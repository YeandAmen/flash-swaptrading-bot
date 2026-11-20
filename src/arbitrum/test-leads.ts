import { parseEther } from 'viem';
import type { ArbQuote, discoverArbitrumPools } from './market.js';

const bridgedUsdc = '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8';
const probeSizes = ['0.0002', '0.0006', '0.0018'].map((size) => parseEther(size));

export function arbitrumTestLeads(
  markets: Awaited<ReturnType<typeof discoverArbitrumPools>>,
  blockNumber: bigint,
): ArbQuote[] {
  const market = markets.find(({ token }) => token.toLowerCase() === bridgedUsdc);
  const buy = market?.pools.find((pool) => pool.kind === 2 && pool.fee === 10000);
  const sell = market?.pools.find((pool) => pool.kind === 2 && pool.fee === 500);
  if (!market || !buy || !sell || buy.pool.toLowerCase() === sell.pool.toLowerCase()) return [];
  // This route once simulated a positive payout on mainnet. Every new probe needs its own exact simulation.
  return probeSizes.map((amountIn) => ({
    symbol: market.symbol,
    payout: 1n,
    order: {
      funding: 1, token: market.token, buy, sell, amountIn, minProfit: 1n, tip: 0n, maxBlock: blockNumber + 10n,
    },
  }));
}
