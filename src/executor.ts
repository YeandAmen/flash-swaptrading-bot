import {
  encodeFunctionData, keccak256, maxUint256, parseAbi, parseEventLogs, parseGwei,
  type Address, type Hex, type TransactionReceipt,
} from 'viem';
import { sendRawTransaction } from 'viem/actions';
import type { PrivateKeyAccount } from 'viem/accounts';
import { ADDR, CONFIG, RISK } from './config.js';
import { erc20Abi, publicClient, sendClient, suggestTipWei, swapRouter02Abi } from './chain.js';
import { quoteExactIn } from './market.js';

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
  constructor(private account: PrivateKeyAccount) {}

  get address(): Address {
    return this.account.address;
  }

  /** Approve the router for exactly `amount` (resetting a partial allowance first). Returns gas spent in wei. */
  private async ensureAllowance(token: Address, amount: bigint, hashes: Hex[], log: (m: string) => void): Promise<bigint> {
    const owner = this.account.address;
    let gasWei = 0n;
    const allowance = await publicClient.readContract({
      address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, ADDR.swapRouter02],
    });
    if (allowance >= amount) return 0n;
    // Some tokens (e.g. LDO, USDT) refuse to change a non-zero allowance directly: reset to 0 first.
    if (allowance > 0n) {
      const zero = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ADDR.swapRouter02, 0n] });
      const z = await this.sendTx(token, zero, 'approve-reset', log);
      hashes.push(z.hash);
      gasWei += z.receipt.gasUsed * z.receipt.effectiveGasPrice;
    }
    const value = RISK.approvalMode === 'unlimited' ? maxUint256 : amount;
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ADDR.swapRouter02, value] });
    const a = await this.sendTx(token, data, 'approve', log);
    hashes.push(a.hash);
    gasWei += a.receipt.gasUsed * a.receipt.effectiveGasPrice;
    return gasWei;
  }

  /**
   * Gas top-up: swap `usdcIn` USDC -> WETH and unwrap to native ETH in one transaction.
   * Returns USDC spent and ETH received (read from the WETH Withdrawal event).
   */
  async topUpGas(usdcIn: bigint, path: Hex, slippageBps: number, ethUsd: number, onSigned: (hash: Hex, deadline: number) => void, log: (m: string) => void) {
    const owner = this.account.address;
    const hashes: Hex[] = [];
    let gasWei = await this.ensureAllowance(ADDR.usdc, usdcIn, hashes, log);
    const q = await quoteExactIn(path, usdcIn);
    const minOut = (q.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const swap = encodeFunctionData({
      abi: swapRouter02Abi, functionName: 'exactInput',
      args: [{ path, recipient: ROUTER_ADDRESS_THIS, amountIn: usdcIn, amountOutMinimum: minOut }],
    });
    const unwrap = encodeFunctionData({ abi: swapRouter02Abi, functionName: 'unwrapWETH9', args: [minOut, owner] });
    const data = encodeFunctionData({ abi: swapRouter02Abi, functionName: 'multicall', args: [BigInt(deadline), [swap, unwrap]] });
    const { hash, receipt } = await this.sendTx(ADDR.swapRouter02, data, 'gas-topup', log, (h) => onSigned(h, deadline));
    hashes.push(hash);
    const t = topUpFromReceipt(receipt, owner);
    gasWei += t.gasWei;
    if (t.ethOut === 0n) throw new Error(`gas top-up ${hash} mined but no ETH was unwrapped`);
    return { usdcIn: t.usdcIn, ethOut: t.ethOut, gasUsd: (Number(gasWei) / 1e18) * ethUsd, txHashes: hashes, blockNumber: receipt.blockNumber };
  }

  async swap(r: SwapRequest, log: (m: string) => void): Promise<Fill> {
    const owner = this.account.address;
    const hashes: Hex[] = [];
    let gasWei = await this.ensureAllowance(r.tokenIn, r.amountIn, hashes, log);

    const q = await quoteExactIn(r.path, r.amountIn);
    const minOut = (q.amountOut * BigInt(10_000 - r.slippageBps)) / 10_000n;
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const inner = encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: 'exactInput',
      args: [{ path: r.path, recipient: owner, amountIn: r.amountIn, amountOutMinimum: minOut }],
    });
    const data = encodeFunctionData({ abi: swapRouter02Abi, functionName: 'multicall', args: [BigInt(deadline), [inner]] });
    const { hash, receipt } = await this.sendTx(ADDR.swapRouter02, data, 'swap', log, (h) => r.onSwapSigned?.(h, deadline));
    hashes.push(hash);
    const f = fillFromReceipt(receipt, r.tokenIn, r.tokenOut, owner);
    gasWei += f.gasWei;
    if (f.amountOut === 0n) throw new Error(`swap ${hash} mined but no output transfer found`);

    return { amountIn: f.amountIn, amountOut: f.amountOut, gasUsd: (Number(gasWei) / 1e18) * r.ethUsd, txHashes: hashes, blockNumber: receipt.blockNumber };
  }

  private async sendTx(to: Address, data: Hex, label: string, log: (m: string) => void, onSigned?: (hash: Hex) => void) {
    const from = this.account.address;
    const [chainNonce, block, maxPriorityFeePerGas] = await Promise.all([
      publicClient.getTransactionCount({ address: from, blockTag: 'latest' }),
      publicClient.getBlock({ blockTag: 'latest' }),
      suggestTipWei(),
    ]);
    // a lagging RPC node may not know our previous tx yet: never reuse a nonce we already got mined
    const nonce = Math.max(chainNonce, this.nextNonce);
    const baseFee = block.baseFeePerGas ?? parseGwei('1');
    const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;
    // estimateGas executes the tx against current state: it throws (and we abort) if it would revert.
    const gasEst = await publicClient.estimateGas({ account: from, to, data });
    const gas = (gasEst * 130n) / 100n;
    const serializedTransaction = await this.account.signTransaction({
      chainId: publicClient.chain.id, type: 'eip1559', to, data, nonce, gas, maxFeePerGas, maxPriorityFeePerGas, value: 0n,
    });
    const hash = keccak256(serializedTransaction);
    onSigned?.(hash);

    let sendErr: unknown = null;
    try {
      await sendRawTransaction(sendClient, { serializedTransaction });
      log(`${label} tx sent ${hash}`);
    } catch (e) {
      sendErr = e;
      log(`${label} broadcast error (${errMsg(e)}) — checking whether it landed anyway`);
    }

    let receipt: TransactionReceipt;
    try {
      receipt = await this.waitReceipt(hash, sendErr ? 90_000 : 6 * 60_000);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Flashbots reports')) throw e; // definitively dropped
      const rejected = /nonce too low|insufficient funds|intrinsic gas|underpriced|fee cap|less than block base fee|invalid sender|exceeds block gas limit/i;
      if (sendErr && rejected.test(errMsg(sendErr) + ' ' + String((sendErr as { details?: string }).details ?? ''))) {
        throw new Error(`${label} rejected by RPC: ${errMsg(sendErr)}`); // node refused it: nothing was broadcast
      }
      throw new UncertainTxError(hash, `${label} outcome unknown (${sendErr ? 'broadcast error' : 'not mined in time'}): ${hash}`);
    }
    this.nextNonce = nonce + 1;
    if (receipt.status !== 'success') throw new Error(`${label} tx reverted: ${hash}`);
    log(`${label} confirmed in block ${receipt.blockNumber}`);
    await this.waitForNode(receipt.blockNumber);
    return { hash, receipt };
  }

  /** Wait until our read RPC has caught up to `bn`, so follow-up reads/simulations see the new state. */
  private async waitForNode(bn: bigint) {
    for (let i = 0; i < 20; i++) {
      try {
        if ((await publicClient.getBlockNumber({ cacheTime: 0 })) >= bn) return;
      } catch { /* retry */ }
      await sleep(CONFIG.forkMode ? 100 : 1_500);
    }
  }

  private async waitReceipt(hash: Hex, timeoutMs: number): Promise<TransactionReceipt> {
    const start = Date.now();
    let lastStatusCheck = 0;
    const usesFlashbots = CONFIG.sendRpcUrl.includes('flashbots') && !CONFIG.forkMode;
    while (Date.now() - start < timeoutMs) {
      try {
        return await publicClient.getTransactionReceipt({ hash });
      } catch { /* not mined yet */ }
      if (usesFlashbots && Date.now() - start > 45_000 && Date.now() - lastStatusCheck > 30_000) {
        lastStatusCheck = Date.now();
        const status = await flashbotsStatus(hash);
        if (status === 'FAILED' || status === 'CANCELLED') throw new Error(`Flashbots reports tx ${status}: ${hash}`);
      }
      await sleep(CONFIG.forkMode ? 300 : 3_000);
    }
    throw new Error(`tx not mined within ${Math.round(timeoutMs / 1000)}s: ${hash}`);
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
