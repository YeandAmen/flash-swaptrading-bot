import fs from 'node:fs';
import path from 'node:path';
import { keccak256, stringToHex, toHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { CONFIG, DATA_DIR, MEV } from '../config.js';
import { publicClient } from '../chain.js';

const AUTH_FILE = path.join(DATA_DIR, 'flashbots-auth.key');
let auth: PrivateKeyAccount | null = null;

/**
 * Flashbots "searcher reputation" key. It only signs bundle requests (builders use it to rate senders);
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
}

function bundleHashOf(value: unknown): Hex | null {
  if (!value || typeof value !== 'object') return null;
  const reply = value as { jsonrpc?: unknown; id?: unknown; error?: unknown; result?: { bundleHash?: unknown } };
  const hash = reply.result?.bundleHash;
  return reply.jsonrpc === '2.0' && reply.id === 1 && !reply.error && typeof hash === 'string' && /^0x[0-9a-f]{64}$/i.test(hash)
    ? hash as Hex : null;
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
      try {
        const hash = await publicClient.request({ method: 'eth_sendRawTransaction', params: [tx] });
        out.push({ builder: 'fork', ok: true, detail: String(hash) });
      } catch {
        out.push({ builder: 'fork', ok: false, detail: 'local submission outcome unknown' });
      }
    }
    return out;
  }
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendBundle', params: [{ txs: signedTxs, blockNumber: toHex(targetBlock) }] });
  const signer = authSigner();
  // Flashbots auth: EIP-191 signature of the hex string of keccak256(body), sent as "address:signature"
  const signature = await signer.signMessage({ message: keccak256(stringToHex(body)) });
  if (!allowed()) return [];
  const headers = { 'content-type': 'application/json', 'x-flashbots-signature': `${signer.address}:${signature}` };
  return Promise.all(MEV.builders.map(async (url): Promise<BuilderResult> => {
    const builder = new URL(url).hostname;
    try {
      const res = await fetch(url, { method: 'POST', redirect: 'error', headers, body, signal: AbortSignal.timeout(4_000) });
      if (!res.ok) return { builder, ok: false, detail: `HTTP ${res.status}` };
      const reply: unknown = await res.json().catch(() => null);
      const hash = bundleHashOf(reply);
      return hash ? { builder, ok: true, detail: hash } : { builder, ok: false, detail: 'no valid bundle acknowledgement' };
    } catch {
      return { builder, ok: false, detail: 'submission outcome unknown' };
    }
  }));
}
