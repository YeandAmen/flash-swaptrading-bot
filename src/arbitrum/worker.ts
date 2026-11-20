import fs from 'node:fs';
import path from 'node:path';
import { formatEther, isAddress, isAddressEqual, keccak256, parseEventLogs, type Address, type Hash } from 'viem';
import { CONFIG, DATA_DIR } from '../config.js';
import { writeJson } from '../persistence.js';
import { loadOrCreateWallet } from '../wallet.js';
import { ARBITRUM_FLASH_ARB_ABI } from './artifact.js';
import { verifyArbitrumExecutor } from './deployment.js';
import { prepareArbitrumOrder } from './execution.js';
import { arbitrumChainId, arbitrumClient, discoverArbitrumPools, scanArbitrum } from './market.js';

const journalFile = path.join(DATA_DIR, 'arbitrum-trades.json');
const haltedFile = path.join(DATA_DIR, 'arbitrum-disarmed.json');
const dayMs = 86400_000;
const txLimitUsd = 0.50;
const dailyLimitUsd = 2;
const minNetUsd = 0.05;
type Pending = { hash: Hash; nonce: number; ethUsd: number; budgetUsd: number };
type Settlement = { hash: Hash; status: 'landed' | 'reverted' | 'replaced'; gasUsd: number; netUsd: number; at: number };
type Journal = { pending: Pending | null; recent: Settlement[] };

export class ArbitrumWorker {
  private readonly client = arbitrumClient(process.env.ARBITRUM_RPC_URL);
  private readonly executionEnabled = process.env.ARBITRUM_LIVE === 'on' && CONFIG.allowLiveTrading;
  private markets: Awaited<ReturnType<typeof discoverArbitrumPools>> = [];
  private refreshAfter = 0;
  private verified = false;
  private journal: Journal | null = null;
  private active = false;
  private halted = fs.existsSync(haltedFile);
  readonly contract = (process.env.ARBITRUM_EXECUTOR_ADDRESS ?? '') as Address;
  readonly owner = (process.env.ARBITRUM_OWNER_ADDRESS ?? '') as Address;
  readonly enabled = process.env.ARBITRUM === 'on' && !CONFIG.forkMode;

  summary = {
    mode: (this.enabled ? 'paper' : 'off') as 'off' | 'paper' | 'live',
    canArm: this.enabled && this.executionEnabled,
    status: this.enabled ? 'Starting' : 'Disabled',
    block: 0, pools: 0, routes: 0, simulated: 0, updatedAt: 0, netEstimateUsd: null as number | null,
    executor: isAddress(this.contract) ? this.contract : null,
    balanceEth: null as string | null, pending: null as Hash | null, settled: null as Settlement | null,
  };

  stop() { this.active = false; }

  disarm() {
    if (!this.enabled || !this.executionEnabled) return;
    this.halted = true;
    this.summary.mode = 'paper';
    writeJson(haltedFile, true);
  }

  arm() {
    if (!this.enabled || !this.executionEnabled || !this.verified) throw new Error('Arbitrum live execution is unavailable');
    fs.rmSync(haltedFile, { force: true });
    this.halted = false;
    this.summary.mode = 'live';
  }

  async scan() {
    this.active = true;
    if (!this.verified) {
      if (await this.client.getChainId() !== arbitrumChainId) throw new Error('RPC must report Arbitrum One');
      if (this.summary.executor) await verifyArbitrumExecutor(this.client, this.contract, this.owner);
      else if (this.executionEnabled) throw new Error('Configure a verified Arbitrum executor before enabling live');
      if (this.executionEnabled) this.openJournal();
      this.verified = true;
      if (this.executionEnabled && !this.halted) this.summary.mode = 'live';
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
    const result = await scanArbitrum(this.client, block, this.markets);
    this.summary.block = Number(block);
    this.summary.pools = this.markets.reduce((sum, market) => sum + market.pools.length, 0);
    this.summary.routes = result.quotedRoutes;
    this.summary.simulated = 0;
    this.summary.netEstimateUsd = null;
    this.summary.updatedAt = Date.now();
    this.summary.status = result.best ? 'Comparing exact payout and fees' : 'No positive payout after loan fees';
    if (!this.summary.executor || !result.best || this.journal?.pending) {
      if (this.journal?.pending) this.summary.status = 'Waiting for transaction receipt';
      else if (result.best) this.summary.status = 'Flash payout quoted. Deploy executor to check full fees.';
      return;
    }
    const available = this.journal ? Math.min(txLimitUsd, dailyLimitUsd
      - this.journal.recent.filter((row) => row.at > Date.now() - dayMs).reduce((sum, row) => sum + row.gasUsd, 0)) : txLimitUsd;
    for (const candidate of result.opportunities.slice(0, 3)) {
      this.summary.simulated += 1;
      const prepared = await prepareArbitrumOrder(this.client, this.contract, this.owner, candidate, result.ethUsd, minNetUsd, available)
        .catch(() => null);
      if (!prepared) continue;
      this.summary.netEstimateUsd = prepared.netUsd;
      this.summary.status = 'Executable quote passed profit and gas checks';
      if (this.summary.mode !== 'live' || !this.active || !this.journal) return;
      const { account } = loadOrCreateWallet();
      if (!isAddressEqual(account.address, this.owner)) throw new Error('Wallet does not match the Arbitrum executor owner');
      const [nonce, pending, balance, head] = await Promise.all([
        this.client.getTransactionCount({ address: account.address }),
        this.client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
        this.client.getBalance({ address: account.address }),
        this.client.getBlockNumber({ cacheTime: 0 }),
      ]);
      if (nonce !== pending || balance < prepared.gasBudget || head >= prepared.deadline || !this.active || this.halted) return;
      const serializedTransaction = await account.signTransaction({ ...prepared.tx, type: 'eip1559', chainId: arbitrumChainId, nonce });
      if (!this.active || this.halted) return;
      const hash = keccak256(serializedTransaction);
      this.save({ ...this.journal, pending: { hash, nonce, ethUsd: result.ethUsd, budgetUsd: prepared.worstGasUsd } });
      this.summary.status = 'Waiting for transaction receipt';
      await this.client.sendRawTransaction({ serializedTransaction });
      return;
    }
    this.summary.status = available > 0 ? 'No fresh route passed padded gas and payout floor' : 'Daily gas budget used';
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
  }

  private save(next: Journal) {
    writeJson(journalFile, next);
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
      this.save({ pending: null, recent: [{
        hash: pending.hash, status: 'replaced', gasUsd: pending.budgetUsd, netUsd: 0, at: Date.now(),
      }, ...journal.recent.filter((row) => row.at > Date.now() - dayMs)] });
      return;
    }
    const [event] = parseEventLogs({
      abi: ARBITRUM_FLASH_ARB_ABI, eventName: 'Arbitrage',
      logs: receipt.logs.filter((log) => isAddressEqual(log.address, this.contract)),
    });
    const fee = receipt.gasUsed * receipt.effectiveGasPrice;
    const landed = receipt.status === 'success' && event;
    const proceeds = landed ? event.args.profit - event.args.tip : 0n;
    this.save({ pending: null, recent: [{
      hash: pending.hash, status: landed ? 'landed' : 'reverted', gasUsd: Number(formatEther(fee)) * pending.ethUsd,
      netUsd: Number(formatEther(proceeds - fee)) * pending.ethUsd, at: Date.now(),
    }, ...journal.recent.filter((row) => row.at > Date.now() - dayMs)] });
  }
}
