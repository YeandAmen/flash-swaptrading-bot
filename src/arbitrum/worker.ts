import fs from 'node:fs';
import path from 'node:path';
import { formatEther, formatUnits, isAddress, isAddressEqual, keccak256, parseAbiItem, parseEventLogs, type Address, type Hash, type Hex } from 'viem';
import { CONFIG, DATA_DIR, MEV } from '../config.js';
import { activeFlashTest, flashTestView, queueFlashTest, type FlashTest, type FlashTestOptions } from '../network-test.js';
import { NetworkActivity } from '../network-activity.js';
import { writeJson } from '../persistence.js';
import { loadOrCreateWallet } from '../wallet.js';
import { ARBITRUM_FLASH_ARB_ABI } from './artifact.js';
import { broadcastArbitrum, type ArbitrumBroadcast } from './broadcast.js';
import { arbitrumSupportsPaths, verifyArbitrumExecutor, type ArbitrumExecutor } from './proxy.js';
import { ARBITRUM_FLASH_ARB_LOGIC_V2_ABI } from './artifact-logic-v2.js';
import { scanArbitrumPaths, type ArbPathQuote } from './paths.js';
import { prepareArbitrumOrder, type ArbitrumOrderRejection } from './execution.js';
import { reconcileArbitrumIntent, type ArbitrumIntent } from './settlement.js';
import { arbitrumTestLeads } from './test-leads.js';
import {
  arbitrumChainId, arbitrumClient, arbitrumEthUsd, arbitrumProbeSize, defaultArbitrumRpc,
  discoverArbitrumPools, scanArbitrum, type ArbQuote, type RecentArbitrumSizingLead,
} from './market.js';

const journalFile = path.join(DATA_DIR, 'arbitrum-trades.json');
const haltedFile = path.join(DATA_DIR, 'arbitrum-disarmed.json');
const dayMs = 86400_000;
const txLimitUsd = Math.min(0.50, CONFIG.maxSwapNetworkFeeUsd);
const dailyLimitUsd = 2;
const minNetUsd = 0.05;
const transferAbi = [parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)')] as const;
const morpho = '0x6c247b1F6182318877311737BaC0844bAa518F5e';
const preparationStatus: Record<ArbitrumOrderRejection, string> = {
  'unsupported-path': 'Multi-hop route requires the reviewed Arbitrum proxy release',
  'daily-budget': 'Daily gas budget used',
  'net-floor': 'Prepared route did not meet the net profit floor',
  'stale-quote': 'Arbitrum quote or chain head was stale before preparation',
  'fee-cap': 'Estimated gas exceeded the approved fee cap',
  'deadline': 'Quoted route expired during pending simulation',
  'gas-estimate-changed': 'Estimated gas grew beyond the padded gas limit',
  'simulation-unavailable': 'Arbitrum pending simulation returned no result',
  'execution-reverted': 'Arbitrum route reverted before signing',
  'head-rpc': 'Arbitrum RPC failed while reading the chain head',
  'fee-rpc': 'Arbitrum RPC failed during fee estimation',
  'simulation-rpc': 'Arbitrum RPC failed during pending simulation',
};
type Pending = ArbitrumIntent & { ethUsd: number; budgetUsd: number; executor?: Address; owner?: Address;
  path?: { asset: Address; decimals: number; assetUsd: number; amount: string; hops: number } };
type Settlement = { hash: Hash; status: 'landed' | 'reverted' | 'unverified' | 'replaced' | 'expired'; gasUsd: number; netUsd: number; at: number;
  loanUsd?: number; replacementHash?: Hash };
type Journal = { pending: Pending | null; recent: Settlement[]; test?: FlashTest };

function receiptStatus(broadcast?: ArbitrumBroadcast): string {
  const alternate = broadcast?.via === 'alternate';
  switch (broadcast?.status) {
    case 'acknowledged':
      return alternate ? 'Alternate RPC acknowledged the Arbitrum transaction after a primary rate limit'
        : 'Primary RPC acknowledged the Arbitrum transaction. Waiting for receipt';
    case 'quota-rejected':
      return alternate ? 'Both Arbitrum RPCs refused the write due to rate limits. Waiting for reconciliation'
        : 'Primary RPC write was rate limited. Waiting for reconciliation';
    case 'hash-mismatch':
      return `${alternate ? 'Alternate' : 'Primary'} RPC returned a different hash. Waiting for reconciliation`;
    case 'unknown':
      return `${alternate ? 'Alternate' : 'Primary'} RPC send outcome is unknown. Waiting for reconciliation`;
    default:
      return 'Waiting for transaction receipt';
  }
}

