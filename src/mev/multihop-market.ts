import { encodeAbiParameters, getAddress, keccak256, parseAbi, parseAbiParameters, zeroAddress, type Abi, type Address, type Hex } from 'viem';
import { ADDR, type TokenCfg } from '../config.js';
import { erc20Abi, factoryAbi, mevPoolClient, multicall3Abi, poolAbi, v2FactoryAbi, v2PairAbi } from '../chain.js';
import { PANCAKE_V2_FACTORY, PANCAKE_V3_FACTORY, pancakeV3PoolAbi, UNISWAP_V4_MANAGER, UNISWAP_V4_STATE_VIEW, v4FeeFraction } from './next-pools.js';

const WETH = ADDR.weth;
const USDT = getAddress('0xdac17f958d2ee523a2206206994597c13d831ec7');
const WBTC = getAddress('0x2260fac5e5542a773aa44fbcfedf7c193bc2c599');
const DAI = getAddress('0x6b175474e89094c44da98b954eedeac495271d0f');
const DCTY = getAddress('0x5659250b7aac8f66701c7655da16070ecad6355e');
const v2Factories = [
  { kind: 0, factory: getAddress('0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f'), fee: 3000 },
  { kind: 1, factory: getAddress('0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac'), fee: 3000 },
  { kind: 6, factory: PANCAKE_V2_FACTORY, fee: 2500 },
] as const;
// Ethereum mainnet deployment registry: https://developers.uniswap.org/docs/protocols/v4/deployments
const V4_QUOTER = getAddress('0x99bd42b2b22e531f283b7f8a86dff631eb16a9d1');
const MORPHO = getAddress('0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb');
const fixedTokens = [
  { symbol: 'WETH', address: WETH }, { symbol: 'USDC', address: ADDR.usdc }, { symbol: 'USDT', address: USDT },
  { symbol: 'WBTC', address: WBTC },
  { symbol: 'DAI', address: DAI },
  { symbol: 'DCTY.5659', address: DCTY },
];
// https://github.com/sushiswap/v3-periphery/blob/master/deployments/ethereum/QuoterV2.json
// https://developer.pancakeswap.finance/contracts/v3/addresses
const v3Venues = {
  2: { factory: ADDR.uniFactory, quoter: ADDR.quoterV2 },
  3: { factory: getAddress('0xbaceb8ec6b9355dfc0269c18bac9d6e2bdc29c4f'), quoter: getAddress('0x64e8802fe490fa7cc61d3463958199161bb608a7') },
  4: { factory: PANCAKE_V3_FACTORY, quoter: getAddress('0xb048bbc1ee6b733fffcfb9e9cef7375518e25997') },
} as const;
// These fixed pair/tier combinations had active depth on Ethereum block 26469254.
// Their factory reads stay bounded when the rotating token inventory changes.
const additionalV3: { kind: 3 | 4; from: Address; to: readonly Address[]; fee: number }[] = [
  { kind: 3, from: WETH, to: [ADDR.usdc, USDT, WBTC, DAI], fee: 3000 },
  { kind: 3, from: ADDR.usdc, to: [USDT, DAI], fee: 100 },
  { kind: 4, from: WETH, to: [ADDR.usdc, USDT], fee: 100 },
  { kind: 4, from: WETH, to: [ADDR.usdc, USDT], fee: 500 },
  { kind: 4, from: WETH, to: [WBTC], fee: 2500 },
  { kind: 4, from: ADDR.usdc, to: [USDT, DAI], fee: 100 },
];
const tiers = [[100, 1], [500, 10], [3000, 60], [10000, 200]] as const;
const keyEncoding = parseAbiParameters('address,address,uint24,int24,address');
const stateAbi = parseAbi([
  'function getLiquidity(bytes32) view returns (uint128)',
  'function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)',
]);
const v3QuoteAbi = parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)']);
const v4QuoteAbi = parseAbi(['function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData)) returns (uint256,uint256)']);

export type PathToken = Pick<TokenCfg, 'address' | 'symbol'>;
export type PathReader = Pick<typeof mevPoolClient, 'multicall'>;
type Read = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] };
export interface EthereumPathHop { kind: 0 | 1 | 2 | 3 | 4 | 5 | 6; pool: Address; fee: number; tickSpacing: number; nativeEth: boolean; tokenOut: Address }
export function isPathV3(kind: EthereumPathHop['kind']): kind is 2 | 3 | 4 {
  return kind === 2 || kind === 3 || kind === 4;
}
export interface PathPool extends Omit<EthereumPathHop, 'tokenOut'> {
  token0: Address; token1: Address; id?: Hex;
}
export interface PathEdge {
  hop: EthereumPathHop;
  pool: PathPool;
  tokenIn: Address;
  reserveIn: bigint;
  reserveOut: bigint;
  fee: bigint;
  zeroForOne: boolean;
  // Marginal exchange rate, before fees. V3/V4 use the exact slot0 price.
  rateN: bigint;
  rateD: bigint;
}
const key = (p: PathPool) => ({
  currency0: p.nativeEth ? zeroAddress : p.token0, currency1: p.token1,
  fee: p.fee, tickSpacing: p.tickSpacing, hooks: zeroAddress,
});

