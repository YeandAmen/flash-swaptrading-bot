import { CONFIG, DATA_DIR } from './config.js';
import { redactDiagnostic } from './diagnostics.js';
import { ArbitrumWorker } from './arbitrum/worker.js';
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
  if (arbitrum.enabled) void poll(() => arbitrum.scan(), 6_000, (error) => { arbitrum.summary.status = error; });
  if (solanaEnabled) void poll(async () => {
    const { scanSolanaCycle, solanaScanConfig } = await import('./solana/scan.js');
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
    solanaResult = await scanSolanaCycle(config, execution ? (candidate) => execution.submit(candidate) : undefined);
    const quoteFailure = solanaResult.routes.length > 0 && solanaResult.routes.every((route) => route.status === 'quote-error')
      ? solanaResult.routes[0].detail ?? 'The venue quotes are unavailable' : null;
    solanaStatus = liveError ?? quoteFailure ?? (execution ? 'Guarded live scan completed' : 'Unsigned scan completed');
    solanaUpdatedAt = Date.now();
  }, solanaCanArm ? 12_000 : 30_000, (error) => { solanaStatus = error; });
}

export function expansionView() {
  return { arbitrum: arbitrum.summary, solana: {
    mode: solanaEnabled ? (solanaLive?.summary.armed && solanaLive.summary.ready ? 'live' : 'paper') : 'off',
    canArm: solanaCanArm,
    status: solanaStatus,
    execution: solanaLive?.summary ?? null,
    updatedAt: solanaUpdatedAt,
    result: solanaResult,
  } };
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