export class ArbitrumWorker {
  private readonly rpcUrl = process.env.ARBITRUM_RPC_URL ?? defaultArbitrumRpc;
  private readonly client = arbitrumClient(this.rpcUrl);
  private readonly alternateWriter = this.rpcUrl.replace(/\/$/, '') === defaultArbitrumRpc
    ? arbitrumClient('https://arbitrum-one-rpc.publicnode.com') : null;
  private readonly executionEnabled = process.env.ARBITRUM_LIVE === 'on' && CONFIG.allowLiveTrading;
  private markets: Awaited<ReturnType<typeof discoverArbitrumPools>> = [];
  private refreshAfter = 0;
  private regularScans = 0;
  private readingPaths = false;
  // One poll and one background path observation may offer orders at once.
  // Both producers wait for their own work before offering another batch.
  private orderTail: Promise<unknown> = Promise.resolve();
  private sizingLead: RecentArbitrumSizingLead | null = null;
  private verified = false;
  private executorCheckAt = 0;
  private journal: Journal | null = null;
  private active = false;
  private sendGeneration = 0;
  private halted = fs.existsSync(haltedFile);
  readonly contract = (process.env.ARBITRUM_EXECUTOR_ADDRESS ?? '') as Address;
  readonly owner = (process.env.ARBITRUM_OWNER_ADDRESS ?? '') as Address;
  readonly enabled = process.env.ARBITRUM === 'on' && !CONFIG.forkMode;

  private readonly activity = new NetworkActivity();
  private deployment = {
    address: isAddress(this.contract) ? this.contract : null,
    owner: isAddress(this.owner) ? this.owner : null,
    verified: false,
    kind: null as ArbitrumExecutor['kind'] | null,
    implementation: null as Address | null,
    releaseHash: null as Hex | null,
    status: this.contract ? 'Awaiting executor verification' : 'No executor configured',
    hash: null as Hash | null,
    block: null as number | null,
    deployedAt: null as number | null,
  };

  summary = {
    mode: (this.enabled ? 'paper' : 'off') as 'off' | 'paper' | 'live',
    canArm: this.enabled && this.executionEnabled,
    status: this.enabled ? 'Starting' : 'Disabled',
    block: 0, pools: 0, routes: 0, simulated: 0, updatedAt: 0, netEstimateUsd: null as number | null,
    prunedRoutes: 0, prunedAfterBuy: 0, unavailableLegs: 0, pathRoutes: 0, pathStatus: 'Awaiting implementation verification',
    pathPools: 0, pathBlock: 0, pathMarkets: 0, pathUnavailable: 0,
    pathBest: null as { route: string; payoutUsd: number; loanUsd: number } | null,
    bestQuote: null as Awaited<ReturnType<typeof scanArbitrum>>['bestQuote'],
    largestQuote: null as Awaited<ReturnType<typeof scanArbitrum>>['largestQuote'],
    preparationRejections: {} as Partial<Record<ArbitrumOrderRejection, number>>,
    executor: isAddress(this.contract) ? this.contract : null,
    balanceEth: null as string | null, pending: null as Hash | null, settled: null as Settlement | null,
  };

  constructor(private readonly scanPaths = scanArbitrumPaths) {}

  view() {
    return { ...this.summary, deployment: this.deployment, logs: this.activity.view(),
      scanWindow: this.activity.scanWindow(), test: flashTestView(this.journal?.test) };
  }

  queueTest(id: string, options?: FlashTestOptions) {
    if (!this.journal || this.summary.mode !== 'live' || this.halted || this.journal.pending) throw new Error('Arbitrum live wallet is not ready for a test');
    const test = queueFlashTest(this.journal.test, id, Date.now(), options);
    if (test !== this.journal.test) {
      this.save({ ...this.journal, test });
      this.activity.record('info', 'Queued one Arbitrum mainnet flash-loan test');
    }
  }

  scanError(message: string) {
    this.summary.status = message;
    this.activity.record('error', message);
  }

