import { formatEther, encodeFunctionData, decodeFunctionResult, parseEther, type Address, type Hex } from 'viem';
import { ARBITRUM_FLASH_ARB_ABI } from './artifact.js';
import { arbitrumPinnedCall } from './proxy.js';
import type { ArbitrumClient, ArbQuote } from './market.js';

export async function prepareArbitrumOrder(client: ArbitrumClient, contract: Address, owner: Address, candidate: ArbQuote,
  ethUsd: number, minimumNetUsd: number, maximumFeeUsd: number, gasOnlyTest = false, release?: Hex) {
  const minNet = gasOnlyTest ? 0n : parseEther((minimumNetUsd / ethUsd).toFixed(18));
  if (maximumFeeUsd <= 0 || candidate.payout <= minNet) return null;
  const head = await client.getBlock();
  if (head.number > candidate.order.maxBlock + 50n || Math.abs(Date.now() - Number(head.timestamp) * 1000) > 5_000) return null;
  // Broad snapshot quotes can take several L2 blocks. Refresh the deadline only for an exact live check.
  const deadline = head.number + 10n;
  const encode = (minProfit: bigint) => {
    const data = encodeFunctionData({
      abi: ARBITRUM_FLASH_ARB_ABI, functionName: 'execute', args: [{ ...candidate.order, maxBlock: deadline, minProfit }],
    });
    return release ? arbitrumPinnedCall(data, release) : data;
  };
  const [estimated, fees] = await Promise.all([
    client.estimateGas({ account: owner, to: contract, data: encode(1n) }), client.estimateFeesPerGas(),
  ]);
  const gas = (estimated * 125n + 99n) / 100n;
  const gasBudget = gas * fees.maxFeePerGas;
  const worstGasUsd = Number(formatEther(gasBudget)) * ethUsd;
  if (worstGasUsd > maximumFeeUsd || (!gasOnlyTest && candidate.payout * 9n / 10n < gasBudget + minNet)) return null;
  const minimum = gasOnlyTest ? 1n : gasBudget + minNet;
  const data = encode(minimum);
  const tx = { to: contract, data, gas, ...fees };
  const [exact, finalState, currentHead] = await Promise.all([
    client.estimateGas({ ...tx, account: owner }),
    client.call({ ...tx, account: owner, blockTag: 'pending' }),
    client.getBlockNumber({ cacheTime: 0 }),
  ]);
  if (!finalState.data || exact > gas || currentHead >= deadline) return null;
  const payout = decodeFunctionResult({ abi: ARBITRUM_FLASH_ARB_ABI, functionName: 'execute', data: finalState.data });
  if ((gasOnlyTest ? payout : payout * 9n / 10n) < minimum) return null;
  return { tx, deadline, worstGasUsd, gasBudget, netUsd: Number(formatEther(payout - gasBudget)) * ethUsd };
}
