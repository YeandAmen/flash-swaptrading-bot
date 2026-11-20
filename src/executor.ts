import fs from 'node:fs';
import path from 'node:path';
import {
  encodeFunctionData, formatEther, keccak256, maxUint256, parseAbi, parseEventLogs, parseGwei,
  type Address, type Hex, type TransactionReceipt,
} from 'viem';
import { sendRawTransaction } from 'viem/actions';
import type { PrivateKeyAccount } from 'viem/accounts';
import { ADDR, CONFIG, DATA_DIR, RISK } from './config.js';
import { erc20Abi, mevReadClient, MIN_PRIORITY_FEE_WEI, nextBaseFee, publicClient, sendClient, suggestTipWei, swapRouter02Abi } from './chain.js';
import { quoteExactIn } from './market.js';
import { syncDirectory, writeJson } from './persistence.js';

export interface SwapRequest {
  path: Hex;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  hops: number;
  slippageBps: number;
  gasPriceGwei: number; // base fee + tip, for paper cost estimates
  ethUsd: number;
  /** Called with the swap tx hash and deadline right BEFORE it is broadcast, so it can be journaled. */
  onSwapSigned?: (hash: Hex, deadline: number) => void;
  onApprovalSigned?: (hash: Hex) => void;
  canSend?: () => boolean;
}

export interface Fill {
  amountIn: bigint;
  amountOut: bigint;
  gasUsd: number;
  txHashes: Hex[];
  blockNumber?: bigint;
}

export interface Executor {
  kind: 'paper' | 'live';
  swap(r: SwapRequest, log: (m: string) => void): Promise<Fill>;
}

/** The swap may or may not have been mined (broadcast error or receipt timeout). Must be reconciled later. */
export class UncertainTxError extends Error {
  constructor(public hash: Hex, msg: string) {
    super(msg);
  }
}

export class LiveSendBlocked extends Error {
  constructor() { super('Live transaction canceled before broadcast'); }
}

export class DeploymentGasError extends Error {
  constructor(balance: bigint, minimum: bigint) {
    super(`Bot wallet has ${formatEther(balance)} ETH. Deployment needs at least ${formatEther(minimum)} ETH at current gas prices.`);
  }
}

function checkSendAllowed(canSend?: () => boolean) {
  if ((!CONFIG.allowLiveTrading && !CONFIG.forkMode) || (canSend && !canSend())) throw new LiveSendBlocked();
}

type Settlement = { status: 'receipt'; receipt: TransactionReceipt } | { status: 'dropped' } | { status: 'pending' };

interface WalletIntent {
  owner: Address;
  hash: Hex;
  nonce: number;
  signedAt: number;
}

const WALLET_INTENT = path.join(DATA_DIR, 'wallet-transaction.json');

function usesProtect() {
  return !CONFIG.forkMode && new URL(CONFIG.sendRpcUrl).hostname === 'rpc.flashbots.net';
}

/** Use the transaction hash and canonical receipt. Elapsed swap deadlines do not settle a nonce. */
export async function transactionSettlement(hash: Hex, checkProtect = true): Promise<Settlement> {
  const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => null);
  if (receipt) {
    if (CONFIG.forkMode) return { status: 'receipt', receipt };
    const head = await publicClient.getBlockNumber({ cacheTime: 0 }).catch(() => null);
    if (head === null || head < receipt.blockNumber + 2n) return { status: 'pending' };
    const canonical = await publicClient.getBlock({ blockNumber: receipt.blockNumber }).catch(() => null);
    return canonical?.hash === receipt.blockHash ? { status: 'receipt', receipt } : { status: 'pending' };
  }
  if (checkProtect && usesProtect()) {
    const status = await flashbotsStatus(hash);
    if (status === 'FAILED' || status === 'CANCELLED') return { status: 'dropped' };
  }
  return { status: 'pending' };
}

/** USD cost of `units` gas at an effective gas price (base fee + tip). */
export function gasUsd(units: number, gasPriceGwei: number, ethUsd: number): number {
  return units * gasPriceGwei * 1e-9 * ethUsd;
}

