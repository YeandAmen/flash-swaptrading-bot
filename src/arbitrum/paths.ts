import { formatUnits, parseAbi, zeroAddress, type Address } from 'viem';
import { loanLimitWei, MAX_FLASH_LOAN_WEI } from '../mev/cadence.js';
import { minimumNetInAsset, requiredGrossPayout } from './profit.js';
import type { ArbitrumClient } from './market.js';

const weth: Address = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const usdc: Address = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const arb: Address = '0x912ce59144191c1204e64559fe8253a0e49e6548';
const usdg: Address = '0x004b506865409877c9fa29bfb1eba929984b9bbc';
const morpho = '0x6c247b1f6182318877311737bac0844baa518f5e';
const usdcUsdFeed = '0x50834f3163758fcc1df9973b6e91f0f0f0434ad3';
const uniFactory: Address = '0x1f98431c8ad98523631ae4a59f267346ea31f984';
const aeroFactory: Address = '0x88a60ee77392577c355c0acb2a8d476d5a4ec03a';
const uniQuoter = '0x61ffe014ba17989e743c5f6cb21bf9697530b21e';
const aeroQuoter = '0x1ddfec5058180c207f55bb77d95acdd0d8227868';
const uniFactoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const aeroFactoryAbi = parseAbi(['function getPool(address,address,int24) view returns (address)']);
const poolAbi = parseAbi(['function slot0() view returns (uint160 sqrtPriceX96)', 'function liquidity() view returns (uint128)']);
const balanceAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);
const clockAbi = parseAbi(['function getCurrentBlockTimestamp() view returns (uint256)']);
const feedAbi = parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']);
const uniQuoteAbi = parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)']);
const aeroQuoteAbi = parseAbi(['function quoteExactInputSingleV3(address pool,address tokenIn,uint256 amountIn,uint160 sqrtPriceLimitX96) returns (uint256,uint160,uint32)']);
const assets = [weth, usdc, arb, usdg] as const;
const symbols = new Map<Address, string>([[weth, 'WETH'], [usdc, 'USDC'], [arb, 'ARB'], [usdg, 'USDG']]);
type Pool = { kind: 2 | 6; pool: Address; token0: Address; token1: Address; tier: number };
type Edge = { pool: Pool; input: Address; output: Address; rate: number; inputDepth: number };
type Trial = { path: Edge[]; asset: Address; symbol: 'WETH' | 'USDC'; usd: number; decimals: number; minimumGross: bigint; amountIn: bigint; out: bigint };
const marketCache = new WeakMap<ArbitrumClient, { block: bigint; pools: Pool[] }>();
export type ArbPathLeg = { kind: 2 | 6; pool: Address; tokenOut: Address; tickSpacing: number };
export interface ArbPathQuote {
  asset: Address; symbol: 'WETH' | 'USDC'; decimals: number; assetUsd: number;
  amountIn: bigint; payout: bigint; legs: ArbPathLeg[]; block: bigint;
  loanUsd: number; payoutUsd: number; label: string;
}

async function discoverPathPools(client: ArbitrumClient, block: bigint) {
  const cached = marketCache.get(client);
  if (cached && block >= cached.block && block - cached.block < 1_000n) return cached.pools;
  const keys: Omit<Pool, 'pool'>[] = [];
  for (const [i, a] of assets.entries()) for (const b of assets.slice(i + 1)) {
    const [token0, token1] = a < b ? [a, b] : [b, a];
    for (const tier of [100, 500, 3000, 10_000]) keys.push({ kind: 2, token0, token1, tier });
    for (const tier of [1, 10, 50, 100]) keys.push({ kind: 6, token0, token1, tier });
  }
  const rows = await client.multicall({ blockNumber: block, contracts: keys.map(({ token0, token1, kind, tier }) => ({
    address: kind === 2 ? uniFactory : aeroFactory, abi: kind === 2 ? uniFactoryAbi : aeroFactoryAbi,
    functionName: 'getPool' as const, args: [token0, token1, tier] as const,
  })) });
  const unique = new Set<string>();
  const pools = keys.flatMap((key, i) => {
    const pool = rows[i]?.result?.toLowerCase() as Address | undefined;
    if (!pool || pool === zeroAddress || unique.has(pool)) return [];
    unique.add(pool);
    return [{ ...key, pool }];
  });
  if (pools.length && rows.every((r) => r.status === 'success')) marketCache.set(client, { pools, block });
  return pools;
}

