import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { BaseError, ContractFunctionExecutionError, decodeFunctionData, encodeAbiParameters, keccak256, parseAbiParameters,
  parseEther, zeroAddress, type Address, type Hex } from 'viem';
import { ARBITRUM_FLASH_ARB_LOGIC_V2_ABI } from './artifact-logic-v2.js';
import type { ArbPathQuote } from './paths.js';

process.env.RPC_URL ??= 'http://127.0.0.1:8545';
const { ArbitrumWorker } = await import('./worker.js');
const { arbitrumReleaseHash, arbitrumPinnedCall } = await import('./proxy.js');
const token = '0x0000000000000000000000000000000000000001';
const contract = '0x0000000000000000000000000000000000000002';
const head = 100n;
const quote: ArbPathQuote = { asset: token, symbol: 'USDC', decimals: 6, assetUsd: 1, amountIn: 50_000_000n,
  payout: 1_000_000n, payoutUsd: 1, loanUsd: 50, block: head, label: 'USDC cycle',
  legs: ([token, contract, token] as const).map(pool => ({ kind: 2, pool, tokenOut: contract, tickSpacing: 0 })) };

test('partial pool discovery preserves verified pools, includes new ones and retries after 30 seconds', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const usdc = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
  const usdce = '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8';
  const v3 = new Map([[100, token], [500, contract], [3000, '0x0000000000000000000000000000000000000003']]);
  const key = (fee: number) => keccak256(encodeAbiParameters(parseAbiParameters('address,address,uint24,int24,address'),
    [zeroAddress, usdce, fee, 1, zeroAddress]));
  const stablePool = key(8), newStablePool = key(100);
  let block = 100n;
  const factoryBlocks: bigint[] = [];
  const worker = new ArbitrumWorker(async () => ({
    opportunities: [], best: null, pools: 0, paths: 0, quotedRoutes: 0, unavailableLegs: 0,
  }));
  const client = {
    getBlockNumber: async () => block,
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'latestRoundData') return [1n, 2000n * 10n ** 8n, 0n, BigInt(Math.floor(Date.now() / 1000)), 1n];
      if (functionName === 'getConfiguration') return 1n << 56n | 1n << 63n;
      if (functionName === 'FLASHLOAN_PREMIUM_TOTAL' || functionName === 'balanceOf') return 0n;
      throw new Error('Unexpected read');
    },
    multicall: async ({ blockNumber, contracts }: { blockNumber: bigint; contracts: {
      address: Address; functionName: string; args?: readonly unknown[];
    }[] }) => {
      assert.equal(blockNumber, block);
      if (contracts[0]?.functionName === 'getPool') factoryBlocks.push(block);
      return contracts.map(({ address, functionName, args = [] }) => {
        const ok = (result: unknown) => ({ status: 'success', result });
        const missing = { status: 'failure', error: new Error('unavailable') };
        if (functionName === 'getPool') {
          const fee = Number(args[2]);
          if (args[1] !== usdc) return ok(zeroAddress);
          if (block === 101n && fee === 100) return missing;
          return ok(fee === 3000 && block === 100n ? zeroAddress : v3.get(fee) ?? zeroAddress);
        }
        if (functionName === 'liquidity') {
          if (address === token && block === 101n) return missing;
          return ok(address === token && block >= 103n ? 0n : 1n);
        }
        if (functionName === 'getLiquidity') {
          if (args[0] === stablePool) return block === 101n ? missing : ok(block < 103n ? 1n : 0n);
          return ok(args[0] === newStablePool && block > 100n ? 1n : 0n);
        }
        assert.ok(functionName === 'slot0' || functionName === 'getSlot0');
        return ok([1n << 96n, 0, 0, 0]);
      });
    },
  };
  Object.assign(worker, { verified: true, owner: '', client });
  await worker.scan();
  assert.equal(worker.summary.pools, 2, 'the first USDC.e pool alone cannot form a round trip');
  block = 101n;
  now += 5 * 60_000;
  await worker.scan();
  assert.equal(worker.summary.pools, 5, 'new pools combine with previously verified v3 and singleton v4 pools');
  block = 102n;
  now += 29_999;
  await worker.scan();
  assert.deepEqual(factoryBlocks, [100n, 101n]);
  block = 103n;
  now++;
  await worker.scan();
  assert.deepEqual(factoryBlocks, [100n, 101n, 103n]);
  assert.equal(worker.summary.pools, 2, 'successful zero liquidity removes the dry v3 pool and breaks the USDC.e cycle');
  now += 30_000;
  await worker.scan();
  assert.deepEqual(factoryBlocks, [100n, 101n, 103n], 'a complete refresh returns to the normal five-minute cadence');
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

