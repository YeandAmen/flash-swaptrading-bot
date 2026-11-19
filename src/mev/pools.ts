import { getAddress, zeroAddress, type Address } from 'viem';
import { ADDR, type TokenCfg } from '../config.js';
import { erc20Abi, factoryAbi, multicall3Abi, poolAbi, v2FactoryAbi, v2PairAbi } from '../chain.js';
import { bigMulticall, type McResult } from '../market.js';

const a = (x: string): Address => getAddress(x.toLowerCase());

/** Uniswap-v2-style venues (0.3% fee, same pair/callback interface). */
const V2_VENUES = [
  { venue: 'Uniswap v2', factory: a('0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f') },
  { venue: 'SushiSwap', factory: a('0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac') },
];
const V3_FEES = [100, 500, 3000, 10000];

/** Liquid tokens worth watching for arbitrage even though the trading strategy skips them (stablecoins). */
export const MEV_EXTRA_TOKENS: TokenCfg[] = [
  { symbol: 'USDC', address: ADDR.usdc, decimals: 6, core: true },
  { symbol: 'USDT', address: a('0xdAC17F958D2ee523a2206206994597C13D831ec7'), decimals: 6, core: true },
  { symbol: 'DAI', address: a('0x6B175474E89094C44Da98b954EedeAC495271d0F'), decimals: 18, core: true },
];

export interface ArbPool {
  address: Address;
  venue: string; // "Uniswap v3 0.3%", "Uniswap v2", "SushiSwap"
  v2: boolean;
  fee: number; // fraction per swap, e.g. 0.003
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
}

/**
 * Gas used by one arbitrage transaction, by route (pool A kind -> pool B kind), for the quick filter and paper mode.
 * Measured on a mainnet fork: 196k-258k (big v3 swaps cross many ticks). Live mode uses the exact estimate.
 */
export const ARB_GAS = { v3v3: 230_000, v3v2: 200_000, v2v3: 210_000, v2v2: 170_000 };
export const arbGas = (A: ArbPool, B: ArbPool) =>
  A.v2 ? (B.v2 ? ARB_GAS.v2v2 : ARB_GAS.v2v3) : B.v2 ? ARB_GAS.v3v2 : ARB_GAS.v3v3;

/**
 * Every WETH pool of each token on Uniswap v3 (all fee tiers), Uniswap v2 and SushiSwap holding at least `minWeth`.
 * Only tokens with two or more such pools can be arbitraged. A few multicalls in total.
 */
export async function discoverArbPools(tokens: TokenCfg[], minWeth: number): Promise<ArbToken[]> {
  const seen = new Set<string>();
  const list = tokens.filter((t) => {
    const k = t.address.toLowerCase();
    if (t.address === ADDR.weth || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  type Lookup = { ti: number; venue: string; v2: boolean; fee: number; call: object };
  const lookups: Lookup[] = [];
  list.forEach((t, ti) => {
    for (const fee of V3_FEES) {
      lookups.push({ ti, venue: `Uniswap v3 ${fee / 1e4}%`, v2: false, fee: fee / 1e6, call: { address: ADDR.uniFactory, abi: factoryAbi, functionName: 'getPool', args: [t.address, ADDR.weth, fee] } });
    }
    for (const v of V2_VENUES) {
      lookups.push({ ti, venue: v.venue, v2: true, fee: 0.003, call: { address: v.factory, abi: v2FactoryAbi, functionName: 'getPair', args: [t.address, ADDR.weth] } });
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
  const byToken = new Map<number, ArbPool[]>();
  pools.forEach((p, i) => {
    const bal = depth[2 * i];
    const second = depth[2 * i + 1];
    if (bal.status !== 'success' || second.status !== 'success') return;
    if (Number(bal.result as bigint) / 1e18 < minWeth) return;
    if (!p.v2 && (second.result as bigint) === 0n) return;
    const arr = byToken.get(p.ti) ?? [];
    arr.push({ address: getAddress(p.address), venue: p.venue, v2: p.v2, fee: p.fee });
    byToken.set(p.ti, arr);
  });
  const out: ArbToken[] = [];
  for (const [ti, ps] of byToken) {
    if (ps.length < 2) continue;
    const t = list[ti];
    out.push({ token: t, wethIs0: BigInt(ADDR.weth) < BigInt(t.address), pools: ps });
  }
  return out;
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
    else contracts.push({ address: p.address, abi: poolAbi, functionName: 'slot0' }, { address: p.address, abi: poolAbi, functionName: 'liquidity' });
    return i;
  }));
  return { contracts, at };
}

export function reservesOf(t: ArbToken, p: ArbPool, r: McResult[], i: number): Reserves | null {
  const dT = 10 ** t.token.decimals;
  if (p.v2) {
    if (r[i]?.status !== 'success') return null;
    const [r0, r1] = r[i].result as readonly [bigint, bigint, number];
    const [rw, rt] = t.wethIs0 ? [r0, r1] : [r1, r0];
    if (rw === 0n || rt === 0n) return null;
    return { w: Number(rw) / 1e18, t: Number(rt) / dT };
  }
  if (r[i]?.status !== 'success' || r[i + 1]?.status !== 'success') return null;
  const s = Number((r[i].result as readonly [bigint, ...unknown[]])[0]) / 2 ** 96; // sqrt(token1 per token0), raw units
  const L = Number(r[i + 1].result as bigint);
  if (!(s > 0) || !(L > 0)) return null;
  const x0 = L / s; // virtual token0 reserve (raw)
  const x1 = L * s; // virtual token1 reserve (raw)
  return t.wethIs0 ? { w: x0 / 1e18, t: x1 / dT } : { w: x1 / 1e18, t: x0 / dT };
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
export function bestCycle(pools: ArbPool[], res: (Reserves | null)[]): { gap: number; cycle: Cycle | null } {
  let gapBest = -Infinity;
  let cycle: Cycle | null = null;
  for (let i = 0; i < pools.length; i++) {
    for (let j = 0; j < pools.length; j++) {
      const A = res[i];
      const B = res[j];
      if (i === j || !A || !B) continue;
      const ga = 1 - pools[i].fee;
      const gb = 1 - pools[j].fee;
      const gap = (gb * (B.w / B.t)) / (A.w / A.t / ga) - 1;
      if (gap > gapBest) gapBest = gap;
      const K = ga * gb * A.t * B.w;
      const C = A.w * B.t;
      const D = ga * (B.t + gb * A.t);
      if (!(K > C) || !(D > 0)) continue;
      const dx = (Math.sqrt(K * C) - C) / D;
      const profit = (K * dx) / (C + D * dx) - dx;
      if (dx > 0 && Number.isFinite(profit) && (!cycle || profit > cycle.profit)) cycle = { buy: i, sell: j, dx, profit, gap };
    }
  }
  return { gap: gapBest, cycle };
}
