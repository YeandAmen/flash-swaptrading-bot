import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  address, assertIsBlockhash, assertIsTransactionWithBlockhashLifetime, createKeyPairSignerFromBytes, createSolanaRpc,
  getBase64EncodedWireTransaction, getCompiledTransactionMessageDecoder, getSignatureFromTransaction, signature,
  signTransaction,
  type Address, type Blockhash, type KeyPairSigner, type Signature,
} from '@solana/kit';
import { writeJson } from '../persistence.js';
import { readPrivateFile, writePrivateFile } from '../private-file.js';
import { LIGHTHOUSE, verifyLighthouseDeployment } from './guard.js';
import { JUPITER, KAMINO, MAINNET_GENESIS, SOLANA_PUBLIC_RPC, USDC, WRAPPED_SOL } from './protocol.js';
import type { PreparedSolanaCycle, SolanaScanConfig } from './scan.js';

const DAILY_FEE_CAP = 2_000_000n;
const NATIVE_RESERVE = 15_000_000n;
const MAX_ATA_RENT = 6_000_000n;
const MAX_CANDIDATE_AGE_SLOTS = 8n;
const MIN_BLOCKS_TO_EXPIRY = 5n;
const MAX_BLOCKS_TO_EXPIRY = 160n;
const DAY_MS = 86_400_000;
const LIVE_COMMITMENT = 'confirmed';

type Rpc = ReturnType<typeof createSolanaRpc>;
type AssetBalances = readonly { mint: Address; owner?: Address; uiTokenAmount: { amount: string } }[] | null | undefined;
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
  fees: FeeSpend[];
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

