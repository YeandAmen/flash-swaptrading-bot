import type { Hex } from 'viem';
import type { BuilderResult } from './bundles.js';

const titan = {
  url: 'https://stats.titanbuilder.xyz',
  method: 'titan_getBundleStats',
  hashKey: 'bundleHash',
  delayMs: 330_000, // Titan makes traces available approximately five minutes after sending.
} as const;
const quasar = {
  url: 'https://stats.quasar.win',
  method: 'quasar_getBundleStats',
  hashKey: 'bundle_hash',
  delayMs: 48_000, // Quasar can lag the target by two slots. Give it an additional slot.
} as const;
const MAX_TRACE_AGE_MS = 24 * 60 * 60 * 1000;
type TraceProvider = typeof titan | typeof quasar;
const providers = new Map<string, TraceProvider>([
  ['rpc.titanbuilder.xyz', titan], ['us.rpc.titanbuilder.xyz', titan], ['eu.rpc.titanbuilder.xyz', titan], ['ap.rpc.titanbuilder.xyz', titan],
  ['rpc.quasar.win', quasar],
]);

const statuses = {
  received: 'received only',
  invalid: 'invalid',
  simulationfail: 'simulation failed',
  simulationpass: 'simulation passed',
  excludedfromblock: 'excluded from block',
  includedinblock: 'included in candidate block',
  submitted: 'submitted to relay',
  landed: 'reported landed',
} as const;

export type BuilderTraceStatus = (typeof statuses)[keyof typeof statuses];

interface TraceRequest {
  builder: BuilderResult;
  hash: Hex;
  provider: TraceProvider;
  waitMs: number;
}

/** Only ask configured providers about prior acknowledgments they issued. */
export function bundleTraceRequests(builders: BuilderResult[], configuredUrls: string[], sentAt: number, now = Date.now()): TraceRequest[] {
  const ageMs = now - sentAt;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= MAX_TRACE_AGE_MS) return [];
  const hosts = new Set(configuredUrls.filter((url) => URL.canParse(url)).map((url) => new URL(url))
    .filter((url) => url.protocol === 'https:').map((url) => url.hostname));
  const requests: TraceRequest[] = [];
  for (const builder of builders) {
    if (!builder?.ok || builder.traceStatus || !builder.bundleHash || !/^0x[0-9a-f]{64}$/i.test(builder.bundleHash) || !hosts.has(builder.builder)) continue;
    const provider = providers.get(builder.builder);
    if (!provider || requests.some((request) => request.provider === provider)) continue;
    requests.push({ builder, hash: builder.bundleHash, provider, waitMs: Math.max(0, provider.delayMs - ageMs) });
  }
  return requests;
}

export async function requestBuilderTrace({ provider, hash }: TraceRequest, transport: typeof fetch = fetch): Promise<BuilderTraceStatus | null> {
  try {
    const response = await transport(provider.url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2_500),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: provider.method, params: [{ [provider.hashKey]: hash }] }),
    });
    if (!response.ok) return null;
    const reply = await response.json() as { jsonrpc?: unknown; id?: unknown; error?: unknown; result?: { status?: unknown } } | null;
    const status = reply?.result?.status;
    if (reply?.jsonrpc !== '2.0' || (reply.id !== 1 && reply.id !== '1') || reply.error || typeof status !== 'string') return null;
    const key = status.toLowerCase().replace(/[ _-]/g, '');
    return Object.hasOwn(statuses, key) ? statuses[key as keyof typeof statuses] : null;
  } catch {
    return null;
  }
}
