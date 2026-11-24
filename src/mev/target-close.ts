import { BaseError, numberToHex, RpcRequestError, type Address, type Hex } from 'viem';
import { mevPoolClient } from '../chain.js';
import { knownArbitrageRevert } from './private-status.js';

/** Ephemeral call parameters. Both supported executor entry points return one uint256 in WETH wei. */
export interface TargetCloseCall {
  from: Address;
  to: Address;
  data: Hex;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  minimumProfit: bigint;
}

export interface TargetCloseReplay {
  block: number;
  blockHash?: Hex;
  status: 'usable' | 'reverted' | 'fee-cap-below-base' | 'unavailable';
  grossProfitWei?: string;
  reason?: string;
}

/** Read once at the canonical target close. Never substitute latest or resubmit the order. */
export async function readTargetClose(block: number, call: TargetCloseCall): Promise<TargetCloseReplay> {
  const report: TargetCloseReplay = { block, status: 'unavailable' };
  const options = { retryCount: 0, signal: AbortSignal.timeout(3_500) };
  try {
    const height = numberToHex(block);
    const header = await mevPoolClient.request({ method: 'eth_getBlockByNumber', params: [height, false] }, options);
    if (!header || header.number !== height || !header.hash || !/^0x[0-9a-f]{64}$/i.test(header.hash)
      || !header.baseFeePerGas || !/^0x[0-9a-f]{1,64}$/i.test(header.baseFeePerGas)) return report;
    report.blockHash = header.hash;
    if (BigInt(header.baseFeePerGas) > call.maxFeePerGas) return { ...report, status: 'fee-cap-below-base' };
    const payout = await mevPoolClient.request({ method: 'eth_call', params: [{
      from: call.from, to: call.to, data: call.data, value: '0x0', gas: numberToHex(call.gas),
      maxFeePerGas: numberToHex(call.maxFeePerGas), maxPriorityFeePerGas: numberToHex(call.maxPriorityFeePerGas),
    }, { blockHash: header.hash, requireCanonical: true }] }, options);
    if (typeof payout !== 'string' || !/^0x[0-9a-f]{64}$/i.test(payout) || BigInt(payout) < call.minimumProfit) {
      return { ...report, reason: 'unexpected payout' };
    }
    return { ...report, status: 'usable', grossProfitWei: BigInt(payout).toString() };
  } catch (error) {
    // RPC request messages can contain calldata and credentials. Classify only the node's structured error.
    const rpcError = error instanceof BaseError ? error.walk(cause => cause instanceof RpcRequestError) : null;
    if (report.blockHash && rpcError instanceof RpcRequestError) {
      const reason = knownArbitrageRevert(rpcError.data) ?? knownArbitrageRevert(rpcError.details?.replace(/^execution reverted: /, ''));
      if (rpcError.code === 3 || ((rpcError.code === -32000 || rpcError.code === -32015)
        && reason && rpcError.details?.startsWith('execution reverted'))) {
        return { ...report, status: 'reverted', ...(reason && { reason }) };
      }
    }
    return report;
  }
}
