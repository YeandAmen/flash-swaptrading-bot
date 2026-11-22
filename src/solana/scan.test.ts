import assert from 'node:assert/strict';
import { test } from 'node:test';
import { address, getAddressEncoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, type ReadonlyUint8Array } from '@solana/kit';
import {
  createWalletAta, JUPITER, KAMINO, KAMINO_MARKET, KAMINO_MARKET_LOOKUP, KAMINO_USDC_RESERVE, LOOKUP_PROGRAM, MAINNET_GENESIS,
  USDC, WRAPPED_SOL,
} from './protocol.js';
import { LIGHTHOUSE, lighthouseAtaFloor, lighthouseLamports, lighthouseTokenAmount } from './guard.js';
import { queueFlashTest, validSolanaSwapLossUsdc } from '../network-test.js';
import { scanSolanaCycle, solanaDiscoveryPairs, solanaVenuePairs } from './scan.js';

const wallet = address('23g1K6sr2bevNwLYPoB79jzEQtErioYQ8mpUa76xA6yu');
const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const fakeRpc = 'http://127.0.0.1:8899';
const fee = 6400;

function reserveFixture() {
  const data = Buffer.alloc(8624);
  Buffer.from('2bf2ccca1af73b7f', 'hex').copy(data);
  const fields = [
    [32, KAMINO_MARKET], [128, USDC],
    [160, 'Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6'],
    [192, 'BbDUrk1bVtSixgQsPLBJFZEF7mwGstnD5joA1WzYvYFX'],
    [408, tokenProgram],
  ] as const;
  for (const [offset, key] of fields) data.set(getAddressEncoder().encode(address(key)), offset);
  data.writeBigUInt64LE(10_000_000_000n, 224);
  data.writeBigUInt64LE(6n, 272);
  data.writeBigUInt64LE(11_529_215_046_068n, 4904);
  return data.toString('base64');
}

function lookupFixture() {
  const data = Buffer.alloc(56 + 64);
  data.writeUInt32LE(1, 0);
  data.set(getAddressEncoder().encode(KAMINO_MARKET), 56);
  data.set(getAddressEncoder().encode(KAMINO_USDC_RESERVE), 88);
  return data.toString('base64');
}

