export type FlashTest = {
  id: string;
  queuedAt: number;
  expiresAt: number;
  checked: number;
  status: 'queued' | 'submitted' | 'landed' | 'failed' | 'expired';
  hash: string | null;
  note: string;
};

export function activeFlashTest(test: FlashTest | undefined | null, now = Date.now()): test is FlashTest & { status: 'queued' } {
  return Boolean(test?.status === 'queued' && test.expiresAt > now);
}

export function flashTestView(test: FlashTest | undefined | null, now = Date.now()) {
  if (!test) return null;
  if (test.status === 'queued' && test.expiresAt <= now) {
    return { ...test, status: 'expired' as const, note: 'No qualifying quote before the deadline. No transaction sent.' };
  }
  return test;
}

export function queueFlashTest(test: FlashTest | undefined | null, id: string, now = Date.now()): FlashTest {
  if (test?.id === id) return test;
  if (activeFlashTest(test, now) || test?.status === 'submitted') throw new Error('A mainnet test is already active');
  return { id, queuedAt: now, expiresAt: now + 12 * 60_000, checked: 0, status: 'queued', hash: null,
    note: 'Waiting for a route that repays the flash loan and protects the wallet. Only network fees may be spent.' };
}
