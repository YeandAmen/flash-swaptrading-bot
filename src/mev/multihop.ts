import { parseEther, type Address, type Hex } from 'viem';
import { mevPoolClient } from '../chain.js';
import { ADDR } from '../config.js';
import { MAX_FLASH_LOAN_WEI } from './cadence.js';
import {
  discoverPathPools, directQuoteCall, isPathV3, pathMarket, pathTokens, pinnedReads, type EthereumPathHop, type PathEdge,
  type PathPool, type PathReader, type PathToken,
} from './multihop-market.js';
export type { EthereumPathHop } from './multihop-market.js';

export interface EthereumPathScan {
  blockNumber: bigint;
  blockHash?: Hex;
  maxLoanWei: bigint;
  minNetWei: bigint;
  gasPriceWei: bigint;
  deadlineMs: number;
  tokens?: readonly PathToken[];
}
export interface EthereumPathCandidate {
  hops: EthereumPathHop[];
  amountIn: bigint;
  amountOut: bigint;
  grossProfit: bigint;
  estimatedNet: bigint;
  label: string;
}
export interface EthereumPathResult {
  blockNumber: bigint;
  status: 'scanned' | 'partial' | 'stale' | 'unavailable';
  pools: number;
  cycles: number;
  exactQuotes: number;
  bestQuote?: Pick<EthereumPathCandidate, 'amountIn' | 'amountOut' | 'estimatedNet' | 'label'>;
  candidates: EthereumPathCandidate[];
}
interface Trial {
  edges: PathEdge[];
  amountIn: bigint;
  amountOut: bigint;
  upper: bigint;
}

const WETH = ADDR.weth;
const million = 1_000_000n;
const maxTrials = 12;
const sizes = ['0.005', '0.015', '0.05', '0.2', '1', '4', '16', '64', '256', '512'].map(s => parseEther(s));
const min = (a: bigint, b: bigint) => a < b ? a : b;
const compare = (a: bigint, b: bigint) => a < b ? 1 : a > b ? -1 : 0;
// Used for ranking. The signer prices and simulates the exact full execution.
const modeledGas = (hops: number) => 155_000n + BigInt(hops) * 65_000n;
const tokenKey = (edges: PathEdge[]) => edges.map(e => e.hop.tokenOut).join('/');

function edgeKey(edge: PathEdge) {
  const { kind, pool, fee, tickSpacing, nativeEth, tokenOut } = edge.hop;
  return [edge.tokenIn, tokenOut, kind, pool, fee, tickSpacing, nativeEth].join('/').toLowerCase();
}

function cpOut(edge: PathEdge, amount: bigint) {
  const input = amount * (million - edge.fee);
  return edge.reserveOut * input / (million * edge.reserveIn + input);
}
function marginalOut(edge: PathEdge, amount: bigint) {
  const numerator = amount * edge.rateN * (million - edge.fee);
  const denominator = edge.rateD * million;
  return (numerator + denominator - 1n) / denominator;
}

function outputLimit(edge: PathEdge, first: PathEdge | undefined, loan: bigint) {
  if (edge.outputBalance === undefined) return undefined;
  // A simple cycle repeats only WETH. A first V4 leg can already have credited the manager
  // with the loan in the same currency (native ETH and WETH are distinct balances).
  const replenished = edge.hop.tokenOut === WETH && edge.hop.kind === 5 && first?.hop.kind === 5
    && edge.hop.pool === first.hop.pool && edge.hop.nativeEth === first.hop.nativeEth;
  return edge.outputBalance + (replenished ? loan : 0n);
}

function extendTrial(part: Trial, edge: PathEdge): Trial {
  const modeled = cpOut(edge, part.amountOut);
  // V2 reserves determine the exact monotone output. Concentrated pools may cross ticks.
  const upper = isPathV3(edge.hop.kind) || edge.hop.kind === 5 ? marginalOut(edge, part.upper) : cpOut(edge, part.upper);
  const limit = outputLimit(edge, part.edges[0], part.amountIn);
  return { edges: [...part.edges, edge], amountIn: part.amountIn,
    amountOut: limit === undefined ? modeled : min(modeled, limit),
    upper: limit === undefined ? upper : min(upper, limit) };
}

