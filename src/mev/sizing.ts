const WETH = 1e18;
const ROUTE_QUOTE_MAX_AGE_MS = 90_000;

export interface RouteQuoteSample {
  at: number;
  modelProfitEth: number;
  modelAmountEth: number;
  proceedsEth: number;
  gasUnits: number;
}

/** A recent execution simulation only informs ranking while the pool estimate still looks similar. */
export function comparableRouteQuote(modelProfitEth: number, modelAmountEth: number,
  sample: RouteQuoteSample, now: number): boolean {
  const age = now - sample.at;
  const profitRatio = modelProfitEth / sample.modelProfitEth;
  const amountRatio = modelAmountEth / sample.modelAmountEth;
  return age >= 0 && age <= ROUTE_QUOTE_MAX_AGE_MS
    && profitRatio >= 2 / 3 && profitRatio <= 1.5 && amountRatio >= 2 / 3 && amountRatio <= 1.5;
}

export function rankRouteNet(modelProfitEth: number, modelAmountEth: number, gasUnits: number,
  gasPriceEth: number, sample: RouteQuoteSample | undefined, now: number, measuredGasUnits?: number): number {
  if (!sample || !comparableRouteQuote(modelProfitEth, modelAmountEth, sample, now)) {
    return modelProfitEth - gasUnits * gasPriceEth;
  }
  const observedRatio = Math.max(0, Math.min(2, sample.proceedsEth / sample.modelProfitEth));
  const rankedProceeds = modelProfitEth * (0.25 + 0.75 * observedRatio);
  return rankedProceeds - (measuredGasUnits ?? sample.gasUnits) * gasPriceEth;
}

/** V2 reserves give an exact constant-product starting point. Virtual V3 reserves only describe the current tick. */
export function routeInputSizes(estimatedEth: number, includesV3: boolean, previous?: bigint, limit?: bigint, broaden = false): bigint[] {
  const estimate = Math.min(estimatedEth * WETH, limit === undefined ? Infinity : Number(limit));
  if (!Number.isFinite(estimate) || estimate <= 0 || estimate * 1.7 >= 2 ** 255) return [];
  const ratios = includesV3 ? [1, 0.55, 0.15, 1.7] : [1, 0.5];
  if (broaden) ratios.push(0.3, 1.25);
  const amounts = ratios.map((ratio) => BigInt(Math.max(1, Math.floor(estimate * ratio))));
  const prior = previous === undefined ? 0 : Number(previous);
  const distinct = amounts.every((amount) => Math.abs(prior / Number(amount) - 1) > 0.03);
  const inRange = prior >= estimate * (includesV3 ? 0.15 : 0.5) && prior <= estimate * (includesV3 ? 1.7 : 1);
  if (previous !== undefined && distinct && inRange) {
    if (includesV3) amounts.push(previous);
    else amounts[1] = previous;
  } else if (includesV3) {
    amounts.push(BigInt(Math.max(1, Math.floor(estimate * 0.8))));
  }
  return [...new Set(amounts.map((amount) => limit !== undefined && amount > limit ? limit : amount))].filter((amount) => amount > 0n);
}
