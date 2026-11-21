export type FlashTestOptions = { minimumNetUsd?: number; minimumLoanUsd?: number; maximumSwapLossUsdc?: number };

export function validSolanaSwapLossUsdc(value: unknown): value is number {
  return typeof value === 'number' && value >= 0.000001 && value <= 0.02
    && Math.round(value * 1_000_000) / 1_000_000 === value;
}

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

export function queueFlashTest(test: FlashTest | undefined | null, id: string, now = Date.now(), options: FlashTestOptions = {},
  chain?: 'solana'): FlashTest {
  const { minimumNetUsd, minimumLoanUsd, maximumSwapLossUsdc } = options;
  if (maximumSwapLossUsdc !== undefined && (chain !== 'solana' || !validSolanaSwapLossUsdc(maximumSwapLossUsdc)
    || minimumNetUsd !== undefined || minimumLoanUsd !== undefined)) {
    throw new Error('Only Solana tests support an exact swap loss cap of up to 0.02 USDC without profit or loan floors');
  }
  if (test?.id === id) {
    if (test.maximumSwapLossUsdc !== maximumSwapLossUsdc) throw new Error('Test ID already has different swap loss terms');
    return test;
  }
  if (minimumNetUsd !== undefined && (!Number.isFinite(minimumNetUsd) || minimumNetUsd <= 0 || minimumNetUsd > 1000)
    || minimumLoanUsd !== undefined && (minimumNetUsd === undefined || !Number.isFinite(minimumLoanUsd)
      || minimumLoanUsd < 1 || minimumLoanUsd > 100000)) {
    throw new Error('A loan floor requires a positive after-fee profit and a supported loan size');
  }
  if (activeFlashTest(test, now) || test?.status === 'submitted') throw new Error('A mainnet test is already active');
  return { id, queuedAt: now, expiresAt: now + 12 * 60_000, checked: 0, status: 'queued', hash: null,
    ...options,
    note: maximumSwapLossUsdc !== undefined
      ? `Waiting for a repayable route within the ${maximumSwapLossUsdc} USDC swap loss cap plus network fees.`
      : minimumNetUsd === undefined
        ? 'Waiting for a route that repays the flash loan and protects the wallet. Only network fees may be spent.'
        : 'Waiting for a route that meets the loan size and positive after-fee profit floors.' };
}
