/** Round the USD floor up to whole units of the repayment asset at its eight-decimal oracle price. */
export function minimumNetInAsset(minimumNetUsd: number, scale: bigint, priceE8: bigint) {
  const minimumUsdE8 = BigInt(Math.ceil(minimumNetUsd * 1e8));
  return (minimumUsdE8 * scale + priceE8 - 1n) / priceE8;
}

/** Smallest gross payout whose remaining 90%, rounded down in token units, covers the required amount. */
export function requiredGrossPayout(required: bigint) {
  return (required * 10n + 8n) / 9n;
}

/** Use part of an already funded EIP-1559 fee ceiling when the Arbitrum RPC recommends a zero tip. */
export function bidArbitrumFeeHeadroom(
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  baseFeePerGas: bigint | null | undefined,
) {
  if (fees.maxPriorityFeePerGas !== 0n || baseFeePerGas == null || baseFeePerGas <= 0n || fees.maxFeePerGas <= baseFeePerGas) return fees;
  const halfHeadroom = (fees.maxFeePerGas - baseFeePerGas) / 2n;
  const maxPriority = 5_000_000n; // 0.005 gwei
  return { ...fees, maxPriorityFeePerGas: halfHeadroom < maxPriority ? halfHeadroom : maxPriority };
}
