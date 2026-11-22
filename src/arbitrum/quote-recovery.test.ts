import assert from 'node:assert/strict';
import test from 'node:test';
import { BaseError, ContractFunctionExecutionError, parseEther, type Address, type Hex } from 'viem';
import { arbitrumQuoteRecoveryReaders, defaultArbitrumRpc, scanArbitrum, type ArbitrumClient } from './market.js';

const blockNumber = 100n;
const blockHash: Hex = `0x${'ab'.repeat(32)}`;
const otherHash: Hex = `0x${'cd'.repeat(32)}`;
const token: Address = '0x0000000000000000000000000000000000000001';
const weth: Address = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const size = parseEther('0.05');

type Leg = { tokenIn: Address; fee: number; amountIn: bigint };
type QuoteCall = {
  contracts: { args: [Leg] }[]; batchSize: number; blockHash?: Hex; blockNumber?: bigint; requireCanonical?: boolean;
};
type Row = { status: 'success'; result: bigint[] } | { status: 'failure'; error: ContractFunctionExecutionError };
type Header = { hash: Hex; number: bigint };

const ok = (amount: bigint): Row => ({ status: 'success', result: [amount] });
const fail = (functionName: string, details: string): Row => ({
  status: 'failure', error: new ContractFunctionExecutionError(new BaseError('RPC failure', { details }), { abi: [], functionName }),
});
const gas = fail('aggregate3', 'out of gas');
const quota = fail('aggregate3', 'rate limited: too many requests');
const individual = fail('quoteExactInputSingle', 'execution reverted: out of gas');

function successfulQuote({ tokenIn, amountIn, fee }: Leg): Row {
  // Encode the buy pool in its output so a displaced retry row changes the downstream route.
  return ok(tokenIn === weth ? size + BigInt(fee) : amountIn);
}

function mixedPrimary(leg: Leg): Row {
  if (leg.tokenIn === weth) {
    if (leg.fee === 100) return gas;
    if (leg.fee === 101) return quota;
    if (leg.fee === 102) return individual;
  }
  if (leg.tokenIn === token && leg.amountIn === size + 103n && leg.fee === 100) return quota;
  return successfulQuote(leg);
}

async function scan(primaryQuote: (leg: Leg) => Row, alternateQuote: (leg: Leg) => Row,
  alternateHeader: Header | null = { number: blockNumber, hash: blockHash }, poolCount = 4, supportsHash = true) {
  const alternateCalls: QuoteCall[] = [];
  const alternateEvents: { tokenIn: Address; event: 'start' | 'finish' }[] = [];
  const primaryCalls: QuoteCall[] = [];
  const market: Parameters<typeof scanArbitrum>[2] = [{
    token, symbol: 'TEST',
    pools: Array.from({ length: poolCount }, (_, index) => ({
      kind: 2, pool: `0x${(100 + index).toString(16).padStart(40, '0')}` as Address,
      fee: 100 + index, tickSpacing: 0, nativeEth: false,
    })),
  }];
  const primary = {
    getBlock: async ({ blockNumber: requested }: { blockNumber: bigint }) => {
      assert.equal(requested, blockNumber);
      return { number: blockNumber, hash: blockHash };
    },
    readContract: async ({ functionName, blockHash: requestedHash }: { functionName: string; blockHash?: Hex }) => {
      if (requestedHash && !supportsHash) throw new Error('block hash queries unsupported');
      if (functionName === 'FLASHLOAN_PREMIUM_TOTAL') return 5n;
      if (functionName === 'getConfiguration') return (1n << 56n) | (1n << 63n);
      if (functionName === 'balanceOf') return size;
      assert.fail(`Unexpected primary read ${functionName}`);
    },
    multicall: async (call: QuoteCall) => {
      primaryCalls.push(call);
      return call.contracts.map(({ args: [leg] }) => primaryQuote(leg));
    },
  } as unknown as ArbitrumClient;
  const alternate = {
    getBlock: async ({ blockNumber: requested }: { blockNumber: bigint }) => {
      assert.equal(requested, blockNumber);
      if (!alternateHeader) throw new Error('block not found');
      return alternateHeader;
    },
    multicall: async (call: QuoteCall) => {
      alternateCalls.push(call);
      const { tokenIn } = call.contracts[0].args[0];
      alternateEvents.push({ tokenIn, event: 'start' });
      await Promise.resolve();
      alternateEvents.push({ tokenIn, event: 'finish' });
      return call.contracts.map(({ args: [leg] }) => alternateQuote(leg));
    },
  } as unknown as ArbitrumClient;
  const result = await scanArbitrum(primary, blockNumber, market, false, undefined, 100, false, Promise.resolve(2_000),
    { blockHash, primary, alternate });
  for (const call of primaryCalls.filter(({ batchSize }) => batchSize === 6000)) {
    assert.equal(call.blockHash, supportsHash ? blockHash : undefined);
    assert.equal(call.blockNumber, supportsHash ? undefined : blockNumber);
    assert.equal(call.requireCanonical, supportsHash ? true : undefined);
  }
  for (const call of alternateCalls) {
    assert.equal(call.blockHash, blockHash);
    assert.equal(call.requireCanonical, true);
    assert.equal(call.blockNumber, undefined);
  }
  assert.equal(result.unavailableLegs, result.quoteRecovery.remaining);
  return { result, alternateCalls, alternateEvents, primaryCalls };
}

