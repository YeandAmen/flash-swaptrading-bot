import { getAddress, zeroAddress, type Address } from 'viem';
import { ADDR, type TokenCfg } from '../config.js';
import { erc20Abi, factoryAbi, multicall3Abi, poolAbi, v2FactoryAbi, v2PairAbi } from '../chain.js';
import { bigMulticall, type McResult } from '../market.js';
import {
  AERO_CL_FACTORY, AERO_QUOTE_TOKENS, AERO_TICK_SPACING, aeroFactoryAbi, aeroPoolAbi,
  CURVE_BUY_PROBES, CURVE_TRICRYPTO_FACTORY, CURVE_WETH_INDEX, curveStateReads, curveTricryptoAbi, curveTricryptoCandidates,
  NextVenueKind, PANCAKE_V2_FACTORY, PANCAKE_V3_FACTORY, PANCAKE_V3_FEES, UNISWAP_V4_MANAGER, pancakeV3PoolAbi,
  v4Candidates, v4FeeFraction, v4LiquidityRead, v4SlotRead, v4StateReads,
  type CurveTricryptoDescriptor, type V4PoolDescriptor, type V4PoolSeed, type V4Slot0,
} from './next-pools.js';

const a = (x: string): Address => getAddress(x.toLowerCase());

/** Legacy Uniswap-v2-style venues (0.3% fee, same pair/callback interface). */
const V2_VENUES = [
  { venue: 'Uniswap v2', factory: a('0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f'), kind: NextVenueKind.UniswapV2, fee: 0.003 },
  { venue: 'SushiSwap', factory: a('0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac'), kind: NextVenueKind.SushiV2, fee: 0.003 },
];
const PANCAKE_V2 = { venue: 'PancakeSwap v2', factory: PANCAKE_V2_FACTORY, kind: NextVenueKind.PancakeV2, fee: 0.0025 };
const V3_FEES = [100, 500, 3000, 10000];
/** These factories deploy pools that call FlashArb's existing uniswapV3SwapCallback. */
const V3_VENUES = [
  { venue: 'Uniswap v3', factory: ADDR.uniFactory, fees: V3_FEES, kind: NextVenueKind.UniswapV3 },
  { venue: 'SushiSwap v3', factory: a('0xbACEB8eC6b9355Dfc0269C18bac9d6E2Bdc29C4F'), fees: V3_FEES, kind: NextVenueKind.SushiV3 },
];
const PANCAKE = { venue: 'PancakeSwap v3', factory: PANCAKE_V3_FACTORY, fees: PANCAKE_V3_FEES, kind: NextVenueKind.PancakeV3 };

/** Priority tokens for MEV discovery, independent of spot trading's token policy. */
export const MEV_EXTRA_TOKENS: TokenCfg[] = [
  { symbol: 'USDC', address: ADDR.usdc, decimals: 6, core: true },
  { symbol: 'USDT', address: a('0xdAC17F958D2ee523a2206206994597C13D831ec7'), decimals: 6, core: true },
  { symbol: 'DAI', address: a('0x6B175474E89094C44Da98b954EedeAC495271d0F'), decimals: 18, core: true },
  { symbol: 'wstETH', address: a('0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0'), decimals: 18, core: true },
  { symbol: 'rETH', address: a('0xae78736Cd615f374D3085123A210448E74Fc6393'), decimals: 18, core: true },
  { symbol: 'weETH', address: a('0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee'), decimals: 18, core: true },
  { symbol: 'cbETH', address: a('0xBe9895146f7AF43049ca1c1AE358B0541Ea49704'), decimals: 18, core: true },
  { symbol: 'cbBTC', address: a('0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf'), decimals: 8, core: true },
  { symbol: 'PENDLE', address: a('0x808507121b80c02388fad14726482e061b8da827'), decimals: 18, core: true },
  { symbol: 'ENA', address: a('0x57e114b691db790c35207b2e685d4a43181e6061'), decimals: 18, core: true },
  { symbol: 'CRV', address: a('0xd533a949740bb3306d119cc777fa900ba034cd52'), decimals: 18, core: true },
  { symbol: 'COMP', address: a('0xc00e94cb662c3520282e6f5717214004a7f26888'), decimals: 18, core: true },
  { symbol: 'WLD', address: a('0x163f8c2467924be0ae7b5347228cabf260318753'), decimals: 18, core: true },
  { symbol: '1INCH', address: a('0x111111111117dc0aa78b770fa6a738034120c302'), decimals: 18, core: true },
  { symbol: 'RPL', address: a('0xd33526068d116ce69f19a9ee46f0bd304f21a51f'), decimals: 18, core: true },
  { symbol: 'SUSHI', address: a('0x6b3595068778dd592e39a122f4f5a5cf09c90fe2'), decimals: 18, core: true },
  { symbol: 'WTRX', address: a('0x50327c6c5a14dcade707abad2e27eb517df87ab5'), decimals: 6, core: true },
];