function modelPath(edges: PathEdge[], amountIn: bigint) {
  return edges.reduce<Trial>(extendTrial, { edges: [], amountIn, amountOut: amountIn, upper: amountIn });
}

/** Simple token cycles ensure no physical pool is quoted twice against its pre-swap state. */
function shortlist(edges: PathEdge[], available: bigint, scan: EthereumPathScan) {
  const graph = new Map<Address, Map<Address, PathEdge[]>>();
  const seenEdges = new Set<string>();
  for (const edge of edges) {
    const key = edgeKey(edge);
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    const destinations = graph.get(edge.tokenIn) ?? new Map<Address, PathEdge[]>();
    graph.set(edge.tokenIn, destinations);
    const out = destinations.get(edge.hop.tokenOut) ?? [];
    out.push(edge);
    destinations.set(edge.hop.tokenOut, out);
  }
  const loans = [...new Set(sizes.map(size => min(size, available)))].filter(a => a > 0n);
  // Extend the local depth model geometrically to the funded limit. A large
  // lender balance can be unprofitable in full while an intermediate size clears gas.
  const largestFixedLoan = sizes[sizes.length - 1];
  for (let size = largestFixedLoan * 4n; size < available; size *= 4n) loans.push(size);
  if (available > largestFixedLoan) loans.push(available);
  const floor = scan.minNetWei + 21_000n * scan.gasPriceWei;
  const score = (trial: Trial) => trial.amountOut - trial.amountIn - modeledGas(trial.edges.length) * scan.gasPriceWei;
  const trials: Trial[] = [];
  let cycles = 0;
  const audit = scan.blockNumber % 8n === 0n;
  const referenceSize = min(available, parseEther('0.05'));
  const references = new Map<number, Trial>();
  const visit = (tokens: Address[], legs: PathEdge[][]) => {
    const last = tokens[tokens.length - 1];
    for (const [nextToken, choices] of graph.get(last) ?? []) {
      const path = [...legs, choices];
      if (nextToken !== WETH) {
        if (path.length < 4 && !tokens.includes(nextToken)) visit([...tokens, nextToken], path);
        continue;
      }
      if (path.length < 3) continue;
      cycles++;
      // Compare against the optimistic marginal price before spending RPCs on exact size quotes.
      const maxAmount = loans[loans.length - 1] ?? 0n;
      let upper = maxAmount;
      for (const venues of path) {
        let maximum = 0n;
        for (const edge of venues) {
          const value = marginalOut(edge, upper);
          if (value > maximum) maximum = value;
        }
        upper = maximum;
      }
      const viable = upper >= maxAmount + floor;
      // A finite V2 reserve can wipe out the marginal edge at large sizes. Keep smaller loans eligible.
      for (const amountIn of viable ? loans : [referenceSize]) {
        let variants: Trial[] = [{ edges: [], amountIn, amountOut: amountIn, upper: amountIn }];
        for (const venues of path) {
          const next = variants.flatMap(part => venues.map(edge => extendTrial(part, edge)));
          next.sort((a, b) => compare(a.amountOut, b.amountOut) || compare(a.upper, b.upper));
          variants = next.slice(0, 2);
        }
        const first = variants[0];
        if (amountIn === referenceSize && first && first.amountOut > (references.get(path.length)?.amountOut ?? 0n)) {
          references.set(path.length, first);
        }
        if (viable) trials.push(...variants.filter(v => v.upper >= amountIn + floor
          && (amountIn <= largestFixedLoan || score(v) >= scan.minNetWei)));
      }
    }
  };
  visit([WETH], []);
  trials.sort((a, b) => compare(score(a), score(b)));
  const chosen: Trial[] = [];
  const seen = new Set<string>();
  for (const trial of trials) {
    const key = tokenKey(trial.edges);
    if (seen.has(key)) continue;
    seen.add(key);
    chosen.push(trial);
    if (chosen.length >= maxTrials / 2) break;
  }
  // Preserve a real market reference even when many size variants of the same thin exit rank ahead
  // on marginal price. Also audit the four-hop reference every eighth block or when no trial qualifies.
  const reference = references.get(3) ?? references.get(4);
  if (reference && !chosen.includes(reference)) chosen.push(reference);
  const four = references.get(4);
  if (four && (audit || !trials.length) && !chosen.includes(four)) chosen.push(four);
  const reserved = chosen.length;
  for (const trial of trials) {
    if (chosen.length >= maxTrials) break;
    if (!chosen.includes(trial)) chosen.push(trial);
  }
  // Search the gaps next to shortlisted sizes on the same concrete pools. Only
  // exact-quote an interior size if its modeled net beats both endpoints and the floor.
  let interior: Trial | undefined;
  const intervals = new Set<string>();
  for (const seed of chosen) {
    const i = loans.indexOf(seed.amountIn);
    const path = seed.edges.map(edgeKey).join('|');
    for (const neighbor of [i - 1, i + 1]) {
      if (neighbor < 0 || neighbor >= loans.length) continue;
      const low = loans[Math.min(i, neighbor)];
      const key = path + ':' + low;
      if (intervals.has(key)) continue;
      intervals.add(key);
      const gap = loans[Math.max(i, neighbor)] - low;
      if (gap < 3n) continue;
      const other = modelPath(seed.edges, loans[neighbor]);
      const endpointNet = score(seed) > score(other) ? score(seed) : score(other);
      for (const offset of [gap / 3n, 2n * gap / 3n]) {
        const candidate = modelPath(seed.edges, low + offset);
        if (candidate.upper < candidate.amountIn + floor) continue;
        const net = score(candidate);
        if (net >= scan.minNetWei && net > endpointNet && (!interior || net > score(interior))) interior = candidate;
      }
    }
  }
  if (interior) {
    const last = chosen.length - 1;
    if (chosen.length < maxTrials) chosen.push(interior);
    else if (last >= reserved && score(interior) > score(chosen[last])) chosen[last] = interior;
  }
  return { cycles, trials: chosen };
}

