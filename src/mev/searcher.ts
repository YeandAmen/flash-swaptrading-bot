import fs from 'node:fs';
import path from 'node:path';
import { BaseError, ExecutionRevertedError, keccak256, pad, parseEventLogs, TransactionReceiptNotFoundError, type Address, type Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { CONFIG, CORE_TOKENS, DATA_DIR, MEV, type TokenCfg } from '../config.js';
import { mevPoolClient, mevReadClient, nextBaseFee, publicClient } from '../chain.js';
import { redactDiagnostic } from '../diagnostics.js';
import { transactionSettlement, UncertainTxError, type LiveExecutor } from '../executor.js';
import type { McResult } from '../market.js';
import { writeJson } from '../persistence.js';
import { FLASH_ARB_V2_ABI, FLASH_ARB_V2_BYTECODE, FLASH_ARB_V2_RUNTIME } from './artifact-v2.js';
import { bundleTraceRequests, requestBuilderTrace } from './builder-trace.js';
import { decodeArbitrage, encodeArbitrage, EXECUTION_GAS_ADDON, FUNDING_NAMES, fundingTrials, type RouteFunding } from './flash-arb.js';
import { sendBundle, type BuilderResult } from './bundles.js';
import { routeInputSizes } from './sizing.js';
import { arbGas, bestCycle, buildStateReads, MEV_EXTRA_TOKENS, poolIdentity, poolVenue, reservesOf, type ArbPool, type ArbToken } from './pools.js';
import { MevUniverse } from './universe.js';

const STATE_FILE = path.join(DATA_DIR, 'mev.json');
/** Address where paper-mode simulations place the contract code (eth_call state override; nothing is deployed). */
const SIM_ADDR: Address = '0x00000000000000000000000000000000000ab1e5';
const HOUR = 3_600_000;
const IDLE_BID_AFTER_MS = 30 * 60_000;
const NORMAL_GAS_PADDING_PCT = 0.25;
const SLOT_MS = 12_000;
const FALLBACK_LEAD_MS = 5_000;
const HEAD_RETRY_MS = 400;
const POOL_READS_PER_CHUNK = 160;
const RECEIPT_CONFIRMATIONS = 2n;
const RECENT_LIMIT = 60;
const RECENT_BUNDLE_LIMIT = 10;
const DASHBOARD_RECENT_LIMIT = 15;
const DASHBOARD_BUNDLE_LIMIT = 5;
const MAX_STARTUP_TRACE_BUNDLES = 6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => redactDiagnostic(((e as Error)?.message ?? String(e)).split('\n')[0]).slice(0, 200);
const eth = (wei: bigint) => Number(wei) / 1e18;
const validPrice = (price: number | null): price is number => price !== null && Number.isFinite(price) && price > 0;

/** The bits of the trading engine the searcher needs. */
export interface MevHost {
  log(msg: string, level?: 'info' | 'warn' | 'error' | 'trade'): void;
  account: PrivateKeyAccount;
  exec: LiveExecutor;
  ethUsd(): number | null;
  /** latest base fee from the trading loop's block header (refreshed every ~30 s); null = read it ourselves */
  baseFeeGwei(): number | null;
  tokens(): TokenCfg[];
  /** an unresolved trading transaction exists (its nonce may still land) */
  tradePending(): boolean;
}

export type OppStatus = 'below gas' | 'would send' | 'sent' | 'landed' | 'not included' | 'failed' | 'skipped';

export interface MevOpp {
  t: number;
  block: number;
  symbol: string;
  buy: string; // venue where TOKEN is bought
  sell: string; // venue where it is sold
  sizeEth: number;
  grossEth: number; // profit before gas and tip
  gasEth: number;
  tipEth: number;
  netEth: number; // ours after gas and tip
  netUsd: number;
  status: OppStatus;
  count?: number; // times seen (repeats are merged)
  note?: string;
  hash?: Hex;
  ownerPayoutEth?: number; // successful contract payout before the owner's transaction fee
  funding?: (typeof FUNDING_NAMES)[number];
  lenderFeeEth?: number;
  submission?: BundleSubmission;
}

/** Preserve submission details through busy stretches of simulation results. */
function retainRecent(rows: MevOpp[], limit: number, bundleLimit: number): MevOpp[] {
  let bundlesLeft = Math.min(bundleLimit, rows.filter((row) => row.submission).length);
  let otherRowsLeft = limit - bundlesLeft;
  return rows.filter((row) => row.submission ? bundlesLeft-- > 0 : otherRowsLeft-- > 0);
}

interface BundleSubmission {
  target: number;
  startedAt: number;
  leadMs: number;
  gasEth: number;
  tipEth: number;
  netUsd: number;
  builders: BuilderResult[];
}

interface MevStats {
  since: number;
  blocks: number;
  candidates: number; // price gaps the quick math liked
  simulated: number; // checked exactly on-chain (eth_call)
  profitable: number; // still profitable after gas
  bundles: number;
  landed: number;
  lastLandedAt?: number;
  netEth: number;
  netUsd: number;
  rpcCalls: number;
}

interface MevFile {
  version: 1;
  armed: boolean;
  armedAt: number | null;
  contract: Address | null;
  v2Contract?: Address | null;
  v2DeployedAt?: number;
  v2DeployGasUsd?: number;
  deployedAt: number | null;
  deployTx: Hex | null;
  deployVersion?: 'v2' | null;
  deployNonce: number | null;
  deployStartedAt: number | null;
  deployGasUsd: number;
  stats: MevStats;
  recent: MevOpp[];
  best: HourBest[];
  pending: PendingBundle | null;
}

interface PendingBundle {
  hash: Hex;
  nonce: number;
  target: string;
  contract: Address;
  ethUsd: number;
  opp: MevOpp;
}

/** Closest the searcher got to a profitable arbitrage in one hour (ETH). */
interface HourBest {
  h: number; // hour start
  estGross: number; // best quick-math estimate before gas (every block, every token)
  estGas: number;
  estSymbol: string;
  simGross: number | null; // best exact simulation before gas (only gaps the quick math liked)
  simGas: number | null;
  simSymbol: string | null;
}

interface BlockRead {
  blockNumber: bigint;
  timestamp: number;
  nextBaseFee: bigint;
  hash: Hex;
  tokens: ArbToken[];
  at: number[][];
  results: McResult[];
  readMs: number;
  failedChunks: number;
}

interface Candidate {
  t: ArbToken;
  A: ArbPool;
  B: ArbPool;
  dx: number;
  est: number;
  estimatedNet: number;
  gasUnits: number;
}

interface Offer {
  candidate: Candidate;
  amount: bigint;
  profit: bigint;
  funding: RouteFunding;
  score: bigint;
  opp: MevOpp;
}

interface SimulatedSize {
  amount: bigint;
  profit: bigint;
  funding: RouteFunding;
  gasUnits: number;
  net: bigint;
}

interface EvaluatedRoute {
  primary: Offer | null;
  fallback?: Offer;
}

interface PreparedOffer {
  offer: Offer;
  contract: Address;
  ethUsd: number;
  data: Hex;
  gas: bigint;
  gasBudget: bigint;
  tip: bigint;
  minimumProfit: bigint;
  net: bigint;
}

interface ProfitPolicy {
  idle: boolean;
  minNetUsd: number;
  builderTipPct: number;
  gasPaddingPct: number;
}

interface RouteCooldown {
  until: number;
  est: number;
  grow: number;
  revertStreak?: number;
  gasRetry?: { profit: bigint; gasUnits: number };
}

const STRUCTURAL_REVERTS = new Set(['v2 factory', 'v3 factory', 'v4 key', 'pool parameters', 'same pool']);
const ROUTE_RETRY_MS = 30_000;
const MAX_REVERT_RETRY_MS = 5 * 60_000;
const MAX_REVERT_STREAK = 5;

function estimateChanged(estimate: number, cooldown: RouteCooldown): boolean {
  return estimate >= cooldown.est * cooldown.grow
    || (cooldown.revertStreak !== undefined && estimate <= cooldown.est / cooldown.grow);
}

/** Short revert reason from a viem error ("unprofitable", "transfer", ...). */
function reasonOf(e: unknown): string {
  const x = e as { shortMessage?: string; details?: string; message?: string };
  const s = redactDiagnostic([x.details, x.shortMessage, x.message].filter(Boolean).join(' | '));
  const m = s.match(/reverted(?: with reason string)?:?\s*'?([^'|\n]{1,60})/i);
  return (m?.[1] ?? s.split('\n')[0]).trim().slice(0, 80) || 'reverted';
}

