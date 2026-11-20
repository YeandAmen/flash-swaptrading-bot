import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  appendTransactionMessageInstructions, assertIsBlockhash, compileTransaction, createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage, getSignatureFromTransaction, getTransactionDecoder,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  type Address,
} from '@solana/kit';
import { writePrivateFile } from '../private-file.js';
import { LIGHTHOUSE } from './guard.js';
import { JUPITER, KAMINO, MAINNET_GENESIS, USDC, WRAPPED_SOL } from './protocol.js';
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
  const token = (mint: Address, amount: string, decimals: number) => ({
    accountIndex: 1, mint, owner: wallet, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
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
      case 'getTransaction':
        // Kit omits the protocol's default commitment from the getTransaction request.
        assert.equal(params[1].commitment ?? 'finalized', 'finalized');
        if (finalizedReceipt === 'none') return reply(null);
        return reply({
          version: 0, slot, transaction: { signatures: [pendingSignature], message: { accountKeys: [wallet] } },
          meta: finalizedReceipt === 'success' ? simulationMeta
            : { ...simulationMeta, err: 'AccountNotFound', postBalances: [walletBalance - fee], postTokenBalances: preTokens },
        });
      default: assert.fail(`Unexpected JSON-RPC method ${method}`);
    }
  });

  const makeWorker = () => new SolanaLiveWorker({ rpcUrl, wallet }, keyFile, dataDir, async () => {});
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
  assert.equal(simulationCount, 0);
  assert.equal(rawSendCount, 0);
  let releaseSimulation!: () => void;
  holdSimulation = new Promise((resolve) => { releaseSimulation = resolve; });
  const waitForSimulation = new Promise<void>((resolve) => { reachedSimulation = resolve; });
  const disarmedCandidate = original.submit(candidate);
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
});