export interface ArbPool {
  address: Address; // V4 venues share the PoolManager address and have a unique PoolId.
  venue: string; // Includes the fee tier for concentrated-liquidity pools.
  v2: boolean;
  fee: number; // fraction per swap, e.g. 0.003
  kind?: NextVenueKind;
  v4?: V4PoolDescriptor;
  curve?: CurveTricryptoDescriptor;
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
  if (pool.kind === undefined) throw new Error('Unrecognized FlashArb venue');
  if (pool.kind === NextVenueKind.AeroSlipstream) {
    return { kind: pool.kind, pool: pool.address, fee: 0, tickSpacing: AERO_TICK_SPACING, nativeEth: false };
  }
  return { kind: pool.kind, pool: pool.address, fee: pool.v4?.fee ?? Math.round(pool.fee * 1e6),
    tickSpacing: pool.v4?.tickSpacing ?? 0, nativeEth: pool.v4?.nativeEth ?? false };
}

export interface DiscoverArbOptions {
  includePancakeV2?: boolean;
  includePancakeV3?: boolean;
  includeUniswapV4?: boolean;
  includeCurve?: boolean;
  includeAero?: boolean;
  v4PoolKeys?: readonly V4PoolSeed[];
}

export interface ArbToken {
  token: TokenCfg;
  wethIs0: boolean; // WETH sorts before the token, so it is token0 in every pool of the pair
  pools: ArbPool[];
}

/** Reserves around the current price in whole units: exact for v2, virtual (inside the current tick range) for v3. */
interface ConstantProductReserves {
  w: number; // WETH
  t: number; // TOKEN
  buyFee?: number; // directional swap fee where it differs from the advertised LP tier
  sellFee?: number;
  curve?: never;
}

interface CurveReserves {
  curve: { buy: QuotePoint[]; sell: QuotePoint[] };
  buyFee?: never;
  sellFee?: never;
}

export type Reserves = ConstantProductReserves | CurveReserves;

interface QuotePoint { input: number; output: number }

/**
 * Gas used by one arbitrage transaction, by route (pool A kind -> pool B kind), for the quick filter and paper mode.
 * Measured on a mainnet fork: 196k-258k (big v3 swaps cross many ticks). Live mode uses the exact estimate.
 */
