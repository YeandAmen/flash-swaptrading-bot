import { spawn } from 'node:child_process';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import QRCode from 'qrcode';
import { formatUnits } from 'viem';
import { CONFIG, GAS_TOPUP, RISK, ROOT, STRATEGY, TOKENS, USDC_DECIMALS } from './config.js';
import { createDashboardCredentialCheck } from './dashboard-auth.js';
import { endpointOrigin, redactDiagnostic } from './diagnostics.js';
import { Engine } from './engine.js';
import type { PortfolioState } from './types.js';

const engine = new Engine();
const app = express();
const dashboardCredentialMatches = CONFIG.allowLiveTrading ? createDashboardCredentialCheck() : null;
const publicDir = path.join(ROOT, 'public');
const liveTradingAllowed = CONFIG.allowLiveTrading || CONFIG.forkMode;
app.disable('x-powered-by');

// Only this machine, only this dashboard: block other hosts (DNS rebinding) and cross-site requests (CSRF).
const allowed = new Set([`127.0.0.1:${CONFIG.port}`, `localhost:${CONFIG.port}`]);
app.use((req: Request, res: Response, next: NextFunction) => {
  const host = req.headers.host ?? '';
  if (!allowed.has(host)) { res.status(403).send('Forbidden host'); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (req.headers.origin !== `http://${host}` || req.headers['x-bot-ui'] !== '1') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'");
  next();
});

function readiness(): { ready: boolean; reason: string } {
  if (engine.stopping) return { ready: false, reason: 'Shutting down' };
  if (engine.liveFault) return { ready: false, reason: 'Live transaction recovery requires review' };
  if (engine.status !== 'running') return { ready: false, reason: engine.status === 'error' ? 'Startup failed' : 'Starting' };
  if (engine.lastError) return { ready: false, reason: 'Market cycle failed' };
  if (!engine.walletReady || engine.state.pending || engine.mev?.walletPending()) {
    return { ready: false, reason: 'Waiting for wallet transaction settlement' };
  }
  if (!engine.lastTickAt || Date.now() - engine.lastTickAt > Math.max(90, CONFIG.loopSeconds * 3) * 1000) {
    return { ready: false, reason: 'Market cycle is stale' };
  }
  if (!engine.snap || (!CONFIG.forkMode && Math.abs(Date.now() - engine.snap.timestamp * 1000) > 90_000)) {
    return { ready: false, reason: 'Ethereum market data is stale' };
  }
  return { ready: true, reason: 'Market cycle is healthy' };
}

// Minimal loopback probes for monitoring. Wallet writes have a separate operator check.
app.get('/api/health', (_req, res) => { res.json({ status: 'ok' }); });
app.get('/api/ready', (_req, res) => {
  const health = readiness();
  res.status(health.ready ? 200 : 503).json(health);
});

app.use(express.json({ limit: '10kb' }));
app.use(express.static(publicDir));

function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = Math.ceil(arr.length / max);
  return arr.filter((_, i) => i % step === 0 || i === arr.length - 1);
}

function portfolioView(pf: PortfolioState) {
  const snap = engine.snap;
  const equity = snap ? engine.equity(pf, snap) : pf.cashUsd;
  const netPnl = pf.kind === 'paper' ? equity - pf.netDepositsUsd : equity - pf.netDepositsUsd - pf.gasSpentUsd;
  return {
    kind: pf.kind,
    equity,
    cashUsd: pf.cashUsd,
    netDepositsUsd: pf.netDepositsUsd,
    netPnlUsd: netPnl,
    netPnlPct: pf.netDepositsUsd > 0 ? netPnl / pf.netDepositsUsd : 0,
    realizedPnlUsd: pf.realizedPnlUsd,
    gasSpentUsd: pf.gasSpentUsd,
    halted: pf.halted,
    pausedUntil: pf.pausedUntil,
    lastDecision: pf.lastDecision,
    cooldowns: Object.fromEntries(Object.entries(pf.cooldowns).filter(([, t]) => t > Date.now())),
    positions: pf.positions.map((pos) => {
      const price = snap ? snap.prices[pos.symbol] : undefined;
      return { ...pos, price, valueUsd: price ? pos.qty * price : null, pnlPct: price ? price / pos.breakevenPrice - 1 : null, ml: engine.mlScores[pos.symbol] ?? null };
    }),
    maxPositions: RISK.maxPositions,
    trades: pf.trades.slice(-60).reverse(),
    recordedTrades: pf.trades.length,
    equityHistory: downsample(pf.equityHistory, 300),
  };
}

