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

type Quote = (leg: Leg) => Row;
type Reader = 'primary' | 'alternate';
interface Fixture {
  block?: bigint;
  poolCount?: number;
  supportsHash?: boolean;
  primaryHeader?: Header | null;
  alternateHeader?: Header | null;
  primaryQuote?: Quote;
  alternateQuote?: Quote;
  legacyQuote?: Quote;
}

async function scan(firstQuote: Quote = mixedPrimary, options: Fixture = {}) {
  const { block = blockNumber, poolCount = 4, supportsHash = true, legacyQuote = firstQuote } = options;
  const canonical = { number: block, hash: blockHash };
  const initialCalls: QuoteCall[] = [];
  const directCalls: Record<Reader, QuoteCall[]> = { primary: [], alternate: [] };
  const directEvents: { event: 'start' | 'finish'; input: Address }[] = [];
  const market: Parameters<typeof scanArbitrum>[2] = [{
    token, symbol: 'TEST',
    pools: Array.from({ length: poolCount }, (_, index) => ({
      kind: 2, pool: `0x${(100 + index).toString(16).padStart(40, '0')}` as Address,
      fee: 100 + index, tickSpacing: 0, nativeEth: false,
    })),
  }];
  const client = {
    readContract: async ({ functionName, blockHash: requestedHash }: { functionName: string; blockHash?: Hex }) => {
      if (requestedHash && !supportsHash) throw new Error('block hash queries unsupported');
      if (functionName === 'FLASHLOAN_PREMIUM_TOTAL') return 5n;
      if (functionName === 'getConfiguration') return (1n << 56n) | (1n << 63n);
      if (functionName === 'balanceOf') return size;
      assert.fail(`Unexpected primary read ${functionName}`);
    },
    multicall: async (call: QuoteCall) => {
      initialCalls.push(call);
      const quote = call.batchSize === 6000 ? firstQuote : legacyQuote;
      return call.contracts.map(({ args: [leg] }) => quote(leg));
    },
  } as unknown as ArbitrumClient;
  const reader = (name: Reader, header: Header | null = canonical, quote: Quote = successfulQuote) => ({
    getBlock: async ({ blockNumber: requested }: { blockNumber: bigint }) => {
      assert.equal(requested, block);
      if (!header) throw new Error('block not found');
      return header;
    },
    multicall: async (call: QuoteCall) => {
      directCalls[name].push(call);
      const input = call.contracts[0].args[0].tokenIn;
      directEvents.push({ input, event: 'start' });
      await Promise.resolve();
      directEvents.push({ input, event: 'finish' });
      return call.contracts.map(({ args: [leg] }) => quote(leg));
    },
  } as unknown as ArbitrumClient);
  const result = await scanArbitrum(client, block, market, false, undefined, 100, false, Promise.resolve(2_000),
    { blockHash, primary: reader('primary', options.primaryHeader, options.primaryQuote),
      alternate: reader('alternate', options.alternateHeader, options.alternateQuote) });
  for (const call of initialCalls) {
    assert.equal(call.blockHash, supportsHash ? blockHash : undefined);
    assert.equal(call.blockNumber, supportsHash ? undefined : block);
    assert.equal(call.requireCanonical, supportsHash ? true : undefined);
  }
  for (const call of [...directCalls.primary, ...directCalls.alternate]) {
    assert.equal(call.blockHash, blockHash);
    assert.equal(call.requireCanonical, true);
    assert.equal(call.blockNumber, undefined);
    assert.equal(call.batchSize, 1400);
  }
  assert.equal(result.unavailableLegs, result.quoteRecovery.remaining);
  return { result, directCalls, initialCalls, directEvents };
}

const mixedFailures = {
  before: 3, recovered: 0, remaining: 3, individualFailures: 1, resolvedIndividual: 0,
  outOfGas: 1, rateLimited: 2, alternateAttempted: 0, alternateRecovered: 0, primaryAttempted: 1, primaryRecovered: 0,
};

test('Arbitrum creates public recovery readers only for the default RPC', () => {
  assert.equal(arbitrumQuoteRecoveryReaders('https://rpc.example.invalid'), undefined);
  assert.equal(arbitrumQuoteRecoveryReaders(defaultArbitrumRpc + '?project=custom'), undefined);
  assert.ok(arbitrumQuoteRecoveryReaders(defaultArbitrumRpc + '/'));
});

