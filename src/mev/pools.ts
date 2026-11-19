import { getAddress, zeroAddress, type Address } from 'viem';
import { ADDR, type TokenCfg } from '../config.js';
import { erc20Abi, factoryAbi, multicall3Abi, poolAbi, v2FactoryAbi, v2PairAbi } from '../chain.js';
import { bigMulticall, type McResult } from '../market.js';
import {
  NextVenueKind, PANCAKE_V3_FACTORY, PANCAKE_V3_FEES, UNISWAP_V4_MANAGER, pancakeV3PoolAbi,
  v4Candidates, v4FeeFraction, v4LiquidityRead, v4SlotRead, v4StateReads,
  type V4PoolDescriptor, type V4PoolSeed, type V4Slot0,
} from './next-pools.js';

const a = (x: string): Address => getAddress(x.toLowerCase());

/** Uniswap-v2-style venues (0.3% fee, same pair/callback interface). */
const V2_VENUES = [
  { venue: 'Uniswap v2', factory: a('0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f'), kind: NextVenueKind.UniswapV2 },
  { venue: 'SushiSwap', factory: a('0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac'), kind: NextVenueKind.SushiV2 },
];
const V3_FEES = [100, 500, 3000, 10000];
/** These factories deploy pools that call FlashArb's existing uniswapV3SwapCallback. */
const V3_VENUES = [
  { venue: 'Uniswap v3', factory: ADDR.uniFactory, fees: V3_FEES, kind: NextVenueKind.UniswapV3 },
  { venue: 'SushiSwap v3', factory: a('0xbACEB8eC6b9355Dfc0269C18bac9d6E2Bdc29C4F'), fees: V3_FEES, kind: NextVenueKind.SushiV3 },
];
const PANCAKE = { venue: 'PancakeSwap v3', factory: PANCAKE_V3_FACTORY, fees: PANCAKE_V3_FEES, kind: NextVenueKind.PancakeV3 };

/** Liquid tokens worth watching for arbitrage even though the trading strategy skips them (stablecoins). */
export const MEV_EXTRA_TOKENS: TokenCfg[] = [
  { symbol: 'USDC', address: ADDR.usdc, decimals: 6, core: true },
  { symbol: 'USDT', address: a('0xdAC17F958D2ee523a2206206994597C13D831ec7'), decimals: 6, core: true },
  { symbol: 'DAI', address: a('0x6B175474E89094C44Da98b954EedeAC495271d0F'), decimals: 18, core: true },
];

export interface ArbPool {
  address: Address; // V4 venues share the PoolManager address and have a unique PoolId.
  venue: string; // Includes the fee tier for concentrated-liquidity pools.
  v2: boolean;
  fee: number; // fraction per swap, e.g. 0.003
  kind?: NextVenueKind;
  v4?: V4PoolDescriptor;
  depthWeth?: number; // V4 uses virtual quote liquidity since PoolManager custody is shared.
}

export function poolVenue(pool: ArbPool): string {
  if (pool.v4) return 'Uniswap v4';
  if (pool.v2) return pool.venue === 'SushiSwap' ? 'SushiSwap v2' : pool.venue;
  return pool.venue.replace(/ \d+(?:\.\d+)?%$/, '');
}

export function poolIdentity(pool: ArbPool): string {
  return (pool.v4?.id ?? pool.address).toLowerCase();
}

export function toNextVenue(pool: ArbPool) {
  if (pool.kind === undefined) throw new Error('Unrecognized FlashArbV2 venue');
  return { kind: pool.kind, pool: pool.address, fee: pool.v4?.fee ?? Math.round(pool.fee * 1e6),
    tickSpacing: pool.v4?.tickSpacing ?? 0, nativeEth: pool.v4?.nativeEth ?? false };
}

export interface DiscoverArbOptions {
  includePancakeV3?: boolean;
  includeUniswapV4?: boolean;
  v4PoolKeys?: readonly V4PoolSeed[];
}

export interface ArbToken {
  token: TokenCfg;
  wethIs0: boolean; // WETH sorts before the token, so it is token0 in every pool of the pair
  pools: ArbPool[];
}