export const ARB_GAS = { v3v3: 230_000, v3v2: 200_000, v2v3: 210_000, v2v2: 170_000 };
export function arbGas(A: ArbPool, B: ArbPool): number {
  const base = A.v2 ? (B.v2 ? ARB_GAS.v2v2 : ARB_GAS.v2v3) : B.v2 ? ARB_GAS.v3v2 : ARB_GAS.v3v3;
  // Provisional search estimate. Every live candidate still has to pass exact gas estimation and simulation.
  return base + [A, B].reduce((extra, pool) => extra + (pool.v4 ? (pool.v4.nativeEth ? 70_000 : 50_000) : pool.curve ? 100_000 : 0), 0);
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
  const v2Venues = options.includePancakeV2 ? [...V2_VENUES, PANCAKE_V2] : V2_VENUES;
  const v3Venues = options.includePancakeV3 ? [...V3_VENUES, PANCAKE] : V3_VENUES;
  type Lookup = { ti: number; venue: string; v2: boolean; fee: number; kind: NextVenueKind; call: object };
  const lookups: Lookup[] = [];
  list.forEach((t, ti) => {
    for (const v of v3Venues) {
      for (const fee of v.fees) {
        lookups.push({ ti, venue: `${v.venue} ${fee / 1e4}%`, v2: false, fee: fee / 1e6, kind: v.kind, call: { address: v.factory, abi: factoryAbi, functionName: 'getPool', args: [t.address, ADDR.weth, fee] } });
      }
    }
    for (const v of v2Venues) {
      lookups.push({ ti, venue: v.venue, v2: true, fee: v.fee, kind: v.kind, call: { address: v.factory, abi: v2FactoryAbi, functionName: 'getPair', args: [t.address, ADDR.weth] } });
    }
  });
  const baseLookups = lookups.length;
  if (options.includeAero) for (const [ti, t] of list.entries()) {
    if (!AERO_QUOTE_TOKENS.has(t.address.toLowerCase())) continue;
    lookups.push({ ti, venue: 'Aero Slipstream', v2: false, fee: 0, kind: NextVenueKind.AeroSlipstream,
      call: { address: AERO_CL_FACTORY, abi: aeroFactoryAbi, functionName: 'getPool', args: [t.address, ADDR.weth, AERO_TICK_SPACING] } });
  }
  const found = await bigMulticall(lookups.map((l) => l.call), 800);
  // Optional Aero reads share these batches; they cannot invalidate discovery of the existing venues.
  if (found.slice(0, baseLookups).filter(r => r.status !== 'success').length > baseLookups * 0.02) throw new Error('RPC error while looking up arbitrage pools');
  const pools = lookups
    .map((l, i) => ({ ...l, address: (found[i].status === 'success' ? found[i].result : zeroAddress) as Address }))
    .filter((p) => p.address !== zeroAddress);

  // depth: WETH held by the pool; v3 pools also need in-range liquidity
  const depth = await bigMulticall(pools.flatMap((p) => [
    { address: ADDR.weth, abi: erc20Abi, functionName: 'balanceOf', args: [p.address] },
    p.v2 ? { address: p.address, abi: v2PairAbi, functionName: 'getReserves' }
      : { address: p.address, abi: p.kind === NextVenueKind.AeroSlipstream ? aeroPoolAbi : poolAbi, functionName: 'liquidity' },
  ]));
  const baseDepthReads = 2 * pools.filter(p => p.kind !== NextVenueKind.AeroSlipstream).length;
  if (depth.slice(0, baseDepthReads).filter(r => r.status !== 'success').length > baseDepthReads * 0.02) throw new Error('RPC error while checking arbitrage pool depth');
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
  if (options.includeCurve) await addCurvePools(list, minWeth, byToken);
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

/** Verify the fixed allowlist's on-chain coin ordering and available WETH before scanning per-block quotes. */
async function addCurvePools(tokens: TokenCfg[], minWeth: number, byToken: Map<number, ArbPool[]>) {
  const candidates = curveTricryptoCandidates(tokens);
  const reads = await bigMulticall(candidates.flatMap((pool) => [
    { address: pool.address, abi: curveTricryptoAbi, functionName: 'coins', args: [CURVE_WETH_INDEX] },
    { address: pool.address, abi: curveTricryptoAbi, functionName: 'coins', args: [pool.tokenIndex] },
    { address: pool.address, abi: curveTricryptoAbi, functionName: 'balances', args: [CURVE_WETH_INDEX] },
    { address: pool.address, abi: curveTricryptoAbi, functionName: 'factory' },
  ]));
  for (const [i, pool] of candidates.entries()) {
    const [weth, token, balance, factory] = reads.slice(4 * i, 4 * i + 4);
    if (weth?.status !== 'success' || token?.status !== 'success' || balance?.status !== 'success'
      || factory?.status !== 'success' || String(factory.result).toLowerCase() !== CURVE_TRICRYPTO_FACTORY.toLowerCase()
      || String(weth.result).toLowerCase() !== ADDR.weth.toLowerCase()
      || String(token.result).toLowerCase() !== pool.token.toLowerCase()) continue;
    const depthWeth = Number(balance.result) / 1e18;
    const ti = tokens.findIndex((t) => t.address.toLowerCase() === pool.token.toLowerCase());
    if (ti < 0 || !Number.isFinite(depthWeth) || depthWeth < minWeth) continue;
    const arr = byToken.get(ti) ?? [];
    arr.push({ address: pool.address, venue: 'Curve Tricrypto-NG', v2: false, fee: 0, kind: NextVenueKind.CurveTricrypto, curve: pool, depthWeth });
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
    else if (p.curve) contracts.push(...curveStateReads(p.curve));
    else if (p.kind === NextVenueKind.AeroSlipstream) {
      for (const functionName of ['slot0', 'liquidity', 'fee']) contracts.push({ address: p.address, abi: aeroPoolAbi, functionName });
    } else {
      const abi = p.kind === NextVenueKind.PancakeV3 ? pancakeV3PoolAbi : poolAbi;
      contracts.push({ address: p.address, abi, functionName: 'slot0' }, { address: p.address, abi, functionName: 'liquidity' });
    }
    return i;
  }));
  return { contracts, at };
}

