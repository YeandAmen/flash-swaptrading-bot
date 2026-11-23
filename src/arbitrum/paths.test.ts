import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEther, zeroAddress, type Address } from 'viem';
import { scanArbitrumPaths } from './paths.js';
import type { ArbitrumClient } from './market.js';

const weth = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const usdc = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const arb = '0x912ce59144191c1204e64559fe8253a0e49e6548';
const usdg = '0x004b506865409877c9fa29bfb1eba929984b9bbc';
const markets = [
  { pool: '0xc6962004f452be9203591991d15f6b388e09e8d0', from: usdc, to: weth, kind: 2, tier: 500, n: 10n ** 12n, d: 2000n },
  { pool: '0xbdf6749254c8760b42f38b9985baaf1cecf17617', from: weth, to: arb, kind: 6, tier: 100, n: 4000n, d: 1n },
  { pool: '0xe41723a9fca1eac0f18728d4583510aa7377901b', from: arb, to: usdg, kind: 6, tier: 100, n: 1n, d: 2n * 10n ** 12n },
  { pool: '0x09328be718d89228a985471bb470988a34d0b162', from: usdg, to: usdc, kind: 6, tier: 1, n: 105n, d: 100n },
] as const;
const block = 526440239n;
const usdcLiquidity = 69_987_654n;
const wethLiquidity = parseEther('0.03');
interface Request { address: Address; functionName: string; args?: readonly unknown[] }

type Market = { pool: string; from: Address; to: Address; kind: number; tier: number; n: bigint; d: bigint; shallow?: boolean };
function fixture(mode?: 'stale' | 'skipped-round' | 'future' | 'unavailable' | 'partial' | 'shallow', pinned = block, extra: Market[] = [],
  cash = { usdc: usdcLiquidity, weth: wethLiquidity }) {
  const inventory: Market[] = [...markets, ...extra];
  if (mode === 'shallow') {
    for (const [i, [kind, tier]] of [[2, 100], [2, 500], [2, 3000], [6, 1], [6, 10], [6, 50]].entries()) {
      inventory.push({ pool: '0x' + (i + 1).toString().padStart(40, '0'), from: weth, to: arb, kind, tier,
        n: BigInt(6000 + i * 100), d: 1n, shallow: true });
    }
  }
  return { multicall: async ({ blockNumber, contracts }: { blockNumber: bigint; contracts: Request[] }) => {
    assert.equal(blockNumber, pinned);
    return contracts.map(({ functionName, args = [], address }) => {
      const success = (result: unknown) => ({ status: 'success', result });
      if (functionName === 'balanceOf') {
        assert.equal(args[0], '0x6c247b1f6182318877311737bac0844baa518f5e');
        return success(address === usdc ? cash.usdc : cash.weth);
      }
      const time = 1_700_000_000n; // Deliberately old to catch use of wall time in a pinned oracle read.
      if (functionName === 'getCurrentBlockTimestamp') return success(time);
      if (functionName === 'latestRoundData') {
        const offset = mode === 'stale' ? -3602n : mode === 'future' ? 10n : 0n;
        return success([2n, 100_000_000n, time + offset, time + offset, mode === 'skipped-round' ? 1n : 2n]);
      }
      if (functionName === 'getPool') {
        const [a, b, tier] = args;
        const kind = address === '0x1f98431c8ad98523631ae4a59f267346ea31f984' ? 2 : 6;
        return success(inventory.find(m => m.kind === kind && m.tier === tier &&
          ((m.from === a && m.to === b) || (m.from === b && m.to === a)))?.pool ?? zeroAddress);
      }
      if (functionName === 'slot0' || functionName === 'liquidity') {
        const market = inventory.find(m => m.pool === address);
        assert.ok(market, 'only discovered markets can be read');
        const rate = Number(market.n) / Number(market.d);
        return success(functionName === 'slot0'
          ? BigInt(Math.floor(2 ** 96 * Math.sqrt(market.from < market.to ? rate : 1 / rate))) : market.shallow ? 1_000_000n : 10n ** 30n);
      }
      const uni = functionName === 'quoteExactInputSingle';
      assert.ok(uni || functionName === 'quoteExactInputSingleV3');
      const first = args[0] as { tokenIn: Address; tokenOut: Address; amountIn: bigint; fee: number };
      const market = uni ? inventory.find(m => m.kind === 2 && m.tier === first.fee &&
        ((m.from === first.tokenIn && m.to === first.tokenOut) || (m.from === first.tokenOut && m.to === first.tokenIn)))
        : inventory.find(m => m.pool === args[0]);
      assert.ok(market);
      if (market.pool === markets[1].pool && mode === 'unavailable') return { status: 'failure' };
      const amount = uni ? first.amountIn : args[2] as bigint;
      const forward = (uni ? first.tokenIn : args[1]) === market.from;
      const out = market.shallow ? 1n : forward ? amount * market.n / market.d : amount * market.d / market.n;
      return success([out, market.pool === markets[1].pool && mode === 'partial' ? 4295128740n : 1n << 96n, 0n, 0n]);
    });
  } } as unknown as ArbitrumClient;
}

