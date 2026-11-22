import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  appendTransactionMessageInstructions, assertIsBlockhash, compileTransaction, createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage, getBase58Decoder, getCompiledTransactionMessageDecoder, getSignatureFromTransaction, getTransactionDecoder,
  setTransactionMessageComputeUnitLimit, setTransactionMessageComputeUnitPrice, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  type Address,
} from '@solana/kit';
import { writePrivateFile } from '../private-file.js';
import { LIGHTHOUSE, lighthouseAtaFloor, lighthouseLamports, lighthouseTokenAmount } from './guard.js';
import { createWalletAta, JUPITER, KAMINO, MAINNET_GENESIS, USDC, WRAPPED_SOL } from './protocol.js';
import type { PreparedSolanaCycle } from './scan.js';
import { SolanaLiveWorker } from './worker.js';

const rpcUrl = 'http://127.0.0.1:8899';
const fee = 6400;
const rent = 4_079_040;
const walletBalance = 20_000_000;
const expires = 150n;

function testCandidate(wallet: Address, blockhash = '11111111111111111111111111111111'): PreparedSolanaCycle {
  assertIsBlockhash(blockhash);
  const sequence = [LIGHTHOUSE, LIGHTHOUSE, KAMINO, JUPITER, JUPITER, KAMINO, LIGHTHOUSE, LIGHTHOUSE];
  const message = appendTransactionMessageInstructions(sequence.map((programAddress) => ({ programAddress })),
    setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: expires },
      setTransactionMessageFeePayer(wallet, createTransactionMessage({ version: 0 }))));
  return {
    transaction: compileTransaction(message), simulationSlot: 90n, lastValidBlockHeight: expires,
    feeLamports: BigInt(fee), rentLamports: BigInt(rent), maximumLamportDebit: BigInt(fee + rent),
    firstMinimum: 3_500_000_000n, loan: 250_000_000n, net: 123_000n,
  };
}

async function testLossCandidate(wallet: Address, id: string, blockhash: string, floorAdjustment = 0n): Promise<PreparedSolanaCycle> {
  const base = testCandidate(wallet, blockhash);
  const [{ ata: usdcAta }, { ata: wsolAta }] = await Promise.all([createWalletAta(wallet, USDC), createWalletAta(wallet, WRAPPED_SOL)]);
  assertIsBlockhash(blockhash);
  const swapLossGuard = { cap: 20_000n, baselineUsdc: 1_000_000n, baselineWsol: 90_000_000n, baselineLamports: BigInt(walletBalance) };
  const nativeFloor = swapLossGuard.baselineLamports - BigInt(fee);
  const borrow = Buffer.alloc(16);
  const repay = Buffer.alloc(17);
  Buffer.from('87e734a70734d4c1', 'hex').copy(borrow);
  Buffer.from('b97500cb60f5b4ba', 'hex').copy(repay);
  borrow.writeBigUInt64LE(base.loan, 8);
  repay.writeBigUInt64LE(base.loan, 8);
  repay[16] = 4;
  const template = setTransactionMessageComputeUnitPrice(1_000n, setTransactionMessageComputeUnitLimit(1_400_000,
    setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: expires },
      setTransactionMessageFeePayer(wallet, createTransactionMessage({ version: 0 })))));
  const message = appendTransactionMessageInstructions([
    lighthouseLamports(wallet, 'equal', nativeFloor), lighthouseTokenAmount(usdcAta, 'equal', swapLossGuard.baselineUsdc),
    { programAddress: KAMINO, data: borrow }, { programAddress: JUPITER }, { programAddress: JUPITER },
    { programAddress: KAMINO, data: repay }, lighthouseAtaFloor(usdcAta, swapLossGuard.baselineUsdc - swapLossGuard.cap + floorAdjustment),
    lighthouseAtaFloor(wsolAta, swapLossGuard.baselineWsol), lighthouseLamports(wallet, 'atLeast', nativeFloor),
  ], template);
  return { ...base, testId: id, transaction: compileTransaction(message), rentLamports: 0n,
    maximumLamportDebit: BigInt(fee), net: -20_458n, swapLossGuard };
}

