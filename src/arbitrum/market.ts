import {
  ContractFunctionExecutionError, createPublicClient, encodeAbiParameters, fallback, formatEther, HttpRequestError, http,
  keccak256, parseAbi, parseAbiParameters, parseEther, zeroAddress, type Address, type Hash,
} from 'viem';
import { arbitrum } from 'viem/chains';
import { loanLimitWei } from '../mev/cadence.js';

export const defaultArbitrumRpc = 'https://arb1.arbitrum.io/rpc';
export const alternateArbitrumReadRpc = 'https://arbitrum-one-rpc.publicnode.com';
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
const auditInterval = 10;
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
type QuoteReader = Pick<ArbitrumClient, 'getBlock' | 'multicall'>;
type QuoteRecoveryReaders = { primary: QuoteReader; alternate: QuoteReader };
export function arbitrumQuoteRecoveryReaders(rpc: string): QuoteRecoveryReaders | undefined {
  if (rpc.replace(/\/$/, '') !== defaultArbitrumRpc) return undefined;
  const direct = (url: string) => createPublicClient({ chain: arbitrum, transport: http(url, {
    timeout: 1200, retryCount: 0, methods: { include: ['eth_getBlockByNumber', 'eth_call'] },
  }) });
  return { primary: direct(defaultArbitrumRpc), alternate: direct(alternateArbitrumReadRpc) };
}
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

function auditBuyPools(markets: Market[], scan: number): Set<Pool> {
  const bucket = scan % auditInterval;
  const loads = Array<number>(auditInterval).fill(0);
  const selected = new Set<Pool>();
  const ordered = markets.flatMap(({ token, pools }) => pools.map((pool) => ({
    pool, weight: pools.length,
    key: [token, pool.kind, pool.pool, pool.fee, pool.tickSpacing, pool.nativeEth].join('/'),
  }))).sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
  for (const { pool, weight } of ordered) {
    // A buy shares its result across every other pool in the market. Count both the buy and its sells.
    const lightest = loads.indexOf(Math.min(...loads));
    loads[lightest] += weight;
    if (lightest === bucket) selected.add(pool);
  }
  return selected;
}

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

function qualifiesForSizing(amount: bigint, payout: bigint): boolean {
  // Keep small-loss quotes as size hints within two basis points of break-even on the base ladder and above.
  return payout >= 0n || (amount >= amounts[0] && payout * 5_000n >= -amount);
}

