import { encodeAbiParameters, getAddress, isAddress, keccak256, parseAbi, parseAbiParameters, zeroAddress, type Address, type Hex } from 'viem';
import { ADDR, type TokenCfg } from '../config.js';

// Ethereum mainnet deployments from the PancakeSwap and Uniswap developer docs.
export const PANCAKE_V3_FACTORY = getAddress('0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865');
export const PANCAKE_V2_FACTORY = getAddress('0x1097053fd2ea711dad45caccc45eff7548fcb362');
export const UNISWAP_V4_MANAGER = getAddress('0x000000000004444c5dc75cb358380d2e3de08a90');
export const UNISWAP_V4_STATE_VIEW = getAddress('0x7ffe42c4a5deea5b0fec41c94c136cf115597227');
export const PANCAKE_V3_FEES = [100, 500, 2500, 10_000];

/** Keep discriminants stable for both direct contracts and upgradeable logic. */
export const enum NextVenueKind {
  UniswapV2 = 0,
  SushiV2 = 1,
  UniswapV3 = 2,
  SushiV3 = 3,
  PancakeV3 = 4,
  UniswapV4 = 5,
  PancakeV2 = 6,
  CurveTricrypto = 7,
}

// Curve's Ethereum Tricrypto-NG deployment registry. The executor uses the same fixed pool list.
export const CURVE_TRICRYPTO_FACTORY = getAddress('0x0c0e5f2ff0ff18a3be9b835635039256dc4b4963');
const CURVE_USDC = getAddress('0x7f86bf177dd4f3494b841a37e810a34dd56c829b');
const CURVE_USDT = getAddress('0xf5f5b97624542d72a9e06f04804bf81baa15e2b4');
const USDT = getAddress('0xdac17f958d2ee523a2206206994597c13d831ec7');
const WBTC = getAddress('0x2260fac5e5542a773aa44fbcfedf7c193bc2c599');

export const curveTricryptoAbi = parseAbi([
  'function factory() view returns (address)',
  'function coins(uint256 index) view returns (address)',
  'function balances(uint256 index) view returns (uint256)',
  'function get_dy(uint256 from, uint256 to, uint256 amount) view returns (uint256)',
]);

export interface CurveTricryptoDescriptor {
  address: Address;
  token: Address;
  tokenIndex: bigint;
  sellProbes: readonly bigint[];
}

export const CURVE_WETH_INDEX = 2n;
export const CURVE_BUY_PROBES = [50_000_000_000_000_000n, 500_000_000_000_000_000n, 2n * 10n ** 18n, 10n * 10n ** 18n] as const;
const CURVE_STABLE_SELL_PROBES = [100_000_000n, 1_000_000_000n, 5_000_000_000n, 20_000_000_000n] as const;
const CURVE_BTC_SELL_PROBES = [200_000n, 1_000_000n, 5_000_000n, 25_000_000n] as const;

/** Each approved pool serves two WETH edges. Match registry entries by token address, never display symbol. */
export function curveTricryptoCandidates(tokens: readonly TokenCfg[]): CurveTricryptoDescriptor[] {
  const wanted = new Set<string>(tokens.map(({ address }) => address.toLowerCase()));
  const out: CurveTricryptoDescriptor[] = [];
  for (const { address, stable } of [{ address: CURVE_USDC, stable: ADDR.usdc }, { address: CURVE_USDT, stable: USDT }]) {
    if (wanted.has(stable.toLowerCase())) out.push({ address, token: stable, tokenIndex: 0n, sellProbes: CURVE_STABLE_SELL_PROBES });
    if (wanted.has(WBTC.toLowerCase())) out.push({ address, token: WBTC, tokenIndex: 1n, sellProbes: CURVE_BTC_SELL_PROBES });
  }
  return out;
}

export function curveStateReads(pool: CurveTricryptoDescriptor) {
  const read = (from: bigint, to: bigint, amount: bigint) => ({
    address: pool.address, abi: curveTricryptoAbi, functionName: 'get_dy', args: [from, to, amount],
  });
  return [
    ...CURVE_BUY_PROBES.map((amount) => read(CURVE_WETH_INDEX, pool.tokenIndex, amount)),
    ...pool.sellProbes.map((amount) => read(pool.tokenIndex, CURVE_WETH_INDEX, amount)),
  ];
}

