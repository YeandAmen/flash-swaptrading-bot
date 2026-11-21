import fs from 'node:fs';
import path from 'node:path';
import { BaseError, ExecutionRevertedError, keccak256, pad, parseEventLogs, TransactionReceiptNotFoundError, type Address, type Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { CONFIG, CORE_TOKENS, DATA_DIR, MEV, type TokenCfg } from '../config.js';
import { mevPoolClient, mevReadClient, MIN_PRIORITY_FEE_WEI, nextBaseFee, publicClient } from '../chain.js';
import { redactDiagnostic } from '../diagnostics.js';
import { transactionSettlement, UncertainTxError, type LiveExecutor } from '../executor.js';
import type { McResult } from '../market.js';
import { writeJson } from '../persistence.js';
import { FLASH_ARB_V2_ABI, FLASH_ARB_V2_RUNTIME } from './artifact-v2.js';
import { FLASH_ARB_V3_RUNTIME } from './artifact-v3.js';
import { bundleTraceRequests, requestBuilderTrace } from './builder-trace.js';
import { decodeArbitrage, encodeArbitrage, EXECUTION_GAS_ADDON, FUNDING_NAMES, fundingTrials, type RouteFunding } from './flash-arb.js';
import { sendBundle, submitPrivateDirect, type BuilderResult } from './bundles.js';
import { affordableDirectFees, directExecutionReserve, directFees, directPriorityFee, findNonceConsumer } from './direct.js';
import { submitDirect } from './direct-broadcast.js';
import { directCadence, extraRoutes, loanLimitWei } from './cadence.js';
import { HeadBackfill } from './head-backfill.js';
import { createHeadWake } from './head-wake.js';
import { pinnedArbitrage, proxyCreationData, proxyReleaseHash, proxyReleaseRuntime, proxyUpgradeData, releaseRuntime, releaseSupportsCurve, releaseSupportsPancakeV2, releaseSupportsSpark, verifyFlashProxy } from './proxy.js';
import { routeInputSizes } from './sizing.js';
import { NextVenueKind } from './next-pools.js';
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
const CADENCE_RECHECK_MS = 60_000;
const GAS_ONLY_TEST_MS = 6 * 60_000;
const GAS_ONLY_TEST_ROUTES = 4;
const TEST_ID = /^[A-Za-z0-9_-]{8,80}$/;
const HEAD_RETRY_MS = 400;
const POOL_READS_PER_CHUNK = 160;
const RECEIPT_CONFIRMATIONS = 2n;
const RECENT_LIMIT = 60;
const RECENT_BUNDLE_LIMIT = 10;
const DASHBOARD_RECENT_LIMIT = 15;
const DASHBOARD_BUNDLE_LIMIT = 5;
const MAX_STARTUP_TRACE_BUNDLES = 6;
const DIRECT_WINDOW = 1;
const PRIVATE_DIRECT_WINDOW = 2;
const PRIVATE_LIVE_WINDOW = 3;
const PRIVATE_FUNCTIONAL_TEST_WINDOW = 5;
const PUBLIC_FUNCTIONAL_TEST_WINDOW = 8;
const MAX_PUBLIC_FUNCTIONAL_TEST_USD = 5;
const MAX_PROFIT_TEST_GAS_USD = 10;
const PUBLIC_FUNCTIONAL_PRIORITY_WEI = 3_000_000_000n;
const DIRECT_SEND_LEAD_MS = 1_500;
const PREMIUM_MIN_NET_USD = 5;
const PREMIUM_TARGET_TIP_WEI = 1_000_000_000n;
const PREMIUM_QUOTE_CAP_WEI = 100_000_000_000n;
const WINDOW_MS = 30 * 60_000;
const GAS_LEDGER_HOURS = 24;
const hourOf = (time: number) => Math.floor(time / HOUR);
const directBudgetConfigured = () => MEV.directMaxGasUsd > 0;
const directPriorityCap = () => BigInt(Math.floor(MEV.directMaxPriorityGwei * 1e9));
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
  requestGasTopUp?(gasWei: bigint): void;
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
  gasOnlyTestId?: string;
}

/** Preserve submission details through busy stretches of simulation results. */
function retainRecent(rows: MevOpp[], limit: number, bundleLimit: number): MevOpp[] {
  let bundlesLeft = Math.min(bundleLimit, rows.filter((row) => row.submission).length);
  let otherRowsLeft = limit - bundlesLeft;
  return rows.filter((row) => row.submission ? bundlesLeft-- > 0 : otherRowsLeft-- > 0);
}

interface BundleSubmission {
  kind?: 'direct';
  privateSubmission?: true;
  target: number;
  startedAt: number;
  leadMs: number;
  priorityGwei?: number;
  rpcAckMs?: number;
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
  directAttempts?: number;
  directLanded?: number;
  directScanStartedAt?: number;
  lastDirectLandedAt?: number;
  landed: number;
  lastLandedAt?: number;
  netEth: number;
  netUsd: number;
  rpcCalls: number;
}

type ProxyAction = 'deploy' | 'upgrade';

interface GasOnlyTest {
  id: string;
  maximumGasUsd: number;
  requireGasCoverage: boolean;
  privateSubmission: boolean;
  publicFunctional: boolean;
  minimumNetUsd?: number;
  minimumLoanUsd?: number;
  expiresAt: number;
  blocksChecked: number;
  routesChecked: number;
}

interface MevFile {
  version: 1;
  armed: boolean;
  armedAt: number | null;
  contract: Address | null;
  v2Contract?: Address | null;
  v2DeployedAt?: number;
  v2DeployGasUsd?: number;
  v3Contract?: Address | null;
  v3DeployedAt?: number;
  v3DeployGasUsd?: number;
  proxyContract?: Address;
  proxyImplementation?: Address;
  proxyRelease?: Hex;
  proxyDeployedAt?: number;
  proxyDeployGasUsd?: number;
  deployedAt: number | null;
  deployTx: Hex | null;
  deployVersion?: 'v2' | 'v3' | 'proxy' | 'proxy-upgrade' | null;
  deployRelease?: Hex | null;
  deployNonce: number | null;
  deployStartedAt: number | null;
  deployGasUsd: number;
  stats: MevStats;
  recent: MevOpp[];
  best: HourBest[];
  pending: PendingBundle | null;
  directGas?: { hour: number; usd: number }[];
  lastGasOnlyTest?: { id: string; hash: Hex };
}

interface PendingBundle {
  kind?: 'direct';
  privateSubmission?: true;
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
  headAgeMs?: number;
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
  test?: GasOnlyTest;
  premium?: boolean;
  privateSubmission?: true;
  contract: Address;
  ethUsd: number;
  data: Hex;
  gas: bigint;
  gasBudget: bigint;
  tip: bigint;
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  target: bigint;
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
  gasRetry?: { profit: bigint; gasUnits: number; cadenceAt?: number };
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
  lastBlock: { number: number; at: number; candidates: number; readMs: number; headAgeMs?: number; decisionMs: number | null; failedChunks: number } | null = null;
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
  private queuedTest: GasOnlyTest | null = null;
  private readonly startedAt = Date.now();
  private scanWindow: { at: number; candidates: number; simulated: number; bestNetUsd: number | null }[] = [];
  private readonly backfill = new HeadBackfill();
  private headWake: ReturnType<typeof createHeadWake> = null;

  constructor(private host: MevHost, private persist = true) {
    this.file = this.load();
    const searcher = this;
    this.universe = new MevUniverse(persist, (message, level) => this.host.log(`[mev] ${message}`, level), {
      includePancakeV3: true, includeUniswapV4: true,
      get includePancakeV2() { return searcher.supportsPancakeV2; },
      get includeCurve() { return searcher.supportsCurve; },
    });
  }

  private get v3Address() { return this.file.v3Contract ?? MEV.v3ContractAddress; }
  private get isV3() { return Boolean(this.file.proxyContract || this.v3Address); }
  private get previewLatest() { return MEV.submission === 'direct' && !directBudgetConfigured(); }
  private get supportsSpark() { return this.previewLatest || Boolean(this.file.proxyRelease && releaseSupportsSpark(this.file.proxyRelease)); }
  private get supportsPancakeV2() { return this.previewLatest || Boolean(this.file.proxyRelease && releaseSupportsPancakeV2(this.file.proxyRelease)); }
  private get supportsCurve() { return this.previewLatest || Boolean(this.file.proxyRelease && releaseSupportsCurve(this.file.proxyRelease)); }
  private get contractLabel() { return this.file.proxyContract ? 'FlashArb Proxy' : this.isV3 ? 'FlashArbV3' : 'FlashArbV2'; }
  private get contractRuntime(): Hex {
    if (this.previewLatest) return proxyReleaseRuntime;
    if (this.file.proxyRelease) return releaseRuntime(this.file.proxyRelease) ?? proxyReleaseRuntime;
    return this.isV3 ? FLASH_ARB_V3_RUNTIME : FLASH_ARB_V2_RUNTIME;
  }
  private get selectedContract() { return this.file.proxyContract ?? this.v3Address ?? this.file.v2Contract ?? null; }
  private get configuredContract() { return this.file.proxyContract ? null : this.isV3 ? MEV.v3ContractAddress : MEV.v2ContractAddress; }
  private proxyActionAvailable(action: ProxyAction) {
    if (!MEV.enabled || !this.persist || this.stopping || this.stateReadError) return false;
    const f = this.file;
    if (action === 'deploy') return !f.proxyContract;
    return Boolean(f.proxyContract && f.proxyRelease && releaseRuntime(f.proxyRelease) && f.proxyRelease !== proxyReleaseHash);
  }

