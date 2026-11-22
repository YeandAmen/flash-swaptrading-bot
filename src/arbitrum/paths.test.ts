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
function fixture(mode?: 'stale' | 'skipped-round' | 'future' | 'unavailable' | 'partial' | 'shallow', pinned = block) {
  const inventory: Market[] = [...markets];
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
        return success(address === usdc ? usdcLiquidity : wethLiquidity);
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
