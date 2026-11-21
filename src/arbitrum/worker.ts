import fs from 'node:fs';
import path from 'node:path';
import { formatEther, isAddress, isAddressEqual, keccak256, parseEther, parseEventLogs, type Address, type Hash, type Hex } from 'viem';
import { CONFIG, DATA_DIR } from '../config.js';
import { activeFlashTest, flashTestView, queueFlashTest, type FlashTest, type FlashTestOptions } from '../network-test.js';
import { NetworkActivity } from '../network-activity.js';
import { writeJson } from '../persistence.js';
import { loadOrCreateWallet } from '../wallet.js';
import { ARBITRUM_FLASH_ARB_ABI } from './artifact.js';
import { verifyArbitrumExecutor, type ArbitrumExecutor } from './proxy.js';
import { prepareArbitrumOrder, type ArbitrumOrderRejection } from './execution.js';
import { arbitrumTestLeads } from './test-leads.js';
import { arbitrumChainId, arbitrumClient, arbitrumEthUsd, discoverArbitrumPools, scanArbitrum, type ArbQuote } from './market.js';

const journalFile = path.join(DATA_DIR, 'arbitrum-trades.json');
const haltedFile = path.join(DATA_DIR, 'arbitrum-disarmed.json');
const dayMs = 86400_000;
const txLimitUsd = 0.50;
const dailyLimitUsd = 2;
const minNetUsd = 0.05;
const extraLoanSizes = ['0.01', '0.1', '0.5', '2', '8'].flatMap((size) => [undefined, parseEther(size)]);
const preparationStatus: Record<ArbitrumOrderRejection, string> = {
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
type Pending = { hash: Hash; nonce: number; ethUsd: number; budgetUsd: number };
type Settlement = { hash: Hash; status: 'landed' | 'reverted' | 'replaced'; gasUsd: number; netUsd: number; at: number; loanUsd?: number };
type Journal = { pending: Pending | null; recent: Settlement[]; test?: FlashTest };

export class ArbitrumWorker {
  private readonly client = arbitrumClient(process.env.ARBITRUM_RPC_URL);
  private readonly executionEnabled = process.env.ARBITRUM_LIVE === 'on' && CONFIG.allowLiveTrading;
  private markets: Awaited<ReturnType<typeof discoverArbitrumPools>> = [];
  private refreshAfter = 0;
  private regularScans = 0;
  private verified = false;
  private executorCheckAt = 0;
  private journal: Journal | null = null;
  private active = false;
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
    preparationRejections: {} as Partial<Record<ArbitrumOrderRejection, number>>,
    executor: isAddress(this.contract) ? this.contract : null,
    balanceEth: null as string | null, pending: null as Hash | null, settled: null as Settlement | null,
  };

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

  stop() { this.active = false; }

  disarm() {
    if (!this.enabled || !this.executionEnabled) return;
    this.halted = true;
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

  async scan() {
    this.active = true;
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
        if (await this.tryOrders(leads, ethUsd, test)) return;
      }
    }
    const extraSize = test ? undefined : extraLoanSizes[this.regularScans++ % extraLoanSizes.length];
    const result = await scanArbitrum(this.client, block, this.markets,
      test?.minimumNetUsd !== undefined ? test.minimumLoanUsd ?? 0 : !!test, extraSize);
    if (test) test.checked += result.quotedRoutes;
    this.summary.block = Number(block);
    this.summary.pools = this.markets.reduce((sum, market) => sum + market.pools.length, 0);
    this.summary.routes = result.quotedRoutes;
    this.summary.updatedAt = Date.now();
    this.activity.recordScan(result.quotedRoutes, this.summary.updatedAt);
    if (this.journal?.pending) this.summary.status = 'Waiting for transaction receipt';
    else if (!result.best) this.summary.status = 'No positive payout after loan fees';
    else if (!this.summary.executor) this.summary.status = 'Flash payout quoted. Deploy executor to check full fees';
    else {
      this.summary.status = 'No fresh route passed padded gas and payout floor';
      await this.tryOrders(result.opportunities.slice(0, 3), result.ethUsd, test);
    }
    this.activity.record('info', `Block ${block}: ${result.quotedRoutes} routes across ${this.summary.pools} pools. ${this.summary.status}.`, undefined, this.summary.updatedAt);
  }

  private async tryOrders(candidates: ArbQuote[], ethUsd: number, test: FlashTest | null): Promise<boolean> {
    const canTest = () => !test || (this.journal?.test === test && activeFlashTest(test));
    const available = this.journal ? Math.min(txLimitUsd, dailyLimitUsd
      - this.journal.recent.filter((row) => row.at > Date.now() - dayMs).reduce((sum, row) => sum + row.gasUsd, 0)) : txLimitUsd;
    let firstRejection: ArbitrumOrderRejection | undefined;
    let reachedLiveChecks = false;
    for (const candidate of candidates) {
      this.summary.simulated += 1;
      const prepared = await prepareArbitrumOrder(this.client, this.contract, this.owner, candidate, ethUsd, Math.max(minNetUsd, test?.minimumNetUsd ?? 0), available,
        !!test && test.minimumNetUsd === undefined, this.deployment.releaseHash ?? undefined);
      if (!prepared.ok) {
        firstRejection ??= prepared.reason;
        const counts = this.summary.preparationRejections;
        counts[prepared.reason] = (counts[prepared.reason] ?? 0) + 1;
        continue;
      }
      if (test?.minimumLoanUsd !== undefined && Number(formatEther(candidate.order.amountIn)) * ethUsd < test.minimumLoanUsd) continue;
      this.summary.netEstimateUsd = prepared.netUsd;
      this.summary.status = test ? 'Test route passed repayment and gas checks' : 'Executable quote passed profit and gas checks';
      if (this.summary.mode !== 'live' || !this.active || !this.journal || !this.deployment.verified || !canTest()) return true;
      reachedLiveChecks = true;
      const { account } = loadOrCreateWallet();
      if (!isAddressEqual(account.address, this.owner)) throw new Error('Wallet does not match the Arbitrum executor owner');
      const [nonce, pending, balance, head] = await Promise.all([
        this.client.getTransactionCount({ address: account.address }),
        this.client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
        this.client.getBalance({ address: account.address }),
        this.client.getBlockNumber({ cacheTime: 0 }),
      ]);
      if (!this.active || this.halted || !canTest()) return true;
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
      if (!this.active || this.halted || !canTest()) return true;
      const hash = keccak256(serializedTransaction);
      this.save({ ...this.journal, pending: { hash, nonce, ethUsd, budgetUsd: prepared.worstGasUsd },
        ...(test ? { test: { ...test, status: 'submitted', hash, note: 'Waiting for the Arbitrum receipt.' } } : {}),
      });
      this.summary.status = 'Waiting for transaction receipt';
      this.activity.record('info', test ? 'Mainnet test submitted' : 'Arbitrum route submitted', `https://arbiscan.io/tx/${hash}`);
      await this.client.sendRawTransaction({ serializedTransaction });
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
    this.activity.record(outcome.status === 'landed' ? 'trade' : 'warn',
      `Arbitrum transaction ${outcome.status}. Gas $${outcome.gasUsd.toFixed(4)}, net $${outcome.netUsd.toFixed(4)}.`,
      `https://arbiscan.io/tx/${outcome.hash}`, outcome.at);
  }

  private save(next: Journal) {
    const outcome = next.recent[0];
    if (outcome && next.test?.status === 'submitted' && next.test.hash === outcome.hash) {
      const meetsProfit = next.test.minimumNetUsd === undefined || outcome.netUsd >= next.test.minimumNetUsd;
      const meetsLoan = next.test.minimumLoanUsd === undefined || (outcome.loanUsd ?? 0) >= next.test.minimumLoanUsd;
      const passed = outcome.status === 'landed' && meetsProfit && meetsLoan;
      const belowFloor = outcome.status === 'landed' && !passed ? ' The receipt did not meet the requested loan or profit floor.' : '';
      next = { ...next, test: { ...next.test, status: passed ? 'landed' : 'failed',
        note: `Confirmed ${outcome.status}. Gas $${outcome.gasUsd.toFixed(4)}, net $${outcome.netUsd.toFixed(4)}.${belowFloor}` } };
    }
    writeJson(journalFile, next);
    if (outcome && this.journal?.recent[0]?.hash !== outcome.hash) this.logSettlement(outcome);
    this.journal = next;
    this.summary.pending = next.pending?.hash ?? null;
    this.summary.settled = next.recent[0] ?? null;
  }

  private async reconcile() {
    const journal = this.journal!;
    const pending = journal.pending!;
    const receipt = await this.client.getTransactionReceipt({ hash: pending.hash }).catch(() => null);
    if (!receipt) {
      const nonce = await this.client.getTransactionCount({ address: this.owner });
      if (nonce <= pending.nonce) return;
      this.save({ ...journal, pending: null, recent: [{
        hash: pending.hash, status: 'replaced', gasUsd: pending.budgetUsd, netUsd: 0, at: Date.now(),
      }, ...journal.recent.filter((row) => row.at > Date.now() - dayMs)] });
      return;
    }
    const logs = receipt.logs.filter((log) => isAddressEqual(log.address, this.contract));
    const [event] = parseEventLogs({ abi: ARBITRUM_FLASH_ARB_ABI, eventName: 'Arbitrage', logs });
    const [funding] = parseEventLogs({ abi: ARBITRUM_FLASH_ARB_ABI, eventName: 'FundedBy', logs });
    const fee = receipt.gasUsed * receipt.effectiveGasPrice;
    const landed = receipt.status === 'success' && event;
    const proceeds = landed ? event.args.profit - event.args.tip : 0n;
    this.save({ ...journal, pending: null, recent: [{
      hash: pending.hash, status: landed ? 'landed' : 'reverted', gasUsd: Number(formatEther(fee)) * pending.ethUsd,
      netUsd: Number(formatEther(proceeds - fee)) * pending.ethUsd, at: Date.now(),
      loanUsd: landed && funding ? Number(formatEther(funding.args.amount)) * pending.ethUsd : undefined,
    }, ...journal.recent.filter((row) => row.at > Date.now() - dayMs)] });
  }
}
