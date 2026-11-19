export interface Position {
  symbol: string;
  qty: number; // token units (display)
  qtyRaw: string; // exact raw amount as bigint string
  entryPrice: number; // effective USD paid per token (incl. pool fees + price impact)
  entryMid: number; // mid price at entry
  entryTime: number; // ms
  costUsd: number; // USDC spent on the buy
  entryGasUsd: number;
  stopPrice: number;
  targetPrice: number;
  stopPct: number;
  targetPct: number;
  trailActive: boolean;
  peakPrice: number;
  breakevenPrice: number; // mid price needed to exit at ~0 net after all costs
}

export interface Trade {
  id: string;
  time: number;
  side: 'BUY' | 'SELL';
  symbol: string;
  usd: number;
  qty: number;
  price: number;
  gasUsd: number;
  pnlUsd?: number;
  pnlPct?: number;
  reason: string;
  txHashes?: string[];
}

export interface PortfolioState {
  kind: 'paper' | 'live';
  cashUsd: number;
  positions: Position[];
  /** @deprecated single-position state from older versions; migrated into `positions` on load (do not use) */
  position?: never | null;
  trades: Trade[];
  equityHistory: [number, number][];
  peakEquity: number;
  dayKey: string;
  dayStartEquity: number;
  realizedPnlUsd: number;
  gasSpentUsd: number;
  netDepositsUsd: number;
  cooldowns: Record<string, number>;
  consecutiveFailures: number;
  retryAfter: number | null; // entries
  exitRetryAfter?: number | null; // exits (short backoff)
  halted: string | null;
  pausedUntil: number | null;
  lastDecision: string;
}

export interface BotEvent {
  t: number;
  level: 'info' | 'trade' | 'warn' | 'error';
  msg: string;
}

export const newPortfolio = (kind: 'paper' | 'live', cash: number): PortfolioState => ({
  kind,
  cashUsd: cash,
  positions: [],
  trades: [],
  equityHistory: [],
  peakEquity: cash,
  dayKey: '',
  dayStartEquity: cash,
  realizedPnlUsd: 0,
  gasSpentUsd: 0,
  netDepositsUsd: kind === 'paper' ? cash : 0,
  cooldowns: {},
  consecutiveFailures: 0,
  retryAfter: null,
  exitRetryAfter: null,
  halted: null,
  pausedUntil: null,
  lastDecision: 'Starting up',
});

/** Upgrade a portfolio saved by an older version (single `position`) to `positions[]`. */
export function migratePortfolio(pf: PortfolioState): PortfolioState {
  if (!Array.isArray(pf.positions)) pf.positions = pf.position ? [pf.position] : [];
  delete pf.position;
  return pf;
}