/** Ignore fees, impact, debt and gas: even selling the entire v4 inventory at v2 spot must cover the net floor. */
export function inventoryCanCoverV2Floor(balance: bigint | undefined, reserves: McResult | undefined,
  wethIs0: boolean, floor: bigint): boolean {
  if (balance === undefined || balance < 0n || floor <= 0n || reserves?.status !== 'success' || !Array.isArray(reserves.result)) return true;
  const [r0, r1] = reserves.result;
  if (typeof r0 !== 'bigint' || typeof r1 !== 'bigint' || r0 <= 0n || r1 <= 0n) return true;
  const [weth, token] = wethIs0 ? [r0, r1] : [r1, r0];
  return balance * weth >= floor * token;
}

/** A fee-free sale of the entire entry inventory at the exit's starting price bounds every trade size. */
export function inventoryCanCoverExitFloor(balance: bigint | undefined, exit: ArbPool, state: McResult | undefined,
  wethIs0: boolean, floor: bigint): boolean {
  if (balance === undefined || balance < 0n || floor <= 0n || exit.curve || state?.status !== 'success'
    || !Array.isArray(state.result)) return true;
  if (exit.v2) {
    if (exit.kind !== NextVenueKind.UniswapV2 && exit.kind !== NextVenueKind.SushiV2 && exit.kind !== NextVenueKind.PancakeV2) return true;
    return inventoryCanCoverV2Floor(balance, state, wethIs0, floor);
  }
  let quoteIs0 = wethIs0;
  if (exit.kind === NextVenueKind.UniswapV4) {
    // Discovery constructs these descriptors from static-fee, zero-hook keys.
    if (!exit.v4 || exit.address.toLowerCase() !== UNISWAP_V4_MANAGER.toLowerCase() || state.result[3] !== exit.v4.fee) return true;
    quoteIs0 = exit.v4.quoteIs0;
  } else {
    if (exit.v4 || state.result[6] !== true || (exit.kind !== NextVenueKind.UniswapV3
      && exit.kind !== NextVenueKind.SushiV3 && exit.kind !== NextVenueKind.PancakeV3)) return true;
  }
  const sqrtPriceX96 = state.result[0];
  // TickMath permits prices from MIN_SQRT_RATIO inclusive to MAX_SQRT_RATIO exclusive.
  if (typeof sqrtPriceX96 !== 'bigint' || sqrtPriceX96 < 4295128739n
    || sqrtPriceX96 >= 1461446703485210103287273052203988822378723970342n) return true;
  const square = sqrtPriceX96 * sqrtPriceX96;
  const q192 = 1n << 192n;
  return quoteIs0 ? balance * q192 >= floor * square : balance * square >= floor * q192;
}