  private async checkDeployment() {
    const hash = process.env.ARBITRUM_DEPLOYMENT_TX;
    if (!hash || !/^0x[0-9a-f]{64}$/i.test(hash)) return;
    try {
      const receipt = await this.client.getTransactionReceipt({ hash: hash as Hash });
      if (receipt.status !== 'success' || !receipt.contractAddress || !isAddressEqual(receipt.contractAddress, this.contract)
        || !isAddressEqual(receipt.from, this.owner)) {
        this.activity.record('warn', 'Configured deployment receipt does not match the executor and owner');
        return;
      }
      const block = await this.client.getBlock({ blockNumber: receipt.blockNumber });
      const deployedAt = Number(block.timestamp) * 1000;
      this.deployment = { ...this.deployment, hash: receipt.transactionHash, block: Number(receipt.blockNumber), deployedAt };
      this.activity.record('info', `Executor deployed in block ${receipt.blockNumber}`, `https://arbiscan.io/tx/${hash}`, deployedAt);
    } catch {
      this.activity.record('warn', 'Arbitrum deployment receipt could not be loaded');
    }
  }

  stop() {
    this.active = false;
    this.sendGeneration++;
  }

  disarm() {
    if (!this.enabled || !this.executionEnabled) return;
    this.halted = true;
    this.sendGeneration++;
    this.summary.mode = 'paper';
    this.activity.record('warn', 'Live signing disarmed');
    writeJson(haltedFile, true);
    if (this.journal?.test?.status === 'queued') {
      this.save({ ...this.journal, test: { ...this.journal.test, status: 'expired', note: 'Canceled when live signing was disarmed.' } });
    }
  }

  arm() {
    if (!this.enabled || !this.executionEnabled || !this.verified) throw new Error('Arbitrum live execution is unavailable');
    fs.rmSync(haltedFile, { force: true });
    if (this.summary.mode !== 'live') this.sendGeneration++;
    this.halted = false;
    this.summary.mode = 'live';
    this.activity.record('info', 'Live signing armed');
  }

  private async verifyExecutor() {
    this.deployment.verified = false;
    const executor = await verifyArbitrumExecutor(this.client, this.contract, this.owner);
    this.deployment = { ...this.deployment, ...executor, verified: true, status: executor.kind === 'proxy'
      ? 'ERC-1967 proxy, owner, admin and implementation verified' : 'Standalone executor bytecode and owner verified' };
    this.executorCheckAt = Date.now() + 60_000;
  }

  // Market observations do not delay two-swap quotes. Only the reviewed
  // release can hand its own recent observation to the live signing gate.
  private observePaths(block: bigint, price: Promise<number>, generation: number) {
    if (this.readingPaths) return;
    this.readingPaths = true;
    const release = this.deployment.releaseHash;
    const executable = this.deployment.verified && arbitrumSupportsPaths(release);
    const mode = executable ? 'Multi-hop' : 'Multi-hop observation (upgrade required)';
    void Promise.all([price, this.scanPaths(this.client, block, price, MEV.maxLoanUsd)]).then(async ([usd, result]) => {
      if (!this.active || this.deployment.releaseHash !== release) return;
      this.summary.pathBlock = Number(block);
      this.summary.pathRoutes = result.quotedRoutes;
      this.summary.pathPools = result.pools;
      this.summary.pathMarkets = result.paths;
      this.summary.pathUnavailable = result.unavailableLegs;
      this.summary.pathBest = result.best;
      this.summary.pathStatus = `${mode}: ${result.quotedRoutes} complete quotes across ${result.pools} pools`
        + (result.unavailableLegs ? `, ${result.unavailableLegs} unavailable legs` : '');
      this.activity.recordScan(result.quotedRoutes, Date.now());
      if (executable && result.opportunities.length) {
        await this.queueOrders(result.opportunities.slice(0, 3), usd, null, generation, release)
          .catch(() => this.scanError('Arbitrum multi-hop order preparation failed'));
      }
    }).catch(() => {
      this.summary.pathBlock = Number(block);
      this.summary.pathBest = null;
      this.summary.pathStatus = `${mode}: quotes unavailable`;
    }).finally(() => { this.readingPaths = false; });
  }

