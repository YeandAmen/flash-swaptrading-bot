import { encodeErrorResult, parseAbi, type Hex } from 'viem';

// Flashbots Protect keeps transaction status for 45 minutes after receipt.
export const PRIVATE_STATUS_RETENTION_MS = 45 * 60_000;
const statuses = ['PENDING', 'FAILED', 'CANCELLED', 'INCLUDED', 'UNKNOWN'] as const;
const simulationErrors = ['MaxFeePerGasTooLow', 'InsufficientFunds', 'NonceTooLow', 'NonceTooHigh',
  'InvalidChainIdForSigner', 'ExecutionReverted', 'OutOfGas', 'Other'] as const;
const errorAbi = parseAbi(['error Error(string)']);
const reasons = new Map<string, string>();
for (const reason of ['expired', 'deadline or floor', 'unprofitable', 'loan repayment', 'partial path input',
  'no swap output', 'transfer failed', 'TF']) {
  reasons.set(reason, reason);
  reasons.set(encodeErrorResult({ abi: errorAbi, errorName: 'Error', args: [reason] }), reason);
}

export function knownArbitrageRevert(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 256) return;
  return reasons.get(raw.startsWith('0x') ? raw.toLowerCase() : raw);
}

export interface PrivateRelayStatus {
  status: (typeof statuses)[number];
  maxBlockNumber?: number;
  simError?: (typeof simulationErrors)[number];
  revertReason?: string;
}

/** Only retain fields with a known meaning for the requested transaction. */
function readStatus(value: unknown, hash: Hex): PrivateRelayStatus | null {
  if (!value || typeof value !== 'object') return null;
  const reply = value as Record<string, unknown>;
  if (typeof reply.hash !== 'string' || reply.hash.toLowerCase() !== hash.toLowerCase()) return null;
  const status = statuses.find(candidate => candidate === reply.status);
  if (!status) return null;
  const result: PrivateRelayStatus = { status };
  const block = reply.maxBlockNumber;
  if (typeof block === 'number' && Number.isSafeInteger(block) && block > 0) result.maxBlockNumber = block;
  const error = simulationErrors.find(candidate => candidate === reply.simError);
  if (error) result.simError = error;
  const raw = reply.revertReason;
  if (error === 'ExecutionReverted') {
    const reason = knownArbitrageRevert(raw);
    if (reason) result.revertReason = reason;
  }
  return result;
}

export async function requestPrivateRelayStatus(hash: Hex, transport: typeof fetch = fetch): Promise<PrivateRelayStatus | null> {
  if (!/^0x[\da-f]{64}$/i.test(hash)) return null;
  try {
    const response = await transport(`https://protect.flashbots.net/tx/${hash}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return readStatus(JSON.parse(Buffer.concat(chunks).toString('utf8')), hash);
  } catch {
    return null;
  }
}