function decodeJournal(text: string, wallet: Address): Journal {
  const state = JSON.parse(text) as Journal;
  if (!state || state.version !== 1 || state.wallet !== wallet || typeof state.armed !== 'boolean' || !Array.isArray(state.fees)
    || state.fees.some((entry) => !naturalInteger(entry?.at) || !naturalInteger(entry.feeLamports))
    || !Object.hasOwn(state, 'pending') || !Object.hasOwn(state, 'lastOutcome')) throw new Error('Invalid Solana live journal');
  if (state.pending !== null) {
    const p = state.pending;
    signature(p.signature);
    assertIsBlockhash(p.blockhash);
    if (uint(p.feeLamports) === 0n || uint(p.maximumLamportDebit) < uint(p.feeLamports)
      || uint(p.lastValidBlockHeight) === 0n || uint(p.minContextSlot) === 0n
      || uint(p.firstMinimum) === 0n || uint(p.loan) === 0n || uint(p.minimumNet) === 0n) {
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
  const networkUsdc = (cost * loan + firstMinimum - 1n) / firstMinimum;
  return {
    fee: meta.fee, cost, wsolPreserved: beforeWsol !== null && afterWsol !== null && afterWsol >= beforeWsol,
    net: beforeUsdc === null || afterUsdc === null ? null : afterUsdc - beforeUsdc - networkUsdc,
  };
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
  private readonly feeCap: bigint;
  private signer: KeyPairSigner | null = null;
  private journal: Journal | null = null;
  private lease: string | null = null;
  private initializing = false;
  private busy = false;
  private stopped = false;
  private generation = 0;
  private status = 'Initializing Solana live worker';

  constructor(config: SolanaScanConfig, private readonly keyPath: string, private readonly dataDir: string,
    private readonly verifyDeployment = verifyLighthouseDeployment) {
    this.wallet = address(config.wallet);
    const rpcUrl = new URL(config.rpcUrl ?? SOLANA_PUBLIC_RPC);
    if (rpcUrl.protocol !== 'https:' && !(rpcUrl.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(rpcUrl.hostname))) {
      throw new Error('Solana live signing requires an HTTPS or loopback RPC');
    }
    this.rpc = createSolanaRpc(rpcUrl.href);
    this.journalPath = path.join(dataDir, 'solana-live.json');
    const minimum = config.minNetUsdc ?? 0.05;
    const cap = config.maxFeeLamports ?? 50_000;
    if (!Number.isFinite(minimum) || minimum < 0.000001 || minimum > 1_000
      || !Number.isSafeInteger(cap) || cap < 5_000 || cap > 5_000_000) {
      throw new Error('Invalid Solana live profit or fee limits');
    }
    this.minimumNet = BigInt(Math.round(minimum * 1_000_000));
    this.feeCap = BigInt(cap);
  }

  get summary() {
    const pending = this.journal?.pending;
    const ready = !!this.signer && !this.stopped;
    return {
      ready, armed: ready && this.journal?.armed === true, wallet: this.wallet,
      status: this.status, pending: pending?.signature ?? null,
      lastOutcome: this.journal?.lastOutcome ?? null,
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
        const next: Journal = { version: 1, wallet: this.wallet, armed: false, pending: null, lastOutcome: null, fees: [] };
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

  disarm(): void {
    this.generation++;
    this.status = this.journal?.pending ? 'Solana disarmed, reconciling its pending signature' : 'Solana live sending disarmed';
    if (this.journal?.armed && this.lease && !this.stopped) {
      const next = { ...this.journal, armed: false };
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

  async submit(candidate: PreparedSolanaCycle): Promise<void> {
    if (!this.signer || this.stopped || this.busy || !this.journal?.armed || this.journal.pending) return;
    this.busy = true;
    const generation = this.generation;
    const canSend = () => !this.stopped && generation === this.generation && this.journal?.armed && !this.journal.pending;
    try {
      if (candidate.net < this.minimumNet || candidate.feeLamports <= 0n || candidate.feeLamports > this.feeCap
        || candidate.rentLamports < 0n || candidate.rentLamports > MAX_ATA_RENT || candidate.firstMinimum <= 0n || candidate.loan <= 0n
        || candidate.maximumLamportDebit !== candidate.feeLamports + candidate.rentLamports
        || this.spentFees() + candidate.feeLamports > DAILY_FEE_CAP) {
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
      if (programs.filter((program) => program === KAMINO).length !== 2
        || programs.filter((program) => program === JUPITER).length !== 2
        || programs.filter((program) => program === LIGHTHOUSE).length < 4 || programs.at(-1) !== LIGHTHOUSE) {
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
      if (!valid || blocksToExpiry < MIN_BLOCKS_TO_EXPIRY || blocksToExpiry > MAX_BLOCKS_TO_EXPIRY
        || head.absoluteSlot < candidate.simulationSlot || head.absoluteSlot - candidate.simulationSlot > MAX_CANDIDATE_AGE_SLOTS
        || balance < NATIVE_RESERVE + candidate.maximumLamportDebit) {
        this.status = 'Solana candidate stale or wallet below its native reserve';
        return;
      }

      const { value: simulation, context } = await this.rpc.simulateTransaction(getBase64EncodedWireTransaction(unsigned), {
        encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false,
        minContextSlot: head.absoluteSlot, commitment: LIVE_COMMITMENT,
      }).send(rpcDeadline());
      if (!canSend()) return;
      const measured = simulation.err ? null : accountOutcome(simulation, this.wallet, candidate.loan, candidate.firstMinimum);
      if (context.slot < head.absoluteSlot || context.slot - candidate.simulationSlot > MAX_CANDIDATE_AGE_SLOTS
        || !measured || measured.fee !== candidate.feeLamports || measured.cost > candidate.maximumLamportDebit
        || !measured.wsolPreserved || measured.net === null || measured.net < this.minimumNet) {
        this.status = 'Solana final simulation did not satisfy the profit and cost guards';
        return;
      }
      const signer = this.signer;
      if (!signer) return;
      const signed = await signTransaction([signer.keyPair], unsigned);
      if (!canSend()) return;
      const wire = getBase64EncodedWireTransaction(signed);
      const sig = getSignatureFromTransaction(signed);
      const pending: Pending = {
        signature: sig, blockhash, lastValidBlockHeight: candidate.lastValidBlockHeight.toString(),
        minContextSlot: context.slot.toString(), feeLamports: candidate.feeLamports.toString(),
        maximumLamportDebit: candidate.maximumLamportDebit.toString(),
        firstMinimum: candidate.firstMinimum.toString(), loan: candidate.loan.toString(), minimumNet: this.minimumNet.toString(),
      };
      // Persist the exact signature before contacting a sender. Uncertain sends stay pending.
      this.save({ ...this.journal, pending });
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
        if (receipt) this.settleReceipt(pending, receipt);
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
        this.settleReceipt(pending, receipt);
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

  private settleReceipt(pending: Pending, receipt: NonNullable<Awaited<ReturnType<SolanaLiveWorker['finalizedReceipt']>>>): void {
    const meta = receipt.meta;
    if (!meta || receipt.version !== 0 || receipt.slot < uint(pending.minContextSlot)
      || receipt.transaction.signatures[0] !== pending.signature || receipt.transaction.message.accountKeys[0] !== this.wallet) {
      throw new Error('Solana finalized receipt did not match the journal');
    }
    const measured = accountOutcome(meta, this.wallet, uint(pending.loan), uint(pending.firstMinimum));
    if (!measured || (!meta.err && measured.net === null)) throw new Error('Solana finalized receipt omitted wallet changes');
    const breached = measured.fee !== uint(pending.feeLamports) || measured.cost > uint(pending.maximumLamportDebit)
      || (!meta.err && (!measured.wsolPreserved || measured.net! < uint(pending.minimumNet)));
    const status = breached ? 'invariant-breach' : meta.err ? 'failed' : 'finalized';
    this.finish(pending, { signature: pending.signature, status, at: Date.now(), slot: Number(receipt.slot),
      feeLamports: Number(measured.fee), walletDebitLamports: Number(measured.cost),
      netUsdc: measured.net === null ? null : Number(measured.net) / 1_000_000 });
  }

  private finish(pending: Pending, outcome: Outcome): void {
    if (this.stopped || !this.journal || this.journal.pending?.signature !== pending.signature) return;
    const fees = outcome.feeLamports > 0 ? [...this.journal.fees, { at: outcome.at, feeLamports: outcome.feeLamports }] : this.journal.fees;
    this.save({ ...this.journal, armed: this.journal.armed && outcome.status !== 'invariant-breach',
      pending: null, lastOutcome: outcome, fees });
    this.status = `Solana transaction ${outcome.status}`;
  }
}