/** Reserves around the current price in whole units: exact for v2, virtual (inside the current tick range) for v3. */
export interface Reserves {
  w: number; // WETH
  t: number; // TOKEN
  buyFee?: number; // directional swap fee where it differs from the advertised LP tier
  sellFee?: number;
}

/**
 * Gas used by one arbitrage transaction, by route (pool A kind -> pool B kind), for the quick filter and paper mode.
 * Measured on a mainnet fork: 196k-258k (big v3 swaps cross many ticks). Live mode uses the exact estimate.
 */
export const ARB_GAS = { v3v3: 230_000, v3v2: 200_000, v2v3: 210_000, v2v2: 170_000 };
export function arbGas(A: ArbPool, B: ArbPool): number {
  const base = A.v2 ? (B.v2 ? ARB_GAS.v2v2 : ARB_GAS.v2v3) : B.v2 ? ARB_GAS.v3v2 : ARB_GAS.v3v3;
  // Provisional search estimate. Every live candidate still has to pass exact gas estimation and simulation.
  return base + [A, B].reduce((extra, pool) => extra + (pool.v4 ? (pool.v4.nativeEth ? 70_000 : 50_000) : 0), 0);
}

/**
 * Every WETH pool of each token on the supported canonical factories holding at least `minWeth`.
 * Only tokens with two or more such pools can be arbitraged. A few multicalls in total.
 */
