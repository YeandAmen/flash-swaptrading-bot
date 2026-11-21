import { CONFIG, DATA_DIR } from './config.js';
import { redactDiagnostic } from './diagnostics.js';
import type { FlashTestOptions } from './network-test.js';
import { NetworkActivity } from './network-activity.js';
import { LIGHTHOUSE } from './solana/guard.js';
import { JUPITER, KAMINO } from './solana/protocol.js';
import { ArbitrumWorker } from './arbitrum/worker.js';
import { SolanaMarketPlanner, type SolanaMarketProbe } from './solana/market.js';
import type { SolanaScanResult } from './solana/scan.js';
import type { SolanaLiveWorker } from './solana/worker.js';

const arbitrum = new ArbitrumWorker();
const solanaEnabled = process.env.SOLANA === 'on' && !CONFIG.forkMode;
const solanaCanArm = solanaEnabled && CONFIG.allowLiveTrading && process.env.SOLANA_LIVE === 'on';
let solanaLive: SolanaLiveWorker | null = null;
let solanaStopBeforeInit = false;
let solanaResult: SolanaScanResult | null = null;
let solanaStatus = solanaEnabled ? 'Starting' : 'Disabled';
let solanaUpdatedAt = 0;
const solanaActivity = new NetworkActivity();
let verifiedGuardLogged = false;
let loggedSignature: string | null = null;
let loggedOutcome: string | null = null;
const solanaTestSizes = [1, 5, 10, 25, 50, 250, 1000] as const;
const solanaBoundedLossTestSizes = [1, 5, 10] as const;
const solanaProfitTestMultipliers = [1, 2, 3, 5, 10] as const;
const solanaVenueRotation = [0, 1, 0, 2] as const;
let solanaMarket: SolanaMarketPlanner | undefined;
let solanaMarketProbe: SolanaMarketProbe | null = null;
let solanaTestScans = 0;
let stopping = false;
const schedule = new Set<ReturnType<typeof setTimeout>>();

async function poll(task: () => Promise<void>, delay: number, reportError: (text: string) => void) {
  if (stopping) return;
  try { await task(); }
  catch (error) {
    reportError(redactDiagnostic(error instanceof Error ? error.message.split('\n')[0] : String(error)));
  }
  if (stopping) return;
  const timeout = setTimeout(() => {
    schedule.delete(timeout);
    void poll(task, delay, reportError);
  }, delay);
  schedule.add(timeout);
}