test('the large path probe rotates through the configured ceiling within the existing quote budget', async () => {
  const cash = { usdc: 3_000_000n * 10n ** 6n, weth: parseEther('2000') };
  const rotation = [10_000, 50_000, 250_000, 1_000_000, 10_000, 50_000, 250_000, 2_000_000];
  for (const [i, large] of rotation.entries()) {
    const pinned = 800n + BigInt(i);
    for (const cap of [1_000_000, 2_000_000]) {
      const result = await scanArbitrumPaths(fixture(undefined, pinned, [], cash), pinned, 2000, cap);
      const sizesUsd = [50, 250, 1000, 2500, Math.min(large, cap)];
      for (const base of [usdc, weth]) {
        const expected = sizesUsd.map(dollars => base === usdc ? BigInt(dollars) * 10n ** 6n : BigInt(dollars) * 10n ** 18n / 2000n);
        assert.deepEqual(new Set(result.opportunities.filter(r => r.asset === base).map(r => r.amountIn)), new Set(expected));
      }
      assert.equal(result.quotedRoutes, 10, 'five sizes per asset for the one profitable cycle in this market');
      assert.equal(result.refinement.tried, 0);
    }
  }
});

test('the configured-ceiling probe respects each pinned lender balance and deduplicates small caps', async () => {
  const pinned = 807n;
  const cash = { weth: parseEther('241.465247653196025614'), usdc: 445_473_159_923n };
  const client = fixture(undefined, pinned, [], cash);
  const funded = await scanArbitrumPaths(client, pinned, 2000, 2_000_000);
  for (const [asset, available] of [[weth, cash.weth], [usdc, cash.usdc]] as const) {
    const loans = funded.opportunities.filter(r => r.asset === asset).map(r => r.amountIn);
    assert.ok(loans.includes(available));
    assert.ok(loans.every(n => n <= available));
  }
  const capped = await scanArbitrumPaths(client, pinned, 2000, 249);
  assert.deepEqual(new Set(capped.opportunities.map(r => r.loanUsd)), new Set([50, 249]));
  assert.equal(capped.quotedRoutes, 4);
});

test('uncapped path discovery rotates deep intermediate amounts and exact asset-specific Morpho balances', async () => {
  const cash = { weth: parseEther('1350.000000000000000001'), usdc: 9_345_678_123_456n };
  const observed = { WETH: new Set<bigint>(), USDC: new Set<bigint>() };
  for (let phase = 0n; phase < 5n; phase++) {
    const pinned = 4n * phase + 3n;
    const result = await scanArbitrumPaths(fixture(undefined, pinned, [], cash), pinned, 2000, Infinity);
    assert.equal(result.quotedRoutes, 10);
    for (const route of result.opportunities) {
      assert.ok(Number.isFinite(route.loanUsd) && Number.isFinite(route.payoutUsd));
      if (route.loanUsd > 2500) observed[route.symbol].add(route.amountIn);
    }
  }
  assert.deepEqual(observed.WETH, new Set([parseEther('500'), parseEther('1000'), cash.weth]));
  assert.deepEqual(observed.USDC, new Set([1_000_000n, 2_000_000n, 4_000_000n, 8_000_000n].map(n => n * 1_000_000n).concat(cash.usdc)));

  // The executor's int128 limit is denominated in raw base-asset units, including six-decimal USDC.
  const maxInput = (1n << 127n) - 1n;
  let phases = 0n;
  for (let depth = 1_000_000_000_000n; depth < maxInput; depth *= 2n) phases++;
  const pinned = 4n * phases + 3n;
  const result = await scanArbitrumPaths(fixture(undefined, pinned, [], { weth: 0n, usdc: maxInput + 1n }), pinned, 2000, Infinity);
  assert.ok(result.opportunities.some(route => route.amountIn === maxInput));
  assert.ok(result.opportunities.every(route => route.amountIn <= maxInput));
});

