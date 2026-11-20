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
  const { ADDR, CORE_TOKENS } = await import('../dist/config.js');
  const { publicClient } = await import('../dist/chain.js');
  const { bestCycle, buildStateReads, discoverArbPools, MEV_EXTRA_TOKENS, poolVenue, reservesOf, toNextVenue } =
    await import('../dist/mev/pools.js');
  const { selectActiveTokens } = await import('../dist/mev/universe.js');

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
