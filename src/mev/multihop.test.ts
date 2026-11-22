import assert from 'node:assert/strict';
import test from 'node:test';
import { getAddress, parseEther, zeroAddress, type Address, type Hex } from 'viem';
import type { PathEdge, PathReader } from './multihop-market.js';
import type { EthereumPathScan } from './multihop.js';

process.env.RPC_URL ??= 'http://127.0.0.1:8545';
const { ADDR } = await import('../config.js');
const { pathTokens, discoverPathPools, pathMarket } = await import('./multihop-market.js');
const { quoteEthereumPaths, EthereumPathPlanner } = await import('./multihop.js');
const a = getAddress('0x0000000000000000000000000000000000000001');
const b = getAddress('0x0000000000000000000000000000000000000002');
const c = getAddress('0x0000000000000000000000000000000000000003');
const WETH = ADDR.weth;
const labels = new Map([[WETH, 'WETH'], [a, 'A'], [b, 'B'], [c, 'C']]);
const currentBlock = 100n;
const settings = (): EthereumPathScan => ({ blockNumber: currentBlock, maxLoanWei: parseEther('0.1'), minNetWei: 1n,
  gasPriceWei: 10n ** 8n, deadlineMs: Date.now() + 10_000 });
function edge(from: Address, to: Address, kind: 0 | 2 | 3 | 4 | 5, rate = 1n, nativeEth = false): PathEdge {
  const reserveIn = parseEther('1000000');
  const pool = getAddress('0x' + (BigInt(from) ^ BigInt(to)).toString(16).padStart(40,'0'));
  const zeroForOne = nativeEth ? from === WETH : BigInt(from) < BigInt(to);
  const hop = { kind, pool, fee: 0, tickSpacing: kind === 5 ? 1 : 0, nativeEth, tokenOut: to };
  return { hop, pool: { ...hop, token0: zeroForOne ? from : to, token1: zeroForOne ? to : from }, zeroForOne,
    tokenIn: from, reserveIn, reserveOut: reserveIn * rate, fee: 0n, rateN: rate, rateD: 1n };
}

interface Read { address: Address; functionName: string; args?: unknown[] }
function client(handler: (calls: Read[], block: bigint) => unknown[]): PathReader {
  return { multicall: async ({ contracts, blockNumber }: { contracts: Read[]; blockNumber: bigint }) => {
    const results = handler(contracts, blockNumber);
    return results.map(result => result === undefined ? { status: 'failure' } : { status: 'success', result });
  } } as unknown as PathReader;
}
function constantOut(edge: PathEdge, amount: bigint) {
  return edge.reserveOut * amount / (edge.reserveIn + amount);
}

test('path quotes chain exact amounts, cap by Morpho liquidity and gas, rank three and four steps', async () => {
  const first = edge(WETH,a,2), middle = edge(a,b,5), last = edge(b,WETH,0,2n);
  const extra = edge(b,c,0), extraLast = edge(c,WETH,0,2n);
  const edges = [first,middle,last,extra,extraLast];
  const calls = new Set<bigint>();
  const reader = client((reads, block) => {
    assert.equal(block, currentBlock);
    assert.equal(reads[0].functionName, 'getBlockNumber');
    return reads.map((r, i) => {
      if (i === 0) return block;
      const p = r.args![0] as { amountIn?: bigint; exactAmount?: bigint; tokenIn: Address; poolKey?: { hooks: Address } };
      if (p.amountIn !== undefined) {
        assert.equal(p.tokenIn, WETH);
        calls.add(p.amountIn + 17n);
        return [p.amountIn + 17n, 1n << 96n];
      }
      assert.equal(p.poolKey?.hooks, zeroAddress);
      assert.ok(calls.has(p.exactAmount!));
      return [p.exactAmount! * 3n / 4n];
    });
  });
  const liquidity = parseEther('0.02');
  const out = await quoteEthereumPaths(settings(), reader, edges, liquidity, labels);
  assert.equal(out.cycles, 2);
  assert.ok(out.exactQuotes > 0 && out.exactQuotes <= 12);
  assert.deepEqual(new Set(out.candidates.map(x => x.hops.length)), new Set([3,4]));
  for (const item of out.candidates) {
    assert.ok(item.amountIn <= liquidity);
    assert.equal(item.hops.at(-1)?.tokenOut, WETH);
    assert.equal(new Set(item.hops.map(h => h.tokenOut)).size, item.hops.length);
    const got = (item.amountIn + 17n) * 3n / 4n;
    const final = item.hops.length === 3 ? constantOut(last, got) : constantOut(extraLast, constantOut(extra, got));
    assert.equal(item.amountOut, final);
    assert.equal(item.grossProfit, final - item.amountIn);
    assert.ok(item.estimatedNet < item.grossProfit);
  }
  assert.deepEqual(out.candidates.map(x => x.estimatedNet), out.candidates.map(x => x.estimatedNet).sort((l,r) => l < r ? 1 : -1));
  const costly = await quoteEthereumPaths({ ...settings(), minNetWei: parseEther('1') }, reader, edges, liquidity, labels);
  assert.deepEqual(costly.candidates, []);
});