// Pancake's protocol-fee field is uint32, not the uint8 used by Uniswap v3.
export const pancakeV3PoolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
]);

const stateViewAbi = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);

const poolKeyEncoding = parseAbiParameters('address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks');
const STATIC_V4_TIERS = [[100, 1], [500, 10], [3000, 60], [10_000, 200]] as const;

/** Only static-fee, hook-free native ETH/token or WETH/token pools are executable. */
export interface V4PoolSeed {
  token: Address;
  fee: number;
  tickSpacing: number;
  nativeEth: boolean;
}

// Nonstandard hook-free PoolManager keys verified through StateView on Ethereum at block 26454925.
const VERIFIED_V4_KEYS: readonly V4PoolSeed[] = [
  { token: '0xdAC17F958D2ee523a2206206994597C13D831ec7', fee: 9000, tickSpacing: 90, nativeEth: true }, // ETH / USDT
  { token: '0x50327c6c5a14DCaDE707ABad2E27eB517df87AB5', fee: 2500, tickSpacing: 25, nativeEth: true }, // ETH / WTRX
];

export interface V4PoolDescriptor extends V4PoolSeed {
  id: Hex;
  quoteIs0: boolean;
}

export function describeV4Pool(seed: V4PoolSeed): V4PoolDescriptor | null {
  if (typeof seed.token !== 'string' || !isAddress(seed.token, { strict: false }) || typeof seed.nativeEth !== 'boolean') return null;
  const token = getAddress(seed.token.toLowerCase());
  if (token === zeroAddress || token === ADDR.weth || !Number.isInteger(seed.fee) || seed.fee < 0 || seed.fee >= 1_000_000
      || !Number.isInteger(seed.tickSpacing) || seed.tickSpacing < 1 || seed.tickSpacing > 32_767) return null;
  const quote = seed.nativeEth ? zeroAddress : ADDR.weth;
  const quoteIs0 = BigInt(quote) < BigInt(token);
  const [currency0, currency1] = quoteIs0 ? [quote, token] : [token, quote];
  const id = keccak256(encodeAbiParameters(poolKeyEncoding, [currency0, currency1, seed.fee, seed.tickSpacing, zeroAddress]));
  return { ...seed, token, id, quoteIs0 };
}

/** Finite canonical StateView probes, including optional known static keys with nonstandard tier/spacing. */
export function v4Candidates(tokens: readonly TokenCfg[], extra: readonly V4PoolSeed[] = []): V4PoolDescriptor[] {
  const wanted = new Set<string>(tokens.map((entry) => entry.address.toLowerCase()));
  const out = new Map<Hex, V4PoolDescriptor>();
  function add(seed: V4PoolSeed) {
    const pool = describeV4Pool(seed);
    if (pool && wanted.has(pool.token.toLowerCase())) out.set(pool.id, pool);
  }
  for (const token of tokens) {
    for (const [fee, tickSpacing] of STATIC_V4_TIERS) {
      add({ token: token.address, fee, tickSpacing, nativeEth: true });
      add({ token: token.address, fee, tickSpacing, nativeEth: false });
    }
  }
  for (const seed of VERIFIED_V4_KEYS) add(seed);
  for (const seed of extra) add(seed);
  return [...out.values()];
}

export function v4SlotRead(pool: V4PoolDescriptor) {
  return { address: UNISWAP_V4_STATE_VIEW, abi: stateViewAbi, functionName: 'getSlot0', args: [pool.id] };
}

export function v4LiquidityRead(pool: V4PoolDescriptor) {
  return { address: UNISWAP_V4_STATE_VIEW, abi: stateViewAbi, functionName: 'getLiquidity', args: [pool.id] };
}

export const v4StateReads = (pool: V4PoolDescriptor) => [v4SlotRead(pool), v4LiquidityRead(pool)];

export type V4Slot0 = readonly [sqrtPriceX96: bigint, tick: number, protocolFee: number, lpFee: number];

/** ProtocolFeeLibrary charges the directional protocol fee first, then the LP fee on the remainder. */
export function v4FeeFraction(protocolFee: number, lpFee: number, zeroForOne: boolean): number {
  const directional = zeroForOne ? protocolFee & 0xfff : protocolFee >> 12;
  return (directional + lpFee - Math.floor(directional * lpFee / 1_000_000)) / 1_000_000;
}
