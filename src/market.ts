import fs from 'node:fs';
import path from 'node:path';
import { encodePacked, parseEther, zeroAddress, type Address, type Hex } from 'viem';
import { ADDR, DATA_DIR, TOKENS, USDC_DECIMALS, type TokenCfg } from './config.js';
import { erc20Abi, factoryAbi, multicall3Abi, poolAbi, publicClient, quoterV2Abi, suggestTipWei } from './chain.js';
import { roundTripCheck } from './safety.js';

export interface PoolInfo {
  address: Address;
  token0: Address;
  token1: Address;
  dec0: number;
  dec1: number;
  fee: number;
}

export interface TokenMarket {
  token: TokenCfg;
  pool: PoolInfo | null; // TOKEN/quote pool (null for WETH itself)
  quote: 'WETH' | 'USDC'; // the pool's other token
  buyPath: Hex; // USDC -> ... -> TOKEN
  sellPath: Hex; // TOKEN -> ... -> USDC
  hops: number;
  poolFeePct: number; // total pool fee for one direction
  depthUsd: number; // quote-side value held by the pool (depth indicator)
  wethDepth: number; // depthUsd expressed in WETH
  safety?: string; // last round-trip simulation result
}

export interface MarketStats {
  candidates: number;
  withPool: number;
  deepEnough: number;
  safetyRejected: number;
  scanned: number;
}

export interface MarketInfo {
  usdcWeth: PoolInfo;
  tokens: TokenMarket[];
  excluded: { symbol: string; reason: string }[];
  stats: MarketStats;
  discoveredAt: number;
}

export interface Snapshot {
  blockNumber: bigint;
  timestamp: number; // seconds
  baseFeeGwei: number;
  tipGwei: number; // suggested priority fee
  ethUsd: number;
  prices: Record<string, number>; // USD per token
  balances?: { eth: bigint; usdc: bigint; tokens: Record<string, bigint> };
}

const FEE_TIERS = [100, 500, 3000, 10000];
/** Bytes of calldata per multicall chunk: thousands of reads in a handful of eth_calls. */
export const BIG_BATCH = 200_000;
const MARKET_CACHE = path.join(DATA_DIR, 'market.json');

const sortTokens = (a: Address, b: Address): [Address, Address] =>
  BigInt(a) < BigInt(b) ? [a, b] : [b, a];

/** price of token0 denominated in token1 */
export function priceFromSqrt(sqrtPriceX96: bigint, dec0: number, dec1: number): number {
  const s = Number(sqrtPriceX96) / 2 ** 96;
  return s * s * 10 ** (dec0 - dec1);
}

/** USD price of `base` given a pool between base and quote, where quote's USD price is known. */
function priceIn(pool: PoolInfo, sqrtPriceX96: bigint, base: Address): number {
  const p01 = priceFromSqrt(sqrtPriceX96, pool.dec0, pool.dec1);
  return pool.token0 === base ? p01 : 1 / p01;
}

const mkPool = (a: Address, b: Address, decA: number, decB: number, fee: number, address: Address): PoolInfo => {
  const [t0, t1] = sortTokens(a, b);
  return { address, token0: t0, token1: t1, dec0: t0 === a ? decA : decB, dec1: t1 === a ? decA : decB, fee };
};

async function runPool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

type McResult = { status: 'success' | 'failure'; result?: unknown };