test('Arbitrum alternates out-of-gas retries by block parity and restores each result to the right leg', async () => {
  const otherAggregate = fail('aggregate3', 'RPC unavailable');
  const first = (leg: Leg) => {
    if (leg.tokenIn === weth && leg.fee === 104) return individual;
    if (leg.tokenIn === weth || leg.amountIn === size + 103n) {
      if (leg.fee === 100 || leg.fee === 102) return gas;
      if (leg.fee === 101) return quota;
      if (leg.fee === 105) return otherAggregate;
    }
    return successfulQuote(leg);
  };
  const retry = (leg: Leg) => leg.tokenIn === weth ? successfulQuote(leg) : ok(size + size / 2000n + BigInt(leg.fee));
  for (const block of [100n, 101n]) {
    const { result, initialCalls, directCalls, directEvents } = await scan(first,
      { block, poolCount: 6, primaryQuote: retry, alternateQuote: retry });
    const expectedPrimary = block % 2n === 0n ? 100 : 102;
    for (const input of [weth, token]) {
      for (const reader of ['primary', 'alternate'] as const) {
        const calls = directCalls[reader].filter((call) => call.contracts[0].args[0].tokenIn === input);
        assert.equal(calls.length, 1);
        const legs = calls[0].contracts.map(({ args: [leg] }) => leg);
        const expected = reader === 'primary' ? [expectedPrimary] : [100, 101, 102, 105].filter((fee) => fee !== expectedPrimary);
        assert.deepEqual(legs.map(({ fee }) => fee).sort((a, b) => a - b), expected);
        assert.ok(legs.every(({ amountIn }) => amountIn === (input === weth ? size : size + 103n)));
      }
      assert.deepEqual(directEvents.filter((e) => e.input === input).map((e) => e.event), ['start', 'start', 'finish', 'finish']);
    }
    assert.ok(initialCalls.every(({ batchSize }) => batchSize === 6000));
    const downstream = initialCalls.flatMap((call) => call.contracts.map(({ args: [leg] }) => leg)).filter((leg) => leg.tokenIn === token);
    for (const buy of [100, 101, 102, 103, 105]) {
      assert.deepEqual(downstream.filter((leg) => leg.amountIn === size + BigInt(buy)).map((leg) => leg.fee),
        [100, 101, 102, 103, 104, 105].filter((sell) => sell !== buy));
    }
    assert.equal(result.quotedRoutes, 25);
    assert.deepEqual(result.opportunities.map(({ order, payout }) => [order.buy.fee, order.sell.fee, payout]),
      [[103, 105, 105n], [103, 102, 102n], [103, 101, 101n], [103, 100, 100n]]);
    assert.deepEqual(result.quoteRecovery, { before: 8, recovered: 8, remaining: 0, individualFailures: 1, resolvedIndividual: 0,
      outOfGas: 4, rateLimited: 2, primaryAttempted: 2, primaryRecovered: 2, alternateAttempted: 6, alternateRecovered: 6 });
  }
});

test('Arbitrum preserves the other reader’s results when a direct retry fails', async () => {
  const { result } = await scan(mixedPrimary, { primaryQuote: () => { throw new Error('primary timeout'); } });
  assert.equal(result.quotedRoutes, 6);
  assert.deepEqual(result.quoteRecovery, { ...mixedFailures, recovered: 2, remaining: 1, alternateAttempted: 2, alternateRecovered: 2 });
});

test('Arbitrum reports individual pool reverts separately from unavailable transport results', async () => {
  for (const unavailable of [true, false]) {
    const alternateQuote = (leg: Leg) => {
      if (leg.tokenIn === weth && leg.fee === 101) return unavailable ? quota : individual;
      return successfulQuote(leg);
    };
    const { result } = await scan(mixedPrimary, { alternateQuote });
    assert.equal(result.quotedRoutes, 6);
    assert.deepEqual(result.quoteRecovery, { ...mixedFailures, recovered: 2, remaining: unavailable ? 1 : 0,
      resolvedIndividual: unavailable ? 0 : 1, individualFailures: unavailable ? 1 : 2,
      primaryRecovered: 1, alternateAttempted: 2, alternateRecovered: 1 });
  }
});

test('Arbitrum uses only the original client for gas retries when the header check or hash support fails', async () => {
  for (const options of [
    { alternateHeader: null }, { alternateHeader: { hash: otherHash, number: blockNumber } },
    { alternateHeader: { hash: blockHash, number: blockNumber - 1n } }, { primaryHeader: null },
    { primaryHeader: { hash: otherHash, number: blockNumber } }, { supportsHash: false },
  ]) {
    const { result, initialCalls, directCalls } = await scan(mixedPrimary, { ...options, legacyQuote: successfulQuote });
    assert.deepEqual(directCalls, { primary: [], alternate: [] });
    assert.deepEqual(initialCalls.filter(({ batchSize }) => batchSize === 1400).flatMap((call) =>
      call.contracts.map(({ args: [leg] }) => [leg.tokenIn, leg.fee])), [[weth, 100]]);
    assert.deepEqual(result.quoteRecovery, { ...mixedFailures, recovered: 1, remaining: 2, primaryRecovered: 1 });
    assert.equal(result.quotedRoutes, 5);
  }
});

test('both readers share the 96-leg limit on either stage and split selected gas failures evenly', async () => {
  for (const [failedInput, poolCount, failures, outOfGas] of [[weth, 105, 105, 53], [token, 11, 110, 60]] as const) {
    const first = (leg: Leg) => {
      if (leg.tokenIn !== failedInput) return successfulQuote(leg);
      return leg.fee % 2 === 0 ? gas : quota;
    };
    const { result, directCalls } = await scan(first, { poolCount, primaryQuote: () => quota, alternateQuote: () => quota });
    const legs = (calls: QuoteCall[]) => calls.flatMap((call) => call.contracts.map(({ args: [leg] }) => leg));
    const primary = legs(directCalls.primary);
    const alternate = legs(directCalls.alternate);
    const all = [...primary, ...alternate];
    assert.ok(primary.length > 0 && primary.every((leg) => leg.fee % 2 === 0));
    assert.ok(Math.abs(primary.length - alternate.filter((leg) => leg.fee % 2 === 0).length) <= 1);
    assert.ok(all.every((leg) => leg.tokenIn === failedInput));
    assert.equal(all.length, 96);
    assert.equal(new Set(all.map(({ fee, amountIn }) => `${fee}/${amountIn}`)).size, 96);
    assert.deepEqual(result.quoteRecovery, { before: failures, recovered: 0, remaining: failures, individualFailures: 0,
      resolvedIndividual: 0, outOfGas, rateLimited: failures - outOfGas,
      primaryAttempted: primary.length, primaryRecovered: 0, alternateAttempted: alternate.length, alternateRecovered: 0 });
    assert.equal(result.quotedRoutes, 0);
  }
});