function fixture(options: { simulate?: boolean; unavailable?: boolean } = {}) {
  const foundPaths = deferred(), twoSwapReads = deferred(), releasePreparation = deferred();
  const preparations: string[] = [];
  let parallel = 0, peak = 0, observations = 0;
  const worker = new ArbitrumWorker(async () => {
    observations++;
    await foundPaths.promise;
    return { opportunities: observations === 1 ? [quote] : [], best: null, pools: 4, paths: 1, quotedRoutes: 1, unavailableLegs: 0 };
  });
  const journal: { pending: object | null; recent: never[]; test?: object } = { pending: null, recent: [] };
  const deployment = { releaseHash: arbitrumReleaseHash, kind: 'proxy', verified: true };
  const client = {
    getBlock: async () => ({ number: head, timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
    getBlockNumber: async () => head,
    getBalance: async () => 10n ** 18n,
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'latestRoundData') return [1n, 2_000n * 10n ** 8n, 0n, BigInt(Math.floor(Date.now() / 1000)), 1n];
      if (functionName === 'getConfiguration') return 1n << 56n | 1n << 63n;
      if (functionName === 'balanceOf') return parseEther('0.05');
      assert.equal(functionName, 'FLASHLOAN_PREMIUM_TOTAL');
      await twoSwapReads.promise;
      return 0n;
    },
    multicall: async ({ contracts }: { contracts: { args: [{ amountIn: bigint }] }[] }) => contracts.map(c => {
      if (options.unavailable) return { status: 'failure', error: new ContractFunctionExecutionError(
        new BaseError('RPC failed', { details: 'timeout' }), { abi: [], functionName: 'aggregate3' }) };
      return { status: 'success', result: [2n * c.args[0].amountIn, 1n << 96n, 0, 0n] };
    }),
    call: async () => ({ data: encodeAbiParameters([{ type: 'uint256' }], [quote.payout]) }),
    estimateFeesPerGas: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
    estimateGas: async ({ data }: { data: Hex }) => {
      const twoSwap = data.slice(0, 10) === arbitrumPinnedCall('0x12345678', arbitrumReleaseHash).slice(0, 10);
      if (!twoSwap) assert.equal(decodeFunctionData({ abi: ARBITRUM_FLASH_ARB_LOGIC_V2_ABI, data }).functionName, 'executePath');
      preparations.push(twoSwap ? 'two-swap' : 'path');
      peak = Math.max(peak, ++parallel);
      try { await releasePreparation.promise; } finally { parallel--; }
      if (options.simulate) return 100_000n;
      throw new Error('fixture stops before signing');
    },
  };
  const markets = [{ symbol: 'A', token, pools: [token, contract].map((pool, i) =>
    ({ kind: 2, pool, fee: i === 0 ? 100 : 500, tickSpacing: 0, nativeEth: false })) }];
  Object.assign(worker, { client, contract, owner: token, journal, deployment, markets,
    verified: true, halted: false, refreshAfter: Infinity, executorCheckAt: Infinity });
  Object.assign(worker.summary, { executor: contract, mode: 'live' });
  return { worker, foundPaths, twoSwapReads, releasePreparation, preparations, journal, deployment,
    peak: () => peak, observations: () => observations };
}

test('a truncated Arbitrum activity entry retains the numeric count of unavailable quote legs', async () => {
  const f = fixture({ unavailable: true });
  f.worker.summary.pathStatus = 'Long path status. '.repeat(30);
  f.twoSwapReads.resolve();
  await f.worker.scan();
  const { logs, unavailableLegs } = f.worker.view();
  assert.equal(unavailableLegs, 2);
  assert.equal(logs[0].message.length, 280);
  assert.match(logs[0].message, /^Block 100: 0 two-swap quotes across 2 pools, 2 unavailable quote legs\./);
  f.worker.stop();
  f.foundPaths.resolve();
});

test('a profitable path starts preparation while the two-swap scan waits, and both producers use one lane', async () => {
  const f = fixture();
  const scan = f.worker.scan();
  f.foundPaths.resolve();
  await nextTurn();
  assert.deepEqual(f.preparations, ['path']);
  f.twoSwapReads.resolve();
  await nextTurn();
  assert.deepEqual(f.preparations, ['path']);
  f.releasePreparation.resolve();
  await scan;
  assert.ok(f.preparations.includes('two-swap'));
  assert.equal(f.peak(), 1);
});

test('when the two-swap batch is already preparing, the later positive path is consumed exactly once', async () => {
  const f = fixture();
  const scan = f.worker.scan();
  f.twoSwapReads.resolve();
  await nextTurn();
  assert.deepEqual(f.preparations, ['two-swap']);
  f.foundPaths.resolve();
  await nextTurn();
  assert.deepEqual(f.preparations, ['two-swap']);
  f.releasePreparation.resolve();
  await scan;
  await nextTurn();
  assert.equal(f.preparations.filter(k => k === 'path').length, 1);
  assert.equal(f.peak(), 1);
});

test('a qualified path from an invalidated observation never starts preparation', async () => {
  for (const gate of ['stop and restart', 'unverified release', 'new test', 'pending intent'] as const) {
    const f = fixture();
    const scan = f.worker.scan();
    await nextTurn();
    assert.equal(f.observations(), 1);
    if (gate === 'stop and restart') { f.worker.stop(); Object.assign(f.worker, { active: true }); }
    if (gate === 'unverified release') f.deployment.verified = false;
    if (gate === 'new test') f.journal.test = { status: 'queued', expiresAt: Date.now() + 60_000 };
    if (gate === 'pending intent') f.journal.pending = {};
    f.foundPaths.resolve();
    f.twoSwapReads.resolve();
    f.releasePreparation.resolve();
    await scan;
    await nextTurn();
    assert.deepEqual(f.preparations, [], gate);
  }
});


test('paper worker simulates a path that arrives between polls and a later empty observation cannot erase it', async () => {
  const f = fixture({ simulate: true });
  Object.assign(f.worker, { markets: [], journal: null });
  f.worker.summary.mode = 'paper';
  f.twoSwapReads.resolve();
  await f.worker.scan();
  assert.deepEqual(f.preparations, []);
  f.foundPaths.resolve();
  f.releasePreparation.resolve();
  await nextTurn();
  assert.deepEqual(f.preparations, ['path', 'path']); // Initial and exact gas estimates for one preparation.
  assert.ok(f.worker.summary.netEstimateUsd && f.worker.summary.netEstimateUsd > 0);
  await f.worker.scan();
  await nextTurn();
  assert.equal(f.observations(), 2);
  assert.deepEqual(f.preparations, ['path', 'path']);
  assert.equal(f.worker.summary.pending, null);
});