/** The previous hop's exact output becomes the next hop's input in atomic units. */
export async function quoteEthereumPaths(scan: EthereumPathScan, client: PathReader, edges: PathEdge[], available: bigint,
  symbols: ReadonlyMap<Address, string>): Promise<Pick<EthereumPathResult, 'cycles' | 'exactQuotes' | 'bestQuote' | 'candidates' | 'status'>> {
  const expired = () => Date.now() >= scan.deadlineMs;
  const { cycles, trials } = shortlist(edges, min(available, min(scan.maxLoanWei, MAX_FLASH_LOAN_WEI)), scan);
  const amounts = trials.map(t => t.amountIn);
  let partial = false;
  for (let leg = 0; leg < 4 && !expired(); leg++) {
    const calls: ReturnType<typeof directQuoteCall>[] = [];
    const reads = new Map<string, number>();
    const refs = trials.map((trial, i) => {
      const edge = trial.edges[leg];
      const amount = amounts[i];
      if (!edge || !amount) return -1;
      if (!isPathV3(edge.hop.kind) && edge.hop.kind !== 5) {
        amounts[i] = cpOut(edge, amount);
        return -1;
      }
      if (amount >= (1n << 128n) || (edge.hop.kind === 5 && amount > MAX_FLASH_LOAN_WEI)) {
        amounts[i] = 0n;
        return -1;
      }
      const key = [edge.pool.id ?? edge.hop.pool, edge.tokenIn, amount].join('/');
      const seen = reads.get(key);
      if (seen !== undefined) return seen;
      reads.set(key, calls.length);
      calls.push(directQuoteCall(edge, amount));
      return calls.length - 1;
    });
    const values = await pinnedReads(client, scan.blockNumber, calls, 4, scan.deadlineMs, scan.blockHash);
    for (const [i, ref] of refs.entries()) {
      if (ref < 0) continue;
      const value = values[ref];
      const trial = trials[i];
      const edge = trial.edges[leg];
      const v3 = isPathV3(edge.hop.kind);
      const fullFill = Array.isArray(value) && (!v3 || typeof value[1] === 'bigint'
        && value[1] > 4295128740n && value[1] < 1461446703485210103287273052203988822378723970341n);
      const limit = outputLimit(edge, trial.edges[0], trial.amountIn);
      amounts[i] = fullFill && typeof value[0] === 'bigint' && value[0] > 0n
        && (limit === undefined || value[0] <= limit) ? value[0] : 0n;
      if (value === undefined) partial = true;
    }
  }
  if (expired()) return { status: 'stale', cycles, exactQuotes: 0, candidates: [] };
  const candidates: EthereumPathCandidate[] = [];
  let exactQuotes = 0;
  let bestQuote: EthereumPathResult['bestQuote'];
  for (const [i, t] of trials.entries()) {
    if (amounts[i] <= 0n) continue;
    exactQuotes++;
    // Morpho charges zero flash premium. Even the intrinsic transaction fee must leave the retained floor.
    const grossProfit = amounts[i] - t.amountIn;
    const estimatedNet = grossProfit - modeledGas(t.edges.length) * scan.gasPriceWei;
    const names = [WETH, ...t.edges.map(e => e.hop.tokenOut)].map(t => symbols.get(t) ?? t.slice(0, 8));
    const quote = { label: names.join(' → '), amountIn: t.amountIn, amountOut: amounts[i], estimatedNet };
    if (!bestQuote || estimatedNet > bestQuote.estimatedNet) bestQuote = quote;
    if (grossProfit <= 0n || grossProfit < scan.minNetWei + 21_000n * scan.gasPriceWei) continue;
    candidates.push({ ...quote, hops: t.edges.map(e => e.hop), grossProfit });
  }
  candidates.sort((a, b) => compare(a.estimatedNet, b.estimatedNet));
  return { status: partial ? 'partial' : 'scanned', cycles, exactQuotes, bestQuote, candidates: candidates.slice(0, 4) };
}

