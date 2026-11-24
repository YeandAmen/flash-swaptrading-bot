import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  address, assertIsBlockhash, assertIsTransactionWithBlockhashLifetime, createKeyPairSignerFromBytes, createSolanaRpc,
  getBase58Encoder, getBase64EncodedWireTransaction, getCompiledTransactionMessageDecoder, getSignatureFromTransaction, signature,
  signTransaction,
  type Address, type Blockhash, type KeyPairSigner, type ReadonlyUint8Array, type Signature,
} from '@solana/kit';
import { activeFlashTest, flashTestView, queueFlashTest, type FlashTest, type FlashTestOptions } from '../network-test.js';
import { writeJson } from '../persistence.js';
import { readPrivateFile, writePrivateFile } from '../private-file.js';
import { LIGHTHOUSE, lighthouseAtaFloor, lighthouseLamports, lighthouseTokenAmount, verifyLighthouseDeployment } from './guard.js';
import { describeSimulationFailure, isJupiterSlippageFailure } from './simulation-error.js';
export { isJupiterSlippageFailure } from './simulation-error.js';
import { DEFAULT_SOLANA_LOAN_USDC, isValidSolanaLoanLimit, MAX_SOLANA_LOAN_UNITS } from './market.js';
import { createWalletAta, JUPITER, KAMINO, MAINNET_GENESIS, SOLANA_PUBLIC_RPC, USDC, WRAPPED_SOL } from './protocol.js';
import {
  matchesSolanaSwapLossBalances, solanaTestMinimums, SOLANA_TEST_MAX_FEE_LAMPORTS,
  type PreparedSolanaCycle, type SolanaRouteDecline, type SolanaScanConfig, type SolanaSwapLossGuard,
} from './scan.js';

const DAILY_FEE_CAP = 2_000_000n;
const NATIVE_RESERVE = 15_000_000n;
const MAX_ATA_RENT = 6_000_000n;
const MAX_TEST_LOAN = 100_000n * 1_000_000n;
const MIN_TEST_RETAINED_USDC = 1n;
const MAX_CANDIDATE_AGE_SLOTS = 8n;
const MIN_BLOCKS_TO_EXPIRY = 5n;
const MAX_BLOCKS_TO_EXPIRY = 160n;
const DAY_MS = 86_400_000;
const LIVE_COMMITMENT = 'confirmed';
const COMPUTE_BUDGET = address('ComputeBudget111111111111111111111111111111');
const LIVE_PROGRAMS = new Set<Address>([
  KAMINO, JUPITER, LIGHTHOUSE, COMPUTE_BUDGET,
  address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
]);
const KAMINO_FLASH_BORROW_TAG = Buffer.from('87e734a70734d4c1', 'hex');
const KAMINO_FLASH_REPAY_TAG = Buffer.from('b97500cb60f5b4ba', 'hex');

type Rpc = ReturnType<typeof createSolanaRpc>;
type AssetBalances = readonly { accountIndex: number; mint: Address; owner?: Address; uiTokenAmount: { amount: string } }[] | null | undefined;
type Balances = {
  fee: bigint | null;
  preBalances?: readonly bigint[] | null;
  postBalances?: readonly bigint[] | null;
  preTokenBalances?: AssetBalances;
  postTokenBalances?: AssetBalances;
};

interface Pending {
  signature: Signature;
  blockhash: Blockhash;
  lastValidBlockHeight: string;
  minContextSlot: string;
  feeLamports: string;
  maximumLamportDebit: string;
  firstMinimum: string;
  loan: string;
  minimumNet: string;
  testId?: string;
  profitOnly?: true;
  minimumLoan?: string;
  swapLossGuard?: Record<keyof SolanaSwapLossGuard, string>;
}
interface Outcome {
  signature: Signature;
  status: 'finalized' | 'failed' | 'expired' | 'invariant-breach';
  at: number;
  slot: number | null;
  feeLamports: number;
  walletDebitLamports: number;
  netUsdc: number | null;
}
interface AutoProfit {
  signature: Signature;
  at: number;
  netUsdc: number;
  slot: number;
}
interface FeeSpend {
  at: number;
  feeLamports: number;
}
interface Journal {
  version: 1;
  wallet: Address;
  armed: boolean;
  pending: Pending | null;
  lastOutcome: Outcome | null;
  lastAutoProfit?: AutoProfit | null;
  fees: FeeSpend[];
  test?: FlashTest;
}

function rpcDeadline() {
  return { abortSignal: AbortSignal.timeout(7_000) };
}

function uint(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) throw new Error('Invalid Solana unsigned integer');
  const result = BigInt(value);
  if (result >= (1n << 64n)) throw new Error('Invalid Solana unsigned integer');
  return result;
}

function naturalInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function decodeLossGuard(value: Pending['swapLossGuard']): SolanaSwapLossGuard | undefined {
  if (value === undefined) return undefined;
  const guard = { cap: uint(value.cap), baselineUsdc: uint(value.baselineUsdc),
    baselineWsol: uint(value.baselineWsol), baselineLamports: uint(value.baselineLamports) };
  if (guard.cap === 0n || guard.baselineUsdc < guard.cap) throw new Error('Invalid Solana swap loss guard');
  return guard;
}

function decodeJournal(text: string, wallet: Address): Journal {
  const state = JSON.parse(text) as Journal;
  if (!state || state.version !== 1 || state.wallet !== wallet || typeof state.armed !== 'boolean' || !Array.isArray(state.fees)
    || state.fees.some((entry) => !naturalInteger(entry?.at) || !naturalInteger(entry.feeLamports))
    || !Object.hasOwn(state, 'pending') || !Object.hasOwn(state, 'lastOutcome')) throw new Error('Invalid Solana live journal');
  if (state.pending !== null) {
    const p = state.pending;
    signature(p.signature);
    assertIsBlockhash(p.blockhash);
    const swapLoss = decodeLossGuard(p.swapLossGuard);
    const fee = uint(p.feeLamports);
    const maximumDebit = uint(p.maximumLamportDebit);
    if (fee === 0n || maximumDebit < fee
      || uint(p.lastValidBlockHeight) === 0n || uint(p.minContextSlot) === 0n
      || uint(p.firstMinimum) === 0n || uint(p.loan) === 0n || (uint(p.minimumNet) === 0n) !== !!swapLoss
      || (swapLoss && (maximumDebit !== fee || fee > SOLANA_TEST_MAX_FEE_LAMPORTS || swapLoss.baselineLamports < NATIVE_RESERVE + fee))) {
      throw new Error('Invalid Solana pending transaction journal');
    }
  }
  if (state.lastOutcome !== null) {
    const o = state.lastOutcome;
    signature(o.signature);
    if (!['finalized', 'failed', 'expired', 'invariant-breach'].includes(o.status) || !naturalInteger(o.at)
      || !(o.slot === null || naturalInteger(o.slot)) || !naturalInteger(o.feeLamports)
      || !naturalInteger(o.walletDebitLamports) || !(o.netUsdc === null || Number.isFinite(o.netUsdc))) {
      throw new Error('Invalid Solana settlement journal');
    }
  }
  if (state.lastAutoProfit != null) {
    const profit = state.lastAutoProfit;
    signature(profit.signature);
    if (!naturalInteger(profit.at) || !naturalInteger(profit.slot) || !Number.isFinite(profit.netUsdc) || profit.netUsdc <= 0) {
      throw new Error('Invalid Solana autonomous profit journal');
    }
  }
  if (state.test !== undefined) {
    const test = state.test;
    if (!test || typeof test.id !== 'string' || !test.id.length || !naturalInteger(test.queuedAt)
      || !naturalInteger(test.expiresAt) || test.expiresAt <= test.queuedAt || !naturalInteger(test.checked)
      || !['queued', 'submitted', 'landed', 'failed', 'expired'].includes(test.status) || typeof test.note !== 'string'
      || (test.status === 'queued' && test.hash !== null)
      || (test.status === 'submitted' && (!state.pending || test.hash !== state.pending.signature
        || test.id !== state.pending.testId))) {
      throw new Error('Invalid Solana flash test journal');
    }
    if (test.hash !== null) signature(test.hash);
    solanaTestMinimums(test);
  }
  if (state.pending?.testId !== undefined && (state.test?.status !== 'submitted' || state.test.id !== state.pending.testId)) {
    throw new Error('Solana pending test does not match the journaled request');
  }
  if (state.pending) {
    const pending = state.pending;
    const limits = solanaTestMinimums(pending.testId ? state.test : undefined);
    if (pending.profitOnly !== (limits.minimumNet === undefined ? undefined : true)
      || pending.minimumLoan !== limits.minimumLoan?.toString()
      || decodeLossGuard(pending.swapLossGuard)?.cap !== limits.maximumSwapLoss
      || (limits.minimumLoan !== undefined && uint(pending.loan) < limits.minimumLoan)
      || (limits.minimumNet !== undefined && uint(pending.minimumNet) !== limits.minimumNet)) {
      throw new Error('Solana pending test does not preserve the requested profit and loan floors');
    }
  }
  return state;
}

function readWallet(pathname: string): Uint8Array {
  try {
    const bytes: unknown = JSON.parse(readPrivateFile(pathname, 2_048));
    if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some((n) => !naturalInteger(n) || n > 255)) {
      throw new Error('Invalid keypair');
    }
    return Uint8Array.from(bytes);
  } catch {
    throw new Error('Solana keypair must be a protected owner-only 64-byte Solana CLI JSON file');
  }
}

function walletToken(balances: AssetBalances, wallet: Address, mint: Address): bigint | null {
  if (!Array.isArray(balances)) return null;
  return balances.reduce((sum: bigint, token) => token.owner === wallet && token.mint === mint
    ? sum + uint(token.uiTokenAmount.amount) : sum, 0n);
}

