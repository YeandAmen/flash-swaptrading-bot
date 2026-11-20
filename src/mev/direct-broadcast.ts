import { createClient, http, keccak256, type Hex } from 'viem';
import { sendRawTransaction } from 'viem/actions';
import { mainnet } from 'viem/chains';
import { CONFIG, MEV } from '../config.js';

const directClients = [CONFIG.rpcUrl, ...MEV.directBroadcastRpcUrls].map((url) => createClient({
  chain: mainnet,
  transport: http(url, { retryCount: 0, timeout: 3_500, fetchOptions: { redirect: 'error' } }),
}));

/** Send the same signature to all configured RPCs and accept the first matching hash. */
export async function submitDirect(serialized: Hex): Promise<Hex> {
  if (!CONFIG.allowLiveTrading && !CONFIG.forkMode) throw new Error('Live transaction canceled before broadcast');
  const expected = keccak256(serialized);
  try {
    return await Promise.any(directClients.map(async (client) => {
      const acknowledged = await sendRawTransaction(client, { serializedTransaction: serialized });
      if (typeof acknowledged !== 'string' || acknowledged.toLowerCase() !== expected) {
        throw new Error('The Ethereum RPC returned an unexpected transaction hash');
      }
      return expected;
    }));
  } catch {
    // Keep the raw transaction and provider details out of the log. The nonce still requires reconciliation.
    throw new Error('No Ethereum RPC acknowledged the direct MEV transaction');
  }
}
