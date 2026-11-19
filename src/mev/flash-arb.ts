import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from 'viem';
import type { MevContractVersion, MevFundingMode } from '../config.js';
import { FLASH_ARB_ABI, FLASH_ARB_RUNTIME } from './artifact.js';
import { FLASH_ARB_V2_ABI, FLASH_ARB_V2_RUNTIME } from './artifact-v2.js';
import { NextVenueKind } from './next-pools.js';
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

export function encodeArbitrage(version: MevContractVersion, funding: RouteFunding, call: Call): Hex {
  const { token, buy, sell, amountIn, minProfit, tip, maxBlock } = call;
  if (version === 'v2') {
    return encodeFunctionData({ abi: FLASH_ARB_V2_ABI, functionName: 'execute',
      args: [{ token, funding, buy: toNextVenue(buy), sell: toNextVenue(sell), amountIn, minProfit, tip, maxBlock }],
    });
  }
  if (funding !== 0 || [buy, sell].some((p) => p.v4 || p.kind === NextVenueKind.PancakeV3)) throw new Error('This route requires FlashArbV2');
  return encodeFunctionData({ abi: FLASH_ARB_ABI, functionName: 'execute',
    args: [{ poolA: buy.address, poolB: sell.address, token, aIsV2: buy.v2, bIsV2: sell.v2, amountIn, minProfit, tip, maxBlock }],
  });
}

export function decodeArbitrage(version: MevContractVersion, data: Hex): bigint {
  return version === 'v2'
    ? decodeFunctionResult({ abi: FLASH_ARB_V2_ABI, functionName: 'execute', data })
    : decodeFunctionResult({ abi: FLASH_ARB_ABI, functionName: 'execute', data });
}

export const flashArbRuntime = (version: MevContractVersion): Hex => version === 'v2' ? FLASH_ARB_V2_RUNTIME : FLASH_ARB_RUNTIME;

/** Compare financing at bounded representative sizes. Explicit lender modes use the full size grid. */
export function fundingTrials(version: MevContractVersion, mode: MevFundingMode, sizes: bigint[]) {
  if (version === 'legacy' || mode === 'pool') return sizes.map((amount) => ({ funding: 0 as const, amount }));
  if (mode === 'aave') return sizes.map((amount) => ({ funding: 1 as const, amount }));
  if (mode === 'morpho') return sizes.map((amount) => ({ funding: 2 as const, amount }));
  return ([0, 1, 2] as const).flatMap((funding) => (funding === 0 ? sizes : sizes.slice(0, 1)).map((amount) => ({ funding, amount })));
}