test('Arbitrum quotes the canonical four distinct pool cycle using the precise previous output', async () => {
  const result = await scanArbitrumPaths(fixture(), block, 2000, 75);
  assert.equal(result.pools, 4);
  assert.ok(result.quotedRoutes > 0 && result.opportunities.length > 1);
  let last = Infinity;
  for (const route of result.opportunities) {
    assert.ok(route.payoutUsd <= last);
    last = route.payoutUsd;
    assert.ok(route.loanUsd <= 75 && route.payout > 0n);
    assert.ok(route.amountIn <= (route.symbol === 'USDC' ? usdcLiquidity : wethLiquidity));
    assert.equal(route.legs.length, 4);
    assert.equal(new Set(route.legs.map(l => l.pool)).size, 4);
    assert.equal(route.legs.at(-1)?.tokenOut, route.asset);
    let acquired = route.amountIn;
    for (const leg of route.legs) {
      const m = markets.find(m => m.pool === leg.pool)!;
      acquired = acquired * m.n / m.d;
    }
    assert.equal(route.payout, acquired - route.amountIn);
  }
  const observed = result.opportunities.find(r => r.symbol === 'USDC')!;
  assert.deepEqual(observed.legs.map(l => l.pool), markets.map(m => m.pool));
  assert.deepEqual(observed.legs.map(l => l.tickSpacing), [0,100,100,1]);
  assert.equal(observed.label, 'USDC → WETH → ARB → USDG → USDC');
  const capped = await scanArbitrumPaths(fixture(), block, 2000, 25.125);
  assert.ok(capped.opportunities.length > 0 && capped.opportunities.every(r => r.loanUsd <= 25.125));
});

test('USDC lending requires a fresh oracle round while WETH remains independently priceable', async () => {
  for (const mode of ['stale','future','skipped-round'] as const) {
    const result = await scanArbitrumPaths(fixture(mode), block, 2000, 75);
    assert.ok(result.opportunities.length > 0 && result.opportunities.every(r => r.asset === weth));
  }
});

test('cached pools start same-block state reads while funding and shared ETH price are pending', async () => {
  const source = fixture();
  const stages: string[] = [];
  let pauseFunding: Promise<void> | undefined;
  const client = { multicall: async (request: { blockNumber: bigint; contracts: Request[] }) => {
    assert.equal(request.blockNumber, block);
    const stage = request.contracts[0].functionName;
    stages.push(stage);
    if (stage === 'balanceOf') await pauseFunding;
    return source.multicall(request as Parameters<typeof source.multicall>[0]);
  } } as unknown as ArbitrumClient;
  const cold = await scanArbitrumPaths(client, block, 2000, 75);
  const warmStages = stages.filter(stage => stage !== 'getPool').sort();
  stages.length = 0;
  let fund!: () => void;
  pauseFunding = new Promise(resolve => { fund = resolve; });
  let setPrice!: (price: number) => void;
  const price = new Promise<number>(resolve => { setPrice = resolve; });
  const run = scanArbitrumPaths(client, block, price, 75);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual([...stages].sort(), ['balanceOf', 'liquidity', 'slot0']);
  fund();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual([...stages].sort(), ['balanceOf', 'liquidity', 'slot0'], 'sizing still waits for the shared price');
  setPrice(2000);
  assert.deepEqual(await run, cold);
  assert.deepEqual(stages.sort(), warmStages, 'warm scan uses exactly the cold requests minus discovery');

  stages.length = 0;
  await assert.rejects(scanArbitrumPaths(client, block, Promise.reject(new Error('feed unavailable')), 75), /feed unavailable/);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(stages.every(stage => !stage.startsWith('quote')));
});

test('unavailable or partially filled quote legs cannot complete a path', async () => {
  for (const mode of ['unavailable','partial'] as const) {
    const result = await scanArbitrumPaths(fixture(mode), block, 2000, 75);
    assert.equal(result.quotedRoutes, 0);
    assert.deepEqual(result.opportunities, []);
    if (mode === 'unavailable') assert.ok(result.unavailableLegs > 0);
  }
});


test('tiny high-spot pools cannot crowd both funded assets out of the executable four-hop shortlist', async () => {
  const pinned = 526452778n;
  const result = await scanArbitrumPaths(fixture('shallow', pinned), pinned, 2000, 50);
  assert.equal(result.pools, 10);
  assert.ok(result.paths <= 8 && result.quotedRoutes <= 8, 'at most four paths per funded asset and size');
  assert.ok(result.opportunities.some(r => r.symbol === 'WETH'));
  const route = result.opportunities.find(r => r.symbol === 'USDC');
  assert.ok(route);
  assert.deepEqual(route.legs.map(l => l.pool), markets.map(m => m.pool));
  assert.equal(result.best?.payoutUsd, result.opportunities[0].payoutUsd);
});