  async scan() {
    this.active = true;
    const generation = this.sendGeneration;
    if (!this.verified) {
      if (await this.client.getChainId() !== arbitrumChainId) throw new Error('RPC must report Arbitrum One');
      if (this.summary.executor) {
        await this.verifyExecutor();
        this.activity.record('info', this.deployment.status, `https://arbiscan.io/address/${this.contract}`);
        void this.checkDeployment();
      } else if (this.executionEnabled) throw new Error('Configure a verified Arbitrum executor before enabling live');
      if (this.executionEnabled) this.openJournal();
      this.verified = true;
      if (this.executionEnabled && !this.halted) this.summary.mode = 'live';
    } else if (this.deployment.kind === 'proxy' && Date.now() >= this.executorCheckAt) {
      await this.verifyExecutor();
    }
    if (isAddress(this.owner)) {
      this.summary.balanceEth = formatEther(await this.client.getBalance({ address: this.owner }));
    }
    if (this.journal?.pending) await this.reconcile();
    const quoteAt = Date.now();
    const block = await this.client.getBlockNumber({ cacheTime: 0 });
    if (Date.now() >= this.refreshAfter) {
      const markets = await discoverArbitrumPools(this.client, block);
      if (markets.length === 0) throw new Error('No liquid Arbitrum markets returned by RPC');
      this.markets = markets;
      this.refreshAfter = Date.now() + 5 * 60_000;
    }
    const selectedTest = this.journal?.test;
    const test = this.summary.mode === 'live' && !this.journal?.pending && activeFlashTest(selectedTest) ? selectedTest : null;
    this.summary.simulated = 0;
    this.summary.netEstimateUsd = null;
    this.summary.preparationRejections = {};
    if (test && test.minimumNetUsd === undefined && this.summary.executor) {
      const leads = arbitrumTestLeads(this.markets, block);
      if (leads.length) {
        test.checked += leads.length;
        const ethUsd = await arbitrumEthUsd(this.client, block);
        if (await this.queueOrders(leads, ethUsd, test, generation, this.deployment.releaseHash)) return;
      }
    }
    const regularScan = test ? undefined : this.regularScans++;
    const extraSize = regularScan === undefined ? undefined : arbitrumProbeSize(regularScan, this.sizingLead, Date.now());
    // Audit a different slice each regular scan while always quoting possible or unknown-price routes.
    const screenRoundTrips = regularScan === undefined ? false : { auditScan: regularScan };
    const price = arbitrumEthUsd(this.client, block);
    const supportsPaths = this.deployment.verified && arbitrumSupportsPaths(this.deployment.releaseHash);
    if (regularScan !== undefined && !this.journal?.pending && (supportsPaths || regularScan % 10 === 1)) {
      this.observePaths(block, price, generation);
    }
    const result = await scanArbitrum(this.client, block, this.markets,
      test?.minimumNetUsd !== undefined ? test.minimumLoanUsd ?? 0 : !!test, extraSize, MEV.maxLoanUsd, screenRoundTrips, price);
    const candidates = result.opportunities;
    if (test) test.checked += result.quotedRoutes;
    else this.sizingLead = result.sizingAmount === undefined ? null : { amount: result.sizingAmount, at: quoteAt };
    this.summary.block = Number(block);
    this.summary.pools = this.markets.reduce((sum, market) => sum + market.pools.length, 0);
    this.summary.routes = result.quotedRoutes;
    this.summary.prunedRoutes = result.prunedRoutes;
    this.summary.prunedAfterBuy = result.prunedAfterBuy;
    this.summary.unavailableLegs = result.unavailableLegs;
    this.summary.updatedAt = Date.now();
    this.summary.bestQuote = result.bestQuote;
    this.summary.largestQuote = result.largestQuote;
    this.activity.recordScan(this.summary.routes, this.summary.updatedAt);
    if (this.journal?.pending) this.summary.status = receiptStatus(this.journal.pending.broadcast);
    else if (candidates.length === 0) {
      const best = result.bestQuote;
      const quoteType = result.prunedRoutes ? 'screened quote' : 'quote';
      this.summary.status = best
        ? `Best ${best.symbol} ${quoteType} on a $${best.loanUsd.toFixed(2)} loan was ${best.payoutUsd < 0 ? '-' : ''}$${Math.abs(best.payoutUsd).toFixed(4)} after lender fee, before gas`
        : result.prunedRoutes ? 'No complete quote from routes that could repay at marginal prices' : 'No complete round-trip quote';
    } else if (!this.summary.executor) this.summary.status = 'Flash payout quoted. Deploy executor to check full fees';
    else {
      this.summary.status = 'No fresh route passed padded gas and payout floor';
      await this.queueOrders(candidates.slice(0, 3), result.ethUsd, test, generation, this.deployment.releaseHash);
    }
    const status = this.summary.status;
    if (result.unavailableLegs) this.summary.status += `. Partial scan, RPC unavailable for ${result.unavailableLegs} quote legs`;
    const screened = result.prunedRoutes ? ` ${result.prunedRoutes} routes screened out, ${result.prunedAfterBuy} after the buy quote.` : '';
    this.activity.record('info', `Block ${block}: ${result.quotedRoutes} two-swap quotes across ${this.summary.pools} pools, ${result.unavailableLegs} unavailable quote legs.${screened} ${this.summary.pathStatus}. ${status}.`, undefined, this.summary.updatedAt);
  }