function nativeCostUsdc(lamports: bigint, loan: bigint, firstMinimum: bigint): bigint {
  return (lamports * loan + firstMinimum - 1n) / firstMinimum;
}

function accountOutcome(meta: Balances, wallet: Address, loan: bigint, firstMinimum: bigint) {
  const beforeUsdc = walletToken(meta.preTokenBalances, wallet, USDC);
  const afterUsdc = walletToken(meta.postTokenBalances, wallet, USDC);
  const beforeWsol = walletToken(meta.preTokenBalances, wallet, WRAPPED_SOL);
  const afterWsol = walletToken(meta.postTokenBalances, wallet, WRAPPED_SOL);
  const beforeNative = meta.preBalances?.[0];
  const afterNative = meta.postBalances?.[0];
  if (beforeNative === undefined || afterNative === undefined || meta.fee == null || meta.fee <= 0n) return null;
  const debit = beforeNative - afterNative;
  const cost = debit > meta.fee ? debit : meta.fee;
  const proceeds = beforeUsdc === null || afterUsdc === null ? null : afterUsdc - beforeUsdc;
  return {
    fee: meta.fee, cost, wsolPreserved: beforeWsol !== null && afterWsol !== null && afterWsol >= beforeWsol,
    net: proceeds === null ? null : proceeds - nativeCostUsdc(cost, loan, firstMinimum),
    retainedBeforeFee: proceeds === null ? null : proceeds - nativeCostUsdc(cost - meta.fee, loan, firstMinimum),
    feeUsdc: nativeCostUsdc(meta.fee, loan, firstMinimum),
  };
}

function meetsOutcomeFloor(outcome: NonNullable<ReturnType<typeof accountOutcome>>, minimum: bigint, gasOnlyTest: boolean): boolean {
  if (outcome.net === null || !outcome.wsolPreserved) return false;
  if (!gasOnlyTest) return outcome.net >= minimum;
  return outcome.retainedBeforeFee !== null && outcome.retainedBeforeFee >= minimum
    && outcome.net >= minimum - outcome.feeUsdc;
}

function matchesKaminoLoan(accounts: readonly Address[], instructions: readonly {
  programAddressIndex: number;
  data?: ReadonlyUint8Array | string;
}[], loan: bigint): boolean {
  const flash = instructions.flatMap((instruction, index) => {
    if (accounts[instruction.programAddressIndex] !== KAMINO || instruction.data === undefined) return [];
    const payload = typeof instruction.data === 'string' ? getBase58Encoder().encode(instruction.data) : instruction.data;
    return [{ index, data: Buffer.from(payload) }];
  });
  if (flash.length !== 2) return false;
  const [borrow, repay] = flash;
  return borrow.data.length === 16 && repay.data.length === 17
    && borrow.data.subarray(0, 8).equals(KAMINO_FLASH_BORROW_TAG)
    && repay.data.subarray(0, 8).equals(KAMINO_FLASH_REPAY_TAG)
    && borrow.data.readBigUInt64LE(8) === loan && repay.data.readBigUInt64LE(8) === loan
    && repay.data[16] === borrow.index;
}

function matchesSwapLossGuards(accounts: readonly Address[], instructions: readonly {
  programAddressIndex: number; accountIndices?: readonly number[]; data?: ReadonlyUint8Array;
}[], wallet: Address, usdcAta: Address, wsolAta: Address, guard: SolanaSwapLossGuard, fee: bigint): boolean {
  const sequence = [COMPUTE_BUDGET, COMPUTE_BUDGET, LIGHTHOUSE, LIGHTHOUSE, KAMINO, JUPITER, JUPITER, KAMINO,
    LIGHTHOUSE, LIGHTHOUSE, LIGHTHOUSE];
  if (instructions.length !== sequence.length
    || instructions.some((ix, index) => accounts[ix.programAddressIndex] !== sequence[index])) return false;
  const nativeFloor = guard.baselineLamports - fee;
  const expected = [lighthouseLamports(wallet, 'equal', nativeFloor), lighthouseTokenAmount(usdcAta, 'equal', guard.baselineUsdc),
    lighthouseAtaFloor(usdcAta, guard.baselineUsdc - guard.cap), lighthouseAtaFloor(wsolAta, guard.baselineWsol),
    lighthouseLamports(wallet, 'atLeast', nativeFloor)];
  return expected.every((ix, index) => {
    const actual = instructions[[2, 3, 8, 9, 10][index]];
    return actual.accountIndices?.length === 1 && accounts[actual.accountIndices[0]] === ix.accounts?.[0].address
      && actual.data !== undefined && Buffer.from(actual.data).equals(Buffer.from(ix.data!));
  });
}

async function walletAtas(wallet: Address): Promise<[Address, Address]> {
  const [usdc, wsol] = await Promise.all([createWalletAta(wallet, USDC), createWalletAta(wallet, WRAPPED_SOL)]);
  return [usdc.ata, wsol.ata];
}

