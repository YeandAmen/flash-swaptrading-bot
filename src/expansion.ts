import { CONFIG } from './config.js';
import { redactDiagnostic } from './diagnostics.js';
import { ArbitrumWorker } from './arbitrum/worker.js';
import type { SolanaScanResult } from './solana/scan.js';

const arbitrum = new ArbitrumWorker();
const solanaEnabled = process.env.SOLANA === 'on' && !CONFIG.forkMode;
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
    solanaResult = await scanSolanaCycle(solanaScanConfig());
    solanaStatus = 'Unsigned scan completed';
    solanaUpdatedAt = Date.now();
  }, 30_000, (error) => { solanaStatus = error; });
}

export function expansionView() {
  return { arbitrum: arbitrum.summary, solana: {
    mode: solanaEnabled ? 'paper' : 'off',
    status: solanaStatus,
    updatedAt: solanaUpdatedAt,
    result: solanaResult,
  } };
}

export function disarmArbitrum() { arbitrum.disarm(); }
export function armArbitrum() { arbitrum.arm(); }

export function stopExpansion() {
  stopping = true;
  arbitrum.stop();
  for (const timeout of schedule) clearTimeout(timeout);
  schedule.clear();
}