test('failed or mismatched pinned reads, expired scans and nonclosing paths never yield candidates', async () => {
  const edges = [edge(WETH,a,2),edge(a,b,2),edge(b,WETH,2,2n)];
  const mismatch = client((reads, block) => reads.map((_,i) => i === 0 ? block - 1n : [parseEther('2')]));
  const out = await quoteEthereumPaths(settings(), mismatch, edges, parseEther('1'), labels);
  assert.equal(out.status, 'partial');
  assert.equal(out.exactQuotes, 0);
  assert.deepEqual(out.candidates, []);
  const failed = client((reads, block) => reads.map((_,i) => i === 0 ? block : undefined));
  assert.deepEqual((await quoteEthereumPaths(settings(), failed, edges, parseEther('1'), labels)).candidates, []);
  const never = client(() => assert.fail('unexpected RPC read'));
  assert.equal((await new EthereumPathPlanner().scan({ ...settings(), deadlineMs: 0 }, never)).status, 'stale');
  assert.equal((await quoteEthereumPaths(settings(), never, edges.slice(0,2), parseEther('1'), labels)).cycles, 0);
  // Two intermediate visits to A or an early WETH return cannot make a valid four-hop path.
  assert.equal((await quoteEthereumPaths(settings(), never, [edge(WETH,a,0),edge(a,b,0),edge(b,a,0),edge(a,WETH,0)],
    parseEther('1'), labels)).cycles, 0);
});

test('discovers the three known hookless stablecoin crossover keys and rotates extra markets', async () => {
  const verified = new Set<Hex>(['0x89a3d4f0e5dd5413745f0a79ab29fbb6f12b430ac0b3804aab271c53027ef083',
    '0x8ed5f4ed25cbd883b62b0880cfd8d8af560cd77fc5cf06d94999f919035c849e',
    '0x35fd769d8345c2925154e2b19f35d33504c53ad88974d496f73219c958107b11']);
  const reader = client((calls, block) => calls.map(({ functionName, args }) => {
    if (functionName === 'getBlockNumber') return block;
    if (functionName === 'getLiquidity') return verified.has(args![0] as Hex) ? 1n : 0n;
    return zeroAddress;
  }));
  const tokens = pathTokens(currentBlock, []);
  const result = await discoverPathPools(reader, currentBlock, tokens, settings().deadlineMs);
  assert.ok(result.complete);
  assert.deepEqual(new Set(result.pools.map(p => p.id)), verified);
  assert.ok(result.pools.every(p => p.kind === 5 && !p.nativeEth));
  const active = [{ address: a, symbol: 'A' }, { address: b, symbol: 'B' }, { address: c, symbol: 'C' }];
  assert.deepEqual(pathTokens(0n, active).slice(-2).map(t => t.address), [a,b]);
  assert.deepEqual(pathTokens(32n, active).slice(-2).map(t => t.address), [c,a]);
});