function running(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** Serialize active workers on this local data directory. Process death makes an orphaned lease inactive. */
function acquireLease(directory: string): string {
  const name = `.solana-live-${process.pid}-${randomUUID()}.lock`;
  const file = path.join(directory, name);
  writePrivateFile(file, '');
  try {
    for (const peer of fs.readdirSync(directory)) {
      const match = /^\.solana-live-([1-9]\d*)-[a-f0-9-]+\.lock$/.exec(peer);
      if (peer !== name && match && running(Number(match[1]))) throw new Error('Another Solana worker owns this data directory');
    }
    return file;
  } catch (error) {
    fs.rmSync(file, { force: true });
    throw error;
  }
}

export class SolanaLiveWorker {
  private readonly rpc: Rpc;
  private readonly wallet: Address;
  private readonly journalPath: string;
  private readonly minimumNet: bigint;
  private readonly maximumLoan: bigint;
  private readonly feeCap: bigint;
  private readonly networkFeeCapUsdc: bigint;
  private signer: KeyPairSigner | null = null;
  private journal: Journal | null = null;
  private lease: string | null = null;
  private initializing = false;
  private busy = false;
  private stopped = false;
  private generation = 0;
  private status = 'Initializing Solana live worker';

  constructor(config: SolanaScanConfig, private readonly keyPath: string, private readonly dataDir: string,
    maximumNetworkFeeUsd: number,
    private readonly verifyDeployment = verifyLighthouseDeployment) {
    this.wallet = address(config.wallet);
    const rpcUrl = new URL(config.rpcUrl ?? SOLANA_PUBLIC_RPC);
    if (rpcUrl.protocol !== 'https:' && !(rpcUrl.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(rpcUrl.hostname))) {
      throw new Error('Solana live signing requires an HTTPS or loopback RPC');
    }
    this.rpc = createSolanaRpc(rpcUrl.href);
    this.journalPath = path.join(dataDir, 'solana-live.json');
    const loanLimit = config.loanUsdc ?? DEFAULT_SOLANA_LOAN_USDC;
    if (!isValidSolanaLoanLimit(loanLimit)) {
      throw new Error('Invalid Solana live loan cap');
    }
    this.maximumLoan = loanLimit === Infinity ? MAX_SOLANA_LOAN_UNITS : BigInt(Math.floor(loanLimit * 1_000_000));
    const minimum = config.minNetUsdc ?? 0.05;
    const cap = config.maxFeeLamports ?? 50_000;
    const usdCapInMicroUsdc = Math.floor(maximumNetworkFeeUsd * 1_000_000);
    if (!Number.isFinite(minimum) || minimum < 0.000001 || minimum > 1_000
      || !Number.isSafeInteger(cap) || cap < 5_000 || cap > 5_000_000
      || !Number.isSafeInteger(usdCapInMicroUsdc) || usdCapInMicroUsdc <= 0) {
      throw new Error('Invalid Solana live profit or fee limits');
    }
    this.minimumNet = BigInt(Math.round(minimum * 1_000_000));
    this.feeCap = BigInt(cap);
    this.networkFeeCapUsdc = BigInt(usdCapInMicroUsdc);
  }

  get summary() {
    const pending = this.journal?.pending;
    const ready = !!this.signer && !this.stopped;
    return {
      ready, armed: ready && this.journal?.armed === true, wallet: this.wallet,
      status: this.status, pending: pending?.signature ?? null,
      pendingFeeLamports: pending ? Number(pending.feeLamports) : 0,
      lastOutcome: this.journal?.lastOutcome ?? null, lastAutoProfit: this.journal?.lastAutoProfit ?? null,
      test: flashTestView(this.journal?.test),
      spentFeeLamports: Number(this.spentFees()), dailyFeeCapLamports: Number(DAILY_FEE_CAP),
      nativeReserveLamports: Number(NATIVE_RESERVE), minimumNetUsdc: Number(this.minimumNet) / 1_000_000,
      maxFeeLamports: Number(this.feeCap),
    };
  }

  async initialize(): Promise<void> {
    if (this.signer || this.initializing || this.stopped) return;
    this.initializing = true;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      this.lease = acquireLease(this.dataDir);
      try {
        this.journal = decodeJournal(readPrivateFile(this.journalPath, 128 * 1024), this.wallet);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Solana live journal must be valid and owner-only');
        const next: Journal = { version: 1, wallet: this.wallet, armed: false, pending: null, lastOutcome: null, lastAutoProfit: null, fees: [] };
        writeJson(this.journalPath, next, true);
        this.journal = next;
      }
      const bytes = readWallet(this.keyPath);
      let signer: KeyPairSigner;
      try { signer = await createKeyPairSignerFromBytes(bytes); } finally { bytes.fill(0); }
      if (signer.address !== this.wallet) throw new Error('Solana keypair differs from the configured public wallet');
      const genesis = await this.rpc.getGenesisHash().send(rpcDeadline());
      if (String(genesis) !== MAINNET_GENESIS) throw new Error('Solana live RPC is not connected to mainnet-beta');
      await this.verifyDeployment(this.rpc);
      if (this.stopped) return;
      this.signer = signer;
      this.status = this.journal.armed ? 'Live Solana scanning' : 'Solana live sending disarmed';
    } catch (error) {
      this.releaseLease();
      this.status = 'Solana live initialization failed';
      throw error;
    } finally {
      this.initializing = false;
    }
  }

  arm(): void {
    if (!this.signer || !this.journal || this.stopped) throw new Error('Solana live worker is not ready');
    if (!this.journal.armed) this.save({ ...this.journal, armed: true });
    this.status = this.journal.pending ? 'Solana waiting for finalized receipt' : 'Live Solana scanning';
  }

  queueTest(id: string, options?: FlashTestOptions): FlashTest {
    if (typeof id !== 'string' || !id.length || id.length > 128) throw new Error('Invalid Solana flash test request');
    if (!this.signer || !this.journal?.armed || this.stopped) throw new Error('Solana live worker must be ready and armed');
    const previous = this.journal.test;
    if (this.journal.pending && previous?.id !== id) throw new Error('A Solana transaction is already pending');
    const test = queueFlashTest(previous, id, Date.now(), options, 'solana');
    solanaTestMinimums(test);
    if (test === previous) return flashTestView(test)!;
    this.save({ ...this.journal, test });
    this.generation++;
    return test;
  }

  activeTest(): FlashTest | null {
    if (!this.signer || this.stopped || !this.journal?.armed || this.journal.pending) return null;
    const test = this.journal.test;
    return activeFlashTest(test) ? test : null;
  }

  recordTestScan(id: string, checked = 1): void {
    const test = this.journal?.test;
    if (test?.id === id && this.journal && this.lease && !this.stopped
      && (test.status === 'queued' || test.status === 'submitted') && naturalInteger(checked) && checked > 0) {
      this.save({ ...this.journal, test: { ...test, checked: test.checked + checked } });
    }
  }

  disarm(): void {
    this.generation++;
    this.status = this.journal?.pending ? 'Solana disarmed, reconciling its pending signature' : 'Solana live sending disarmed';
    if (this.journal?.armed && this.lease && !this.stopped) {
      const test = this.journal.test;
      const expired = activeFlashTest(test) ? { ...test, status: 'expired' as const,
        note: 'Solana was disarmed before submission. No test transaction sent.' } : test;
      const next = { ...this.journal, armed: false, test: expired };
      this.journal = next;
      this.save(next);
    }
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    this.signer = null;
    this.releaseLease();
    this.status = 'Solana live worker stopped';
  }

  private releaseLease(): void {
    if (!this.lease) return;
    fs.rmSync(this.lease, { force: true });
    this.lease = null;
  }

  private save(next: Journal): void {
    if (!this.lease || this.stopped) throw new Error('Solana live worker lost its journal lease');
    const normalized = { ...next, fees: next.fees.filter((spend) => spend.at > Date.now() - DAY_MS) };
    writeJson(this.journalPath, normalized);
    this.journal = normalized;
  }

  private spentFees(): bigint {
    return (this.journal?.fees ?? []).filter((spend) => spend.at > Date.now() - DAY_MS)
      .reduce((sum, spend) => sum + BigInt(spend.feeLamports), 0n);
  }

  scanHandoff() {
    const generation = this.generation;
    return async (candidate: PreparedSolanaCycle) => this.generation === generation ? this.submit(candidate) : undefined;
  }

  async submit(candidate: PreparedSolanaCycle): Promise<void | SolanaRouteDecline> {
    if (!this.signer || this.stopped || this.busy || !this.journal?.armed || this.journal.pending) return;
    const test = candidate.testId === undefined ? null : this.activeTest();
    if (candidate.testId !== undefined && test?.id !== candidate.testId) return;
    const limits = solanaTestMinimums(test);
    const gasOnlyTest = !!test && limits.minimumNet === undefined;
    const lossGuard = candidate.swapLossGuard;
    const minimum = limits.maximumSwapLoss !== undefined ? -limits.maximumSwapLoss
      : gasOnlyTest ? MIN_TEST_RETAINED_USDC : limits.minimumNet ?? this.minimumNet;
    this.busy = true;
    const generation = this.generation;
    const canSend = () => !this.stopped && generation === this.generation && this.journal?.armed && !this.journal.pending
      && (test ? this.activeTest()?.id === test.id : !this.activeTest());
    const decline = (): SolanaRouteDecline | undefined => test || !canSend() ? undefined : {
      status: 'route-declined',
      canTryAlternate: () => !this.busy && Boolean(canSend()),
    };
    try {
      if (!canSend()) return;
      if (typeof candidate.loan !== 'bigint' || candidate.loan <= 0n
        || candidate.loan > (test ? MAX_TEST_LOAN : this.maximumLoan)) {
        this.status = 'Solana candidate skipped by loan size limit';
        return;
      }
      if (candidate.feeLamports <= 0n || candidate.feeLamports > this.feeCap || (test && candidate.feeLamports > SOLANA_TEST_MAX_FEE_LAMPORTS)
        || candidate.rentLamports < 0n || candidate.rentLamports > MAX_ATA_RENT || candidate.firstMinimum <= 0n
        || candidate.maximumLamportDebit !== candidate.feeLamports + candidate.rentLamports
        || (limits.minimumLoan !== undefined && candidate.loan < limits.minimumLoan)
        || lossGuard?.cap !== limits.maximumSwapLoss
        || (lossGuard && (candidate.rentLamports !== 0n || lossGuard.baselineUsdc < lossGuard.cap
          || lossGuard.baselineLamports < NATIVE_RESERVE + candidate.feeLamports))
        || this.spentFees() + candidate.feeLamports > DAILY_FEE_CAP) {
        this.status = 'Solana candidate skipped by profit or fee budget';
        return;
      }
      // Use guaranteed first-leg output for the conservative USDC value of base and priority fees.
      // The simulated fee must match this exact quote. Account rent is checked separately.
      const feeUsdc = nativeCostUsdc(candidate.feeLamports, candidate.loan, candidate.firstMinimum);
      if (feeUsdc > this.networkFeeCapUsdc) {
        this.status = 'Solana candidate skipped by network fee USD cap';
        return;
      }
      const allowedLoss = gasOnlyTest ? feeUsdc : 0n;
      if (candidate.net < minimum - allowedLoss) {
        this.status = 'Solana candidate skipped by profit or fee budget';
        return;
      }
      const unsigned = candidate.transaction;
      assertIsTransactionWithBlockhashLifetime(unsigned);
      const compiled = getCompiledTransactionMessageDecoder().decode(unsigned.messageBytes);
      if (compiled.version !== 0 || compiled.header.numSignerAccounts !== 1 || compiled.staticAccounts[0] !== this.wallet
        || Object.keys(unsigned.signatures).length !== 1 || unsigned.signatures[this.wallet] !== null
        || unsigned.lifetimeConstraint.lastValidBlockHeight !== candidate.lastValidBlockHeight
        || compiled.lifetimeToken !== unsigned.lifetimeConstraint.blockhash) {
        this.status = 'Solana candidate rejected for unexpected signer or lifetime';
        return;
      }
      const programs = compiled.instructions.map((ix) => compiled.staticAccounts[ix.programAddressIndex]);
      const cycle = programs.filter((program) => program === KAMINO || program === JUPITER);
      const atas = lossGuard ? await walletAtas(this.wallet) : null;
      if (programs.some((program) => !LIVE_PROGRAMS.has(program)) || cycle.length !== 4
        || cycle[0] !== KAMINO || cycle[1] !== JUPITER || cycle[2] !== JUPITER || cycle[3] !== KAMINO
        || programs.filter((program) => program === LIGHTHOUSE).length < 4 || programs.at(-1) !== LIGHTHOUSE
        || !matchesKaminoLoan(compiled.staticAccounts, compiled.instructions, candidate.loan)
        || (lossGuard && atas && !matchesSwapLossGuards(compiled.staticAccounts, compiled.instructions,
          this.wallet, ...atas, lossGuard, candidate.feeLamports))) {
        this.status = 'Solana candidate is missing complete swap or profit assertions';
        return;
      }
      const { blockhash } = unsigned.lifetimeConstraint;
      const [head, { value: balance }, { value: valid }] = await Promise.all([
        this.rpc.getEpochInfo({ commitment: LIVE_COMMITMENT, minContextSlot: candidate.simulationSlot }).send(rpcDeadline()),
        this.rpc.getBalance(this.wallet, { commitment: LIVE_COMMITMENT, minContextSlot: candidate.simulationSlot }).send(rpcDeadline()),
        this.rpc.isBlockhashValid(blockhash, { commitment: LIVE_COMMITMENT, minContextSlot: candidate.simulationSlot }).send(rpcDeadline()),
      ]);
      const blocksToExpiry = candidate.lastValidBlockHeight - head.blockHeight;
      if (!canSend()) return;
      if (blocksToExpiry > MAX_BLOCKS_TO_EXPIRY || head.absoluteSlot < candidate.simulationSlot
        || balance < NATIVE_RESERVE + candidate.maximumLamportDebit) {
        this.status = 'Solana candidate stale or wallet below its native reserve';
        return;
      }
      if (!valid || blocksToExpiry < MIN_BLOCKS_TO_EXPIRY || head.absoluteSlot - candidate.simulationSlot > MAX_CANDIDATE_AGE_SLOTS) {
        this.status = 'Solana candidate stale before final simulation';
        return decline();
      }

      const { value: simulation, context } = await this.rpc.simulateTransaction(getBase64EncodedWireTransaction(unsigned), {
        encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false,
        minContextSlot: head.absoluteSlot, commitment: LIVE_COMMITMENT,
      }).send(rpcDeadline());
      if (!canSend()) return;
      if (!test && context.slot >= head.absoluteSlot && context.slot - candidate.simulationSlot <= MAX_CANDIDATE_AGE_SLOTS
        && isJupiterSlippageFailure(simulation.err, simulation.logs, programs)) {
        this.status = 'Jupiter slippage limit exceeded in final Solana simulation';
        return decline();
      }
      const measured = simulation.err ? null : accountOutcome(simulation, this.wallet, candidate.loan, candidate.firstMinimum);
      if (context.slot < head.absoluteSlot || !measured || measured.net === null || !measured.wsolPreserved
        || measured.fee !== candidate.feeLamports || measured.cost > candidate.maximumLamportDebit
        || (simulation.postBalances?.[0] ?? 0n) < NATIVE_RESERVE
        || (lossGuard && atas && !matchesSolanaSwapLossBalances(simulation, compiled.staticAccounts,
          this.wallet, ...atas, lossGuard, measured.fee))) {
        this.status = 'Solana final simulation did not satisfy the profit and cost guards';
        const failure = simulation.err && describeSimulationFailure(simulation.err, simulation.logs, programs);
        if (failure?.origin) this.status += `. ${failure.detail}`;
        return;
      }
      if (context.slot - candidate.simulationSlot > MAX_CANDIDATE_AGE_SLOTS || !meetsOutcomeFloor(measured, minimum, gasOnlyTest)) {
        this.status = 'Solana final simulation did not satisfy the profit and cost guards';
        return decline();
      }
      const signer = this.signer;
      if (!signer) return;
      const signed = await signTransaction([signer.keyPair], unsigned);
      if (!canSend()) return;
      const wire = getBase64EncodedWireTransaction(signed);
      const sig = getSignatureFromTransaction(signed);
      if (this.journal.lastOutcome?.signature === sig) return;
      const queued = this.journal.test;
      const submitted = test && queued
        ? { ...queued, status: 'submitted' as const, hash: sig, note: 'Submitted once. Waiting for a finalized receipt.' } : queued;
      const pending: Pending = {
        signature: sig, blockhash, lastValidBlockHeight: candidate.lastValidBlockHeight.toString(),
        minContextSlot: context.slot.toString(), feeLamports: candidate.feeLamports.toString(),
        maximumLamportDebit: candidate.maximumLamportDebit.toString(),
        firstMinimum: candidate.firstMinimum.toString(), loan: candidate.loan.toString(), minimumNet: lossGuard ? '0' : minimum.toString(),
        testId: test?.id, profitOnly: limits.minimumNet === undefined ? undefined : true,
        minimumLoan: limits.minimumLoan?.toString(),
        ...(lossGuard ? { swapLossGuard: { cap: lossGuard.cap.toString(), baselineUsdc: lossGuard.baselineUsdc.toString(),
          baselineWsol: lossGuard.baselineWsol.toString(), baselineLamports: lossGuard.baselineLamports.toString() } } : {}),
      };
      // Persist the exact signature before contacting a sender. Uncertain sends stay pending.
      this.save({ ...this.journal, pending, test: submitted });
      this.status = 'Solana awaiting RPC submission';
      const acknowledged = await this.rpc.sendTransaction(wire, {
        encoding: 'base64', skipPreflight: false, preflightCommitment: LIVE_COMMITMENT,
        minContextSlot: context.slot, maxRetries: 0n,
      }).send(rpcDeadline());
      if (!this.stopped) this.status = acknowledged === sig
        ? 'Solana waiting for finalized receipt' : 'Solana RPC acknowledgment differs from the journaled signature';
    } catch {
      if (!this.stopped) this.status = this.journal?.pending
        ? 'Solana submission uncertain, checking the journaled signature'
        : 'Solana candidate halted before submission';
    } finally {
      this.busy = false;
    }
  }

  async reconcile(): Promise<void> {
    if (this.stopped || this.busy || !this.lease || !this.journal?.pending) return;
    this.busy = true;
    const pending = this.journal.pending;
    const minContextSlot = uint(pending.minContextSlot);
    try {
      const first = await this.signatureStatus(pending.signature);
      if (first.value[0]?.confirmationStatus === 'finalized') {
        const receipt = await this.finalizedReceipt(pending.signature);
        if (receipt) await this.settleReceipt(pending, receipt);
        return;
      }
      const finalized = await this.rpc.getEpochInfo({ commitment: 'finalized', minContextSlot }).send(rpcDeadline());
      if (finalized.blockHeight <= uint(pending.lastValidBlockHeight) + 2n) return;
      const [history, validity, receipt] = await Promise.all([
        this.signatureStatus(pending.signature),
        this.rpc.isBlockhashValid(pending.blockhash, { commitment: 'finalized', minContextSlot: finalized.absoluteSlot }).send(rpcDeadline()),
        this.finalizedReceipt(pending.signature),
      ]);
      if (receipt) {
        await this.settleReceipt(pending, receipt);
      } else if (history.value[0] === null && !validity.value
        && history.context.slot >= finalized.absoluteSlot && validity.context.slot >= finalized.absoluteSlot) {
        this.finish(pending, { signature: pending.signature, status: 'expired', at: Date.now(), slot: null,
          feeLamports: 0, walletDebitLamports: 0, netUsdc: null });
      }
    } catch {
      if (!this.stopped) this.status = 'Solana receipt lookup unavailable, retaining pending signature';
    } finally {
      this.busy = false;
    }
  }

  private signatureStatus(sig: Signature) {
    return this.rpc.getSignatureStatuses([sig], { searchTransactionHistory: true }).send(rpcDeadline());
  }

  private finalizedReceipt(sig: Signature) {
    return this.rpc.getTransaction(sig, { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 0 }).send(rpcDeadline());
  }

  private async settleReceipt(pending: Pending, receipt: NonNullable<Awaited<ReturnType<SolanaLiveWorker['finalizedReceipt']>>>): Promise<void> {
    const meta = receipt.meta;
    if (!meta || receipt.version !== 0 || receipt.slot < uint(pending.minContextSlot)
      || receipt.transaction.signatures[0] !== pending.signature || receipt.transaction.message.accountKeys[0] !== this.wallet) {
      throw new Error('Solana finalized receipt did not match the journal');
    }
    const measured = accountOutcome(meta, this.wallet, uint(pending.loan), uint(pending.firstMinimum));
    if (!measured || (!meta.err && measured.net === null)) throw new Error('Solana finalized receipt omitted wallet changes');
    const loan = uint(pending.loan);
    const message = receipt.transaction.message;
    const lossGuard = decodeLossGuard(pending.swapLossGuard);
    const minimum = lossGuard ? -lossGuard.cap : uint(pending.minimumNet);
    const verifiedLoan = matchesKaminoLoan(message.accountKeys,
      message.instructions.map((ix) => ({ data: ix.data, programAddressIndex: Number(ix.programIdIndex) })), loan);
    const wrongLoan = (pending.profitOnly || lossGuard) && !verifiedLoan;
    const wrongBalance = lossGuard && !meta.err && !matchesSolanaSwapLossBalances(meta, message.accountKeys,
      this.wallet, ...await walletAtas(this.wallet), lossGuard, measured.fee);
    const breached = wrongLoan || wrongBalance || measured.fee !== uint(pending.feeLamports) || measured.cost > uint(pending.maximumLamportDebit)
      || (!meta.err && !meetsOutcomeFloor(measured, minimum, pending.testId !== undefined && !pending.profitOnly));
    const status = breached ? 'invariant-breach' : meta.err ? 'failed' : 'finalized';
    this.finish(pending, { signature: pending.signature, status, at: Date.now(), slot: Number(receipt.slot),
      feeLamports: Number(measured.fee), walletDebitLamports: Number(measured.cost),
      netUsdc: measured.net === null ? null : Number(measured.net) / 1_000_000 }, verifiedLoan);
  }

  private finish(pending: Pending, outcome: Outcome, verifiedLoan = false): void {
    if (this.stopped || !this.journal || this.journal.pending?.signature !== pending.signature) return;
    const fees = outcome.feeLamports > 0 ? [...this.journal.fees, { at: outcome.at, feeLamports: outcome.feeLamports }] : this.journal.fees;
    let test = this.journal.test;
    if (test && pending.testId === test.id) {
      const status = outcome.status === 'finalized' ? 'landed' : outcome.status === 'expired' ? 'expired' : 'failed';
      const note = status === 'landed' ? (pending.profitOnly
        ? 'Finalized. The requested after-fee profit and loan size were verified.'
        : pending.swapLossGuard ? 'Finalized. Flash loan repayment and the approved USDC swap loss cap were verified.'
          : 'Finalized. The flash loan and rent were covered by the swaps.')
        : status === 'expired' ? 'Signature expired without landing. No transaction fee was charged.'
          : outcome.status === 'invariant-breach' ? 'Receipt did not satisfy the wallet protection checks. Solana was disarmed.'
            : 'The test reverted. Check the finalized fee and transaction receipt.';
      test = { ...test, status, note };
    }
    const { signature, at, netUsdc, slot } = outcome;
    const lastAutoProfit = verifiedLoan && pending.testId === undefined && this.journal.test?.hash !== signature
      && outcome.status === 'finalized' && netUsdc !== null && netUsdc > 0 && slot !== null
      ? { signature, at, netUsdc, slot } : this.journal.lastAutoProfit ?? null;
    this.save({ ...this.journal, armed: this.journal.armed && outcome.status !== 'invariant-breach',
      pending: null, lastOutcome: outcome, lastAutoProfit, fees, test });
    this.status = `Solana transaction ${outcome.status}`;
  }
}