const mixedFailures = {
  before: 3, recovered: 0, remaining: 3, individualFailures: 1, resolvedIndividual: 0,
  outOfGas: 1, rateLimited: 2, alternateAttempted: 0, alternateRecovered: 0,
};

test('Arbitrum creates public recovery readers only for the default RPC', () => {
  assert.equal(arbitrumQuoteRecoveryReaders('https://rpc.example.invalid'), undefined);
  assert.equal(arbitrumQuoteRecoveryReaders(defaultArbitrumRpc + '?project=custom'), undefined);
  assert.ok(arbitrumQuoteRecoveryReaders(defaultArbitrumRpc + '/'));
});

test('Arbitrum runs separate hash-pinned gas and quota retries concurrently for both quote legs', async () => {
  // The 103 -> 101 return also runs out of gas. Give the two recovered sells distinct payouts.
  const primary = (leg: Leg) => leg.tokenIn === token && leg.amountIn === size + 103n && leg.fee === 101
    ? gas : mixedPrimary(leg);
  const alternate = (leg: Leg) => leg.tokenIn === weth ? successfulQuote(leg) : ok(size + size / 2000n + BigInt(leg.fee));
  const { result, alternateCalls, alternateEvents, primaryCalls } = await scan(primary, alternate);
  for (const input of [weth, token]) {
    const calls = alternateCalls.filter(({ contracts }) => contracts[0].args[0].tokenIn === input);
    assert.equal(calls.length, 2);
    const expected = input === weth ? [[700, 100], [1400, 101]] : [[700, 101], [1400, 100]];
    for (const [batchSize, fee] of expected) {
      const call = calls.find((call) => call.batchSize === batchSize);
      assert.deepEqual(call?.contracts.map(({ args: [leg] }) => [leg.tokenIn, leg.fee, leg.amountIn]),
        [[input, fee, input === weth ? size : size + 103n]]);
    }
    assert.deepEqual(alternateEvents.filter(({ tokenIn }) => tokenIn === input).map(({ event }) => event),
      ['start', 'start', 'finish', 'finish']);
  }
  assert.deepEqual(result.quoteRecovery, { ...mixedFailures, before: 4, outOfGas: 2, recovered: 4, remaining: 0,
    alternateAttempted: 4, alternateRecovered: 4 });
  assert.equal(result.quotedRoutes, 9);
  assert.deepEqual(result.opportunities.map(({ order, payout }) => [order.buy.fee, order.sell.fee, payout]),
    [[103, 101, 101n], [103, 100, 100n]]);
  const sellLegs = primaryCalls.filter((call) => call.batchSize === 6000).flatMap((call) =>
    call.contracts.map(({ args: [leg] }) => leg).filter((leg) => leg.tokenIn === token));
  for (const buy of [100, 101, 103]) {
    assert.deepEqual(sellLegs.filter((leg) => leg.amountIn === size + BigInt(buy)).map((leg) => leg.fee),
      [100, 101, 102, 103].filter((sell) => sell !== buy));
  }
});