function pathCandidates(base: Address, edges: Edge[]) {
  const cycles: Edge[][] = [];
  const walk = (current: Address, path: Edge[], seen: Set<Address>, rate: number) => {
    for (const edge of edges) {
      if (edge.input !== current || path.some((step) => step.pool.pool === edge.pool.pool)) continue;
      const next = [...path, edge];
      const margin = rate * edge.rate;
      if (edge.output === base) {
        if (next.length >= 3 && margin >= 1 - 1e-10) cycles.push(next);
      } else if (next.length < 4 && !seen.has(edge.output)) {
        walk(edge.output, next, new Set([...seen, edge.output]), margin);
      }
    }
  };
  walk(base, [], new Set([base]), 1);
  return cycles;
}

// Estimate price impact from the virtual input reserve in the active tick. Crossing
// initialized ticks changes liquidity, so the pinned DEX quote still decides each payout.
function shortlist(cycles: Edge[][], amount: bigint, block: bigint) {
  const ranked = cycles.map((path) => {
    const out = path.reduce((input, edge) => input * edge.rate / (1 + input / edge.inputDepth), Number(amount));
    return { path, out, tokens: path.map((edge) => edge.output).join('/') };
  }).sort((a, b) => b.out - a.out);
  if (ranked.length <= 4) return ranked;

  const selected = ranked.slice(0, 2);
  // Reserve one slot for a different token sequence when it quotes within 50 bps
  // of the best model. Rotate the last slot among similarly priced alternatives.
  const plausible = ranked.slice(2).filter((r) => r.out >= ranked[0].out * 0.995);
  selected.push(plausible.find((r) => selected.every((s) => s.tokens !== r.tokens)) ?? ranked[2]);
  const others = plausible.filter((r) => !selected.includes(r));
  selected.push(others.length ? others[Number(block % BigInt(others.length))] : ranked.find((r) => !selected.includes(r))!);
  return selected;
}

function quoteLeg(edge: Edge, amount: bigint) {
  const { pool, input, output } = edge;
  if (pool.kind === 6) return { address: aeroQuoter, abi: aeroQuoteAbi, functionName: 'quoteExactInputSingleV3',
    args: [pool.pool, input, amount, 0n] } as const;
  return { address: uniQuoter, abi: uniQuoteAbi, functionName: 'quoteExactInputSingle',
    args: [{ tokenIn: input, tokenOut: output, amountIn: amount, fee: pool.tier, sqrtPriceLimitX96: 0n }] } as const;
}