function betterSizingLead(amount: bigint, payout: bigint, current: SizingLead | null): boolean {
  if (!qualifiesForSizing(amount, payout)) return false;
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

function maxSellOutput(tokenAmount: bigint, sell: SpotRate) {
  return ceilRatio(tokenAmount * sell.baseIn * (swapFeeScale - sell.lpFee), sell.tokenOut * swapFeeScale);
}

/** Swap rates are monotone along each hook-free curve. Use each starting price as an optimistic bound. */
export function mayProfitAtArbitrumSpot(amount: bigint, premiumBps: bigint, buy?: SpotRate, sell?: SpotRate): boolean {
  if (!buy || !sell) return true;
  // Round up both legs to cover atomic pricing boundaries. Ignoring any protocol fee only raises the bound.
  const tokenOut = ceilRatio(amount * buy.tokenOut * (swapFeeScale - buy.lpFee), buy.baseIn * swapFeeScale);
  const baseOut = maxSellOutput(tokenOut, sell);
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

export async function refreshArbitrumPools(client: ArbitrumClient, blockNumber: bigint, previous = new Map<string, Pool>()) {
  const v3Pairs = tokens.flatMap(([, token]) => v3Fees.map((fee) => ({ token, fee })));
  const addresses = await client.multicall({ blockNumber, contracts: v3Pairs.map(({ token, fee }) => ({
    address: factory, abi: factoryAbi, functionName: 'getPool' as const, args: [weth, token, fee] as const,
  })) }).catch(() => []);
  const v3Pools = v3Pairs.flatMap(({ token, fee }, i) => {
    const key = token + '/' + fee;
    const poolAddress = addresses[i]?.result ?? previous.get(key)?.pool;
    if (!poolAddress || poolAddress === zeroAddress) return [];
    const pool: Pool = { kind: 2, pool: poolAddress, fee, tickSpacing: 0, nativeEth: false };
    return [{ token, pool, key, read: { address: poolAddress, abi: v3PoolAbi, functionName: 'liquidity' as const } }];
  });
  const v4Keys = tokens.flatMap(([, token]) => v4Tiers.map(([fee, tickSpacing]) => ({ token, fee, tickSpacing })));
  const v4Pools = v4Keys.flatMap(({ token, fee, tickSpacing }) => [true, false].map((nativeEth) => {
    const pool: Pool = { kind: 5, pool: poolManager, fee, tickSpacing, nativeEth };
    const key = poolId(token, pool);
    return { token, pool, key, read: { address: stateView, abi: stateAbi, functionName: 'getLiquidity' as const,
      args: [key] as const } };
  }));
  const candidates = [...v3Pools, ...v4Pools];
  const liquidity = await client.multicall({ blockNumber, contracts: candidates.map((candidate) => candidate.read) }).catch(() => []);
  const complete = addresses.length === v3Pairs.length && addresses.every(row => row.status === 'success')
    && liquidity.length === candidates.length && liquidity.every(row => row.status === 'success');
  const knownPools = new Map<string, Pool>();
  for (const [i, { key, pool }] of candidates.entries()) {
    const quantity = liquidity[i]?.result;
    // Preserve only this exact pool on a failed read. A zero address or zero liquidity evicts it.
    if (quantity === undefined ? previous.get(key)?.pool.toLowerCase() === pool.pool.toLowerCase() : quantity > 0n) {
      knownPools.set(key, pool);
    }
  }
  const markets = tokens.map(([symbol, token]) => ({
    symbol, token, pools: candidates.filter(candidate => candidate.token === token && knownPools.has(candidate.key)).map(candidate => candidate.pool),
  })).filter((market) => market.pools.length > 1);
  return { markets, knownPools, complete };
}

export async function discoverArbitrumPools(client: ArbitrumClient, blockNumber: bigint): Promise<Market[]> {
  return (await refreshArbitrumPools(client, blockNumber)).markets;
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

export function emptyArbitrumQuoteRecovery() {
  return { before: 0, recovered: 0, remaining: 0, individualFailures: 0, resolvedIndividual: 0,
    outOfGas: 0, rateLimited: 0, alternateAttempted: 0, alternateRecovered: 0 };
}

type QuotePin = { blockNumber: bigint } | { blockHash: Hash; requireCanonical: true };

function selectRetryLegs(eligible: number[], blockNumber: bigint, canRepay?: (index: number) => boolean) {
  if (eligible.length <= maxRetryQuoteLegs) return eligible;
  const rotating = (indices: number[], limit: number) => {
    if (indices.length <= limit) return indices;
    const start = Number(blockNumber % BigInt(indices.length));
    return Array.from({ length: limit }, (_, i) => indices[(start + i) % indices.length]);
  };
  if (!canRepay) return rotating(eligible, maxRetryQuoteLegs);
  const plausible: number[] = [], belowRepayment: number[] = [];
  for (const i of eligible) (canRepay(i) ? plausible : belowRepayment).push(i);
  // Keep one rotating audit even when potentially repayable or unknown-price sells fill the budget.
  const preferred = rotating(plausible, maxRetryQuoteLegs - (belowRepayment.length ? 1 : 0));
  return [...preferred, ...rotating(belowRepayment, maxRetryQuoteLegs - preferred.length)];
}

async function quoteArbitrumPools(client: ArbitrumClient, blockNumber: bigint, contracts: ReturnType<typeof quote>[],
  pin: QuotePin, counts: ReturnType<typeof emptyArbitrumQuoteRecovery>, alternateForBlock: () => Promise<QuoteReader | undefined>,
  canRepay?: (index: number) => boolean) {
  if (!contracts.length) return [];
  const rows = await client.multicall({ ...pin, batchSize: 6000, contracts });
  const missing: number[] = [], gasLimited: number[] = [];
  for (const [i, row] of rows.entries()) {
    if (row.status === 'success') continue;
    if (!aggregateFailure(row.error)) { counts.individualFailures++; continue; }
    missing.push(i);
    if (/\bout of gas\b/i.test(row.error.details ?? '')) gasLimited.push(i);
    else if (/rate.?limit|too many requests/i.test(row.error.details ?? '')
      || row.error.walk(cause => cause instanceof HttpRequestError && cause.status === 429)) counts.rateLimited++;
  }
  counts.before += missing.length;
  counts.remaining += missing.length;
  counts.outOfGas += gasLimited.length;
  if (!missing.length) return rows;
  const alternate = await alternateForBlock();
  const eligible = alternate ? missing : gasLimited;
  if (!eligible.length) return rows;
  // Each failed leg gets at most one smaller retry, on a single reader.
  const selected = selectRetryLegs(eligible, blockNumber, canRepay);
  if (alternate) counts.alternateAttempted += selected.length;
  const retry = await (alternate ?? client).multicall({ ...pin, batchSize: 1400, contracts: selected.map(i => contracts[i]) })
    .catch(() => []);
  for (const [j, row] of retry.entries()) {
    rows[selected[j]] = row;
    if (row.status === 'success') {
      counts.recovered++;
      counts.remaining--;
      if (alternate) counts.alternateRecovered++;
    } else if (!aggregateFailure(row.error)) {
      counts.individualFailures++;
      counts.resolvedIndividual++;
      counts.remaining--;
    }
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
  test: boolean | number = false, extraSize?: bigint, maxLoanUsd = 1_000_000,
  screenRoundTrips: boolean | { auditScan: number } = false,
  price = arbitrumEthUsd(client, blockNumber), recovery?: QuoteRecoveryReaders & { blockHash: Hash }) {
  let pin: QuotePin = recovery ? { blockHash: recovery.blockHash, requireCanonical: true } : { blockNumber };
  const premiumRead = { address: aavePool, abi: aaveAbi, functionName: 'FLASHLOAN_PREMIUM_TOTAL' } as const;
  // Check hash-pin support with an existing small read before issuing the large quote batches.
  const premium = client.readContract({ ...premiumRead, ...pin }).catch(error => {
    if (!recovery) throw error;
    pin = { blockNumber };
    return client.readContract({ ...premiumRead, blockNumber });
  });
  const [premiumBps, config, available, ethUsd, spotRates] = await Promise.all([
    premium,
    client.readContract({ address: aavePool, abi: aaveAbi, functionName: 'getConfiguration', args: [weth], blockNumber }),
    client.readContract({ address: weth, abi: balanceAbi, functionName: 'balanceOf', args: [aaveWeth], blockNumber }),
    price,
    screenRoundTrips && test === false
      ? readArbitrumSpotRates(client, blockNumber, markets).catch(() => undefined) : undefined,
  ]);
  const active = (config & (1n << 56n)) !== 0n && (config & (1n << 60n)) === 0n && (config & (1n << 63n)) !== 0n;
  if (!active) throw new Error('Aave WETH flash loans are disabled');
  const quoteRecovery = emptyArbitrumQuoteRecovery();
  let verified: Promise<QuoteReader | undefined> | undefined;
  const alternateForBlock = async () => {
    if (!recovery || !('blockHash' in pin)) return undefined;
    // Use independent transports. A fallback client could otherwise confirm its own hash twice.
    return verified ??= Promise.all([recovery.primary, recovery.alternate].map(reader => reader.getBlock({ blockNumber })))
      .then(headers => headers.every(header => header.number === blockNumber && header.hash === recovery.blockHash)
        ? recovery.alternate : undefined).catch(() => undefined);
  };
  const usdLimit = loanLimitWei(maxLoanUsd, ethUsd) ?? 0n;
  const ladder = typeof test === 'number' ? profitTestAmounts.filter((amount) => Number(formatEther(amount)) * ethUsd >= test)
    : test ? testAmounts : extraSize === undefined || amounts.includes(extraSize) ? amounts : [...amounts, extraSize];
  const sizes = ladder.filter((size) => size > 0n && size <= available && size <= usdLimit);
  const audit = test === false && typeof screenRoundTrips === 'object' ? auditBuyPools(markets, screenRoundTrips.auditScan) : undefined;
  let prunedRoutes = 0;
  const buys = markets.flatMap((market) => market.pools.flatMap((pool) => sizes.flatMap((size) => {
    // The previous full audit ran on an even scan and covered only the base ladder.
    const auditSize = audit?.has(pool) && amounts.includes(size);
    const sellPools = market.pools.filter((sell) => {
      if (sell === pool) return false;
      if (auditSize || mayProfitAtArbitrumSpot(size, premiumBps, spotRates?.get(pool), spotRates?.get(sell))) return true;
      prunedRoutes++;
      return false;
    });
    return sellPools.length ? [{ market, pool, size, sellPools, auditSize }] : [];
  })));
  const bought = await quoteArbitrumPools(client, blockNumber,
    buys.map(({ market, pool, size }) => quote(market.token, pool, true, size)), pin, quoteRecovery, alternateForBlock);
  let prunedAfterBuy = 0;
  const sells = buys.flatMap(({ market, pool, size, sellPools, auditSize }, i) => {
    const amount = bought[i].result?.[0] ?? 0n;
    if (amount <= 0n || amount >= 2n ** 128n) return [];
    const repayment = size + flashPremium(size, premiumBps);
    return sellPools.flatMap((sell) => {
      const rate = !auditSize && spotRates?.has(pool) ? spotRates.get(sell) : undefined;
      if (rate && !qualifiesForSizing(size, maxSellOutput(amount, rate) - repayment)) {
        prunedAfterBuy++;
        return [];
      }
      return [{ market, buy: pool, sell, size, amount, repayment }];
    });
  });
  const sold = await quoteArbitrumPools(client, blockNumber,
    sells.map(({ market, sell, amount }) => quote(market.token, sell, false, amount)), pin, quoteRecovery, alternateForBlock,
    spotRates?.size ? (i) => {
      const { amount, sell, repayment } = sells[i];
      const rate = spotRates.get(sell);
      return !rate || maxSellOutput(amount, rate) >= repayment;
    } : undefined);
  const opportunities: ArbQuote[] = [];
  let bestQuote: SampledQuote | null = null;
  let largestQuote: SampledQuote | null = null;
  let sizingLead: SizingLead | null = null;
  let quotedRoutes = 0;
  for (const [i, { market, buy, sell, size, repayment }] of sells.entries()) {
    const received = sold[i].result?.[0] ?? 0n;
    if (received <= 0n) continue;
    quotedRoutes += 1;
    const payout = received - repayment;
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
    ethUsd, quotedRoutes, prunedRoutes: prunedRoutes + prunedAfterBuy, prunedAfterBuy, unavailableLegs: quoteRecovery.remaining, quoteRecovery,
    opportunities, sizingAmount: sizingLead?.amount,
    best: best ? { symbol: best.symbol, payoutUsd: Number(formatEther(best.payout)) * ethUsd } : null,
    bestQuote: report(bestQuote), largestQuote: report(largestQuote),
  };
}
