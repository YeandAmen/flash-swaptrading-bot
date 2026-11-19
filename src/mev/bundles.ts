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

const errMsg = (e: unknown) => ((e as Error)?.message ?? String(e)).split('\n')[0].slice(0, 120);

/**
 * Sends a bundle to several block builders for ONE target block. A bundle is all-or-nothing: if any transaction in it
 * would revert, builders drop it, so an arbitrage that is no longer profitable simply never lands (and costs nothing).
 * On a local fork (tests) the transactions are sent directly instead.
 */
export async function sendBundle(signedTxs: Hex[], targetBlock: bigint): Promise<BuilderResult[]> {
  if (CONFIG.forkMode) {
    const out: BuilderResult[] = [];
    for (const tx of signedTxs) {
      try {
        const hash = await publicClient.request({ method: 'eth_sendRawTransaction', params: [tx] });
        out.push({ builder: 'fork', ok: true, detail: String(hash) });
      } catch (e) {
        out.push({ builder: 'fork', ok: false, detail: errMsg(e) });
      }
    }
    return out;
  }
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendBundle', params: [{ txs: signedTxs, blockNumber: toHex(targetBlock) }] });
  const signer = authSigner();
  // Flashbots auth: EIP-191 signature of the hex string of keccak256(body), sent as "address:signature"
  const signature = await signer.signMessage({ message: keccak256(stringToHex(body)) });
  const headers = { 'content-type': 'application/json', 'x-flashbots-signature': `${signer.address}:${signature}` };
  return Promise.all(MEV.builders.map(async (url): Promise<BuilderResult> => {
    const builder = new URL(url).hostname;
    try {
      const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(4_000) });
      const text = await res.text();
      let j: { error?: { message?: string } } | null = null;
      try { j = JSON.parse(text); } catch { /* not JSON */ }
      if (!res.ok || j?.error) return { builder, ok: false, detail: (j?.error?.message ?? (text || res.statusText)).slice(0, 120) };
      return { builder, ok: true, detail: 'accepted' };
    } catch (e) {
      return { builder, ok: false, detail: errMsg(e) };
    }
  }));
}