function measuredQuotes(probes: readonly bigint[], reads: McResult[], offset: number, inputScale: number, outputScale: number) {
  const points: QuotePoint[] = [];
  for (const [index, amount] of probes.entries()) {
    const quote = reads[offset + index];
    if (quote?.status !== 'success') continue;
    const output = Number(quote.result) / outputScale;
    if (!(output > (points.at(-1)?.output ?? 0) && Number.isFinite(output))) continue;
    points.push({ input: Number(amount) / inputScale, output });
  }
  return points;
}

export function reservesOf(t: ArbToken, p: ArbPool, r: McResult[], i: number): Reserves | null {
  if (p.curve) {
    const tokenScale = 10 ** t.token.decimals;
    const buy = measuredQuotes(CURVE_BUY_PROBES, r, i, 1e18, tokenScale);
    const sell = measuredQuotes(p.curve.sellProbes, r, i + CURVE_BUY_PROBES.length, tokenScale, 1e18);
    return buy.length && sell.length ? { curve: { buy, sell } } : null;
  }
  if (p.v2) {
    if (r[i]?.status !== 'success') return null;
    const [r0, r1] = r[i].result as readonly [bigint, bigint, number];
    const [rw, rt] = t.wethIs0 ? [r0, r1] : [r1, r0];
    if (rw === 0n || rt === 0n) return null;
    return { w: Number(rw) / 1e18, t: Number(rt) / (10 ** t.token.decimals) };
  }
  if (r[i]?.status !== 'success' || r[i + 1]?.status !== 'success') return null;
  const slot = r[i].result;
  if (!Array.isArray(slot)) return null;
  const [sqrtPriceX96] = slot;
  const liquidity = r[i + 1].result as bigint;
  if (p.kind === NextVenueKind.AeroSlipstream) {
    const fee = r[i + 2];
    if (slot[5] !== true || typeof sqrtPriceX96 !== 'bigint'
      || typeof liquidity !== 'bigint' || fee?.status !== 'success' || typeof fee.result !== 'number'
      || !Number.isInteger(fee.result) || fee.result < 0 || fee.result >= 1_000_000) return null;
    const reserves = virtualReserves(sqrtPriceX96, liquidity, t.wethIs0, t.token.decimals);
    // fee() is a current pre-swap hint. The exact proxy call also applies the hook's actual transaction context.
    return reserves && { ...reserves, buyFee: fee.result / 1e6, sellFee: fee.result / 1e6 };
  }
  if (!p.v4) return virtualReserves(sqrtPriceX96, liquidity, t.wethIs0, t.token.decimals);
  const [, , protocolFee, lpFee] = r[i].result as V4Slot0;
  if (lpFee !== p.v4.fee) return null;
  const reserves = virtualReserves(sqrtPriceX96, liquidity, p.v4.quoteIs0, t.token.decimals);
  if (!reserves) return null;
  return { ...reserves, buyFee: v4FeeFraction(protocolFee, lpFee, p.v4.quoteIs0), sellFee: v4FeeFraction(protocolFee, lpFee, !p.v4.quoteIs0) };
}

