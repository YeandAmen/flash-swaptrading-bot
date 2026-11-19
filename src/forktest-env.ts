import assert from 'node:assert/strict';
import { CONFIG } from './config.js';

export async function assertForkTestEnvironment() {
  assert.ok(CONFIG.forkMode, 'FORK_MODE=1 required');
  assert.ok(CONFIG.walletKeyFile, 'WALLET_KEY_FILE required (throwaway test key)');
  assert.equal(new URL(CONFIG.rpcUrl).href, new URL(CONFIG.sendRpcUrl).href, 'fork tests must read and send to the same Anvil node');
  const response = await fetch(CONFIG.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_nodeInfo', params: [] }),
    redirect: 'error',
    signal: AbortSignal.timeout(3000),
  });
  const node = await response.json() as { result?: unknown };
  assert.ok(response.ok && node.result && typeof node.result === 'object', 'fork tests require a local Anvil node');
}
