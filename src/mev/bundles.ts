import fs from 'node:fs';
import path from 'node:path';
import { keccak256, stringToHex, toHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { CONFIG, DATA_DIR, MEV } from '../config.js';
import { publicClient } from '../chain.js';
import type { BuilderTraceStatus } from './builder-trace.js';

const FLASHBOTS_RELAY = 'https://relay.flashbots.net';
const AUTH_FILE = path.join(DATA_DIR, 'flashbots-auth.key');
let auth: PrivateKeyAccount | null = null;

/**
 * Flashbots "searcher reputation" key. It only signs relay requests (builders use it to rate senders);
 * it never holds or controls any funds. Created once, kept in data/.
 */
function authSigner(): PrivateKeyAccount {
  if (auth) return auth;
  let key = '';
  try { key = fs.readFileSync(AUTH_FILE, 'utf8').trim(); } catch { /* first use */ }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    key = generatePrivateKey();
    fs.writeFileSync(AUTH_FILE, key + '\n', { mode: 0o600 });
  }
  auth = privateKeyToAccount(key as Hex);
  return auth;
}

export interface BuilderResult {
  builder: string;
  ok: boolean;
  detail: string;
  elapsedMs: number;
  bundleHash?: Hex;
  traceStatus?: BuilderTraceStatus;
}

/** Retain only structured acknowledgements and error codes supplied by the relay. */
export function parseBuilderReply(value: unknown): Pick<BuilderResult, 'ok' | 'detail' | 'bundleHash'> {
  if (!value || typeof value !== 'object') return { ok: false, detail: 'no valid bundle acknowledgement' };
  const reply = value as { jsonrpc?: unknown; id?: unknown; error?: { code?: unknown }; result?: { bundleHash?: unknown } };
  const hash = reply.result?.bundleHash;
  if (reply.jsonrpc === '2.0' && (reply.id === 1 || reply.id === '1') && !reply.error && typeof hash === 'string' && /^0x[0-9a-f]{64}$/i.test(hash)) {
    return { ok: true, detail: 'acknowledged', bundleHash: hash as Hex };
  }
  const code = reply.error?.code;
  return typeof code === 'number' && Number.isSafeInteger(code)
    ? { ok: false, detail: `JSON-RPC error ${code}` }
    : { ok: false, detail: 'no valid bundle acknowledgement' };
}

/**
 * Ask each builder to include the bundle for one target block, with no permitted reverts. The caller checks settlement
 * independently by transaction hash. The local fork uses raw transactions to exercise the contract and settlement path.
 */
export async function sendBundle(signedTxs: Hex[], targetBlock: bigint, canSend: () => boolean): Promise<BuilderResult[]> {
  const allowed = () => (CONFIG.allowLiveTrading || CONFIG.forkMode) && canSend();
  if (!allowed()) return [];
  if (CONFIG.forkMode) {
    const out: BuilderResult[] = [];
    for (const tx of signedTxs) {
      if (!allowed()) break;
      const started = performance.now();
      try {
        await publicClient.request({ method: 'eth_sendRawTransaction', params: [tx] });
        out.push({ builder: 'fork', ok: true, detail: 'acknowledged', elapsedMs: Math.round(performance.now() - started) });
      } catch {
        out.push({ builder: 'fork', ok: false, detail: 'local submission outcome unknown', elapsedMs: Math.round(performance.now() - started) });
      }
    }
    return out;
  }
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendBundle', params: [{ txs: signedTxs, blockNumber: toHex(targetBlock) }] });
  const builders = MEV.builders.map((url) => ({ url, builder: new URL(url).hostname }));
  const unsignedHeaders = { 'content-type': 'application/json' };
  let signedHeaders: Record<string, string> | null = null;
  if (builders.some(({ builder }) => builder !== 'rpc.beaverbuild.org')) {
    try {
      const signer = authSigner();
      // Flashbots auth: EIP-191 signature of the hex string of keccak256(body), sent as "address:signature".
      const signature = await signer.signMessage({ message: keccak256(stringToHex(body)) });
      signedHeaders = { ...unsignedHeaders, 'x-flashbots-signature': `${signer.address}:${signature}` };
    } catch { /* Beaverbuild and Quasar support unsigned submissions. */ }
  }
  if (!allowed()) return [];
  if (!signedHeaders && !builders.some(({ builder }) => builder === 'rpc.beaverbuild.org' || builder === 'rpc.quasar.win')) return [];
  return Promise.all(builders.map(async ({ url, builder }): Promise<BuilderResult> => {
    const headers = builder === 'rpc.beaverbuild.org' ? unsignedHeaders : signedHeaders ?? (builder === 'rpc.quasar.win' ? unsignedHeaders : null);
    if (!headers) return { builder, ok: false, detail: 'local builder signature unavailable', elapsedMs: 0 };
    const started = performance.now();
    const signal = AbortSignal.timeout(4_000);
    const elapsedMs = () => Math.round(performance.now() - started);
    try {
      const res = await fetch(url, { method: 'POST', redirect: 'error', headers, body, signal });
      if (!res.ok) return { builder, ok: false, detail: `HTTP ${res.status}`, elapsedMs: elapsedMs() };
      const reply: unknown = await res.json();
      return { builder, ...parseBuilderReply(reply), elapsedMs: elapsedMs() };
    } catch (error) {
      const detail = signal.aborted ? 'submission timed out' : error instanceof SyntaxError ? 'invalid JSON response' : 'network error';
      return { builder, ok: false, detail, elapsedMs: elapsedMs() };
    }
  }));
}