  private liveData(data: Hex): Hex {
    return this.file.proxyRelease ? pinnedArbitrage(data, this.file.proxyRelease) : data;
  }

  private get pending() { return this.file.pending; }

  // ------------------------------------------------------------------ persistence
  private loadSaved(): MevFile | null {
    if (!this.persist) return null;
    try {
      const f = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as MevFile;
      if (f.version !== 1 || !f.stats || !Array.isArray(f.recent)) throw new Error('invalid MEV state');
      const proxyJournal = f.deployVersion === 'proxy' || f.deployVersion === 'proxy-upgrade';
      if (Boolean(f.proxyContract) !== Boolean(f.proxyRelease)
        || Boolean(f.proxyContract) !== Boolean(f.proxyImplementation)
        || proxyJournal !== Boolean(f.deployRelease)
        || (proxyJournal && !f.deployTx)
        || (f.deployVersion === 'proxy-upgrade' && !f.proxyContract)) throw new Error('invalid FlashArb proxy state');
      if ((f.deployTx != null && !/^0x[0-9a-f]{64}$/i.test(f.deployTx))
        || (f.deployVersion != null && !['v2', 'v3', 'proxy', 'proxy-upgrade'].includes(f.deployVersion))
        || (f.contract != null && !/^0x[0-9a-f]{40}$/i.test(f.contract))
        || (f.v2Contract != null && !/^0x[0-9a-f]{40}$/i.test(f.v2Contract))
        || (f.v3Contract != null && !/^0x[0-9a-f]{40}$/i.test(f.v3Contract))
        || (f.proxyContract != null && !/^0x[0-9a-f]{40}$/i.test(f.proxyContract))
        || (f.proxyImplementation != null && !/^0x[0-9a-f]{40}$/i.test(f.proxyImplementation))
        || (f.proxyRelease != null && !/^0x[0-9a-f]{64}$/i.test(f.proxyRelease))
        || (f.deployRelease != null && !/^0x[0-9a-f]{64}$/i.test(f.deployRelease))) throw new Error('invalid MEV contract state');
      f.best = Array.isArray(f.best) ? f.best.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) : [];
      f.deployStartedAt ??= null;
      f.deployNonce ??= null;
      f.pending ??= null;
      if (f.lastGasOnlyTest !== undefined && (!f.lastGasOnlyTest || typeof f.lastGasOnlyTest.id !== 'string' || !TEST_ID.test(f.lastGasOnlyTest.id)
        || !/^0x[0-9a-f]{64}$/i.test(f.lastGasOnlyTest.hash))) throw new Error('invalid gas-only test journal');
      // Earlier direct journals kept the count but lacked a dedicated confirmation timestamp.
      if (!f.stats.lastDirectLandedAt && f.stats.directLanded) {
        const latest = f.recent.find((row) => row?.status === 'landed' && row.submission?.kind === 'direct');
        if (latest && Number.isFinite(latest.t)) f.stats.lastDirectLandedAt = latest.t;
      }
      if (f.directGas !== undefined && (!Array.isArray(f.directGas)
        || f.directGas.some((entry) => !entry || !Number.isSafeInteger(entry.hour)
          || !Number.isFinite(entry.usd) || entry.usd < 0))) throw new Error('invalid direct gas ledger');
      const pending = f.pending;
      if (pending !== null) {
        if (!/^0x[0-9a-f]{64}$/i.test(pending.hash) || !/^0x[0-9a-f]{40}$/i.test(pending.contract)
          || !/^\d+$/.test(pending.target) || !Number.isSafeInteger(pending.nonce) || pending.nonce < 0
          || (pending.kind !== undefined && pending.kind !== 'direct')
          || (pending.privateSubmission !== undefined && (pending.privateSubmission !== true || pending.kind !== 'direct'))
          || (pending.kind === 'direct' && (!Number.isSafeInteger(pending.opp?.block) || pending.opp.block < 0))
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
    if (this.deploying) return 'Preparing the FlashArb proxy transaction…';
    if (this.file.deployTx) return 'Waiting for the deployment transaction to settle';
    if (this.file.armed && !this.contractReady) return `Verifying the ${this.contractLabel} contract…`;
    if (this.file.armed && MEV.submission === 'direct') return MEV.directProtected
      ? 'Live mode: eligible trades use deadline-protected private submission'
      : 'Live mode: eligible trades go directly to the Ethereum RPC';
    if (this.file.armed) return 'Live mode: eligible bundles go to the configured builders';
    if (MEV.submission === 'direct' && !directBudgetConfigured()) return 'Direct paper mode. Set gas limits before arming direct execution.';
    if (MEV.funding === 'spark' && !this.supportsSpark) return 'Deploy or upgrade FlashArb Proxy to simulate routes funded by SparkLend';
    if (MEV.funding === 'balancer' && !this.isV3) return 'Deploy FlashArb Proxy to simulate routes funded by Balancer V3';
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
    if (!this.stopping && !CONFIG.forkMode && MEV.submission === 'direct') this.headWake = createHeadWake(CONFIG.rpcUrl);
    void this.loop();
    if (this.universe.broad && !this.stopping) void this.discoverMorePools();
  }

  stop() {
    this.stopping = true;
    this.headWake?.stop();
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

  private waitForHead(ms: number) {
    return this.headWake?.wait(ms) ?? sleep(ms);
  }

  private async loop() {
    let last: { hash: Hex; number: bigint } | null = null;
    let backoff = 0;
    while (!this.stopping) {
      try {
        if (!this.universe.broad && Date.now() - this.poolsAt > 24 * HOUR) await this.refreshPools();
        const head = await this.head();
        if (head.hash === last?.hash || (last && head.number < last.number)) {
          const ageMs = Date.now() - Number(head.timestamp) * 1000;
          await this.waitForHead(ageMs < SLOT_MS + 3000 ? HEAD_RETRY_MS : 1000);
          continue;
        }
        if (MEV.submission === 'direct') void directPriorityFee(directPriorityCap()).catch(() => {});
        const r = await this.read(head);
        this.lastError = null;
        await this.onBlock(r);
        const previous = last;
        last = { hash: r.hash, number: r.blockNumber };
        if (previous) this.backfill.observe(previous.number, head.number);
        if (this.beforeNextSlot(r)) this.backfill.run((height) => this.scanHistorical(height));
        backoff = 0;
        // Start checking for the next execution head at the expected slot boundary.
        await this.waitForHead(Math.min(SLOT_MS, Math.max(HEAD_RETRY_MS, r.timestamp * 1000 + SLOT_MS - Date.now())));
      } catch (e) {
        this.lastError = errMsg(e);
        backoff = Math.min(backoff * 2 + 750, 6_000);
        await sleep(backoff);
      }
    }
  }

  private async scanHistorical(height: bigint) {
    this.file.stats.rpcCalls++;
    const header = await mevReadClient.getBlock({ blockNumber: height });
    if (header.number !== height) throw new Error('historical block did not match the expected height');
    const snapshot = await this.read(header);
    if (this.stopping || snapshot.failedChunks) throw new Error('historical snapshot incomplete');
    await this.onBlock(snapshot, true);
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
    const headAgeMs = Date.now() - Number(head.timestamp) * 1000;
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
      tokens, at: reads.at, results, readMs: Math.round(performance.now() - start), headAgeMs,
      failedChunks: valid.filter((chunk) => chunk === null).length,
    };
  }

  private async onBlock(r: BlockRead, historical = false) {
    const started = performance.now();
    const generation = this.armGeneration;
    this.file.stats.blocks++;
    if (!historical) {
      const recovery = this.reconcileWallet(r.blockNumber);
      if (CONFIG.forkMode) await recovery;
    }
    let nextMaxBase = r.nextBaseFee;
    if (!historical && MEV.submission === 'direct') {
      const cap = directPriorityCap();
      const priority = await directPriorityFee(cap).catch(() => cap);
      nextMaxBase = directFees(r.nextBaseFee, priority, DIRECT_WINDOW).maxFeePerGas;
    }
    const gasPriceEth = Number(nextMaxBase) / 1e18;
    const cands: Candidate[] = [];
    const test = historical ? null : this.activeGasOnlyTest();
    const testCandidates: Candidate[] = [];
    const now = Date.now();
    if (!historical && MEV.submission === 'direct' && !this.file.stats.directScanStartedAt) {
      this.file.stats.directScanStartedAt = now;
      this.save();
    }
    const ethUsd = this.host.ethUsd();
    const policy = this.profitPolicy(now);
    const cadence = historical ? null : this.cadence(now);
    const broadenSizes = Boolean(cadence && cadence.routeLimit > cadence.baseRouteLimit);
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
        if (test && cycle.profit > 0 && (t.token.core || (test.minimumNetUsd !== undefined && estimatedNet > 0))) {
          testCandidates.push({ t, A, B, dx: cycle.dx, est: cycle.profit, estimatedNet, gasUnits });
        }
        if (cycle.profit <= gasEth * (broadenSizes ? 0.65 : 0.8)) continue;
        const cd = this.cooldown.get(`${poolIdentity(A)}|${poolIdentity(B)}`);
        if (cd && now < cd.until && !estimateChanged(cycle.profit, cd)) {
          const retry = cd.gasRetry;
          const cadenceRetry = broadenSizes && retry?.cadenceAt !== undefined && now >= retry.cadenceAt;
          if (!cadenceRetry && (!retry || retry.profit - BigInt(retry.gasUnits) * nextMaxBase <= minimumNet)) continue;
        }
        cands.push({ t, A, B, dx: cycle.dx, est: cycle.profit, estimatedNet, gasUnits });
      }
    }
    if (historical) {
      this.recordScan(r.timestamp * 1000, cands.length, 0, null);
      return;
    }
    const block = { number: Number(r.blockNumber), at: now, candidates: cands.length, readMs: r.readMs, headAgeMs: r.headAgeMs, decisionMs: null as number | null, failedChunks: r.failedChunks };
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
    const additions = extraRoutes(cands, selected, (cadence?.routeLimit ?? selected.length) - MEV.maxSimsPerBlock,
      (candidate) => candidate.t.token.address.toLowerCase());
    const simulatedBefore = this.file.stats.simulated;
    const shortlistNet: number[] = [];
    const observedNet = (netUsd: number) => shortlistNet.push(netUsd);
    const canTest = () => !this.pending && this.activeGasOnlyTest() === test && this.canMeetSendDeadline(r);
    const prioritizeTest = test?.publicFunctional || test?.privateSubmission;
    if (test && prioritizeTest && canTest()) {
      await this.scanGasOnlyTest(test, testCandidates, r, nextMaxBase, policy, generation);
    }
    const signed = await this.scanShortlist(selected, r, nextMaxBase, policy, generation, observedNet,
      broadenSizes && additions.length === 0);
    const enoughTime = CONFIG.forkMode || r.timestamp * 1000 + SLOT_MS - Date.now() >= FALLBACK_LEAD_MS;
    if (!signed && !this.stopping && !this.pending && additions.length && enoughTime) {
      await this.scanShortlist(additions, r, nextMaxBase, policy, generation, observedNet, true);
    }
    if (test && !prioritizeTest && enoughTime && canTest()) {
      await this.scanGasOnlyTest(test, testCandidates, r, nextMaxBase, policy, generation);
    }
    block.decisionMs = Math.round(performance.now() - started);
    this.recordScan(now, cands.length, this.file.stats.simulated - simulatedBefore, shortlistNet.length ? Math.max(...shortlistNet) : null);
    if (this.file.stats.blocks % 20 === 0) this.save();
  }

