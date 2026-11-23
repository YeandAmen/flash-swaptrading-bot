import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { address, getAddressEncoder, getCompiledTransactionMessageDecoder, getPublicKeyFromAddress, getSignatureFromTransaction,
  getTransactionDecoder, type Address, type ReadonlyUint8Array } from '@solana/kit';
import {
  createWalletAta, JUPITER, KAMINO, KAMINO_MARKET, KAMINO_MARKET_LOOKUP, KAMINO_USDC_RESERVE, LOOKUP_PROGRAM, MAINNET_GENESIS,
  USDC, WRAPPED_SOL,
} from './protocol.js';
import { LIGHTHOUSE, lighthouseAtaFloor, lighthouseLamports, lighthouseTokenAmount } from './guard.js';
import { SolanaLiveWorker } from './worker.js';
import { SolanaScanCadence } from './scan-cadence.js';
import { queueFlashTest, validSolanaSwapLossUsdc } from '../network-test.js';
import { scanSolanaCycle, solanaDiscoveryPairs, solanaScanConfig, solanaVenuePairs } from './scan.js';

const wallet = address('23g1K6sr2bevNwLYPoB79jzEQtErioYQ8mpUa76xA6yu');
const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const fakeRpc = 'http://127.0.0.1:8899';
const fee = 6400;