test('Solana paper scanner composes unsigned atomic borrow and repay and gates observed net profit', async (t) => {
  let simulationCount = 0;
  let actualWalletGain = 210_000;
  let live = false;
  let reportedFee = fee;
  let returnOut = '250250000';
  let usdcBalance = 1_000_000;
  let wsolBalance = 20_000;
  let wsolDrop = 0;
  let usdcAccountExists = true;
  let reportedNativeDebit = fee;
  let checkLossGuards = false;
  let jupiterRequests = 0;
  let groupedExit: string | undefined;
  let groupedIssue: 'layout' | 'oversized' | 'accounts' | 'rate-limit' | undefined;
  const requestedExits: string[][] = [];
  let slowQuote: Promise<void> | undefined;
  const [{ ata: usdcAta }, { ata: solAta }] = await Promise.all([createWalletAta(wallet, USDC), createWalletAta(wallet, WRAPPED_SOL)]);
  const account = (owner: string, data: string, space: number, lamports = 10_000_000) =>
    ({ owner, data: [data, 'base64'], executable: false, lamports, rentEpoch: 0, space });
  const walletToken = (mint: string, amount: bigint) => {
    const data = Buffer.alloc(165);
    data.set(getAddressEncoder().encode(address(mint)), 0);
    data.set(getAddressEncoder().encode(wallet), 32);
    data.writeBigUInt64LE(amount, 64);
    data[108] = 1;
    return account(tokenProgram, data.toString('base64'), 165);
  };
  t.mock.method(globalThis, 'fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === 'https://api.jup.ag') {
      jupiterRequests++;
      const params = url.searchParams;
      const inputMint = params.get('inputMint');
      const outputMint = params.get('outputMint');
      const requested = params.get('dexes')!.split(',');
      const paired = requested.includes('BisonFi') ? 'BisonFi' : 'SolFi V2';
      const venue = requested.length === 1 ? requested[0] : groupedExit === 'paired' ? paired : groupedExit;
      const issue = requested.length > 1 ? groupedIssue : undefined;
      if (issue === 'rate-limit') return Response.json({}, { status: 429 });
      if (requested.length > 1) requestedExits.push(requested);
      const first = inputMint === USDC;
      if (first && venue === 'Meteora DLMM') await slowQuote;
      assert.equal(params.get('wrapAndUnwrapSol'), 'false');
      assert.equal(first ? outputMint : inputMint, WRAPPED_SOL);
      if (!first) assert.equal(params.get('amount'), live ? '3498250000' : '3499000000');
      const outAmount = first ? '3500000000' : returnOut;
      const bytes = Buffer.alloc(issue === 'oversized' ? 1_500 : 34);
      Buffer.from('bb64facc31c4af14', 'hex').copy(bytes);
      bytes.writeBigUInt64LE(BigInt(params.get('amount')!), 8);
      bytes.writeBigUInt64LE(BigInt(outAmount), 16);
      bytes.writeUInt16LE(5, 24);
      if (issue === 'layout') bytes[0] = 0;
      const destination = params.get('destinationTokenAccount');
      const metas = [
        { pubkey: wallet, isSigner: true, isWritable: false },
        { pubkey: destination, isSigner: false, isWritable: true },
      ];
      const routeMetas = [metas[0], { pubkey: first ? usdcAta : solAta, isSigner: false, isWritable: true }, metas[1],
        ...[inputMint, outputMint, tokenProgram, tokenProgram, destination, JUPITER, JUPITER]
          .map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }))];
      if (issue === 'accounts') routeMetas[1] = metas[1];
      return Response.json({
        inputMint, outputMint, inAmount: params.get('amount'),
        outAmount,
        otherAmountThreshold: first ? '3499000000' : '250120000',
        swapMode: 'ExactIn', slippageBps: 5,
        routePlan: [{ swapInfo: { ammKey: first ? USDC : WRAPPED_SOL, label: venue, inputMint, outputMint } }],
        swapInstruction: { programId: JUPITER, data: live ? bytes.toString('base64') : 'AA==', accounts: live ? routeMetas : metas },
        cleanupInstruction: null, tipInstruction: null, otherInstructions: [], addressesByLookupTableAddress: null,
      });
    }

    assert.equal(url.origin, fakeRpc);
    const request = JSON.parse(String(init?.body)) as { id: string; method: string; params: unknown[] };
    const response = (result: unknown) => Response.json({ jsonrpc: '2.0', id: request.id, result });
    const atSlot = (value: unknown) => response({ context: { slot: 42 }, value });
    switch (request.method) {
      case 'getGenesisHash': return response(MAINNET_GENESIS);
      case 'getAccountInfo': return atSlot({ data: [reserveFixture(), 'base64'], executable: false, owner: KAMINO, lamports: 7, rentEpoch: 0, space: 8624 });
      case 'getBalance': return atSlot(10_000_000);
      case 'getMultipleAccounts': {
        if (live && (request.params[0] as string[])[0] === wallet) {
          return atSlot([account('11111111111111111111111111111111', '', 0),
            usdcAccountExists ? walletToken(USDC, BigInt(usdcBalance)) : null, walletToken(WRAPPED_SOL, BigInt(wsolBalance))]);
        }
        assert.deepEqual(request.params[0], [KAMINO_MARKET_LOOKUP]);
        return atSlot([{ data: [lookupFixture(), 'base64'], executable: false, owner: LOOKUP_PROGRAM, lamports: 7, rentEpoch: 0, space: 120 }]);
      }
      case 'getFeeForMessage': return atSlot(fee);
      case 'getMinimumBalanceForRentExemption': return response(1_488_440);
      case 'getLatestBlockhash': return atSlot({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 42 });
      case 'simulateTransaction': {
        simulationCount++;
        assert.equal((request.params[1] as { sigVerify: boolean }).sigVerify, false);
        const transaction = getTransactionDecoder().decode(Buffer.from(String(request.params[0]), 'base64'));
        assert.ok(Object.values(transaction.signatures).every((signature) => signature === null));
        const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
        if (compiled.version !== 0) assert.fail('Expected a v0 transaction');
        assert.equal(compiled.addressTableLookups?.[0]?.lookupTableAddress, KAMINO_MARKET_LOOKUP);
        const sequence = compiled.instructions.map((instruction) => compiled.staticAccounts[instruction.programAddressIndex]);
        if (live) {
          assert.equal((request.params[1] as { replaceRecentBlockhash: boolean }).replaceRecentBlockhash, false);
          assert.deepEqual(sequence.slice(2, 8), [LIGHTHOUSE, LIGHTHOUSE, KAMINO, JUPITER, JUPITER, KAMINO]);
          assert.deepEqual(sequence.slice(8), [LIGHTHOUSE, LIGHTHOUSE, LIGHTHOUSE]);
        } else {
          assert.deepEqual(sequence.slice(4), [KAMINO, JUPITER, JUPITER, KAMINO]);
        }
        if (checkLossGuards) {
          for (const [position, expected] of [
            [2, lighthouseLamports(wallet, 'equal', BigInt(10_000_000 - fee))],
            [3, lighthouseTokenAmount(usdcAta, 'equal', BigInt(usdcBalance))],
            [8, lighthouseAtaFloor(usdcAta, BigInt(usdcBalance - 20_000))],
            [9, lighthouseAtaFloor(solAta, BigInt(wsolBalance))],
            [10, lighthouseLamports(wallet, 'atLeast', BigInt(10_000_000 - fee))],
          ] as const) {
            const instruction: { data?: ReadonlyUint8Array; accountIndices?: readonly number[] } = compiled.instructions[position];
            assert.deepEqual(Buffer.from(instruction.data!), Buffer.from(expected.data!));
            assert.equal(compiled.staticAccounts[instruction.accountIndices![0]], expected.accounts![0].address);
          }
        }
        assert.equal(compiled.instructions[7].data?.[16], 4);
        const tokenBalance = (mint: string, ata: string, amount: number, decimals: number) => ({
          accountIndex: compiled.staticAccounts.findIndex((key) => key === ata), mint, owner: wallet, programId: tokenProgram,
          uiTokenAmount: { amount: String(amount), decimals, uiAmount: amount / 10 ** decimals, uiAmountString: String(amount / 10 ** decimals) },
        });
        return atSlot({
          err: null, fee: reportedFee, unitsConsumed: 420000,
          preBalances: [10_000_000], postBalances: [10_000_000 - reportedNativeDebit],
          preTokenBalances: [tokenBalance(USDC, usdcAta, usdcBalance, 6), tokenBalance(WRAPPED_SOL, solAta, wsolBalance, 9)],
          postTokenBalances: [tokenBalance(USDC, usdcAta, usdcBalance + actualWalletGain, 6),
            tokenBalance(WRAPPED_SOL, solAta, wsolBalance - wsolDrop, 9)],
        });
      }
      default: assert.fail(`Unexpected RPC method ${request.method}`);
    }
  });

  const config = { rpcUrl: fakeRpc, wallet };
  const scan = await scanSolanaCycle(config);
  assert.equal(scan.flashFeeUsdc, 0.0025);
  assert.equal(simulationCount, 2);
  for (const route of scan.routes) {
    assert.equal(route.status, 'simulated', route.detail);
    assert.equal(route.qualified, true);
    assert.equal(route.simulatedCostLamports, fee);
    assert.ok(route.simulatedNetUsdc! > 0.2);
  }

  actualWalletGain = 10_000;
  const belowFloor = await scanSolanaCycle(config);
  assert.ok(belowFloor.routes.every((route) => route.status === 'simulated' && route.qualified === false));
  actualWalletGain = 210_000;
  const overBudget = await scanSolanaCycle({ ...config, maxFeeLamports: 6000 });
  assert.ok(overBudget.routes.every((route) => route.status === 'simulated' && route.simulatedNetUsdc! > 0.2 && route.qualified === false));

  live = true;
  await t.test('submits a qualifying route before the opposite quote finishes', async () => {
    jupiterRequests = 0;
    let submissions = 0;
    let releaseQuote!: () => void;
    slowQuote = new Promise<void>((resolve) => { releaseQuote = resolve; });
    let markSubmission!: () => void;
    const submissionStarted = new Promise<void>((resolve) => { markSubmission = resolve; });
    const pending = scanSolanaCycle({ ...config, venuePair: solanaVenuePairs[1] }, async (candidate) => {
      submissions++;
      assert.equal(candidate.feeLamports, 6400n);
      assert.equal(candidate.maximumLamportDebit, 6400n);
      assert.equal(candidate.simulationSlot, 42n);
      assert.ok(candidate.net >= 50_000n);
      markSubmission();
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        submissionStarted,
        pending.then(() => assert.fail('Scan finished before the delayed quote was released')),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Submission waited for the delayed quote')), 1000);
        }),
      ]);
      assert.equal(submissions, 1);
    } finally {
      clearTimeout(timeout);
      releaseQuote();
      slowQuote = undefined;
    }
    const guarded = await pending;
    assert.deepEqual(guarded.routes.map(({ buy, sell }) => [buy, sell]), [
      ['Whirlpool', 'Meteora DLMM'], ['Meteora DLMM', 'Whirlpool'],
    ]);
    assert.equal(jupiterRequests, 4, 'query two legs in each direction for the selected venue pair');
    for (const route of guarded.routes) assert.equal(route.status, 'simulated', route.detail);
    assert.equal(submissions, 1, 'submit only the first qualifying guarded route');
  });
  await t.test('tries the alternate only after an explicit route decline', async () => {
    let submissions = 0;
    const scanned = await scanSolanaCycle(config, async () => {
      if (++submissions === 1) return { status: 'route-declined', canTryAlternate: () => true };
      return undefined;
    });
    assert.ok(scanned.routes.every((route) => route.qualified));
    assert.equal(submissions, 2);
  });
  await t.test('does not retry if a route decline is invalidated before the other quote arrives', async () => {
    let submissions = 0;
    let resolveQuote!: () => void;
    let resolveDecline!: () => void;
    let validPermit = true;
    slowQuote = new Promise<void>((resolve) => { resolveQuote = resolve; });
    const firstDeclined = new Promise<void>((resolve) => { resolveDecline = resolve; });
    const pending = scanSolanaCycle({ ...config, venuePair: solanaVenuePairs[1] }, async () => {
      submissions++;
      resolveDecline();
      return { status: 'route-declined', canTryAlternate: () => validPermit };
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        firstDeclined,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('First decision waited for the delayed quote')), 1000);
        }),
      ]);
      validPermit = false;
    } finally {
      clearTimeout(timeout);
      resolveQuote();
      slowQuote = undefined;
    }
    const scanned = await pending;
    assert.ok(scanned.routes.every((route) => route.qualified));
    assert.equal(submissions, 1);
  });
  await t.test('does not try an alternate after an error or during a manual test', async () => {
    let submissions = 0;
    await assert.rejects(scanSolanaCycle(config, async () => {
      submissions++;
      throw new Error('Submission acknowledgment unavailable');
    }), /Submission acknowledgment unavailable/);
    assert.equal(submissions, 1);

    submissions = 0;
    const manual = await scanSolanaCycle(config, async () => {
      submissions++;
      return { status: 'route-declined', canTryAlternate: () => true };
    }, 'manual-test');
    assert.ok(manual.routes.every((route) => route.qualified));
    assert.equal(submissions, 1);
  });
  await t.test('compares other direct exits and records the actual venue with one quote per leg', async () => {
    groupedExit = 'PancakeSwap';
    jupiterRequests = 0;
    const settings = { ...config, venuePair: solanaDiscoveryPairs[2], compareReturnVenues: true };
    let submissions = 0;
    const direct = await scanSolanaCycle(settings, async () => { submissions++; });
    assert.equal(jupiterRequests, 4);
    assert.equal(submissions, 1);
    assert.deepEqual(direct.routes.map((route) => [route.buy, route.sell, route.qualified]),
      [['SolFi V2', 'PancakeSwap', true], ['BisonFi', 'PancakeSwap', true]]);
    assert.equal(requestedExits.length, 2);
    for (const allowed of requestedExits) {
      assert.equal(new Set(allowed).size, 5);
      assert.ok(allowed.includes('SolFi V2') !== allowed.includes('BisonFi'));
    }

    groupedExit = 'unexpected venue';
    jupiterRequests = 0;
    const fixed = await scanSolanaCycle(settings, async () => {});
    assert.equal(jupiterRequests, 6);
    assert.deepEqual(fixed.routes.map((route) => [route.buy, route.sell, route.qualified]),
      [['SolFi V2', 'BisonFi', true], ['BisonFi', 'SolFi V2', true]]);
    // The best grouped price may have an incompatible instruction or be too large to compose.
    groupedExit = 'PancakeSwap';
    for (const issue of ['layout', 'oversized'] as const) {
      groupedIssue = issue;
      jupiterRequests = 0;
      submissions = 0;
      const paired = await scanSolanaCycle(settings, async (candidate) => {
        submissions++;
        assert.equal(candidate.feeLamports, BigInt(fee));
        assert.ok(candidate.net >= 50_000n);
      });
      assert.equal(jupiterRequests, 6, 'reuse both first legs and retry each return once');
      assert.equal(submissions, 1);
      assert.deepEqual(paired.routes.map((route) => [route.buy, route.sell, route.qualified]),
        [['SolFi V2', 'BisonFi', true], ['BisonFi', 'SolFi V2', true]]);
    }

    groupedExit = 'paired';
    jupiterRequests = 0;
    const sameVenue = await scanSolanaCycle(settings, async () => assert.fail('Oversized paired route submitted'));
    assert.equal(jupiterRequests, 4, 'no identical paired retry');
    assert.ok(sameVenue.routes.every((route) => route.detail?.includes('size limit')));
    groupedExit = 'PancakeSwap';
    for (const issue of ['accounts', 'rate-limit'] as const) {
      groupedIssue = issue;
      jupiterRequests = 0;
      const rejected = await scanSolanaCycle(settings, async () => assert.fail('Rejected route submitted'));
      assert.equal(jupiterRequests, 4, 'account guard failures and upstream throttling do not start a retry');
      assert.ok(rejected.routes.every((route) => route.status === 'quote-error'));
    }
    groupedIssue = undefined;
    groupedExit = undefined;
  });
  reportedFee = fee + 1;
  const inconsistent = await scanSolanaCycle({ ...config, venuePair: solanaVenuePairs[2] },
    async () => { assert.fail('Fee mismatch authorized a candidate'); }, 'guarded-test');
  assert.deepEqual(inconsistent.routes.map(({ buy, sell }) => [buy, sell]), [
    ['Raydium CLMM', 'Meteora DLMM'], ['Meteora DLMM', 'Raydium CLMM'],
  ]);
  assert.ok(inconsistent.routes.every((route) => route.qualified === false));

  await t.test('capped test accepts the exact loss boundary with existing funded ATAs only', async () => {
    reportedFee = fee;
    returnOut = '250122500';
    actualWalletGain = -20_000;
    checkLossGuards = true;
    const testRequest = { id: 'bounded-test', maximumSwapLossUsdc: 0.02 };
    let submissions = 0;
    const attempted = await scanSolanaCycle(config, async (candidate) => {
      submissions++;
      assert.equal(candidate.testId, testRequest.id);
      assert.equal(candidate.rentLamports, 0n);
      assert.equal(candidate.maximumLamportDebit, BigInt(fee));
      assert.deepEqual(candidate.swapLossGuard, {
        cap: 20_000n, baselineUsdc: 1_000_000n, baselineWsol: 20_000n, baselineLamports: 10_000_000n,
      });
    }, testRequest);
    assert.equal(submissions, 1);
    assert.ok(attempted.routes.every((route) => route.qualified), JSON.stringify(attempted.routes));

    const neverSubmit = async () => { assert.fail('Capped test accepted a wallet invariant violation'); };
    actualWalletGain = -20_001;
    assert.ok((await scanSolanaCycle(config, neverSubmit, testRequest)).routes.every((route) => route.qualified === false));
    actualWalletGain = -20_000;
    wsolDrop = 1;
    assert.ok((await scanSolanaCycle(config, neverSubmit, testRequest)).routes.every((route) => route.qualified === false));
    wsolDrop = 0;
    reportedNativeDebit = fee + 1;
    assert.ok((await scanSolanaCycle(config, neverSubmit, testRequest)).routes.every((route) => route.qualified === false));
    reportedNativeDebit = fee;
    const simulationsBefore = simulationCount;
    usdcBalance = 19_999;
    assert.ok((await scanSolanaCycle(config, neverSubmit, testRequest)).routes.every((route) => route.status === 'simulation-failed'));
    usdcBalance = 1_000_000;
    usdcAccountExists = false;
    assert.ok((await scanSolanaCycle(config, neverSubmit, testRequest)).routes.every((route) => route.status === 'simulation-failed'));
    assert.equal(simulationCount, simulationsBefore);
  });
});

test('only Solana can queue exact micro-USDC swap loss limits without conflicting floors', () => {
  for (const value of [0, 0.0000009, 0.0000011, 0.02 + 0.000001, 0.021, '0.02', Infinity, NaN, null]) {
    assert.equal(validSolanaSwapLossUsdc(value), false);
  }
  for (const value of [0.000001, 0.001001, 0.019999, 0.02]) assert.equal(validSolanaSwapLossUsdc(value), true);
  assert.throws(() => queueFlashTest(null, 'arbitrum', 0, { maximumSwapLossUsdc: 0.02 }), /Only Solana/);
  assert.throws(() => queueFlashTest(null, 'solana', 0, { maximumSwapLossUsdc: 0.02, minimumNetUsd: 1 }, 'solana'), /without profit/);
  assert.throws(() => queueFlashTest(null, 'solana', 0, { maximumSwapLossUsdc: 0.02, minimumLoanUsd: 1 }, 'solana'), /without profit/);
});
