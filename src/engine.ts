import fs from 'node:fs';
import path from 'node:path';
import { encodePacked, formatUnits, parseEther, parseUnits, type Hex, type TransactionReceipt } from 'viem';
import { ADDR, CONFIG, DATA_DIR, GAS_TOPUP, ML, RISK, STRATEGY, TOKENS, USDC_DECIMALS, type TokenCfg } from './config.js';
import { publicClient } from './chain.js';
import { runResearch, type BacktestResult, type Research } from './backtest.js';
import {
  fillFromReceipt, gasUsd, LiveExecutor, PaperExecutor, swapGasUnits, topUpFromReceipt, UncertainTxError, type Executor, type Fill,
} from './executor.js';
import {
  discoverMarkets, History, loadMarketCache, quoteExactIn, saveMarketCache, snapshot, type MarketInfo, type Snapshot, type TokenMarket,
} from './market.js';
import { scoreLatest, SeriesBase, type LogitModel } from './ml.js';
import { roundTripCheck } from './safety.js';
import { analyze, ANALYSIS_WINDOW, checkExit, marketRegime, pickEntry, type Analysis, type Regime } from './strategy.js';
import { loadCandidates } from './tokens.js';
import { migratePortfolio, newPortfolio, type BotEvent, type PortfolioState, type Position } from './types.js';
import { loadOrCreateWallet, type WalletInfo } from './wallet.js';

/** Journal of an in-flight live transaction. Written BEFORE broadcast so a crash or timeout can be reconciled from chain. */
interface PendingSwap {
  side: 'BUY' | 'SELL' | 'GAS';
  symbol: string;
  amountIn: string;
  startedAt: number;
  hash: Hex | null;
  deadline: number | null;
  reason: string;
  stopPct: number;
  targetPct: number;
  mid: number;
}

interface BotState {
  version: 1;
  armed: boolean;
  armedAt: number | null;
  entriesPaused: boolean;
  lastUsdcRaw: string | null;
  lastTradeBlock: string | null;
  pending: PendingSwap | null;
  topups: { t: number; usd: number; eth: number }[];
  /** market entries of tokens we hold or are trading (by lowercase address): never dropped from the universe */
  heldMarkets: Record<string, TokenMarket>;
  paper: PortfolioState;
  live: PortfolioState;
}

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.log');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usd = (x: number) => `$${x.toFixed(2)}`;
const errMsg = (e: unknown) => ((e as Error)?.message ?? String(e)).split('\n')[0].slice(0, 300);
const HOUR = 3_600_000;

export class Engine {
  status: 'starting' | 'running' | 'error' = 'starting';
  startupStep = 'Loading';
  lastError: string | null = null;
  lastTickAt = 0;
  market!: MarketInfo;
  wallet!: WalletInfo;
  history = new History();
  snap: Snapshot | null = null;
  analyses: Analysis[] = [];
  regime: Regime = { riskOn: false, reason: 'starting' };
  backtest: BacktestResult | null = null;
  research: Research | null = null;
  /** ML probability per token for the latest hour (only when a model exists) */
  mlScores: Record<string, number> = {};
  mlActive = false;
  mlThreshold = 0.6;
  events: BotEvent[] = [];
  state: BotState;
  busy = false;
  stopping = false;
  refreshing = false;
  researching = false;
  liveStatus = { ready: false, reason: 'Not armed' };
  costs = { gasPerSwapUsd: 0, roundTripPctAt50: 0, hurdlePctAt50: 0 };
  /** tokens that failed a pre-trade honeypot/tax check: symbol -> blocked until (ms) */
  safetyBlocks: Record<string, number> = {};
  private mlModel: LogitModel | null = null;
  private lastMlScoreHour = -1;
  private paperExec = new PaperExecutor();
  private liveExec!: LiveExecutor;
  private lastHourSaved = 0;
  private lastEquityPoint = 0;
  private lastResearchAt = 0;
  private lastGasWarn = 0;
  private liveActed = false; // a live buy/sell was attempted this tick

  constructor() {
    this.state = this.loadState();
    try {
      const lines = fs.readFileSync(EVENTS_FILE, 'utf8').trim().split('\n').slice(-300);
      this.events = lines.map((l) => JSON.parse(l) as BotEvent);
    } catch { /* first run */ }
  }

  // ------------------------------------------------------------------ logging & state
  log(msg: string, level: BotEvent['level'] = 'info') {
    const e: BotEvent = { t: Date.now(), level, msg };
    this.events.push(e);
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
    try { fs.appendFileSync(EVENTS_FILE, JSON.stringify(e) + '\n'); } catch { /* disk issue: keep running */ }
    console.log(`[${new Date(e.t).toISOString()}] ${level.toUpperCase()} ${msg}`);
  }

  private loadState(): BotState {
    try {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as BotState;
      if (s.version === 1) {
        s.pending ??= null;
        s.topups ??= [];
        s.heldMarkets ??= {};
        migratePortfolio(s.paper);
        migratePortfolio(s.live);
        return s;
      }
    } catch { /* fresh */ }
    return {
      version: 1, armed: false, armedAt: null, entriesPaused: false, lastUsdcRaw: null, lastTradeBlock: null, pending: null, topups: [],
      heldMarkets: {}, paper: newPortfolio('paper', CONFIG.paperStartUsd), live: newPortfolio('live', 0),
    };
  }