/**
 * Scan block-pinned pool state for two-venue price differences. Rank by estimated net profit, then simulate candidate
 * sizes against that block. A live order must cover its gas budget, builder tip and configured profit floor.
 */
export class MevSearcher {
  private readonly scheduledTraces = new WeakSet<BuilderResult>();
  file: MevFile;
  tokens: ArbToken[] = [];
  status = 'starting';
  lastError: string | null = null;
  lastBlock: { number: number; at: number; candidates: number; readMs: number; decisionMs: number | null; failedChunks: number } | null = null;
  private deploying = false;
  private reads: ReturnType<typeof buildStateReads> | null = null;
  private poolsAt = 0;
  private universe: MevUniverse;
  private refreshingPools: Promise<void> | null = null;
  private stateReadError: string | null = null;
  private recovery: Promise<void> | null = null;
  private bundleReserved = false;
  private contractReady = false;
  private armGeneration = 0;
  private cooldown = new Map<string, RouteCooldown>();
  private previousSizes = new Map<string, { amount: bigint; at: number }>();
  private stopping = false;

  constructor(private host: MevHost, private persist = true) {
    this.file = this.load();
    this.universe = new MevUniverse(persist, (message, level) => this.host.log(`[mev] ${message}`, level), {
      includePancakeV3: true, includeUniswapV4: true,
    });
  }

  private get selectedContract() { return this.file.v2Contract ?? null; }
  private get configuredContract() { return MEV.v2ContractAddress; }

  private get pending() { return this.file.pending; }