  private queueOrders(candidates: (ArbQuote | ArbPathQuote)[], ethUsd: number, test: FlashTest | null, generation: number, release: Hex | null) {
    const run = () => this.tryOrders(candidates, ethUsd, test, generation, release);
    const result = this.orderTail.then(run, run);
    this.orderTail = result;
    return result;
  }

  private async tryOrders(candidates: (ArbQuote | ArbPathQuote)[], ethUsd: number, test: FlashTest | null, generation: number, release: Hex | null): Promise<boolean> {
    const canContinue = () => this.active && generation === this.sendGeneration && !this.journal?.pending
      && this.deployment.verified && this.deployment.releaseHash === release
      && (test ? this.journal?.test === test && activeFlashTest(test) : !activeFlashTest(this.journal?.test));
    const canSign = () => canContinue() && this.summary.mode === 'live' && !this.halted && !!this.journal;
    const available = this.journal ? Math.min(txLimitUsd, dailyLimitUsd
      - this.journal.recent.filter((row) => row.at > Date.now() - dayMs).reduce((sum, row) => sum + row.gasUsd, 0)) : txLimitUsd;
    let firstRejection: ArbitrumOrderRejection | undefined;
    let reachedLiveChecks = false;
    for (const candidate of candidates) {
      if (!canContinue()) return false;
      this.summary.simulated += 1;
      const prepared = await prepareArbitrumOrder(this.client, this.contract, this.owner, candidate, ethUsd, Math.max(minNetUsd, test?.minimumNetUsd ?? 0), available,
        !!test && test.minimumNetUsd === undefined, release ?? undefined);
      if (!canContinue()) return false;
      if (!prepared.ok) {
        firstRejection ??= prepared.reason;
        const counts = this.summary.preparationRejections;
        counts[prepared.reason] = (counts[prepared.reason] ?? 0) + 1;
        continue;
      }
      const loanUsd = 'legs' in candidate ? candidate.loanUsd : Number(formatEther(candidate.order.amountIn)) * ethUsd;
      if (test?.minimumLoanUsd !== undefined && loanUsd < test.minimumLoanUsd) continue;
      this.summary.netEstimateUsd = prepared.netUsd;
      this.summary.status = test ? 'Test route passed repayment and gas checks' : 'Executable quote passed profit and gas checks';
      if (!this.journal || !canSign()) return true;
      reachedLiveChecks = true;
      const { account } = loadOrCreateWallet();
      if (!isAddressEqual(account.address, this.owner)) throw new Error('Wallet does not match the Arbitrum executor owner');
      const [nonce, pending, balance, head] = await Promise.all([
        this.client.getTransactionCount({ address: account.address }),
        this.client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
        this.client.getBalance({ address: account.address }),
        this.client.getBlockNumber({ cacheTime: 0 }),
      ]);
      if (!canSign()) return true;
      if (nonce !== pending) {
        this.summary.status = 'Waiting for the wallet nonce to settle';
        return true;
      }
      if (balance < prepared.gasBudget) {
        this.summary.status = 'Quoted route exceeds the wallet ETH available for gas';
        continue;
      }
      if (head >= prepared.deadline) {
        this.summary.status = 'Quoted route expired before signing';
        continue;
      }
      const serializedTransaction = await account.signTransaction({ ...prepared.tx, type: 'eip1559', chainId: arbitrumChainId, nonce });
      if (!canSign()) return true;
      const hash = keccak256(serializedTransaction);
      this.save({ ...this.journal, pending: { hash, nonce, ethUsd, budgetUsd: prepared.worstGasUsd,
        owner: account.address, executor: this.contract,
        ...('legs' in candidate ? { path: { asset: candidate.asset, decimals: candidate.decimals, assetUsd: candidate.assetUsd,
          amount: candidate.amountIn.toString(), hops: candidate.legs.length } } : {}),
        signedAtBlock: head.toString(), deadline: prepared.deadline.toString() },
        ...(test ? { test: { ...test, status: 'submitted', hash, note: 'Waiting for the Arbitrum receipt.' } } : {}),
      });
      this.summary.status = 'Journaled Arbitrum transaction. Waiting for RPC acknowledgement';
      const alternate = this.alternateWriter;
      const broadcast = await broadcastArbitrum(
        (transaction) => this.client.sendRawTransaction({ serializedTransaction: transaction }), serializedTransaction, hash,
        alternate ? {
          send: (transaction) => alternate.sendRawTransaction({ serializedTransaction: transaction }),
          canSend: () => this.active && !this.halted && this.sendGeneration === generation && this.summary.mode === 'live'
            && this.deployment.verified && this.deployment.releaseHash === release && this.journal?.pending?.hash === hash
            && (!test || Date.now() < test.expiresAt),
          verifyFresh: async () => {
            const [id, primaryHead, alternateHead] = await Promise.all([
              alternate.getChainId(), this.client.getBlockNumber({ cacheTime: 0 }), alternate.getBlockNumber({ cacheTime: 0 }),
            ]);
            return id === arbitrumChainId && primaryHead >= head && alternateHead >= head
              && primaryHead < prepared.deadline && alternateHead < prepared.deadline;
          },
        } : undefined,
      );
      const journal = this.journal;
      if (journal?.pending?.hash === hash) {
        this.summary.status = receiptStatus(broadcast);
        this.save({ ...journal, pending: { ...journal.pending, broadcast } });
        this.activity.record(broadcast.status === 'acknowledged' ? 'info' : 'warn',
          this.summary.status, `https://arbiscan.io/tx/${hash}`);
      }
      return true;
    }
    if (available <= 0) this.summary.status = preparationStatus['daily-budget'];
    else if (firstRejection && !reachedLiveChecks) this.summary.status = preparationStatus[firstRejection];
    return false;
  }

