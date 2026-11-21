import {
  createPublicClient, encodeAbiParameters, fallback, formatEther, http, keccak256, parseAbi, parseAbiParameters,
  parseEther, zeroAddress, type Address,
} from 'viem';
import { arbitrum } from 'viem/chains';

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
const tiers = [[100, 1], [500, 10], [3000, 60], [10000, 200]] as const;
const amounts = ['0.05', '0.25', '1', '4', '16'].map((size) => parseEther(size));
const profitTestAmounts = ['0.015', '0.05', '0.1', '0.25', '1', '4', '8', '16', '32', '64'].map((size) => parseEther(size));
const testAmounts = ['0.0002', '0.0006', '0.0018', '0.005', '0.015', '0.05', '0.1', '0.25', '1', '4', '16'].map((size) => parseEther(size));
const keyAbi = parseAbiParameters('address,address,uint24,int24,address');
const factoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const stateAbi = parseAbi(['function getLiquidity(bytes32) view returns (uint128)']);
const liquidityAbi = parseAbi(['function liquidity() view returns (uint128)']);
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

function poolKey(token: Address, pool: Pool) {
  const base = pool.nativeEth ? zeroAddress : weth;
  const [currency0, currency1] = base < token ? [base, token] : [token, base];
  return { currency0, currency1, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: zeroAddress };
}

export async function discoverArbitrumPools(client: ArbitrumClient, blockNumber: bigint): Promise<Market[]> {
  const combinations = tokens.flatMap(([, token]) => tiers.map(([fee, tickSpacing]) => ({ token, fee, tickSpacing })));
  const addresses = await client.multicall({ blockNumber, contracts: combinations.map(({ token, fee }) => ({
    address: factory, abi: factoryAbi, functionName: 'getPool' as const, args: [weth, token, fee] as const,
  })) });
  const v3Pools = combinations.flatMap(({ token, fee }, i) => {
    const poolAddress = addresses[i].result;
    if (!poolAddress || poolAddress === zeroAddress) return [];
    const pool: Pool = { kind: 2, pool: poolAddress, fee, tickSpacing: 0, nativeEth: false };
    return [{ token, pool, read: { address: poolAddress, abi: liquidityAbi, functionName: 'liquidity' as const } }];
  });
  const v4Pools = combinations.flatMap(({ token, fee, tickSpacing }) => [true, false].map((nativeEth) => {
    const pool: Pool = { kind: 5, pool: poolManager, fee, tickSpacing, nativeEth };
    const { currency0, currency1, hooks } = poolKey(token, pool);
    const id = keccak256(encodeAbiParameters(keyAbi, [currency0, currency1, fee, tickSpacing, hooks]));
    return { token, pool, read: { address: stateView, abi: stateAbi, functionName: 'getLiquidity' as const, args: [id] as const } };
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

export async function arbitrumEthUsd(client: ArbitrumClient, blockNumber?: bigint): Promise<number> {
  const [, price, , updated] = await client.readContract({
    address: ethUsdFeed, abi: oracleAbi, functionName: 'latestRoundData', blockNumber,
  });
  if (price <= 0n || updated < BigInt(Math.floor(Date.now() / 1000) - 3600)) throw new Error('Arbitrum ETH/USD feed is stale');
  return Number(price) / 1e8;
}

export async function scanArbitrum(client: ArbitrumClient, blockNumber: bigint, markets: Market[],
  test: boolean | number = false, extraSize?: bigint) {
  const [premiumBps, config, available, ethUsd] = await Promise.all([
    client.readContract({ address: aavePool, abi: aaveAbi, functionName: 'FLASHLOAN_PREMIUM_TOTAL', blockNumber }),
    client.readContract({ address: aavePool, abi: aaveAbi, functionName: 'getConfiguration', args: [weth], blockNumber }),
    client.readContract({ address: weth, abi: balanceAbi, functionName: 'balanceOf', args: [aaveWeth], blockNumber }),
    arbitrumEthUsd(client, blockNumber),
  ]);
  const active = (config & (1n << 56n)) !== 0n && (config & (1n << 60n)) === 0n && (config & (1n << 63n)) !== 0n;
  if (!active) throw new Error('Aave WETH flash loans are disabled');
  const sizes = typeof test === 'number' ? profitTestAmounts.filter((amount) => Number(formatEther(amount)) * ethUsd >= test)
    : test ? testAmounts : extraSize === undefined ? amounts : [...amounts, extraSize];
  const buys = markets.flatMap((market) => market.pools.flatMap((pool) =>
    sizes.filter((size) => size <= available).map((size) => ({ market, pool, size }))));
  const bought = await client.multicall({
    blockNumber, batchSize: 6000, contracts: buys.map(({ market, pool, size }) => quote(market.token, pool, true, size)),
  });
  const sells = buys.flatMap(({ market, pool, size }, i) => {
    const amount = bought[i].result?.[0] ?? 0n;
    if (amount <= 0n || amount >= 2n ** 128n) return [];
    return market.pools.filter((sell) => sell !== pool).map((sell) => ({ market, buy: pool, sell, size, amount }));
  });
  const sold = await client.multicall({
    blockNumber, batchSize: 6000, contracts: sells.map(({ market, sell, amount }) => quote(market.token, sell, false, amount)),
  });
  const opportunities: ArbQuote[] = [];
  let quotedRoutes = 0;
  for (const [i, { market, buy, sell, size }] of sells.entries()) {
    const received = sold[i].result?.[0] ?? 0n;
    if (received <= 0n) continue;
    quotedRoutes += 1;
    const payout = received - size - (size * premiumBps + 5_000n) / 10_000n;
    if (payout <= 0n) continue;
    opportunities.push({
      order: { funding: 1, token: market.token, buy, sell, amountIn: size, minProfit: 1n, tip: 0n, maxBlock: blockNumber + 10n },
      symbol: market.symbol, payout,
    });
  }
  opportunities.sort((a, b) => a.payout > b.payout ? -1 : a.payout < b.payout ? 1 : 0);
  const best = opportunities[0];
  return {
    ethUsd, quotedRoutes, opportunities,
    best: best ? { symbol: best.symbol, payoutUsd: Number(formatEther(best.payout)) * ethUsd } : null,
  };
}