export function startExpansion() {
  if (arbitrum.enabled) void poll(() => arbitrum.scan(), 6_000, (error) => arbitrum.scanError(error));
  if (solanaEnabled) void poll(async () => {
    const { scanSolanaCycle, solanaScanConfig, solanaVenuePairs } = await import('./solana/scan.js');
    const config = solanaScanConfig();
    let liveError: string | null = null;
    if (solanaCanArm) {
      try {
        if (!solanaLive) {
          const { SolanaLiveWorker } = await import('./solana/worker.js');
          if (stopping) return;
          solanaLive = new SolanaLiveWorker(config, process.env.SOLANA_WALLET_KEY_FILE ?? '', DATA_DIR);
        }
        await solanaLive.initialize();
        if (solanaStopBeforeInit && solanaLive.summary.armed) solanaLive.disarm();
        await solanaLive.reconcile();
      } catch (error) {
        liveError = redactDiagnostic(String((error as Error)?.message ?? error)).split('\n')[0];
      }
    }
    const worker = solanaLive;
    const execution = !liveError && worker?.summary.armed && worker.summary.ready && !worker.summary.pending ? worker : null;
    const test = execution?.activeTest();
    let probe: SolanaMarketProbe | undefined;
    if (test) {
      const scan = solanaTestScans++;
      config.venuePair = solanaVenuePairs[solanaVenueRotation[scan % solanaVenueRotation.length]];
      const sizes = test.maximumSwapLossUsdc === undefined ? solanaTestSizes : solanaBoundedLossTestSizes;
      config.loanUsdc = test.minimumLoanUsd === undefined
        ? sizes[scan % sizes.length]
        : Math.min(100_000, test.minimumLoanUsd * solanaProfitTestMultipliers[scan % solanaProfitTestMultipliers.length]);
    } else if (config.loanUsdc !== undefined && config.loanUsdc >= 1 && config.loanUsdc <= 100_000) {
      solanaMarket ??= new SolanaMarketPlanner(solanaVenuePairs.length);
      probe = solanaMarket.plan(config.loanUsdc, Date.now());
      config.venuePair = solanaVenuePairs[probe.venue];
      config.loanUsdc = probe.loanUsdc;
    }
    solanaResult = await scanSolanaCycle(config, execution ? (candidate) => execution.submit(candidate) : undefined, test ?? undefined);
    if (test) execution?.recordTestScan(test.id, solanaResult.routes.length);
    const quoteFailure = solanaResult.routes.length > 0 && solanaResult.routes.every((route) => route.status === 'quote-error')
      ? solanaResult.routes[0].detail ?? 'The venue quotes are unavailable' : null;
    solanaStatus = liveError ?? quoteFailure ?? (execution ? 'Guarded live scan completed' : 'Unsigned scan completed');
    solanaUpdatedAt = Date.now();
    if (probe) {
      const { routes, checkedAt } = solanaResult;
      const quotes = routes.flatMap(({ status, quotedNetBeforeNetworkUsdc }) =>
        (status === 'below-profit-floor' || status === 'simulated') && quotedNetBeforeNetworkUsdc !== undefined
          && Number.isFinite(quotedNetBeforeNetworkUsdc) ? [quotedNetBeforeNetworkUsdc] : []);
      solanaMarket?.record(probe, quotes.length > 0 ? Math.max(...quotes) : undefined, Date.parse(checkedAt));
    }
    solanaMarketProbe = probe ?? null;
    solanaActivity.recordScan(solanaResult.routes.filter((route) => route.quotedNetBeforeNetworkUsdc !== undefined).length, solanaUpdatedAt);
    const status = worker?.summary;
    if (status?.ready && !verifiedGuardLogged) {
      solanaActivity.record('info', 'Immutable Lighthouse program verified on Solana mainnet', `https://explorer.solana.com/address/${LIGHTHOUSE}`);
      verifiedGuardLogged = true;
    }
    if (status?.pending && status.pending !== loggedSignature) {
      solanaActivity.record('info', test ? 'Mainnet test submitted' : 'Solana route submitted', `https://explorer.solana.com/tx/${status.pending}`);
      loggedSignature = status.pending;
    }
    if (status?.lastOutcome && status.lastOutcome.signature !== loggedOutcome) {
      const row = status.lastOutcome;
      solanaActivity.record(row.status === 'finalized' ? 'trade' : 'warn',
        `Solana transaction ${row.status}. Fee ${row.feeLamports} lamports.`, `https://explorer.solana.com/tx/${row.signature}`, row.at);
      loggedOutcome = row.signature;
    }
    const routes = solanaResult.routes.map((route) =>
      `${route.buy} → ${route.sell}: ${route.detail ?? route.status}${route.quotedNetBeforeNetworkUsdc === undefined ? '' : ` (${route.quotedNetBeforeNetworkUsdc.toFixed(6)} USDC before network fees)`}`);
    const sizing = probe ? ' ' + probe.loanUsdc + ' USDC ' + probe.reason + ' probe.' : '';
    const report = 'Slot ' + solanaResult.slot + '.' + sizing + ' ' + (routes.join(' | ') || solanaResult.status) + '.';
    solanaActivity.record(quoteFailure || liveError ? 'warn' : 'info', report);
  }, solanaCanArm ? 12_000 : 30_000, (error) => {
    solanaStatus = error;
    solanaActivity.record('error', error);
  });
}

export function expansionView() {
  return { arbitrum: arbitrum.view(), solana: {
    mode: solanaEnabled ? (solanaLive?.summary.armed && solanaLive.summary.ready ? 'live' : 'paper') : 'off',
    canArm: solanaCanArm,
    status: solanaStatus,
    execution: solanaLive?.summary ?? null,
    updatedAt: solanaUpdatedAt,
    result: solanaResult,
    marketProbe: solanaMarketProbe,
    deployment: {
      address: null, owner: null, guardAddress: LIGHTHOUSE, lenderAddress: KAMINO, routerAddress: JUPITER,
      guardVerified: solanaLive?.summary.ready ?? false,
      status: solanaLive?.summary.ready ? 'Uses the verified Lighthouse balance guard' : 'Uses the deployed Lighthouse program',
    },
    logs: solanaActivity.view(),
    scanWindow: solanaActivity.scanWindow(),
    test: solanaLive?.summary.test ?? null,
  } };
}

export function queueArbitrumTest(id: string, options?: FlashTestOptions) { arbitrum.queueTest(id, options); }

export function queueSolanaTest(id: string, options?: FlashTestOptions) {
  if (!solanaLive) throw new Error('Solana live wallet is not ready');
  solanaLive.queueTest(id, options);
  solanaActivity.record('info', 'Queued one Solana mainnet flash-loan test');
}

export function disarmArbitrum() { arbitrum.disarm(); }
export function armArbitrum() { arbitrum.arm(); }

export function disarmSolana() {
  solanaStopBeforeInit = true;
  solanaLive?.disarm();
}

export function armSolana() {
  if (!solanaCanArm || !solanaLive?.summary.ready) throw new Error('Solana live execution is unavailable');
  solanaLive.arm();
  solanaStopBeforeInit = false;
}

export function stopExpansion() {
  stopping = true;
  arbitrum.stop();
  solanaLive?.stop();
  for (const timeout of schedule) clearTimeout(timeout);
  schedule.clear();
}