/** Thousands of reads: fixed-size chunks (one eth_call each), few at a time, each chunk retried — stays under RPC rate limits. */
async function bigMulticall(contracts: any[], chunk = 400, concurrency = 3): Promise<McResult[]> {
  const parts: any[][] = [];
  for (let i = 0; i < contracts.length; i += chunk) parts.push(contracts.slice(i, i + chunk));
  const results = await runPool(parts, concurrency, async (part) => {
    let last: McResult[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        last = (await publicClient.multicall({ contracts: part, allowFailure: true, batchSize: BIG_BATCH })) as McResult[];
        if (last.some((r) => r.status === 'success')) return last;
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    return last.length ? last : part.map(() => ({ status: 'failure' as const }));
  });
  return results.flat();
}

/**
 * Builds the tradeable universe from `candidates`:
 *  1. deepest Uniswap v3 WETH pool per token (thousands of lookups batched into a few eth_calls)
 *  2. depth filter (core: 30 WETH, others: MIN_POOL_WETH), deepest MAX_TOKENS kept
 *  3. on-chain decimals
 *  4. honeypot / hidden-tax simulation (buy + sell in one eth_call) for every non-core token
 * RPC failures THROW (caller retries). Symbols in `mustInclude` (held now) are kept whatever their depth.
 */
export async function discoverMarkets(
  log: (m: string) => void,
  candidates: TokenCfg[],
  mustInclude: string[] = [],
  opts: { safety?: boolean } = {},
): Promise<MarketInfo> {
  const excluded: { symbol: string; reason: string }[] = [];
  const failRatio = (rs: { status: string }[]) => (rs.length ? rs.filter((r) => r.status !== 'success').length / rs.length : 0);

  // 1. pools: every token vs WETH and vs USDC, all fee tiers (tens of thousands of lookups, batched)
  type Quote = 'WETH' | 'USDC';
  const quoteAddr = (q: Quote) => (q === 'WETH' ? ADDR.weth : ADDR.usdc);
  const pairs: { key: string; a: Address; quote: Quote; fee: number }[] = [];
  for (const fee of FEE_TIERS) pairs.push({ key: '__USDC', a: ADDR.usdc, quote: 'WETH', fee });
  for (const t of candidates) {
    if (t.address === ADDR.weth || t.address === ADDR.usdc) continue;
    for (const quote of ['WETH', 'USDC'] as const) {
      for (const fee of FEE_TIERS) pairs.push({ key: t.symbol, a: t.address, quote, fee });
    }
  }
  const poolAddrs = await bigMulticall(
    pairs.map((p) => ({ address: ADDR.uniFactory, abi: factoryAbi, functionName: 'getPool', args: [p.a, quoteAddr(p.quote), p.fee] })),
    800,
  );
  if (failRatio(poolAddrs) > 0.02) throw new Error('RPC error while looking up Uniswap pools');
  const found = pairs
    .map((p, i) => ({ ...p, pool: (poolAddrs[i].status === 'success' ? poolAddrs[i].result : zeroAddress) as Address }))
    .filter((p) => p.pool !== zeroAddress);

  // 2. depth: in-range liquidity + the quote token held by each pool, valued in USD
  const depth = await bigMulticall(
    found.flatMap((p) => [
      { address: p.pool, abi: poolAbi, functionName: 'liquidity' },
      { address: quoteAddr(p.quote), abi: erc20Abi, functionName: 'balanceOf', args: [p.pool] },
    ]),
  );
  if (failRatio(depth) > 0.02) throw new Error('RPC error while measuring pool depth');
  const uwBest = found
    .map((p, i) => ({ p, liq: depth[2 * i].status === 'success' ? (depth[2 * i].result as bigint) : 0n, wethBal: Number((depth[2 * i + 1].result as bigint) ?? 0n) / 1e18 }))
    .filter((x) => x.p.key === '__USDC' && x.liq > 0n)
    .sort((a, b) => (b.liq > a.liq ? 1 : b.liq < a.liq ? -1 : 0))[0];
  if (!uwBest) throw new Error('Could not find a USDC/WETH Uniswap v3 pool');
  const usdcWeth = mkPool(ADDR.usdc, ADDR.weth, USDC_DECIMALS, 18, uwBest.p.fee, uwBest.p.pool);
  const uwSlot0 = (await publicClient.readContract({ address: usdcWeth.address, abi: poolAbi, functionName: 'slot0' })) as readonly [bigint, ...unknown[]];
  const ethUsd = priceIn(usdcWeth, uwSlot0[0], ADDR.weth);
  log(`USDC/WETH pool ${usdcWeth.address} fee ${usdcWeth.fee / 1e4}% depth ${uwBest.wethBal.toFixed(0)} WETH, ETH $${ethUsd.toFixed(0)}`);

  // deepest pool per (token, quote) by in-range liquidity, then the better quote by USD depth
  type Best = { quote: Quote; fee: number; pool: Address; liq: bigint; depthUsd: number };
  const perQuote = new Map<string, Best>();
  found.forEach((p, i) => {
    if (p.key === '__USDC') return;
    if (depth[2 * i].status !== 'success' || depth[2 * i + 1].status !== 'success') return;
    const liq = depth[2 * i].result as bigint;
    if (liq === 0n) return;
    const bal = depth[2 * i + 1].result as bigint;
    const depthUsd = p.quote === 'WETH' ? (Number(bal) / 1e18) * ethUsd : Number(bal) / 1e6;
    const k = `${p.key}|${p.quote}`;
    const cur = perQuote.get(k);
    if (!cur || liq > cur.liq) perQuote.set(k, { quote: p.quote, fee: p.fee, pool: p.pool, liq, depthUsd });
  });
  const bestByKey = new Map<string, Best>();
  for (const [k, b] of perQuote) {
    const key = k.slice(0, k.lastIndexOf('|'));
    const cur = bestByKey.get(key);
    if (!cur || b.depthUsd > cur.depthUsd) bestByKey.set(key, b);
  }

  const minDepth = (t: TokenCfg) => (mustInclude.includes(t.symbol) ? 0 : t.core ? TOKENS.corePoolUsd : TOKENS.minPoolUsd);
  const withPool = candidates.filter((t) => t.address === ADDR.weth || bestByKey.has(t.symbol));
  let deep = withPool.filter((t) => t.address === ADDR.weth || bestByKey.get(t.symbol)!.depthUsd >= minDepth(t));
  for (const t of candidates.filter((c) => c.core && !deep.includes(c))) {
    excluded.push({ symbol: t.symbol, reason: `no Uniswap v3 pool with >= $${TOKENS.corePoolUsd} depth` });
  }
  const longTail = deep.filter((t) => !t.core && !mustInclude.includes(t.symbol))
    .sort((x, y) => bestByKey.get(y.symbol)!.depthUsd - bestByKey.get(x.symbol)!.depthUsd);
  const dropped = new Set(longTail.slice(TOKENS.maxTokens).map((t) => t.symbol));
  deep = deep.filter((t) => !dropped.has(t.symbol));
  const deepCount = deep.length;

  // 3. on-chain decimals (token lists can be wrong)
  const dec = await bigMulticall(deep.map((t) => ({ address: t.address, abi: erc20Abi, functionName: 'decimals' })));
  const verified: TokenCfg[] = [];
  deep.forEach((t, i) => {
    const r = dec[i];
    if (r.status !== 'success') {
      if (t.core) throw new Error(`RPC error reading decimals of ${t.symbol}`);
      excluded.push({ symbol: t.symbol, reason: 'decimals() call failed (non-standard token)' });
      return;
    }
    const d = Number(r.result);
    if (t.core && d !== t.decimals) { excluded.push({ symbol: t.symbol, reason: `decimals ${d} != expected ${t.decimals}` }); return; }
    verified.push({ ...t, decimals: d });
  });

  const tokens: TokenMarket[] = verified.map((t): TokenMarket => {
    if (t.address === ADDR.weth) {
      return {
        token: t, pool: null, quote: 'USDC',
        buyPath: encodePacked(['address', 'uint24', 'address'], [ADDR.usdc, usdcWeth.fee, ADDR.weth]),
        sellPath: encodePacked(['address', 'uint24', 'address'], [ADDR.weth, usdcWeth.fee, ADDR.usdc]),
        hops: 1, poolFeePct: usdcWeth.fee / 1e6, depthUsd: uwBest.wethBal * ethUsd, wethDepth: uwBest.wethBal,
      };
    }
    const b = bestByKey.get(t.symbol)!;
    if (b.quote === 'USDC') {
      // direct TOKEN/USDC pool: one hop, cheaper gas
      return {
        token: t, pool: mkPool(t.address, ADDR.usdc, t.decimals, USDC_DECIMALS, b.fee, b.pool), quote: 'USDC',
        buyPath: encodePacked(['address', 'uint24', 'address'], [ADDR.usdc, b.fee, t.address]),
        sellPath: encodePacked(['address', 'uint24', 'address'], [t.address, b.fee, ADDR.usdc]),
        hops: 1, poolFeePct: b.fee / 1e6, depthUsd: b.depthUsd, wethDepth: b.depthUsd / ethUsd,
      };
    }
    return {
      token: t, pool: mkPool(t.address, ADDR.weth, t.decimals, 18, b.fee, b.pool), quote: 'WETH',
      buyPath: encodePacked(['address', 'uint24', 'address', 'uint24', 'address'], [ADDR.usdc, usdcWeth.fee, ADDR.weth, b.fee, t.address]),
      sellPath: encodePacked(['address', 'uint24', 'address', 'uint24', 'address'], [t.address, b.fee, ADDR.weth, usdcWeth.fee, ADDR.usdc]),
      hops: 2, poolFeePct: (usdcWeth.fee + b.fee) / 1e6, depthUsd: b.depthUsd, wethDepth: b.depthUsd / ethUsd,
    };
  });

  // 4. honeypot / tax simulation for every non-core token
  let safetyRejected = 0;
  let kept = tokens;
  if (opts.safety !== false) {
    const verdicts = await runPool(tokens, 4, async (t) => {
      if (t.token.core || !t.pool) return { ok: true, reason: 'core' };
      for (let attempt = 0; attempt < 2; attempt++) {
        try { return await roundTripCheck(t, parseEther('0.05'), usdcWeth.fee); } catch { await new Promise((r) => setTimeout(r, 1500)); }
      }
      return { ok: false, reason: 'safety simulation unavailable (RPC)' };
    });
    kept = tokens.filter((t, i) => {
      t.safety = verdicts[i].reason;
      if (verdicts[i].ok || mustInclude.includes(t.token.symbol)) return true;
      safetyRejected++;
      excluded.push({ symbol: t.token.symbol, reason: verdicts[i].reason });
      return false;
    });
  }

  for (const t of kept.filter((x) => x.token.core && x.pool)) {
    log(`${t.token.symbol}/${t.quote} pool ${t.pool!.address} fee ${t.pool!.fee / 1e4}% depth $${(t.depthUsd / 1000).toFixed(0)}k`);
  }
  const stats: MarketStats = {
    candidates: candidates.length, withPool: withPool.length, deepEnough: deepCount, safetyRejected, scanned: kept.length,
  };
  log(`Universe: ${kept.length} tokens tradeable (from ${stats.candidates} candidates: ${stats.withPool} have a v3 WETH/USDC pool, ` +
    `${stats.deepEnough} deep enough, ${stats.safetyRejected} failed the honeypot/tax check; ` +
    `${kept.filter((x) => x.quote === 'USDC' && x.pool).length} trade via USDC pools)`);
  for (const e of excluded.filter((x) => candidates.find((c) => c.symbol === x.symbol)?.core)) log(`Excluded ${e.symbol}: ${e.reason}`);
  return { usdcWeth, tokens: kept, excluded, stats, discoveredAt: Date.now() };
}

const MARKET_CACHE_VERSION = 3; // bump when token keys or the entry format change

export function saveMarketCache(m: MarketInfo) {
  try {
    fs.writeFileSync(MARKET_CACHE + '.tmp', JSON.stringify({ ...m, version: MARKET_CACHE_VERSION }));
    fs.renameSync(MARKET_CACHE + '.tmp', MARKET_CACHE);
  } catch { /* ignore */ }
}

export function loadMarketCache(maxAgeMs: number): MarketInfo | null {
  try {
    const m = JSON.parse(fs.readFileSync(MARKET_CACHE, 'utf8')) as MarketInfo & { version?: number };
    if (m.version !== MARKET_CACHE_VERSION) return null;
    if (!m.discoveredAt || Date.now() - m.discoveredAt > maxAgeMs || !Array.isArray(m.tokens) || !m.usdcWeth) return null;
    return m;
  } catch {
    return null;
  }
}

/** One multicall: block time, all pool prices, and (optionally) wallet balances. */
export async function snapshot(m: MarketInfo, wallet?: Address, blockNumber?: bigint): Promise<Snapshot> {
  const contracts: any[] = [
    { address: ADDR.multicall3, abi: multicall3Abi, functionName: 'getCurrentBlockTimestamp' },
    { address: ADDR.multicall3, abi: multicall3Abi, functionName: 'getBasefee' },
    { address: m.usdcWeth.address, abi: poolAbi, functionName: 'slot0' },
    ...m.tokens.map((t) => (t.pool ? { address: t.pool.address, abi: poolAbi, functionName: 'slot0' } : { address: ADDR.multicall3, abi: multicall3Abi, functionName: 'getBasefee' })),
  ];
  if (wallet) {
    contracts.push({ address: ADDR.multicall3, abi: multicall3Abi, functionName: 'getEthBalance', args: [wallet] });
    contracts.push({ address: ADDR.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] });
    for (const t of m.tokens) contracts.push({ address: t.token.address, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] });
  }
  // Live: read base fee from the block header (BASEFEE inside eth_call is 0 on geth-style nodes).
  let bn: bigint;
  let baseFeeGwei = 0;
  let tipGwei = 0;
  if (blockNumber === undefined) {
    const [block, tip] = await Promise.all([publicClient.getBlock({ blockTag: 'latest' }), suggestTipWei()]);
    bn = block.number;
    baseFeeGwei = Number(block.baseFeePerGas ?? 0n) / 1e9;
    tipGwei = Number(tip) / 1e9;
  } else {
    bn = blockNumber;
  }
  const r = (await publicClient.multicall({ contracts, allowFailure: true, blockNumber: bn, batchSize: BIG_BATCH })) as { status: string; result: any }[];
  const ok = (i: number) => {
    if (r[i].status !== 'success') throw new Error(`multicall item ${i} failed at block ${bn}`);
    return r[i].result;
  };

  const timestamp = Number(ok(0));
  const usdcPerWeth = priceIn(m.usdcWeth, ok(2)[0] as bigint, ADDR.weth);
  const prices: Record<string, number> = {};
  m.tokens.forEach((t, i) => {
    if (!t.pool) { prices[t.token.symbol] = usdcPerWeth; return; }
    if (r[3 + i].status !== 'success') return; // pool did not exist at this block
    const p = priceIn(t.pool, r[3 + i].result[0] as bigint, t.token.address) * (t.quote === 'USDC' ? 1 : usdcPerWeth);
    if (Number.isFinite(p) && p > 0) prices[t.token.symbol] = p;
  });

  let balances: Snapshot['balances'];
  if (wallet) {
    const base = 3 + m.tokens.length;
    const tokens: Record<string, bigint> = {};
    m.tokens.forEach((t, i) => {
      const x = r[base + 2 + i];
      // a broken token balanceOf must not stall the bot (left undefined = "unknown", never read as 0); core balances are required
      if (x.status === 'success') tokens[t.token.symbol] = x.result as bigint;
      else if (t.token.core) throw new Error(`balanceOf failed for ${t.token.symbol}`);
    });
    balances = { eth: ok(base) as bigint, usdc: ok(base + 1) as bigint, tokens };
  }
  return { blockNumber: bn, timestamp, baseFeeGwei, tipGwei, ethUsd: usdcPerWeth, prices, balances };
}