export class EthereumPathPlanner {
  private cache?: { block: bigint; until: bigint; complete: boolean; group: string; pools: PathPool[] };

  async scan(input: EthereumPathScan, client: PathReader = mevPoolClient): Promise<EthereumPathResult> {
    const { blockNumber: block, deadlineMs } = input;
    const result: EthereumPathResult = { blockNumber: block, pools: 0, cycles: 0, exactQuotes: 0, candidates: [], status: 'unavailable' };
    if (Date.now() >= deadlineMs) return { ...result, status: 'stale' };
    if (input.maxLoanWei <= 0n || input.minNetWei < 0n || input.gasPriceWei < 0n || block < 0n) return result;
    const tokens = pathTokens(block, input.tokens ?? []);
    const group = tokens.map(t => t.address).join('/');
    let pools = this.cache?.pools;
    let complete = this.cache?.complete ?? false;
    if (!this.cache || this.cache.group !== group || this.cache.block > block || block >= this.cache.until) {
      const discovery = await discoverPathPools(client, block, tokens, deadlineMs, input.blockHash);
      pools = discovery.pools;
      complete = discovery.complete;
      if (pools.length) this.cache = { block, until: block + (complete ? 32n : 3n), complete, group, pools };
    }
    if (Date.now() >= deadlineMs) return { ...result, status: 'stale' };
    if (!pools?.length) return result;
    const market = await pathMarket(client, block, pools, deadlineMs, input.blockHash);
    result.pools = market.edges.length / 2;
    if (Date.now() >= deadlineMs) return { ...result, status: 'stale' };
    if (!market.available || !market.edges.length) return result;
    const quotes = await quoteEthereumPaths(input, client, market.edges, market.available, new Map(tokens.map(t => [t.address, t.symbol])));
    if (quotes.status === 'scanned' && (!complete || !market.complete)) quotes.status = 'partial';
    return { ...result, ...quotes };
  }
}
