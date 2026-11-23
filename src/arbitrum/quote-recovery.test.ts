import assert from 'node:assert/strict';
import test from 'node:test';
import { BaseError, ContractFunctionExecutionError, HttpRequestError, parseEther, TimeoutError, type Address, type Hex } from 'viem';
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
  alternateHeader: Header | null = { number: blockNumber, hash: blockHash }, poolCount = 4, supportsHash = true,
  retryResponse: (rows: Row[]) => Row[] = rows => rows) {
  const alternateCalls: QuoteCall[] = [];
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
      const rows = call.contracts.map(({ args: [leg] }) => primaryQuote(leg));
      return call.batchSize === 1400 ? retryResponse(rows) : rows;
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
      return retryResponse(call.contracts.map(({ args: [leg] }) => alternateQuote(leg)));
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
  assert.ok(alternateCalls.every(({ batchSize }) => batchSize === 1400));
  assert.equal(result.unavailableLegs, result.quoteRecovery.remaining);
  const counts = result.quoteRecovery;
  assert.equal(counts.remaining, counts.untriedCap + counts.untriedNoReader + counts.retryOutOfGas
    + counts.retryTimeout + counts.retryRateLimited + counts.retryOther);
  assert.equal(counts.before, counts.recovered + counts.resolvedIndividual + counts.remaining);
  return { result, alternateCalls, primaryCalls };
}

const residuals = { untriedCap: 0, untriedNoReader: 0, retryOutOfGas: 0, retryTimeout: 0, retryRateLimited: 0, retryOther: 0 };
const mixedFailures = {
  before: 3, recovered: 0, remaining: 3, individualFailures: 1, resolvedIndividual: 0,
  outOfGas: 1, rateLimited: 2, alternateAttempted: 0, alternateRecovered: 0, ...residuals,
};

test('Arbitrum creates public recovery readers only for the default RPC', () => {
  assert.equal(arbitrumQuoteRecoveryReaders('https://rpc.example.invalid'), undefined);
  assert.equal(arbitrumQuoteRecoveryReaders(defaultArbitrumRpc + '?project=custom'), undefined);
  assert.ok(arbitrumQuoteRecoveryReaders(defaultArbitrumRpc + '/'));
});

test('a fully quoted scan keeps every recovery counter at zero without retrying', async () => {
  const { result, alternateCalls, primaryCalls } = await scan(successfulQuote, successfulQuote);
  assert.ok(primaryCalls.every(call => call.batchSize === 6000));
  assert.equal(alternateCalls.length, 0);
  assert.equal(result.quotedRoutes, 12);
  assert.deepEqual(result.quoteRecovery, { before: 0, recovered: 0, remaining: 0, individualFailures: 0,
    resolvedIndividual: 0, outOfGas: 0, rateLimited: 0, alternateAttempted: 0, alternateRecovered: 0, ...residuals });
});

test('Arbitrum recovers only aggregate failures at the specified hash across both quote legs', async () => {
  const { result, alternateCalls, primaryCalls } = await scan(mixedPrimary, successfulQuote);
  assert.deepEqual(alternateCalls.map((call) => call.contracts.map(({ args: [leg] }) => [leg.tokenIn, leg.fee])), [
    [[weth, 100], [weth, 101]], [[token, 100]],
  ]);
  assert.deepEqual(result.quoteRecovery, { ...mixedFailures, recovered: 3, remaining: 0, alternateAttempted: 3, alternateRecovered: 3 });
  assert.equal(result.quotedRoutes, 9);
  const sellLegs = primaryCalls.filter((call) => call.batchSize === 6000).flatMap((call) =>
    call.contracts.map(({ args: [leg] }) => leg).filter((leg) => leg.tokenIn === token));
  for (const buy of [100, 101, 103]) {
    assert.deepEqual(sellLegs.filter((leg) => leg.amountIn === size + BigInt(buy)).map((leg) => leg.fee),
      [100, 101, 102, 103].filter((sell) => sell !== buy));
  }
});

test('Arbitrum keeps a partial recovered batch and excludes an unresolved buy from sell routing', async () => {
  const { result } = await scan(mixedPrimary, (leg) => leg.tokenIn === weth && leg.fee === 101 ? quota : successfulQuote(leg));
  assert.deepEqual(result.quoteRecovery, { ...mixedFailures, recovered: 2, remaining: 1, alternateAttempted: 3,
    alternateRecovered: 2, retryRateLimited: 1 });
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
    assert.deepEqual(result.quoteRecovery, { ...mixedFailures, untriedNoReader: 2, retryOutOfGas: 1 });
    assert.equal(result.quotedRoutes, 2);
  }
});