  private async scanShortlist(selected: Candidate[], r: BlockRead, nextMaxBase: bigint, policy: ProfitPolicy,
    generation: number, observedNet: (usd: number) => void, broadenSizes: boolean): Promise<boolean> {
    const canTryLive = () => this.liveArmed(generation) && this.contractReady && !this.deploying && !this.walletPending()
      && (MEV.directProtected || !this.activeGasOnlyTest()?.privateSubmission);
    const canTryFallback = () => canTryLive() && !this.host.tradePending()
      && (CONFIG.forkMode || r.timestamp * 1000 + SLOT_MS - Date.now() >= FALLBACK_LEAD_MS);
    const allowFallback = canTryFallback();
    const shortlisted = await Promise.all(selected.map((candidate) =>
      this.evaluate(candidate, r, nextMaxBase, policy, allowFallback, observedNet, broadenSizes)));
    const offers = shortlisted.flatMap((route) => route?.primary ? [route.primary] : [])
      .sort((a, b) => a.score > b.score ? -1 : a.score < b.score ? 1 : 0);
    let fallback: Offer | undefined;
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
          fallback = bestFallback.offer;
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
    return Boolean(fallback?.opp.hash || offers.some((offer) => offer.opp.hash));
  }

  private async scanGasOnlyTest(test: GasOnlyTest, candidates: Candidate[], r: BlockRead, nextMaxBase: bigint,
    policy: ProfitPolicy, generation: number) {
    test.blocksChecked++;
    const ethUsd = this.host.ethUsd();
    const meetsSize = (candidate: Candidate) => test.minimumLoanUsd === undefined
      || (validPrice(ethUsd) && candidate.dx * ethUsd >= test.minimumLoanUsd);
    candidates.sort((a, b) => Number(meetsSize(b)) - Number(meetsSize(a)) || b.estimatedNet - a.estimatedNet);
    const diversified = test.privateSubmission || test.publicFunctional;
    const top = diversified
      ? extraRoutes(candidates, [], GAS_ONLY_TEST_ROUTES + 2, (candidate) => candidate.t.token.address.toLowerCase())
      : candidates.slice(0, GAS_ONLY_TEST_ROUTES);
    test.routesChecked += top.length;
    const canTry = () => this.liveArmed(generation) && !this.walletPending()
      && this.activeGasOnlyTest() === test && this.canMeetSendDeadline(r);
    const quotes = top.map((candidate) => this.evaluate(candidate, r, nextMaxBase, policy, false, undefined, true, test));
    if (diversified) {
      const prepared = (await Promise.all(quotes.map(async (quote) => {
        const route = await quote;
        if (!canTry() || !route?.primary) return [];
        const offers = route.fallback ? [route.primary, route.fallback] : [route.primary];
        return Promise.all(offers.map((offer) => this.prepareLive(offer, r, policy, test)));
      }))).flat();
      const ranked = prepared.filter((offer) => offer !== null).sort((a, b) => {
        const left = test.requireGasCoverage ? a.net : a.offer.profit;
        const right = test.requireGasCoverage ? b.net : b.offer.profit;
        return left > right ? -1 : left < right ? 1 : 0;
      });
      for (const offer of ranked) {
        if (!canTry()) break;
        await this.sendLive(offer, r, generation);
      }
      return;
    }
    const routes = await Promise.all(quotes);
    if (!canTry()) return;
    const offers = routes.flatMap((route) => route?.primary ? [route.primary] : [])
      .sort((a, b) => a.score > b.score ? -1 : a.score < b.score ? 1 : 0);
    for (const offer of offers) {
      if (!canTry()) break;
      const prepared = await this.prepareLive(offer, r, policy, test);
      if (prepared) await this.sendLive(prepared, r, generation);
    }
  }