test('a hash-pinned blocked RPC cannot occupy the worker beyond the scan deadline', async () => {
  const hash = ('0x' + 'aa'.repeat(32)) as Hex;
  let reads = 0;
  const blocked = { multicall: async (request: { blockHash: Hex; requireCanonical: boolean; blockNumber?: bigint }) => {
    assert.equal(request.blockHash, hash);
    assert.equal(request.requireCanonical, true);
    assert.equal(request.blockNumber, undefined);
    reads++;
    return new Promise(() => {});
  } } as unknown as PathReader;
  const started = Date.now();
  const out = await new EthereumPathPlanner().scan({ ...settings(), blockHash: hash, deadlineMs: started + 50 }, blocked);
  assert.ok(reads > 0);
  assert.equal(out.status, 'stale');
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(out.candidates, []);
});

test('finite V2 exits prune impossible amounts while a near-even reference gets an exact quote', async () => {
  const thin = edge(a, b, 0, 1000n);
  thin.reserveIn = 10n ** 10n;
  thin.reserveOut = thin.reserveIn * 1000n;
  const edges = [edge(WETH, a, 2), thin, edge(WETH, c, 2), edge(c, b, 0), edge(b, WETH, 0)];
  const quotedOutputs = new Set<Address>();
  const reader = client((calls, block) => calls.map((call, i) => {
    if (!i) return block;
    const args = call.args![0] as { amountIn: bigint; tokenOut: Address };
    quotedOutputs.add(args.tokenOut);
    return [args.amountIn, 1n << 96n];
  }));
  const out = await quoteEthereumPaths(settings(), reader, edges, parseEther('1'), labels);
  assert.deepEqual([...quotedOutputs], [c]);
  assert.equal(out.exactQuotes, 1);
  assert.equal(out.bestQuote?.label, 'WETH → C → B → WETH');
  assert.deepEqual(out.candidates, []);

  // This V2 pair can repay at small sizes even though the maximum tested loan would lose money.
  thin.reserveIn = parseEther('0.05');
  thin.reserveOut = parseEther('0.07');
  thin.rateN = 7n;
  thin.rateD = 5n;
  const small = await quoteEthereumPaths(settings(), reader, edges, parseEther('1'), labels);
  assert.ok(small.candidates.length > 0);
  assert.ok(small.candidates.every(quote => quote.amountIn < parseEther('0.05') && quote.grossProfit > 0n));
});

test('a full set of high-ranked three-hop trials leaves room for the four-hop audit', async () => {
  const scan = { ...settings(), blockNumber: 104n, maxLoanWei: parseEther('512') };
  const alternative = edge(a, b, 0, 2n);
  alternative.pool = { ...alternative.pool, pool: c };
  alternative.hop = { ...alternative.hop, pool: c };
  const edges = [edge(WETH, a, 0), edge(a, b, 0), alternative, edge(b, WETH, 0, 3n), edge(b, c, 0), edge(c, WETH, 2)];
  // An adverse C/WETH marginal quote rules the four-hop cycle out for trading.
  edges[5].reserveOut /= 4n;
  edges[5].rateD = 4n;
  let audited = false;
  const reader = client((calls, block) => calls.map((call, i) => {
    if (!i) return block;
    const args = call.args![0] as { amountIn: bigint; tokenIn: Address };
    assert.equal(args.tokenIn, c);
    audited = true;
    return [args.amountIn / 4n, 1n << 96n];
  }));
  const out = await quoteEthereumPaths(scan, reader, edges, parseEther('512'), labels);
  assert.ok(audited);
  assert.equal(out.exactQuotes, 12);
  assert.ok(out.candidates.every(q => q.hops.length === 3));
});