export async function quoteExactIn(path: Hex, amountIn: bigint): Promise<{ amountOut: bigint; gasEstimate: bigint }> {
  const { result } = await publicClient.simulateContract({
    address: ADDR.quoterV2,
    abi: quoterV2Abi,
    functionName: 'quoteExactInput',
    args: [path, amountIn],
  });
  return { amountOut: result[0], gasEstimate: result[3] };
}

// ---------------------------------------------------------------------------
// Hourly price history (built from on-chain pool prices, no third-party API)
// ---------------------------------------------------------------------------

export class History {
  private file = path.join(DATA_DIR, 'history.json');
  bars: Record<string, Map<number, number>> = {};

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, [number, number][]>;
      for (const [sym, arr] of Object.entries(raw)) this.bars[sym] = new Map(arr);
    } catch { /* no history yet */ }
  }

  save(keepDays: number, keepSymbols?: Set<string>) {
    const cutoff = Math.floor(Date.now() / 3_600_000) - (keepDays + 10) * 24;
    const out: Record<string, [number, number][]> = {};
    for (const [sym, m] of Object.entries(this.bars)) {
      if (keepSymbols && !keepSymbols.has(sym)) continue; // drop tokens that left the universe
      out[sym] = [...m.entries()].filter(([b]) => b >= cutoff).sort((x, y) => x[0] - y[0]);
    }
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(out));
    fs.renameSync(this.file + '.tmp', this.file);
  }

  record(snap: Snapshot) {
    const bucket = Math.floor(snap.timestamp / 3600);
    for (const [sym, p] of Object.entries(snap.prices)) {
      if (!Number.isFinite(p) || p <= 0) continue;
      (this.bars[sym] ??= new Map()).set(bucket, p);
    }
  }

  /** Forward-filled hourly closes up to and including `uptoBucket`. */
  series(sym: string, uptoBucket?: number): { buckets: number[]; closes: number[] } {
    const m = this.bars[sym];
    if (!m || m.size === 0) return { buckets: [], closes: [] };
    let first = Infinity;
    let lastKey = -Infinity;
    for (const k of m.keys()) { if (k < first) first = k; if (k > lastKey) lastKey = k; }
    const end = uptoBucket ?? lastKey;
    const buckets: number[] = [];
    const closes: number[] = [];
    let last: number | undefined;
    for (let b = first; b <= end; b++) {
      const v = m.get(b);
      if (v !== undefined) last = v;
      if (last !== undefined) { buckets.push(b); closes.push(last); }
    }
    return { buckets, closes };
  }

  /**
   * Fills missing hourly buckets by reading pool prices at past blocks (archive eth_call).
   * `only` = backfill just these tokens (e.g. newly added ones); default checks coverage via WETH.
   */
  async backfill(m: MarketInfo, days: number, log: (s: string) => void, only?: string[]) {
    const subset = only ? { ...m, tokens: m.tokens.filter((t) => only.includes(t.token.symbol)) } : m;
    if (subset.tokens.length === 0) return;
    const check = only ?? ['WETH'];
    const latest = await publicClient.getBlockNumber({ cacheTime: 0 });
    const nowBucket = Math.floor(Date.now() / 3_600_000);
    const targets: bigint[] = [];
    for (let k = 1; k <= days * 24; k++) {
      const b = nowBucket - k;
      if (check.every((s) => this.bars[s]?.has(b) && this.bars[s]?.has(b - 1))) continue;
      targets.push(latest - BigInt(k * 300));
    }
    if (targets.length === 0) return;
    log(`Backfilling ${targets.length} hourly price points for ${only ? `${subset.tokens.length} new tokens` : 'all tokens'}...`);
    let done = 0;
    let failed = 0;
    const worker = async () => {
      while (targets.length) {
        const bn = targets.shift()!;
        let ok = false;
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
          try {
            this.record(await snapshot(subset, undefined, bn));
            ok = true;
          } catch {
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          }
        }
        if (!ok) failed++;
        done++;
        if (done % 240 === 0) log(`  ...${done} points`);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    log(`Backfill done (${done - failed} ok, ${failed} failed)`);
  }
}