  private recordScan(at: number, candidates: number, simulated: number, bestNetUsd: number | null) {
    this.scanWindow = this.scanWindow.filter((row) => row.at >= Date.now() - WINDOW_MS);
    this.scanWindow.push({ at, candidates, simulated, bestNetUsd });
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
        data: contract ? this.liveData(data) : data,
        stateOverride: contract
          ? undefined
          : [{ address: SIM_ADDR, code: this.contractRuntime, stateDiff: [{ slot: pad('0x0'), value: pad(this.host.account.address) }] }],
      });
      if (!res.data) return { ok: false, reason: 'no result', reverted: false };
      return { ok: true, profit: decodeArbitrage(res.data) };
    } catch (e) {
      const reverted = e instanceof BaseError && e.walk((cause) => cause instanceof ExecutionRevertedError) instanceof ExecutionRevertedError;
      return { ok: false, reason: reasonOf(e), reverted };
    }
  }

  private async evaluate(c: Candidate, r: BlockRead, nextMaxBase: bigint, policy: ProfitPolicy, allowFallback: boolean, observedNet?: (usd: number) => void, broadenSizes = false, test?: GasOnlyTest): Promise<EvaluatedRoute | null> {
    const st = this.file.stats;
    st.candidates++;
    const key = `${poolIdentity(c.A)}|${poolIdentity(c.B)}`;
    const price = this.host.ethUsd();
    const limit = loanLimitWei(MEV.maxLoanUsd, price);
    if (limit === null || (test?.minimumLoanUsd !== undefined && !validPrice(price))) return null;
    const previous = this.previousSizes.get(key);
    const previousAmount = previous && Date.now() - previous.at < 10 * 60_000 ? previous.amount : undefined;
    let sizes = routeInputSizes(c.dx, !c.A.v2 || !c.B.v2, previousAmount, limit, broadenSizes);
    if (test?.minimumLoanUsd !== undefined && validPrice(price)) {
      const floor = BigInt(Math.ceil(test.minimumLoanUsd / price * 1e18));
      sizes = sizes.filter((amount) => amount >= floor);
      if (!sizes.length && floor <= limit) sizes = [floor];
    }
    if (!sizes.length) return null;
    const lenderOnlyTest = test?.requireGasCoverage === false && !test.privateSubmission && !test.publicFunctional;
    const trials = fundingTrials(MEV.funding, sizes, this.isV3 || this.previewLatest, this.supportsSpark)
      .filter(({ funding }) => funding !== 0 || (!lenderOnlyTest && c.A.kind !== NextVenueKind.CurveTricrypto));
    if (!trials.length) return null;
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
      if (test) return null;
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
    if (test) {
      const alternate = test.privateSubmission || test.publicFunctional ? alternatives[0] : undefined;
      return { primary, fallback: alternate ? makeOffer(alternate) : undefined };
    }
    if (validPrice(ethUsd)) observedNet?.(primary.opp.netUsd);
    if (net < minNetWei) {
      // estimate far above reality = an illusion of the quick math: back off for longer
      const illusion = Number(b.profit) / 1e18 < c.est * 0.1;
      this.cooldown.set(key, {
        until: Date.now() + (illusion ? HOUR : 5 * 60_000), est: c.est, grow: illusion ? 3 : 1.5,
        gasRetry: { profit: b.profit, gasUnits: b.gasUnits,
          cadenceAt: !illusion && b.profit * 4n >= gasWei * 3n ? Date.now() + CADENCE_RECHECK_MS : undefined },
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

  private cadence(now: number) {
    if (MEV.submission !== 'direct') return null;
    const stats = this.file.stats;
    const lastLandedAt = stats.lastDirectLandedAt ?? null;
    const since = lastLandedAt ?? stats.directScanStartedAt ?? this.startedAt;
    return { ...directCadence(now, since, MEV.maxSimsPerBlock, MEV.directCadenceMaxRoutes,
      this.file.armed && this.contractReady), lastLandedAt };
  }

  private profitPolicy(now: number): ProfitPolicy {
    if (MEV.submission === 'direct') return { idle: false, minNetUsd: MEV.directMinNetUsd, builderTipPct: 0, gasPaddingPct: NORMAL_GAS_PADDING_PCT };
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

  private beforeNextSlot(r: Pick<BlockRead, 'timestamp'>): boolean {
    return CONFIG.forkMode || Date.now() < r.timestamp * 1000 + SLOT_MS;
  }

  private canMeetSendDeadline(r: Pick<BlockRead, 'timestamp'>): boolean {
    if (MEV.submission !== 'direct') return this.beforeNextSlot(r);
    return CONFIG.forkMode || r.timestamp * 1000 + SLOT_MS - Date.now() > DIRECT_SEND_LEAD_MS;
  }

  private skipOpportunity(opp: MevOpp, note: string) {
    opp.status = 'skipped';
    opp.note = note;
    this.record(opp);
    return null;
  }

  private directGasSpent(now: number): number {
    const start = hourOf(now) - GAS_LEDGER_HOURS;
    return (this.file.directGas ?? []).filter((entry) => entry.hour >= start).reduce((total, entry) => total + entry.usd, 0);
  }

  private availableDirectGasUsd(now: number, premium = false, test?: GasOnlyTest): number {
    if (test && (test.publicFunctional || test.minimumNetUsd !== undefined)) return test.maximumGasUsd;
    const spent = this.directGasSpent(now);
    if (premium) return MEV.directPremiumMaxGasUsd - spent;
    return Math.min(MEV.directMaxGasUsd, MEV.directDailyGasUsd - spent, test?.maximumGasUsd ?? Infinity);
  }

  private withinDirectGasBudget(gasUsd: number, now: number, premium = false, test?: GasOnlyTest): boolean {
    return gasUsd > 0 && gasUsd <= this.availableDirectGasUsd(now, premium, test);
  }

  private async prepareLive(offer: Offer, r: BlockRead, policy: ProfitPolicy, test?: GasOnlyTest): Promise<PreparedOffer | null> {
    const contract = this.selectedContract;
    const { candidate: c, opp } = offer;
    const gasOnly = test?.requireGasCoverage === false;
    if (test && (this.activeGasOnlyTest() !== test || MEV.submission !== 'direct'
      || (gasOnly && !test.privateSubmission && !test.publicFunctional && offer.funding === 0) || offer.profit < 1n)) return null;
    if (!contract) return this.skipOpportunity(opp, `verified ${this.contractLabel} unavailable`);
    if (!this.canMeetSendDeadline(r)) return this.skipOpportunity(opp, 'too late to prepare a fresh send');
    const ethUsd = this.host.ethUsd();
    if (!validPrice(ethUsd)) return this.skipOpportunity(opp, 'ETH/USD price unavailable');
    const loanCap = loanLimitWei(MEV.maxLoanUsd, ethUsd);
    if (loanCap === null || offer.amount > loanCap) return this.skipOpportunity(opp, 'flash loan exceeds the USD cap');
    if (test?.minimumLoanUsd !== undefined && eth(offer.amount) * ethUsd < test.minimumLoanUsd) {
      return this.skipOpportunity(opp, 'flash loan is below the requested test size');
    }
    const requestedNet = test?.minimumNetUsd;
    const profitTest = requestedNet !== undefined;
    const minimumPolicy = profitTest ? { ...policy, minNetUsd: requestedNet } : policy;
    let minimumNet = test && !profitTest ? 0n : this.minimumNet(ethUsd, minimumPolicy);
    let premium = false;
    const direct = MEV.submission === 'direct';
    const privateSubmission = direct && (test?.privateSubmission ?? MEV.directProtected) ? true : undefined;
    const privateGasOnly = privateSubmission && gasOnly;
    const privateLive = privateSubmission && !test;
    let horizon = test?.publicFunctional ? PUBLIC_FUNCTIONAL_TEST_WINDOW
      : privateGasOnly || profitTest ? PRIVATE_FUNCTIONAL_TEST_WINDOW
        : privateLive ? PRIVATE_LIVE_WINDOW : privateSubmission ? PRIVATE_DIRECT_WINDOW : DIRECT_WINDOW;
    let target = r.blockNumber + BigInt(horizon);
    const encode = (tip: bigint, minProfit: bigint) => this.liveData(encodeArbitrage(offer.funding, {
      buy: c.A, sell: c.B, token: c.t.token.address, amountIn: offer.amount, minProfit, tip, maxBlock: target,
    }));
    try {
      // Estimate the applicable payment path before simulating exact calldata and gas.
      this.file.stats.rpcCalls++;
      const priorityCap = test?.publicFunctional ? PUBLIC_FUNCTIONAL_PRIORITY_WEI : profitTest ? PREMIUM_QUOTE_CAP_WEI : directPriorityCap();
      const premiumAvailable = direct && !test && MEV.directPremiumMaxGasUsd > 0;
      const earlier = test?.publicFunctional && r.blockNumber >= 2n ? [r.blockNumber - 1n, r.blockNumber - 2n] : [];
      this.file.stats.rpcCalls += earlier.length;
      const [estimate, preferredTip, previousQuotes] = await Promise.all([
        mevReadClient.estimateGas({ account: this.host.account, to: contract, data: encode(direct ? 0n : 1n, 1n), blockNumber: r.blockNumber }),
        direct ? directPriorityFee(premiumAvailable ? PREMIUM_QUOTE_CAP_WEI : priorityCap, true) : 0n,
        Promise.all(earlier.map((height) => this.simulate(c.t, c.A, c.B, offer.amount, target, height, offer.funding))),
      ]);
      if (test?.publicFunctional && (previousQuotes.length !== 2
        || previousQuotes.some((quote) => !quote.ok || quote.profit * 2n < offer.profit))) {
        return this.skipOpportunity(opp, 'public functional test route was unstable in the previous two blocks');
      }
      const modeledProceeds = profitTest && test?.publicFunctional
        ? previousQuotes.reduce((payout, quote) => quote.ok && quote.profit < payout ? quote.profit : payout, offer.profit)
        : offer.profit;
      const reserve = direct && !gasOnly ? directExecutionReserve(modeledProceeds) : 0n;
      const spendableProceeds = modeledProceeds - reserve;
      const padding = privateGasOnly ? Math.min(policy.gasPaddingPct, 0.15) : policy.gasPaddingPct;
      const paddedBps = 10_000n + BigInt(Math.round(padding * 10_000));
      const gas = (estimate * paddedBps + 9_999n) / 10_000n;
      let fees = directFees(r.nextBaseFee, 0n, horizon);
      if (direct) {
        const now = Date.now();
        // A deadline-protected test bids as high as its padded gas and profit limits allow.
        const ordinaryTip = test?.publicFunctional || (test?.privateSubmission && !gasOnly && !profitTest) ? priorityCap : preferredTip < priorityCap ? preferredTip : priorityCap;
        const minimumTip = priorityCap < MIN_PRIORITY_FEE_WEI ? priorityCap : MIN_PRIORITY_FEE_WEI;
        const maxGasUsd = this.availableDirectGasUsd(now, false, test);
        const maxGasWei = loanLimitWei(maxGasUsd, ethUsd);
        let budgetFees = maxGasWei !== null
          ? affordableDirectFees(r.nextBaseFee, gas, ordinaryTip, minimumTip, maxGasWei, horizon) : null;
        if (!budgetFees && privateGasOnly && maxGasWei !== null) {
          for (const shorter of [PRIVATE_DIRECT_WINDOW, DIRECT_WINDOW]) {
            budgetFees = affordableDirectFees(r.nextBaseFee, gas, ordinaryTip, minimumTip, maxGasWei, shorter);
            if (!budgetFees) continue;
            horizon = shorter;
            target = r.blockNumber + BigInt(horizon);
            break;
          }
        }
        let affordableFees = gasOnly || !budgetFees ? budgetFees : affordableDirectFees(
          r.nextBaseFee, gas, budgetFees.maxPriorityFeePerGas, minimumTip, spendableProceeds - minimumNet, horizon,
        );
        if (!affordableFees && privateLive && maxGasWei !== null) {
          const shorterBudget = affordableDirectFees(r.nextBaseFee, gas, ordinaryTip, minimumTip, maxGasWei, PRIVATE_DIRECT_WINDOW);
          budgetFees ??= shorterBudget;
          if (shorterBudget) {
            affordableFees = affordableDirectFees(r.nextBaseFee, gas, shorterBudget.maxPriorityFeePerGas,
              minimumTip, spendableProceeds - minimumNet, PRIVATE_DIRECT_WINDOW);
            if (affordableFees) {
              horizon = PRIVATE_DIRECT_WINDOW;
              target = r.blockNumber + BigInt(horizon);
            }
          }
        }
        if (!affordableFees && profitTest && privateSubmission && maxGasWei !== null) {
          const safeGasWei = spendableProceeds - minimumNet;
          horizon = PRIVATE_DIRECT_WINDOW;
          target = r.blockNumber + BigInt(horizon);
          affordableFees = affordableDirectFees(r.nextBaseFee, gas, ordinaryTip, minimumTip,
            maxGasWei < safeGasWei ? maxGasWei : safeGasWei, horizon);
        }
        if (premiumAvailable) {
          const retained = this.minimumNet(ethUsd, { ...policy, minNetUsd: Math.max(policy.minNetUsd, PREMIUM_MIN_NET_USD) });
          const premiumCap = loanLimitWei(this.availableDirectGasUsd(now, true), ethUsd);
          const afterRetained = spendableProceeds - retained;
          // Keep at least half of the gross proceeds, even at the full padded gas limit.
          const halfProfit = spendableProceeds / 2n;
          const profitCap = afterRetained < halfProfit ? afterRetained : halfProfit;
          const maximum = premiumCap !== null && premiumCap < profitCap ? premiumCap : profitCap;
          const premiumTip = preferredTip > PREMIUM_TARGET_TIP_WEI ? preferredTip : PREMIUM_TARGET_TIP_WEI;
          let faster = premiumCap !== null
            ? affordableDirectFees(r.nextBaseFee, gas, premiumTip, minimumTip, maximum, horizon) : null;
          if (!faster && !affordableFees && privateLive && premiumCap !== null) {
            faster = affordableDirectFees(r.nextBaseFee, gas, premiumTip, minimumTip, maximum, PRIVATE_DIRECT_WINDOW);
            if (faster) {
              horizon = PRIVATE_DIRECT_WINDOW;
              target = r.blockNumber + BigInt(horizon);
            }
          }
          if (faster && faster.maxPriorityFeePerGas > (affordableFees?.maxPriorityFeePerGas ?? 0n)) {
            affordableFees = faster;
            minimumNet = retained;
            premium = true;
          }
        }
        if (!affordableFees) {
          if (!budgetFees) return this.skipOpportunity(opp, 'direct route exceeds an approved gas limit');
          return this.skipOpportunity(opp, test ? 'test payout does not cover padded gas' : 'below configured profit floor with padded gas');
        }
        fees = affordableFees;
      }
      const gasBudget = gas * fees.maxFeePerGas;
      if (premium && gasBudget > minimumNet) minimumNet = gasBudget;
      const afterGas = modeledProceeds - gasBudget;
      if (!gasOnly && afterGas < minimumNet) {
        return this.skipOpportunity(opp, test ? 'test payout does not cover padded gas' : 'below configured profit floor with padded gas');
      }
      const tip = direct ? 0n : this.builderTip(afterGas, minimumNet, policy);
      if (!direct && tip === 0n) return this.skipOpportunity(opp, 'profit does not cover a builder payment above the configured floor');
      const minimumProfit = gasOnly ? 1n : tip + gasBudget + minimumNet;
      return { offer, contract, ethUsd, gas, gasBudget, tip, fees, target, minimumProfit, test, premium, privateSubmission, data: encode(tip, minimumProfit), net: afterGas - tip };
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
    const { offer, contract, ethUsd, data, gas, gasBudget, tip, fees, target, minimumProfit, net, test, premium, privateSubmission } = prepared;
    const direct = MEV.submission === 'direct';
    const { opp } = offer;
    const skip = (note: string) => { this.skipOpportunity(opp, note); };
    const stillLive = () => this.liveArmed(generation) && this.contractReady && this.selectedContract === contract
      && !this.deploying && !this.host.tradePending() && this.canMeetSendDeadline(r);
    const canSend = () => stillLive() && (!test || this.activeGasOnlyTest() === test);
    if (!canSend()) return skip('target slot passed or MEV became unavailable before signing');
    if (this.walletPending() || !this.reserveBundle()) return skip('wallet is busy or MEV was disarmed');
    try {
      this.file.stats.rpcCalls += direct ? 2 : 1;
      const [result, nonce, balance, observedHead, pendingCheck] = await Promise.all([
        mevReadClient.call({ account, to: contract, data, gas, blockNumber: r.blockNumber }),
        exec.bundleNonce(),
        mevReadClient.getBalance({ address: account.address }),
        direct ? this.head() : undefined,
        direct ? mevReadClient.call({ account, to: contract, data, gas, ...fees, value: 0n, blockTag: 'pending' })
          .catch((error) => ({ data: undefined, failure: reasonOf(error) })) : undefined,
      ]);
      if (!result.data || decodeArbitrage(result.data) < minimumProfit) {
        return skip('final simulation returned insufficient profit');
      }
      if (direct && !this.withinDirectGasBudget(eth(gasBudget) * ethUsd, Date.now(), premium, test)) return skip('direct gas limit reached');
      const head = observedHead ?? await this.head();
      if (head.hash !== r.hash || !canSend()) return skip('block changed or MEV was disarmed before signing');
      if (balance < gasBudget) {
        if (premium && this.host.requestGasTopUp) {
          // The fee-bearing pending call can reject an unfunded sender before running the order.
          const [fundingQuote, fundingHead] = await Promise.all([
            pendingCheck?.data ? pendingCheck
              : mevReadClient.call({ account, to: contract, data, gas, blockTag: 'pending' }).catch(() => undefined),
            this.head(),
          ]);
          if (fundingQuote?.data && decodeArbitrage(fundingQuote.data) >= minimumProfit
            && fundingHead.hash === r.hash && canSend()) this.host.requestGasTopUp(gasBudget);
        }
        return skip('wallet ETH does not cover the padded gas budget');
      }
      if (direct && (!pendingCheck?.data || decodeArbitrage(pendingCheck.data) < minimumProfit)) {
        const failure = pendingCheck && 'failure' in pendingCheck ? pendingCheck.failure : 'insufficient profit';
        return skip('pending-state simulation: ' + failure);
      }
      const currentEthUsd = this.host.ethUsd();
      if (premium && (!validPrice(currentEthUsd) || minimumProfit - gasBudget < BigInt(Math.ceil(PREMIUM_MIN_NET_USD / currentEthUsd * 1e18)))) {
        return skip('premium route falls below its required net profit at signing');
      }
      if (test?.minimumNetUsd !== undefined && (!validPrice(currentEthUsd)
        || minimumProfit - gasBudget < BigInt(Math.ceil(test.minimumNetUsd / currentEthUsd * 1e18)))) {
        return skip('test route falls below its required net profit at signing');
      }
      const currentLoanCap = loanLimitWei(MEV.maxLoanUsd, currentEthUsd);
      if (currentLoanCap === null || offer.amount > currentLoanCap) return skip('flash loan exceeds the USD cap at signing');
      if (test?.minimumLoanUsd !== undefined && (!validPrice(currentEthUsd) || eth(offer.amount) * currentEthUsd < test.minimumLoanUsd)) {
        return skip('flash loan is below the requested test size at signing');
      }
      const signingGasUsd = eth(gasBudget) * (currentEthUsd ?? ethUsd);
      if (direct && !this.withinDirectGasBudget(signingGasUsd, Date.now(), premium, test)) return skip('direct gas limit reached at signing');
      if (test && signingGasUsd > test.maximumGasUsd) return skip('gas-only test would exceed its gas cap at signing');
      const signed = await account.signTransaction({
        chainId: publicClient.chain.id, type: 'eip1559', to: contract, data, nonce, gas,
        ...fees, value: 0n,
      });
      if (direct && (await this.head()).hash !== r.hash) return skip('block changed after signing before broadcast');
      if (!canSend()) return skip('target slot passed or MEV was disarmed before broadcast');
      const hash = keccak256(signed);
      const startedAt = Date.now();
      const kind = direct ? 'direct' as const : undefined;
      const submission: BundleSubmission = {
        kind, privateSubmission,
        target: Number(target), startedAt, leadMs: r.timestamp * 1000 + SLOT_MS - startedAt,
        priorityGwei: direct ? Number(fees.maxPriorityFeePerGas) / 1e9 : undefined,
        gasEth: eth(gasBudget), tipEth: eth(tip), netUsd: eth(net) * ethUsd, builders: [],
      };
      const queued = direct ? this.activeGasOnlyTest() : null;
      const matched = queued && signingGasUsd <= queued.maximumGasUsd
        && (offer.funding !== 0 || queued.requireGasCoverage || queued.privateSubmission || queued.publicFunctional)
        && (!queued.privateSubmission || privateSubmission)
        && (!queued.publicFunctional || queued === test || queued.minimumNetUsd !== undefined)
        && (queued.minimumLoanUsd === undefined || (validPrice(currentEthUsd) && eth(offer.amount) * currentEthUsd >= queued.minimumLoanUsd))
        && (queued.minimumNetUsd === undefined || queued === test || (minimumProfit - gasBudget) >=
          BigInt(Math.ceil(queued.minimumNetUsd / (currentEthUsd ?? ethUsd) * 1e18))) ? queued : null;
      Object.assign(opp, {
        gasOnlyTestId: matched?.id,
        hash, status: 'sent', gasEth: submission.gasEth, tipEth: submission.tipEth,
        netEth: eth(net), netUsd: submission.netUsd, note: direct ? 'awaiting direct RPC submission' : 'awaiting builder replies', submission,
      });
      const pending = { kind, privateSubmission, hash, nonce, target: target.toString(), contract, ethUsd, opp };
      const recent = this.file.recent.slice();
      const attempts = this.file.stats.directAttempts;
      const lastTest = this.file.lastGasOnlyTest;
      if (matched) this.file.lastGasOnlyTest = { id: matched.id, hash };
      this.file.pending = pending;
      if (direct) this.file.stats.directAttempts = (attempts ?? 0) + 1;
      this.record(opp, false);
      try {
        this.writeState();
      } catch (error) {
        this.file.pending = null;
        this.file.recent = recent;
        this.file.stats.directAttempts = attempts;
        this.file.lastGasOnlyTest = lastTest;
        throw error;
      }
      // A signed test is consumed on the durable nonce journal, even if the RPC times out.
      if (matched) this.queuedTest = null;
      const canSubmit = () => stillLive() && (!test || Date.now() < test.expiresAt) && this.pending === pending;
      const flight = direct ? this.submitSignedDirect(pending, signed, canSubmit)
        : this.submitSignedBundle(pending, submission, signed, canSubmit);
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

  private async submitSignedDirect(pending: PendingBundle, signed: Hex, canSubmit: () => boolean) {
    if (!canSubmit()) {
      if (this.pending === pending) this.finishBundle({
        ...pending.opp, status: 'skipped', note: 'direct send canceled before contacting the RPC', gasEth: 0, tipEth: 0, netEth: 0, netUsd: 0,
      });
      return;
    }
    const startedAt = performance.now();
    try {
      if (pending.privateSubmission) await submitPrivateDirect(signed, BigInt(pending.target), canSubmit);
      else await submitDirect(signed);
      const rpcAckMs = Math.round(performance.now() - startedAt);
      if (this.pending === pending) {
        pending.opp.note = pending.privateSubmission ? 'private relay accepted; awaiting receipt' : 'direct Ethereum RPC accepted; awaiting receipt';
        if (pending.opp.submission) pending.opp.submission.rpcAckMs = rpcAckMs;
      }
      this.host.log(`[mev] Direct transaction ${pending.hash} submitted. RPC acknowledged in ${rpcAckMs} ms. Route deadline is block ${pending.target}.`);
    } catch (e) {
      if (this.pending === pending) pending.opp.note = 'direct send outcome unknown; waiting for confirmed nonce settlement';
      this.host.log(`[mev] Direct send ${pending.hash} awaiting reconciliation: ${errMsg(e)}`, 'warn');
    }
    this.save();
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
    if (p.kind !== 'direct' && current < target + confirmations) return;
    const receipt = await this.receipt(p.hash);
    if (receipt) {
      if (current < receipt.blockNumber + confirmations) return;
      if (p.kind === 'direct' && (receipt.from.toLowerCase() !== this.host.account.address.toLowerCase()
        || receipt.to?.toLowerCase() !== p.contract.toLowerCase())) throw new Error('unexpected direct transaction receipt');
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
      this.host.log(`[mev] ${p.kind === 'direct' ? 'Direct transaction' : 'Bundle'} ${p.hash} ${outcome.status}: ${outcome.note}`, outcome.status === 'landed' ? 'trade' : 'warn');
      return;
    }
    if (p.kind === 'direct') {
      const confirmedBlock = current - confirmations;
      const first = BigInt(p.opp.block) + 1n;
      if (confirmedBlock < (p.privateSubmission ? target : first)) return;
      const nonce = await findNonceConsumer(this.host.account.address, p.nonce, confirmedBlock, first);
      if (nonce.status === 'included' && nonce.hash.toLowerCase() !== p.hash.toLowerCase()) {
        this.host.exec.noteNonceUsed(p.nonce);
        this.finishBundle({ ...p.opp, status: 'not included', note: 'a different confirmed transaction used the nonce',
          netEth: 0, netUsd: 0, gasEth: 0, tipEth: 0 });
        this.host.log(`[mev] Direct transaction ${p.hash} was replaced at nonce ${p.nonce}.`);
      } else if (p.privateSubmission && nonce.status === 'unused') {
        this.finishBundle({ ...p.opp, status: 'not included', note: 'private deadline passed without using this nonce',
          netEth: 0, netUsd: 0, gasEth: 0, tipEth: 0 });
        this.host.log(`[mev] Private transaction ${p.hash} missed blocks ${first} through ${target}. Wallet nonce was unused.`);
      } else if (current > target && this.pending === p) {
        p.opp.note = nonce.status !== 'unused' ? 'nonce settlement awaiting a verified receipt'
          : 'route expired; wallet reserved until the public nonce settles';
      }
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
    const previous = { pending: f.pending, recent: f.recent, stats: f.stats, directGas: f.directGas };
    f.pending = null;
    f.recent = retainRecent([outcome, ...f.recent.filter((item) => item.hash !== outcome.hash)], RECENT_LIMIT, RECENT_BUNDLE_LIMIT);
    if (included) {
      const landed = outcome.status === 'landed';
      const direct = previous.pending?.kind === 'direct';
      if (direct && previous.pending) {
        const hour = hourOf(Date.now());
        const ledger = (f.directGas ?? []).filter((entry) => entry.hour >= hour - GAS_LEDGER_HOURS && entry.hour < hour);
        const current = (f.directGas ?? []).find((entry) => entry.hour === hour);
        const spent = outcome.gasEth * previous.pending.ethUsd;
        f.directGas = [...ledger, { hour, usd: (current?.usd ?? 0) + spent }];
      }
      f.stats = {
        ...f.stats, landed: f.stats.landed + (landed ? 1 : 0),
        directLanded: (f.stats.directLanded ?? 0) + (direct && landed ? 1 : 0),
        lastDirectLandedAt: direct && landed ? Date.now() : f.stats.lastDirectLandedAt,
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
    if (CONFIG.forkMode || this.stopping || MEV.submission === 'direct' || !submission
      || submission.kind === 'direct' || !Array.isArray(submission.builders)) return false;
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

  queueGasOnlyTest(id: string, maximumGasUsd: number, requireGasCoverage = false,
    privateSubmission = false, publicFunctional = false, minimumNetUsd?: number, minimumLoanUsd?: number) {
    if (this.queuedTest?.id === id || this.file.lastGasOnlyTest?.id === id
      || this.file.recent.some((row) => row?.gasOnlyTestId === id)) return;
    const profitTest = minimumNetUsd !== undefined;
    if (profitTest && (!requireGasCoverage || privateSubmission === publicFunctional
      || !Number.isFinite(minimumNetUsd * 1e18) || minimumNetUsd <= 0)) {
      throw new Error('A minimum net profit requires full gas coverage and a submission mode.');
    }
    if (minimumLoanUsd !== undefined && (!profitTest || !Number.isFinite(minimumLoanUsd)
      || minimumLoanUsd < 1 || minimumLoanUsd > MEV.maxLoanUsd)) throw new Error('Invalid minimum USD loan size.');
    const gasCap = profitTest ? MAX_PROFIT_TEST_GAS_USD : publicFunctional ? MAX_PUBLIC_FUNCTIONAL_TEST_USD : MEV.directMaxGasUsd;
    if (publicFunctional && (privateSubmission || (requireGasCoverage && !profitTest))) throw new Error('Invalid public test settings.');
    if (!TEST_ID.test(id) || !Number.isFinite(maximumGasUsd) || maximumGasUsd <= 0 || maximumGasUsd > gasCap) {
      throw new Error('The test needs an ID and a gas cap within the live direct limit.');
    }
    if (MEV.submission !== 'direct' || !this.file.proxyContract || !this.contractReady
      || !this.liveArmed(this.armGeneration) || this.walletPending() || this.host.tradePending()) {
      throw new Error('A verified, armed direct proxy with an available wallet is required for a test.');
    }
    if (this.activeGasOnlyTest()) throw new Error('A gas-only test is already queued.');
    this.queuedTest = { id, maximumGasUsd, requireGasCoverage, privateSubmission, publicFunctional,
      minimumNetUsd: minimumNetUsd === undefined ? undefined : Math.max(MEV.directMinNetUsd, minimumNetUsd),
      minimumLoanUsd, expiresAt: Date.now() + GAS_ONLY_TEST_MS, blocksChecked: 0, routesChecked: 0 };
    const coverage = requireGasCoverage ? ' requiring full gas coverage' : '';
    this.host.log('[mev] One flash-loan test queued' + coverage + ' with a gas cap of $' + maximumGasUsd.toFixed(2) + '.');
  }

  private activeGasOnlyTest() {
    const test = this.queuedTest;
    return test && Date.now() < test.expiresAt ? test : null;
  }

  private gasOnlyTestView() {
    const queued = this.queuedTest;
    if (queued) return { ...queued, status: this.activeGasOnlyTest() ? 'queued' : 'expired', hash: null };
    const saved = this.file.lastGasOnlyTest;
    if (!saved) return null;
    const trade = this.file.recent.find((row) => row?.hash === saved.hash);
    return { ...saved, status: !trade ? 'journaled' : trade.status === 'sent' ? 'submitted' : trade.status };
  }

  // ------------------------------------------------------------------ arming & the contract
  arm() {
    if (!MEV.enabled) throw new Error('MEV is turned off in .env (MEV=off)');
    if (!CONFIG.allowLiveTrading && !CONFIG.forkMode) throw new Error('Live execution is disabled (ALLOW_LIVE_TRADING=off).');
    if (MEV.submission === 'bundle' && !CONFIG.forkMode && MEV.builders.length === 0) throw new Error('MEV requires at least one configured builder.');
    if (MEV.submission === 'direct' && !directBudgetConfigured()) {
      throw new Error('Set the direct transaction and daily gas limits before arming direct execution.');
    }
    if (this.stateReadError) throw new Error(this.stateReadError);
    if (!this.persist || this.stopping || this.walletPending()) throw new Error('MEV cannot arm while wallet recovery or contract preparation is in progress.');
    if (MEV.funding === 'spark' && !this.supportsSpark) throw new Error('SparkLend funding requires a compatible FlashArb Proxy release.');
    if (MEV.funding === 'balancer' && !this.isV3) throw new Error('Balancer V3 funding requires FlashArbV3.');
    const existing = this.selectedContract;
    const configured = this.configuredContract;
    if (existing && configured && existing.toLowerCase() !== configured.toLowerCase()) {
      throw new Error(`The configured ${this.contractLabel} address conflicts with the saved deployment. Review both addresses before arming.`);
    }
    const address = existing ?? configured;
    if (!address) throw new Error('Deploy FlashArb Proxy from the dashboard before arming MEV.');
    if (this.file.armed) return;
    const generation = ++this.armGeneration;
    this.contractReady = false;
    this.file.armed = true;
    this.file.armedAt = Date.now();
    this.status = this.modeText();
    this.host.log(`MEV live arming requested. Verifying ${this.contractLabel}.`, 'warn');
    void this.verifyForArm(address, generation);
  }

  disarm(reason = 'by user') {
    this.queuedTest = null;
    if (!this.file.armed && !this.deploying) return;
    this.armGeneration++;
    const wasArmed = this.file.armed;
    this.file.armed = false;
    this.file.armedAt = null;
    this.contractReady = false;
    this.status = this.modeText();
    if (wasArmed) this.host.log(`MEV arbitrage disarmed ${reason}. Scanning continues in paper mode.`, 'warn');
  }

  private async contractOk(addr: Address, runtime: Hex = this.contractRuntime, blockNumber?: bigint): Promise<boolean> {
    const [code, owner] = await Promise.all([
      publicClient.getCode({ address: addr, blockNumber }).catch(() => undefined),
      publicClient.readContract({ address: addr, abi: FLASH_ARB_V2_ABI, functionName: 'owner', blockNumber }).catch(() => null),
    ]);
    return code?.toLowerCase() === runtime.toLowerCase() && owner?.toLowerCase() === this.host.account.address.toLowerCase();
  }

  private clearDeployment(deployment?: { address: Address; gasWei: bigint; implementation?: Address }) {
    const f = this.file;
    const previous = {
      contract: f.contract, deployedAt: f.deployedAt, deployGasUsd: f.deployGasUsd,
      v2Contract: f.v2Contract, v2DeployedAt: f.v2DeployedAt, v2DeployGasUsd: f.v2DeployGasUsd,
      v3Contract: f.v3Contract, v3DeployedAt: f.v3DeployedAt, v3DeployGasUsd: f.v3DeployGasUsd,
      proxyContract: f.proxyContract, proxyImplementation: f.proxyImplementation, proxyRelease: f.proxyRelease,
      proxyDeployedAt: f.proxyDeployedAt, proxyDeployGasUsd: f.proxyDeployGasUsd,
      deployTx: f.deployTx, deployVersion: f.deployVersion, deployRelease: f.deployRelease, deployNonce: f.deployNonce, deployStartedAt: f.deployStartedAt,
    };
    if (deployment) {
      const cost = eth(deployment.gasWei) * (this.host.ethUsd() ?? 0);
      if (f.deployVersion === 'proxy' || f.deployVersion === 'proxy-upgrade') {
        if (!deployment.implementation || !f.deployRelease) throw new Error('Missing verified proxy release');
        f.proxyContract = deployment.address;
        f.proxyImplementation = deployment.implementation;
        f.proxyRelease = f.deployRelease;
        if (f.deployVersion === 'proxy') {
          f.proxyDeployedAt = Date.now();
          f.proxyDeployGasUsd = cost;
        }
      } else if (f.deployVersion === 'v3') {
        f.v3Contract = deployment.address;
        f.v3DeployedAt = Date.now();
        f.v3DeployGasUsd = cost;
      } else if (f.deployVersion === 'v2') {
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
    f.deployRelease = null;
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
      await this.verifyAndRecordDeployment(receipt.contractAddress ?? null, receipt.to ?? null, receipt.from,
        receipt.gasUsed * receipt.effectiveGasPrice, receipt.blockNumber);
      this.host.log('[mev] Restored the confirmed contract deployment.', 'trade');
    } else {
      this.clearDeployment();
      this.host.log('[mev] Contract deployment reverted.', 'warn');
    }
  }

  private async verifyAndRecordDeployment(created: Address | null, to: Address | null, from: Address, gasWei: bigint, blockNumber: bigint) {
    const f = this.file;
    const upgrade = f.deployVersion === 'proxy-upgrade';
    const address = upgrade ? f.proxyContract : created;
    const wallet = this.host.account.address;
    if (!address || from.toLowerCase() !== wallet.toLowerCase()
      || (upgrade ? to?.toLowerCase() !== address.toLowerCase() : to !== null)) throw new Error('Confirmed deployment has an unexpected sender or destination');

    if (f.deployVersion === 'proxy' || upgrade) {
      const implementation = f.deployRelease && await verifyFlashProxy(address, wallet, f.deployRelease, blockNumber);
      if (!implementation) throw new Error('Confirmed FlashArb proxy bytecode, release or wallet ownership could not be verified');
      this.clearDeployment({ address, gasWei, implementation });
      if (this.reads && !this.stopping) {
        void this.refreshPools().catch((error) => this.host.log('[mev] Pool refresh after proxy activation: ' + errMsg(error), 'warn'));
      }
    } else {
      const runtime = f.deployVersion === 'v3' ? FLASH_ARB_V3_RUNTIME : f.deployVersion === 'v2' ? FLASH_ARB_V2_RUNTIME : null;
      if (runtime && !await this.contractOk(address, runtime, blockNumber)) throw new Error('Confirmed deployment could not be verified');
      this.clearDeployment({ address, gasWei });
    }
    return address;
  }

  private async verifyForArm(address: Address, generation: number) {
    try {
      const proxy = this.file.proxyRelease;
      const verified = proxy
        ? await verifyFlashProxy(address, this.host.account.address, proxy)
        : await this.contractOk(address);
      if (!verified) throw new Error(`${this.contractLabel} bytecode or bot wallet ownership could not be verified.`);
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
      this.host.log(`[mev] Verified ${this.contractLabel} at ${address}`);
    } catch (error) {
      if (this.liveArmed(generation)) {
        this.host.log('[mev] Arming stopped: ' + errMsg(error), 'warn');
        this.disarm('after contract verification failed');
      }
    }
  }

  private proxyTransaction(action: ProxyAction) {
    if (action === 'deploy') return { data: proxyCreationData(), address: undefined };
    const { proxyContract, proxyRelease } = this.file;
    if (!proxyContract || !proxyRelease) throw new Error('A verified proxy deployment is required before upgrades.');
    return { data: proxyUpgradeData(proxyRelease), address: proxyContract };
  }

  async deploymentQuote(action: ProxyAction = 'deploy') {
    if (!this.proxyActionAvailable(action) || this.walletPending()) throw new Error('The FlashArb proxy gas quote is unavailable.');
    const { data, address } = this.proxyTransaction(action);
    const { balance, minimumWei, estimatedWei, gas, maxFeePerGas } = await this.host.exec.quoteDeployment(data, address);
    const maximumWei = estimatedWei === null ? null : gas * maxFeePerGas;
    return {
      version: 'proxy' as const,
      release: proxyReleaseHash,
      maximumWei: maximumWei?.toString() ?? null,
      balanceEth: eth(balance),
      minimumEth: eth(minimumWei),
      estimatedEth: estimatedWei === null ? null : eth(estimatedWei),
      maximumEth: maximumWei === null ? null : eth(maximumWei),
    };
  }

  /** The dashboard authorizes one wallet transaction for a single bundled release. */
  async deployFromDashboard(maximumGasWei: bigint, disarmSpot?: () => void, action: ProxyAction = 'deploy', release: Hex = proxyReleaseHash): Promise<Address> {
    if (!MEV.enabled) throw new Error('MEV is turned off in .env (MEV=off).');
    if (!CONFIG.allowLiveTrading && !CONFIG.forkMode) throw new Error('Live execution is disabled (ALLOW_LIVE_TRADING=off).');
    if (this.stateReadError) throw new Error(this.stateReadError);
    if (release !== proxyReleaseHash || !this.proxyActionAvailable(action) || this.walletPending() || this.host.tradePending()) {
      throw new Error('The requested FlashArb proxy release is unavailable or another wallet transaction is in progress.');
    }

    const { data, address } = this.proxyTransaction(action);
    let generation = this.armGeneration;
    this.deploying = true;
    this.status = this.modeText();
    const f = this.file;
    const canSend = () => this.deploying && this.armGeneration === generation && !this.stopping
      && !this.stateReadError && !this.pending && !this.host.tradePending();
    const log = (message: string) => this.host.log('[mev] ' + message);
    const onSigned = (hash: Hex, nonce: number) => {
      f.deployTx = hash;
      f.deployVersion = action === 'deploy' ? 'proxy' : 'proxy-upgrade';
      f.deployRelease = release;
      f.deployNonce = nonce;
      f.deployStartedAt = Date.now();
      try {
        this.writeState();
      } catch (error) {
        f.deployTx = null;
        f.deployVersion = null;
        f.deployRelease = null;
        f.deployNonce = null;
        f.deployStartedAt = null;
        throw error;
      }
    };
    const options = {
      maximumGasWei,
      beforeSign: () => {
        disarmSpot?.();
        if (f.armed) this.disarm('for the FlashArb proxy transaction');
        generation = this.armGeneration;
      },
    };
    try {
      if (address && (!f.proxyRelease || !await verifyFlashProxy(address, this.host.account.address, f.proxyRelease))) {
        throw new Error('The proxy changed since its last verified deployment.');
      }
      const r = address ? await this.host.exec.upgradeContract(address, data, log, onSigned, canSend, options)
        : await this.host.exec.deployContract(data, log, onSigned, canSend, options);
      const target = await this.verifyAndRecordDeployment(address ? null : r.address, address ?? null,
        this.host.account.address, r.gasWei, r.blockNumber);
      this.host.log('[mev] Verified FlashArb Proxy release at ' + target, 'trade');
      return target;
    } catch (error) {
      if (error instanceof UncertainTxError) throw new Error('The FlashArb proxy transaction is awaiting confirmation. Recovery continues in paper mode.');
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
    const now = Date.now();
    const hour = Math.floor(now / HOUR) * HOUR;
    const window = this.scanWindow.filter((row) => row.at >= now - WINDOW_MS);
    const nets = window.flatMap((row) => row.bestNetUsd === null ? [] : [row.bestNetUsd]);
    return {
      enabled: MEV.enabled,
      mode: !MEV.enabled ? 'off' : this.deploying ? 'deploying' : f.armed ? (this.contractReady ? 'live' : 'arming') : 'paper',
      status: this.status,
      lastError: this.lastError,
      armed: f.armed,
      contract: this.selectedContract,
      configuredContract: this.configuredContract,
      canDeployProxy: this.proxyActionAvailable('deploy'),
      canUpgradeProxy: this.proxyActionAvailable('upgrade'),
      proxyImplementation: f.proxyImplementation ?? null,
      proxyRelease: f.proxyRelease ?? null,
      contractVersion: f.proxyContract ? 'proxy' : this.isV3 ? 'v3' : 'v2',
      fundingMode: MEV.funding,
      paperRelease: this.previewLatest ? proxyReleaseHash : null,
      deployedAt: (f.proxyContract ? f.proxyDeployedAt : this.isV3 ? f.v3DeployedAt : f.v2DeployedAt) ?? null,
      deployGasUsd: (f.proxyContract ? f.proxyDeployGasUsd : this.isV3 ? f.v3DeployGasUsd : f.v2DeployGasUsd) ?? 0,
      tokens: this.tokens.length,
      pools: this.tokens.reduce((s, t) => s + t.pools.length, 0),
      venues,
      coverage: this.universe.view(),
      lastBlock: this.lastBlock,
      cadence: this.cadence(now),
      gasOnlyTest: this.gasOnlyTestView(),
      scanWindow: {
        blocks: window.length,
        candidates: window.reduce((sum, row) => sum + row.candidates, 0),
        simulations: window.reduce((sum, row) => sum + row.simulated, 0),
        bestNetUsd: nets.length ? Math.max(...nets) : null,
        caughtUp: this.backfill.caughtUp, missedSnapshots: this.backfill.missed, queuedSnapshots: this.backfill.pending,
      },
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
      pending: this.pending ? { hash: this.pending.hash, target: Number(this.pending.target), kind: this.pending.kind } : null,
      deploymentPending: f.deployVersion === 'proxy-upgrade' ? null : f.deployTx,
      upgradePending: f.deployVersion === 'proxy-upgrade' ? f.deployTx : null,
      recent: retainRecent(f.recent, DASHBOARD_RECENT_LIMIT, DASHBOARD_BUNDLE_LIMIT),
      settings: {
        submission: MEV.submission,
        maxLoanUsd: MEV.maxLoanUsd,
        direct: { maxGasUsd: MEV.directMaxGasUsd, dailyGasUsd: MEV.directDailyGasUsd, protected: MEV.directProtected,
          premiumMaxGasUsd: MEV.directPremiumMaxGasUsd, premiumMinNetUsd: PREMIUM_MIN_NET_USD,
          broadcastRpcCount: 1 + MEV.directBroadcastRpcUrls.length, spentGasUsd: this.directGasSpent(now), enabled: directBudgetConfigured() },
        tipPct: MEV.builderTipPct, minNetUsd: MEV.minNetUsd, minPoolWeth: MEV.minPoolWeth,
        activeProfitPolicy: this.profitPolicy(Date.now()),
        builders: MEV.builders.map((u) => new URL(u).hostname),
      },
    };
  }
}