  saveState() {
    try {
      fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(this.state, null, 1));
      fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    } catch (e) {
      console.error('saveState failed', e);
    }
  }

  private heldSymbols(): string[] {
    const pend = this.state.pending && this.state.pending.side !== 'GAS' ? [this.state.pending.symbol] : [];
    return [...this.state.paper.positions, ...this.state.live.positions].map((p) => p.symbol).concat(pend);
  }

  private findTm(symbol: string): TokenMarket | undefined {
    return this.market.tokens.find((x) => x.token.symbol === symbol);
  }

  private minBarsOf(t: TokenMarket): number {
    return t.token.core ? STRATEGY.minBars : TOKENS.minHistoryDays * 24;
  }

  // ------------------------------------------------------------------ token universe
  /** Remember the market entry of a token we hold / are trading, so a universe refresh can never drop it. */
  private rememberMarket(t: TokenMarket) {
    this.state.heldMarkets[t.token.address.toLowerCase()] = t;
  }

  /** Forget remembered entries no longer held by any portfolio or in-flight swap. */
  private pruneHeldMarkets() {
    const keep = new Set(this.heldSymbols());
    for (const [addr, t] of Object.entries(this.state.heldMarkets)) if (!keep.has(t.token.symbol)) delete this.state.heldMarkets[addr];
  }

  /** Put every held token back into a freshly built universe (matched by address; the remembered key wins). */
  private mergeHeld(m: MarketInfo): MarketInfo {
    const held = new Set(this.heldSymbols());
    for (const [addr, t] of Object.entries(this.state.heldMarkets)) {
      if (!held.has(t.token.symbol)) continue;
      const fixed: TokenMarket = { ...t, quote: t.quote ?? 'WETH', depthUsd: t.depthUsd ?? 0 }; // entries saved by older versions
      const i = m.tokens.findIndex((x) => x.token.address.toLowerCase() === addr);
      if (i === -1) {
        m.tokens.push(fixed);
        this.log(`Kept held token ${t.token.symbol} in the universe (it no longer passes discovery)`, 'warn');
      } else if (m.tokens[i].token.symbol !== t.token.symbol) {
        m.tokens[i] = fixed;
      }
    }
    return m;
  }

  /** Token lists + on-chain depth + honeypot/tax simulation. Held tokens are always kept. */
  private async discover(): Promise<MarketInfo> {
    const candidates = await loadCandidates((m) => this.log(m));
    for (const t of Object.values(this.state.heldMarkets)) {
      if (!candidates.some((c) => c.address.toLowerCase() === t.token.address.toLowerCase())) candidates.push(t.token as TokenCfg);
    }
    const m = this.mergeHeld(await discoverMarkets((x) => this.log(x), candidates, this.heldSymbols()));
    saveMarketCache(m);
    return m;
  }

  /** Tokens new to the bot (almost no stored history). Young pools with genuinely short history are not re-fetched. */
  private symbolsNeedingHistory(m: MarketInfo): string[] {
    return m.tokens.map((t) => t.token.symbol).filter((s) => (this.history.bars[s]?.size ?? 0) < 48);
  }

  /** Daily background refresh of the universe; swapped in between ticks. */
  private async refreshUniverse() {
    this.refreshing = true;
    try {
      const m = await this.discover();
      const fresh = this.symbolsNeedingHistory(m);
      if (fresh.length) await this.history.backfill(m, CONFIG.historyDays, (x) => this.log(x), fresh);
      while (this.busy) await sleep(200);
      const before = this.market.tokens.length;
      this.market = this.mergeHeld(m); // a buy may have landed while discovery ran
      this.history.save(CONFIG.historyDays, new Set(m.tokens.map((t) => t.token.symbol)));
      this.log(`Token universe refreshed: ${before} -> ${m.tokens.length} tradeable tokens`);
      void this.runResearchNow();
    } catch (e) {
      this.log(`Token universe refresh failed (${errMsg(e)}); keeping the current one, retrying in 1h`, 'warn');
      if (this.market) this.market.discoveredAt = Date.now() - (TOKENS.refreshHours - 1) * HOUR;
    } finally {
      this.refreshing = false;
    }
  }

  // ------------------------------------------------------------------ startup / shutdown
  async start(): Promise<void> {
    for (;;) {
      try {
        this.startupStep = 'Loading wallet';
        this.wallet = loadOrCreateWallet();
        this.liveExec = new LiveExecutor(this.wallet.account);
        if (this.wallet.created) this.log(`Created new bot wallet ${this.wallet.account.address} (key stored in ${this.wallet.storage})`);
        else this.log(`Bot wallet ${this.wallet.account.address} (key in ${this.wallet.storage})`);

        const chainId = await publicClient.getChainId();
        if (chainId !== 1) throw new Error(`RPC is chain ${chainId}, expected Ethereum mainnet (1)`);

        this.startupStep = 'Building the token universe (token lists + on-chain safety checks)';
        const cached = loadMarketCache(TOKENS.refreshHours * HOUR);
        if (cached) {
          this.market = this.mergeHeld(cached);
          this.log(`Token universe loaded from cache: ${cached.tokens.length} tradeable tokens`);
        } else {
          this.market = await this.discover();
        }

        this.startupStep = `Loading ${CONFIG.historyDays} days of on-chain price history`;
        this.history.load();
        await this.history.backfill(this.market, CONFIG.historyDays, (m) => this.log(m));
        const fresh = this.symbolsNeedingHistory(this.market);
        if (fresh.length) await this.history.backfill(this.market, CONFIG.historyDays, (m) => this.log(m), fresh);
        this.history.save(CONFIG.historyDays, new Set(this.market.tokens.map((t) => t.token.symbol)));

        this.startupStep = 'First market snapshot';
        await this.tick();
        this.startupStep = 'Backtesting rules and training the ML model (walk-forward)';
        await this.runResearchNow();
        this.status = 'running';
        this.lastError = null;
        this.log(`Bot running. Scanning ${this.market.tokens.length} tokens, up to ${RISK.maxPositions} positions. Signals: ${this.mlActive ? 'ML' : 'rules'}. Live trading: ${this.state.armed ? 'ARMED' : 'not armed'}.`);
        break;
      } catch (e) {
        this.status = 'error';
        this.lastError = errMsg(e);
        this.log(`Startup failed: ${this.lastError} (retrying in 30s)`, 'error');
        await sleep(30_000);
      }
    }
    void this.loop();
  }

  /** Graceful stop: wait for an in-flight trade (up to 25s) and persist state. */
  async stop() {
    this.stopping = true;
    for (let i = 0; i < 100 && this.busy; i++) await sleep(250);
    this.saveState();
  }

  private async loop() {
    let backoff = 0;
    while (!this.stopping) {
      await sleep(Math.max(5, CONFIG.loopSeconds) * 1000 + backoff);
      try {
        await this.tick();
        backoff = 0;
        this.lastError = null;
        if (Date.now() - this.lastResearchAt > 6 * HOUR) void this.runResearchNow();
        if (!this.refreshing && Date.now() - this.market.discoveredAt > TOKENS.refreshHours * HOUR) void this.refreshUniverse();
      } catch (e) {
        this.lastError = errMsg(e);
        this.log(`Tick error: ${this.lastError}`, 'error');
        backoff = Math.min(backoff * 2 + 15_000, 120_000);
      }
    }
  }

  /** Rules backtest + walk-forward ML training/evaluation + the gate deciding whether ML drives entries. */
  async runResearchNow() {
    if (!this.snap || this.researching) return;
    this.researching = true;
    this.lastResearchAt = Date.now();
    try {
      const t0 = Date.now();
      const r = await runResearch(this.history, this.market, this.snap.baseFeeGwei + this.snap.tipGwei, this.snap.ethUsd, CONFIG.paperStartUsd);
      this.research = r;
      this.backtest = r.rules;
      this.mlModel = r.model;
      this.mlActive = r.ml.active && !!r.model;
      // research picks a lift (x base rate); live compares probabilities, so convert with the live model's base rate
      this.mlThreshold = Math.min(0.95, (r.ml.threshold ?? 2) * (r.model?.baseRate ?? 0.3));
      this.computeMlScores(true);
      const b = r.rules;
      this.log(`Backtest rules (${(b.hours / 24).toFixed(0)}d, ${this.market.tokens.length} tokens): ${(b.returnPct * 100).toFixed(2)}% vs ETH ${(b.ethHoldPct * 100).toFixed(2)}%, ${b.trades} trades, max DD ${(b.maxDrawdownPct * 100).toFixed(1)}%`);
      const m = r.ml;
      if (m.enabled) {
        this.log(`ML walk-forward: AUC ${m.auc === null ? 'n/a' : m.auc.toFixed(3)} on ${m.oosRows} unseen hours, ${m.folds} re-trains; ` +
          `best ML ${m.mlOos ? (m.mlOos.returnPct * 100).toFixed(2) + '%' : 'n/a'} (${m.threshold}x base rate) vs rules ${m.rulesOos ? (m.rulesOos.returnPct * 100).toFixed(2) + '%' : 'n/a'} → ${this.mlActive ? 'ML drives entries' : 'rules drive entries'} (${m.reason}). [${((Date.now() - t0) / 1000).toFixed(0)}s]`);
      }
    } catch (e) {
      this.log(`Research/backtest failed: ${errMsg(e)}`, 'warn');
    } finally {
      this.researching = false;
    }
  }

  /** ML probabilities for every token at the latest hour (features use the same code as training). */
  private computeMlScores(force = false) {
    if (!this.mlModel || !this.snap) { this.mlScores = {}; return; }
    const hour = Math.floor(this.snap.timestamp / 3600);
    if (!force && hour === this.lastMlScoreHour) return;
    this.lastMlScoreHour = hour;
    const master = this.history.series('WETH');
    const L = Math.min(master.buckets.length, 720);
    const buckets = master.buckets.slice(-L);
    const eth = new SeriesBase(master.closes.slice(-L));
    const scores: Record<string, number> = {};
    for (const t of this.market.tokens) {
      const sym = t.token.symbol;
      let s = eth;
      if (sym !== 'WETH') {
        const ser = this.history.series(sym);
        const map = new Map(ser.buckets.map((b, i) => [b, ser.closes[i]]));
        const arr = new Float64Array(L).fill(NaN);
        let last = NaN;
        buckets.forEach((b, i) => { const v = map.get(b); if (v !== undefined) last = v; arr[i] = last; });
        s = new SeriesBase(arr);
      }
      const p = scoreLatest(this.mlModel, s, eth);
      if (p !== null) scores[sym] = p;
    }
    this.mlScores = scores;
  }

  // ------------------------------------------------------------------ main tick
  async tick() {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      const snap = await snapshot(this.market, this.wallet.account.address);
      this.snap = snap;
      this.lastTickAt = Date.now();
      this.history.record(snap);
      const hour = Math.floor(snap.timestamp / 3600);
      if (hour !== this.lastHourSaved) { this.history.save(CONFIG.historyDays); this.lastHourSaved = hour; }

      this.analyses = this.market.tokens.map((t) => {
        const closes = this.history.series(t.token.symbol).closes;
        const win = closes.length > ANALYSIS_WINDOW ? closes.slice(-ANALYSIS_WINDOW) : closes;
        return analyze(t.token.symbol, win, this.minBarsOf(t), closes.length);
      });
      this.regime = marketRegime(this.analyses.find((a) => a.symbol === 'WETH'));
      this.computeMlScores();
      const g = gasUsd(swapGasUnits(2, RISK.approvalMode === 'exact'), snap.baseFeeGwei + snap.tipGwei, snap.ethUsd);
      const rt = (2 * g) / 50 + 2 * 0.0035;
      this.costs = { gasPerSwapUsd: g, roundTripPctAt50: rt, hurdlePctAt50: rt * RISK.costHurdleMult };

      const settled = await this.reconcilePending(snap);
      this.syncLive(snap, settled);
      this.liveActed = false;

      // live first (real money has priority): exits/entries before anything else, each step isolated
      try {
        await this.manageLive(snap);
      } catch (e) {
        this.log(`[live] decision error: ${errMsg(e)}`, 'error');
      }
      try {
        // gas top-up only on a quiet tick (no live trade just happened, nothing in flight)
        if (settled && !this.liveActed && !this.state.pending) await this.maybeTopUpGas(snap);
      } catch (e) {
        this.log(`[live] gas top-up error: ${errMsg(e)}`, 'error');
      }
      try {
        await this.manage(this.state.paper, snap, this.paperExec, true);
      } catch (e) {
        this.log(`[paper] decision error: ${errMsg(e)}`, 'warn');
      }

      if (Date.now() - this.lastEquityPoint > 5 * 60_000) {
        this.lastEquityPoint = Date.now();
        for (const pf of [this.state.paper, this.state.live]) {
          pf.equityHistory.push([Date.now(), this.equity(pf, snap)]);
          if (pf.equityHistory.length > 4000) pf.equityHistory.splice(0, pf.equityHistory.length - 4000);
        }
      }
      this.pruneHeldMarkets();
      this.saveState();
    } finally {
      this.busy = false;
    }
  }

  equity(pf: PortfolioState, snap: Snapshot): number {
    if (pf.kind === 'live') {
      const b = snap.balances!;
      let eq = Number(formatUnits(b.usdc, USDC_DECIMALS));
      const seen = new Set<string>();
      for (const t of this.market.tokens) {
        const addr = t.token.address.toLowerCase();
        if (seen.has(addr)) continue; // never count one token twice
        seen.add(addr);
        // a failed balance read (undefined) falls back to the position's last known quantity
        const held = pf.positions.find((p) => p.symbol === t.token.symbol);
        const bal = b.tokens[t.token.symbol] ?? (held ? BigInt(held.qtyRaw) : 0n);
        if (bal > 0n) eq += Number(formatUnits(bal, t.token.decimals)) * (snap.prices[t.token.symbol] ?? 0);
      }
      return eq;
    }
    return pf.cashUsd + pf.positions.reduce((s, p) => s + p.qty * (snap.prices[p.symbol] ?? 0), 0);
  }

  /**
   * Settles a journaled in-flight transaction (after a crash, broadcast error or receipt timeout) from on-chain facts.
   * Returns false while it is still unresolved: balances are then in flux and must not be read as deposits.
   */
  private async reconcilePending(snap: Snapshot): Promise<boolean> {
    const p = this.state.pending;
    if (!p) return true;
    if (!p.hash) {
      this.log(`[live] Cleared journal of a ${p.side} ${p.symbol} transaction that was never broadcast.`);
      this.state.pending = null;
      return true;
    }
    let receipt: TransactionReceipt | null = null;
    try { receipt = await publicClient.getTransactionReceipt({ hash: p.hash }); } catch { /* not mined / not found */ }
    const t = p.side === 'GAS' ? null : this.findTm(p.symbol) ?? null;
    if (receipt && (t || p.side === 'GAS')) {
      if (receipt.status === 'success') {
        this.log(`[live] In-flight ${p.side} ${p.symbol} transaction landed on chain (${p.hash}). Recording it.`, 'trade');
        if (p.side === 'GAS') {
          const g = topUpFromReceipt(receipt, this.wallet.account.address);
          this.bookGasTopup(g.usdcIn, g.ethOut, (Number(g.gasWei) / 1e18) * snap.ethUsd, receipt.blockNumber);
        } else {
          const tokenIn = p.side === 'BUY' ? ADDR.usdc : t!.token.address;
          const tokenOut = p.side === 'BUY' ? t!.token.address : ADDR.usdc;
          const f = fillFromReceipt(receipt, tokenIn, tokenOut, this.wallet.account.address);
          const fill: Fill = {
            amountIn: f.amountIn, amountOut: f.amountOut, gasUsd: (Number(f.gasWei) / 1e18) * snap.ethUsd,
            txHashes: [p.hash], blockNumber: receipt.blockNumber,
          };
          if (p.side === 'BUY') this.commitBuy(this.state.live, t!, fill, p.mid, p.stopPct, p.targetPct, p.reason, snap);
          else if (this.state.live.positions.some((x) => x.symbol === p.symbol)) this.commitSell(this.state.live, t!, fill, p.reason);
          else this.afterLiveFill(fill.amountOut, fill.blockNumber);
        }
      } else {
        this.log(`[live] In-flight ${p.side} ${p.symbol} transaction reverted on chain (${p.hash}). Only gas was spent.`, 'warn');
        this.state.live.gasSpentUsd += (Number(receipt.gasUsed * receipt.effectiveGasPrice) / 1e18) * snap.ethUsd;
        this.state.lastTradeBlock = receipt.blockNumber.toString();
        this.state.pending = null;
      }
      this.saveState();
      return false; // balances in this tick's snapshot may predate the trade
    }
    if (p.deadline !== null && Date.now() / 1000 > p.deadline + 180) {
      this.log(`[live] In-flight ${p.side} ${p.symbol} transaction ${p.hash} passed its deadline without being mined. Cleared.`, 'warn');
      this.state.pending = null;
      this.saveState();
      return true;
    }
    this.state.live.lastDecision = `Waiting for in-flight ${p.side} ${p.symbol} transaction ${p.hash.slice(0, 10)}… to settle`;
    return false;
  }

  /** Reconcile the live portfolio with on-chain balances and detect deposits/withdrawals. */
  private syncLive(snap: Snapshot, settled: boolean) {
    const b = snap.balances!;
    const live = this.state.live;
    const usdc = Number(formatUnits(b.usdc, USDC_DECIMALS));
    live.cashUsd = usdc;
    const staleRead = this.state.lastTradeBlock !== null && snap.blockNumber < BigInt(this.state.lastTradeBlock);
    if (!settled || staleRead || this.state.pending) return;

    const prev = this.state.lastUsdcRaw === null ? 0 : Number(formatUnits(BigInt(this.state.lastUsdcRaw), USDC_DECIMALS));
    const diff = usdc - prev;
    if (Math.abs(diff) >= 0.01) {
      live.netDepositsUsd += diff;
      // deposits/withdrawals are not profit or loss: shift the risk baselines with them
      live.peakEquity = Math.max(0, live.peakEquity + diff);
      live.dayStartEquity = Math.max(0, live.dayStartEquity + diff);
      if (diff > 0) {
        this.log(`Deposit detected: +${diff.toFixed(2)} USDC in bot wallet`, 'trade');
        if (this.state.armed) this.log('Live trading is armed — the bot will trade these funds automatically.', 'trade');
        else this.log('Live trading is NOT armed — funds sit idle until you click "Arm live trading".', 'warn');
      } else {
        this.log(`USDC left the wallet outside a bot trade: ${diff.toFixed(2)} USDC`, 'warn');
      }
    }
    this.state.lastUsdcRaw = b.usdc.toString();

    for (const pos of [...live.positions]) {
      const t = this.findTm(pos.symbol);
      const bal = b.tokens[pos.symbol];
      if (!t || bal === undefined) {
        // token missing from the universe or its balance read failed: keep the last known position, never clear it on a guess
        this.warnLive(`Could not read ${pos.symbol} this tick; keeping the last known position`);
      } else if (bal === 0n) {
        const value = pos.qty * (snap.prices[pos.symbol] ?? 0);
        this.log(`${pos.symbol} position is no longer in the wallet (moved outside the bot). Clearing it.`, 'warn');
        live.netDepositsUsd -= value;
        live.peakEquity = Math.max(0, live.peakEquity - value);
        live.dayStartEquity = Math.max(0, live.dayStartEquity - value);
        live.positions.splice(live.positions.indexOf(pos), 1);
      } else {
        pos.qtyRaw = bal.toString();
        pos.qty = Number(formatUnits(bal, t.token.decimals));
      }
    }
    if (this.state.armed && live.positions.length < RISK.maxPositions) {
      // adopt only core tokens (e.g. WETH/WBTC you deposited); random airdrops of long-tail tokens are ignored
      const held = new Set(live.positions.map((p) => p.symbol));
      for (const t of this.market.tokens.filter((x) => x.token.core && !held.has(x.token.symbol))) {
        const bal = b.tokens[t.token.symbol] ?? 0n;
        const price = snap.prices[t.token.symbol] ?? 0;
        const value = Number(formatUnits(bal, t.token.decimals)) * price;
        if (value >= 2) {
          const a = this.analyses.find((x) => x.symbol === t.token.symbol);
          const stopPct = a?.stopPct ?? STRATEGY.minStopPct;
          live.positions.push(this.makePosition(t, bal, value, price, 0, stopPct, stopPct * STRATEGY.rewardRisk, snap));
          this.rememberMarket(t);
          live.netDepositsUsd += value;
          live.peakEquity += value;
          live.dayStartEquity += value;
          this.log(`Adopted existing ${t.token.symbol} holding (${usd(value)}) into live management`, 'warn');
          break;
        }
      }
    }
  }

  // ------------------------------------------------------------------ gas
  /** ETH the wallet must hold to send one approve+swap at current gas prices (nodes check gasLimit x maxFee). */
  private ethForSwap(snap: Snapshot, hops = 2): number {
    return swapGasUnits(hops, true) * 1.3 * (snap.baseFeeGwei * 2 + snap.tipGwei) * 1e-9;
  }

  private warnLive(msg: string) {
    if (Date.now() - this.lastGasWarn > 30 * 60_000) { this.lastGasWarn = Date.now(); this.log(`[live] ${msg}`, 'warn'); }
  }

  /** Buys a little ETH for gas with USDC when the wallet runs low (approve + swap + unwrap, journaled like trades). */
  private async maybeTopUpGas(snap: Snapshot) {
    if (!GAS_TOPUP.enabled || !this.state.armed || this.state.pending) return;
    const b = snap.balances!;
    const live = this.state.live;
    const now = Date.now();
    const eth = Number(formatUnits(b.eth, 18));
    // critical = we hold positions and could not even afford their exits
    const exitNeed = live.positions.reduce((s, p) => s + this.ethForSwap(snap, this.findTm(p.symbol)?.hops ?? 2), 0);
    const critical = live.positions.length > 0 && eth < exitNeed * 1.5;
    const entriesPossible = (this.mlActive || this.regime.riskOn) && !live.halted && !this.state.entriesPaused && !(live.pausedUntil && now < live.pausedUntil);
    if (!critical) {
      if (eth >= GAS_TOPUP.belowEth) return; // fixed trigger: a gas spike must not make the bot buy ever more ETH
      if (live.positions.length === 0 && !entriesPossible) return; // nothing to spend gas on yet (e.g. risk-off): keep the USDC
    }

    const recent = this.state.topups.filter((x) => now - x.t < 24 * HOUR);
    if (recent.some((x) => now - x.t < 15 * 60_000)) return; // at most one every 15 min
    if (recent.length >= GAS_TOPUP.maxPerDay) { this.warnLive(`Daily gas top-up limit (${GAS_TOPUP.maxPerDay}) reached; ETH ${eth.toFixed(5)}`); return; }
    if (eth < this.ethForSwap(snap, 1) * 1.2) { this.warnLive(`ETH (${eth.toFixed(5)}) is too low even to buy gas. Send ~0.001 ETH once; after that the bot refills itself.`); return; }
    const usdc = Number(formatUnits(b.usdc, USDC_DECIMALS));
    const amount = Math.floor(Math.min(GAS_TOPUP.usd, usdc * (critical ? 1 : 0.25)) * 100) / 100;
    if (amount < 1) { this.warnLive(`ETH is low (${eth.toFixed(5)}) but there is no free USDC to buy gas with`); return; }
    // efficiency: the top-up's own gas must stay a small part of the ETH it buys
    const selfGasEth = (RISK.gasUnits.approve + RISK.gasUnits.swap1Hop + 40_000) * (snap.baseFeeGwei + snap.tipGwei) * 1e-9;
    const ethBought = amount / snap.ethUsd;
    if (selfGasEth > ethBought * (critical ? 0.6 : 0.3)) {
      this.warnLive(`Gas is expensive (${snap.baseFeeGwei.toFixed(1)} gwei): a ${usd(amount)} top-up would burn ${((selfGasEth / ethBought) * 100).toFixed(0)}% of itself. Waiting.`);
      return;
    }

    const usdcIn = parseUnits(amount.toFixed(6), USDC_DECIMALS);
    const path = encodePacked(['address', 'uint24', 'address'], [ADDR.usdc, this.market.usdcWeth.fee, ADDR.weth]);
    this.log(`[live] Gas is low (${eth.toFixed(5)} ETH): buying ${usd(amount)} of ETH with USDC`, 'trade');
    this.state.pending = { side: 'GAS', symbol: 'ETH', amountIn: usdcIn.toString(), startedAt: now, hash: null, deadline: null, reason: 'gas top-up', stopPct: 0, targetPct: 0, mid: snap.ethUsd };
    this.saveState();
    try {
      const r = await this.liveExec.topUpGas(usdcIn, path, RISK.maxSlippageBps, snap.ethUsd, (hash, deadline) => {
        if (this.state.pending) { this.state.pending.hash = hash; this.state.pending.deadline = deadline; this.saveState(); }
      }, (m) => this.log(`[live] ${m}`));
      this.bookGasTopup(r.usdcIn, r.ethOut, r.gasUsd, r.blockNumber);
    } catch (e) {
      if (e instanceof UncertainTxError && this.state.pending?.hash === e.hash) {
        this.log(`[live] gas top-up: ${e.message}. Will settle it from chain.`, 'warn');
      } else {
        this.state.pending = null;
        this.state.topups.push({ t: now, usd: 0, eth: 0 }); // counts toward the rate limit so failures can't loop
        this.log(`[live] gas top-up failed: ${errMsg(e)}`, 'error');
      }
      this.saveState();
    }
  }

  /** USDC moved into the gas wallet is not a trading loss: book it like a withdrawal; burned gas is counted separately. */
  private bookGasTopup(usdcIn: bigint, ethOut: bigint, gasUsdSpent: number, blockNumber?: bigint) {
    const live = this.state.live;
    const spent = Number(formatUnits(usdcIn, USDC_DECIMALS));
    const eth = Number(formatUnits(ethOut, 18));
    live.netDepositsUsd -= spent;
    live.peakEquity = Math.max(0, live.peakEquity - spent);
    live.dayStartEquity = Math.max(0, live.dayStartEquity - spent);
    live.gasSpentUsd += gasUsdSpent;
    this.afterLiveFill(-usdcIn, blockNumber);
    this.state.topups.push({ t: Date.now(), usd: spent, eth });
    if (this.state.topups.length > 200) this.state.topups.splice(0, this.state.topups.length - 200);
    this.log(`[live] Gas top-up done: ${usd(spent)} USDC -> ${eth.toFixed(5)} ETH (tx gas ${usd(gasUsdSpent)})`, 'trade');
    this.saveState();
  }

  private liveReadiness(snap: Snapshot): { ready: boolean; reason: string } {
    const live = this.state.live;
    const holding = live.positions.length > 0;
    if (!this.state.armed) {
      return { ready: false, reason: holding ? 'Disarmed — no new buys; open positions keep their stop-loss/target' : 'Live trading not armed — paper trading only' };
    }
    if (live.halted) return { ready: false, reason: `HALTED: ${live.halted}. No new buys (open positions still protected). Reset after reviewing.` };
    const eth = Number(formatUnits(snap.balances!.eth, 18));
    const usdc = Number(formatUnits(snap.balances!.usdc, USDC_DECIMALS));
    const eq = this.equity(live, snap);
    if (!holding && eq < RISK.minTradeUsd) return { ready: false, reason: `Armed — waiting for USDC deposit (min ${usd(RISK.minTradeUsd)})` };
    const need = Math.max(RISK.minGasEth, 2 * this.ethForSwap(snap));
    if (eth < need) {
      if (eth >= GAS_TOPUP.belowEth) return { ready: false, reason: `Armed — gas is expensive right now (${snap.baseFeeGwei.toFixed(1)} gwei); waiting for cheaper gas` };
      if (GAS_TOPUP.enabled && eth >= this.ethForSwap(snap, 1) * 1.2 && usdc >= 1) {
        return {
          ready: false,
          reason: this.mlActive || this.regime.riskOn
            ? `Armed — buying a little ETH for gas from USDC first (have ${eth.toFixed(5)} ETH)`
            : `Armed — low on gas (${eth.toFixed(5)} ETH); will buy some from USDC once there is something to trade`,
        };
      }
      return { ready: false, reason: `Armed — waiting for ETH for gas: send ~0.001 ETH once (have ${eth.toFixed(5)}). After that the bot buys its own gas from USDC.` };
    }
    return { ready: true, reason: 'Live trading active' };
  }

  private async manageLive(snap: Snapshot) {
    const live = this.state.live;
    this.liveStatus = this.liveReadiness(snap);
    if (this.state.pending) return; // never trade while a transaction is unresolved
    if (live.positions.length > 0 || this.liveStatus.ready) {
      // exits ALWAYS run while we hold something (armed or not, halted or not); entries only when ready
      await this.manage(live, snap, this.liveExec, this.liveStatus.ready);
    } else {
      live.lastDecision = this.liveStatus.reason;
    }
  }

  private tm(symbol: string): TokenMarket {
    const t = this.findTm(symbol);
    if (!t) throw new Error(`Unknown token ${symbol}`);
    return t;
  }

  private makePosition(t: TokenMarket, qtyRaw: bigint, costUsd: number, mid: number, gasUsdIn: number, stopPct: number, targetPct: number, snap: Snapshot): Position {
    const qty = Number(formatUnits(qtyRaw, t.token.decimals));
    const exitGas = gasUsd(swapGasUnits(t.hops, RISK.approvalMode === 'exact'), snap.baseFeeGwei + snap.tipGwei, snap.ethUsd);
    return {
      symbol: t.token.symbol, qty, qtyRaw: qtyRaw.toString(), entryPrice: costUsd / qty, entryMid: mid, entryTime: Date.now(),
      costUsd, entryGasUsd: gasUsdIn, stopPct, targetPct, stopPrice: mid * (1 - stopPct), targetPrice: mid * (1 + targetPct),
      trailActive: false, peakPrice: mid,
      breakevenPrice: (costUsd + gasUsdIn + exitGas) / (qty * (1 - t.poolFeePct - 0.001)),
    };
  }

  // ------------------------------------------------------------------ decisions
  private async manage(pf: PortfolioState, snap: Snapshot, exec: Executor, entriesAllowed: boolean) {
    const now = Date.now();
    const equity = this.equity(pf, snap);
    const dayKey = new Date(snap.timestamp * 1000).toISOString().slice(0, 10);
    if (pf.dayKey !== dayKey) { pf.dayKey = dayKey; pf.dayStartEquity = equity; pf.pausedUntil = null; }
    if (pf.kind === 'live' && pf.peakEquity === 0) pf.peakEquity = equity;
    pf.peakEquity = Math.max(pf.peakEquity, equity);
    if (!pf.halted && pf.peakEquity > 0 && equity < pf.peakEquity * (1 - RISK.maxDrawdownPct)) {
      pf.halted = `max drawdown ${(RISK.maxDrawdownPct * 100).toFixed(0)}% reached`;
      this.log(`[${pf.kind}] Circuit breaker: ${pf.halted}. No new buys until you reset it.`, 'warn');
    }
    if (!pf.pausedUntil && pf.dayStartEquity > 0 && equity < pf.dayStartEquity * (1 - RISK.dailyLossLimitPct)) {
      const midnight = new Date(dayKey + 'T00:00:00Z').getTime() + 86_400_000;
      pf.pausedUntil = midnight;
      this.log(`[${pf.kind}] Daily loss limit hit. No new buys until ${new Date(midnight).toISOString()}.`, 'warn');
    }

    // ---- exits (never blocked by halts, pauses or arming)
    const notes: string[] = [];
    let sold = false;
    for (const pos of [...pf.positions]) {
      const price = snap.prices[pos.symbol];
      if (!(price > 0)) { notes.push(`${pos.symbol} (no price)`); continue; }
      const a = this.analyses.find((x) => x.symbol === pos.symbol);
      const ex = checkExit(pos, a, price, this.regime, now);
      const pnlPct = price / pos.breakevenPrice - 1;
      if (!ex.exit) { notes.push(`${pos.symbol} ${(pnlPct * 100).toFixed(1)}%`); continue; }
      if (pf.exitRetryAfter && now < pf.exitRetryAfter) { notes.push(`${pos.symbol} exit retry pending (${ex.reason})`); continue; }
      if (snap.baseFeeGwei > RISK.maxExitGasGwei) { notes.push(`${pos.symbol} exit waits for gas < ${RISK.maxExitGasGwei} gwei`); continue; }
      if (pf.kind === 'live') {
        const needEth = this.ethForSwap(snap, this.findTm(pos.symbol)?.hops ?? 2);
        const eth = Number(formatUnits(snap.balances!.eth, 18));
        if (eth < needEth) {
          const msg = `Exit signal for ${pos.symbol} (${ex.reason}) but only ${eth.toFixed(5)} ETH for gas (need ~${needEth.toFixed(5)}). SEND ETH to the bot wallet!`;
          notes.push(msg);
          if (now - this.lastGasWarn > 10 * 60_000) { this.lastGasWarn = now; this.log(`[live] ${msg}`, 'error'); }
          continue;
        }
      }
      await this.sell(pf, exec, snap, pos, ex.reason, RISK.maxSlippageBps);
      sold = true;
      if (this.state.pending) return; // an unresolved live transaction: stop this tick
    }
    const holding = notes.length ? `Holding ${notes.join(', ')}. ` : '';

    // ---- entries
    if (!entriesAllowed) { pf.lastDecision = holding + 'No new buys right now.'; return; }
    if (sold) { pf.lastDecision = holding + 'Sold this tick; looking for new entries next tick.'; return; }
    pf.lastDecision = holding + (await this.tryEntry(pf, snap, exec, now));
  }

  /** Finds and executes at most one new entry. Returns a human-readable decision. */
  private async tryEntry(pf: PortfolioState, snap: Snapshot, exec: Executor, now: number): Promise<string> {
    if (pf.positions.length >= RISK.maxPositions) return `Max ${RISK.maxPositions} positions held.`;
    if (pf.retryAfter && now < pf.retryAfter) return 'Cooling down after a failed transaction.';
    if (this.state.entriesPaused) return 'New entries paused by you.';
    if (pf.halted) return `Halted: ${pf.halted}.`;
    if (pf.pausedUntil && now < pf.pausedUntil) return 'Daily loss limit — waiting for next UTC day.';
    if (snap.baseFeeGwei > RISK.maxEntryGasGwei) return `Gas ${snap.baseFeeGwei.toFixed(1)} gwei above entry limit ${RISK.maxEntryGasGwei}.`;
    const held = new Set(pf.positions.map((p) => p.symbol));
    const blocked: Record<string, number> = { ...pf.cooldowns, ...this.safetyBlocks };
    const free = this.analyses.filter((a) => !held.has(a.symbol));

    let cand: Analysis | null = null;
    let why = '';
    if (this.mlActive) {
      const eth = this.analyses.find((a) => a.symbol === 'WETH');
      if (eth && eth.change24h < -0.06) return `ETH crashed ${(eth.change24h * 100).toFixed(1)}% in 24h — no new buys.`;
      const pool = free
        .filter((a) => {
          const t = this.findTm(a.symbol);
          const p = this.mlScores[a.symbol];
          return t && p !== undefined && p >= this.mlThreshold && !((blocked[a.symbol] ?? 0) > now)
            && a.bars >= this.minBarsOf(t) && a.dailyVol >= STRATEGY.minDailyVol;
        })
        .sort((x, y) => (this.mlScores[y.symbol] ?? 0) - (this.mlScores[x.symbol] ?? 0));
      cand = pool[0] ?? null;
      if (!cand) return `ML: no token with probability ≥ ${this.mlThreshold} (of ${this.analyses.length}). Holding USDC.`;
      why = `ML p=${this.mlScores[cand.symbol].toFixed(2)}`;
    } else {
      if (!this.regime.riskOn) return `Risk-off: ${this.regime.reason}. Holding USDC.`;
      cand = pickEntry(free, blocked, now);
      if (!cand) return `No token (of ${this.analyses.length}) passes every entry rule. Holding USDC.`;
      why = `score ${cand.score.toFixed(2)}`;
    }

    const t = this.tm(cand.symbol);
    const equity = this.equity(pf, snap);
    const cash = pf.kind === 'live' ? Number(formatUnits(snap.balances!.usdc, USDC_DECIMALS)) : pf.cashUsd;
    const gasReserve = pf.kind === 'live' && GAS_TOPUP.enabled ? GAS_TOPUP.usd : 0; // keep a little USDC to buy gas later
    const capUsd = Math.min(
      (cash - gasReserve) * RISK.maxAllocPct,
      equity * RISK.maxPositionPct,
      t.token.core ? Infinity : equity * TOKENS.maxAllocPct,
    );
    const size = Math.floor(Math.min(capUsd, (equity * RISK.riskPerTradePct) / cand.stopPct) * 100) / 100;
    if (size < RISK.minTradeUsd) return `${cand.symbol} signal (${why}), but size ${usd(size)} < minimum ${usd(RISK.minTradeUsd)}.`;

    const amountIn = parseUnits(size.toFixed(6), USDC_DECIMALS);
    const q = await quoteExactIn(t.buyPath, amountIn);
    const outQty = Number(formatUnits(q.amountOut, t.token.decimals));
    const impact = Math.max(0, 1 - (outQty * snap.prices[cand.symbol]) / size); // pool fees + price impact
    const g = gasUsd(swapGasUnits(t.hops, RISK.approvalMode === 'exact'), snap.baseFeeGwei + snap.tipGwei, snap.ethUsd);
    const rtCost = 2 * impact + (2 * g) / size;
    if (rtCost > RISK.maxRoundTripCostPct) {
      return `${cand.symbol} signal (${why}) skipped: round-trip cost ${(rtCost * 100).toFixed(2)}% > max ${(RISK.maxRoundTripCostPct * 100).toFixed(1)}% (gas ${usd(g)}/swap on a ${usd(size)} trade).`;
    }
    if (cand.targetPct < RISK.costHurdleMult * rtCost) {
      return `${cand.symbol} signal (${why}) skipped: target ${(cand.targetPct * 100).toFixed(1)}% < ${RISK.costHurdleMult}x cost ${(rtCost * 100).toFixed(2)}%.`;
    }
    if (!t.token.core) {
      // fresh honeypot / tax simulation at the real trade size, right before buying
      const s = await roundTripCheck(t, parseEther(Math.max(0.002, size / snap.ethUsd).toFixed(8)), this.market.usdcWeth.fee);
      if (!s.ok) {
        this.safetyBlocks[cand.symbol] = now + 24 * HOUR;
        this.log(`[${pf.kind}] ${cand.symbol} blocked for 24h — pre-trade honeypot/tax check failed: ${s.reason}`, 'warn');
        return `${cand.symbol} failed the pre-trade safety check: ${s.reason}.`;
      }
    }
    const ok = await this.buy(pf, exec, snap, t, cand, amountIn, why);
    return ok ? `Bought ${cand.symbol} (${why}).` : `Buy of ${cand.symbol} failed — see log.`;
  }

  private journal(pf: PortfolioState, p: Omit<PendingSwap, 'startedAt' | 'hash' | 'deadline'>) {
    if (pf.kind !== 'live') return undefined;
    this.state.pending = { ...p, startedAt: Date.now(), hash: null, deadline: null };
    this.saveState();
    return (hash: Hex, deadline: number) => {
      if (!this.state.pending) return;
      this.state.pending.hash = hash;
      this.state.pending.deadline = deadline;
      this.saveState();
    };
  }

  private async buy(pf: PortfolioState, exec: Executor, snap: Snapshot, t: TokenMarket, cand: Analysis, amountIn: bigint, why: string): Promise<boolean> {
    const sym = t.token.symbol;
    this.rememberMarket(t);
    if (pf.kind === 'live') this.liveActed = true;
    const reason = `${why}, momentum ${cand.momentum.toFixed(2)}σ, ${cand.trend} trend, RSI ${cand.rsi.toFixed(0)}`;
    this.log(`[${pf.kind}] BUY ${sym}: ${reason}, stop -${(cand.stopPct * 100).toFixed(1)}%, target +${(cand.targetPct * 100).toFixed(1)}%`, 'trade');
    const mid = snap.prices[sym];
    const onSwapSigned = this.journal(pf, { side: 'BUY', symbol: sym, amountIn: amountIn.toString(), reason, stopPct: cand.stopPct, targetPct: cand.targetPct, mid });
    let fill: Fill;
    try {
      fill = await exec.swap({
        path: t.buyPath, tokenIn: ADDR.usdc, tokenOut: t.token.address, amountIn, hops: t.hops,
        slippageBps: RISK.maxSlippageBps, gasPriceGwei: snap.baseFeeGwei + snap.tipGwei, ethUsd: snap.ethUsd, onSwapSigned,
      }, (m) => this.log(`[${pf.kind}] ${m}`));
    } catch (e) {
      this.onTradeFailure(pf, `buy ${sym}`, e, false);
      return false;
    }
    this.commitBuy(pf, t, fill, mid, cand.stopPct, cand.targetPct, reason, snap);
    return true;
  }

  private commitBuy(pf: PortfolioState, t: TokenMarket, fill: Fill, mid: number, stopPct: number, targetPct: number, reason: string, snap: Snapshot) {
    const spent = Number(formatUnits(fill.amountIn, USDC_DECIMALS));
    const pos = this.makePosition(t, fill.amountOut, spent, mid, fill.gasUsd, stopPct, targetPct, snap);
    pf.positions.push(pos);
    pf.gasSpentUsd += fill.gasUsd;
    if (pf.kind === 'paper') pf.cashUsd -= spent + fill.gasUsd;
    else this.afterLiveFill(-fill.amountIn, fill.blockNumber);
    pf.consecutiveFailures = 0;
    pf.retryAfter = null;
    pf.trades.push({
      id: `${Date.now()}`, time: Date.now(), side: 'BUY', symbol: pos.symbol, usd: spent, qty: pos.qty, price: pos.entryPrice,
      gasUsd: fill.gasUsd, reason, txHashes: fill.txHashes,
    });
    if (pf.trades.length > 500) pf.trades.splice(0, pf.trades.length - 500);
    this.log(`[${pf.kind}] Bought ${pos.qty.toPrecision(6)} ${pos.symbol} for ${usd(spent)} (gas ${usd(fill.gasUsd)})`, 'trade');
    this.saveState();
  }

  private async sell(pf: PortfolioState, exec: Executor, snap: Snapshot, pos: Position, reason: string, slippageBps: number): Promise<boolean> {
    const t = this.tm(pos.symbol);
    if (pf.kind === 'live') this.liveActed = true;
    this.log(`[${pf.kind}] SELL ${pos.symbol}: ${reason}`, 'trade');
    const amountIn = BigInt(pos.qtyRaw);
    const onSwapSigned = this.journal(pf, { side: 'SELL', symbol: pos.symbol, amountIn: amountIn.toString(), reason, stopPct: pos.stopPct, targetPct: pos.targetPct, mid: snap.prices[pos.symbol] });
    let fill: Fill;
    try {
      fill = await exec.swap({
        path: t.sellPath, tokenIn: t.token.address, tokenOut: ADDR.usdc, amountIn, hops: t.hops,
        slippageBps, gasPriceGwei: snap.baseFeeGwei + snap.tipGwei, ethUsd: snap.ethUsd, onSwapSigned,
      }, (m) => this.log(`[${pf.kind}] ${m}`));
    } catch (e) {
      this.onTradeFailure(pf, `sell ${pos.symbol}`, e, true);
      return false;
    }
    this.commitSell(pf, t, fill, reason);
    return true;
  }

  private commitSell(pf: PortfolioState, t: TokenMarket, fill: Fill, reason: string) {
    const idx = pf.positions.findIndex((p) => p.symbol === t.token.symbol);
    if (idx === -1) { if (pf.kind === 'live') this.afterLiveFill(fill.amountOut, fill.blockNumber); return; }
    const pos = pf.positions[idx];
    const got = Number(formatUnits(fill.amountOut, USDC_DECIMALS));
    const soldQty = Number(formatUnits(fill.amountIn, t.token.decimals));
    const pnl = got - pos.costUsd - pos.entryGasUsd - fill.gasUsd;
    pf.realizedPnlUsd += pnl;
    pf.gasSpentUsd += fill.gasUsd;
    if (pf.kind === 'paper') pf.cashUsd += got - fill.gasUsd;
    else this.afterLiveFill(fill.amountOut, fill.blockNumber);
    pf.consecutiveFailures = 0;
    pf.exitRetryAfter = null;
    const hours = reason.includes('stop-loss') ? RISK.cooldownHoursAfterStop : RISK.cooldownHoursAfterExit;
    pf.cooldowns[pos.symbol] = Date.now() + hours * HOUR;
    pf.trades.push({
      id: `${Date.now()}`, time: Date.now(), side: 'SELL', symbol: pos.symbol, usd: got, qty: soldQty, price: soldQty > 0 ? got / soldQty : 0,
      gasUsd: fill.gasUsd, pnlUsd: pnl, pnlPct: pos.costUsd > 0 ? pnl / pos.costUsd : 0, reason, txHashes: fill.txHashes,
    });
    if (pf.trades.length > 500) pf.trades.splice(0, pf.trades.length - 500);
    pf.positions.splice(idx, 1);
    this.log(`[${pf.kind}] Sold ${pos.symbol} for ${usd(got)} — net P&L ${usd(pnl)} after gas (${reason})`, 'trade');
    this.saveState();
  }

  /** Book a live fill against the last known USDC balance, so the next tick can't mistake it for a deposit. */
  private afterLiveFill(usdcDelta: bigint, blockNumber?: bigint) {
    const prev = this.state.lastUsdcRaw === null ? 0n : BigInt(this.state.lastUsdcRaw);
    const next = prev + usdcDelta;
    this.state.lastUsdcRaw = (next < 0n ? 0n : next).toString();
    if (blockNumber !== undefined) this.state.lastTradeBlock = blockNumber.toString();
    this.state.pending = null;
  }

  private onTradeFailure(pf: PortfolioState, what: string, e: unknown, isExit: boolean) {
    if (pf.kind === 'live' && this.state.pending) {
      if (e instanceof UncertainTxError && this.state.pending.hash === e.hash) {
        this.log(`[live] ${what}: ${e.message}. Will settle it from chain before trading again.`, 'warn');
        this.saveState();
        return;
      }
      this.state.pending = null;
    }
    pf.consecutiveFailures++;
    if (isExit) pf.exitRetryAfter = Date.now() + 60_000 * Math.min(5, pf.consecutiveFailures);
    else pf.retryAfter = Date.now() + 10 * 60_000;
    this.log(`[${pf.kind}] ${what} failed (${pf.consecutiveFailures}/${RISK.maxConsecutiveFailures}): ${errMsg(e)}`, 'error');
    if (pf.consecutiveFailures >= RISK.maxConsecutiveFailures && !pf.halted) {
      pf.halted = `${pf.consecutiveFailures} failed trades in a row`;
      this.log(`[${pf.kind}] HALTED new buys after repeated failures (exits keep retrying). Check the log, then Reset.`, 'error');
    }
    this.saveState();
  }

  // ------------------------------------------------------------------ controls
  arm() {
    this.state.armed = true;
    this.state.armedAt = Date.now();
    this.log('Live trading ARMED by user. The bot will trade the wallet\'s USDC (and buy its own gas) automatically.', 'warn');
    this.saveState();
  }

  disarm() {
    this.state.armed = false;
    this.log('Live trading DISARMED by user. No new buys; open positions keep their stop-loss/target (use Panic sell to exit now).', 'warn');
    this.saveState();
  }

  setPaused(p: boolean) {
    this.state.entriesPaused = p;
    this.log(p ? 'New entries paused by user (exits still managed).' : 'New entries resumed by user.', 'warn');
    this.saveState();
  }

  resume(kind: 'paper' | 'live') {
    const pf = this.state[kind];
    pf.halted = null;
    pf.consecutiveFailures = 0;
    pf.retryAfter = null;
    pf.exitRetryAfter = null;
    pf.pausedUntil = null;
    if (this.snap) pf.peakEquity = this.equity(pf, this.snap);
    this.log(`[${kind}] Circuit breaker reset by user.`, 'warn');
    this.saveState();
  }

  resetPaper() {
    this.state.paper = newPortfolio('paper', CONFIG.paperStartUsd);
    this.log(`Paper portfolio reset to ${usd(CONFIG.paperStartUsd)}.`);
    this.saveState();
  }

  /** Sell every open position now. Throws if any could not be sold. */
  async panic(kind: 'paper' | 'live') {
    const pf = this.state[kind];
    if (kind === 'live' && this.state.armed) this.disarm();
    if (pf.positions.length === 0) { this.log(`[${kind}] Panic: no open positions.`, 'warn'); return; }
    for (let i = 0; i < 2400 && this.busy; i++) await sleep(250);
    if (this.busy) throw new Error('Bot is busy with another transaction; try again in a minute.');
    this.busy = true;
    const failed: string[] = [];
    try {
      const snap = await snapshot(this.market, this.wallet.account.address);
      if (kind === 'live') {
        const settled = await this.reconcilePending(snap);
        this.syncLive(snap, settled);
        if (this.state.pending) throw new Error('A transaction is still settling on chain; try again in a minute.');
      }
      for (const pos of [...pf.positions]) {
        const ok = await this.sell(pf, kind === 'live' ? this.liveExec : this.paperExec, snap, pos, 'panic sell by user', RISK.panicSlippageBps);
        if (!ok) failed.push(pos.symbol);
        if (this.state.pending) break;
      }
    } finally {
      this.busy = false;
      this.saveState();
    }
    if (failed.length) throw new Error(`Panic sell failed for ${failed.join(', ')} — see the activity log. Stop-loss rules keep protecting them.`);
  }
}