export async function discoverArbPools(tokens: TokenCfg[], minWeth: number, options: DiscoverArbOptions = {}): Promise<ArbToken[]> {
  const seen = new Set<string>();
  const list = tokens.filter((t) => {
    const k = t.address.toLowerCase();
    if (k === ADDR.weth.toLowerCase() || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const v3Venues = options.includePancakeV3 ? [...V3_VENUES, PANCAKE] : V3_VENUES;
  type Lookup = { ti: number; venue: string; v2: boolean; fee: number; kind: NextVenueKind; call: object };
  const lookups: Lookup[] = [];
  list.forEach((t, ti) => {
    for (const v of v3Venues) {
      for (const fee of v.fees) {
        lookups.push({ ti, venue: `${v.venue} ${fee / 1e4}%`, v2: false, fee: fee / 1e6, kind: v.kind, call: { address: v.factory, abi: factoryAbi, functionName: 'getPool', args: [t.address, ADDR.weth, fee] } });
      }
    }
    for (const v of V2_VENUES) {
      lookups.push({ ti, venue: v.venue, v2: true, fee: 0.003, kind: v.kind, call: { address: v.factory, abi: v2FactoryAbi, functionName: 'getPair', args: [t.address, ADDR.weth] } });
    }
  });
  const found = await bigMulticall(lookups.map((l) => l.call), 800);
  if (found.filter((r) => r.status !== 'success').length > lookups.length * 0.02) throw new Error('RPC error while looking up arbitrage pools');
  const pools = lookups
    .map((l, i) => ({ ...l, address: (found[i].status === 'success' ? found[i].result : zeroAddress) as Address }))
    .filter((p) => p.address !== zeroAddress);

  // depth: WETH held by the pool; v3 pools also need in-range liquidity
  const depth = await bigMulticall(pools.flatMap((p) => [
    { address: ADDR.weth, abi: erc20Abi, functionName: 'balanceOf', args: [p.address] },
    p.v2 ? { address: p.address, abi: v2PairAbi, functionName: 'getReserves' } : { address: p.address, abi: poolAbi, functionName: 'liquidity' },
  ]));
  if (depth.filter((r) => r.status !== 'success').length > depth.length * 0.02) throw new Error('RPC error while checking arbitrage pool depth');
  const byToken = new Map<number, ArbPool[]>();
  pools.forEach((p, i) => {
    const bal = depth[2 * i];
    const second = depth[2 * i + 1];
    if (bal.status !== 'success' || second.status !== 'success') return;
    let wethDepth = bal.result as bigint;
    if (p.v2) {
      const [reserve0, reserve1] = second.result as readonly [bigint, bigint, number];
      if (reserve0 === 0n || reserve1 === 0n) return;
      const wethReserve = BigInt(ADDR.weth) < BigInt(list[p.ti].address) ? reserve0 : reserve1;
      if (wethReserve < wethDepth) wethDepth = wethReserve;
    } else if ((second.result as bigint) === 0n) return;
    const depthWeth = Number(wethDepth) / 1e18;
    if (depthWeth < minWeth) return;
    const arr = byToken.get(p.ti) ?? [];
    arr.push({ address: getAddress(p.address), venue: p.venue, v2: p.v2, fee: p.fee, kind: p.kind, depthWeth });
    byToken.set(p.ti, arr);
  });
  if (options.includeUniswapV4) await addV4Pools(list, minWeth, byToken, options.v4PoolKeys);
  const out: ArbToken[] = [];
  for (const [ti, ps] of byToken) {
    if (ps.length < 2) continue;
    const t = list[ti];
    out.push({ token: t, wethIs0: BigInt(ADDR.weth) < BigInt(t.address), pools: ps });
  }
  return out;
}

async function addV4Pools(tokens: TokenCfg[], minWeth: number, byToken: Map<number, ArbPool[]>, extra?: readonly V4PoolSeed[]) {
  const idx = new Map<string, number>(tokens.map((t, i) => [t.address.toLowerCase(), i]));
  const candidates = v4Candidates(tokens, extra);
  const prices = await bigMulticall(candidates.map(v4SlotRead), 320, 2);
  if (prices.filter((r) => r.status !== 'success').length > prices.length * 0.02) throw new Error('RPC error while checking Uniswap v4 pools');
  const initialized = candidates.flatMap((pool, i) => {
    if (prices[i]?.status !== 'success') return [];
    const [sqrtPriceX96, , , lpFee] = prices[i].result as V4Slot0;
    return sqrtPriceX96 > 0n && lpFee === pool.fee ? [{ pool, sqrtPriceX96 }] : [];
  });
  const liquidity = await bigMulticall(initialized.map(({ pool }) => v4LiquidityRead(pool)), 160, 2);
  if (liquidity.filter((r) => r.status !== 'success').length > liquidity.length * 0.02) throw new Error('RPC error while checking Uniswap v4 liquidity');
  for (const [i, { pool, sqrtPriceX96 }] of initialized.entries()) {
    if (liquidity[i]?.status !== 'success') continue;
    const reserves = virtualReserves(sqrtPriceX96, liquidity[i].result as bigint, pool.quoteIs0, 18);
    if (!reserves || reserves.w < minWeth) continue;
    const ti = idx.get(pool.token.toLowerCase());
    if (ti === undefined) continue;
    const arr = byToken.get(ti) ?? [];
    arr.push({ address: UNISWAP_V4_MANAGER, venue: `Uniswap v4 ${pool.nativeEth ? 'ETH' : 'WETH'} ${pool.fee / 1e4}%`, v2: false,
      fee: pool.fee / 1e6, kind: NextVenueKind.UniswapV4, v4: pool, depthWeth: reserves.w });
    byToken.set(ti, arr);
  }
}

/**
 * One multicall per block: block number, timestamp and the state of every watched pool.
 * (Not the base fee: RPC nodes run eth_call with BASEFEE = 0, so it comes from the block header instead.)
 */
export function buildStateReads(tokens: ArbToken[]) {
  const contracts: object[] = [
    { address: ADDR.multicall3, abi: multicall3Abi, functionName: 'getBlockNumber' },
    { address: ADDR.multicall3, abi: multicall3Abi, functionName: 'getCurrentBlockTimestamp' },
  ];
  const at: number[][] = tokens.map((t) => t.pools.map((p) => {
    const i = contracts.length;
    if (p.v2) contracts.push({ address: p.address, abi: v2PairAbi, functionName: 'getReserves' });
    else if (p.v4) contracts.push(...v4StateReads(p.v4));
    else {
      const abi = p.kind === NextVenueKind.PancakeV3 ? pancakeV3PoolAbi : poolAbi;
      contracts.push({ address: p.address, abi, functionName: 'slot0' }, { address: p.address, abi, functionName: 'liquidity' });
    }
    return i;
  }));
  return { contracts, at };
}

export function reservesOf(t: ArbToken, p: ArbPool, r: McResult[], i: number): Reserves | null {
  if (p.v2) {
    if (r[i]?.status !== 'success') return null;
    const [r0, r1] = r[i].result as readonly [bigint, bigint, number];
    const [rw, rt] = t.wethIs0 ? [r0, r1] : [r1, r0];
    if (rw === 0n || rt === 0n) return null;
    return { w: Number(rw) / 1e18, t: Number(rt) / (10 ** t.token.decimals) };
  }
  if (r[i]?.status !== 'success' || r[i + 1]?.status !== 'success') return null;
  const [sqrtPriceX96] = r[i].result as readonly [bigint, ...unknown[]];
  const liquidity = r[i + 1].result as bigint;
  if (!p.v4) return virtualReserves(sqrtPriceX96, liquidity, t.wethIs0, t.token.decimals);
  const [, , protocolFee, lpFee] = r[i].result as V4Slot0;
  if (lpFee !== p.v4.fee) return null;
  const reserves = virtualReserves(sqrtPriceX96, liquidity, p.v4.quoteIs0, t.token.decimals);
  if (!reserves) return null;
  return { ...reserves, buyFee: v4FeeFraction(protocolFee, lpFee, p.v4.quoteIs0), sellFee: v4FeeFraction(protocolFee, lpFee, !p.v4.quoteIs0) };
}

function virtualReserves(sqrtPriceX96: bigint, liquidity: bigint, quoteIs0: boolean, tokenDecimals: number): Reserves | null {
  const s = Number(sqrtPriceX96) / 2 ** 96; // sqrt(token1 per token0), raw units
  const L = Number(liquidity);
  if (!(s > 0) || !(L > 0)) return null;
  const x0 = L / s; // virtual token0 reserve (raw)
  const x1 = L * s; // virtual token1 reserve (raw)
  const [quote, token] = quoteIs0 ? [x0, x1] : [x1, x0];
  return { w: quote / 1e18, t: token / (10 ** tokenDecimals) };
}

export interface Cycle {
  buy: number; // pool index where TOKEN is bought with WETH
  sell: number; // pool index where TOKEN is sold for WETH
  dx: number; // optimal WETH in
  profit: number; // estimated WETH profit before gas
  gap: number; // marginal price gap after both pool fees (>0 = arbitrage exists)
}

/**
 * Best WETH -> TOKEN (pool `buy`) -> WETH (pool `sell`) cycle on constant-product reserves.
 * Two x*y=k swaps compose into out = K·dx / (C + D·dx); profit is maximal at dx* = (√(K·C) − C) / D.
 * For v3 pools this is an estimate (it ignores tick crossings); the exact on-chain simulation decides.
 */
export function bestCycle(pools: ArbPool[], res: (Reserves | null)[]): { gap: number; cycle: Cycle | null; cycles: Cycle[] } {
  let gapBest = -Infinity;
  let cycle: Cycle | null = null;
  const cycles: Cycle[] = [];
  for (let i = 0; i < pools.length; i++) {
    for (let j = 0; j < pools.length; j++) {
      const A = res[i];
      const B = res[j];
      if (i === j || !A || !B || poolIdentity(pools[i]) === poolIdentity(pools[j])) continue;
      const ga = 1 - (A.buyFee ?? pools[i].fee);
      const gb = 1 - (B.sellFee ?? pools[j].fee);
      const gap = (gb * (B.w / B.t)) / (A.w / A.t / ga) - 1;
      if (gap > gapBest) gapBest = gap;
      if (!(gap > 0)) continue;
      // Normalize by C and avoid subtracting nearly equal numbers when the spread is small.
      const relativeSlope = ga * (1 + gb * (A.t / B.t)) / A.w;
      const sqrtGap = gap / (Math.sqrt(1 + gap) + 1);
      const dx = sqrtGap / relativeSlope;
      const profit = dx * sqrtGap;
      if (!(dx > 0 && profit > 0 && Number.isFinite(profit))) continue;
      const route = { buy: i, sell: j, dx, profit, gap };
      cycles.push(route);
      if (!cycle || profit > cycle.profit) cycle = route;
    }
  }
  return { gap: gapBest, cycle, cycles };
}
