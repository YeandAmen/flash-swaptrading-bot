// Run with node test/mev-discovery.mjs after npm run build.
// Pass a loopback Anvil RPC forked at Ethereum block 26455000 to also verify canonical pool discovery and pricing.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const forkRpc = process.argv[2];
const rpc = new URL(forkRpc ?? 'http://127.0.0.1:18647');
assert.equal(rpc.protocol, 'http:');
assert.ok(['127.0.0.1', '[::1]'].includes(rpc.hostname));
const temporary = mkdtempSync(join(tmpdir(), 'eth-mev-discovery-'));
Object.assign(process.env, { FORK_MODE: '1', RPC_URL: rpc.href, SEND_RPC_URL: rpc.href,
  ALLOW_LIVE_TRADING: 'off', DATA_DIR: temporary, WALLET_KEY_FILE: join(temporary, 'disposable-wallet.json') });

try {
  const { ADDR, CORE_TOKENS, MEV } = await import('../dist/config.js');
  const { publicClient } = await import('../dist/chain.js');
  const { bestCycle, buildStateReads, curveBuyRefinement, discoverArbPools, MEV_EXTRA_TOKENS, poolVenue, reservesOf, toNextVenue } =
    await import('../dist/mev/pools.js');
  const { selectActiveTokens } = await import('../dist/mev/universe.js');
  const { AERO_CL_FACTORY } = await import('../dist/mev/next-pools.js');
  const { proxyReleaseHash } = await import('../dist/mev/proxy.js');
  const { MevSearcher } = await import('../dist/mev/searcher.js');

  const token = CORE_TOKENS.find(({ symbol }) => symbol === 'WBTC');
  const wethIs0 = BigInt(ADDR.weth) < BigInt(token.address);
  const address = (index) => '0x' + String(index).padStart(40, '0');
  const ordinary = (index, venue, depthWeth) => ({ address: address(index), venue, depthWeth, v2: !venue.includes(' v3 '), fee: 0.003 });
  const first = ordinary(1, 'Uniswap v3 0.01%', 100);
  const sameVenue = ordinary(2, 'Uniswap v3 0.05%', 80);
  const otherVenue = ordinary(3, 'SushiSwap', 45);
  const shallow = ordinary(4, 'PancakeSwap v2', 15);
  const universeToken = { token, wethIs0, pools: [sameVenue, shallow, first, otherVenue] };
  assert.deepEqual(selectActiveTokens([universeToken], 2)[0].pools, [first, otherVenue]);
  assert.deepEqual(selectActiveTokens([{ ...universeToken, pools: [first, sameVenue, shallow] }], 2)[0].pools,
    [first, sameVenue], 'keep the superior same-venue second leg when the alternative is shallow');

  const stable = MEV_EXTRA_TOKENS.find(({ symbol }) => symbol === 'USDC');
  const tether = MEV_EXTRA_TOKENS.find(({ symbol }) => symbol === 'USDT');
  const aeroPool = { address: '0xd661623947ef2ead12d577b47021c167d163b0c5', venue: 'Aero Slipstream', kind: 8, v2: false, fee: 0 };
  const success = result => ({ status: 'success', result });
  const failed = { status: 'failure' };
  const originalMulticall = publicClient.multicall;
  let optionalFailure = false;
  const aeroLookups = [];
  try {
    publicClient.multicall = async ({ contracts }) => contracts.map(call => {
      if (call.address === AERO_CL_FACTORY) {
        aeroLookups.push(call.args);
        return optionalFailure ? failed : success(call.args[0] === stable.address ? aeroPool.address : address(20));
      }
      if (call.functionName === 'getPool') return success(call.address === ADDR.uniFactory && call.args[2] === 500 ? address(5) : address(0));
      if (call.functionName === 'getPair') return success(address(0));
      return success(100n * 10n ** 18n);
    });
    const tokens = [stable, tether, { ...token, symbol: 'USDC' }];
    assert.deepEqual(await discoverArbPools(tokens, 1), []);
    assert.deepEqual(aeroLookups, [], 'older releases spend no Aero discovery budget');
    const markets = await discoverArbPools(tokens, 1, { includeAero: true });
    assert.deepEqual(aeroLookups, [[stable.address, ADDR.weth, 50], [tether.address, ADDR.weth, 50]]);
    assert.equal(markets.length, 2);
    assert.ok(markets.every(t => t.pools.length === 2 && t.pools.some(p => p.kind === 8)));
    optionalFailure = true;
    assert.deepEqual(await discoverArbPools(tokens, 1, { includeAero: true }), []);
  } finally { publicClient.multicall = originalMulticall; }

  const pair = { token: stable, wethIs0: false, pools: [aeroPool, { ...first, kind: 2, fee: 0.0005 }] };
  const reads = buildStateReads([pair]);
  assert.deepEqual(reads.contracts.slice(2, 5).map(call => call.functionName), ['slot0', 'liquidity', 'fee']);
  assert.equal(reads.contracts[2].abi.find(x => x.name === 'slot0').outputs.length, 6);
  assert.deepEqual(toNextVenue(aeroPool), { kind: 8, pool: aeroPool.address, fee: 0, tickSpacing: 50, nativeEth: false });
  // Ethereum 26481443, including the dynamic fee and canonical factory's two-swap market.
  const slot = [1916362932470542656428128511983616n, 201882, 855, 900, 900, true];
  const uniSlot = [1918658504726226871868652321296582n, 201906, 275, 723, 723, 68, true];
  const liq = 761393202730698280n;
  const aeroState = [success(slot), success(liq), success(218)];
  const priced = reservesOf(pair, aeroPool, aeroState, 0);
  assert.equal(priced.buyFee, 0.000218);
  assert.equal(priced.sellFee, 0.000218);
  assert.equal(reservesOf(pair, aeroPool, [success(slot), success(liq), success(3500)], 0).buyFee, 0.0035);
  for (const bad of [failed, success(-1), success(1e6), success(10.5), success(null)]) {
    assert.equal(reservesOf(pair, aeroPool, [success(slot), success(liq), bad], 0), null);
  }
  assert.equal(reservesOf(pair, aeroPool, [success(slot), success(0n), success(218)], 0), null);
  assert.equal(reservesOf(pair, aeroPool, [success([...slot.slice(0, 5), false]), success(liq), success(218)], 0), null);

  // Pinned Aero MetaQuoter + Uni QuoterV2 round-trip proceeds for the five ordinary scanner proposals.
  const grossBySize = new Map([
    [12882984512425461760n, 10801605221861263n], [7085641481834004480n, 8615287746923889n],
    [1932447676863819264n, 2998426418994914n], [21901073671123283968n, 4732511094372272n],
    [10306387609940369408n, 10369830805865116n],
  ]);
  const saved = { funding: MEV.funding, submission: MEV.submission, maxLoanUsd: MEV.maxLoanUsd };
  async function scanAero({ funding = 'auto', release = proxyReleaseHash, reverse = false, limit = Infinity, manual = false } = {}) {
    Object.assign(MEV, { funding, submission: 'bundle', maxLoanUsd: limit });
    const searcher = new MevSearcher({ ethUsd: () => 1706.87581561, log() {}, tradePending: () => false }, false);
    searcher.file.proxyContract = address(27);
    searcher.file.proxyRelease = release;
    if (manual) {
      searcher.queuedTest = { id: 'manual', expiresAt: Date.now() + 60_000 };
      searcher.scanGasOnlyTest = async () => {};
    }
    const calls = [];
    searcher.simulate = async (_token, buy, sell, amount, _deadline, block, funding) => {
      calls.push({ buy: buy.kind, sell: sell.kind, amount, block, funding });
      const profit = reverse || Number.isFinite(limit) ? 10n ** 16n : grossBySize.get(amount);
      assert.ok(profit, 'unknown size in the historical fixture');
      return { ok: true, profit };
    };
    await searcher.onBlock({ blockNumber: 26481443n, hash: '0xd09ff935a70b798f0b468625f6b0bf3c6fc2531afff6583225d9170b7f64edf8',
      timestamp: Math.floor(Date.now() / 1000), nextBaseFee: 2107315504n, tokens: [pair], at: reads.at,
      results: [success(26481443n), success(0n), ...aeroState,
        success(reverse ? [slot[0] * 999n / 1000n, ...uniSlot.slice(1)] : uniSlot), success(3832058717280284881n)],
      readMs: 0, failedChunks: 0 });
    return { calls, candidates: searcher.lastBlock.candidates, best: searcher.file.recent[0] };
  }
  try {
    const natural = await scanAero();
    assert.deepEqual(natural.calls.map(c => c.amount), [...grossBySize.keys()]);
    assert.ok(natural.calls.every(c => c.funding === 2 && c.buy === 8 && c.sell === 2 && c.block === 26481443n));
    assert.equal(natural.best.grossEth, Number(10801605221861263n) / 1e18);
    assert.equal(natural.best.funding, 'Morpho Blue');
    assert.equal(natural.best.sizeEth, Number(12882984512425461760n) / 1e18);
    const reverse = await scanAero({ funding: 'morpho', reverse: true, limit: 1706.87581561 });
    assert.ok(reverse.calls.length > 0 && reverse.calls.every(c => c.funding === 2 && c.sell === 8 && c.amount <= 10n ** 18n));
    for (const excluded of [{ funding: 'pool' }, { funding: 'aave' }, { funding: 'spark' }, { funding: 'balancer' },
      { release: '0x24eeea8287c4dcd7878691e0a7af3e945dc32cdf941309cb34f44c1523ab47d7' }, { manual: true }]) {
      const result = await scanAero(excluded);
      assert.equal(result.candidates, 0, JSON.stringify(excluded));
      assert.equal(result.calls.length, 0);
    }
  } finally { Object.assign(MEV, saved); }

  const curve = { ...otherVenue, v2: false, fee: 0, venue: 'Curve Tricrypto-NG', kind: 7 };
  const quotes = { curve: {
    buy: [{ input: 1, output: 110 }, { input: 3, output: 315 }],
    sell: [{ input: 100, output: 0.9 }, { input: 300, output: 2.6 }],
  } };
  const { cycles } = bestCycle([curve, first], [quotes, { w: 100, t: 10000 }]);
  const path = cycles.find((cycle) => cycle.buy === 0 && cycle.sell === 1);
  assert.ok(path?.profit > 0 && path.dx <= 3, 'score a Curve leg using only the quotes within the measured range');
  const missing = bestCycle([curve, first], [{ curve: { ...quotes.curve, buy: [] } }, { w: 100, t: 10000 }]);
  assert.ok(missing.cycles.every((cycle) => cycle.buy !== 0), 'a missing quote cannot become an executable candidate');

  // Ethereum 26481007: the Curve WETH-to-WBTC knots and the WBTC/WETH 500 ppm exit are from one source block.
  const measuredBuy = [139900, 1398396, 5585904, 27835097].map((raw, i) => ({
    input: [0.05, 0.5, 2, 10][i], output: raw / 1e8,
  }));
  const exit = { ...first, fee: 0.0005 };
  const exitReserves = reservesOf({ token, wethIs0: false }, exit, [
    { status: 'success', result: [47441275561872219123115375842033664n] },
    { status: 'success', result: 126323962247006146n },
  ], 0);
  const curveReserves = { curve: { buy: measuredBuy, sell: [] } };
  const baseline = bestCycle([curve, exit], [curveReserves, exitReserves]).cycle;
  assert.equal(baseline.dx, 2, 'the ordinary screening and ranking model keeps its measured knot');
  const trial = curveBuyRefinement(measuredBuy, exitReserves, exit.fee, baseline.profit);
  assert.equal(trial, 1_480_595_136_236_223_488n, 'historically verified by the pinned Morpho proxy at this size');
  assert.equal(curveBuyRefinement(measuredBuy.slice(0, 3), exitReserves, exit.fee, baseline.profit), undefined,
    'an incomplete rising range cannot establish a peak');
  assert.equal(curveBuyRefinement(measuredBuy, exitReserves, exit.fee, 1), undefined,
    'a fit cannot add a trial without beating the existing route estimate');
  assert.equal(curveBuyRefinement(measuredBuy, curveReserves, 0, baseline.profit), undefined);
  for (const last of [{ input: 10, output: NaN }, { input: 2, output: 1 }, { input: 10, output: 0.01 }, { input: 10, output: 1 }]) {
    assert.equal(curveBuyRefinement([...measuredBuy.slice(0, 3), last], exitReserves, exit.fee, baseline.profit), undefined,
      'malformed or nonconcave quotes cannot nominate a principal');
  }

  if (forkRpc) {
    const block = 26455000n;
    assert.equal(await publicClient.getBlockNumber(), block);
    const stables = MEV_EXTRA_TOKENS.filter(({ symbol }) => ['USDC', 'USDT'].includes(symbol));
    const discovery = stables.concat(token);
    const options = { includePancakeV3: true, includePancakeV2: true };
    const legacy = await discoverArbPools(discovery, 2, options);
    assert.ok(legacy.every((entry) => entry.pools.every((pool) => pool.kind !== 7)));
    const routes = await discoverArbPools(discovery, 2, { ...options, includeCurve: true });
    assert.equal(routes.length, discovery.length);
    const reads = buildStateReads(routes);
    const results = await publicClient.multicall({ contracts: reads.contracts, blockNumber: block });
    assert.equal(results[0].result, block);
    for (const [i, entry] of routes.entries()) {
      const curveEdges = entry.pools.filter((pool) => pool.kind === 7);
      assert.equal(curveEdges.length, entry.token.symbol === 'WBTC' ? 2 : 1);
      for (const pool of curveEdges) {
        assert.equal(poolVenue(pool), 'Curve Tricrypto-NG');
        assert.ok(pool.depthWeth > 800);
        assert.equal(toNextVenue(pool).fee, 0);
        const decoded = reservesOf(entry, pool, results, reads.at[i][entry.pools.indexOf(pool)]);
        assert.ok(decoded?.curve?.buy.length >= 3 && decoded?.curve?.sell.length >= 3);
      }
    }
    console.log('PASS: canonical Curve WETH/USDC, WETH/USDT and both WETH/WBTC pool edges and block-pinned directional quotes');
  }
  console.log('PASS: venue-aware read budget and bounded mixed-venue candidate scoring');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
