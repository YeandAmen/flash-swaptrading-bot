import { BaseError, HttpRequestError, RpcRequestError, type Hash, type Hex } from 'viem';

type Send = (transaction: Hex) => Promise<Hash>;

type Fallback = {
  send: Send;
  canSend: () => boolean;
  verifyFresh: () => Promise<boolean>;
};

export type ArbitrumBroadcast = {
  status: 'acknowledged' | 'quota-rejected' | 'unknown' | 'hash-mismatch';
  via: 'primary' | 'alternate';
};

function writeQuotaRejected(error: unknown) {
  if (!(error instanceof BaseError)) return false;
  return Boolean(error.walk((cause) =>
    (cause instanceof HttpRequestError && cause.status === 429)
    || (cause instanceof RpcRequestError && (cause.status === 429
      || /^Public RPC Rate Limit Hit(?:, limit will reset in \d+ seconds)?$/.test(cause.details ?? '')))));
}

/** Send the same journaled bytes through the alternate only after an explicit write rejection. */
export async function broadcastArbitrum(
  primary: Send, transaction: Hex, hash: Hash, alternate?: Fallback,
): Promise<ArbitrumBroadcast> {
  const matches = (result: Hash) => typeof result === 'string' && result.toLowerCase() === hash.toLowerCase();
  let primaryResult: ArbitrumBroadcast;
  try {
    const acknowledged = await primary(transaction);
    return { status: matches(acknowledged) ? 'acknowledged' : 'hash-mismatch', via: 'primary' };
  } catch (error) {
    primaryResult = { status: writeQuotaRejected(error) ? 'quota-rejected' : 'unknown', via: 'primary' };
  }
  if (primaryResult.status !== 'quota-rejected' || !alternate || !alternate.canSend()
    || !await alternate.verifyFresh().catch(() => false) || !alternate.canSend()) return primaryResult;
  try {
    const acknowledged = await alternate.send(transaction);
    return { status: matches(acknowledged) ? 'acknowledged' : 'hash-mismatch', via: 'alternate' };
  } catch (error) {
    return { status: writeQuotaRejected(error) ? 'quota-rejected' : 'unknown', via: 'alternate' };
  }
}