test('a competitive 1% Uniswap pool fits within the existing four-route shortlist', async () => {
  const active = { ...markets[0], pool: '0x42fc852a750ba93d5bf772ecdc857e87a86403a9', tier: 10_000,
    n: markets[0].n * 103n, d: markets[0].d * 100n };
  const dry = { ...markets[1], pool: '0x92fd143a8fa0c84e016c2765648b9733b0aa519e', kind: 2, tier: 10_000 };
  const source = fixture('shallow', block, [active, dry]);
  let feeProbes = 0, stateReads = 0, exactReads = 0;
  const client = { multicall: async (request: { blockNumber: bigint; contracts: Request[] }) => {
    const rows = await source.multicall(request as Parameters<typeof source.multicall>[0]);
    return request.contracts.map(({ functionName, address, args = [] }, i) => {
      if (functionName === 'getPool' && args[2] === 10_000) {
        feeProbes++;
        // A later duplicate address must not create another market or state read.
        if (args.includes(weth) && args.includes(usdg)) return { status: 'success', result: active.pool };
      }
      if ((functionName === 'slot0' || functionName === 'liquidity') && address === active.pool) stateReads++;
      if (functionName === 'liquidity' && address === dry.pool) return { status: 'success', result: 0n };
      if (functionName === 'quoteExactInputSingle') {
        const leg = args[0] as { fee: number; tokenIn: Address; tokenOut: Address };
        if (leg.fee === 10_000) {
          assert.deepEqual([leg.tokenIn, leg.tokenOut].sort(), [weth, usdc].sort(), 'the dry pool never reaches the quoter');
          exactReads++;
          const [out, ...rest] = (rows[i] as { result: readonly bigint[] }).result;
          return { status: 'success', result: [out * 99n / 100n, ...rest] };
        }
      }
      return rows[i];
    });
  } } as unknown as ArbitrumClient;
  const result = await scanArbitrumPaths(client, block, 2000, 50);
  assert.equal(feeProbes, 6);
  assert.equal(stateReads, 2);
  assert.ok(exactReads > 0);
  assert.ok(result.paths <= 8 && result.quotedRoutes <= 8, 'four quotes per asset at the single capped amount');
  const route = result.opportunities.find(r => r.asset === usdc && r.legs[0].pool === active.pool);
  assert.ok(route);
  assert.deepEqual(route.legs.map(leg => leg.pool), [active.pool, ...markets.slice(1).map(m => m.pool)]);
  const first = route.amountIn * active.n / active.d * 99n / 100n;
  const received = markets.slice(1).reduce((amount, market) => amount * market.n / market.d, first);
  assert.equal(route.payout, received - route.amountIn);
});

function sizingFixture(spreadPpm: bigint, reserve: bigint, failRefinement = false) {
  const base = fixture();
  const firstLoans: bigint[] = [];
  const legs = new Set<string>();
  const ordinarySizes = [50_000_000n, 250_000_000n];
  const client = { multicall: async (request: { blockNumber: bigint; contracts: Request[] }) => {
    const rows = await base.multicall(request as Parameters<typeof base.multicall>[0]);
    return request.contracts.map(({ functionName, args = [], address }, i) => {
      const ok = (result: unknown) => ({ status: 'success', result });
      if (functionName === 'balanceOf') return ok(address === usdc ? ordinarySizes[1] : 0n);
      const spot = 1 + Number(spreadPpm) / 1e6;
      if (address === markets[3].pool && functionName === 'slot0') return ok(BigInt(Math.floor(2 ** 96 * Math.sqrt(spot))));
      if (address === markets[3].pool && functionName === 'liquidity') return ok(BigInt(Math.floor(Number(reserve) * Math.sqrt(spot))));
      if (!functionName.startsWith('quote')) return rows[i];
      const uni = functionName === 'quoteExactInputSingle';
      const input = uni ? (args[0] as { tokenIn: Address }).tokenIn : args[1] as Address;
      const amount = uni ? (args[0] as { amountIn: bigint }).amountIn : args[2] as bigint;
      const key = [uni ? markets[0].pool : args[0], input, amount].join('/');
      assert.ok(!legs.has(key), 'a pinned pool/input/amount quote is requested once');
      legs.add(key);
      if (uni && input === usdc) {
        firstLoans.push(amount);
        if (failRefinement && !ordinarySizes.includes(amount)) throw new Error('refinement RPC unavailable');
        // The first fixed conversion includes the V3 500 ppm fee.
        const out = amount * markets[0].n * 999_500n / (markets[0].d * 1_000_000n);
        return ok([out, 1n << 96n, 0n, 0n]);
      }
      if (!uni && args[0] === markets[3].pool && input === usdg) {
        const out = amount * (1_000_000n + spreadPpm) * reserve / ((reserve + amount) * 1_000_000n);
        return ok([out, 1n << 96n, 0n]);
      }
      return rows[i];
    });
  } } as unknown as ArbitrumClient;
  return { client, firstLoans, legs };
}