function reserveFixture(available: bigint) {
  const data = Buffer.alloc(8624);
  Buffer.from('2bf2ccca1af73b7f', 'hex').copy(data);
  const fields = [
    [32, KAMINO_MARKET], [128, USDC],
    [160, 'Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6'],
    [192, 'BbDUrk1bVtSixgQsPLBJFZEF7mwGstnD5joA1WzYvYFX'],
    [408, tokenProgram],
  ] as const;
  for (const [offset, key] of fields) data.set(getAddressEncoder().encode(address(key)), offset);
  data.writeBigUInt64LE(available, 224);
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
  let availableUsdcUnits = 10_000_000_000n;
  let actualWalletGain = 210_000;
  let live = false;
  let reportedFee = fee;
  let returnOut = '250250000';
  let firstOut = 3_500_000_001n;
  let usdcBalance = 1_000_000;
  let wsolBalance = 20_000;
  let wsolDrop = 0;
  let usdcAccountExists = true;
  let reportedNativeDebit = fee;
  let checkLossGuards = false;
  let jupiterRequests = 0;
  let groupedExit: string | undefined;
  let groupedIssue: 'no-route' | 'layout' | 'oversized' | 'accounts' | 'rate-limit' | 'instruction-slippage' | 'response-slippage' | undefined;
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
      if (issue === 'no-route') return Response.json({ errorCode: 'COULD_NOT_FIND_ANY_ROUTE' }, { status: 400 });
      if (requested.length > 1) requestedExits.push(requested);
      const first = inputMint === USDC;
      if (first && venue === 'Meteora DLMM') await slowQuote;
      assert.equal(params.get('wrapAndUnwrapSol'), 'false');
      assert.equal(first ? outputMint : inputMint, WRAPPED_SOL);
      const slippageBps = Number(params.get('slippageBps'));
      assert.ok(slippageBps === 1 || slippageBps === 5);
      const minimum = (out: bigint, roundUp: boolean) => (out * BigInt(10_000 - slippageBps) + (roundUp ? 9_999n : 0n)) / 10_000n;
      if (!first) assert.equal(params.get('amount'), String(minimum(firstOut, !live)));
      const outAmount = first ? String(firstOut) : returnOut;
      const bytes = Buffer.alloc(issue === 'oversized' ? 1_500 : 34);
      Buffer.from('bb64facc31c4af14', 'hex').copy(bytes);
      bytes.writeBigUInt64LE(BigInt(params.get('amount')!), 8);
      bytes.writeBigUInt64LE(BigInt(outAmount), 16);
      bytes.writeUInt16LE(issue === 'instruction-slippage' ? 5 : slippageBps, 24);
      // Distinguish the two fixture routes even when the quoted amounts match.
      if (venue === 'Kipseli') bytes[32] = 9;
      bytes[33] = venue === 'Whirlpool' ? 1 : 2;
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
        otherAmountThreshold: String(minimum(BigInt(outAmount), true)),
        swapMode: 'ExactIn', slippageBps: issue === 'response-slippage' ? 5 : slippageBps,
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
      case 'getAccountInfo': return atSlot({ data: [reserveFixture(availableUsdcUnits), 'base64'], executable: false, owner: KAMINO, lamports: 7, rentEpoch: 0, space: 8624 });
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
          const setup = usdcAccountExists ? [] : [address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')];
          assert.deepEqual(sequence.slice(2), [LIGHTHOUSE, ...setup, LIGHTHOUSE, KAMINO, JUPITER, JUPITER, KAMINO,
            LIGHTHOUSE, LIGHTHOUSE, LIGHTHOUSE]);
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
        assert.equal(compiled.instructions[sequence.lastIndexOf(KAMINO)].data?.[16], sequence.indexOf(KAMINO));
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
  assert.equal(scan.slippageBps, 1);
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
  await t.test('finite ordinary and manual requests retain their sizing and funding checks', async () => {
    const startingRequests = jupiterRequests;
    const noSubmit = async () => assert.fail('Unfundable or invalid principal was handed off');
    for (const [configured, actual] of [
      [10_000.0000009, 10_000.000001], [2_000_000.0000009, 2_000_000], [20_000_000, 20_000_000],
    ]) {
      const result = await scanSolanaCycle({ ...config, loanUsdc: configured }, noSubmit);
      assert.equal(result.loanUsdc, actual);
      assert.equal(result.status, 'loan-unavailable');
      assert.ok(result.availableUsdc < actual);
    }
    const fixedManual = await scanSolanaCycle({ ...config, loanUsdc: 50_000, clampLoanToReserve: true }, noSubmit, 'manual-size');
    assert.equal(fixedManual.status, 'loan-unavailable');
    assert.equal(fixedManual.loanUsdc, 50_000);
    for (const loanUsdc of [100_000.000001, Infinity]) {
      await assert.rejects(scanSolanaCycle({ ...config, loanUsdc }, noSubmit, 'manual-size'), /Loan size/);
    }
    assert.equal(solanaScanConfig({ SOLANA_LOAN_USDC: '20000000' }).loanUsdc, 20_000_000);
    assert.equal(solanaScanConfig({}).loanUsdc, 250);
    for (const raw of ['invalid', 'Infinity', '+Infinity', '-Infinity', 'NaN', '1e309', '0.99', '0', '-1', String(Number.MAX_SAFE_INTEGER)]) {
      assert.throws(() => solanaScanConfig({ SOLANA_LOAN_USDC: raw }), /Loan size/);
    }
    assert.equal(jupiterRequests, startingRequests);
    const originalAvailable = availableUsdcUnits;
    availableUsdcUnits = 2_000_000_000_000n;
    try {
      const funded = await scanSolanaCycle({ ...config, loanUsdc: 2_000_000 }, noSubmit);
      assert.equal(funded.status, 'scanned');
      assert.equal(funded.flashFeeUsdc, 20);
      assert.ok(funded.routes.every(route => route.status === 'below-profit-floor'));
      assert.equal(jupiterRequests - startingRequests, 4);
    } finally { availableUsdcUnits = originalAvailable; }
  });
  await t.test('unlimited cold start and planned scans quote and encode only the currently fundable principal', async (t) => {
    const unlimited = solanaScanConfig({ SOLANA_WALLET_ADDRESS: wallet, SOLANA_RPC_URL: fakeRpc, SOLANA_LOAN_USDC: 'unlimited' });
    assert.equal(unlimited.loanUsdc, Infinity);
    const originalAvailable = availableUsdcUnits;
    t.after(() => { availableUsdcUnits = originalAvailable; });
    const firstInputs: bigint[] = [];
    const fetchFixture = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin === 'https://api.jup.ag' && url.searchParams.get('inputMint') === USDC) {
        firstInputs.push(BigInt(url.searchParams.get('amount')!));
      }
      return fetchFixture(input, init);
    });
    const planned = { ...unlimited, loanUsdc: 2_000_000, clampLoanToReserve: true };
    for (const { scanConfig, available, expected, feeUsdc } of [
      { scanConfig: unlimited, available: 40_000_000_000_000n, expected: 250_000_000n, feeUsdc: 0.0025 },
      { scanConfig: planned, available: 239_123_456n, expected: 239_123_456n, feeUsdc: 0.002392 },
      { scanConfig: unlimited, available: 241_234_567n, expected: 241_234_567n, feeUsdc: 0.002413 },
    ]) {
      availableUsdcUnits = available;
      const startingRequests = jupiterRequests;
      firstInputs.length = 0;
      let handoffs = 0;
      const result = await scanSolanaCycle(scanConfig, async candidate => {
        handoffs++;
        assert.equal(candidate.loan, expected);
        const compiled = getCompiledTransactionMessageDecoder().decode(candidate.transaction.messageBytes);
        if (compiled.version !== 0) assert.fail('Expected a v0 transaction');
        const kamino = compiled.instructions.filter(ix => compiled.staticAccounts[ix.programAddressIndex] === KAMINO);
        assert.deepEqual(kamino.map(ix => Buffer.from(ix.data!).readBigUInt64LE(8)), [expected, expected]);
      });
      assert.equal(result.status, 'scanned');
      assert.equal(result.loanUsdc, Number(expected) / 1e6);
      assert.equal(result.availableUsdc, Number(available) / 1e6);
      assert.equal(result.flashFeeUsdc, feeUsdc);
      assert.deepEqual(firstInputs, [expected, expected]);
      assert.equal(jupiterRequests - startingRequests, 4);
      assert.ok(result.routes.every(route => route.qualified), JSON.stringify(result.routes));
      assert.equal(handoffs, 1);
    }
    const startingRequests = jupiterRequests;
    for (const value of [0n, 999_999n]) {
      availableUsdcUnits = value;
      const result = await scanSolanaCycle(planned, async () => assert.fail('Sub-dollar loan was handed off'));
      assert.equal(result.status, 'loan-unavailable');
      assert.equal(result.loanUsdc, Number(value) / 1e6);
      assert.equal(result.flashFeeUsdc, null);
      assert.deepEqual(result.routes, []);
    }
    assert.equal(jupiterRequests, startingRequests);
  });
  await t.test('unlimited raw sizing preserves the exact quote, fee and encoded principal above 2^53', async (t) => {
    const configured = { ...config, loanUsdc: Infinity };
    const original = { available: availableUsdcUnits, firstOut, returnOut };
    t.after(() => { availableUsdcUnits = original.available; firstOut = original.firstOut; returnOut = original.returnOut; });
    const requestedUnits: bigint[] = [];
    const fixtureFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin === 'https://api.jup.ag' && url.searchParams.get('inputMint') === USDC) {
        requestedUnits.push(BigInt(url.searchParams.get('amount')!));
      }
      return fixtureFetch(input, init);
    });
    const planned = 9_007_199_254_740_993n;
    for (const [available, fullReserve, expected, oneUnitShort] of [
      [planned + 1_006n, false, planned, false],
      [planned + 1_006n, true, planned + 1_006n, false],
      [planned - 2n, false, planned - 2n, false],
      [planned + 1_006n, false, planned, true],
    ] as const) {
      availableUsdcUnits = available;
      requestedUnits.length = 0;
      firstOut = expected * 14n + 1n;
      // The fixture fee rounds up to 90,071,992,548 micro-USDC, and 6,400 lamports costs 458 micro-USDC.
      const guarantee = expected + 90_071_992_548n + 458n + 50_000n - (oneUnitShort ? 1n : 0n);
      returnOut = ((guarantee * 10_000n + 9_998n) / 9_999n).toString();
      let handoffs = 0;
      const before = simulationCount;
      const result = await scanSolanaCycle({ ...configured, plannedLoanUnits: planned, useFullReserve: fullReserve }, async candidate => {
        handoffs++;
        assert.equal(candidate.loan, expected);
        const compiled = getCompiledTransactionMessageDecoder().decode(candidate.transaction.messageBytes);
        if (compiled.version !== 0) assert.fail('Expected a v0 transaction');
        const kamino = compiled.instructions.filter(ix => compiled.staticAccounts[ix.programAddressIndex] === KAMINO);
        assert.deepEqual(kamino.map(ix => Buffer.from(ix.data!).readBigUInt64LE(8)), [expected, expected]);
      });
      assert.equal(result.loanUsdcUnits, expected.toString());
      assert.equal(result.availableUsdcUnits, available.toString());
      assert.equal(result.flashFeeUsdcUnits, '90071992548');
      assert.equal(result.flashFeeUsdc, 90_071.992548);
      assert.deepEqual(requestedUnits, [expected, expected]);
      assert.ok(result.routes.every(route => route.quotedNetBeforeNetworkUsdc === (oneUnitShort ? 0.050457 : 0.050458)));
      assert.ok(result.routes.every(route => oneUnitShort ? route.status === 'below-profit-floor' : route.qualified), JSON.stringify(result.routes));
      assert.equal(handoffs, oneUnitShort ? 0 : 1);
      assert.equal(simulationCount - before, oneUnitShort ? 0 : 2);
      assert.doesNotThrow(() => JSON.stringify(result));
    }
  });
  await t.test('planner overrides require unlimited ordinary mode and a repayable u64 amount', async (t) => {
    const original = availableUsdcUnits;
    t.after(() => { availableUsdcUnits = original; });
    const noSubmit = async () => assert.fail('An unprofitable or out-of-range candidate was handed off');
    const unlimited = { ...config, loanUsdc: Infinity };
    const maxU64 = (1n << 64n) - 1n;
    const before = jupiterRequests;
    for (const plannedLoanUnits of [-1n, 999_999n, maxU64 + 1n]) {
      await assert.rejects(scanSolanaCycle({ ...unlimited, plannedLoanUnits }, noSubmit), /Planned loan size/);
    }
    for (const override of [{ plannedLoanUnits: 250_000_000n }, { useFullReserve: true }]) {
      await assert.rejects(scanSolanaCycle({ ...config, ...override }, noSubmit), /unlimited ordinary/);
      await assert.rejects(scanSolanaCycle({ ...unlimited, ...override }, noSubmit, 'manual'), /unlimited ordinary/);
    }
    const largestRepayable = 18_446_559_608_113_470_487n;
    for (const unrepayable of [largestRepayable + 1n, maxU64]) {
      availableUsdcUnits = unrepayable;
      const result = await scanSolanaCycle({ ...unlimited, useFullReserve: true }, noSubmit);
      assert.equal(result.status, 'loan-unavailable');
      assert.equal(result.loanUsdcUnits, unrepayable.toString());
      assert.deepEqual(result.routes, []);
    }
    assert.equal(jupiterRequests, before);
    availableUsdcUnits = maxU64;
    const atBoundary = await scanSolanaCycle({ ...unlimited, plannedLoanUnits: largestRepayable }, noSubmit);
    assert.equal(atBoundary.status, 'scanned');
    assert.equal(BigInt(atBoundary.loanUsdcUnits) + BigInt(atBoundary.flashFeeUsdcUnits!), maxU64);
    assert.ok(atBoundary.routes.every(route => route.status === 'below-profit-floor'));
    assert.equal(jupiterRequests, before + 4);
  });
  await t.test('rejects a Jupiter output larger than u64 before requesting the next swap', async (t) => {
    const fixtureFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
      const response = await fixtureFetch(input, init);
      const url = new URL(String(input));
      if (url.origin !== 'https://api.jup.ag') return response;
      assert.equal(url.searchParams.get('inputMint'), USDC);
      const swap = await response.json();
      swap.outAmount = (1n << 64n).toString();
      return Response.json(swap);
    });
    const before = jupiterRequests, beforeSim = simulationCount;
    const result = await scanSolanaCycle(config, async () => assert.fail('A route with a non-u64 output was handed off'));
    assert.ok(result.routes.every(route => route.status === 'quote-error' && route.detail?.includes('u64')));
    assert.equal(jupiterRequests - before, 2);
    assert.equal(simulationCount, beforeSim);
  });
  await t.test('prices a missing ATA in parallel with the message fee and waits for both before simulation', async (t) => {
    const fetchFixture = globalThis.fetch;
    const rent = 1_488_440;
    let releaseRent!: () => void, sawFee!: () => void, sawRent!: () => void;
    const rentGate = new Promise<void>(resolve => { releaseRent = resolve; });
    const feeRequested = new Promise<void>(resolve => { sawFee = resolve; });
    const rentRequested = new Promise<void>(resolve => { sawRent = resolve; });
    let rejectRent = false, rentRequests = 0;
    t.mock.method(globalThis, 'fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
      if (new URL(String(input)).origin === fakeRpc) {
        const request = JSON.parse(String(init?.body));
        if (request.method === 'getFeeForMessage') sawFee();
        if (request.method === 'getMinimumBalanceForRentExemption') {
          rentRequests++;
          sawRent();
          await rentGate;
          if (rejectRent) return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'Rent unavailable' } });
        }
      }
      return fetchFixture(input, init);
    });
    const previousUsdcBalance = usdcBalance;
    usdcAccountExists = false;
    usdcBalance = 0;
    reportedNativeDebit = fee + rent;
    t.after(() => { releaseRent(); usdcAccountExists = true; usdcBalance = previousUsdcBalance; reportedNativeDebit = fee; });
    const before = simulationCount, startingRequests = jupiterRequests;
    let submitted = 0;
    const scan = scanSolanaCycle(config, async candidate => {
      submitted++;
      assert.equal(candidate.rentLamports, BigInt(rent));
      assert.equal(candidate.maximumLamportDebit, BigInt(rent + fee));
      assert.ok(candidate.net >= 50_000n);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all([feeRequested, rentRequested]), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('Message fee waited for the rent response')), 1000);
      })]);
      assert.equal(simulationCount, before);
      assert.equal(submitted, 0);
    } finally { clearTimeout(timer); releaseRent(); }
    const checked = await scan;
    assert.ok(checked.routes.every(route => route.qualified), JSON.stringify(checked.routes));
    assert.equal(simulationCount, before + 2);
    assert.equal(jupiterRequests - startingRequests, 4);
    assert.equal(submitted, 1);

    rejectRent = true;
    const noSubmit = async () => assert.fail('Unavailable rent must not qualify a candidate');
    assert.ok((await scanSolanaCycle(config, noSubmit)).routes.every(route => route.status === 'simulation-failed'));
    assert.equal(simulationCount, before + 2);
    const previousRentRequests = rentRequests;
    usdcAccountExists = true;
    reportedNativeDebit = fee;
    assert.ok((await scanSolanaCycle(config, async () => {})).routes.every(route => route.qualified));
    assert.equal(rentRequests, previousRentRequests, 'existing ATAs require no rent lookup');
  });
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
  await t.test('a verified Jupiter slippage failure permits one ordinary alternate through the worker handoff', async (t) => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'solana-slippage-test-'));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const workerRpc = 'http://127.0.0.1:8898';
    const worker = new SolanaLiveWorker({ wallet, rpcUrl: workerRpc }, '', dataDir, 5);
    // Public key and mock signature bytes only. Exercise the ordinary handoff, journal and RPC acknowledgment.
    Object.assign(worker, { signer: { keyPair: { publicKey: await getPublicKeyFromAddress(wallet) } }, lease: 'unit-test',
      journal: { version: 1, wallet, armed: true, pending: null, lastOutcome: null, fees: [] } });
    const signer = t.mock.method(crypto.subtle, 'sign', async () => new Uint8Array(64).fill(71).buffer);
    const scannerFetch = globalThis.fetch;
    const finalWires: string[] = [];
    const sentMessages: Buffer[] = [];
    let failEveryRoute = true;
    const slippage: { program: Address; code: number; childFailed: boolean } = { program: JUPITER, code: 6001, childFailed: false };
    let failure = slippage;
    t.mock.method(globalThis, 'fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
      if (new URL(String(input)).origin !== workerRpc) return scannerFetch(input, init);
      const { id, method, params } = JSON.parse(String(init?.body));
      const reply = (result: unknown) => Response.json({ id, jsonrpc: '2.0', result });
      const atSlot = (value: unknown) => reply({ context: { slot: 42 }, value });
      if (method === 'getEpochInfo') return reply({ absoluteSlot: 42, blockHeight: 32, epoch: 1, slotIndex: 1, slotsInEpoch: 100 });
      if (method === 'getBalance') return atSlot(50_000_000);
      if (method === 'isBlockhashValid') return atSlot(true);
      const tx = getTransactionDecoder().decode(Buffer.from(params[0], 'base64'));
      if (method === 'sendTransaction') {
        sentMessages.push(Buffer.from(tx.messageBytes));
        return reply(getSignatureFromTransaction(tx));
      }
      assert.equal(method, 'simulateTransaction');
      assert.ok(Object.values(tx.signatures).every((sig) => sig === null));
      finalWires.push(params[0]);
      if (failEveryRoute || finalWires.length === 1) {
        const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
        assert(compiled.version === 0);
        const index = compiled.instructions.findIndex((ix) => compiled.staticAccounts[ix.programAddressIndex] === failure.program);
        assert.ok(index >= 0);
        const failed = `failed: custom program error: 0x${failure.code.toString(16)}`;
        return atSlot({ err: { InstructionError: [index, { Custom: failure.code }] },
          logs: [`Program ${failure.program} invoke [1]`, `Program ${tokenProgram} invoke [2]`,
            `Program ${tokenProgram} ${failure.childFailed ? failed : 'success'}`,
            `Program ${failure.program} consumed 80000 of 1200000 compute units`, `Program ${failure.program} ${failed}`] });
      }
      const balances = (gain: number) => [USDC, WRAPPED_SOL].map((mint, index) => ({
        accountIndex: index + 1, mint, owner: wallet, uiTokenAmount: { amount: String(index === 0 ? gain : 0) },
      }));
      return atSlot({ err: null, fee, preBalances: [50_000_000], postBalances: [50_000_000 - fee],
        preTokenBalances: balances(0), postTokenBalances: balances(210_000) });
    });

    worker.queueTest('manual-slippage');
    await scanSolanaCycle(config, worker.scanHandoff(), 'manual-slippage');
    assert.equal(finalWires.length, 1);
    assert.equal(signer.mock.callCount(), 0);
    worker.disarm();
    worker.arm();

    for (const other of [{ ...slippage, childFailed: true }, { ...slippage, code: 6002 },
      { ...slippage, program: KAMINO }, { ...slippage, program: LIGHTHOUSE }]) {
      failure = other;
      finalWires.length = 0;
      await scanSolanaCycle(config, worker.scanHandoff());
      assert.equal(finalWires.length, 1, 'an unverified or non-Jupiter failure must hold the alternate');
      assert.equal(signer.mock.callCount(), 0);
    }
    failure = slippage;

    finalWires.length = 0;
    await scanSolanaCycle(config, worker.scanHandoff());
    assert.equal(finalWires.length, 2, 'if both decline, the scan exhausts its one alternate');
    assert.equal(signer.mock.callCount(), 0);
    assert.equal(worker.summary.pending, null);

    failEveryRoute = false;
    finalWires.length = 0;
    const scanned = await scanSolanaCycle(config, worker.scanHandoff());
    assert.ok(scanned.routes.every((route) => route.qualified));
    assert.equal(finalWires.length, 2);
    assert.notEqual(finalWires[0], finalWires[1]);
    assert.equal(sentMessages.length, 1);
    assert.deepEqual(sentMessages[0], Buffer.from(getTransactionDecoder().decode(Buffer.from(finalWires[1], 'base64')).messageBytes));
    assert.equal(signer.mock.callCount(), 1);
    assert.ok(worker.summary.pending);

    await scanSolanaCycle(config, worker.scanHandoff());
    assert.equal(finalWires.length, 2, 'a pending intent precludes another final simulation');
    assert.equal(signer.mock.callCount(), 1);
    assert.equal(sentMessages.length, 1);
  });
  await t.test('attributes early simulation failures and retries one verified grouped return with the original entry', async (t) => {
    const settings = { ...config, loanUsdc: 2_500, venuePair: solanaDiscoveryPairs[2], compareReturnVenues: true };
    const previous = { firstOut, returnOut, groupedExit };
    t.after(() => {
      firstOut = previous.firstOut; returnOut = previous.returnOut; groupedExit = previous.groupedExit;
      reportedFee = fee; requestedExits.length = 0;
    });
    firstOut = 35_000_000_001n;
    const guarantee = 2_500_000_000n + 25_000n + 72_517n; // lender repayment plus the observed pre-network margin
    returnOut = ((guarantee * 10_000n + 9_998n) / 9_999n).toString();
    groupedExit = 'Kipseli';
    let step: 'entry' | 'return' | 'borrow' | 'repay' | 'guard' | 'unknown' = 'return';
    let code = 6001, cpi = false, expired = false, allExits = false, missingEntry = false;
    let clock = 1_000, attempts = 0;
    t.mock.method(performance, 'now', () => clock);
    const fetchFixture = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', (input: URL | RequestInfo, init?: RequestInit) => {
      if (new URL(String(input)).origin !== fakeRpc) return fetchFixture(input, init);
      const req = JSON.parse(String(init?.body));
      if (req.method !== 'simulateTransaction') return fetchFixture(input, init);
      attempts++;
      const transaction = getTransactionDecoder().decode(Buffer.from(req.params[0], 'base64'));
      const wire = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
      if (wire.version !== 0) assert.fail('expected V0');
      const programs = wire.instructions.map(ix => wire.staticAccounts[ix.programAddressIndex]);
      const exit = programs.lastIndexOf(JUPITER);
      if (wire.instructions[exit].data?.[32] !== 9 && !allExits) return fetchFixture(input, init);
      const index = step === 'entry' ? programs.indexOf(JUPITER) : step === 'borrow' ? programs.indexOf(KAMINO)
        : step === 'repay' ? programs.lastIndexOf(KAMINO) : step === 'guard' ? programs.lastIndexOf(LIGHTHOUSE) : exit;
      const root = programs[index];
      const logs = [...(step === 'return' && !missingEntry ? [`Program ${JUPITER} invoke [1]`, `Program ${JUPITER} success`] : []),
        `Program ${root} invoke [1]`, 'Program log: Error: https://private.invalid/value?key=secret',
        ...(cpi ? [`Program ${tokenProgram} invoke [2]`, `Program ${tokenProgram} failed: custom program error: 0x1771`] : []),
        `Program ${root} failed: custom program error: 0x${code.toString(16)}`];
      const err = step === 'unknown' ? { InstructionError: [250, { Custom: code }] } : { InstructionError: [index, { Custom: code }] };
      if (expired) clock += 8_001;
      return Promise.resolve(Response.json({ jsonrpc: '2.0', id: req.id, result: { context: { slot: 42 }, value: { err, logs } } }));
    });
    let handoffs = 0;
    const run = async (manual?: string) => {
      attempts = handoffs = 0;
      const before = jupiterRequests;
      const result = await scanSolanaCycle(settings, async candidate => {
        handoffs++;
        assert.equal(candidate.loan, 2_500_000_000n);
        assert.equal(candidate.feeLamports, BigInt(fee));
        assert.ok(candidate.net >= 50_000n);
      }, manual);
      assert.equal(result.flashFeeUsdc, 0.025);
      assert.ok(result.routes.every(route => !/private|secret/.test(route.detail ?? '')));
      return { result, requests: jupiterRequests - before };
    };
    const recovered = await run();
    assert.equal(recovered.requests, 5, 'two entries, two grouped returns, one paired return');
    assert.equal(attempts, 3);
    assert.equal(handoffs, 1);
    assert.ok(recovered.result.routes.every(r => r.quotedNetBeforeNetworkUsdc === 0.072517));
    const winner = recovered.result.routes.find(route => route.qualified);
    assert.ok(winner && winner.sell !== 'Kipseli');
    assert.match(winner.detail!, /Previous Kipseli: Outer ix [0-9]+ Jupiter return: slippage 6001/);
    reportedFee++;
    const rejected = await run();
    assert.equal(rejected.requests, 5);
    assert.equal(handoffs, 0, 'paired return still needs exact network fee reconciliation');
    reportedFee = fee;
    for (const [failure, detail] of [
      ['entry', 'Jupiter entry'], ['borrow', 'Kamino borrow'], ['repay', 'Kamino repay'],
      ['guard', 'Lighthouse balance floor'], ['unknown', 'unclassified error'],
    ] as const) {
      step = failure;
      const blocked = await run();
      assert.equal(blocked.requests, 4, failure);
      assert.equal(handoffs, 0, failure);
      assert.ok(blocked.result.routes.every(r => r.status === 'simulation-failed' && r.detail?.includes(detail)));
    }
    step = 'return';
    for (const reason of ['nested CPI', 'unverified entry', 'unknown code', 'expired', 'same exit', 'manual']) {
      cpi = reason === 'nested CPI';
      missingEntry = reason === 'unverified entry';
      code = reason === 'unknown code' ? 6002 : 6001;
      expired = reason === 'expired';
      allExits = reason === 'same exit' || reason === 'manual';
      groupedExit = reason === 'same exit' ? 'paired' : 'Kipseli';
      // The manual five-bps return must still clear its pre-simulation floor.
      if (reason === 'manual') returnOut = '2503000000';
      const blocked = await run(reason === 'manual' ? 'manual-error' : undefined);
      assert.equal(blocked.requests, 4, reason);
      assert.equal(handoffs, 0, reason);
      assert.ok(blocked.result.routes.every(r => r.status === 'simulation-failed'), reason);
    }
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
  await t.test('a declined first route can release one paired return rebuild while the entry quote is fresh', async (t) => {
    const settings = { ...config, venuePair: solanaVenuePairs[1], compareReturnVenues: true };
    let clock = 1_000;
    t.mock.method(performance, 'now', () => clock);
    const fetchFixture = globalThis.fetch;
    let groupedReply!: () => void;
    let pairedRequest!: () => void;
    const firstVenues: string[] = [];
    t.mock.method(globalThis, 'fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin !== 'https://api.jup.ag') return fetchFixture(input, init);
      const dexes = url.searchParams.get('dexes')!;
      const buy = url.searchParams.get('inputMint') === USDC;
      if (buy) firstVenues.push(dexes);
      if (!buy && dexes === 'Whirlpool') pairedRequest();
      const response = await fetchFixture(input, init);
      if (!buy && dexes.includes(',') && !dexes.includes('Meteora DLMM')) groupedReply();
      return response;
    });
    t.after(() => { groupedIssue = undefined; groupedExit = undefined; slowQuote = undefined; requestedExits.length = 0; });

    type Decision = 'decline' | 'early decline' | 'accepted' | 'unknown' | 'revoked' | 'expired' | 'revoked during rebuild' | 'expired during rebuild';
    async function run(issue: NonNullable<typeof groupedIssue>, decision: Decision) {
      jupiterRequests = 0;
      firstVenues.length = 0;
      groupedExit = 'Kipseli';
      groupedIssue = undefined;
      let permit = true;
      let unblockEntry!: () => void;
      let decide!: () => void;
      let submissions = 0;
      const gate = new Promise<void>(resolve => { decide = resolve; });
      const grouped = new Promise<void>(resolve => { groupedReply = resolve; });
      slowQuote = new Promise<void>(resolve => { unblockEntry = resolve; });
      pairedRequest = () => {
        if (decision === 'revoked during rebuild') permit = false;
        if (decision === 'expired during rebuild') clock += 8001;
      };
      const scan = scanSolanaCycle(settings, async candidate => {
        assert.ok(candidate.net >= 50_000n);
        if (++submissions === 1) {
          groupedIssue = issue;
          if (decision === 'early decline') setImmediate(unblockEntry);
          else { unblockEntry(); await gate; }
          if (decision === 'accepted') return;
          if (decision === 'unknown') throw Error('First submission outcome unknown');
          if (decision === 'revoked') permit = false;
          if (decision === 'expired') clock += 8001;
        }
        return { status: 'route-declined', canTryAlternate: () => permit };
      });
      await grouped;
      if (decision !== 'early decline') {
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(jupiterRequests, 4, 'an outstanding first handoff cannot spend the return request');
        assert.equal(submissions, 1);
      }
      decide();
      const result = decision === 'unknown' ? await assert.rejects(scan, /First submission outcome unknown/) : await scan;
      assert.deepEqual(firstVenues.sort(), ['Meteora DLMM', 'Whirlpool'], 'reuse the original guaranteed entry');
      return { submissions, requests: jupiterRequests, route: result?.routes[1] };
    }

    for (const issue of ['no-route', 'layout', 'oversized'] as const) {
      const recovered = await run(issue, 'decline');
      assert.equal(recovered.requests, 5, issue);
      assert.equal(recovered.submissions, 2, issue);
      assert.equal(recovered.route?.sell, 'Whirlpool');
      assert.equal(recovered.route?.qualified, true);
    }
    const early = await run('layout', 'early decline');
    assert.equal(early.requests, 5);
    assert.equal(early.submissions, 2);
    assert.equal(early.route?.qualified, true);
    for (const decision of ['accepted', 'unknown', 'revoked', 'expired'] as const) {
      const skipped = await run('layout', decision);
      assert.equal(skipped.requests, 4, decision);
      assert.equal(skipped.submissions, 1, decision);
    }
    for (const issue of ['accounts', 'rate-limit', 'instruction-slippage', 'response-slippage'] as const) {
      const invalid = await run(issue, 'decline');
      assert.equal(invalid.requests, 4, issue);
      assert.equal(invalid.submissions, 1, issue);
    }
    for (const decision of ['revoked during rebuild', 'expired during rebuild'] as const) {
      const late = await run('layout', decision);
      assert.equal(late.requests, 5, decision);
      assert.equal(late.submissions, 1, decision);
    }
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
    assert.equal(manual.slippageBps, 5);
    assert.ok(manual.routes.every((route) => route.qualified));
    assert.equal(submissions, 1);
  });
  await t.test('uses the guaranteed return to gate tight ordinary quotes while reporting the expected return', async () => {
    const settings = { ...config, venuePair: solanaDiscoveryPairs[2], compareReturnVenues: true };
    groupedExit = 'PancakeSwap';
    returnOut = '250090000';
    let submissions = 0;
    const ordinary = await scanSolanaCycle(settings, async () => { submissions++; });
    assert.equal(ordinary.slippageBps, 1);
    assert.equal(submissions, 1);
    for (const route of ordinary.routes) {
      assert.equal(route.qualified, true, route.detail);
      assert.equal(route.expectedNetBeforeNetworkUsdc, 0.0875);
      assert.equal(route.quotedNetBeforeNetworkUsdc, 0.062491);
    }

    const noSubmit = async () => assert.fail('Unprotected quote authorized a candidate');
    const simulationsBefore = simulationCount;
    const manual = await scanSolanaCycle(settings, noSubmit, { id: 'profit-test', minimumNetUsd: 0.05 });
    assert.equal(manual.slippageBps, 5);
    for (const route of manual.routes) {
      assert.equal(route.status, 'below-profit-floor', route.detail);
      assert.equal(route.quotedNetBeforeNetworkUsdc, -0.037545);
    }
    returnOut = '250065000';
    const near = await scanSolanaCycle(settings, noSubmit);
    for (const route of near.routes) {
      assert.equal(route.status, 'below-profit-floor', route.detail);
      assert.equal(route.expectedNetBeforeNetworkUsdc, 0.0625);
      assert.equal(route.quotedNetBeforeNetworkUsdc, 0.037493);
    }
    assert.equal(simulationCount, simulationsBefore);
    groupedExit = undefined;
    returnOut = '250250000';
    requestedExits.length = 0;
  });
  await t.test('a late successful grouped return cannot erase its sibling’s Build cooldown', async t => {
    const cadence = new SolanaScanCadence();
    t.mock.method(performance, 'now', () => 1_000);
    t.mock.method(Date, 'now', () => 1_800_000_000_000);
    const baseFetch = globalThis.fetch;
    let started!: () => void;
    const bothExits = new Promise<void>(resolve => { started = resolve; });
    let builds = 0;
    t.mock.method(globalThis, 'fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin === 'https://api.jup.ag') {
        builds++;
        const venues = url.searchParams.get('dexes')!.split(',');
        if (venues.length > 1) {
          if (venues.includes('BisonFi')) {
            await bothExits;
            return Response.json({}, { status: 429, headers: { 'retry-after': '35' } });
          }
          started();
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }
      return baseFetch(input, init);
    });
    groupedExit = 'Kipseli';
    returnOut = '250065000';
    try {
      const result = await scanSolanaCycle({ ...config, venuePair: solanaDiscoveryPairs[2], compareReturnVenues: true,
        fetchBuild: cadence.fetchBuild }, async () => assert.fail('No route qualified for execution'));
      assert.deepEqual(result.routes.map(route => route.status), ['quote-error', 'below-profit-floor']);
      assert.equal(builds, 4);
      assert.equal(cadence.complete(false), 35_000);
      assert.equal(cadence.delay(true), 35_000);
      assert.equal(cadence.providerCooldownUntil, Date.now() + 35_000);
    } finally {
      groupedExit = undefined;
      returnOut = '250250000';
    }
  });
  await t.test('compares other direct exits and records the actual venue with one quote per leg', async () => {
    const settings = { ...config, venuePair: solanaDiscoveryPairs[2], compareReturnVenues: true };
    let submissions = 0;
    for (const exit of ['Kipseli', 'ZeroFi']) {
      groupedExit = exit;
      jupiterRequests = 0;
      submissions = 0;
      requestedExits.length = 0;
      const direct = await scanSolanaCycle(settings, async () => { submissions++; });
      assert.equal(jupiterRequests, 4);
      assert.equal(submissions, 1);
      assert.deepEqual(direct.routes.map((route) => [route.buy, route.sell, route.qualified]),
        [['SolFi V2', exit, true], ['BisonFi', exit, true]]);
      assert.equal(requestedExits.length, 2);
      for (const allowed of requestedExits) {
        assert.equal(new Set(allowed).size, 7);
        assert.ok(allowed.includes('Kipseli') && allowed.includes('ZeroFi'));
        assert.ok(allowed.includes('SolFi V2') !== allowed.includes('BisonFi'));
      }
    }
    requestedExits.length = 0;
    jupiterRequests = 0;
    const manual = await scanSolanaCycle(settings, async () => {}, 'paired-manual-test');
    assert.equal(jupiterRequests, 4);
    assert.equal(requestedExits.length, 0);
    assert.deepEqual(manual.routes.map(({ buy, sell }) => [buy, sell]), [['SolFi V2', 'BisonFi'], ['BisonFi', 'SolFi V2']]);

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
    for (const issue of ['accounts', 'rate-limit', 'instruction-slippage', 'response-slippage'] as const) {
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
