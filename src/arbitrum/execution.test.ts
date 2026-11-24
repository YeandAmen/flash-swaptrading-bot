import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, encodeFunctionResult, parseEther, type Address } from 'viem';
import { ARBITRUM_FLASH_ARB_ABI } from './artifact.js';
import { ARBITRUM_FLASH_ARB_LOGIC_V2_ABI } from './artifact-logic-v2.js';
import { arbitrumReleaseHash } from './proxy.js';
import { bidArbitrumFeeHeadroom } from './profit.js';
import type { ArbPathQuote } from './paths.js';
import { prepareArbitrumOrder, type ArbitrumOrderRejection } from './execution.js';
import type { ArbQuote, ArbitrumClient } from './market.js';

const owner: Address = '0x0000000000000000000000000000000000000001';
const contract: Address = '0x0000000000000000000000000000000000000002';
const buy: ArbQuote['order']['buy'] = { kind: 2, pool: owner, fee: 500, tickSpacing: 0, nativeEth: false };
const profitable: ArbQuote = {
  order: { funding: 1, token: owner, buy, sell: { ...buy, pool: contract }, amountIn: parseEther('1'),
    minProfit: 1n, tip: 0n, maxBlock: 110n },
  symbol: 'WETH/USDC',
  payout: parseEther('0.001'),
};

function clientFor({ head = 104n, preparationBlock = 100n, payout = profitable.payout, feeCap = 100_000_000n,
  timestamp = BigInt(Math.floor(Date.now() / 1000)) } = {}) {
  let finalMinProfit = 0n;
  let finalDeadline = 0n;
  const client = {
    getBlock: async () => ({ number: preparationBlock, timestamp }),
    getBlockNumber: async () => head,
    estimateGas: async () => 200_000n,
    estimateFeesPerGas: async () => ({ maxFeePerGas: feeCap, maxPriorityFeePerGas: 1_000_000n }),
    call: async ({ data, blockTag }: { data: `0x${string}`; blockTag: string }) => {
      assert.equal(blockTag, 'pending');
      const parsed = decodeFunctionData({ abi: ARBITRUM_FLASH_ARB_ABI, data });
      assert.equal(parsed.functionName, 'execute');
      if (parsed.functionName === 'execute') {
        finalMinProfit = parsed.args[0].minProfit;
        finalDeadline = parsed.args[0].maxBlock;
      }
      return { data: encodeFunctionResult({ abi: ARBITRUM_FLASH_ARB_ABI, functionName: 'execute', result: payout }) };
    },
  } as unknown as ArbitrumClient;
  return { client, finalMinProfit: () => finalMinProfit, finalDeadline: () => finalDeadline };
}

test('Arbitrum signing gate requires fresh execution to cover padded gas and the net floor', async () => {
  const ok = clientFor();
  const quote = await prepareArbitrumOrder(ok.client, contract, owner, profitable, 2_000, 0.05, 0.50);
  assert.ok(quote.ok);
  assert.equal(quote.worstGasUsd, 0.05);
  assert.equal(ok.finalMinProfit(), quote.gasBudget + parseEther('0.000025'));
  const delayed = clientFor({ preparationBlock: 117n, head: 119n });
  const refreshed = await prepareArbitrumOrder(delayed.client, contract, owner, profitable, 2_000, 0.05, 0.50);
  assert.ok(refreshed.ok);
  assert.equal(delayed.finalDeadline(), 127n);
  assert.deepEqual(await prepareArbitrumOrder(clientFor({ head: 110n }).client, contract, owner, profitable, 2_000, 0.05, 0.50),
    { ok: false, reason: 'deadline' });
  assert.deepEqual(await prepareArbitrumOrder(clientFor({ payout: 1n }).client, contract, owner, profitable, 2_000, 0.05, 0.50),
    { ok: false, reason: 'net-floor' });
  assert.deepEqual(await prepareArbitrumOrder(clientFor({ feeCap: 2_000_000_000n }).client, contract, owner, profitable, 2_000, 0.05, 0.50),
    { ok: false, reason: 'fee-cap' });
});