export function swapGasUnits(hops: number, withApproval: boolean): number {
  return (hops === 1 ? RISK.gasUnits.swap1Hop : RISK.gasUnits.swap2Hop) + (withApproval ? RISK.gasUnits.approve : 0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => ((e as Error)?.message ?? String(e)).split('\n')[0].slice(0, 200);

/** Paper trading: real on-chain quotes (fees + price impact) and real gas prices, no transactions. */
export class PaperExecutor implements Executor {
  kind = 'paper' as const;
  async swap(r: SwapRequest): Promise<Fill> {
    const q = await quoteExactIn(r.path, r.amountIn);
    const approveNeeded = RISK.approvalMode === 'exact';
    return {
      amountIn: r.amountIn,
      amountOut: q.amountOut,
      gasUsd: gasUsd(swapGasUnits(r.hops, approveNeeded), r.gasPriceGwei, r.ethUsd),
      txHashes: [],
    };
  }
}

const transferEvent = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

const withdrawalEvent = parseAbi(['event Withdrawal(address indexed src, uint256 wad)']);
const ROUTER_ADDRESS_THIS: Address = '0x0000000000000000000000000000000000000002';

/** USDC spent and native ETH received by a mined gas top-up (swap to WETH + unwrap). */
export function topUpFromReceipt(receipt: TransactionReceipt, owner: Address) {
  const lc = (x: string) => x.toLowerCase();
  const transfers = parseEventLogs({ abi: transferEvent, logs: receipt.logs, eventName: 'Transfer' });
  const usdcIn = transfers
    .filter((l) => lc(l.address) === lc(ADDR.usdc) && lc(l.args.from) === lc(owner))
    .reduce((s, l) => s + l.args.value, 0n);
  const ethOut = parseEventLogs({ abi: withdrawalEvent, logs: receipt.logs, eventName: 'Withdrawal' })
    .filter((l) => lc(l.address) === lc(ADDR.weth) && lc(l.args.src) === lc(ADDR.swapRouter02))
    .reduce((s, l) => s + l.args.wad, 0n);
  return { usdcIn, ethOut, gasWei: receipt.gasUsed * receipt.effectiveGasPrice };
}

/** Exact token amounts moved by a mined swap, read from its Transfer logs. */
export function fillFromReceipt(receipt: TransactionReceipt, tokenIn: Address, tokenOut: Address, owner: Address) {
  const logs = parseEventLogs({ abi: transferEvent, logs: receipt.logs, eventName: 'Transfer' });
  const lc = (x: string) => x.toLowerCase();
  const amountOut = logs
    .filter((l) => lc(l.address) === lc(tokenOut) && lc(l.args.to) === lc(owner))
    .reduce((s, l) => s + l.args.value, 0n);
  const amountIn = logs
    .filter((l) => lc(l.address) === lc(tokenIn) && lc(l.args.from) === lc(owner))
    .reduce((s, l) => s + l.args.value, 0n);
  return { amountIn, amountOut, gasWei: receipt.gasUsed * receipt.effectiveGasPrice };
}

/** Live trading: approve (exact amount) -> fresh quote -> simulate -> sign -> private send -> confirm. */
export class LiveExecutor implements Executor {
  kind = 'live' as const;
  private nextNonce = 0;
  // Wallet operations queue as a unit, including their approvals. A bundle reserves the same writer.
  private bundleUntil = 0;
  private txActive = false;
  private txWaiting = 0;
  private tail: Promise<void> = Promise.resolve();
  constructor(private account: PrivateKeyAccount) {}

  get address(): Address {
    return this.account.address;
  }

  private readIntent(): WalletIntent | null {
    let raw: string;
    try { raw = fs.readFileSync(WALLET_INTENT, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const intent: WalletIntent = JSON.parse(raw);
    if (intent?.owner?.toLowerCase() !== this.address.toLowerCase() ||
        !/^0x[0-9a-f]{64}$/i.test(intent.hash) || !Number.isSafeInteger(intent.nonce) ||
        intent.nonce < 0 || !Number.isFinite(intent.signedAt)) {
      throw new Error('Wallet transaction journal is invalid or belongs to a different wallet');
    }
    return intent;
  }

  private clearIntent(intent: WalletIntent) {
    if (this.readIntent()?.hash !== intent.hash) return;
    fs.unlinkSync(WALLET_INTENT);
    syncDirectory(DATA_DIR);
  }

  private async recoverIntent(intent: WalletIntent): Promise<boolean> {
    const result = await transactionSettlement(intent.hash, Date.now() - intent.signedAt > 45_000);
    if (result.status === 'pending') return false;
    if (result.status === 'receipt') this.noteNonceUsed(intent.nonce);
    this.clearIntent(intent);
    return true;
  }

  async reconcileWallet(): Promise<boolean> {
    const intent = this.readIntent();
    return !intent || (!this.txActive && await this.recoverIntent(intent));
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    this.txWaiting++;
    try {
      await previous;
      const until = Date.now() + 25_000;
      while (Date.now() < this.bundleUntil && Date.now() < until) await sleep(CONFIG.forkMode ? 50 : 500);
      if (Date.now() < this.bundleUntil) throw new Error('Waiting for the outstanding MEV bundle to settle');
      this.txActive = true;
      const intent = this.readIntent();
      if (intent && !await this.recoverIntent(intent)) throw new UncertainTxError(intent.hash, 'An earlier wallet transaction is still settling');
      return await fn();
    } finally {
      this.txActive = false;
      this.txWaiting--;
      release();
    }
  }

  /** MEV: block normal transactions until `untilMs` so a bundle can use our next nonce. False if one is in progress. */
  reserveForBundle(untilMs: number): boolean {
    if (this.txActive || this.txWaiting > 0 || this.readIntent()) return false;
    this.bundleUntil = Math.max(this.bundleUntil, untilMs);
    return true;
  }

  releaseBundle() {
    this.bundleUntil = 0;
  }

  /** Next nonce for a bundle (a lagging RPC node may not know our last mined transaction yet). */
  async bundleNonce(): Promise<number> {
    const chainNonce = await this.chainNonce(mevReadClient);
    return Math.max(chainNonce, this.nextNonce);
  }

  noteNonceUsed(nonce: number) {
    this.nextNonce = Math.max(this.nextNonce, nonce + 1);
  }

  private async chainNonce(client = publicClient) {
    const [latest, pending] = await Promise.all([
      client.getTransactionCount({ address: this.address, blockTag: 'latest' }),
      client.getTransactionCount({ address: this.address, blockTag: 'pending' }),
    ]);
    if (pending > latest) throw new Error('Wallet has an external pending transaction');
    return latest;
  }

  private async estimateFees(data: Hex, to?: Address) {
    const [block, tip, estimatedGas] = await Promise.all([
      publicClient.getBlock({ blockTag: 'latest' }),
      suggestTipWei(),
      publicClient.estimateGas({ account: this.address, to, data }),
    ]);
    return { block, tip, estimatedGas, base: block.baseFeePerGas ?? parseGwei('1') };
  }

  async quoteDeployment(bytecode: Hex) {
    const [{ block, tip, estimatedGas, base }, balance] = await Promise.all([
      this.estimateFees(bytecode),
      publicClient.getBalance({ address: this.address, blockTag: 'latest' }),
    ]);
    const next = block.baseFeePerGas === null ? base : nextBaseFee(block);
    const gas = (estimatedGas * 105n + 99n) / 100n;
    const minimumFee = (next > base ? next : base) + MIN_PRIORITY_FEE_WEI;
    const minimumWei = gas * minimumFee;
    const standardCeiling = base * 2n + tip;
    const ceiling = standardCeiling > minimumFee ? standardCeiling : minimumFee;
    const affordableFee = balance / gas;
    const maxFeePerGas = affordableFee < ceiling ? affordableFee : ceiling;
    const maxPriorityFeePerGas = tip < maxFeePerGas ? tip : maxFeePerGas;
    const effectiveFee = maxFeePerGas < next + maxPriorityFeePerGas ? maxFeePerGas : next + maxPriorityFeePerGas;
    const estimatedWei = balance >= minimumWei ? estimatedGas * effectiveFee : null;
    return { balance, minimumWei, estimatedWei, gas, maxFeePerGas, maxPriorityFeePerGas };
  }

  private async transactionFees(to: Address | null, data: Hex) {
    if (to === null) {
      const quote = await this.quoteDeployment(data);
      if (quote.balance < quote.minimumWei) throw new DeploymentGasError(quote.balance, quote.minimumWei);
      return quote;
    }
    const { base, tip, estimatedGas } = await this.estimateFees(data, to);
    return { gas: (estimatedGas * 130n) / 100n, maxFeePerGas: base * 2n + tip, maxPriorityFeePerGas: tip };
  }

  /** Deploys a contract from the bot wallet (privately, like every transaction). */
  async deployContract(bytecode: Hex, log: (m: string) => void, onSigned?: (hash: Hex, nonce: number) => void, canSend?: () => boolean): Promise<{ address: Address; hash: Hex; gasWei: bigint }> {
    return this.exclusive(async () => {
      const { hash, receipt } = await this.sendTx(null, bytecode, 'deploy', log, onSigned, canSend);
      if (!receipt.contractAddress) throw new Error(`deploy ${hash} mined but created no contract`);
      return { address: receipt.contractAddress, hash, gasWei: receipt.gasUsed * receipt.effectiveGasPrice };
    });
  }

  /** Approve the router for exactly `amount` (resetting a partial allowance first). Returns gas spent in wei. */
  private async ensureAllowance(token: Address, amount: bigint, hashes: Hex[], log: (m: string) => void, onSigned?: (hash: Hex) => void, canSend?: () => boolean): Promise<bigint> {
    checkSendAllowed(canSend);
    const owner = this.account.address;
    let gasWei = 0n;
    const allowance = await publicClient.readContract({
      address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, ADDR.swapRouter02],
    });
    if (allowance === amount || (RISK.approvalMode === 'unlimited' && allowance >= amount)) return 0n;
    // Some tokens (e.g. LDO, USDT) refuse to change a non-zero allowance directly: reset to 0 first.
    if (allowance > 0n) {
      const zero = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ADDR.swapRouter02, 0n] });
      const z = await this.sendTx(token, zero, 'approve-reset', log, onSigned, canSend);
      hashes.push(z.hash);
      gasWei += z.receipt.gasUsed * z.receipt.effectiveGasPrice;
    }
    const value = RISK.approvalMode === 'unlimited' ? maxUint256 : amount;
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ADDR.swapRouter02, value] });
    const a = await this.sendTx(token, data, 'approve', log, onSigned, canSend);
    hashes.push(a.hash);
    gasWei += a.receipt.gasUsed * a.receipt.effectiveGasPrice;
    return gasWei;
  }

  /**
   * Gas top-up: swap `usdcIn` USDC -> WETH and unwrap to native ETH in one transaction.
   * Returns USDC spent and ETH received (read from the WETH Withdrawal event).
   */
  async topUpGas(usdcIn: bigint, path: Hex, slippageBps: number, ethUsd: number, onSigned: (hash: Hex, deadline: number) => void, log: (m: string) => void, onApprovalSigned?: (hash: Hex) => void, canSend?: () => boolean) {
    return this.exclusive(() => this.topUpGasNow(usdcIn, path, slippageBps, ethUsd, onSigned, log, onApprovalSigned, canSend));
  }

  private async topUpGasNow(usdcIn: bigint, path: Hex, slippageBps: number, ethUsd: number, onSigned: (hash: Hex, deadline: number) => void, log: (m: string) => void, onApprovalSigned?: (hash: Hex) => void, canSend?: () => boolean) {
    const owner = this.account.address;
    const hashes: Hex[] = [];
    let gasWei = await this.ensureAllowance(ADDR.usdc, usdcIn, hashes, log, onApprovalSigned, canSend);
    const q = await quoteExactIn(path, usdcIn);
    const minOut = (q.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const swap = encodeFunctionData({
      abi: swapRouter02Abi, functionName: 'exactInput',
      args: [{ path, recipient: ROUTER_ADDRESS_THIS, amountIn: usdcIn, amountOutMinimum: minOut }],
    });
    const unwrap = encodeFunctionData({ abi: swapRouter02Abi, functionName: 'unwrapWETH9', args: [minOut, owner] });
    const data = encodeFunctionData({ abi: swapRouter02Abi, functionName: 'multicall', args: [BigInt(deadline), [swap, unwrap]] });
    const { hash, receipt } = await this.sendTx(ADDR.swapRouter02, data, 'gas-topup', log, (h) => onSigned(h, deadline), canSend);
    hashes.push(hash);
    const t = topUpFromReceipt(receipt, owner);
    gasWei += t.gasWei;
    if (t.ethOut === 0n || t.usdcIn === 0n) throw new Error(`gas top-up ${hash} mined but receipt amounts could not be verified`);
    return { usdcIn: t.usdcIn, ethOut: t.ethOut, gasUsd: (Number(gasWei) / 1e18) * ethUsd, txHashes: hashes, blockNumber: receipt.blockNumber };
  }

  async swap(r: SwapRequest, log: (m: string) => void): Promise<Fill> {
    return this.exclusive(() => this.swapNow(r, log));
  }

  private async swapNow(r: SwapRequest, log: (m: string) => void): Promise<Fill> {
    const owner = this.account.address;
    const hashes: Hex[] = [];
    let gasWei = await this.ensureAllowance(r.tokenIn, r.amountIn, hashes, log, r.onApprovalSigned, r.canSend);

    const q = await quoteExactIn(r.path, r.amountIn);
    const minOut = (q.amountOut * BigInt(10_000 - r.slippageBps)) / 10_000n;
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const inner = encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: 'exactInput',
      args: [{ path: r.path, recipient: owner, amountIn: r.amountIn, amountOutMinimum: minOut }],
    });
    const data = encodeFunctionData({ abi: swapRouter02Abi, functionName: 'multicall', args: [BigInt(deadline), [inner]] });
    const { hash, receipt } = await this.sendTx(ADDR.swapRouter02, data, 'swap', log, (h) => r.onSwapSigned?.(h, deadline), r.canSend);
    hashes.push(hash);
    const f = fillFromReceipt(receipt, r.tokenIn, r.tokenOut, owner);
    gasWei += f.gasWei;
    if (f.amountOut === 0n || f.amountIn === 0n) throw new Error(`swap ${hash} mined but receipt amounts could not be verified`);

    return { amountIn: f.amountIn, amountOut: f.amountOut, gasUsd: (Number(gasWei) / 1e18) * r.ethUsd, txHashes: hashes, blockNumber: receipt.blockNumber };
  }

  /** `to: null` deploys a contract (`data` = creation code). */
  private async sendTx(to: Address | null, data: Hex, label: string, log: (m: string) => void, onSigned?: (hash: Hex, nonce: number) => void, canSend?: () => boolean) {
    checkSendAllowed(canSend);
    const from = this.account.address;
    const [chainNonce, { gas, maxFeePerGas, maxPriorityFeePerGas }] = await Promise.all([
      this.chainNonce(),
      this.transactionFees(to, data),
    ]);
    // a lagging RPC node may not know our previous tx yet: never reuse a nonce we already got mined
    const nonce = Math.max(chainNonce, this.nextNonce);
    checkSendAllowed(canSend);
    const serializedTransaction = await this.account.signTransaction({
      chainId: publicClient.chain.id, type: 'eip1559', to, data, nonce, gas, maxFeePerGas, maxPriorityFeePerGas, value: 0n,
    });
    checkSendAllowed(canSend);
    const hash = keccak256(serializedTransaction);
    const intent = { owner: from, hash, nonce, signedAt: Date.now() };
    writeJson(WALLET_INTENT, intent, true);
    try {
      onSigned?.(hash, nonce);
      checkSendAllowed(canSend);
    } catch (error) {
      this.clearIntent(intent);
      throw error;
    }

    let sendErr: unknown = null;
    try {
      await sendRawTransaction(sendClient, { serializedTransaction });
      log(`${label} tx sent ${hash}`);
    } catch (e) {
      sendErr = e;
      log(`${label} broadcast error (${errMsg(e)}) — checking whether it landed anyway`);
    }

    const result = await this.waitSettlement(intent, sendErr ? 90_000 : 6 * 60_000);
    if (result.status === 'pending') throw new UncertainTxError(hash, `${label} outcome unknown (${sendErr ? 'broadcast error' : 'receipt timeout'}): ${hash}`);
    if (result.status === 'receipt') this.noteNonceUsed(nonce);
    this.clearIntent(intent);
    if (result.status === 'dropped') throw new Error(`Flashbots dropped ${label} transaction ${hash}`);
    const { receipt } = result;
    if (receipt.status !== 'success') throw new Error(`${label} tx reverted: ${hash}`);
    log(`${label} confirmed in block ${receipt.blockNumber}`);
    return { hash, receipt };
  }

  private async waitSettlement(intent: WalletIntent, timeoutMs: number): Promise<Settlement> {
    let lastStatusCheck = 0;
    while (Date.now() - intent.signedAt < timeoutMs) {
      const now = Date.now();
      const checkProtect = now - intent.signedAt > 45_000 && now - lastStatusCheck > 30_000;
      if (checkProtect) lastStatusCheck = now;
      const result = await transactionSettlement(intent.hash, checkProtect);
      if (result.status !== 'pending') return result;
      await sleep(CONFIG.forkMode ? 300 : 3_000);
    }
    return { status: 'pending' };
  }
}

export async function flashbotsStatus(hash: Hex): Promise<string | null> {
  try {
    const res = await fetch(`https://protect.flashbots.net/tx/${hash}`, { signal: AbortSignal.timeout(10_000) });
    const j = (await res.json()) as { status?: string };
    return j.status ?? null;
  } catch {
    return null;
  }
}
