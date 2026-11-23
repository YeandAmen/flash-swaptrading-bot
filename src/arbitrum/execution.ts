import { BaseError, ExecutionRevertedError, formatEther, formatUnits, encodeFunctionData, decodeFunctionResult, type Address, type Hex } from 'viem';
import { ARBITRUM_FLASH_ARB_ABI } from './artifact.js';
import { ARBITRUM_FLASH_ARB_LOGIC_V2_ABI } from './artifact-logic-v2.js';
import { arbitrumPinnedCall, arbitrumSupportsPaths } from './proxy.js';
import { minimumNetInAsset, requiredGrossPayout } from './profit.js';
import type { ArbitrumClient, ArbQuote } from './market.js';
import type { ArbPathQuote } from './paths.js';

export type ArbitrumOrderRejection = 'daily-budget' | 'net-floor' | 'stale-quote' | 'fee-cap' | 'deadline'
  | 'gas-estimate-changed' | 'simulation-unavailable' | 'execution-reverted' | 'head-rpc' | 'fee-rpc' | 'simulation-rpc'
  | 'unsupported-path';

export interface ArbitrumStaleHead {
  at: number;
  headBlock: number;
  headTimestamp: number;
  headAgeMs: number;
  reason: 'head-behind-source' | 'quote-too-old' | 'head-clock-behind' | 'head-clock-ahead';
}

const reject = (reason: Exclude<ArbitrumOrderRejection, 'stale-quote'>) => ({ ok: false as const, reason });

export async function prepareArbitrumOrder(client: ArbitrumClient, contract: Address, owner: Address, candidate: ArbQuote | ArbPathQuote,
  ethUsd: number, minimumNetUsd: number, maximumFeeUsd: number, gasOnlyTest = false, release?: Hex) {
  if (maximumFeeUsd <= 0) return reject('daily-budget');
  let rpcStage: 'head-rpc' | 'fee-rpc' | 'simulation-rpc' = 'head-rpc';
  try {
    const path = 'legs' in candidate ? candidate : undefined;
    if (path && (!release || !arbitrumSupportsPaths(release) || gasOnlyTest)) return reject('unsupported-path');
    const decimals = path?.decimals ?? 18;
    const assetUsd = path?.assetUsd ?? ethUsd;
    if (!Number.isFinite(assetUsd) || assetUsd <= 0 || !Number.isFinite(ethUsd) || ethUsd <= 0) return reject('fee-rpc');
    // Both oracle prices use eight decimals. Round each minimum upward in the borrowed asset.
    const assetPrice = BigInt(Math.round(assetUsd * 1e8));
    const scale = 10n ** BigInt(decimals);
    const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
    const minNet = gasOnlyTest ? 0n : minimumNetInAsset(minimumNetUsd, scale, assetPrice);
    if (candidate.payout <= minNet) return reject('net-floor');
    const head = await client.getBlock();
    const at = Date.now();
    const headTimestamp = Number(head.timestamp);
    const headAgeMs = at - headTimestamp * 1000;
    const lastFreshBlock = ('legs' in candidate ? candidate.block : candidate.order.maxBlock) + 50n;
    let reason: ArbitrumStaleHead['reason'] | undefined;
    if (path && head.number < path.block) reason = 'head-behind-source';
    else if (head.number > lastFreshBlock) reason = 'quote-too-old';
    else if (headAgeMs > 5_000) reason = 'head-clock-behind';
    else if (headAgeMs < -5_000) reason = 'head-clock-ahead';
    if (reason) {
      return { ok: false as const, reason: 'stale-quote' as const, stale: { at, headBlock: Number(head.number), headTimestamp, headAgeMs, reason } };
    }
    // Broad snapshot quotes can take several L2 blocks. Refresh the deadline only for an exact live check.
    const deadline = head.number + 10n;
    const encode = (minProfit: bigint) => {
      if ('legs' in candidate) return encodeFunctionData({
        abi: ARBITRUM_FLASH_ARB_LOGIC_V2_ABI, functionName: 'executePath',
        args: [release!, { asset: candidate.asset, amountIn: candidate.amountIn, legs: candidate.legs, minProfit, maxBlock: deadline }],
      });
      const data = encodeFunctionData({
        abi: ARBITRUM_FLASH_ARB_ABI, functionName: 'execute', args: [{ ...candidate.order, maxBlock: deadline, minProfit }],
      });
      return release ? arbitrumPinnedCall(data, release) : data;
    };
    rpcStage = 'fee-rpc';
    const [estimated, fees] = await Promise.all([
      client.estimateGas({ account: owner, to: contract, data: encode(1n) }), client.estimateFeesPerGas(),
    ]);
    const gas = (estimated * 125n + 99n) / 100n;
    const gasBudget = gas * fees.maxFeePerGas;
    const worstGasUsd = Number(formatEther(gasBudget)) * ethUsd;
    if (worstGasUsd > maximumFeeUsd) return reject('fee-cap');
    const gasInAsset = ceil(gasBudget * BigInt(Math.round(ethUsd * 1e8)) * scale, 10n ** 18n * assetPrice);
    const minimum = gasOnlyTest ? 1n : gasInAsset + minNet;
    const requiredPayout = gasOnlyTest ? 1n : requiredGrossPayout(minimum);
    if (!gasOnlyTest && candidate.payout < requiredPayout) return reject('net-floor');
    const data = encode(minimum);
    const tx = { to: contract, data, gas, ...fees };
    rpcStage = 'simulation-rpc';
    const [exact, finalState, currentHead] = await Promise.all([
      client.estimateGas({ ...tx, account: owner }),
      client.call({ ...tx, account: owner, blockTag: 'pending' }),
      client.getBlockNumber({ cacheTime: 0 }),
    ]);
    if (currentHead >= deadline) return reject('deadline');
    if (exact > gas) return reject('gas-estimate-changed');
    if (!finalState.data || finalState.data === '0x') return reject('simulation-unavailable');
    const payout = decodeFunctionResult({ abi: ARBITRUM_FLASH_ARB_ABI, functionName: 'execute', data: finalState.data });
    if (payout < requiredPayout) return reject('net-floor');
    return { ok: true as const, tx, deadline, worstGasUsd, gasBudget, netUsd: Number(formatUnits(payout, decimals)) * assetUsd - worstGasUsd };
  } catch (error) {
    const reverted = error instanceof BaseError && error.walk((cause) => cause instanceof ExecutionRevertedError) instanceof ExecutionRevertedError;
    // Keep endpoint URLs, provider error messages, and request bodies out of dashboard data.
    return reject(reverted ? 'execution-reverted' : rpcStage);
  }
}