  private openJournal() {
    if (fs.existsSync(journalFile)) {
      const journal: Journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
      if (!Array.isArray(journal.recent) || !Object.hasOwn(journal, 'pending')) throw new Error('Invalid Arbitrum trade journal');
      this.journal = journal;
    } else {
      this.journal = { pending: null, recent: [] };
    }
    this.summary.pending = this.journal.pending?.hash ?? null;
    this.summary.settled = this.journal.recent[0] ?? null;
    if (this.summary.settled) this.logSettlement(this.summary.settled);
  }

  private logSettlement(outcome: Settlement) {
    if (outcome.status === 'expired') {
      this.activity.record('warn', 'Arbitrum transaction expired after RPC rate limits. Its nonce remained unused and no gas was charged.', undefined, outcome.at);
      return;
    }
    this.activity.record(outcome.status === 'landed' ? 'trade' : 'warn',
      `Arbitrum transaction ${outcome.status}. Gas $${outcome.gasUsd.toFixed(4)}, net $${outcome.netUsd.toFixed(4)}.`,
      `https://arbiscan.io/tx/${outcome.replacementHash ?? outcome.hash}`, outcome.at);
  }

  private save(next: Journal) {
    const outcome = next.recent[0];
    if (outcome && next.test?.status === 'submitted' && next.test.hash === outcome.hash) {
      const meetsProfit = next.test.minimumNetUsd === undefined || outcome.netUsd >= next.test.minimumNetUsd;
      const meetsLoan = next.test.minimumLoanUsd === undefined || (outcome.loanUsd ?? 0) >= next.test.minimumLoanUsd;
      const passed = outcome.status === 'landed' && meetsProfit && meetsLoan;
      const belowFloor = outcome.status === 'landed' && !passed ? ' The receipt did not meet the requested loan or profit floor.' : '';
      const note = outcome.status === 'expired' ? 'RPC rate limits prevented submission. The nonce remained unused and no gas was charged.'
        : `Confirmed ${outcome.status}. Gas $${outcome.gasUsd.toFixed(4)}, net $${outcome.netUsd.toFixed(4)}.${belowFloor}`;
      next = { ...next, test: { ...next.test, status: passed ? 'landed' : 'failed', note } };
    }
    writeJson(journalFile, next);
    if (outcome && this.journal?.recent[0]?.hash !== outcome.hash) this.logSettlement(outcome);
    this.journal = next;
    this.summary.pending = next.pending?.hash ?? null;
    this.summary.settled = next.recent[0] ?? null;
  }