export function pathTokens(block: bigint, active: readonly PathToken[]) {
  const known = new Set([...fixedTokens.map(t => t.address.toLowerCase()), zeroAddress]);
  const extra = active.filter(t => {
    const address = t.address.toLowerCase();
    if (known.has(address)) return false;
    known.add(address);
    return true;
  }).sort((a, b) => a.address.localeCompare(b.address));
  if (!extra.length) return fixedTokens;
  const start = Number((block / 32n) * 2n % BigInt(extra.length));
  return [...fixedTokens, ...Array.from({ length: Math.min(2, extra.length) }, (_, i) => {
    const t = extra[(start + i) % extra.length];
    return { symbol: t.symbol, address: getAddress(t.address) };
  })];
}

function v4(a: Address, b: Address, fee: number, tickSpacing: number, nativeEth: boolean): PathPool {
  // Logical native edges expose WETH to the executor, which wraps and unwraps atomically.
  const [token0, token1] = nativeEth ? [WETH, a === WETH ? b : a] : [a, b];
  const pool: PathPool = { kind: 5, pool: UNISWAP_V4_MANAGER, token0, token1, fee, tickSpacing, nativeEth };
  const k = key(pool);
  pool.id = keccak256(encodeAbiParameters(keyEncoding, [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
  return pool;
}

function probesFor(tokens: readonly PathToken[]) {
  const probes: { pool: PathPool; read: Read }[] = [];
  for (let i = 0; i < 3; i++) {
    for (const other of tokens.slice(i + 1)) {
      const [a, b] = [tokens[i].address, other.address].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
      const base = { token0: a, token1: b, tickSpacing: 0, nativeEth: false };
      for (const { kind, factory, fee } of v2Factories) {
        probes.push({ pool: { ...base, kind, fee, pool: zeroAddress },
          read: { address: factory, abi: v2FactoryAbi, functionName: 'getPair', args: [a, b] } });
      }
      const keys: PathPool[] = [];
      for (const [fee, spacing] of tiers) {
        probes.push({ pool: { ...base, kind: 2, fee, pool: zeroAddress },
          read: { address: v3Venues[2].factory, abi: factoryAbi, functionName: 'getPool', args: [a, b, fee] } });
        keys.push(v4(a, b, fee, spacing, false));
        if (i === 0) keys.push(v4(a, b, fee, spacing, true));
      }
      if (tokens[i].address === ADDR.usdc && other.address === USDT) keys.push(v4(a, b, 10, 1, false));
      // Verified hook-free stablecoin crossover pools observed in block 26468993.
      if (other.address === DCTY && i === 1) keys.push(v4(a, b, 47000, 470, false));
      if (other.address === DCTY && i === 2) keys.push(v4(a, b, 29995, 300, false), v4(a, b, 28802, 288, false));
      for (const pool of keys) probes.push({ pool, read: { address: UNISWAP_V4_STATE_VIEW, abi: stateAbi, functionName: 'getLiquidity', args: [pool.id] } });
    }
  }
  const included = new Set(tokens.map(t => t.address));
  for (const { kind, from, to, fee } of additionalV3) {
    for (const other of to) {
      if (!included.has(from) || !included.has(other)) continue;
      const [token0, token1] = BigInt(from) < BigInt(other) ? [from, other] : [other, from];
      probes.push({ pool: { kind, token0, token1, pool: zeroAddress, fee, tickSpacing: 0, nativeEth: false },
        read: { address: v3Venues[kind].factory, abi: factoryAbi, functionName: 'getPool', args: [token0, token1, fee] } });
    }
  }
  return probes;
}

export async function pinnedReads(client: PathReader, blockNumber: bigint, calls: Read[], chunkSize: number, deadlineMs: number, blockHash?: Hex) {
  if (!calls.length || Date.now() >= deadlineMs) return [];
  const chunks = Array.from({ length: Math.ceil(calls.length / chunkSize) }, (_, i) => calls.slice(i * chunkSize, (i + 1) * chunkSize));
  const pin = blockHash ? { blockHash, requireCanonical: true } as const : { blockNumber };
  const request = Promise.all(chunks.map(async (chunk) => {
    const rows = await client.multicall({ ...pin, batchSize: 0, allowFailure: true, contracts: [
      { address: ADDR.multicall3, abi: multicall3Abi, functionName: 'getBlockNumber' }, ...chunk,
    ] }).catch(() => []);
    if (rows.length !== chunk.length + 1 || rows[0]?.result !== blockNumber) return Array(chunk.length).fill(undefined);
    return rows.slice(1).map(row => row.result);
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<unknown[][]>(resolve => {
      timer = setTimeout(() => resolve([]), Math.max(0, deadlineMs - Date.now()));
    });
    const parts = await Promise.race([request, timeout]);
    // Flatten batches once: individual pool and quoter rows can themselves be tuples.
    return parts.flat();
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverPathPools(client: PathReader, block: bigint, tokens: readonly PathToken[], deadlineMs: number, blockHash?: Hex) {
  const probes = probesFor(tokens);
  const rows = await pinnedReads(client, block, probes.map(p => p.read), 64, deadlineMs, blockHash);
  const pools: PathPool[] = [];
  for (const [i, { pool }] of probes.entries()) {
    const result = rows[i];
    if (pool.kind === 5) {
      if (typeof result === 'bigint' && result > 0n) pools.push(pool);
    } else if (typeof result === 'string' && result !== zeroAddress) {
      pools.push({ ...pool, pool: getAddress(result) });
    }
  }
  return { pools, complete: rows.length === probes.length && rows.every(r => r !== undefined) };
}

export async function pathMarket(client: PathReader, block: bigint, pools: PathPool[], deadlineMs: number, blockHash?: Hex) {
  const calls: Read[] = [{ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [MORPHO] }];
  const indices = pools.map(pool => {
    const index = calls.length;
    if (!isPathV3(pool.kind) && pool.kind !== 5) calls.push({ address: pool.pool, abi: v2PairAbi, functionName: 'getReserves' });
    else if (isPathV3(pool.kind)) calls.push(...['slot0','liquidity'].map(functionName =>
      ({ address: pool.pool, abi: pool.kind === 4 ? pancakeV3PoolAbi : poolAbi, functionName })));
    else calls.push(...['getSlot0','getLiquidity'].map(functionName => ({ address: UNISWAP_V4_STATE_VIEW, abi: stateAbi, functionName, args: [pool.id] })));
    return index;
  });
  const rows = await pinnedReads(client, block, calls, 96, deadlineMs, blockHash);
  const edges: PathEdge[] = [];
  for (const [i, pool] of pools.entries()) {
    const index = indices[i];
    const state = rows[index];
    if (!Array.isArray(state) || typeof state[0] !== 'bigint' || state[0] <= 0n) continue;
    let r0: bigint, r1: bigint, rateN: bigint, rateD: bigint;
    if (!isPathV3(pool.kind) && pool.kind !== 5) {
      r0 = state[0]; r1 = state[1];
      if (typeof r1 !== 'bigint') continue;
      rateN = r1; rateD = r0;
    } else {
      const price = state[0], liquidity = rows[index + 1];
      if (typeof liquidity !== 'bigint' || liquidity <= 0n) continue;
      if (isPathV3(pool.kind) && state[6] !== true || pool.kind === 5 && (state[3] !== pool.fee || !Number.isInteger(state[2]))) continue;
      r0 = liquidity * (1n << 96n) / price;
      r1 = liquidity * price / (1n << 96n);
      rateN = price * price; rateD = 1n << 192n;
    }
    if (r0 <= 0n || r1 <= 0n) continue;
    for (const forward of [true, false]) {
      const tokenIn = forward ? pool.token0 : pool.token1;
      const tokenOut = forward ? pool.token1 : pool.token0;
      const { kind, fee, tickSpacing, nativeEth } = pool;
      edges.push({ hop: { kind, pool: pool.pool, fee, tickSpacing, nativeEth, tokenOut }, pool, tokenIn,
        reserveIn: forward ? r0 : r1, reserveOut: forward ? r1 : r0, zeroForOne: forward,
        rateN: forward ? rateN : rateD, rateD: forward ? rateD : rateN,
        fee: BigInt(kind === 5 ? Math.round(v4FeeFraction(state[2], fee, forward) * 1e6) : fee) });
    }
  }
  return { edges, available: typeof rows[0] === 'bigint' ? rows[0] : 0n, complete: rows.length === calls.length && rows.every(r => r !== undefined) };
}

export function directQuoteCall(edge: PathEdge, amount: bigint): Read {
  const hop = edge.hop;
  if (isPathV3(hop.kind)) return { address: v3Venues[hop.kind].quoter, abi: v3QuoteAbi, functionName: 'quoteExactInputSingle',
    args: [{ tokenIn: edge.tokenIn, tokenOut: hop.tokenOut, amountIn: amount, fee: hop.fee, sqrtPriceLimitX96: 0n }] };
  if (hop.kind !== 5) throw new Error('Only concentrated-liquidity path edges use an external quoter');
  return { address: V4_QUOTER, abi: v4QuoteAbi, functionName: 'quoteExactInputSingle',
    args: [{ poolKey: key(edge.pool), zeroForOne: edge.zeroForOne, exactAmount: amount, hookData: '0x' }] };
}
