import { BaseError, ExecutionRevertedError, formatEther, encodeFunctionData, decodeFunctionResult, parseEther, type Address, type Hex } from 'viem';
import { ARBITRUM_FLASH_ARB_ABI } from './artifact.js';
import { arbitrumPinnedCall } from './proxy.js';
import type { ArbitrumClient, ArbQuote } from './market.js';

export type ArbitrumOrderRejection = 'daily-budget' | 'net-floor' | 'stale-quote' | 'fee-cap' | 'deadline'
  | 'gas-estimate-changed' | 'simulation-unavailable' | 'execution-reverted' | 'head-rpc' | 'fee-rpc' | 'simulation-rpc';

const reject = (reason: ArbitrumOrderRejection) => ({ ok: false as const, reason });

export async function prepareArbitrumOrder(client: ArbitrumClient, contract: Address, owner: Address, candidate: ArbQuote,
  ethUsd: number, minimumNetUsd: number, maximumFeeUsd: number, gasOnlyTest = false, release?: Hex) {
  if (maximumFeeUsd <= 0) return reject('daily-budget');
  let rpcStage: 'head-rpc' | 'fee-rpc' | 'simulation-rpc' = 'head-rpc';
  try {
    const minNet = gasOnlyTest ? 0n : parseEther((minimumNetUsd / ethUsd).toFixed(18));
    if (candidate.payout <= minNet) return reject('net-floor');
    const head = await client.getBlock();
    if (head.number > candidate.order.maxBlock + 50n || Math.abs(Date.now() - Number(head.timestamp) * 1000) > 5_000) {
      return reject('stale-quote');
    }
    // Broad snapshot quotes can take several L2 blocks. Refresh the deadline only for an exact live check.
    const deadline = head.number + 10n;
    const encode = (minProfit: bigint) => {
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
    if (!gasOnlyTest && candidate.payout * 9n / 10n < gasBudget + minNet) return reject('net-floor');
    const minimum = gasOnlyTest ? 1n : gasBudget + minNet;
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
    if ((gasOnlyTest ? payout : payout * 9n / 10n) < minimum) return reject('net-floor');
    return { ok: true as const, tx, deadline, worstGasUsd, gasBudget, netUsd: Number(formatEther(payout - gasBudget)) * ethUsd };
  } catch (error) {
    const reverted = error instanceof BaseError && error.walk((cause) => cause instanceof ExecutionRevertedError) instanceof ExecutionRevertedError;
    // Keep endpoint URLs, provider error messages, and request bodies out of dashboard data.
    return reject(reverted ? 'execution-reverted' : rpcStage);
  }
}