app.get('/api/state', (_req, res) => {
  const snap = engine.snap;
  const b = snap?.balances;
  const w = engine.wallet;
  const mev = engine.mev?.view();
  res.json({
    now: Date.now(),
    status: engine.status,
    startupStep: engine.startupStep,
    lastError: engine.lastError && redactDiagnostic(engine.lastError),
    liveFault: engine.liveFault && redactDiagnostic(engine.liveFault),
    walletReady: engine.walletReady,
    health: readiness(),
    liveTradingAllowed,
    forkMode: CONFIG.forkMode,
    lastTickAt: engine.lastTickAt,
    loopSeconds: CONFIG.loopSeconds,
    sendRpc: endpointOrigin(CONFIG.sendRpcUrl),
    wallet: w
      ? {
          address: w.account.address,
          storage: w.storage === 'macOS Keychain' ? w.storage : 'local key file',
          eth: b ? Number(formatUnits(b.eth, 18)) : null,
          usdc: b ? Number(formatUnits(b.usdc, USDC_DECIMALS)) : null,
          tokens: b && engine.market
            ? Object.fromEntries(engine.market.tokens
              .filter((t) => (b.tokens[t.token.symbol] ?? 0n) > 0n)
              .map((t) => [t.token.symbol, Number(formatUnits(b.tokens[t.token.symbol] ?? 0n, t.token.decimals))]))
            : {},
        }
      : null,
    chain: snap ? { block: Number(snap.blockNumber), baseFeeGwei: snap.baseFeeGwei, tipGwei: snap.tipGwei, ethUsd: snap.ethUsd, timestamp: snap.timestamp } : null,
    armed: engine.state.armed,
    armedAt: engine.state.armedAt,
    entriesPaused: engine.state.entriesPaused,
    liveStatus: engine.liveStatus,
    regime: engine.regime,
    costs: engine.costs,
    analyses: topAnalyses(),
    universe: engine.market
      ? {
          scanned: engine.market.tokens.length,
          core: engine.market.tokens.filter((t) => t.token.core).length,
          eligible: engine.analyses.filter((a) => a.eligible).length,
          warming: engine.analyses.filter((a) => a.reasons.some((r) => r.startsWith('too new') || r.startsWith('warming'))).length,
          stats: engine.market.stats,
          discoveredAt: engine.market.discoveredAt,
          refreshing: engine.refreshing,
          mode: TOKENS.mode,
          safetyBlocked: Object.entries(engine.safetyBlocks).filter(([, t]) => t > Date.now()).map(([s]) => s),
          excluded: engine.market.excluded.slice(0, 40),
        }
      : null,
    gas: {
      autoTopup: GAS_TOPUP,
      topups: engine.state.topups.filter((x) => x.usd > 0).slice(-5).reverse(),
      topupsToday: engine.state.topups.filter((x) => Date.now() - x.t < 86_400_000).length,
    },
    paper: portfolioView(engine.state.paper),
    live: portfolioView(engine.state.live),
    backtest: engine.backtest,
    signals: {
      mode: engine.mlActive ? 'ml' : 'rules',
      mlThreshold: engine.mlThreshold,
      researching: engine.researching,
      ranAt: engine.research?.ranAt ?? null,
      ml: engine.research ? { ...engine.research.ml, rulesOos: slimBt(engine.research.ml.rulesOos), mlOos: slimBt(engine.research.ml.mlOos) } : null,
    },
    events: engine.events.slice(-150).reverse().map((event) => ({ ...event, msg: redactDiagnostic(event.msg) })),
    mev: mev ? {
      ...mev,
      status: redactDiagnostic(mev.status),
      lastError: mev.lastError && redactDiagnostic(mev.lastError),
      recent: mev.recent.map((opportunity) => ({ ...opportunity, note: opportunity.note && redactDiagnostic(opportunity.note) })),
    } : null,
    params: { risk: RISK, strategy: STRATEGY, tokens: { ...TOKENS, listUrls: TOKENS.listUrls.map(endpointOrigin) } },
  });
});

function slimBt(b: { equity: unknown; tradeList: unknown } | null) {
  return b ? { ...b, tradeList: undefined } : null;
}

/** Held tokens first, then buy signals (rules or ML), then the strongest scores — enough rows for the dashboard. */
function topAnalyses() {
  const held = new Set([...engine.state.paper.positions, ...engine.state.live.positions].map((p) => p.symbol));
  const byKey = new Map((engine.market?.tokens ?? []).map((t) => [t.token.symbol, t]));
  const ml = engine.mlScores;
  const signal = (a: (typeof engine.analyses)[number]) =>
    engine.mlActive ? (ml[a.symbol] ?? 0) >= engine.mlThreshold : a.eligible && engine.regime.riskOn;
  const strength = (a: (typeof engine.analyses)[number]) =>
    engine.mlActive ? (ml[a.symbol] ?? 0) : Number.isFinite(a.score) ? a.score : -1e6;
  const rank = (a: (typeof engine.analyses)[number]) => (held.has(a.symbol) ? 2e9 : signal(a) ? 1e9 : 0) + strength(a);
  return [...engine.analyses]
    .sort((x, y) => rank(y) - rank(x))
    .slice(0, 30)
    .map((a) => {
      const t = byKey.get(a.symbol);
      return {
        ...a, ml: ml[a.symbol] ?? null, address: t?.token.address, core: t?.token.core ?? false, name: t?.token.name,
        depthUsd: t?.depthUsd, quote: t?.quote, poolFeePct: t?.poolFeePct,
      };
    });
}