test('Arbitrum retains primary quotes when the primary rejects hash-pinned calls', async () => {
  const { result, alternateCalls } = await scan(mixedPrimary, successfulQuote, { hash: blockHash, number: blockNumber }, 4, false);
  assert.equal(alternateCalls.length, 0);
  assert.equal(result.quotedRoutes, 2);
  assert.deepEqual(result.quoteRecovery, { ...mixedFailures, untriedNoReader: 2, retryOutOfGas: 1 });
});

test('Arbitrum bounds the alternate retry even when every quote in a market is unavailable', async () => {
  const { result, alternateCalls } = await scan(() => quota, () => quota, { hash: blockHash, number: blockNumber }, 105);
  const retries = alternateCalls.flatMap((call) => call.contracts.map(({ args: [leg] }) => leg.fee));
  assert.equal(retries.length, 96);
  assert.equal(new Set(retries).size, 96);
  assert.deepEqual(result.quoteRecovery, { before: 105, recovered: 0, remaining: 105, individualFailures: 0,
    resolvedIndividual: 0, outOfGas: 0, rateLimited: 105, alternateAttempted: 96, alternateRecovered: 0,
    ...residuals, untriedCap: 9, retryRateLimited: 96 });
  assert.equal(result.quotedRoutes, 0);
});

// Error-like terms in viem's URL/body diagnostics must not influence classification.
const retryRequest = { url: 'https://reader.example.invalid/out-of-gas', body: { example: 'out of gas, too many requests, timeout' } };
const aggregate = (cause: BaseError) => new ContractFunctionExecutionError(cause, { abi: [], functionName: 'aggregate3' });
const timeout = aggregate(new TimeoutError(retryRequest));
const rateLimit = new HttpRequestError({ ...retryRequest, status: 429 });
const unavailable = new HttpRequestError({ ...retryRequest, status: 503, details: 'temporarily unavailable' });

test('Arbitrum accounts for mixed retry results, including a sparse row and a truncated tail', async () => {
  const { result } = await scan(leg => leg.tokenIn === weth ? quota : successfulQuote(leg), successfulQuote, undefined, 8, true,
    (rows) => {
      const partial: Row[] = [gas, { status: 'failure', error: timeout }, { status: 'failure', error: aggregate(rateLimit) },
        { status: 'failure', error: aggregate(unavailable) }, rows[4]];
      partial[6] = individual; // Row 5 is a hole and the eighth requested row is absent.
      return partial;
    });
  assert.deepEqual(result.quoteRecovery, { before: 8, recovered: 1, remaining: 6, individualFailures: 1,
    resolvedIndividual: 1, outOfGas: 0, rateLimited: 8, alternateAttempted: 8, alternateRecovered: 1,
    ...residuals, retryOutOfGas: 1, retryTimeout: 1, retryRateLimited: 1, retryOther: 3 });
  assert.equal(result.quotedRoutes, 7);
});

test('Arbitrum classifies all selected legs when the entire retry throws', async () => {
  for (const [reason, expected] of [
    [timeout, 'retryTimeout'], [rateLimit, 'retryRateLimited'], [unavailable, 'retryOther'],
    [aggregate(new BaseError('RPC failure', { details: 'out of gas' })), 'retryOutOfGas'],
  ] as const) {
    const { result, alternateCalls } = await scan(() => gas, successfulQuote, undefined, 3, true, () => { throw reason; });
    assert.equal(alternateCalls.length, 1);
    assert.deepEqual(result.quoteRecovery, { before: 3, recovered: 0, remaining: 3, individualFailures: 0,
      resolvedIndividual: 0, outOfGas: 3, rateLimited: 0, alternateAttempted: 3, alternateRecovered: 0,
      ...residuals, [expected]: 3 });
  }
});

test('Arbitrum limits the primary retry to gas failures when its alternate is unavailable', async () => {
  const { result, alternateCalls, primaryCalls } = await scan(leg => leg.fee < 199 ? gas : quota, successfulQuote, null, 105);
  assert.equal(alternateCalls.length, 0);
  const retriedFees = primaryCalls.filter(call => call.batchSize === 1400)
    .flatMap(call => call.contracts.map(({ args: [leg] }) => leg.fee));
  assert.equal(retriedFees.length, 96);
  assert.ok(retriedFees.every(fee => fee < 199));
  assert.deepEqual(result.quoteRecovery, { before: 105, recovered: 0, remaining: 105, individualFailures: 0,
    resolvedIndividual: 0, outOfGas: 99, rateLimited: 6, alternateAttempted: 0, alternateRecovered: 0,
    ...residuals, untriedCap: 3, untriedNoReader: 6, retryOutOfGas: 96 });
});
