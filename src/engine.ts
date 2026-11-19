import fs from 'node:fs';
import path from 'node:path';
import { encodePacked, formatUnits, parseEther, parseUnits, type Hex } from 'viem';
import { ADDR, CONFIG, DATA_DIR, GAS_TOPUP, ML, RISK, STRATEGY, TOKENS, USDC_DECIMALS, type TokenCfg } from './config.js';
import { publicClient } from './chain.js';
import { appendRotatingLog, readLogTail, redactDiagnostic } from './diagnostics.js';
import { writeJson } from './persistence.js';
import { assertForkTestEnvironment } from './forktest-env.js';
import { runResearch, type BacktestResult, type Research } from './backtest.js';
import {
  fillFromReceipt, gasUsd, LiveExecutor, LiveSendBlocked, PaperExecutor, swapGasUnits, topUpFromReceipt, transactionSettlement, type Executor, type Fill, type SwapRequest,
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
import { MevSearcher } from './mev/searcher.js';

/** Journal of an in-flight live transaction. Written BEFORE broadcast so a crash or timeout can be reconciled from chain. */
interface PendingSwap {
  side: 'BUY' | 'SELL' | 'GAS';
  symbol: string;
  amountIn: string;
  startedAt: number;
  hash: Hex | null;
  deadline: number | null;
  approvalHashes?: Hex[];
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
  netRiskBaseline?: true;
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
const errMsg = (e: unknown) => redactDiagnostic(((e as Error)?.message ?? String(e)).split('\n')[0]).slice(0, 300);
const HOUR = 3_600_000;
const positive = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value > 0;
const liveEnabled = () => CONFIG.allowLiveTrading || CONFIG.forkMode;

export class Engine {
  status: 'starting' | 'running' | 'error' = 'starting';
  startupStep = 'Loading';
  lastError: string | null = null;
  liveFault: string | null = null;
  walletReady = false;
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
  /** MEV arbitrage searcher (scans every block; sends bundles only when armed) */
  mev: MevSearcher | null = null;
  private mlModel: LogitModel | null = null;
  private lastMlScoreHour = -1;
  private paperExec = new PaperExecutor();
  private liveExec!: LiveExecutor;
  private lastHourSaved = 0;
  private lastEquityPoint = 0;
  private lastResearchAt = 0;
  private lastGasWarn = 0;
  private liveActed = false; // a live buy/sell was attempted this tick
  private entryEpoch = 0;
  private disarmEpoch = 0;
  private panicActive = false;

  constructor() {
    this.state = this.loadState();
    try {
      this.events = readLogTail(EVENTS_FILE).slice(-300).flatMap((line) => {
        try { return [JSON.parse(line) as BotEvent]; } catch { return []; }
      });
    } catch { /* first run */ }
  }

  // ------------------------------------------------------------------ logging & state
  log(msg: string, level: BotEvent['level'] = 'info') {
    const e: BotEvent = { t: Date.now(), level, msg: redactDiagnostic(msg) };
    this.events.push(e);
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
    try { appendRotatingLog(EVENTS_FILE, JSON.stringify(e) + '\n'); } catch { /* keep diagnostics available in memory */ }
    console.log(`[${new Date(e.t).toISOString()}] ${level.toUpperCase()} ${e.msg}`);
  }

  private loadState(): BotState {
    try {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as BotState;
      if (s.version === 1 && s.paper?.kind === 'paper' && s.live?.kind === 'live') {
        s.pending ??= null;
        s.topups ??= [];
        s.heldMarkets ??= {};
        for (const pf of [migratePortfolio(s.paper), migratePortfolio(s.live)]) {
          if (!Array.isArray(pf.trades) || !Array.isArray(pf.equityHistory) || !pf.cooldowns || !Number.isFinite(pf.cashUsd) || !Number.isFinite(pf.gasSpentUsd)) throw new Error('Invalid portfolio state');
          const lastBuy = pf.trades.slice().reverse().find((trade) => trade.side === 'BUY');
          pf.lastEntryHour ??= lastBuy ? Math.floor(lastBuy.time / HOUR) : null;
          for (const pos of pf.positions) {
            if (positive(pos.entryMid) && positive(pos.stopPrice) && positive(pos.targetPrice) && positive(pos.peakPrice)) continue;
            if (!positive(pos.entryPrice) || !positive(pos.stopPct) || pos.stopPct >= 1 || !positive(pos.targetPct)) throw new Error('Invalid open position');
            pos.entryMid = pos.entryPrice;
            pos.stopPrice = pos.entryPrice * (1 - pos.stopPct);
            pos.targetPrice = pos.entryPrice * (1 + pos.targetPct);
            pos.peakPrice = pos.entryPrice;
            pos.trailActive = false;
          }
        }
        if (!s.netRiskBaseline) {
          s.live.peakEquity = Math.max(0, s.live.peakEquity - s.live.gasSpentUsd);
          s.live.dayStartEquity = Math.max(0, s.live.dayStartEquity - s.live.gasSpentUsd);
          s.netRiskBaseline = true;
        }
        s.armed = false;
        s.armedAt = null;
        return s;
      }
      throw new Error('Unsupported portfolio state');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.liveFault = 'Trading state could not be loaded. Preserve and repair state.json before restarting.';
    }
    return {
      version: 1, armed: false, armedAt: null, entriesPaused: false, lastUsdcRaw: null, lastTradeBlock: null, pending: null, topups: [],
      heldMarkets: {}, netRiskBaseline: true, paper: newPortfolio('paper', CONFIG.paperStartUsd), live: newPortfolio('live', 0),
    };
  }

  saveState(required = false) {
    if (this.liveFault) {
      if (required) throw new Error(this.liveFault);
      return false;
    }
    try {
      writeJson(STATE_FILE, this.state);
      return true;
    } catch (error) {
      this.liveFault = 'Trading state could not be saved. Review storage and restart to reconcile pending transactions.';
      this.state.armed = false;
      this.entryEpoch++;
      try { this.mev?.disarm('because trading state could not be saved'); } catch { /* liveFault also blocks signing */ }
      this.log(`${this.liveFault} ${errMsg(error)}`, 'error');
      if (required) throw new Error(this.liveFault, { cause: error });
      return false;
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
      void this.mev?.refreshPools().catch((e) => this.log(`MEV pool refresh failed: ${errMsg(e)}`, 'warn'));
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
        if (CONFIG.forkMode) {
          this.startupStep = 'Verifying local Anvil';
          await assertForkTestEnvironment();
        }
        this.startupStep = 'Loading wallet';
        this.wallet = loadOrCreateWallet();
        this.liveExec = new LiveExecutor(this.wallet.account);
        const storage = this.wallet.storage === 'macOS Keychain' ? 'macOS Keychain' : 'local key file';
        if (this.wallet.created) this.log(`Created new bot wallet ${this.wallet.account.address} (key stored in ${storage})`);
        else this.log(`Bot wallet ${this.wallet.account.address} (key in ${storage})`);

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

        this.mev = new MevSearcher({
          log: (m, level) => this.log(m, level),
          account: this.wallet.account,
          exec: this.liveExec,
          ethUsd: () => (this.snap && this.isCurrent(this.snap) ? this.snap.ethUsd : null),
          gasPriceGwei: () => (this.snap ? this.snap.baseFeeGwei + this.snap.tipGwei : null),
          baseFeeGwei: () => (this.snap && this.isCurrent(this.snap) ? this.snap.baseFeeGwei : null),
          tokens: () => this.market.tokens.map((t) => t.token),
          tradePending: () => !!this.state.pending || !!this.liveFault || this.stopping || this.panicActive,
        });
        this.startupStep = 'First market snapshot';
        await this.tick();
        this.startupStep = 'Backtesting rules and training the ML model (walk-forward)';
        await this.runResearchNow();
        this.status = 'running';
        this.lastError = null;
        this.log(`Bot running. Scanning ${this.market.tokens.length} tokens, up to ${RISK.maxPositions} positions. Signals: ${this.mlActive ? 'ML' : 'rules'}. Live trading starts disarmed.`);
        void this.mev.start();
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
    this.mev?.stop();
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
  private isCurrent(snap: Snapshot) {
    if (!positive(snap.ethUsd) || !Number.isFinite(snap.timestamp)) return false;
    if (this.snap && snap.blockNumber < this.snap.blockNumber) return false;
    if (CONFIG.forkMode) return true;
    const age = Date.now() - snap.timestamp * 1000;
    return age >= -30_000 && age <= 120_000;
  }

  private async walletSettled() {
    await this.mev?.reconcileWallet();
    const settled = await this.liveExec.reconcileWallet();
    return settled && !this.mev?.walletPending();
  }

  private canTrade(snap: Snapshot) {
    return liveEnabled() && !this.liveFault && !this.stopping && this.isCurrent(snap) && !this.mev?.walletPending() &&
      (this.state.lastTradeBlock === null || snap.blockNumber >= BigInt(this.state.lastTradeBlock));
  }

  async tick() {
    if (this.busy || this.stopping || this.panicActive) return;
    this.busy = true;
    try {
      const snap = await snapshot(this.market, this.wallet.account.address);
      if (!this.isCurrent(snap)) throw new Error('Ethereum snapshot is stale, invalid or behind the previous block');
      this.snap = snap;
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

      const walletSettled = await this.walletSettled();
      const settled = await this.reconcilePending(snap);
      this.syncLive(snap, settled && walletSettled);
      this.liveActed = false;

      // live first (real money has priority): exits/entries before anything else, each step isolated
      try {
        if (walletSettled && settled) await this.manageLive(snap);
        else this.liveStatus = { ready: false, reason: 'Waiting for wallet settlement' };
      } catch (e) {
        this.log(`[live] decision error: ${errMsg(e)}`, 'error');
      }
      try {
        // gas top-up only on a quiet tick (no live trade just happened, nothing in flight)
        if (walletSettled && settled && !this.liveActed && !this.state.pending) await this.maybeTopUpGas(snap);
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
      this.walletReady = !this.liveFault && !this.state.pending && !this.mev?.walletPending() && walletSettled && this.isCurrent(snap);
      this.lastTickAt = Date.now();
    } catch (error) {
      this.walletReady = false;
      throw error;
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

  private riskEquity(pf: PortfolioState, snap: Snapshot) {
    return Math.max(0, this.equity(pf, snap) - (pf.kind === 'live' ? pf.gasSpentUsd : 0));
  }

  /**
   * Settles a journaled in-flight transaction (after a crash, broadcast error or receipt timeout) from on-chain facts.
   * Returns false while it is still unresolved: balances are then in flux and must not be read as deposits.
   */
  private async reconcilePending(snap: Snapshot): Promise<boolean> {
    const p = this.state.pending;
    if (!p) return true;
    const hashes = [...(p.approvalHashes ?? []), ...(p.hash ? [p.hash] : [])];
    const outcomes = await Promise.all(hashes.map((hash) => transactionSettlement(hash, Date.now() - p.startedAt > 45_000)));
    if (outcomes.some((outcome) => outcome.status === 'pending')) {
      this.state.live.lastDecision = `Waiting for in-flight ${p.side} ${p.symbol} transaction or approval to settle`;
      return false;
    }
    let gasWei = 0n;
    let lastBlock = 0n;
    for (const outcome of outcomes) {
      if (outcome.status !== 'receipt') continue;
      const { receipt } = outcome;
      gasWei += receipt.gasUsed * receipt.effectiveGasPrice;
      if (receipt.blockNumber > lastBlock) lastBlock = receipt.blockNumber;
    }
    const gasUsdSpent = (Number(gasWei) / 1e18) * snap.ethUsd;
    const terminal = p.hash ? outcomes.at(-1) : undefined;
    const receipt = terminal?.status === 'receipt' ? terminal.receipt : null;
    if (receipt?.status === 'success') {
      if (p.side === 'GAS') {
        const g = topUpFromReceipt(receipt, this.wallet.account.address);
        if (g.usdcIn === 0n || g.ethOut === 0n) throw new Error('Pending gas top-up receipt amounts could not be verified');
        this.bookGasTopup(g.usdcIn, g.ethOut, gasUsdSpent, receipt.blockNumber);
      } else {
        const t = this.findTm(p.symbol);
        if (!t) throw new Error(`Cannot reconcile ${p.symbol} until its market is restored`);
        const [tokenIn, tokenOut] = p.side === 'BUY' ? [ADDR.usdc, t.token.address] : [t.token.address, ADDR.usdc];
        const f = fillFromReceipt(receipt, tokenIn, tokenOut, this.wallet.account.address);
        if (f.amountIn === 0n || f.amountOut === 0n) throw new Error('Pending swap receipt amounts could not be verified');
        const fill = { amountIn: f.amountIn, amountOut: f.amountOut, gasUsd: gasUsdSpent, txHashes: hashes, blockNumber: receipt.blockNumber };
        if (p.side === 'BUY') {
          const mid = positive(p.mid) ? p.mid : Number(formatUnits(f.amountIn, USDC_DECIMALS)) / Number(formatUnits(f.amountOut, t.token.decimals));
          this.commitBuy(this.state.live, t, fill, mid, p.stopPct, p.targetPct, p.reason, snap);
        } else this.commitSell(this.state.live, t, fill, p.reason);
      }
      this.log(`[live] Reconciled ${p.side} ${p.symbol} from receipt ${p.hash}.`, 'trade');
    } else {
      this.state.live.gasSpentUsd += gasUsdSpent;
      if (p.side === 'GAS') this.state.topups.push({ t: p.startedAt, usd: 0, eth: 0 });
      if (lastBlock > 0n) this.state.lastTradeBlock = lastBlock.toString();
      this.state.pending = null;
      this.saveState();
      this.log(`[live] Settled ${p.side} ${p.symbol} without a fill. Verified gas ${usd(gasUsdSpent)}.`, 'warn');
    }
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
        const qty = Number(formatUnits(bal, t.token.decimals));
        const price = snap.prices[pos.symbol];
        if (bal !== BigInt(pos.qtyRaw)) {
          if (!positive(price)) {
            this.warnLive(`Waiting for a current price before reconciling the changed ${pos.symbol} balance`);
            continue;
          }
          const delta = (qty - pos.qty) * price;
          const retained = Math.min(1, qty / pos.qty);
          pos.costUsd = pos.costUsd * retained + Math.max(delta, 0);
          pos.entryGasUsd *= retained;
          pos.entryPrice = pos.costUsd / qty;
          const exitGas = gasUsd(swapGasUnits(t.hops, RISK.approvalMode === 'exact'), snap.baseFeeGwei + snap.tipGwei, snap.ethUsd);
          pos.breakevenPrice = (pos.costUsd + pos.entryGasUsd + exitGas) / (qty * (1 - t.poolFeePct - 0.001));
          live.netDepositsUsd += delta;
          live.peakEquity = Math.max(0, live.peakEquity + delta);
          live.dayStartEquity = Math.max(0, live.dayStartEquity + delta);
          this.log(`[live] Reconciled external ${pos.symbol} balance change of ${usd(delta)}`, 'warn');
        }
        pos.qtyRaw = bal.toString();
        pos.qty = qty;
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
    if (!GAS_TOPUP.enabled || !this.state.armed || !this.canTrade(snap) || this.state.pending) return;
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
    const epoch = this.entryEpoch;
    const canSend = () => this.state.armed && epoch === this.entryEpoch && this.canTrade(snap);
    try {
      const journal = this.journal({ side: 'GAS', symbol: 'ETH', amountIn: usdcIn.toString(), reason: 'gas top-up', stopPct: 0, targetPct: 0, mid: snap.ethUsd });
      const r = await this.liveExec.topUpGas(usdcIn, path, RISK.maxSlippageBps, snap.ethUsd, journal.onSwapSigned, (m) => this.log(`[live] ${m}`), journal.onApprovalSigned, canSend);
      this.bookGasTopup(r.usdcIn, r.ethOut, r.gasUsd, r.blockNumber);
    } catch (e) {
      this.discardUnsigned();
      if (!this.state.pending && !(e instanceof LiveSendBlocked)) this.state.topups.push({ t: now, usd: 0, eth: 0 });
      this.log(`[live] gas top-up: ${errMsg(e)}`, 'warn');
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
    if (this.liveFault) return { ready: false, reason: this.liveFault };
    if (!liveEnabled()) return { ready: false, reason: 'Live broadcasting disabled by configuration' };
    if (!this.state.armed) return { ready: false, reason: 'Disarmed. Automated wallet activity is off.' };
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
    if (this.state.pending || !this.state.armed || !this.canTrade(snap)) return;
    if (live.positions.length > 0 || this.liveStatus.ready) {
      // While armed, entry halts do not prevent exits.
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
    const pricesComplete = pf.positions.every((p) => positive(snap.prices[p.symbol]));
    const equity = pricesComplete ? this.riskEquity(pf, snap) : null;
    const dayKey = new Date(snap.timestamp * 1000).toISOString().slice(0, 10);
    if (equity !== null && pf.dayKey !== dayKey) { pf.dayKey = dayKey; pf.dayStartEquity = equity; pf.pausedUntil = null; }
    if (equity !== null) pf.peakEquity = Math.max(pf.peakEquity, equity);
    if (equity !== null && !pf.halted && pf.peakEquity > 0 && equity < pf.peakEquity * (1 - RISK.maxDrawdownPct)) {
      pf.halted = `max drawdown ${(RISK.maxDrawdownPct * 100).toFixed(0)}% reached`;
      this.log(`[${pf.kind}] Circuit breaker: ${pf.halted}. No new buys until you reset it.`, 'warn');
    }
    if (equity !== null && !pf.pausedUntil && pf.dayStartEquity > 0 && equity < pf.dayStartEquity * (1 - RISK.dailyLossLimitPct)) {
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
      sold = await this.sell(pf, exec, snap, pos, ex.reason, RISK.maxSlippageBps) || sold;
      if (this.state.pending) return; // an unresolved live transaction: stop this tick
      if (sold && pf.kind === 'live') break; // the next wallet action needs a post-fill snapshot
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
    const hour = Math.floor(snap.timestamp / 3600);
    if (pf.lastEntryHour !== null && pf.lastEntryHour !== undefined && hour <= pf.lastEntryHour) return 'Already opened a position this hour.';
    if (pf.positions.some((p) => !positive(snap.prices[p.symbol]))) return 'Waiting for current prices of open positions.';
    const epoch = this.entryEpoch;
    const canEnter = () => this.entryEpoch === epoch && this.state[pf.kind] === pf && !this.state.entriesPaused && !pf.halted && !this.stopping && this.isCurrent(snap);
    const held = new Set(pf.positions.map((p) => p.symbol));
    const blocked: Record<string, number> = { ...pf.cooldowns, ...this.safetyBlocks };
    const free = this.analyses.filter((a) => !held.has(a.symbol) && positive(snap.prices[a.symbol]));

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
    const longTailExposure = pf.positions.reduce((sum, p) => this.findTm(p.symbol)?.token.core ? sum : sum + p.qty * snap.prices[p.symbol], 0);
    const capUsd = Math.min(
      (cash - gasReserve) * RISK.maxAllocPct,
      equity * RISK.maxPositionPct,
      t.token.core ? Infinity : equity * TOKENS.maxAllocPct - longTailExposure,
    );
    const size = Math.floor(Math.min(capUsd, (equity * RISK.riskPerTradePct) / cand.stopPct) * 100) / 100;
    if (!positive(size) || size < RISK.minTradeUsd) return `${cand.symbol} signal (${why}), but size ${usd(size)} < minimum ${usd(RISK.minTradeUsd)}.`;

    const amountIn = parseUnits(size.toFixed(6), USDC_DECIMALS);
    const q = await quoteExactIn(t.buyPath, amountIn);
    const outQty = Number(formatUnits(q.amountOut, t.token.decimals));
    const impact = Math.max(0, 1 - (outQty * snap.prices[cand.symbol]) / size); // pool fees + price impact
    const g = gasUsd(swapGasUnits(t.hops, RISK.approvalMode === 'exact'), snap.baseFeeGwei + snap.tipGwei, snap.ethUsd);
    const rtCost = 2 * impact + (2 * g) / size;
    if (!positive(outQty) || !Number.isFinite(rtCost)) return `${cand.symbol} quote or cost is invalid.`;
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
    if (!canEnter()) return `${cand.symbol} entry canceled.`;
    const ok = await this.buy(pf, exec, snap, t, cand, amountIn, why, canEnter);
    return ok ? `Bought ${cand.symbol} (${why}).` : `Buy of ${cand.symbol} failed — see log.`;
  }

  private journal(p: Omit<PendingSwap, 'startedAt' | 'hash' | 'deadline'>): Required<Pick<SwapRequest, 'onSwapSigned' | 'onApprovalSigned'>> {
    if (this.state.pending) throw new Error('A spot wallet operation is already awaiting settlement');
    let record: PendingSwap = { ...p, startedAt: Date.now(), hash: null, deadline: null };
    this.state.pending = record;
    this.saveState(true);
    const update = (patch: Partial<PendingSwap>) => {
      if (this.state.pending !== record) throw new Error('Spot journal changed before signing');
      this.state.pending = { ...record, ...patch };
      try { this.saveState(true); } catch (error) { this.state.pending = record; throw error; }
      record = this.state.pending;
    };
    return {
      onSwapSigned: (hash, deadline) => update({ hash, deadline }),
      onApprovalSigned: (hash) => update({ approvalHashes: [...(record.approvalHashes ?? []), hash] }),
    };
  }

  private async buy(pf: PortfolioState, exec: Executor, snap: Snapshot, t: TokenMarket, cand: Analysis, amountIn: bigint, why: string, canEnter = () => true): Promise<boolean> {
    const sym = t.token.symbol;
    const mid = snap.prices[sym];
    if (!positive(mid)) return false;
    const epoch = this.entryEpoch;
    const canSend = () => this.state.armed && epoch === this.entryEpoch && !this.panicActive && this.canTrade(snap) && canEnter();
    if (pf.kind === 'live' && !canSend()) return false;
    this.rememberMarket(t);
    if (pf.kind === 'live') this.liveActed = true;
    const reason = `${why}, momentum ${cand.momentum.toFixed(2)}σ, ${cand.trend} trend, RSI ${cand.rsi.toFixed(0)}`;
    this.log(`[${pf.kind}] BUY ${sym}: ${reason}, stop -${(cand.stopPct * 100).toFixed(1)}%, target +${(cand.targetPct * 100).toFixed(1)}%`, 'trade');
    let fill: Fill;
    try {
      const hooks = pf.kind === 'live' ? this.journal({ side: 'BUY', symbol: sym, amountIn: amountIn.toString(), reason, stopPct: cand.stopPct, targetPct: cand.targetPct, mid }) : {};
      fill = await exec.swap({
        path: t.buyPath, tokenIn: ADDR.usdc, tokenOut: t.token.address, amountIn, hops: t.hops,
        slippageBps: RISK.maxSlippageBps, gasPriceGwei: snap.baseFeeGwei + snap.tipGwei, ethUsd: snap.ethUsd, ...hooks, canSend,
      }, (m) => this.log(`[${pf.kind}] ${m}`));
    } catch (e) {
      this.onTradeFailure(pf, `buy ${sym}`, e, false);
      return false;
    }
    if (pf.kind === 'paper' && !canEnter()) return false;
    this.commitBuy(pf, t, fill, mid, cand.stopPct, cand.targetPct, reason, snap);
    return true;
  }

  private commitBuy(pf: PortfolioState, t: TokenMarket, fill: Fill, mid: number, stopPct: number, targetPct: number, reason: string, snap: Snapshot) {
    const spent = Number(formatUnits(fill.amountIn, USDC_DECIMALS));
    const pos = this.makePosition(t, fill.amountOut, spent, mid, fill.gasUsd, stopPct, targetPct, snap);
    pf.positions.push(pos);
    pf.lastEntryHour = Math.floor(snap.timestamp / 3600);
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

  private async sell(pf: PortfolioState, exec: Executor, snap: Snapshot, pos: Position, reason: string, slippageBps: number, manual = false): Promise<boolean> {
    const epoch = this.disarmEpoch;
    const canSend = () => epoch === this.disarmEpoch && this.canTrade(snap) && (manual ? this.panicActive : this.state.armed && !this.panicActive);
    if (pf.kind === 'live' && !canSend()) return false;
    const t = this.tm(pos.symbol);
    if (pf.kind === 'live') this.liveActed = true;
    this.log(`[${pf.kind}] SELL ${pos.symbol}: ${reason}`, 'trade');
    const amountIn = BigInt(pos.qtyRaw);
    let fill: Fill;
    try {
      const hooks = pf.kind === 'live' ? this.journal({ side: 'SELL', symbol: pos.symbol, amountIn: amountIn.toString(), reason, stopPct: pos.stopPct, targetPct: pos.targetPct, mid: snap.prices[pos.symbol] ?? pos.entryMid }) : {};
      fill = await exec.swap({
        path: t.sellPath, tokenIn: t.token.address, tokenOut: ADDR.usdc, amountIn, hops: t.hops,
        slippageBps, gasPriceGwei: snap.baseFeeGwei + snap.tipGwei, ethUsd: snap.ethUsd, ...hooks, canSend,
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
    if (idx === -1) {
      if (pf.kind === 'live') {
        pf.gasSpentUsd += fill.gasUsd;
        this.afterLiveFill(fill.amountOut, fill.blockNumber);
        this.saveState();
      }
      return;
    }
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
    if (pf.kind === 'live') this.discardUnsigned();
    if (e instanceof LiveSendBlocked) {
      this.log(`[${pf.kind}] ${what} canceled before broadcast. Any signed approvals will be reconciled.`, 'warn');
      this.saveState();
      return;
    }
    pf.consecutiveFailures++;
    if (isExit) pf.exitRetryAfter = Date.now() + 60_000 * Math.min(5, pf.consecutiveFailures);
    else pf.retryAfter = Date.now() + 10 * 60_000;
    this.log(`[${pf.kind}] ${what} failed (${pf.consecutiveFailures}/${RISK.maxConsecutiveFailures}): ${errMsg(e)}`, 'error');
    if (pf.consecutiveFailures >= RISK.maxConsecutiveFailures && !pf.halted) {
      pf.halted = `${pf.consecutiveFailures} failed trades in a row`;
      this.log(`[${pf.kind}] HALTED new buys after repeated failures. Review the log before resetting.`, 'error');
    }
    this.saveState();
  }

  private discardUnsigned() {
    if (this.state.pending && !this.state.pending.hash && !this.state.pending.approvalHashes?.length) this.state.pending = null;
  }

  // ------------------------------------------------------------------ controls
  arm() {
    if (!liveEnabled()) throw new Error('Live broadcasting is disabled by configuration');
    if (this.liveFault || this.stopping || this.panicActive) throw new Error(this.liveFault ?? 'Wallet controls are busy');
    this.state.armed = true;
    this.state.armedAt = Date.now();
    this.saveState(true);
    this.log('Live trading ARMED by user. The bot will trade the wallet\'s USDC (and buy its own gas) automatically.', 'warn');
  }

  disarm() {
    this.state.armed = false;
    this.entryEpoch++;
    this.disarmEpoch++;
    this.log('Live trading disarmed. Automated sends are off. Already submitted transactions may still settle.', 'warn');
    try { this.mev?.disarm('together with spot trading'); } finally { this.saveState(); }
  }

  setPaused(p: boolean) {
    this.entryEpoch++;
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
    const snap = this.snap;
    if (snap && pf.positions.every((p) => positive(snap.prices[p.symbol]))) pf.peakEquity = this.riskEquity(pf, snap);
    this.log(`[${kind}] Circuit breaker reset by user.`, 'warn');
    this.saveState();
  }

  resetPaper() {
    this.entryEpoch++;
    this.state.paper = newPortfolio('paper', CONFIG.paperStartUsd);
    this.log(`Paper portfolio reset to ${usd(CONFIG.paperStartUsd)}.`);
    this.saveState();
  }

  /** Sell every open position now. Throws if any could not be sold. */
  async panic(kind: 'paper' | 'live') {
    if (this.panicActive) throw new Error('A liquidation request is already running');
    this.panicActive = true;
    let locked = false;
    try {
      if (kind === 'live') {
        this.disarm();
        if (!liveEnabled() || this.liveFault) throw new Error(this.liveFault ?? 'Live broadcasting is disabled by configuration');
      }
      const waitUntil = Date.now() + 10_000;
      while (this.busy && Date.now() < waitUntil) await sleep(250);
      if (this.busy) throw new Error('The active tick is still settling. New automated sends are disarmed. Retry Panic after it settles.');
      this.busy = true;
      locked = true;
      const pf = this.state[kind];
      if (!pf.positions.length && (kind === 'paper' || (!this.state.pending && await this.walletSettled()))) {
        this.log(`[${kind}] Panic: no open positions.`, 'warn');
        return;
      }
      let snap = await snapshot(this.market, this.wallet.account.address);
      if (!this.isCurrent(snap)) throw new Error('Cannot liquidate using a stale Ethereum snapshot');
      if (kind === 'live') {
        if (!await this.walletSettled()) throw new Error('A wallet transaction is still settling. Retry Panic after it settles.');
        const settled = await this.reconcilePending(snap);
        if (this.state.pending) throw new Error('A transaction is still settling on chain; try again in a minute.');
        if (!settled) throw new Error('Wallet settlement just completed. Retry Panic with a fresh balance snapshot.');
        this.syncLive(snap, true);
      }
      const failed: string[] = [];
      const positions = [...pf.positions];
      for (const [index, pos] of positions.entries()) {
        const ok = await this.sell(pf, kind === 'live' ? this.liveExec : this.paperExec, snap, pos, 'panic sell by user', RISK.panicSlippageBps, true);
        if (!ok) failed.push(pos.symbol);
        if (kind === 'live' && this.state.pending) throw new Error('A liquidation transaction is still settling. Review the wallet before retrying.');
        if (ok && kind === 'live' && index + 1 < positions.length) snap = await snapshot(this.market, this.wallet.account.address);
      }
      if (failed.length) throw new Error(`Panic sell failed for ${failed.join(', ')}. See the activity log.`);
    } finally {
      if (locked) {
        this.busy = false;
        this.saveState();
      }
      this.panicActive = false;
    }
  }
}
