import {
  ContractFunctionExecutionError, createPublicClient, encodeAbiParameters, fallback, formatEther, http, keccak256, parseAbi, parseAbiParameters,
  parseEther, zeroAddress, type Address,
} from 'viem';
import { arbitrum } from 'viem/chains';
import { loanLimitWei } from '../mev/cadence.js';

export const defaultArbitrumRpc = 'https://arb1.arbitrum.io/rpc';
const alternateArbitrumReadRpc = 'https://arbitrum-one-rpc.publicnode.com';
const arbReadMethods = [
  'eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getStorageAt',
  'eth_getBalance', 'eth_getTransactionCount', 'eth_getTransactionReceipt', 'eth_call',
  'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
];
export const arbitrumChainId = 42161;
const weth: Address = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const factory: Address = '0x1f98431c8ad98523631ae4a59f267346ea31f984';
const quoterV3 = '0x61ffe014ba17989e743c5f6cb21bf9697530b21e';
const quoterV4 = '0x8928074ca1b241d8ec02815881c1af11e8bc5219';
const poolManager: Address = '0x360e68faccca8ca495c1b759fd9eee466db9fb32';
const stateView: Address = '0x76fd297e2d437cd7f76d50f01afe6160f86e9990';
const aavePool = '0x794a61358d6845594f94dc1db02a252b5b4814ad';
const aaveWeth = '0xe50fa9b3c56ffb159cb0fca61f5c9d750e8128c8';
const ethUsdFeed = '0x639fe6ab55c921f74e7fac1ee960c0b6293ba612';
const tokens = [
  ['USDC', '0xaf88d065e77c8cc2239327c5edb3a432268e5831'],
  ['USDC.e', '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8'],
  ['USDT', '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'],
  ['WBTC', '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f'],
  ['ARB', '0x912ce59144191c1204e64559fe8253a0e49e6548'],
  ['LINK', '0xf97f4df75117a78c1a5a0dbb814af92458539fb4'],
  ['GMX', '0xfc5a1a6eb076a2c7ad06ed22c90d7e710e35ad0a'],
  ['wstETH', '0x5979d7b546e38e414f7e9822514be443a4800529'],
  ['rETH', '0xec70dcb4a1efa46b8f2d97c310c9c4790ba5ffa8'],
] as const;
const v3Fees = [100, 500, 3000, 10000] as const;
// V4 pool keys include an independent tick spacing. These hook-free keys include
// liquid Arbitrum pools outside the conventional v3 fee and spacing combinations.
const v4Tiers = [[8, 1], [100, 1], [250, 5], [500, 10], [1000, 20], [3000, 60], [10000, 200]] as const;
const amounts = ['0.05', '0.25', '1', '4', '16'].map((size) => parseEther(size));
const explorationSizes = ['0.01', '0.1', '0.5', '2', '8', '32', '64'].map((size) => parseEther(size));
const refinementRatios = [[3n, 2n], [3n, 4n], [2n, 1n], [1n, 2n]] as const;
const quoteLeadMaxAge = 30_000;
const maxRetryQuoteLegs = 96;
const profitTestAmounts = ['0.015', '0.05', '0.1', '0.25', '1', '4', '8', '16', '32', '64'].map((size) => parseEther(size));
const testAmounts = ['0.0002', '0.0006', '0.0018', '0.005', '0.015', '0.05', '0.1', '0.25', '1', '4', '16'].map((size) => parseEther(size));
const q192 = 2n ** 192n;
const swapFeeScale = 1_000_000n;
const keyAbi = parseAbiParameters('address,address,uint24,int24,address');
const factoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const stateAbi = parseAbi([
  'function getLiquidity(bytes32) view returns (uint128)',
  'function getSlot0(bytes32) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)',
]);
const v3PoolAbi = parseAbi([
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
]);
const aaveAbi = parseAbi(['function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)', 'function getConfiguration(address) view returns (uint256)']);
const balanceAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);
const oracleAbi = parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']);
const quoteV3Abi = parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256 gasEstimate)']);
const quoteV4Abi = parseAbi(['function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData)) returns (uint256 amountOut,uint256 gasEstimate)']);

export const arbitrumClient = (rpc = defaultArbitrumRpc) => {
  const primary = http(rpc, { timeout: 6000, retryCount: 0 });
  const transport = rpc.replace(/\/$/, '') === defaultArbitrumRpc
    ? fallback([primary, http(alternateArbitrumReadRpc, {
      timeout: 2000, retryCount: 0, methods: { include: arbReadMethods },
    })], { retryCount: 0 })
    : primary;
  return createPublicClient({ chain: arbitrum, transport });
};
export type ArbitrumClient = ReturnType<typeof arbitrumClient>;
type Pool = { kind: 2 | 5; pool: Address; fee: number; tickSpacing: number; nativeEth: boolean };
type Market = { symbol: string; token: Address; pools: Pool[] };
export type ArbOrder = {
  funding: 1; token: Address; buy: Pool; sell: Pool;
  amountIn: bigint; minProfit: bigint; tip: bigint; maxBlock: bigint;
};
export type ArbQuote = { order: ArbOrder; symbol: string; payout: bigint };
type SizingLead = { amount: bigint; payout: bigint };
type SampledQuote = SizingLead & { symbol: string };
export type RecentArbitrumSizingLead = { amount: bigint; at: number };
type SpotRate = { tokenOut: bigint; baseIn: bigint; lpFee: bigint };

