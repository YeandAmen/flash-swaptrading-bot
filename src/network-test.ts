export type FlashTestOptions = { minimumNetUsd?: number; minimumLoanUsd?: number };

export type FlashTest = FlashTestOptions & {
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

export function queueFlashTest(test: FlashTest | undefined | null, id: string, now = Date.now(), options: FlashTestOptions = {}): FlashTest {
  if (test?.id === id) return test;
  const { minimumNetUsd, minimumLoanUsd } = options;
  if (minimumNetUsd !== undefined && (!Number.isFinite(minimumNetUsd) || minimumNetUsd <= 0 || minimumNetUsd > 1000)
    || minimumLoanUsd !== undefined && (minimumNetUsd === undefined || !Number.isFinite(minimumLoanUsd)
      || minimumLoanUsd < 1 || minimumLoanUsd > 100000)) {
    throw new Error('A loan floor requires a positive after-fee profit and a supported loan size');
  }
  if (activeFlashTest(test, now) || test?.status === 'submitted') throw new Error('A mainnet test is already active');
  return { id, queuedAt: now, expiresAt: now + 12 * 60_000, checked: 0, status: 'queued', hash: null,
    ...options,
    note: minimumNetUsd === undefined
      ? 'Waiting for a route that repays the flash loan and protects the wallet. Only network fees may be spent.'
      : 'Waiting for a route that meets the loan size and positive after-fee profit floors.' };
}