  // ------------------------------------------------------------------ persistence
  private loadSaved(): MevFile | null {
    if (!this.persist) return null;
    try {
      const f = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as MevFile;
      if (f.version !== 1 || !f.stats || !Array.isArray(f.recent)) throw new Error('invalid MEV state');
      if ((f.deployTx != null && !/^0x[0-9a-f]{64}$/i.test(f.deployTx))
        || (f.deployVersion != null && f.deployVersion !== 'v2')
        || (f.contract != null && !/^0x[0-9a-f]{40}$/i.test(f.contract))
        || (f.v2Contract != null && !/^0x[0-9a-f]{40}$/i.test(f.v2Contract))) throw new Error('invalid MEV contract state');
      f.best = Array.isArray(f.best) ? f.best.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) : [];
      f.deployStartedAt ??= null;
      f.deployNonce ??= null;
      f.pending ??= null;
      const pending = f.pending;
      if (pending !== null) {
        if (!/^0x[0-9a-f]{64}$/i.test(pending.hash) || !/^0x[0-9a-f]{40}$/i.test(pending.contract)
          || !/^\d+$/.test(pending.target) || !Number.isSafeInteger(pending.nonce) || pending.nonce < 0
          || !validPrice(pending.ethUsd) || !pending.opp || pending.opp.hash !== pending.hash) throw new Error('invalid bundle journal');
        const recorded = f.recent.find((o) => o?.hash === pending.hash);
        if (recorded) pending.opp = recorded;
        else f.recent.unshift(pending.opp);
      }
      f.armed = false;
      f.armedAt = null;
      return f;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.stateReadError = 'MEV state could not be read. Restore the state file before allowing wallet sends.';
      return null;
    }
  }

  private load(): MevFile {
    return this.loadSaved() ?? {
      version: 1, armed: false, armedAt: null, contract: null, deployedAt: null, deployTx: null, deployNonce: null, deployStartedAt: null, deployGasUsd: 0,
      stats: { since: Date.now(), blocks: 0, candidates: 0, simulated: 0, profitable: 0, bundles: 0, landed: 0, netEth: 0, netUsd: 0, rpcCalls: 0 },
      recent: [], best: [], pending: null,
    };
  }

  save() {
    if (!this.persist || this.stateReadError) return;
    try { this.writeState(); } catch { this.host.log('MEV state file could not be saved.', 'error'); }
  }

  private writeState() {
    if (!this.persist || this.stateReadError) throw new Error(this.stateReadError ?? 'MEV recovery journal is disabled');
    writeJson(STATE_FILE, { ...this.file, armed: false, armedAt: null });
  }

  walletPending(): boolean {
    return Boolean(this.stateReadError || this.pending || this.file.deployTx || this.deploying);
  }

  private liveArmed(generation: number): boolean {
    return this.persist && !this.stateReadError && !this.stopping && MEV.enabled
      && (CONFIG.allowLiveTrading || CONFIG.forkMode) && this.file.armed && this.armGeneration === generation;
  }

  private modeText(): string {
    if (this.stateReadError) return this.stateReadError;
    if (!MEV.enabled) return 'Off (MEV=off in .env)';
    if (this.deploying) return 'Deploying FlashArbV2…';
    if (this.file.deployTx) return 'Waiting for the deployment transaction to settle';
    if (this.file.armed && !this.contractReady) return 'Verifying the FlashArbV2 contract…';
    if (this.file.armed) return 'Live mode: eligible bundles go to the configured builders';
    return 'Paper mode: every block is scanned and simulated, nothing is sent';
  }

  // ------------------------------------------------------------------ lifecycle
  async start() {
    if (this.stateReadError) this.host.log(this.stateReadError, 'error');
    if (!MEV.enabled) { this.status = this.modeText(); return; }
    for (let i = 0; !this.stopping; i++) {
      try {
        await this.refreshPools();
        break;
      } catch (e) {
        this.lastError = errMsg(e);
        this.status = 'Finding arbitrage pools failed; retrying';
        await sleep(Math.min(120_000, 15_000 * (i + 1)));
      }
    }
    let recoveredTraces = 0;
    for (const outcome of this.file.recent) {
      if (outcome?.status === 'not included' && this.traceMissedBundle(outcome) && ++recoveredTraces >= MAX_STARTUP_TRACE_BUNDLES) break;
    }
    void this.loop();
    if (this.universe.broad && !this.stopping) void this.discoverMorePools();
  }

  stop() {
    this.stopping = true;
    this.disarm('during shutdown');
    this.save();
  }

  /** Start with core and recently watched tokens. Broader discovery runs alongside block scanning. */
  async refreshPools() {
    if (!MEV.enabled) return;
    if (!this.refreshingPools) this.refreshingPools = this.warmupPools().finally(() => { this.refreshingPools = null; });
    await this.refreshingPools;
  }

  private priorityTokens() {
    return [...CORE_TOKENS, ...MEV_EXTRA_TOKENS, ...this.host.tokens()];
  }

  private async warmupPools() {
    await this.universe.warmup(this.priorityTokens());
    this.poolsAt = Date.now();
    this.updatePools(true);
    this.status = this.modeText();
  }

  private updatePools(log = false) {
    const tokens = this.universe.active();
    this.tokens = tokens;
    this.reads = buildStateReads(tokens);
    if (log) {
      const pools = tokens.flatMap((t) => t.pools);
      const venues = [...new Set(pools.map(poolVenue))].join(', ');
      this.host.log(`MEV: watching ${tokens.length} tokens in ${pools.length} pools${venues ? ` (${venues})` : ''} — ${this.file.armed ? 'ARMED' : 'paper mode'}`);
    }
  }

  private async discoverMorePools() {
    while (!this.stopping) {
      let delayMs = 24 * HOUR;
      try {
        await this.universe.sweep(this.priorityTokens(), () => this.updatePools(), () => this.stopping);
        if (!this.stopping) this.updatePools(true);
      } catch (error) {
        this.host.log(`[mev] Expanded pool discovery paused: ${errMsg(error)}`, 'warn');
        delayMs = 5 * 60_000;
      }
      if (!this.stopping) await sleep(delayMs);
    }
  }

  private async loop() {
    let lastHash: Hex | null = null;
    let backoff = 0;
    while (!this.stopping) {
      try {
        if (!this.universe.broad && Date.now() - this.poolsAt > 24 * HOUR) await this.refreshPools();
        const head = await this.head();
        if (head.hash === lastHash) {
          const ageMs = Date.now() - Number(head.timestamp) * 1000;
          await sleep(ageMs < SLOT_MS + 3000 ? HEAD_RETRY_MS : 1000);
          continue;
        }
        const r = await this.read(head);
        this.lastError = null;
        await this.onBlock(r);
        lastHash = r.hash;
        backoff = 0;
        // Start checking for the next execution head at the expected slot boundary.
        await sleep(Math.min(SLOT_MS, Math.max(HEAD_RETRY_MS, r.timestamp * 1000 + SLOT_MS - Date.now())));
      } catch (e) {
        this.lastError = errMsg(e);
        backoff = Math.min(backoff * 2 + 750, 6_000);
        await sleep(backoff);
      }
    }
  }

  /** Test hook: read the current block and act on it once. */
  async scanOnce() {
    const r = await this.read(await this.head());
    await this.onBlock(r);
    return r.blockNumber;
  }

  // ------------------------------------------------------------------ per block
  private async head() {
    const head = await mevReadClient.getBlock({ blockTag: 'latest' });
    this.file.stats.rpcCalls++;
    return head;
  }

  private async read(head: Awaited<ReturnType<MevSearcher['head']>>): Promise<BlockRead> {
    const reads = this.reads;
    const tokens = this.tokens;
    if (!reads) throw new Error('pools not loaded');
    const start = performance.now();
    const headers = reads.contracts.slice(0, 2);
    const chunks = Array.from({ length: Math.max(1, Math.ceil((reads.contracts.length - 2) / POOL_READS_PER_CHUNK)) }, (_, i) =>
      reads.contracts.slice(2 + i * POOL_READS_PER_CHUNK, 2 + (i + 1) * POOL_READS_PER_CHUNK));
    this.file.stats.rpcCalls += chunks.length;
    const checks = await Promise.allSettled(chunks.map((chunk) =>
      mevPoolClient.multicall({ contracts: [...headers, ...chunk] as any, allowFailure: true, blockNumber: head.number, batchSize: 0 }) as Promise<McResult[]>));
    const valid = checks.map((check, index) => check.status === 'fulfilled' && check.value.length === 2 + chunks[index].length
      && check.value[0]?.status === 'success' && check.value[0].result === head.number
      && check.value[1]?.status === 'success' && check.value[1].result === head.timestamp ? check.value : null);
    const stamped = valid.find((chunk) => chunk !== null);
    if (!stamped) {
      throw new Error('pool snapshot did not match the block header');
    }
    const results = [...stamped.slice(0, 2), ...valid.flatMap((chunk, i) => chunk?.slice(2) ?? chunks[i].map((): McResult => ({ status: 'failure' })))];
    return {
      blockNumber: head.number, timestamp: Number(head.timestamp), nextBaseFee: nextBaseFee(head), hash: head.hash,
      tokens, at: reads.at, results, readMs: Math.round(performance.now() - start),
      failedChunks: valid.filter((chunk) => chunk === null).length,
    };
  }

  private async onBlock(r: BlockRead) {
    const started = performance.now();
    const generation = this.armGeneration;
    this.file.stats.blocks++;
    const recovery = this.reconcileWallet(r.blockNumber);
    if (CONFIG.forkMode) await recovery;
    const nextMaxBase = r.nextBaseFee;
    const gasPriceEth = Number(nextMaxBase) / 1e18;
    const cands: Candidate[] = [];
    const now = Date.now();
    const ethUsd = this.host.ethUsd();
    const policy = this.profitPolicy(now);
    const minimumNet = validPrice(ethUsd) ? this.minimumNet(ethUsd, policy) : 20_000_000_000_000n;
    let est: { net: number; gross: number; gas: number; symbol: string } | null = null;
    for (const [ti, t] of r.tokens.entries()) {
      const res = t.pools.map((p, pi) => reservesOf(t, p, r.results, r.at[ti][pi]));
      for (const cycle of bestCycle(t.pools, res).cycles) {
        const A = t.pools[cycle.buy];
        const B = t.pools[cycle.sell];
        const gasUnits = arbGas(A, B);
        const gasEth = gasUnits * gasPriceEth;
        const estimatedNet = cycle.profit - gasEth;
        if (!est || estimatedNet > est.net) est = { net: estimatedNet, gross: cycle.profit, gas: gasEth, symbol: t.token.symbol };
        if (cycle.profit <= gasEth * 0.8) continue;
        const cd = this.cooldown.get(`${poolIdentity(A)}|${poolIdentity(B)}`);
        if (cd && now < cd.until && !estimateChanged(cycle.profit, cd)) {
          const retry = cd.gasRetry;
          if (!retry || retry.profit - BigInt(retry.gasUnits) * nextMaxBase <= minimumNet) continue;
        }
        cands.push({ t, A, B, dx: cycle.dx, est: cycle.profit, estimatedNet, gasUnits });
      }
    }
    const block = { number: Number(r.blockNumber), at: now, candidates: cands.length, readMs: r.readMs, decisionMs: null as number | null, failedChunks: r.failedChunks };
    this.lastBlock = block;
    if (est) {
      const hb = this.hourBest();
      if (hb.estGross < 0 || est.net > hb.estGross - hb.estGas) Object.assign(hb, { estGross: est.gross, estGas: est.gas, estSymbol: est.symbol });
    }
    cands.sort((x, y) => y.estimatedNet - x.estimatedNet);
    const selected = cands.slice(0, MEV.maxSimsPerBlock);
    // A single exaggerated token estimate can otherwise fill every simulation slot.
    const leadingToken = selected[0]?.t.token.address;
    if (selected.length > 1 && selected.every((c) => c.t.token.address === leadingToken)) {
      const alternative = cands.find((c) => c.t.token.address !== leadingToken);
      if (alternative) selected[selected.length - 1] = alternative;
    }
    const canTryLive = () => this.liveArmed(generation) && this.contractReady && !this.deploying && !this.walletPending();
    const canTryFallback = () => canTryLive() && !this.host.tradePending()
      && (CONFIG.forkMode || r.timestamp * 1000 + SLOT_MS - Date.now() >= FALLBACK_LEAD_MS);
    const allowFallback = canTryFallback();
    const shortlisted = await Promise.all(selected.map((c) => this.evaluate(c, r, nextMaxBase, policy, allowFallback)));
    const offers = shortlisted.flatMap((route) => route?.primary ? [route.primary] : [])
      .sort((a, b) => a.score > b.score ? -1 : a.score < b.score ? 1 : 0);
    block.decisionMs = Math.round(performance.now() - started);
    if (canTryLive()) {
      const prepared = await Promise.all(offers.map((offer) => this.prepareLive(offer, r, policy)));
      const ranked = prepared.filter((offer) => offer !== null).sort((a, b) => {
        const byNet = a.net - b.net;
        const difference = byNet === 0n ? a.tip - b.tip : byNet;
        return difference > 0n ? -1 : difference < 0n ? 1 : 0;
      });
      for (const offer of ranked) {
        if (!canTryLive()) break;
        await this.sendLive(offer, r, generation);
      }
      // Keep the original submission path fast. Spend one more gas quote only when no primary was signed.
      if (canTryFallback() && !offers.some((offer) => offer.opp.hash)) {
        const [bestFallback] = shortlisted.flatMap((route) => route?.fallback ? [{ route, offer: route.fallback }] : [])
          .sort((a, b) => a.offer.score > b.offer.score ? -1 : a.offer.score < b.offer.score ? 1 : 0);
        if (bestFallback) {
          const extra = await this.prepareLive(bestFallback.offer, r, policy);
          if (extra && canTryLive() && !this.host.tradePending()) {
            if (!bestFallback.route.primary) {
              this.file.stats.profitable++;
              const { A, B } = extra.offer.candidate;
              this.cooldown.delete(`${poolIdentity(A)}|${poolIdentity(B)}`);
            }
            await this.sendLive(extra, r, generation);
          }
        }
      }
    } else {
      for (const offer of offers.reverse()) this.record(offer.opp);
    }
    if (this.file.stats.blocks % 20 === 0) this.save();
  }

  /** This hour's record of how close we got (created on first use; the last 72 hours are kept). */
  private hourBest(): HourBest {
    const h = Math.floor(Date.now() / HOUR) * HOUR;
    const best = this.file.best;
    let cur = best[best.length - 1];
    if (!cur || cur.h !== h) {
      cur = { h, estGross: -1, estGas: 0, estSymbol: '', simGross: null, simGas: null, simSymbol: null };
      best.push(cur);
      if (best.length > 72) best.splice(0, best.length - 72);
    }
    return cur;
  }

  /** Best exact (simulated) arbitrage of the hour, next to what its gas would have cost. */
  private trackSim(grossEth: number, gasEth: number, symbol: string) {
    const b = this.hourBest();
    if (b.simGross === null || grossEth - gasEth > b.simGross - (b.simGas ?? 0)) {
      b.simGross = grossEth;
      b.simGas = gasEth;
      b.simSymbol = symbol;
    }
  }

  /** Exact profit of one route at `amountIn`, from an eth_call of the contract (the real one, or its code injected). */
  async simulate(t: ArbToken, A: ArbPool, B: ArbPool, amountIn: bigint, maxBlock: bigint, blockNumber?: bigint, funding: RouteFunding = 0): Promise<{ ok: true; profit: bigint } | { ok: false; reason: string; reverted: boolean }> {
    const contract = this.contractReady ? this.selectedContract : null;
    try {
      const data = encodeArbitrage(funding, { token: t.token.address, buy: A, sell: B, amountIn, minProfit: 1n, tip: 0n, maxBlock });
      const res = await mevReadClient.call({
        account: this.host.account.address,
        blockNumber,
        to: contract ?? SIM_ADDR,
        data,
        stateOverride: contract
          ? undefined
          : [{ address: SIM_ADDR, code: FLASH_ARB_V2_RUNTIME, stateDiff: [{ slot: pad('0x0'), value: pad(this.host.account.address) }] }],
      });
      if (!res.data) return { ok: false, reason: 'no result', reverted: false };
      return { ok: true, profit: decodeArbitrage(res.data) };
    } catch (e) {
      const reverted = e instanceof BaseError && e.walk((cause) => cause instanceof ExecutionRevertedError) instanceof ExecutionRevertedError;
      return { ok: false, reason: reasonOf(e), reverted };
    }
  }

  private async evaluate(c: Candidate, r: BlockRead, nextMaxBase: bigint, policy: ProfitPolicy, allowFallback: boolean): Promise<EvaluatedRoute | null> {
    const st = this.file.stats;
    st.candidates++;
    const key = `${poolIdentity(c.A)}|${poolIdentity(c.B)}`;
    const previous = this.previousSizes.get(key);
    const sizes = routeInputSizes(c.dx, !c.A.v2 || !c.B.v2, previous && Date.now() - previous.at < 10 * 60_000 ? previous.amount : undefined);
    if (!sizes.length) return null;
    const trials = fundingTrials(MEV.funding, sizes);
    const sims = await Promise.all(trials.map(({ amount, funding }) => this.simulate(c.t, c.A, c.B, amount, r.blockNumber + 1n, r.blockNumber, funding)));
    st.rpcCalls += sims.length;
    st.simulated++;
    const successful: SimulatedSize[] = [];
    for (let i = 0; i < sims.length; i++) {
      const s = sims[i];
      if (!s.ok) continue;
      const { amount, funding } = trials[i];
      const gasUnits = c.gasUnits + EXECUTION_GAS_ADDON[funding];
      const net = s.profit - BigInt(gasUnits) * nextMaxBase;
      successful.push({ amount, funding, profit: s.profit, gasUnits, net });
    }
    successful.sort((a, b) => a.net > b.net ? -1 : a.net < b.net ? 1 : 0);
    const [best, ...alternatives] = successful;
    const ethUsd = this.host.ethUsd();
    const gasWei = BigInt(best?.gasUnits ?? c.gasUnits) * nextMaxBase;
    const opp: MevOpp = {
      t: Date.now(), block: Number(r.blockNumber), symbol: c.t.token.symbol, buy: c.A.venue, sell: c.B.venue,
      sizeEth: c.dx, grossEth: 0, gasEth: eth(gasWei), tipEth: 0, netEth: 0, netUsd: 0, status: 'failed',
    };
    if (!best) {
      const allReverted = sims.every((s) => !s.ok && s.reverted);
      const structuralFailure = allReverted && sims.every((s) => !s.ok && STRUCTURAL_REVERTS.has(s.reason));
      const previousFailure = this.cooldown.get(key);
      const previousStreak = previousFailure && !estimateChanged(c.est, previousFailure) ? previousFailure.revertStreak ?? 0 : 0;
      // A provider error does not count as evidence that the route keeps reverting.
      const revertStreak = allReverted ? Math.min(previousStreak + 1, MAX_REVERT_STREAK) : undefined;
      const delay = structuralFailure ? HOUR : Math.min(ROUTE_RETRY_MS * 2 ** ((revertStreak ?? 1) - 1), MAX_REVERT_RETRY_MS);
      this.cooldown.set(key, { until: Date.now() + delay, est: c.est, grow: structuralFailure ? 3 : 1.5, revertStreak });
      opp.note = `simulation: ${sims.find((s) => !s.ok)?.reason ?? 'reverted'}`;
      this.record(opp);
      return null;
    }
    const b = best;
    this.previousSizes.delete(key);
    this.previousSizes.set(key, { amount: b.amount, at: Date.now() });
    if (this.previousSizes.size > 512) {
      const oldest = this.previousSizes.keys().next().value;
      if (oldest !== undefined) this.previousSizes.delete(oldest);
    }
    const net = b.net;
    this.trackSim(eth(b.profit), eth(gasWei), c.t.token.symbol);
    const minNetWei = validPrice(ethUsd) ? this.minimumNet(ethUsd, policy) : 20_000_000_000_000n;
    const makeOffer = (trial: SimulatedSize): Offer => {
      const tip = trial.net >= minNetWei ? this.builderTip(trial.net, minNetWei, policy) : 0n;
      const netEth = eth(trial.net - tip);
      return {
        candidate: c, amount: trial.amount, profit: trial.profit, funding: trial.funding, score: trial.net - tip,
        opp: {
          ...opp, sizeEth: eth(trial.amount), grossEth: eth(trial.profit),
          gasEth: eth(BigInt(trial.gasUnits) * nextMaxBase), tipEth: eth(tip), netEth,
          netUsd: validPrice(ethUsd) ? netEth * ethUsd : 0,
          funding: FUNDING_NAMES[trial.funding], status: 'would send',
          note: validPrice(ethUsd) ? 'paper estimate' : 'paper estimate, ETH/USD price unavailable',
        },
      };
    };
    const primary = makeOffer(b);
    if (net < minNetWei) {
      // estimate far above reality = an illusion of the quick math: back off for longer
      const illusion = Number(b.profit) / 1e18 < c.est * 0.1;
      this.cooldown.set(key, {
        until: Date.now() + (illusion ? HOUR : 5 * 60_000), est: c.est, grow: illusion ? 3 : 1.5,
        gasRetry: { profit: b.profit, gasUnits: b.gasUnits },
      });
      if (b.profit * 4n >= gasWei) { // only list near misses (gross at least a quarter of the gas), not dust
        this.record({ ...primary.opp, status: 'below gas', note: 'below configured net profit floor' });
      }
      // The size simulation is pinned, but its rough gas cost can overstate the padded execution cost.
      return allowFallback && validPrice(ethUsd) && net + gasWei / 5n >= minNetWei
        ? { primary: null, fallback: primary } : null;
    }
    this.cooldown.delete(key);
    st.profitable++;
    const runnerUp = alternatives[0];
    let fallback: Offer | undefined;
    if (allowFallback && validPrice(ethUsd) && runnerUp) {
      // A comparable loan provider avoids repeating the funding path that failed the exact checks.
      const distinct = alternatives.find((trial) => trial.funding !== b.funding && trial.net >= minNetWei
        && trial.net * 5n >= runnerUp.net * 4n);
      const trial = distinct ?? runnerUp;
      const trialGas = BigInt(trial.gasUnits) * nextMaxBase;
      if (trial.net + trialGas / 5n >= minNetWei) fallback = makeOffer(trial);
    }
    return { primary, fallback };
  }

  private profitPolicy(now: number): ProfitPolicy {
    const { stats, armedAt } = this.file;
    // Old journals with no landed bundles already record how long the scanner has been running.
    const since = stats.lastLandedAt ?? (stats.landed === 0 ? stats.since : armedAt);
    const configured = MEV.idleBuilderTipPct !== MEV.builderTipPct || MEV.idleMinNetUsd !== MEV.minNetUsd
      || MEV.idleGasPaddingPct !== NORMAL_GAS_PADDING_PCT;
    const idle = configured && this.liveArmed(this.armGeneration) && this.contractReady
      && since !== null && Number.isFinite(since) && since > 0 && now - since >= IDLE_BID_AFTER_MS;
    return {
      idle,
      minNetUsd: idle ? MEV.idleMinNetUsd : MEV.minNetUsd,
      builderTipPct: idle ? MEV.idleBuilderTipPct : MEV.builderTipPct,
      gasPaddingPct: idle ? MEV.idleGasPaddingPct : NORMAL_GAS_PADDING_PCT,
    };
  }

  private minimumNet(ethUsd: number, policy: ProfitPolicy): bigint {
    return BigInt(Math.max(1, Math.ceil(policy.minNetUsd / ethUsd * 1e18)));
  }

  private builderTip(afterGas: bigint, minimumNet: bigint, policy: ProfitPolicy): bigint {
    const proposed = (afterGas * BigInt(Math.round(policy.builderTipPct * 10_000))) / 10_000n;
    const room = afterGas - minimumNet;
    return proposed < room ? proposed : room;
  }

  private beforeNextSlot(r: BlockRead): boolean {
    return CONFIG.forkMode || Date.now() < r.timestamp * 1000 + SLOT_MS;
  }

  private skipOpportunity(opp: MevOpp, note: string) {
    opp.status = 'skipped';
    opp.note = note;
    this.record(opp);
    return null;
  }

  private async prepareLive(offer: Offer, r: BlockRead, policy: ProfitPolicy): Promise<PreparedOffer | null> {
    const contract = this.selectedContract;
    const { candidate: c, opp } = offer;
    if (!contract) return this.skipOpportunity(opp, 'verified FlashArbV2 unavailable');
    if (!this.beforeNextSlot(r)) return this.skipOpportunity(opp, 'target slot passed before gas estimation');
    const ethUsd = this.host.ethUsd();
    if (!validPrice(ethUsd)) return this.skipOpportunity(opp, 'ETH/USD price unavailable');
    const minimumNet = this.minimumNet(ethUsd, policy);
    const target = r.blockNumber + 1n;
    const encode = (tip: bigint, minProfit: bigint) => encodeArbitrage(offer.funding, {
      buy: c.A, sell: c.B, token: c.t.token.address, amountIn: offer.amount, minProfit, tip, maxBlock: target,
    });
    try {
      // Estimate with the builder payment path enabled, then simulate the exact calldata and gas limit.
      this.file.stats.rpcCalls++;
      const estimate = await mevReadClient.estimateGas({ account: this.host.account, to: contract, data: encode(1n, 1n), blockNumber: r.blockNumber });
      const paddedBps = 10_000n + BigInt(Math.round(policy.gasPaddingPct * 10_000));
      const gas = (estimate * paddedBps + 9_999n) / 10_000n;
      const gasBudget = gas * r.nextBaseFee;
      const afterGas = offer.profit - gasBudget;
      if (afterGas < minimumNet) return this.skipOpportunity(opp, 'below configured profit floor with padded gas');
      const tip = this.builderTip(afterGas, minimumNet, policy);
      if (tip === 0n) return this.skipOpportunity(opp, 'profit does not cover a builder payment above the configured floor');
      const minimumProfit = tip + gasBudget + minimumNet;
      return { offer, contract, ethUsd, gas, gasBudget, tip, minimumProfit, data: encode(tip, minimumProfit), net: afterGas - tip };
    } catch (e) {
      opp.status = 'failed';
      opp.note = `gas estimate: ${reasonOf(e)}`;
      this.record(opp);
      return null;
    }
  }

  private async sendLive(prepared: PreparedOffer, r: BlockRead, generation: number) {
    const exec = this.host.exec;
    const account = this.host.account;
    const { offer, contract, ethUsd, data, gas, gasBudget, tip, minimumProfit, net } = prepared;
    const { opp } = offer;
    const skip = (note: string) => { this.skipOpportunity(opp, note); };
    const canSend = () => this.liveArmed(generation) && this.contractReady && this.selectedContract === contract
      && !this.deploying && !this.host.tradePending() && this.beforeNextSlot(r);
    if (!canSend()) return skip('target slot passed or MEV became unavailable before signing');
    if (this.walletPending() || !this.reserveBundle()) return skip('wallet is busy or MEV was disarmed');
    const target = r.blockNumber + 1n;
    try {
      this.file.stats.rpcCalls++;
      const [result, nonce, balance] = await Promise.all([
        mevReadClient.call({ account, to: contract, data, gas, blockNumber: r.blockNumber }),
        exec.bundleNonce(),
        mevReadClient.getBalance({ address: account.address }),
      ]);
      if (!result.data || decodeArbitrage(result.data) < minimumProfit) {
        return skip('final simulation returned insufficient profit');
      }
      if (balance < gasBudget) return skip('wallet ETH does not cover the padded gas budget');
      const head = await this.head();
      if (head.hash !== r.hash || !canSend()) return skip('block changed or MEV was disarmed before signing');
      const signed = await account.signTransaction({
        chainId: publicClient.chain.id, type: 'eip1559', to: contract, data, nonce, gas,
        maxFeePerGas: r.nextBaseFee, maxPriorityFeePerGas: 0n, value: 0n,
      });
      if (!canSend()) return skip('MEV was disarmed before sending');
      const hash = keccak256(signed);
      const startedAt = Date.now();
      const submission: BundleSubmission = {
        target: Number(target), startedAt, leadMs: r.timestamp * 1000 + SLOT_MS - startedAt,
        gasEth: eth(gasBudget), tipEth: eth(tip), netUsd: eth(net) * ethUsd, builders: [],
      };
      Object.assign(opp, {
        hash, status: 'sent', gasEth: submission.gasEth, tipEth: submission.tipEth,
        netEth: eth(net), netUsd: submission.netUsd, note: 'awaiting builder replies', submission,
      });
      const pending = { hash, nonce, target: target.toString(), contract, ethUsd, opp };
      const recent = this.file.recent.slice();
      this.file.pending = pending;
      this.record(opp, false);
      try {
        this.writeState();
      } catch (error) {
        this.file.pending = null;
        this.file.recent = recent;
        throw error;
      }
      const flight = this.submitSignedBundle(pending, submission, signed, () => canSend() && this.pending === pending);
      // The journal continues to reserve the nonce while replies arrive. The scanner can follow the next head.
      if (CONFIG.forkMode) await flight;
    } catch (e) {
      if (opp.hash) throw e;
      opp.status = 'failed';
      opp.note = `final check: ${reasonOf(e)}`;
      this.record(opp);
    } finally {
      if (!this.pending) this.releaseBundle();
    }
  }

  private async submitSignedBundle(pending: PendingBundle, submission: BundleSubmission, signed: Hex, canSend: () => boolean) {
    try {
      const responses = await sendBundle([signed], BigInt(pending.target), canSend);
      if (!responses.length) {
        if (this.pending === pending) this.finishBundle({
          ...pending.opp, status: 'skipped', note: 'submission canceled before contacting builders',
          gasEth: 0, tipEth: 0, netEth: 0, netUsd: 0,
        });
        return;
      }
      this.file.stats.bundles++;
      submission.builders = responses;
      const acknowledgements = responses.filter((response) => response.ok).length;
      if (this.pending === pending) pending.opp.note = `${acknowledgements}/${responses.length} acknowledged; awaiting on-chain settlement`;
      this.save();
      const details = responses.map(({ builder, detail, elapsedMs }) => `${builder} ${detail} (${elapsedMs} ms)`).join(', ');
      this.host.log(`[mev] Bundle submitted for block ${pending.target}: ${acknowledgements}/${responses.length} acknowledged, start ${submission.leadMs} ms before expected slot. ${details}`);
    } catch {
      // A transport or storage error does not settle the wallet intent.
      this.host.log(`[mev] Bundle for block ${pending.target} awaiting on-chain reconciliation after a submission error.`, 'warn');
    }
  }

  private reserveBundle(): boolean {
    if (this.bundleReserved) return true;
    this.bundleReserved = this.host.exec.reserveForBundle(Infinity);
    return this.bundleReserved;
  }

  private releaseBundle() {
    if (this.bundleReserved) this.host.exec.releaseBundle();
    this.bundleReserved = false;
  }

  /** Resolve persisted uncertainty even when the strategy is disarmed or scanning is disabled. */
  async reconcileWallet(current?: bigint): Promise<void> {
    if (this.recovery) return this.recovery;
    if (this.stateReadError || !this.walletPending()) return;
    this.recovery = this.recover(current).catch(() => {
      this.lastError = 'Wallet reconciliation is waiting for reliable chain data and storage.';
    }).finally(() => {
      this.recovery = null;
    });
    return this.recovery;
  }

  private async recover(current?: bigint) {
    if (this.pending) {
      this.reserveBundle();
      await this.checkPending(current ?? (await this.head()).number);
    }
    if (this.file.deployTx && !this.deploying) await this.recoverDeployment();
  }

  private async receipt(hash: Hex) {
    this.file.stats.rpcCalls++;
    try {
      return await publicClient.getTransactionReceipt({ hash });
    } catch (e) {
      if (e instanceof TransactionReceiptNotFoundError) return null;
      throw e;
    }
  }

  private async checkPending(current: bigint) {
    const p = this.pending;
    if (!p) return;
    const target = BigInt(p.target);
    const confirmations = CONFIG.forkMode ? 0n : RECEIPT_CONFIRMATIONS;
    if (current < target + confirmations) return;
    const receipt = await this.receipt(p.hash);
    if (receipt) {
      if (current < receipt.blockNumber + confirmations) return;
      if (!CONFIG.forkMode) {
        const canonical = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
        this.file.stats.rpcCalls++;
        if (canonical.hash !== receipt.blockHash) return;
      }
      this.host.exec.noteNonceUsed(p.nonce);
      const gasWei = receipt.gasUsed * receipt.effectiveGasPrice;
      const ev = parseEventLogs({
        abi: FLASH_ARB_V2_ABI,
        logs: receipt.logs.filter((log) => log.address.toLowerCase() === p.contract.toLowerCase()),
        eventName: 'Arbitrage',
      })[0];
      const outcome = { ...p.opp, gasEth: eth(gasWei) };
      if (receipt.status === 'success' && ev) {
        outcome.status = 'landed';
        outcome.grossEth = eth(ev.args.profit);
        outcome.tipEth = eth(ev.args.tip);
        outcome.ownerPayoutEth = eth(ev.args.profit - ev.args.tip);
        const financing = parseEventLogs({ abi: FLASH_ARB_V2_ABI, eventName: 'FundedBy',
          logs: receipt.logs.filter((log) => log.address.toLowerCase() === p.contract.toLowerCase()),
        })[0];
        if (financing) {
          outcome.funding = FUNDING_NAMES[financing.args.funding as RouteFunding];
          outcome.lenderFeeEth = eth(financing.args.premium);
        }
        outcome.netEth = eth(ev.args.profit - ev.args.tip - gasWei);
        outcome.note = `block ${receipt.blockNumber}`;
      } else {
        outcome.status = 'failed';
        outcome.grossEth = 0;
        outcome.tipEth = 0;
        outcome.netEth = -eth(gasWei);
        outcome.note = receipt.status === 'success' ? 'confirmed without a verified arbitrage event' : 'confirmed revert; gas spent';
      }
      outcome.netUsd = outcome.netEth * p.ethUsd;
      this.finishBundle(outcome, true);
      this.host.log(`[mev] Bundle ${p.hash} ${outcome.status}: ${outcome.note}`, outcome.status === 'landed' ? 'trade' : 'warn');
      return;
    }
    const nonceAtTarget = await publicClient.getTransactionCount({ address: this.host.account.address, blockNumber: target });
    this.file.stats.rpcCalls++;
    if (nonceAtTarget <= p.nonce) {
      this.finishBundle({ ...p.opp, status: 'not included', note: 'target block passed without using this nonce', netEth: 0, netUsd: 0, gasEth: 0, tipEth: 0 });
      this.host.log(`[mev] Bundle for block ${target} not included. Wallet nonce was unused in the target block.`);
    } else {
      const block = await publicClient.getBlock({ blockNumber: target, includeTransactions: true });
      this.file.stats.rpcCalls++;
      const owner = this.host.account.address.toLowerCase();
      const tx = block.transactions.find((candidate) => candidate.nonce === p.nonce && candidate.from.toLowerCase() === owner);
      if (tx && tx.hash.toLowerCase() !== p.hash.toLowerCase()) {
        this.host.exec.noteNonceUsed(p.nonce);
        this.finishBundle({ ...p.opp, status: 'not included', note: 'a different transaction used the nonce in the target block', netEth: 0, netUsd: 0, gasEth: 0, tipEth: 0 });
        this.host.log(`[mev] Bundle for block ${target} not included. A different transaction used the wallet nonce.`);
        return;
      }
      // A changed nonce alone does not establish which hash landed.
      p.opp.note = 'nonce advanced; awaiting this bundle receipt';
    }
  }

  private finishBundle(outcome: MevOpp, included = false) {
    const f = this.file;
    const previous = { pending: f.pending, recent: f.recent, stats: f.stats };
    f.pending = null;
    f.recent = retainRecent([outcome, ...f.recent.filter((item) => item.hash !== outcome.hash)], RECENT_LIMIT, RECENT_BUNDLE_LIMIT);
    if (included) {
      const landed = outcome.status === 'landed';
      f.stats = {
        ...f.stats, landed: f.stats.landed + (landed ? 1 : 0),
        lastLandedAt: landed ? Date.now() : f.stats.lastLandedAt,
        netEth: f.stats.netEth + outcome.netEth, netUsd: f.stats.netUsd + outcome.netUsd,
      };
    }
    try {
      this.writeState();
    } catch (e) {
      Object.assign(f, previous);
      throw e;
    }
    this.releaseBundle();
    if (outcome.status === 'not included') this.traceMissedBundle(outcome);
  }

  /** Collect builder diagnostics after chain settlement without delaying scans or nonce release. */
  private traceMissedBundle(outcome: MevOpp) {
    const submission = outcome.submission;
    if (CONFIG.forkMode || this.stopping || !submission || !Array.isArray(submission.builders)) return false;
    let scheduled = false;
    for (const request of bundleTraceRequests(submission.builders, MEV.builders, submission.startedAt)) {
      if (this.scheduledTraces.has(request.builder)) continue;
      this.scheduledTraces.add(request.builder);
      scheduled = true;
      setTimeout(() => {
        if (this.stopping) return;
        void requestBuilderTrace(request).then((status) => {
          if (this.stopping || !status) return;
          request.builder.traceStatus = status;
          if (this.file.recent.includes(outcome)) this.save();
          this.host.log(`[mev] ${request.builder.builder} trace for target block ${submission.target}: ${status}.`);
        });
      }, request.waitMs).unref();
    }
    return scheduled;
  }

  /** Keeps a bounded journal. Repeated simulations of the same route and outcome are merged. */
  private record(o: MevOpp, merge = true) {
    const rec = this.file.recent;
    if (merge && !o.submission) {
      const i = rec.findIndex((x) => !x.submission && x.symbol === o.symbol && x.buy === o.buy && x.sell === o.sell && x.status === o.status && o.t - x.t < 10 * 60_000);
      if (i !== -1) {
        o.count = (rec[i].count ?? 1) + 1;
        rec.splice(i, 1);
      }
    }
    rec.unshift(o);
    this.file.recent = retainRecent(rec, RECENT_LIMIT, RECENT_BUNDLE_LIMIT);
  }

  // ------------------------------------------------------------------ arming & the contract
  arm() {
    if (!MEV.enabled) throw new Error('MEV is turned off in .env (MEV=off)');
    if (!CONFIG.allowLiveTrading && !CONFIG.forkMode) throw new Error('Live execution is disabled (ALLOW_LIVE_TRADING=off).');
    if (!CONFIG.forkMode && MEV.builders.length === 0) throw new Error('MEV requires at least one configured builder.');
    if (this.stateReadError) throw new Error(this.stateReadError);
    if (!this.persist || this.stopping || this.walletPending()) throw new Error('MEV cannot arm while wallet recovery or contract preparation is in progress.');
    const existing = this.selectedContract;
    const configured = this.configuredContract;
    if (existing && configured && existing.toLowerCase() !== configured.toLowerCase()) {
      throw new Error('MEV_V2_CONTRACT_ADDRESS conflicts with the saved deployment. Review both addresses before arming.');
    }
    const address = existing ?? configured;
    if (!address) throw new Error('Deploy FlashArbV2 from the dashboard before arming MEV.');
    if (this.file.armed) return;
    const generation = ++this.armGeneration;
    this.contractReady = false;
    this.file.armed = true;
    this.file.armedAt = Date.now();
    this.status = this.modeText();
    this.host.log('MEV live arming requested. Verifying FlashArbV2.', 'warn');
    void this.verifyForArm(address, generation);
  }

  disarm(reason = 'by user') {
    if (!this.file.armed && !this.deploying) return;
    this.armGeneration++;
    const wasArmed = this.file.armed;
    this.file.armed = false;
    this.file.armedAt = null;
    this.contractReady = false;
    this.status = this.modeText();
    if (wasArmed) this.host.log(`MEV arbitrage disarmed ${reason}. Scanning continues in paper mode.`, 'warn');
  }

  private async contractOk(addr: Address): Promise<boolean> {
    const [code, owner] = await Promise.all([
      publicClient.getCode({ address: addr }).catch(() => undefined),
      publicClient.readContract({ address: addr, abi: FLASH_ARB_V2_ABI, functionName: 'owner' }).catch(() => null),
    ]);
    return code?.toLowerCase() === FLASH_ARB_V2_RUNTIME.toLowerCase() && owner?.toLowerCase() === this.host.account.address.toLowerCase();
  }

  private clearDeployment(deployment?: { address: Address; gasWei: bigint }) {
    const f = this.file;
    const previous = {
      contract: f.contract, deployedAt: f.deployedAt, deployGasUsd: f.deployGasUsd,
      v2Contract: f.v2Contract, v2DeployedAt: f.v2DeployedAt, v2DeployGasUsd: f.v2DeployGasUsd,
      deployTx: f.deployTx, deployVersion: f.deployVersion, deployNonce: f.deployNonce, deployStartedAt: f.deployStartedAt,
    };
    if (deployment) {
      const cost = eth(deployment.gasWei) * (this.host.ethUsd() ?? 0);
      if (f.deployVersion === 'v2') {
        f.v2Contract = deployment.address;
        f.v2DeployedAt = Date.now();
        f.v2DeployGasUsd = cost;
      } else {
        // Deployment journals from before V2 had no version marker. Keep their receipts as history.
        f.contract = deployment.address;
        f.deployedAt = Date.now();
        f.deployGasUsd = cost;
      }
    }
    f.deployTx = null;
    f.deployVersion = null;
    f.deployNonce = null;
    f.deployStartedAt = null;
    try {
      this.writeState();
    } catch (e) {
      Object.assign(f, previous);
      throw e;
    }
    this.status = this.modeText();
  }

  private async recoverDeployment() {
    const f = this.file;
    const hash = f.deployTx;
    if (!hash) return;
    const result = await transactionSettlement(hash, Date.now() - (f.deployStartedAt ?? 0) > 45_000);
    if (f.deployTx !== hash || result.status === 'pending') return;
    if (result.status === 'dropped') {
      this.clearDeployment();
      return;
    }
    const receipt = result.receipt;
    if (f.deployNonce !== null) this.host.exec.noteNonceUsed(f.deployNonce);
    if (receipt.status === 'success') {
      if (!receipt.contractAddress || receipt.from.toLowerCase() !== this.host.account.address.toLowerCase()
        || (f.deployVersion === 'v2' && !await this.contractOk(receipt.contractAddress))) {
        throw new Error('Confirmed deployment could not be verified');
      }
      this.clearDeployment({ address: receipt.contractAddress, gasWei: receipt.gasUsed * receipt.effectiveGasPrice });
      this.host.log('[mev] Restored the confirmed contract deployment.', 'trade');
    } else {
      this.clearDeployment();
      this.host.log('[mev] Contract deployment reverted.', 'warn');
    }
  }

  private async verifyForArm(address: Address, generation: number) {
    try {
      if (!await this.contractOk(address)) throw new Error('FlashArbV2 bytecode or bot wallet ownership could not be verified.');
      if (!this.liveArmed(generation)) return;
      if (!this.selectedContract) {
        const previous = this.file.v2Contract;
        this.file.v2Contract = address;
        try {
          this.writeState();
        } catch (error) {
          this.file.v2Contract = previous;
          throw error;
        }
      }
      this.contractReady = true;
      this.status = this.modeText();
      this.host.log(`[mev] Verified FlashArbV2 at ${address}`);
    } catch (error) {
      if (this.liveArmed(generation)) {
        this.host.log('[mev] Arming stopped: ' + errMsg(error), 'warn');
        this.disarm('after contract verification failed');
      }
    }
  }

  async deploymentQuote() {
    const { balance, minimumWei, estimatedWei, gas, maxFeePerGas } = await this.host.exec.quoteDeployment(FLASH_ARB_V2_BYTECODE);
    return {
      balanceEth: eth(balance),
      minimumEth: eth(minimumWei),
      estimatedEth: estimatedWei === null ? null : eth(estimatedWei),
      maximumEth: estimatedWei === null ? null : eth(gas * maxFeePerGas),
    };
  }

  /** This action authorizes one deployment. Live trading stays separately controlled. */
  async deployFromDashboard(): Promise<Address> {
    if (!MEV.enabled) throw new Error('MEV is turned off in .env (MEV=off).');
    if (!CONFIG.allowLiveTrading && !CONFIG.forkMode) throw new Error('Live execution is disabled (ALLOW_LIVE_TRADING=off).');
    if (this.stateReadError) throw new Error(this.stateReadError);
    if (!this.persist || this.stopping || this.file.armed || this.walletPending() || this.host.tradePending()) {
      throw new Error('Disarm MEV and wait for pending wallet operations to settle before deploying.');
    }
    if (this.selectedContract || this.configuredContract) throw new Error('A FlashArbV2 address is already saved or configured.');

    const generation = this.armGeneration;
    this.deploying = true;
    this.status = this.modeText();
    const f = this.file;
    const canSend = () => this.deploying && this.armGeneration === generation && !this.stopping
      && !f.armed && !this.stateReadError && !this.pending && !this.host.tradePending();
    try {
      const r = await this.host.exec.deployContract(
        FLASH_ARB_V2_BYTECODE,
        (message) => this.host.log('[mev] ' + message),
        (hash, nonce) => {
          f.deployTx = hash;
          f.deployVersion = 'v2';
          f.deployNonce = nonce;
          f.deployStartedAt = Date.now();
          try {
            this.writeState();
          } catch (error) {
            f.deployTx = null;
            f.deployVersion = null;
            f.deployNonce = null;
            f.deployStartedAt = null;
            throw error;
          }
        },
        canSend,
      );
      if (!await this.contractOk(r.address)) throw new Error('Confirmed deployment could not be verified');
      this.clearDeployment({ address: r.address, gasWei: r.gasWei });
      this.host.log('[mev] Verified FlashArbV2 deployment at ' + r.address, 'trade');
      return r.address;
    } catch (error) {
      if (error instanceof UncertainTxError) throw new Error('The deployment transaction is awaiting confirmation. Recovery continues in paper mode.');
      throw error;
    } finally {
      this.deploying = false;
      this.status = this.modeText();
    }
  }

  // ------------------------------------------------------------------ dashboard
  view() {
    const f = this.file;
    const venues: Record<string, number> = {};
    for (const t of this.tokens) for (const p of t.pools) {
      const name = poolVenue(p);
      venues[name] = (venues[name] ?? 0) + 1;
    }
    const ethUsd = this.host.ethUsd();
    const hour = Math.floor(Date.now() / HOUR) * HOUR;
    return {
      enabled: MEV.enabled,
      mode: !MEV.enabled ? 'off' : this.deploying ? 'deploying' : f.armed ? (this.contractReady ? 'live' : 'arming') : 'paper',
      status: this.status,
      lastError: this.lastError,
      armed: f.armed,
      contract: this.selectedContract,
      configuredContract: this.configuredContract,
      contractVersion: 'v2',
      fundingMode: MEV.funding,
      deployedAt: f.v2DeployedAt ?? null,
      deployGasUsd: f.v2DeployGasUsd ?? 0,
      tokens: this.tokens.length,
      pools: this.tokens.reduce((s, t) => s + t.pools.length, 0),
      venues,
      coverage: this.universe.view(),
      lastBlock: this.lastBlock,
      bestThisHour: (() => {
        const b = f.best.find((x) => x.h === hour);
        if (!b) return null;
        // prefer the exact simulation; otherwise the quick estimate (it overstates, so "below gas" there is certain)
        const exact = b.simGross !== null;
        const grossEth = exact ? b.simGross! : Math.max(0, b.estGross);
        const gasEth = exact ? b.simGas! : b.estGas;
        if (!exact && b.estGross < 0) return null;
        return { exact, symbol: exact ? b.simSymbol : b.estSymbol, grossEth, gasEth, grossUsd: ethUsd ? grossEth * ethUsd : null, gasUsd: ethUsd ? gasEth * ethUsd : null };
      })(),
      best: f.best.slice(-24),
      stats: f.stats,
      pending: this.pending ? { hash: this.pending.hash, target: Number(this.pending.target) } : null,
      deploymentPending: f.deployTx,
      recent: retainRecent(f.recent, DASHBOARD_RECENT_LIMIT, DASHBOARD_BUNDLE_LIMIT),
      settings: {
        tipPct: MEV.builderTipPct, minNetUsd: MEV.minNetUsd, minPoolWeth: MEV.minPoolWeth,
        activeProfitPolicy: this.profitPolicy(Date.now()),
        builders: MEV.builders.map((u) => new URL(u).hostname),
      },
    };
  }
}