export function arbitrumProbeSize(scan: number, lead: RecentArbitrumSizingLead | null, now: number): bigint | undefined {
  if (scan % 2 === 0) return undefined;
  const extra = Math.floor(scan / 2);
  const round = Math.floor(extra / 2);
  const exploration = explorationSizes[round % explorationSizes.length];
  // Keep the existing one extra size every other scan. Half of those slots explore independently of the quote signal.
  if (extra % 2 === 1 || !lead || lead.at > now || now - lead.at > quoteLeadMaxAge) return exploration;
  const [numerator, denominator] = refinementRatios[round % refinementRatios.length];
  const refined = lead.amount * numerator / denominator;
  return refined >= explorationSizes[0] && refined <= explorationSizes[explorationSizes.length - 1]
    && !amounts.includes(refined) ? refined : exploration;
}

function betterSizingLead(amount: bigint, payout: bigint, current: SizingLead | null): boolean {
  // Use small-loss quotes as size hints only where lender fees leave the route within two basis points of break-even.
  if (payout < 0n && (amount < amounts[0] || payout * 5_000n < -amount)) return false;
  if (!current) return true;
  if (payout >= 0n || current.payout >= 0n) return payout > current.payout;
  const byMargin = payout * current.amount - current.payout * amount;
  return byMargin > 0n || (byMargin === 0n && amount > current.amount);
}

function poolKey(token: Address, pool: Pool) {
  const base = pool.nativeEth ? zeroAddress : weth;
  const [currency0, currency1] = base < token ? [base, token] : [token, base];
  return { currency0, currency1, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: zeroAddress };
}

function poolId(token: Address, pool: Pool) {
  const { currency0, currency1, fee, tickSpacing, hooks } = poolKey(token, pool);
  return keccak256(encodeAbiParameters(keyAbi, [currency0, currency1, fee, tickSpacing, hooks]));
}

function flashPremium(amount: bigint, premiumBps: bigint) {
  return (amount * premiumBps + 5_000n) / 10_000n;
}

function ceilRatio(numerator: bigint, denominator: bigint) {
  return (numerator + denominator - 1n) / denominator;
}

/** Swap rates are monotone along each hook-free curve. Use each starting price as an optimistic bound. */
export function mayProfitAtArbitrumSpot(amount: bigint, premiumBps: bigint, buy?: SpotRate, sell?: SpotRate): boolean {
  if (!buy || !sell) return true;
  // Round up both legs to cover atomic pricing boundaries. Ignoring any protocol fee only raises the bound.
  const tokenOut = ceilRatio(amount * buy.tokenOut * (swapFeeScale - buy.lpFee), buy.baseIn * swapFeeScale);
  const baseOut = ceilRatio(tokenOut * sell.baseIn * (swapFeeScale - sell.lpFee), sell.tokenOut * swapFeeScale);
  return baseOut > amount + flashPremium(amount, premiumBps);
}

async function readArbitrumSpotRates(client: ArbitrumClient, blockNumber: bigint, markets: Market[]): Promise<Map<Pool, SpotRate>> {
  const pools = markets.flatMap(({ token, pools }) => pools.map((pool) => ({ token, pool })));
  const results = await client.multicall({ blockNumber, contracts: pools.map(({ token, pool }) =>
    pool.kind === 2 ? { address: pool.pool, abi: v3PoolAbi, functionName: 'slot0' as const }
      : { address: stateView, abi: stateAbi, functionName: 'getSlot0' as const, args: [poolId(token, pool)] as const },
  ) });
  const rates = new Map<Pool, SpotRate>();
  for (const [i, { token, pool }] of pools.entries()) {
    const values = results[i]?.result;
    const sqrtPrice = values?.[0];
    if (typeof sqrtPrice !== 'bigint' || sqrtPrice <= 0n || !Number.isInteger(pool.fee)
      || pool.fee < 0 || pool.fee >= Number(swapFeeScale)
      || (pool.kind === 5 && values?.[3] !== pool.fee)) continue;
    const square = sqrtPrice * sqrtPrice;
    const base = pool.nativeEth ? zeroAddress : weth;
    const isBaseFirst = base < token;
    rates.set(pool, { tokenOut: isBaseFirst ? square : q192, baseIn: isBaseFirst ? q192 : square, lpFee: BigInt(pool.fee) });
  }
  return rates;
}

