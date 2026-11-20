const WETH = 1e18;

/** V2 reserves give an exact constant-product starting point. Virtual V3 reserves only describe the current tick. */
export function routeInputSizes(estimatedEth: number, includesV3: boolean, previous?: bigint, limit?: bigint, broaden = false): bigint[] {
  const estimate = Math.min(estimatedEth * WETH, limit === undefined ? Infinity : Number(limit));
  if (!Number.isFinite(estimate) || estimate <= 0 || estimate * 1.7 >= 2 ** 255) return [];
  const ratios = includesV3 ? [1, 0.55, 0.15, 1.7] : [1, 0.5];
  if (broaden) ratios.push(0.3, 1.25);
  const amounts = ratios.map((ratio) => BigInt(Math.max(1, Math.floor(estimate * ratio))));
  if (includesV3) {
    const prior = previous === undefined ? 0 : Number(previous);
    const distinct = amounts.every((amount) => Math.abs(prior / Number(amount) - 1) > 0.03);
    amounts.push(previous !== undefined && distinct && prior >= estimate * 0.15 && prior <= estimate * 1.7
      ? previous : BigInt(Math.max(1, Math.floor(estimate * 0.8))));
  }
  return [...new Set(amounts.map((amount) => limit !== undefined && amount > limit ? limit : amount))].filter((amount) => amount > 0n);
}