/** Route one transaction through private endpoints that honor its block deadline. */
export async function submitPrivateDirect(signed: Hex, maxBlock: bigint, canSend: () => boolean = () => true): Promise<Hex> {
  const allowed = () => (CONFIG.allowLiveTrading || CONFIG.forkMode) && canSend();
  if (maxBlock <= 0n) throw new Error('A private transaction needs a positive block deadline');
  if (!allowed()) throw new Error('Private transaction canceled before submission');
  const expected = keccak256(signed);
  if (CONFIG.forkMode) {
    const result = await publicClient.request({ method: 'eth_sendRawTransaction', params: [signed] });
    if (typeof result !== 'string' || result.toLowerCase() !== expected) {
      throw new Error('The private transaction acknowledgement did not match its signed hash');
    }
    return expected;
  }

  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'eth_sendPrivateTransaction',
    params: [{ tx: signed, maxBlockNumber: toHex(maxBlock), preferences: { fast: true } }],
  });
  const signer = authSigner();
  const signature = await signer.signMessage({ message: keccak256(stringToHex(body)) });
  if (!allowed()) throw new Error('Private transaction canceled before submission');
  const headers = { 'content-type': 'application/json' };
  const send = async (url: string, requestHeaders: Record<string, string>) => {
    const response = await fetch(url, {
      method: 'POST', redirect: 'error', headers: requestHeaders, body, signal: AbortSignal.timeout(3_500),
    });
    if (!response.ok) throw new Error('HTTP response rejected');
    const reply = await response.json() as { jsonrpc?: unknown; id?: unknown; error?: unknown; result?: unknown } | null;
    if (reply?.jsonrpc !== '2.0' || (reply.id !== 1 && reply.id !== '1') || reply.error
      || typeof reply.result !== 'string' || reply.result.toLowerCase() !== expected) {
      throw new Error('The private transaction acknowledgement did not match its signed hash');
    }
    return expected;
  };

  const submissions = [send(FLASHBOTS_RELAY, { ...headers, 'x-flashbots-signature': `${signer.address}:${signature}` })];
  // Alchemy offers a second ingress to Flashbots and preserves maxBlockNumber.
  if (/^https:\/\/eth-mainnet\.g\.alchemy\.com\/v2\/[A-Za-z0-9_-]+$/.exec(CONFIG.rpcUrl)?.[0] === CONFIG.rpcUrl) {
    submissions.push(send(CONFIG.rpcUrl, headers));
  }
  try {
    return await Promise.any(submissions);
  } catch {
    // Network errors can include URLs or raw transaction data. Reconcile the signed nonce instead.
    throw new Error('No private endpoint acknowledged the transaction');
  }
}