export async function discoverArbitrumPools(client: ArbitrumClient, blockNumber: bigint): Promise<Market[]> {
  const v3Pairs = tokens.flatMap(([, token]) => v3Fees.map((fee) => ({ token, fee })));
  const addresses = await client.multicall({ blockNumber, contracts: v3Pairs.map(({ token, fee }) => ({
    address: factory, abi: factoryAbi, functionName: 'getPool' as const, args: [weth, token, fee] as const,
  })) });
  const v3Pools = v3Pairs.flatMap(({ token, fee }, i) => {
    const poolAddress = addresses[i].result;
    if (!poolAddress || poolAddress === zeroAddress) return [];
    const pool: Pool = { kind: 2, pool: poolAddress, fee, tickSpacing: 0, nativeEth: false };
    return [{ token, pool, read: { address: poolAddress, abi: v3PoolAbi, functionName: 'liquidity' as const } }];
  });
  const v4Keys = tokens.flatMap(([, token]) => v4Tiers.map(([fee, tickSpacing]) => ({ token, fee, tickSpacing })));
  const v4Pools = v4Keys.flatMap(({ token, fee, tickSpacing }) => [true, false].map((nativeEth) => {
    const pool: Pool = { kind: 5, pool: poolManager, fee, tickSpacing, nativeEth };
    return { token, pool, read: { address: stateView, abi: stateAbi, functionName: 'getLiquidity' as const,
      args: [poolId(token, pool)] as const } };
  }));
  const candidates = [...v3Pools, ...v4Pools];
  const liquidity = await client.multicall({ blockNumber, contracts: candidates.map((candidate) => candidate.read) });
  return tokens.map(([symbol, token]) => ({
    symbol, token, pools: candidates.filter((candidate, i) => candidate.token === token && (liquidity[i].result ?? 0n) > 0n).map((candidate) => candidate.pool),
  })).filter((market) => market.pools.length > 1);
}

function quote(token: Address, pool: Pool, buy: boolean, amount: bigint) {
  if (pool.kind === 2) return { address: quoterV3, abi: quoteV3Abi, functionName: 'quoteExactInputSingle', args: [{
    tokenIn: buy ? weth : token, tokenOut: buy ? token : weth, amountIn: amount, fee: pool.fee, sqrtPriceLimitX96: 0n,
  }] } as const;
  const key = poolKey(token, pool);
  const tokenIn = buy ? (pool.nativeEth ? zeroAddress : weth) : token;
  return { address: quoterV4, abi: quoteV4Abi, functionName: 'quoteExactInputSingle', args: [{
    poolKey: key, zeroForOne: key.currency0 === tokenIn, exactAmount: amount, hookData: '0x',
  }] } as const;
}

function aggregateFailure(error: unknown): error is ContractFunctionExecutionError {
  return error instanceof ContractFunctionExecutionError && error.functionName === 'aggregate3';
}

async function quoteArbitrumPools(client: ArbitrumClient, blockNumber: bigint, contracts: ReturnType<typeof quote>[]) {
  if (!contracts.length) return [];
  const rows = await client.multicall({ blockNumber, batchSize: 6000, contracts });
  // A gas-limited aggregate supplies the same error for every leg in that RPC
  // batch, including valid pools. A revert from an individual quoter is final.
  const missing = rows.flatMap((row, index) => row.status === 'failure' && aggregateFailure(row.error)
    && /\bout of gas\b/i.test(row.error.details ?? '') ? [index] : []);
  if (missing.length) {
    // Bound even a full-market audit to one recovery pass per leg. Vary the
    // starting point so a repeatedly expensive early pool cannot starve later ones.
    const start = missing.length > maxRetryQuoteLegs ? Number(blockNumber % BigInt(missing.length)) : 0;
    const selected = Array.from({ length: Math.min(missing.length, maxRetryQuoteLegs) },
      (_, i) => missing[(start + i) % missing.length]);
    const retry = await client.multicall({ blockNumber, batchSize: 1400, contracts: selected.map((i) => contracts[i]) })
      .catch(() => []);
    for (const [j, row] of retry.entries()) rows[selected[j]] = row;
  }
  return rows;
}

export async function arbitrumEthUsd(client: ArbitrumClient, blockNumber?: bigint): Promise<number> {
  const [, price, , updated] = await client.readContract({
    address: ethUsdFeed, abi: oracleAbi, functionName: 'latestRoundData', blockNumber,
  });
  if (price <= 0n || updated < BigInt(Math.floor(Date.now() / 1000) - 3600)) throw new Error('Arbitrum ETH/USD feed is stale');
  return Number(price) / 1e8;
}