test('an intermediate USDC loan clears the net floor on the same market where the fixed sizes miss it', async t => {
  const run = async (minimumNetUsd: number, fail = false) => {
    const market = sizingFixture(1701n, 208_333_333_333n, fail);
    const result = await scanArbitrumPaths(market.client, block, 2000, 250, minimumNetUsd);
    return { ...market, result };
  };
  // A deliberately unreachable refinement threshold observes only the original ladder.
  const fixed = await run(100);
  const adaptive = await run(0.05);
  assert.deepEqual(fixed.firstLoans, [50_000_000n, 250_000_000n]);
  assert.deepEqual(adaptive.firstLoans.slice(0, 2), fixed.firstLoans);
  assert.equal(adaptive.firstLoans.length, 3);
  const [best] = adaptive.result.opportunities;
  assert.ok(best.loanUsd > 120 && best.loanUsd < 130);
  assert.equal(best.amountIn, adaptive.firstLoans[2]);
  assert.equal(adaptive.legs.size, fixed.legs.size + 4, 'only the extra four-hop cycle was quoted');
  assert.deepEqual(adaptive.result.refinement, { tried: 1, quoted: 1, bestPayoutUsd: best.payoutUsd,
    baselineBestPayoutUsd: fixed.result.best!.payoutUsd });
  const paddedGasUsd = 0.01;
  assert.ok(fixed.result.best!.payoutUsd < 0.05);
  assert.ok(best.payoutUsd * 0.9 - paddedGasUsd >= 0.05, 'exact payout clears the 10% cushion, padded fee and net floor');
  t.diagnostic('Fixed gross $' + fixed.result.best!.payoutUsd + ', refined $' + best.loanUsd + ' loan gross $' + best.payoutUsd
    + ', cushioned net $' + (best.payoutUsd * 0.9 - paddedGasUsd).toFixed(6) + ' at $0.01 padded gas.');
  const unavailable = await run(0.05, true);
  assert.deepEqual(unavailable.result.best, fixed.result.best);
  assert.deepEqual(unavailable.result.opportunities, fixed.result.opportunities);
  assert.equal(unavailable.result.refinement.tried, 1);
  assert.equal(unavailable.result.refinement.quoted, 0);
  assert.equal(unavailable.result.refinement.bestPayoutUsd, null);
});

test('an already qualifying ladder quote and a losing market both skip every refinement read', async () => {
  for (const [spread, reserve, winning] of [[4000n, 208_333_333_333n, true], [1701n, 20_000_000_000n, false]] as const) {
    const market = sizingFixture(spread, reserve);
    const result = await scanArbitrumPaths(market.client, block, 2000, 250);
    assert.deepEqual(market.firstLoans, [50_000_000n, 250_000_000n]);
    assert.ok(winning ? result.best!.payoutUsd >= 0.05 : result.best!.payoutUsd < 0);
    assert.deepEqual(result.refinement, { tried: 0, quoted: 0, bestPayoutUsd: null, baselineBestPayoutUsd: result.best!.payoutUsd });
  }
});

test('a refined final leg arriving after its deadline preserves the completed ladder quotes', async t => {
  let time = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => time);
  const ordinary = sizingFixture(1701n, 208_333_333_333n);
  const reference = await scanArbitrumPaths(ordinary.client, block, 2000, 250, 100);
  const market = sizingFixture(1701n, 208_333_333_333n);
  const delayed = { multicall: async (request: { blockNumber: bigint; contracts: Request[] }) => {
    const rows = await market.client.multicall(request as Parameters<typeof market.client.multicall>[0]);
    if (market.firstLoans.length === 3 && request.contracts.some(c => c.args?.[0] === markets[3].pool)) time += 2000;
    return rows;
  } } as unknown as ArbitrumClient;
  const result = await scanArbitrumPaths(delayed, block, 2000, 250);
  assert.deepEqual(result.opportunities, reference.opportunities);
  assert.deepEqual(result.best, reference.best);
  assert.deepEqual(result.refinement, { tried: 1, quoted: 0, bestPayoutUsd: null, baselineBestPayoutUsd: reference.best!.payoutUsd });
});