test('Arbitrum keeps a partial recovered batch and excludes an unresolved buy from sell routing', async () => {
  const { result } = await scan(mixedPrimary, (leg) => leg.tokenIn === weth && leg.fee === 101 ? quota : successfulQuote(leg));
  assert.deepEqual(result.quoteRecovery, { ...mixedFailures, recovered: 2, remaining: 1, alternateAttempted: 3, alternateRecovered: 2 });
  assert.equal(result.quotedRoutes, 6);
});

test('Arbitrum records a confirmed pool revert separately from recovered quotes and unavailable RPC legs', async () => {
  const { result } = await scan(mixedPrimary, (leg) => leg.tokenIn === weth && leg.fee === 101 ? individual : successfulQuote(leg));
  assert.deepEqual(result.quoteRecovery, { ...mixedFailures, recovered: 2, remaining: 0, individualFailures: 2,
    resolvedIndividual: 1, alternateAttempted: 3, alternateRecovered: 2 });
  assert.equal(result.quotedRoutes, 6);
});

test('Arbitrum skips alternate quotes when its block is missing or its header differs', async () => {
  for (const header of [null, { hash: otherHash, number: blockNumber }, { hash: blockHash, number: blockNumber - 1n }]) {
    const { result, alternateCalls } = await scan(mixedPrimary, successfulQuote, header);
    assert.equal(alternateCalls.length, 0);
    assert.deepEqual(result.quoteRecovery, mixedFailures);
    assert.equal(result.quotedRoutes, 2);
  }
});

test('Arbitrum retains primary quotes when the primary rejects hash-pinned calls', async () => {
  const { result, alternateCalls } = await scan(mixedPrimary, successfulQuote, { hash: blockHash, number: blockNumber }, 4, false);
  assert.equal(alternateCalls.length, 0);
  assert.equal(result.quotedRoutes, 2);
  assert.deepEqual(result.quoteRecovery, mixedFailures);
});

test('Arbitrum shares 96 unique retries between gas and quota failures in either quote stage', async () => {
  for (const [failedInput, poolCount, failures, outOfGas] of [[weth, 105, 105, 53], [token, 11, 110, 60]] as const) {
    const primary = (leg: Leg) => {
      if (leg.tokenIn !== failedInput) return successfulQuote(leg);
      return leg.fee % 2 === 0 ? gas : quota;
    };
    const { result, alternateCalls } = await scan(primary, () => quota, { hash: blockHash, number: blockNumber }, poolCount);
    assert.equal(alternateCalls.length, 2);
    const retries = alternateCalls.flatMap((call) => call.contracts.map(({ args: [leg] }) => {
      assert.equal(leg.tokenIn, failedInput);
      assert.equal(call.batchSize, leg.fee % 2 === 0 ? 700 : 1400);
      return `${leg.fee}/${leg.amountIn}`;
    }));
    assert.equal(retries.length, 96);
    assert.equal(new Set(retries).size, 96);
    assert.deepEqual(result.quoteRecovery, { before: failures, recovered: 0, remaining: failures, individualFailures: 0,
      resolvedIndividual: 0, outOfGas, rateLimited: failures - outOfGas, alternateAttempted: 96, alternateRecovered: 0 });
    assert.equal(result.quotedRoutes, 0);
  }
});