test('automatic fallback priority fits the existing fee ceiling on the 527095270 quote', async () => {
  const rawFees = { maxFeePerGas: 24_480_000n, maxPriorityFeePerGas: 0n };
  const base = 20_400_000n;
  const bid = bidArbitrumFeeHeadroom(rawFees, base);
  assert.deepEqual(bid, { maxFeePerGas: 24_480_000n, maxPriorityFeePerGas: 2_040_000n });
  assert.equal(bidArbitrumFeeHeadroom({ ...rawFees, maxPriorityFeePerGas: 1n }, base).maxPriorityFeePerGas, 1n);
  for (const unavailable of [undefined, null, 0n, rawFees.maxFeePerGas, rawFees.maxFeePerGas + 1n]) {
    assert.equal(bidArbitrumFeeHeadroom(rawFees, unavailable).maxPriorityFeePerGas, 0n);
  }
  assert.equal(bidArbitrumFeeHeadroom({ ...rawFees, maxFeePerGas: base + 3n }, base).maxPriorityFeePerGas, 1n);
  assert.equal(bidArbitrumFeeHeadroom({ ...rawFees, maxFeePerGas: base + 100_000_000n }, base).maxPriorityFeePerGas, 5_000_000n);

  const seen: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }[] = [];
  const client = { ...clientFor().client,
    getBlock: async () => ({ number: 100n, timestamp: BigInt(Math.floor(Date.now() / 1000)), baseFeePerGas: base }),
    estimateFeesPerGas: async () => rawFees,
    call: async (args: typeof rawFees) => {
      seen.push({ maxFeePerGas: args.maxFeePerGas, maxPriorityFeePerGas: args.maxPriorityFeePerGas });
      return { data: encodeFunctionResult({ abi: ARBITRUM_FLASH_ARB_ABI, functionName: 'execute', result: profitable.payout }) };
    },
  } as unknown as ArbitrumClient;
  const live = { sourceBlock: 100n, bidFeeHeadroom: true, canSign: () => true,
    readWallet: async () => ({ nonce: 6, pending: 6, balance: parseEther('1') }) };
  const ordinary = await prepareArbitrumOrder(client, contract, owner, profitable, 2_000, 0.05, 0.5, false, undefined, live);
  assert.ok(ordinary.ok);
  assert.deepEqual(seen, [bid, bid]);
  assert.equal(ordinary.tx.maxPriorityFeePerGas, bid.maxPriorityFeePerGas);
  assert.equal(ordinary.gasBudget, ordinary.tx.gas * rawFees.maxFeePerGas);
  seen.length = 0;
  const standard = await prepareArbitrumOrder(client, contract, owner, profitable, 2_000, 0.05, 0.5);
  assert.ok(standard.ok);
  assert.deepEqual(seen, [rawFees]);
  assert.equal(standard.gasBudget, ordinary.gasBudget);
});

test('an explicit Arbitrum test isolates the network fee exception', async () => {
  const tiny = { ...profitable, payout: 1000n };
  const fixture = clientFor({ payout: 1000n });
  assert.deepEqual(await prepareArbitrumOrder(fixture.client, contract, owner, tiny, 2_000, 0.05, 0.50),
    { ok: false, reason: 'net-floor' });
  const allowed = await prepareArbitrumOrder(fixture.client, contract, owner, tiny, 2_000, 0.05, 0.50, true);
  assert.ok(allowed.ok && allowed.netUsd < 0);
  assert.equal(fixture.finalMinProfit(), 1n);
  assert.deepEqual(await prepareArbitrumOrder(fixture.client, contract, owner, tiny, 2_000, 0.05, 0.01, true),
    { ok: false, reason: 'fee-cap' });
  assert.deepEqual(await prepareArbitrumOrder(clientFor({ payout: 0n }).client, contract, owner, tiny, 2_000, 0.05, 0.50, true),
    { ok: false, reason: 'net-floor' });
});