test('Solana journals before raw send and restores one pending signature across restart', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solana-worker-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const keyFile = path.join(dataDir, 'mock-wallet.json');
  const journal = path.join(dataDir, 'solana-live.json');
  const seed = new Uint8Array(32).fill(7);
  const { address: wallet, keyPair } = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  writePrivateFile(keyFile, JSON.stringify([...seed, ...publicBytes]));
  let candidate = testCandidate(wallet);
  let slot = 91;
  let height = 80;
  let blockhashValid = true;
  let finalizedReceipt: 'none' | 'failed' | 'success' = 'none';
  let simulationCount = 0;
  let rawSendCount = 0;
  let pendingSignature: string | null = null;
  let holdSimulation: Promise<void> | null = null;
  let reachedSimulation: (() => void) | undefined;
  const token = (mint: Address, amount: string, decimals: number, accountIndex = 1) => ({
    accountIndex, mint, owner: wallet, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    uiTokenAmount: { amount, decimals },
  });
  const preTokens = [token(USDC, '1000000', 6), token(WRAPPED_SOL, '90000000', 9)];
  const postTokens = [token(USDC, '1420000', 6), token(WRAPPED_SOL, '90000000', 9)];
  const simulationMeta = {
    err: null, fee, preBalances: [walletBalance], postBalances: [walletBalance - fee - rent],
    preTokenBalances: preTokens, postTokenBalances: postTokens,
  };
  const seenSignatures = new Set<string>();
  t.mock.method(globalThis, 'fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
    assert.equal(new URL(String(input)).origin, rpcUrl);
    const { id, method, params } = JSON.parse(String(init?.body));
    const reply = (result: unknown) => Response.json({ id, jsonrpc: '2.0', result });
    const context = (value: unknown) => reply({ context: { slot }, value });
    switch (method) {
      case 'getGenesisHash': return reply(MAINNET_GENESIS);
      case 'getEpochInfo': return reply({ absoluteSlot: slot, blockHeight: height, epoch: 8, slotIndex: 21, slotsInEpoch: 200 });
      case 'getBalance': return context(walletBalance);
      case 'isBlockhashValid': return context(blockhashValid);
      case 'simulateTransaction': {
        simulationCount++;
        const tx = getTransactionDecoder().decode(Buffer.from(params[0], 'base64'));
        assert.equal(params[1].sigVerify, false);
        assert.equal(params[1].replaceRecentBlockhash, false);
        assert.ok(Object.values(tx.signatures).every((sig) => sig === null));
        assert.deepEqual(Buffer.from(tx.messageBytes), Buffer.from(candidate.transaction.messageBytes));
        reachedSimulation?.();
        await holdSimulation;
        return context(simulationMeta);
      }
      case 'sendTransaction': {
        rawSendCount++;
        const tx = getTransactionDecoder().decode(Buffer.from(params[0], 'base64'));
        const sig = getSignatureFromTransaction(tx);
        assert.ok(Object.values(tx.signatures).every((item) => item !== null));
        assert.deepEqual(Buffer.from(tx.messageBytes), Buffer.from(candidate.transaction.messageBytes));
        assert.equal(params[1].skipPreflight, false);
        assert.equal(params[1].maxRetries, 0);
        const saved = JSON.parse(fs.readFileSync(journal, 'utf8'));
        assert.equal(saved.pending.signature, sig);
        if (candidate.testId) {
          assert.equal(saved.pending.testId, candidate.testId);
          assert.equal(saved.test.status, 'submitted');
          assert.equal(saved.test.hash, sig);
        }
        seenSignatures.add(sig);
        pendingSignature = sig;
        throw new Error('Mock send acknowledgment was lost');
      }
      case 'getSignatureStatuses':
        assert.ok(seenSignatures.has(params[0][0]));
        assert.equal(params[1].searchTransactionHistory, true);
        return context([finalizedReceipt === 'none' ? null : { confirmationStatus: 'finalized', confirmations: null,
          slot, err: finalizedReceipt === 'success' ? null : 'AccountNotFound' }]);
      case 'getTransaction': {
        // Kit omits the protocol's default commitment from the getTransaction request.
        assert.equal(params[1].commitment ?? 'finalized', 'finalized');
        if (finalizedReceipt === 'none') return reply(null);
        const compiled = getCompiledTransactionMessageDecoder().decode(candidate.transaction.messageBytes);
        assert.equal(compiled.version, 0);
        const instructions = compiled.instructions.map((ix) => ({ programIdIndex: ix.programAddressIndex,
          accounts: ix.accountIndices ?? [], data: getBase58Decoder().decode(ix.data ?? new Uint8Array()) }));
        return reply({
          version: 0, slot, transaction: { signatures: [pendingSignature], message: { accountKeys: compiled.staticAccounts, instructions } },
          meta: finalizedReceipt === 'success' ? simulationMeta
            : { ...simulationMeta, err: 'AccountNotFound', postBalances: [walletBalance - fee], postTokenBalances: preTokens },
        });
      }
      default: assert.fail(`Unexpected JSON-RPC method ${method}`);
    }
  });

  const makeWorker = () => new SolanaLiveWorker({ rpcUrl, wallet }, keyFile, dataDir, 5, async () => {});
  const original = makeWorker();
  await original.initialize();
  assert.equal(original.summary.ready, true);
  assert.equal(original.summary.armed, false);
  assert.throws(() => original.queueTest('readiness-check'), /ready and armed/);
  const conflicting = makeWorker();
  await assert.rejects(() => conflicting.initialize(), /Another Solana worker/);
  original.arm();

  await original.submit({ ...candidate, net: 49_999n });
  await original.submit({ ...candidate, simulationSlot: 70n });
  // This first-leg minimum values the network fee at exactly 5 USDC. Rent stays in its own guards.
  const feeBoundary = { ...candidate, firstMinimum: 320_000n };
  await original.submit({ ...feeBoundary, loan: feeBoundary.loan + 1n });
  assert.match(original.summary.status, /network fee USD cap/);
  assert.equal(simulationCount, 0);
  assert.equal(rawSendCount, 0);
  let releaseSimulation!: () => void;
  holdSimulation = new Promise((resolve) => { releaseSimulation = resolve; });
  const waitForSimulation = new Promise<void>((resolve) => { reachedSimulation = resolve; });
  const disarmedCandidate = original.submit(feeBoundary);
  const reached = await Promise.race([waitForSimulation.then(() => true), disarmedCandidate.then(() => false)]);
  assert.equal(reached, true, original.summary.status);
  original.disarm();
  releaseSimulation();
  await disarmedCandidate;
  holdSimulation = null;
  reachedSimulation = undefined;
  assert.equal(rawSendCount, 0);
  assert.equal(original.summary.armed, false);

  original.arm();
  await original.submit(candidate);
  assert.equal(rawSendCount, 1);
  assert.ok(pendingSignature);
  assert.equal(original.summary.pending, pendingSignature);
  await original.submit(candidate);
  assert.equal(rawSendCount, 1);
  original.stop();

  const restarted = makeWorker();
  await restarted.initialize();
  assert.equal(restarted.summary.armed, true);
  assert.equal(restarted.summary.pending, pendingSignature);
  await restarted.reconcile();
  assert.equal(restarted.summary.pending, pendingSignature);
  finalizedReceipt = 'failed';
  await restarted.reconcile();
  assert.equal(restarted.summary.pending, null);
  assert.equal(restarted.summary.lastOutcome?.status, 'failed');
  assert.equal(restarted.summary.spentFeeLamports, fee);
  assert.equal(restarted.summary.lastOutcome?.walletDebitLamports, fee);

  // A missed signature only expires after the finalized height and history checks agree.
  finalizedReceipt = 'none';
  candidate = testCandidate(wallet, USDC);
  await restarted.submit(candidate);
  assert.equal(rawSendCount, 2);
  assert.equal(restarted.summary.pending, pendingSignature);
  height = 153;
  slot = 201;
  await restarted.reconcile();
  assert.equal(restarted.summary.pending, pendingSignature);
  blockhashValid = false;
  await restarted.reconcile();
  assert.equal(restarted.summary.pending, null);
  assert.equal(restarted.summary.lastOutcome?.status, 'expired');
  assert.equal(restarted.summary.spentFeeLamports, fee);

  // Only the scoped test can accept a bounded network-fee loss, and the actual simulation
  // must still leave one micro-USDC after protecting the loan and account rent.
  slot = 91;
  height = 80;
  blockhashValid = true;
  const testId = 'one-solana-test';
  candidate = { ...testCandidate(wallet, JUPITER), net: -457n, testId };
  await restarted.submit(candidate);
  assert.equal(rawSendCount, 2);
  assert.equal(restarted.queueTest(testId).status, 'queued');
  restarted.recordTestScan(testId, 2);
  assert.equal(restarted.activeTest()?.checked, 2);
  simulationMeta.postTokenBalances = [token(USDC, '1291360', 6), token(WRAPPED_SOL, '90000000', 9)];
  await restarted.submit(candidate);
  assert.equal(rawSendCount, 2);
  assert.equal(restarted.activeTest()?.id, testId);

  simulationMeta.postTokenBalances = [token(USDC, '1291361', 6), token(WRAPPED_SOL, '90000000', 9)];
  await restarted.submit(candidate);
  assert.equal(rawSendCount, 3);
  assert.equal(restarted.summary.test?.status, 'submitted');
  assert.equal(restarted.activeTest(), null);
  restarted.recordTestScan(testId, 2);
  assert.equal(restarted.summary.test?.checked, 4);
  restarted.stop();

  const restartTest = makeWorker();
  await restartTest.initialize();
  assert.equal(restartTest.summary.test?.status, 'submitted');
  assert.equal(restartTest.summary.test?.hash, pendingSignature);
  finalizedReceipt = 'success';
  await restartTest.reconcile();
  assert.equal(restartTest.summary.test?.status, 'landed');
  assert.equal(restartTest.summary.lastOutcome?.netUsdc, -0.000457);
  assert.equal(restartTest.summary.lastOutcome?.walletDebitLamports, fee + rent);
  assert.equal(restartTest.summary.spentFeeLamports, 2 * fee);
  assert.equal(restartTest.queueTest(testId).status, 'landed');
  await restartTest.submit(candidate);
  assert.equal(rawSendCount, 3);
  restartTest.disarm();
  restartTest.stop();

  const afterDisarm = makeWorker();
  await afterDisarm.initialize();
  assert.equal(afterDisarm.summary.armed, false);
  assert.equal(afterDisarm.summary.spentFeeLamports, 2 * fee);
  assert.equal(afterDisarm.summary.test?.status, 'landed');
  afterDisarm.stop();

  await t.test('capped test verifies the exact authorization, simulation, restart, and receipt', async () => {
    const worker = makeWorker();
    await worker.initialize();
    worker.arm();
    const cappedId = 'capped-solana-test';
    candidate = await testLossCandidate(wallet, cappedId, KAMINO);
    const exactCandidate = candidate;
    await worker.submit(candidate);
    assert.equal(rawSendCount, 3);
    assert.equal(worker.queueTest(cappedId, { maximumSwapLossUsdc: 0.02 }).maximumSwapLossUsdc, 0.02);
    assert.throws(() => worker.queueTest(cappedId, { maximumSwapLossUsdc: 0.019999 }), /different swap loss terms/);
    const compiled = getCompiledTransactionMessageDecoder().decode(candidate.transaction.messageBytes);
    const [{ ata: usdcAta }, { ata: wsolAta }] = await Promise.all([createWalletAta(wallet, USDC), createWalletAta(wallet, WRAPPED_SOL)]);
    const usdcIndex = compiled.staticAccounts.indexOf(usdcAta);
    const wsolIndex = compiled.staticAccounts.indexOf(wsolAta);
    const usdc = (amount: string) => token(USDC, amount, 6, usdcIndex);
    const wsol = token(WRAPPED_SOL, '90000000', 9, wsolIndex);
    simulationMeta.preTokenBalances = [usdc('1000000'), wsol];
    simulationMeta.postBalances = [walletBalance - fee];
    simulationMeta.postTokenBalances = [usdc('980000'), wsol];

    const simulationStart = simulationCount;
    await worker.submit({ ...candidate, swapLossGuard: { ...candidate.swapLossGuard!, cap: 19_999n } });
    candidate = await testLossCandidate(wallet, cappedId, KAMINO, -1n);
    await worker.submit(candidate);
    assert.equal(simulationCount, simulationStart);
    candidate = exactCandidate;
    simulationMeta.postTokenBalances = [usdc('979999'), wsol];
    await worker.submit(candidate);
    assert.equal(simulationCount, simulationStart + 1);
    assert.equal(rawSendCount, 3);
    simulationMeta.postTokenBalances = [usdc('980000'), wsol];
    await worker.submit(candidate);
    assert.equal(rawSendCount, 4);
    assert.equal(worker.summary.test?.status, 'submitted');
    const saved = fs.readFileSync(journal, 'utf8');
    const state = JSON.parse(saved);
    assert.equal(state.pending.swapLossGuard.cap, '20000');
    assert.equal(state.pending.minimumNet, '0');
    assert.equal(state.test.maximumSwapLossUsdc, 0.02);
    worker.stop();

    fs.writeFileSync(journal, JSON.stringify({ ...state, test: { ...state.test, maximumSwapLossUsdc: 0.019999 } }));
    const mismatched = makeWorker();
    await assert.rejects(() => mismatched.initialize(), /journal must be valid/);
    fs.writeFileSync(journal, saved);

    const recovered = makeWorker();
    await recovered.initialize();
    assert.equal(recovered.summary.test?.maximumSwapLossUsdc, 0.02);
    assert.equal(recovered.summary.pending, pendingSignature);
    finalizedReceipt = 'success';
    await recovered.reconcile();
    assert.equal(recovered.summary.test?.status, 'landed');
    assert.equal(recovered.summary.lastOutcome?.netUsdc, -0.020458);
    assert.equal(recovered.summary.lastOutcome?.walletDebitLamports, fee);
    await recovered.submit(candidate);
    assert.equal(rawSendCount, 4);

    const overCapId = 'bad-finalized-balance';
    recovered.queueTest(overCapId, { maximumSwapLossUsdc: 0.02 });
    candidate = await testLossCandidate(wallet, overCapId, WRAPPED_SOL);
    await recovered.submit(candidate);
    assert.equal(rawSendCount, 5);
    simulationMeta.postTokenBalances = [usdc('979999'), wsol];
    await recovered.reconcile();
    assert.equal(recovered.summary.lastOutcome?.status, 'invariant-breach');
    assert.equal(recovered.summary.test?.status, 'failed');
    assert.equal(recovered.summary.armed, false);
    recovered.stop();
  });
});
