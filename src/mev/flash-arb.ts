import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from 'viem';
import type { MevFundingMode } from '../config.js';
import { FLASH_ARB_V2_ABI } from './artifact-v2.js';
import { toNextVenue, type ArbPool } from './pools.js';

export type RouteFunding = 0 | 1 | 2;
export const FUNDING_NAMES = ['Pool flash swap', 'Aave V3', 'Morpho Blue'] as const;
export const EXECUTION_GAS_ADDON = [0, 95_000, 70_000] as const;

interface Call {
  token: Address;
  buy: ArbPool;
  sell: ArbPool;
  amountIn: bigint;
  minProfit: bigint;
  tip: bigint;
  maxBlock: bigint;
}

export function encodeArbitrage(funding: RouteFunding, call: Call): Hex {
  const { token, buy, sell, amountIn, minProfit, tip, maxBlock } = call;
  return encodeFunctionData({ abi: FLASH_ARB_V2_ABI, functionName: 'execute',
    args: [{ token, funding, buy: toNextVenue(buy), sell: toNextVenue(sell), amountIn, minProfit, tip, maxBlock }],
  });
}

export function decodeArbitrage(data: Hex): bigint {
  return decodeFunctionResult({ abi: FLASH_ARB_V2_ABI, functionName: 'execute', data });
}

/** Compare the reserve estimate and smallest trial for each lender. Explicit modes use the full grid. */
export function fundingTrials(mode: MevFundingMode, sizes: bigint[]) {
  if (mode === 'pool') return sizes.map((amount) => ({ funding: 0 as const, amount }));
  if (mode === 'aave') return sizes.map((amount) => ({ funding: 1 as const, amount }));
  if (mode === 'morpho') return sizes.map((amount) => ({ funding: 2 as const, amount }));
  if (!sizes.length) return [];
  const smallest = sizes.reduce((a, b) => a < b ? a : b);
  const lenderSizes = [...new Set([sizes[0], smallest])];
  return ([0, 1, 2] as const).flatMap((funding) => (funding === 0 ? sizes : lenderSizes).map((amount) => ({ funding, amount })));
}