test('USDC multi-hop requires its reviewed release and protects dollar costs in six-decimal asset units', async t => {
  const at = 1_800_000_000_075;
  t.mock.method(Date, 'now', () => at);
  const path: ArbPathQuote = { asset: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', amountIn: 100_000_000n,
    decimals: 6, symbol: 'USDC', assetUsd: 0.95, loanUsd: 95, payout: 200_000n, payoutUsd: 0.19,
    block: 100n, label: 'USDC cycle', legs: [owner, contract, owner].map((pool) => ({ kind: 2, pool, tokenOut: contract, tickSpacing: 0 })) };
  let minimum = 0n;
  const client = { ...clientFor().client, call: async ({ data }: { data: `0x${string}` }) => {
    const parsed = decodeFunctionData({ abi: ARBITRUM_FLASH_ARB_LOGIC_V2_ABI, data });
    assert.equal(parsed.functionName, 'executePath');
    if (parsed.functionName !== 'executePath') throw new Error('unexpected selector');
    assert.equal(parsed.args[0], arbitrumReleaseHash);
    minimum = parsed.args[1].minProfit;
    return { data: encodeFunctionResult({ abi: ARBITRUM_FLASH_ARB_LOGIC_V2_ABI, functionName: 'executePath', result: path.payout }) };
  } } as unknown as ArbitrumClient;
  assert.deepEqual(await prepareArbitrumOrder(client, contract, owner, path, 2_000, 0.05, 0.5), { ok: false, reason: 'unsupported-path' });
  assert.deepEqual(await prepareArbitrumOrder(client, contract, owner, path, 2_000, 0.05, 0.5, true, arbitrumReleaseHash),
    { ok: false, reason: 'unsupported-path' });
  for (const [observedBlock, reason] of [[49n, 'quote-too-old'], [101n, 'head-behind-source']] as const) {
    assert.deepEqual(await prepareArbitrumOrder(client, contract, owner, { ...path, block: observedBlock },
      2_000, 0.05, 0.5, false, arbitrumReleaseHash), { ok: false, reason: 'stale-quote',
      stale: { at, headBlock: 100, headTimestamp: 1_800_000_000, headAgeMs: 75, reason } });
  }
  assert.ok((await prepareArbitrumOrder(client, contract, owner, { ...path, block: 50n },
    2_000, 0.05, 0.5, false, arbitrumReleaseHash)).ok);
  const prepared = await prepareArbitrumOrder(client, contract, owner, path, 2_000, 0.05, 0.5, false, arbitrumReleaseHash);
  assert.ok(prepared.ok);
  assert.equal(minimum, 105264n);
  assert.ok(Math.abs(prepared.netUsd - 0.14) < 1e-10);
});

test('two-swap freshness preserves the deadline boundary and reports signed header age at rejection', async t => {
  const timestamp = 1_800_000_000n;
  let now = Number(timestamp) * 1000;
  t.mock.method(Date, 'now', () => now);
  for (const [height, age, reason] of [
    [160n, 5000, null], [160n, -5000, null], [99n, 0, null],
    [100n, 5001, 'head-clock-behind'], [100n, -5001, 'head-clock-ahead'], [161n, -5001, 'quote-too-old'],
  ] as const) {
    now = Number(timestamp) * 1000 + age;
    const { client } = clientFor({ head: height, preparationBlock: height, timestamp });
    const prepared = await prepareArbitrumOrder(client, contract, owner, profitable, 2000, 0.05, 0.50);
    if (!reason) assert.ok(prepared.ok);
    else assert.deepEqual(prepared, { ok: false, reason: 'stale-quote',
      stale: { at: now, headBlock: Number(height), headTimestamp: Number(timestamp), headAgeMs: age, reason } });
  }
});

test('Arbitrum preparation reports the failing RPC stage without exposing provider errors', async () => {
  const fixture = clientFor();
  const fail = async () => { throw new Error('https://example.com/private-rpc-token'); };
  const cases: [ArbitrumClient, ArbitrumOrderRejection][] = [
    [{ ...fixture.client, getBlock: fail }, 'head-rpc'],
    [{ ...fixture.client, estimateFeesPerGas: fail }, 'fee-rpc'],
    [{ ...fixture.client, call: fail }, 'simulation-rpc'],
  ];
  for (const [client, reason] of cases) {
    assert.deepEqual(await prepareArbitrumOrder(client, contract, owner, profitable, 2_000, 0.05, 0.50), { ok: false, reason });
  }
});