export async function scanArbitrum(client: ArbitrumClient, blockNumber: bigint, markets: Market[],
  test: boolean | number = false, extraSize?: bigint, maxLoanUsd = 1_000_000, screenRoundTrips = false,
  price = arbitrumEthUsd(client, blockNumber)) {
  const [premiumBps, config, available, ethUsd, spotRates] = await Promise.all([
    client.readContract({ address: aavePool, abi: aaveAbi, functionName: 'FLASHLOAN_PREMIUM_TOTAL', blockNumber }),
    client.readContract({ address: aavePool, abi: aaveAbi, functionName: 'getConfiguration', args: [weth], blockNumber }),
    client.readContract({ address: weth, abi: balanceAbi, functionName: 'balanceOf', args: [aaveWeth], blockNumber }),
    price,
    screenRoundTrips && test === false
      ? readArbitrumSpotRates(client, blockNumber, markets).catch(() => undefined) : undefined,
  ]);
  const active = (config & (1n << 56n)) !== 0n && (config & (1n << 60n)) === 0n && (config & (1n << 63n)) !== 0n;
  if (!active) throw new Error('Aave WETH flash loans are disabled');
  const usdLimit = loanLimitWei(maxLoanUsd, ethUsd) ?? 0n;
  const ladder = typeof test === 'number' ? profitTestAmounts.filter((amount) => Number(formatEther(amount)) * ethUsd >= test)
    : test ? testAmounts : extraSize === undefined || amounts.includes(extraSize) ? amounts : [...amounts, extraSize];
  const sizes = ladder.filter((size) => size > 0n && size <= available && size <= usdLimit);
  let prunedRoutes = 0;
  const buys = markets.flatMap((market) => market.pools.flatMap((pool) => sizes.flatMap((size) => {
    const sellPools = market.pools.filter((sell) => {
      if (sell === pool) return false;
      if (mayProfitAtArbitrumSpot(size, premiumBps, spotRates?.get(pool), spotRates?.get(sell))) return true;
      prunedRoutes++;
      return false;
    });
    return sellPools.length ? [{ market, pool, size, sellPools }] : [];
  })));
  const bought = await quoteArbitrumPools(client, blockNumber,
    buys.map(({ market, pool, size }) => quote(market.token, pool, true, size)));
  const sells = buys.flatMap(({ market, pool, size, sellPools }, i) => {
    const amount = bought[i].result?.[0] ?? 0n;
    if (amount <= 0n || amount >= 2n ** 128n) return [];
    return sellPools.map((sell) => ({ market, buy: pool, sell, size, amount }));
  });
  const sold = await quoteArbitrumPools(client, blockNumber,
    sells.map(({ market, sell, amount }) => quote(market.token, sell, false, amount)));
  const unavailableLegs = [...bought, ...sold].filter((row) => row.status === 'failure' && aggregateFailure(row.error)).length;
  const opportunities: ArbQuote[] = [];
  let bestQuote: SampledQuote | null = null;
  let largestQuote: SampledQuote | null = null;
  let sizingLead: SizingLead | null = null;
  let quotedRoutes = 0;
  for (const [i, { market, buy, sell, size }] of sells.entries()) {
    const received = sold[i].result?.[0] ?? 0n;
    if (received <= 0n) continue;
    quotedRoutes += 1;
    const payout = received - size - flashPremium(size, premiumBps);
    if (!bestQuote || payout > bestQuote.payout) bestQuote = { symbol: market.symbol, amount: size, payout };
    if (!largestQuote || size > largestQuote.amount || (size === largestQuote.amount && payout > largestQuote.payout)) {
      largestQuote = { symbol: market.symbol, amount: size, payout };
    }
    if (betterSizingLead(size, payout, sizingLead)) sizingLead = { amount: size, payout };
    if (payout <= 0n) continue;
    opportunities.push({
      order: { funding: 1, token: market.token, buy, sell, amountIn: size, minProfit: 1n, tip: 0n, maxBlock: blockNumber + 10n },
      symbol: market.symbol, payout,
    });
  }
  opportunities.sort((a, b) => a.payout > b.payout ? -1 : a.payout < b.payout ? 1 : 0);
  const best = opportunities[0];
  const report = (quote: SampledQuote | null) => quote ? {
    symbol: quote.symbol,
    loanUsd: Number(formatEther(quote.amount)) * ethUsd,
    payoutUsd: Number(formatEther(quote.payout)) * ethUsd,
  } : null;
  return {
    ethUsd, quotedRoutes, prunedRoutes, unavailableLegs, opportunities, sizingAmount: sizingLead?.amount,
    best: best ? { symbol: best.symbol, payoutUsd: Number(formatEther(best.payout)) * ethUsd } : null,
    bestQuote: report(bestQuote), largestQuote: report(largestQuote),
  };
}