function virtualReserves(sqrtPriceX96: bigint, liquidity: bigint, quoteIs0: boolean, tokenDecimals: number): ConstantProductReserves | null {
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

/** Estimate only inside the measured range. Reverse interpolation maps sell knots back to WETH input. */
function interpolate(points: readonly QuotePoint[], amount: number, reverse = false): number {
  let priorIn = 0;
  let priorOut = 0;
  for (const point of points) {
    const [input, output] = reverse ? [point.output, point.input] : [point.input, point.output];
    if (amount <= input * (1 + 1e-12)) return priorOut + (Math.min(amount, input) - priorIn) * (output - priorOut) / (input - priorIn);
    priorIn = input;
    priorOut = output;
  }
  return 0;
}

function sellForWeth(exit: Reserves, keep: number, tokens: number): number {
  return exit.curve ? interpolate(exit.curve.sell, tokens) : exit.w * keep * tokens / (exit.t + keep * tokens);
}

/** Use measured Curve inputs to propose one interior principal for an exact proxy simulation. */
export function curveBuyRefinement(buy: readonly QuotePoint[], exit: Reserves, exitFee: number, baselineProfit: number): bigint | undefined {
  if (buy.length < 3 || exit.curve || !(exit.w > 0 && exit.t > 0) || !(baselineProfit > 0)) return;
  const keep = 1 - (exit.sellFee ?? exitFee);
  if (!(keep > 0 && keep <= 1)) return;
  let previousSize = 0, previousTokens = 0, previousProfit = 0, previousSlope = Infinity;
  let bestSize = 0, bestProfit = baselineProfit;
  for (const { input, output } of buy) {
    if (!(input > previousSize && output > previousTokens)) return;
    const profit = sellForWeth(exit, keep, output) - input;
    const slope = (profit - previousProfit) / (input - previousSize);
    if (!Number.isFinite(slope) || slope > previousSlope) return;
    if (previousSize > 0) {
      // Fit profit(x) = linear*x - curvature*x² through zero and adjacent measured knot payouts.
      const leftRate = previousProfit / previousSize;
      const curvature = (leftRate - profit / input) / (input - previousSize);
      if (curvature > 0) {
        const linear = leftRate + curvature * previousSize;
        const peak = linear / (2 * curvature);
        const payout = peak * linear / 2;
        if (peak > previousSize && peak < input && Number.isFinite(payout) && payout > bestProfit) {
          bestSize = peak;
          bestProfit = payout;
        }
      }
    }
    previousSize = input;
    previousTokens = output;
    previousProfit = profit;
    previousSlope = slope;
  }
  // Require the measured payout to have turned down; a rising edge alone cannot bracket a maximum.
  const wei = Math.floor(bestSize * 1e18);
  return previousSlope < 0 && Number.isFinite(wei) && wei > 0 ? BigInt(wei) : undefined;
}

function getMeasuredCycle(pools: ArbPool[], a: Reserves, b: Reserves, buy: number, sell: number): { gapBest: number; cycle: Cycle | null } {
  const ga = 1 - (a.buyFee ?? pools[buy].fee);
  const gb = 1 - (b.sellFee ?? pools[sell].fee);
  const knots = a.curve?.buy.map((point) => point.input) ?? [];
  for (const { input } of b.curve?.sell ?? []) {
    const dx = a.curve ? interpolate(a.curve.buy, input, true) : a.w * input / (ga * (a.t - input));
    if (dx > 0 && Number.isFinite(dx)) knots.push(dx);
  }
  knots.sort((x, y) => x - y);
  let previous = 0;
  let gapBest = -Infinity;
  let cycle: Cycle | null = null;
  function quote(dx: number) {
    const tokens = a.curve ? interpolate(a.curve.buy, dx) : a.t * ga * dx / (a.w + ga * dx);
    if (!(tokens > 0)) return;
    const weth = sellForWeth(b, gb, tokens);
    if (!(weth > 0)) return;
    const profit = weth - dx;
    const gap = profit / dx;
    gapBest = Math.max(gapBest, gap);
    if (profit > 0 && (!cycle || profit > cycle.profit)) cycle = { buy, sell, dx, profit, gap };
  }
  for (const input of knots) {
    if (input <= previous) continue;
    quote((previous + input) / 2);
    quote(input);
    previous = input;
  }
  return { gapBest, cycle };
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
      if (A.curve || B.curve) {
        const measured = getMeasuredCycle(pools, A, B, i, j);
        gapBest = Math.max(gapBest, measured.gapBest);
        if (measured.cycle) {
          cycles.push(measured.cycle);
          if (!cycle || measured.cycle.profit > cycle.profit) cycle = measured.cycle;
        }
        continue;
      }
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