test('Sushi and Pancake factory discovery, fee tiers and slot layouts remain bounded across token rotations', async () => {
  const sushi = getAddress('0xbaceb8ec6b9355dfc0269c18bac9d6e2bdc29c4f');
  const pancake = getAddress('0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865');
  const counts = new Map([[sushi, 0], [pancake, 0]]);
  const tokens = pathTokens(currentBlock, [{ address: a, symbol: 'A' }, { address: b, symbol: 'B' }]);
  const usdt = tokens.find(t => t.symbol === 'USDT')!.address;
  const reader = client((calls, block) => calls.map(call => {
    const { functionName, address, args } = call;
    if (functionName === 'getBlockNumber') return block;
    if (functionName === 'getLiquidity') return 0n;
    if (functionName === 'balanceOf') return 10n ** 18n;
    if (functionName === 'liquidity') return 10n ** 22n;
    if (functionName === 'slot0') {
      const { abi } = call as unknown as { abi: { name: string; outputs: { type: string }[] }[] };
      assert.equal(abi.find(f => f.name === 'slot0')!.outputs[5].type, address === b ? 'uint32' : 'uint8');
      return [1n << 96n, 0, 1, 1, 1, address === b ? 2000 : 0, true];
    }
    if (!counts.has(address)) return zeroAddress;
    counts.set(address, counts.get(address)! + 1);
    assert.equal(functionName, 'getPool');
    assert.ok(args![0] !== a && args![1] !== b && args![0] !== b && args![1] !== a);
    return args![0] === ADDR.usdc && args![1] === usdt && args![2] === 100 ? (address === sushi ? a : b) : zeroAddress;
  }));
  const discovery = await discoverPathPools(reader, currentBlock, tokens, settings().deadlineMs);
  assert.deepEqual([...counts.values()], [6,7]);
  const market = await pathMarket(reader, currentBlock, discovery.pools, settings().deadlineMs);
  assert.ok(discovery.complete && market.complete);
  assert.deepEqual(market.edges.map(e => [e.hop.kind, e.fee, e.hop.tickSpacing, e.hop.nativeEth]),
    [[3,100n,0,false], [3,100n,0,false], [4,100n,0,false], [4,100n,0,false]]);
});

test('Sushi and Pancake use their own exact quoters and discard partial fills in either direction', async () => {
  const first = edge(WETH, a, 3), middle = edge(a, b, 4), exit = edge(b, WETH, 0, 2n);
  const scan = { ...settings(), maxLoanWei: parseEther('0.005') };
  for (const stopAt of [0, 3, 4]) {
    const visited: number[] = [];
    const reader = client((calls, block) => calls.map(({ address, functionName, args }, i) => {
      if (!i) return block;
      const { tokenIn, tokenOut, amountIn, sqrtPriceLimitX96 } = args![0] as
        { tokenIn: Address; tokenOut: Address; amountIn: bigint; sqrtPriceLimitX96: bigint };
      const sushi = tokenIn === WETH;
      const kind = sushi ? 3 : 4;
      visited.push(kind);
      assert.equal(address.toLowerCase(), sushi ? '0x64e8802fe490fa7cc61d3463958199161bb608a7' : '0xb048bbc1ee6b733fffcfb9e9cef7375518e25997');
      assert.equal(functionName, 'quoteExactInputSingle');
      assert.equal(tokenOut, sushi ? a : b);
      assert.equal(amountIn, sushi ? scan.maxLoanWei : scan.maxLoanWei + 5n);
      assert.equal(sqrtPriceLimitX96, 0n);
      const limit = sushi ? 1461446703485210103287273052203988822378723970341n : 4295128740n;
      return [amountIn + 5n, kind === stopAt ? limit : 1n << 96n, 0, 40000n];
    }));
    const result = await quoteEthereumPaths(scan, reader, [first, middle, exit], scan.maxLoanWei, labels);
    assert.deepEqual(visited, stopAt === 3 ? [3] : [3,4]);
    assert.equal(result.exactQuotes, stopAt ? 0 : 1);
    assert.equal(result.candidates.length, stopAt ? 0 : 1);
    if (!stopAt) assert.equal(result.candidates[0].amountOut, constantOut(exit, scan.maxLoanWei + 10n));
  }
});