async function optionalQuotes<T>(request: Promise<T[]>, deadline: number): Promise<T[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request.catch(() => []), new Promise<T[]>(resolve => {
      timer = setTimeout(() => resolve([]), Math.max(0, deadline - Date.now()));
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function refineSizes(completed: Trial[], baseline: Trial[]) {
  const bestExact = new Map<Address, bigint>();
  for (const t of completed) {
    const payout = t.out - t.amountIn;
    if (payout > (bestExact.get(t.asset) ?? 0n)) bestExact.set(t.asset, payout);
  }
  const previous = new Map<Edge[], Trial>();
  const best = new Map<Address, { trial: Trial; estimated: bigint }>();
  // Samples of each exact pool sequence arrive in ascending loan order.
  for (const upper of completed) {
    const lower = previous.get(upper.path);
    previous.set(upper.path, upper);
    if (!lower) continue;
    const x = lower.amountIn, y = upper.amountIn;
    const p = lower.out - x, q = upper.out - y;
    // Fit payout(s) = a*s - b*s² through zero and the two exact payouts.
    // The common denominator is x*y*(y-x). Only test an interior maximum.
    const b = p * y - q * x;
    if (b <= 0n || y <= x) continue;
    const a = p * y * (y - x) + b * x;
    const amountIn = a / (2n * b);
    if (amountIn <= x || amountIn >= y || baseline.some(t => t.path === upper.path && t.amountIn === amountIn)) continue;
    const estimated = amountIn * (a - b * amountIn) / (x * y * (y - x));
    if (estimated <= (bestExact.get(upper.asset) ?? 0n) || estimated <= (best.get(upper.asset)?.estimated ?? 0n)) continue;
    if (estimated < upper.minimumGross) continue;
    best.set(upper.asset, { trial: { ...upper, amountIn, out: amountIn }, estimated });
  }
  return [...best.values()].map(({ trial }) => trial);
}

export async function scanArbitrumPaths(client: ArbitrumClient, block: bigint, ethUsd: number | Promise<number>, maxLoanUsd: number, minimumNetUsd = 0.05) {
  const startedAt = Date.now();
  const refinement = { tried: 0, quoted: 0, bestPayoutUsd: null as number | null, baselineBestPayoutUsd: null as number | null };
  const result = { opportunities: [] as ArbPathQuote[], best: null as { route: string; payoutUsd: number; loanUsd: number } | null,
    pools: 0, paths: 0, quotedRoutes: 0, unavailableLegs: 0, refinement };
  if (!(maxLoanUsd > 0)) {
    await ethUsd;
    return result;
  }
  if (typeof ethUsd === 'number' && (!Number.isFinite(ethUsd) || ethUsd <= 0)) return result;
  // Pool reads depend on discovery alone. Start them as soon as the list is available,
  // while this block's lender balances and shared ETH/USD oracle are still in flight.
  const market = discoverPathPools(client, block).then(async pools => {
    if (!pools.length) return { pools, prices: [], liquidity: [] };
    const [prices, liquidity] = await Promise.all((['slot0', 'liquidity'] as const).map(functionName =>
      client.multicall({ blockNumber: block, contracts: pools.map(({ pool }) => ({ address: pool, abi: poolAbi, functionName })) })));
    return { pools, prices, liquidity };
  });
  const [{ pools, prices, liquidity }, funding, ethPrice] = await Promise.all([
    market,
    client.multicall({ blockNumber: block, contracts: [
      { address: weth, abi: balanceAbi, functionName: 'balanceOf', args: [morpho] },
      { address: usdc, abi: balanceAbi, functionName: 'balanceOf', args: [morpho] },
      { address: usdcUsdFeed, abi: feedAbi, functionName: 'latestRoundData' },
      { address: '0xca11bde05977b3631167028862be2a173976ca11', abi: clockAbi, functionName: 'getCurrentBlockTimestamp' },
    ] }),
    ethUsd,
  ]);
  if (!Number.isFinite(ethPrice) || ethPrice <= 0) return result;
  result.pools = pools.length;
  if (!pools.length) return result;
  const edges: Edge[] = [];
  for (const [i, pool] of pools.entries()) {
    const sqrt = prices[i]?.result;
    if (sqrt === undefined || liquidity[i]?.result === undefined) { result.unavailableLegs++; continue; }
    if (!sqrt || !liquidity[i].result) continue;
    const sqrtRatio = Number(sqrt) / 2 ** 96;
    const spot = sqrtRatio ** 2;
    const activeLiquidity = Number(liquidity[i].result);
    const keep = pool.kind === 2 ? 1 - pool.tier / 1e6 : 1;
    edges.push({ pool, input: pool.token0, output: pool.token1, rate: spot * keep, inputDepth: activeLiquidity / sqrtRatio / keep },
      { pool, input: pool.token1, output: pool.token0, rate: keep / spot, inputDepth: activeLiquidity * sqrtRatio / keep });
  }
  const feed = funding[2].result;
  const now = funding[3].result;
  const stableUsd = now && feed && feed[1] > 0n && feed[3] <= now && now - feed[3] <= 3600n && feed[4] >= feed[0] ? Number(feed[1]) / 1e8 : 0;
  const baseline: Trial[] = [];
  for (const [i, asset] of [weth, usdc].entries()) {
    const usd = i === 0 ? ethPrice : stableUsd;
    const available = funding[i].result as bigint | undefined;
    if (!available || !usd) continue;
    const decimals = i === 0 ? 18 : 6;
    const symbol = i === 0 ? 'WETH' : 'USDC';
    const priceE8 = BigInt(Math.round(usd * 1e8));
    if (priceE8 <= 0n) continue;
    const minimumGross = requiredGrossPayout(minimumNetInAsset(minimumNetUsd, 10n ** BigInt(decimals), priceE8));
    const scale = 10n ** BigInt(18 - decimals);
    const amountForUsd = (size: number) => (loanLimitWei(size, usd) ?? 0n) / scale;
    const configured = maxLoanUsd === Infinity ? MAX_FLASH_LOAN_WEI : amountForUsd(maxLoanUsd);
    const maximum = [configured, available, MAX_FLASH_LOAN_WEI].reduce((a, b) => a < b ? a : b);
    if (maximum <= 0n) continue;
    const regular = [50, 250, 1000, 2500].map(amountForUsd);
    const rotation = Number(block % 4n);
    let large: bigint;
    if (rotation === 3) {
      // Reuse the deepest slot for intermediate powers of two and the exact funded maximum.
      const levels: bigint[] = [];
      for (let depth = amountForUsd(1_000_000); depth > 0n && depth < maximum; depth *= 2n) levels.push(depth);
      levels.push(maximum);
      large = levels[Number((block / 4n) % BigInt(levels.length))];
    } else large = amountForUsd([10_000, 50_000, 250_000][rotation]);
    const cycles = pathCandidates(asset, edges);
    const amounts = [...new Set([...regular, large].map(loan => loan < maximum ? loan : maximum))].filter(loan => loan > 0n);
    const selectedPaths = new Set<Edge[]>();
    for (const amountIn of amounts) for (const { path } of shortlist(cycles, amountIn, block)) {
      selectedPaths.add(path);
      baseline.push({ path, asset, symbol, usd, decimals, minimumGross, amountIn, out: amountIn });
    }
    result.paths += selectedPaths.size;
  }
  const completed: Trial[] = [];
  const quotedLegs = new Map<string, readonly [bigint, bigint] | undefined>();
  for (const refining of [false, true]) {
    let trials = baseline;
    let deadline: number | undefined;
    if (refining) {
      // Preserve the fast path as soon as any fixed size covers the floor after the execution reserve, before gas.
      if (!completed.length || completed.some(t => t.out - t.amountIn >= t.minimumGross)) break;
      deadline = Math.min(startedAt + 10_000, Date.now() + 1500);
      if (Date.now() >= deadline) break;
      trials = refineSizes(completed, baseline);
      refinement.tried = trials.length;
    }
    for (let hop = 0; trials.length && hop < 4; hop++) {
      if (deadline !== undefined && Date.now() >= deadline) break;
      const keys = trials.map(t => t.path[hop].pool.pool + '/' + t.path[hop].input + '/' + t.out);
      const reads = new Map<string, ReturnType<typeof quoteLeg>>();
      for (const [i, t] of trials.entries()) {
        if (!quotedLegs.has(keys[i]) && !reads.has(keys[i])) reads.set(keys[i], quoteLeg(t.path[hop], t.out));
      }
      if (reads.size) {
        const req = client.multicall({ blockNumber: block, batchSize: 900, contracts: [...reads.values()] });
        const rows = deadline === undefined ? await req : await optionalQuotes(req, deadline);
        if (deadline !== undefined && Date.now() >= deadline) break;
        for (const [i, key] of [...reads.keys()].entries()) {
          const output = rows[i]?.result;
          quotedLegs.set(key, output ? [output[0], output[1]] : undefined);
        }
      }
      trials = trials.filter((trial, i) => {
        const quoted = quotedLegs.get(keys[i]);
        if (!quoted || quoted[0] <= 0n) { if (!quoted) result.unavailableLegs++; return false; }
        // Reject a partial concentrated-liquidity fill stopped at the tick range boundary.
        if (quoted[1] <= 4295128740n || quoted[1] >= 1461446703485210103287273052203988822378723970341n) return false;
        trial.out = quoted[0];
        if (hop + 1 < trial.path.length) return true;
        result.quotedRoutes++;
        const payout = trial.out - trial.amountIn;
        const payoutUsd = Number(formatUnits(payout, trial.decimals)) * trial.usd;
        const loanUsd = Number(formatUnits(trial.amountIn, trial.decimals)) * trial.usd;
        const label = [trial.symbol, ...trial.path.map((leg) => symbols.get(leg.output))].join(' → ');
        if (refining) {
          refinement.quoted++;
          if (refinement.bestPayoutUsd === null || payoutUsd > refinement.bestPayoutUsd) refinement.bestPayoutUsd = payoutUsd;
        } else {
          completed.push(trial);
          if (refinement.baselineBestPayoutUsd === null || payoutUsd > refinement.baselineBestPayoutUsd) refinement.baselineBestPayoutUsd = payoutUsd;
        }
        if (!result.best || payoutUsd > result.best.payoutUsd) result.best = { route: label, payoutUsd, loanUsd };
        if (payout > 0n) {
          const legs = trial.path.map(({ pool, output }) => ({ kind: pool.kind, pool: pool.pool,
            tokenOut: output, tickSpacing: pool.kind === 6 ? pool.tier : 0 }));
          result.opportunities.push({ asset: trial.asset, symbol: trial.symbol, assetUsd: trial.usd,
            decimals: trial.decimals, amountIn: trial.amountIn, payout, legs, block,
            payoutUsd, loanUsd, label });
        }
        return false;
      });
    }
  }
  result.opportunities.sort((a, b) => b.payoutUsd - a.payoutUsd);
  return result;
}