app.get('/api/qr.svg', async (_req, res) => {
  if (!engine.wallet) { res.status(503).end(); return; }
  const svg = await QRCode.toString(engine.wallet.account.address, { type: 'svg', margin: 1, color: { dark: '#0b0f17', light: '#ffffff' } });
  res.type('image/svg+xml').send(svg);
});

const kindOf = (req: Request) => (req.body?.kind === 'live' ? 'live' : 'paper') as 'paper' | 'live';

function allowLiveControl(req: Request, res: Response): boolean {
  if (!liveTradingAllowed) { res.status(403).json({ error: 'Live signing is disabled in settings' }); return false; }
  if (!CONFIG.forkMode && !dashboardCredentialMatches?.(req.headers.authorization)) {
    res.status(401).json({ error: 'This live wallet action requires the local operator password.' });
    return false;
  }
  return true;
}

function allowArming(req: Request, res: Response): boolean {
  if (!allowLiveControl(req, res)) return false;
  const health = readiness();
  if (!health.ready) { res.status(503).json({ error: health.reason }); return false; }
  return true;
}

function control(operation: (req: Request) => void | Promise<void | { address: string }>) {
  return async (req: Request, res: Response) => {
    try {
      const result = await operation(req);
      res.json({ ok: true, ...result });
    } catch (error) {
      const message = redactDiagnostic(String((error as Error)?.message ?? error).split('\n')[0]);
      engine.log(`${req.path}: ${message}`, 'warn');
      res.status(409).json({ error: 'The request could not complete. See the activity log.' });
    }
  };
}

app.post('/api/arm', (req, res) => {
  if (req.body?.confirm !== 'LIVE') { res.status(400).json({ error: 'Type LIVE to confirm' }); return; }
  if (allowArming(req, res)) void control(() => engine.arm())(req, res);
});
app.post('/api/disarm', control(() => engine.disarm()));
app.post('/api/mev/deploy', (req, res) => {
  if (req.body?.confirm !== 'DEPLOY') { res.status(400).json({ error: 'Type DEPLOY to confirm' }); return; }
  if (!allowArming(req, res)) return;
  const mev = engine.mev;
  if (!mev) { res.status(503).json({ error: 'MEV is still starting' }); return; }
  void control(async () => ({ address: await mev.deployFromDashboard() }))(req, res);
});
app.post('/api/mev/arm', (req, res) => {
  if (req.body?.confirm !== 'MEV') { res.status(400).json({ error: 'Type MEV to confirm' }); return; }
  if (!allowArming(req, res)) return;
  const mev = engine.mev;
  if (!mev) { res.status(503).json({ error: 'MEV is still starting' }); return; }
  void control(() => mev.arm())(req, res);
});
app.post('/api/mev/disarm', control(() => engine.mev?.disarm()));
app.post('/api/pause', (req, res) => {
  const paused = Boolean(req.body?.paused);
  if (paused || !liveTradingAllowed || allowLiveControl(req, res)) void control(() => engine.setPaused(paused))(req, res);
});
app.post('/api/resume', (req, res) => {
  const kind = kindOf(req);
  if (kind === 'paper' || allowLiveControl(req, res)) void control(() => engine.resume(kind))(req, res);
});
app.post('/api/paper/reset', control(() => engine.resetPaper()));
app.post('/api/backtest', control(() => { void engine.runResearchNow(); }));
app.post('/api/panic', (req, res) => {
  const kind = kindOf(req);
  if (kind === 'paper' || allowLiveControl(req, res)) void control(() => engine.panic(kind))(req, res);
});

const server = app.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`Dashboard: http://127.0.0.1:${CONFIG.port}`);
  void engine.start();
});

// Keep the Mac from sleeping while the bot runs (caffeinate exits by itself when this process exits).
if (process.platform === 'darwin') {
  try {
    const c = spawn('/usr/bin/caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' });
    c.on('error', () => console.error('caffeinate not available; the Mac may sleep'));
    process.on('exit', () => { try { c.kill(); } catch { /* ignore */ } });
  } catch { /* ignore */ }
}

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Shutting down: waiting for any in-flight trade, then saving state...');
  server.close();
  setTimeout(() => process.exit(0), 28_000).unref();
  try { await engine.stop(); } catch { /* ignore */ }
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (e) => console.error('Unhandled promise rejection:', redactDiagnostic(String(e).split('\n')[0])));