  private async reconcile() {
    const pending = this.journal!.pending!;
    const executor = pending.executor ?? this.contract;
    const owner = pending.owner ?? this.owner;
    const resolution = await reconcileArbitrumIntent(this.client, pending, owner, executor);
    const journal = this.journal;
    if (!journal || journal.pending?.hash !== pending.hash || resolution.status === 'pending') return;
    const now = Date.now();
    const recent = journal.recent.filter((row) => row.at > now - dayMs);
    if (resolution.status !== 'receipt') {
      const replacementHash = resolution.status === 'replaced' ? resolution.replacementHash : undefined;
      this.save({ ...journal, pending: null, recent: [{
        hash: pending.hash, status: resolution.status, replacementHash, gasUsd: 0, netUsd: 0, at: now,
      }, ...recent] });
      return;
    }
    const { receipt } = resolution;
    const logs = receipt.logs.filter((log) => isAddressEqual(log.address, executor));
    const [event] = parseEventLogs({ abi: ARBITRUM_FLASH_ARB_ABI, eventName: 'Arbitrage', logs });
    const [funding] = parseEventLogs({ abi: ARBITRUM_FLASH_ARB_ABI, eventName: 'FundedBy', logs });
    const fee = receipt.gasUsed * receipt.effectiveGasPrice;
    const gasUsd = Number(formatEther(fee)) * pending.ethUsd;
    if (pending.path) {
      const path = pending.path;
      const [cycle] = parseEventLogs({ abi: ARBITRUM_FLASH_ARB_LOGIC_V2_ABI, eventName: 'PathArbitrage', logs });
      const transfers = parseEventLogs({ abi: transferAbi, eventName: 'Transfer',
        logs: receipt.logs.filter((log) => isAddressEqual(log.address, path.asset)) });
      const transferred = (from: Address, to: Address, amount: bigint) => transfers.some(({ args }) =>
        isAddressEqual(args.from, from) && isAddressEqual(args.to, to) && args.value === amount);
      const principal = BigInt(path.amount);
      const landed = receipt.status === 'success' && cycle && isAddressEqual(cycle.args.asset, path.asset)
        && isAddressEqual(cycle.args.recipient, owner) && cycle.args.hops === path.hops && cycle.args.amountIn === principal
        && cycle.args.profit > 0n && funding?.args.funding === 2 && funding.args.amount === principal && funding.args.premium === 0n
        && transferred(morpho, executor, principal) && transferred(executor, morpho, principal)
        && transferred(executor, owner, cycle.args.profit);
      const gainUsd = landed ? Number(formatUnits(cycle.args.profit, path.decimals)) * path.assetUsd : 0;
      this.save({ ...journal, pending: null, recent: [{
        hash: pending.hash, status: landed ? 'landed' : receipt.status === 'success' ? 'unverified' : 'reverted', gasUsd,
        netUsd: gainUsd - gasUsd, loanUsd: landed ? Number(formatUnits(principal, path.decimals)) * path.assetUsd : undefined, at: now,
      }, ...recent] });
      return;
    }
    const landed = receipt.status === 'success' && event;
    const proceeds = landed ? event.args.profit - event.args.tip : 0n;
    this.save({ ...journal, pending: null, recent: [{
      hash: pending.hash, status: landed ? 'landed' : 'reverted', gasUsd,
      netUsd: Number(formatEther(proceeds - fee)) * pending.ethUsd, at: now,
      loanUsd: landed && funding ? Number(formatEther(funding.args.amount)) * pending.ethUsd : undefined,
    }, ...recent] });
  }
}
