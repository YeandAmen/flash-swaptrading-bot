'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (x, d = 2) => (x == null || !isFinite(x) ? '–' : (x < 0 ? '-$' : '$') + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (x, d = 2) => (x == null || !isFinite(x) ? '–' : (x > 0 ? '+' : '') + (x * 100).toFixed(d) + '%');
const cls = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');
const price = (p) => (p == null ? '–' : p >= 1000 ? usd(p, 0) : p >= 1 ? usd(p, 2) : '$' + p.toPrecision(4));
const time = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const hm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? s + 's ago' : Math.round(s / 60) + 'm ago'; };
const MEV_STALE_AFTER_MS = 60_000;
const isDirectMev = (mev) => mev?.settings?.submission === 'direct';

let S = null;
let stateRequest = null;
let tab = 'live';
let qrLoaded = false;
let panicPending = false;
const mevContractActions = {
  deploy: {
    label: 'Deploy upgradeable FlashArb',
    confirmation: 'DEPLOY',
    impact: 'The bot wallet will own the proxy. The bot uses the new address after verifying the deployment. Spot and MEV are disarmed before signing. Re-arm the modes you want after deployment.',
  },
  upgrade: {
    label: 'Upgrade FlashArb implementation',
    confirmation: 'UPGRADE',
    impact: 'The bot keeps its FlashArb proxy address. This upgrade deploys and installs a new implementation in one transaction. Spot and MEV are disarmed before signing. Re-arm the modes you want after verification.',
  },
};
let mevContractAction = null;
let mevContractSubmitting = false;
let mevContractQuoteRequest = 0;
let mevContractQuote = null;

async function api(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-ui': '1' },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

async function refresh() {
  stateRequest?.abort();
  const request = new AbortController();
  stateRequest = request;
  const timeout = setTimeout(() => request.abort(), 10_000);
  try {
    const r = await fetch('/api/state', { cache: 'no-store', signal: request.signal });
    if (!r.ok) throw new Error(r.statusText);
    const state = await r.json();
    if (stateRequest !== request) return;
    S = state;
    render();
  } catch (e) {
    if (stateRequest !== request) return;
    $('modePill').className = 'pill err'; $('modePill').textContent = 'OFFLINE';
    $('banner').className = 'banner bad';
    $('bannerText').textContent = 'Dashboard data is unavailable. Retrying automatically.';
  } finally {
    clearTimeout(timeout);
    if (stateRequest === request) stateRequest = null;
  }
}

function posList(list, max) {
  if (!list || !list.length) return `<div class="posbox sub">No open positions — holding USDC (up to ${max || 1} at once)</div>`;
  return list.map((p) => `<div class="posbox"><b>${esc(p.symbol)}</b> ${p.qty.toPrecision(5)} · value ${usd(p.valueUsd)} · <span class="${cls(p.pnlPct)}">${pct(p.pnlPct)}</span> vs breakeven${p.ml != null ? ` · AI ${(p.ml * 100).toFixed(0)}%` : ''}
    <div class="sub">entry ${price(p.entryMid)} · stop ${price(p.stopPrice)}${p.trailActive ? ' (trailing)' : ''} · target ${price(p.targetPrice)} · since ${time(p.entryTime)}</div></div>`).join('');
}

function renderNetworks(networks) {
  const arb = networks?.arbitrum;
  const solana = networks?.solana;
  const routes = solana?.result?.routes;
  const rows = [];
  if (arb && arb.mode !== 'off') {
    const executor = arb.executor ? ` <a target="_blank" rel="noopener noreferrer" href="https://arbiscan.io/address/${esc(arb.executor)}">Executor ↗</a>` : '';
    const settled = arb.settled ? ` · <a target="_blank" rel="noopener noreferrer" href="https://arbiscan.io/tx/${esc(arb.settled.hash)}">${esc(arb.settled.status)}</a> ${usd(arb.settled.netUsd)} net` : '';
    rows.push(['Arbitrum One', arb.mode, arb.block, arb.routes, arb.balanceEth ? `${esc(arb.balanceEth.slice(0, 12))} ETH` : '–', esc(arb.status) + executor + settled]);
  }
  if (solana && solana.mode !== 'off') {
    const balance = solana.result?.walletSol;
    const qualified = routes?.filter((route) => route.qualified).length;
    const order = solana.execution;
    const completed = ['Unsigned scan completed', 'Guarded live scan completed'].includes(solana.status);
    const status = completed && qualified !== undefined ? `${qualified} qualifying routes` : solana.status;
    const outcome = order?.lastOutcome;
    const settled = outcome ? ` · <a target="_blank" rel="noopener noreferrer" href="https://explorer.solana.com/tx/${esc(outcome.signature)}">${esc(outcome.status)}</a>${Number.isFinite(outcome.netUsdc) ? ` ${usd(outcome.netUsdc)} net` : ''}` : '';
    rows.push(['Solana', solana.mode, solana.result?.slot, routes?.length, Number.isFinite(balance) ? `${balance.toFixed(6)} SOL` : '–',
      esc(order?.pending ? 'Waiting for transaction settlement' : status) + settled]);
  }
  $('extraNetworks').hidden = rows.length === 0;
  $('arbitrumModeBtn').hidden = !arb?.canArm;
  $('arbitrumModeBtn').textContent = arb?.mode === 'live' ? 'Disarm Arbitrum' : 'Arm Arbitrum';
  $('solanaModeBtn').hidden = !solana?.canArm;
  $('solanaModeBtn').textContent = solana?.mode === 'live' ? 'Disarm Solana' : 'Arm Solana';
  $('extraNetworkRows').innerHTML = rows.map(([name, mode, block, routes, balance, status]) =>
    `<tr><td>${name}</td><td>${esc(mode)}</td><td class="r">${block ? block.toLocaleString() : '–'}</td><td class="r">${routes ?? '–'}</td><td class="r">${balance}</td><td>${status}</td></tr>`).join('');
}

function render() {
  if (!S) return;
  renderNetworks(S.networks);
  const c = S.chain;
  $('cBlock').textContent = c ? c.block.toLocaleString() : '–';
  const g = (x) => (x < 0.01 ? x.toPrecision(2) : x.toFixed(2));
  $('cGas').textContent = c ? g(c.baseFeeGwei) + ' + ' + g(c.tipGwei) + ' gwei' : '–';
  $('cEth').textContent = c ? usd(c.ethUsd, 0) : '–';
  $('cAgo').textContent = S.lastTickAt ? ago(S.lastTickAt) : '–';

  // mode + banner
  const pill = $('modePill');
  const banner = $('banner');
  const mev = S.mev;
  const now = Number.isFinite(S.now) ? S.now : Date.now();
  const scanAt = mev?.lastBlock?.at;
  const directPending = mev?.pending?.kind === 'direct';
  const scanAge = (mev?.mode === 'live' || directPending) && Number.isFinite(scanAt) && scanAt > 0 ? now - scanAt : null;
  const staleScan = scanAge !== null && scanAge > MEV_STALE_AFTER_MS
    ? `Last MEV scan was ${Math.floor(scanAge / 1000)} seconds ago.` : '';
  const pendingTarget = mev?.pending?.target;
  const scanBlock = mev?.lastBlock?.number;
  const waitingForMev = S.health?.ready === false && S.health.reason === 'Waiting for wallet transaction settlement'
    && !S.forkMode && !mev?.lastError && !mev?.deploymentPending && !mev?.upgradePending
    && scanAge !== null && scanAge >= 0 && !staleScan
    && (directPending || (Number.isSafeInteger(scanBlock) && Number.isSafeInteger(pendingTarget)
      && pendingTarget >= scanBlock - 3 && pendingTarget <= scanBlock + 1));
  if (S.liveFault) {
    pill.className = 'pill err'; pill.textContent = 'RECOVERY';
    banner.className = 'banner bad'; $('bannerText').textContent = S.liveFault;
  } else if (S.status === 'starting') {
    pill.className = 'pill wait'; pill.textContent = 'STARTING';
    banner.className = 'banner warn'; $('bannerText').textContent = 'Starting: ' + S.startupStep + '…';
  } else if (S.status === 'error' || S.lastError) {
    pill.className = 'pill err'; pill.textContent = S.status === 'error' ? 'ERROR' : (S.armed ? 'LIVE' : 'PAPER');
    banner.className = 'banner bad'; $('bannerText').textContent = 'Problem: ' + (S.lastError || 'unknown') + ' — the bot retries automatically.';
  } else if (waitingForMev) {
    pill.className = 'pill wait'; pill.textContent = 'SETTLING';
    banner.className = 'banner warn';
    $('bannerText').textContent = directPending
      ? 'Scanning while the direct MEV transaction awaits on-chain settlement.'
      : `Scanning while the MEV bundle for block ${pendingTarget.toLocaleString()} settles.`;
  } else if (!S.health.ready) {
    pill.className = 'pill err'; pill.textContent = 'UNREADY';
    banner.className = 'banner bad'; $('bannerText').textContent = S.health.reason;
  } else if (!S.forkMode && staleScan) {
    pill.className = 'pill err'; pill.textContent = 'MEV STALE';
    banner.className = 'banner bad'; $('bannerText').textContent = staleScan;
  } else if (S.forkMode) {
    pill.className = 'pill paper'; pill.textContent = 'LOCAL FORK';
    banner.className = 'banner'; $('bannerText').textContent = 'Connected to a local Ethereum fork with test funds.';
  } else if (S.armed && S.liveStatus.ready) {
    pill.className = 'pill live'; pill.textContent = 'LIVE';
    banner.className = 'banner ok'; $('bannerText').textContent = 'Live trading active. ' + (S.live.lastDecision || '');
  } else if (S.armed) {
    pill.className = 'pill wait'; pill.textContent = 'ARMED';
    banner.className = 'banner warn'; $('bannerText').textContent = S.liveStatus.reason;
  } else {
    pill.className = 'pill paper'; pill.textContent = 'PAPER';
    banner.className = 'banner'; $('bannerText').textContent = S.liveTradingAllowed
      ? 'Paper trading with on-chain prices. Live modes start disarmed.'
      : 'Paper trading with on-chain prices. Set ALLOW_LIVE_TRADING=on in .env and restart to enable live signing.';
  }

  // wallet
  const w = S.wallet;
  if (w) {
    $('wAddr').textContent = w.address;
    $('wStorage').textContent = 'key: ' + w.storage;
    $('ethLink').href = 'https://etherscan.io/address/' + w.address;
    $('wUsdc').textContent = w.usdc == null ? '–' : w.usdc.toFixed(2);
    $('wEth').textContent = w.eth == null ? '–' : w.eth.toFixed(5) + (c ? ' (' + usd(w.eth * c.ethUsd) + ')' : '');
    const held = Object.entries(w.tokens || {}).filter(([, v]) => v > 0);
    $('wTokens').textContent = held.length ? held.map(([k, v]) => v.toPrecision(4) + ' ' + k).join(', ') : 'none';
    if (!qrLoaded) { $('qr').src = '/api/qr.svg'; qrLoaded = true; }
  }
  const G = S.gas;
  if (G) {
    const a = G.autoTopup;
    const last = G.topups && G.topups[0];
    $('wGas').textContent = a.enabled
      ? `When spot is armed · buys ${usd(a.usd)} of ETH below ${a.belowEth} ETH · ${G.topupsToday}/${a.maxPerDay} attempts in 24h` + (last ? ` · last ${last.eth.toFixed(5)} ETH ${time(last.t)}` : '')
      : 'OFF';
  }
  $('armBtn').hidden = S.armed;
  $('armBtn').disabled = !S.liveTradingAllowed || !S.health.ready;
  $('disarmBtn').hidden = !S.armed && !S.mev?.armed;
  $('wNote').hidden = !S.liveTradingAllowed || S.forkMode;

  // live
  const L = S.live;
  $('lEq').textContent = usd(L.equity);
  $('lPnl').innerHTML = L.netDepositsUsd > 0 ? `Net P&amp;L <span class="${cls(L.netPnlUsd)}">${usd(L.netPnlUsd)} (${pct(L.netPnlPct)})</span> after gas` : 'No deposits yet';
  $('lPos').innerHTML = posList(L.positions, L.maxPositions);
  $('lDep').textContent = usd(L.netDepositsUsd);
  $('lReal').innerHTML = `<span class="${cls(L.realizedPnlUsd)}">${usd(L.realizedPnlUsd)}</span>`;
  $('lGas').textContent = usd(L.gasSpentUsd);
  $('lDecision').textContent = (L.halted ? 'HALTED: ' + L.halted + ' · ' : '') + (S.armed ? L.lastDecision : S.liveStatus.reason);
  $('liveTag').innerHTML = S.armed ? '<span class="tag up">ARMED</span>' : '<span class="tag flat">OFF</span>';

  // paper
  const P = S.paper;
  $('pEq').textContent = usd(P.equity);
  $('pPnl').innerHTML = `Net P&amp;L <span class="${cls(P.netPnlUsd)}">${usd(P.netPnlUsd)} (${pct(P.netPnlPct)})</span> from ${usd(P.netDepositsUsd)}`;
  $('pPos').innerHTML = posList(P.positions, P.maxPositions);
  $('pReal').innerHTML = `<span class="${cls(P.realizedPnlUsd)}">${usd(P.realizedPnlUsd)}</span>`;
  $('pGas').textContent = usd(P.gasSpentUsd);
  $('pTrades').textContent = P.recordedTrades;
  $('pDecision').textContent = (P.halted ? 'HALTED: ' + P.halted + ' · ' : '') + P.lastDecision;

  // brain
  $('regime').innerHTML = `Market: <span class="${S.regime.riskOn ? 'pos' : 'amb'}">${S.regime.riskOn ? 'RISK-ON' : 'RISK-OFF'}</span> — ${esc(S.regime.reason)}`;
  const heldSet = new Set([...(P.positions || []), ...(L.positions || [])].map((p) => p.symbol));
  const SG = S.signals || {};
  const mlMode = SG.mode === 'ml';
  const U = S.universe;
  if (U) {
    const st = U.stats || {};
    $('uniStats').textContent = `Signals: ${mlMode ? `AI model (buys when probability ≥ ${(SG.mlThreshold * 100).toFixed(0)}%)` : 'rules'} · ` +
      `Scanning ${U.scanned} tokens (${U.core} core + ${U.scanned - U.core} from token lists) · ` +
      `${U.eligible} with a rule signal · ${U.warming} still collecting history · ` +
      `${st.safetyRejected ?? 0} rejected by the honeypot/tax check · from ${st.candidates ?? '?'} listed tokens (${st.withPool ?? '?'} with a Uniswap v3 pool)` +
      (U.refreshing ? ' · refreshing universe…' : ` · refreshed ${time(U.discoveredAt)}`);
    $('rejected').innerHTML = (U.excluded || []).length
      ? U.excluded.map((e) => `<div><b>${esc(e.symbol)}</b> — ${esc(e.reason)}</div>`).join('')
      : 'None right now.';
  }
  const symCell = (a) => {
    const [s, tag] = String(a.symbol).split('.');
    const label = `<b>${esc(s)}</b>${tag ? `<span class="sub">.${esc(tag)}</span>` : ''}${a.core ? '' : ' <span class="tag flat" title="long-tail token: max 50% of equity">LT</span>'}`;
    return a.address ? `<a href="https://etherscan.io/token/${esc(a.address)}" target="_blank" rel="noopener noreferrer" title="${esc(a.name || a.symbol)}" style="color:inherit;text-decoration:none">${label}</a>` : label;
  };
  $('anaBody').innerHTML = (S.analyses || []).map((a) => {
    let decision;
    const aiOk = a.ml != null && a.ml >= SG.mlThreshold;
    if (heldSet.has(a.symbol)) decision = '<span class="tag buy">HOLDING</span>';
    else if (mlMode && aiOk) decision = '<span class="tag buy">AI BUY SIGNAL</span>';
    else if (!mlMode && a.eligible && S.regime.riskOn) decision = '<span class="tag buy">BUY SIGNAL</span>';
    else if (!mlMode && a.eligible) decision = '<span class="tag sell">SIGNAL, MARKET RISK-OFF</span>';
    else decision = '<span class="why">' + esc((mlMode ? [`AI ${a.ml == null ? 'n/a' : (a.ml * 100).toFixed(0) + '%'} < ${(SG.mlThreshold * 100).toFixed(0)}%`] : a.reasons).join(' · ')) + '</span>';
    const aiCell = a.ml == null ? '–' : `<span class="${aiOk ? 'pos' : ''}">${(a.ml * 100).toFixed(0)}%</span>`;
    return `<tr><td>${symCell(a)}</td><td class="r">${aiCell}</td><td class="r">${price(a.price)}</td><td class="r ${cls(a.change24h)}">${pct(a.change24h, 1)}</td>
      <td><span class="tag ${a.trend}">${a.trend}</span></td><td class="r">${a.momentum.toFixed(2)}σ</td><td class="r">${a.rsi.toFixed(0)}</td>
      <td class="r">${(a.dailyVol * 100).toFixed(1)}%</td><td class="r">-${(a.stopPct * 100).toFixed(1)}% / +${(a.targetPct * 100).toFixed(1)}%</td><td>${decision}</td></tr>`;
  }).join('');
  const k = S.costs;
  $('costNote').textContent = k ? `Cost of one swap right now: ~${usd(k.gasPerSwapUsd)} gas (incl. approval). A $50 round trip costs ~${pct(k.roundTripPctAt50)} with pool fees, so the bot only buys when the target move is ≥ ${pct(k.hurdlePctAt50)}.` : '';

  // trades
  const trades = (tab === 'live' ? L : P).trades;
  $('tradeBody').innerHTML = trades.length ? trades.map((t) => `<tr><td>${time(t.time)}</td><td><span class="tag ${t.side === 'BUY' ? 'buy' : 'sell'}">${t.side}</span></td><td>${esc(t.symbol)}</td>
      <td class="r">${usd(t.usd)}</td><td class="r">${price(t.price)}</td><td class="r">${usd(t.gasUsd)}</td>
      <td class="r ${cls(t.pnlUsd)}">${t.pnlUsd == null ? '' : usd(t.pnlUsd)}</td><td class="why">${esc(t.reason)}${(t.txHashes || []).map((h) => ` <a href="https://etherscan.io/tx/${esc(h)}" target="_blank" rel="noopener noreferrer">tx↗</a>`).join('')}</td></tr>`).join('')
    : `<tr><td colspan="8" class="empty">No ${tab} trades yet. The bot waits for a strong uptrend whose expected move beats its costs.</td></tr>`;

  // backtest
  const b = S.backtest;
  if (b) {
    $('btRange').textContent = `${new Date(b.from).toLocaleDateString()} → ${new Date(b.to).toLocaleDateString()}`;
    $('btRet').innerHTML = `<span class="${cls(b.returnPct)}">${pct(b.returnPct)}</span>`;
    $('btEth').innerHTML = `<span class="${cls(b.ethHoldPct)}">${pct(b.ethHoldPct)}</span>`;
    $('btDD').textContent = pct(-b.maxDrawdownPct);
    $('btTrades').textContent = b.trades;
    $('btWin').textContent = b.trades ? pct(b.winRate, 0).replace('+', '') : '–';
    $('btGas').textContent = usd(b.gasPaidUsd);
    $('btNote').textContent = 'Rule-based strategy replayed on on-chain hourly prices. ' + b.assumptions + '. A short history is not proof of future results.';
    spark($('btSpark'), b.equity, b.startUsd);
  }

  // AI model (walk-forward)
  const M = SG.ml;
  if (SG.researching && !M) $('mlSummary').textContent = 'Training and testing the model…';
  if (M) {
    const aucTxt = M.auc == null ? 'n/a' : M.auc.toFixed(3);
    $('mlMode').innerHTML = M.active ? '<span class="tag buy">AI ACTIVE</span>' : '<span class="tag flat">RULES IN CHARGE</span>';
    $('mlSummary').innerHTML = `${esc(M.reason)}.` +
      `<div class="sub" style="margin-top:6px">Final holdout since ${M.oosFrom ? new Date(M.oosFrom).toLocaleDateString() : '–'} · ${M.folds} re-trains · ${(M.oosRows || 0).toLocaleString()} labelled holdout token-hours · base rate ${M.baseRate == null ? '–' : pct(M.baseRate, 1).replace('+', '')} · last run ${SG.ranAt ? time(SG.ranAt) : '–'}${SG.researching ? ' · re-training…' : ''}</div>`;
    $('mlAuc').textContent = aucTxt;
    $('mlAuc').className = 'v ' + (M.auc != null && M.auc >= 0.55 ? 'pos' : 'amb');
    $('mlRules').innerHTML = M.rulesOos ? `<span class="${cls(M.rulesOos.returnPct)}">${pct(M.rulesOos.returnPct)}</span>` : '–';
    $('mlBest').innerHTML = M.mlOos ? `<span class="${cls(M.mlOos.returnPct)}">${pct(M.mlOos.returnPct)}</span> <span class="sub">${M.threshold}× base rate</span>` : '–';
    $('mlThr').innerHTML = (M.thresholds || []).map((x) => `<span>Calibration ≥ ${x.threshold}× base rate</span><span><span class="${cls(x.returnPct)}">${pct(x.returnPct)}</span> · ${x.trades} trades · DD ${pct(-x.maxDrawdownPct, 1)}</span>`).join('');
    $('mlFeat').textContent = (M.importance || []).map((f) => `${f.name} ${f.weight >= 0 ? '+' : ''}${f.weight.toFixed(2)}`).join(' · ');
  }

  // MEV arbitrage
  const X = S.mev;
  if (X) {
    const tag = { live: 'buy', paper: 'flat', deploying: 'sell', arming: 'sell', off: 'flat' }[X.mode] || 'flat';
    $('mevMode').innerHTML = `<span class="tag ${tag}">${esc(String(X.mode).toUpperCase())}</span>`;
    const direct = isDirectMev(X);
    const venues = Object.entries(X.venues || {}).map(([k, v]) => `${v} ${k}`).join(', ');
    const lb = X.lastBlock;
    const C = X.coverage;
    const coverage = C?.mode === 'all'
      ? ` · discovery ${C.phase}: ${C.checked.toLocaleString()}/${C.candidates.toLocaleString()} addresses checked, ${C.eligible.toLocaleString()} eligible, ${C.maxPools} pool limit`
      : '';
    const timing = lb?.decisionMs == null ? '' : ` · ${lb.readMs} ms pool reads, ${lb.decisionMs} ms decisions`;
    const missingReads = lb?.failedChunks > 0 ? ` · ${lb.failedChunks} pool batches unavailable` : '';
    const P = X.settings?.activeProfitPolicy;
    const maxLoanUsd = X.settings?.maxLoanUsd;
    const loanCap = Number.isFinite(maxLoanUsd) ? ` · Loan cap ${usd(maxLoanUsd, Number.isInteger(maxLoanUsd) ? 0 : 2)}` : '';
    const padding = P?.gasPaddingPct == null ? '' : ` · ${Math.round(P.gasPaddingPct * 100)}% gas buffer`;
    const bidding = direct && Number.isFinite(P?.minNetUsd) ? ` · ${usd(P.minNetUsd)} minimum net per attempt${padding}`
      : P?.idle ? ` · idle bidding with a ${usd(P.minNetUsd)} net floor and up to ${Math.round(P.builderTipPct * 100)}% of after-gas profit bid${padding}` : '';
    const transport = X.mode === 'live' ? '' : direct ? 'Direct Ethereum transactions · ' : 'Private bundles · ';
    $('mevStatus').textContent = (staleScan ? 'Scan is stale · ' : '') + `${transport}${X.status} · watching ${X.tokens} tokens in ${X.pools} pools${venues ? ` (${venues})` : ''}` +
      coverage + loanCap + bidding + (lb ? ` · last block ${lb.number.toLocaleString()} ${ago(lb.at)}` : '') + timing + missingReads + (X.lastError ? ` · last error: ${X.lastError}` : '');
    const st = X.stats;
    $('mevBlocks').textContent = st.blocks.toLocaleString();
    const B = X.bestThisHour?.exact ? X.bestThisHour : null;
    const bestVal = !B ? '<span class="sub">No successful simulation this hour</span>' : B.grossUsd != null
      ? `<span class="${B.grossUsd > B.gasUsd ? 'pos' : ''}">${usd(B.grossUsd)}</span> <span class="sub">vs ${usd(B.gasUsd)} gas</span>`
      : `${B.grossEth.toFixed(5)} <span class="sub">vs ${B.gasEth.toFixed(5)} ETH gas</span>`;
    $('mevGap').innerHTML = bestVal + (B ? `<div class="sub">${esc(B.symbol)}${direct ? '' : ' · before builder bid'}</div>` : '');
    $('mevSims').textContent = `${st.simulated} / ${st.profitable}`;
    $('mevSubmissionLabel').textContent = direct ? 'Direct attempts / landed' : 'Bundles sent / landed';
    $('mevBundles').textContent = direct
      ? `${st.directAttempts ?? 0} / ${st.directLanded ?? 0}`
      : `${st.bundles} / ${st.landed - (st.directLanded ?? 0)}`;
    $('mevProfit').innerHTML = `<span class="${cls(st.netEth)}">${st.netEth.toFixed(5)} ETH</span> <span class="sub">${usd(st.netUsd)}</span>`;
    $('mevRpc').textContent = st.rpcCalls.toLocaleString();
    const rTag = { landed: 'buy', 'would send': 'buy', sent: 'sell', failed: 'down' };
    const mevBody = $('mevBody');
    const openSubmissions = new Set(Array.from(mevBody.querySelectorAll('details[open]'), (item) => item.dataset.target));
    mevBody.innerHTML = (X.recent || []).length ? X.recent.map((o) => `<tr><td>${hm(o.t)}</td><td><b>${esc(o.symbol)}</b></td>
      <td class="why">${esc(o.buy)} → ${esc(o.sell)}${o.funding ? `<div class="sub">${esc(o.funding)}</div>` : ''}</td><td class="r">${o.sizeEth.toFixed(3)}</td><td class="r">${o.grossEth.toFixed(5)}</td>
      <td class="r">${o.gasEth.toFixed(5)}</td><td class="r ${cls(o.netEth)}">${o.netEth.toFixed(5)}</td>
      <td><span class="tag ${rTag[o.status] || 'flat'}">${esc(o.status)}</span>${o.count > 1 ? ` <span class="sub">×${o.count}</span>` : ''}
      <span class="why">${esc(o.note || '')}</span>${o.hash && (o.status === 'landed' || (o.submission?.kind === 'direct' && !S.forkMode)) ? ` <a href="https://etherscan.io/tx/${esc(o.hash)}" target="_blank" rel="noopener noreferrer">tx↗</a>` : ''}${submissionDetails(o.submission, openSubmissions)}</td></tr>`).join('')
      : '<tr><td colspan="8" class="empty">No price gap has beaten pool fees + gas yet. Small gaps are usually closed by professional bots in the same block.</td></tr>';
  }
  renderMevWindow(X?.scanWindow, isDirectMev(X) ? X.settings.direct : null);
  renderMevCadence(isDirectMev(X) ? X.cadence : null);
  renderMevControls(X);

  // log
  $('log').innerHTML =(S.events || []).map((e) => `<div><span class="t">${hm(e.t)}</span><span class="${e.level}">${esc(e.msg)}</span></div>`).join('');

  // controls
  $('pauseBtn').textContent = S.entriesPaused ? 'Resume new entries' : 'Pause new entries';
  $('panicLiveBtn').disabled = !S.liveTradingAllowed || panicPending;
  $('panicPaperBtn').disabled = !(P.positions && P.positions.length);
  $('sendRpc').textContent = S.sendRpc;
  const r = S.params.risk;
  $('params').innerHTML = [
    ['Risk per trade', (r.riskPerTradePct * 100).toFixed(1) + '% of equity'], ['Max slippage', (r.maxSlippageBps / 100).toFixed(2) + '%'],
    ['Daily loss stop', pct(-r.dailyLossLimitPct, 0)], ['Drawdown halt', pct(-r.maxDrawdownPct, 0)],
    ['Max entry gas', r.maxEntryGasGwei + ' gwei'], ['Approvals', r.approvalMode === 'exact' ? 'exact amount only' : 'unlimited'],
  ].map(([a, v]) => `<span>${a}</span><span>${v}</span>`).join('');
}

function renderMevWindow(scanWindow, gas) {
  const scan = $('mevScanWindow');
  scan.hidden = !scanWindow;
  if (scanWindow) {
    const { blocks, candidates, simulations, bestNetUsd, caughtUp, missedSnapshots, queuedSnapshots } = scanWindow;
    const metrics = [
      `${blocks.toLocaleString()} blocks`, `${candidates.toLocaleString()} candidates`, `${simulations.toLocaleString()} simulations`,
    ];
    if (Number.isFinite(bestNetUsd)) metrics.push(`best simulated net ${usd(bestNetUsd)}`);
    if (caughtUp > 0) metrics.push(`${caughtUp.toLocaleString()} recovered snapshot${caughtUp === 1 ? '' : 's'} since restart`);
    if (queuedSnapshots > 0) metrics.push(`${queuedSnapshots.toLocaleString()} queued snapshot${queuedSnapshots === 1 ? '' : 's'}`);
    if (missedSnapshots > 0) metrics.push(`${missedSnapshots.toLocaleString()} unrecovered gap${missedSnapshots === 1 ? '' : 's'} since restart`);
    scan.textContent = 'Last 30 minutes · ' + metrics.join(' · ');
  }
  const costs = $('mevDirectGas');
  costs.hidden = !gas;
  if (gas) costs.textContent = `Direct gas · ${usd(gas.spentGasUsd)} spent in 24 hours · limits ${usd(gas.maxGasUsd)} per attempt and ${usd(gas.dailyGasUsd)} per 24 hours`;
}

function renderMevCadence(cadence) {
  const element = $('mevDirectCadence');
  element.hidden = !cadence;
  if (!cadence) return;

  const { state, elapsedMs, lastLandedAt, intervalMs, routeLimit, baseRouteLimit } = cadence;
  const minuteMs = 60_000;
  const target = Math.round(intervalMs / minuteMs);
  const remainingMs = Number.isFinite(elapsedMs) ? intervalMs - elapsedMs : null;
  const due = remainingMs === null ? 'scanning for a fill'
    : remainingMs > 0 ? `due in ${Math.ceil(remainingMs / minuteMs)} min` : 'due now';
  const timing = state === 'paper' ? 'paper mode' : state === 'overdue' ? 'overdue' : due;
  const parts = [`${target}-minute direct trade target`, timing];
  if (routeLimit > baseRouteLimit) {
    parts.push(`expanded search checks up to ${routeLimit} routes per block`);
  }
  parts.push(Number.isFinite(lastLandedAt) && lastLandedAt > 0
    ? `last confirmed direct fill ${time(lastLandedAt)}` : 'no confirmed direct fills');
  element.textContent = parts.join(' · ');
}

function submissionDetails(submission, openSubmissions) {
  if (!submission) return '';
  const { kind, target, leadMs, netUsd, gasEth, tipEth, builders } = submission;
  const key = `${kind === 'direct' ? 'direct' : 'bundle'}-${target}`;
  const open = openSubmissions.has(key) ? ' open' : '';
  if (kind === 'direct') {
    return `<details class="sub" data-target="${esc(key)}"${open}><summary>Direct transaction · route deadline block ${esc(target)}</summary>
      <div>Maximum network fee ${gasEth.toFixed(6)} ETH · simulated net ${usd(netUsd)}</div></details>`;
  }
  const timing = `${(Math.abs(leadMs) / 1000).toFixed(2)}s ${leadMs >= 0 ? 'before' : 'after'} expected slot`;
  return `<details class="sub" data-target="${esc(key)}"${open}><summary>Bundle for block ${esc(target)}</summary>
    <div>${timing} · quoted net ${usd(netUsd)}</div>
    <div>Gas budget ${gasEth.toFixed(6)} ETH · builder bid ${tipEth.toFixed(6)} ETH</div>
    ${builders.map((builder) => `<div title="${esc(builder.bundleHash || '')}">${esc(builder.builder)} · ${esc(builder.detail)} · ${esc(builder.elapsedMs)} ms${builder.traceStatus ? ` · trace ${esc(builder.traceStatus)}` : ''}</div>`).join('')}
    </details>`;
}

function availableMevContractAction(mev) {
  if (mev?.mode === 'off') return null;
  if (mev?.canUpgradeProxy === true) return 'upgrade';
  return mev?.canDeployProxy === true ? 'deploy' : null;
}

function renderMevControls(X) {
  const contract = X?.contract || X?.configuredContract;
  const isProxy = X?.contractVersion === 'proxy';
  const contractName = isProxy ? 'FlashArb proxy' : 'Legacy FlashArb';
  const off = X?.mode === 'off';
  const direct = isDirectMev(X);
  const needsDirectLimits = direct && X.settings.direct?.enabled !== true;
  const action = availableMevContractAction(X);
  let reason = '';
  if (!X) reason = 'Waiting for bot status.';
  else if (off) reason = 'MEV scanning is disabled by MEV=off in .env.';
  else if (X.upgradePending) reason = 'Waiting for the FlashArb upgrade receipt.';
  else if (X.deploymentPending) reason = 'Waiting for the FlashArb deployment receipt.';
  else if (X.mode === 'upgrading' || (mevContractSubmitting && mevContractAction === 'upgrade')) reason = 'Preparing the FlashArb upgrade…';
  else if (X.mode === 'deploying' || mevContractSubmitting) reason = 'Preparing the FlashArb deployment…';
  else if (X.mode === 'arming') reason = `Checking ${contractName} before arming…`;
  else if (!S.liveTradingAllowed) reason = 'Set ALLOW_LIVE_TRADING=on in .env and restart to enable contract changes and live MEV.';
  else if (X.pending) reason = X.pending.kind === 'direct'
    ? 'Waiting for the direct MEV transaction to settle.'
    : 'Waiting for a submitted MEV bundle to settle.';
  else if (!S.health.ready) reason = S.health.reason || 'Waiting for the bot to be ready.';

  const actionButton = $('mevDeployBtn');
  actionButton.hidden = action === null;
  actionButton.disabled = Boolean(reason || action === null);
  if (action) actionButton.textContent = mevContractActions[action].label;
  $('mevArmBtn').hidden = Boolean(X?.armed || off);
  $('mevArmBtn').disabled = Boolean(reason || !contract || X?.armed || needsDirectLimits);
  $('mevArmBtn').textContent = direct ? 'Arm direct MEV' : 'Arm MEV (live bundles)';
  $('mevDisarmBtn').hidden = !X?.armed;
  $('mevContract').hidden = !contract;
  $('mevContract').textContent = contract ? `${contractName} ${contract}${X.contract ? '' : ' (configured)'}` : '';
  const implementation = $('mevImplementation');
  implementation.hidden = !(isProxy && X.proxyImplementation);
  implementation.textContent = implementation.hidden ? '' : `Implementation ${X.proxyImplementation}`;
  const status = reason || (action === 'deploy' && !contract ? 'Deploy upgradeable FlashArb to enable MEV arming.'
    : needsDirectLimits ? 'Set MEV_DIRECT_MAX_GAS_USD and MEV_DIRECT_DAILY_GAS_USD to enable direct MEV arming.' : '');
  const statusNode = $('mevDeploy');
  if (statusNode.textContent !== status) statusNode.textContent = status;
  statusNode.hidden = !status;
  updateMevContractConfirm();
  updateMevArmConfirm();
}

function spark(svg, pts, base) {
  if (!pts || pts.length < 2) { svg.innerHTML = ''; return; }
  const W = 400, H = 110, pad = 6;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]).concat([base]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const X = (x) => pad + ((x - x0) / (x1 - x0 || 1)) * (W - 2 * pad);
  const Y = (y) => H - pad - ((y - y0) / (y1 - y0 || 1)) * (H - 2 * pad);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join(' ');
  const end = pts[pts.length - 1][1];
  const col = end >= base ? 'var(--green)' : 'var(--red)';
  svg.innerHTML = `<line x1="0" x2="${W}" y1="${Y(base)}" y2="${Y(base)}" stroke="#2b3550" stroke-dasharray="4 4"/>
    <path d="${d}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
}

// ---- events
$('copyBtn').onclick = async () => {
  if (!S?.wallet) return;
  try { await navigator.clipboard.writeText(S.wallet.address); $('copyBtn').textContent = 'Copied ✓'; setTimeout(() => ($('copyBtn').textContent = 'Copy address'), 1500); } catch { /* ignore */ }
};
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => {
  tab = b.dataset.tab;
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  render();
}));
const dlg = $('armDlg');
$('armBtn').onclick = () => { $('armInput').value = ''; $('armConfirm').disabled = true; dlg.showModal(); };
$('armInput').oninput = () => ($('armConfirm').disabled = $('armInput').value.trim() !== 'LIVE');
$('armCancel').onclick = () => dlg.close();
$('armConfirm').onclick = async () => {
  const typed = $('armInput').value.trim();
  if (typed !== 'LIVE') return;
  try { await api('/api/arm', { confirm: typed }); dlg.close(); refresh(); } catch (e) { alert(e.message); }
};
$('disarmBtn').onclick = async () => {
  if (!confirm('Disarm live trading across all networks? Open positions stay in the wallet. Submitted transactions can still settle.')) return;
  try { await api('/api/disarm'); } catch (e) { alert(e.message); }
  refresh();
};
$('arbitrumModeBtn').onclick = async () => {
  const arm = S?.networks?.arbitrum?.mode !== 'live';
  try {
    if (arm) {
      if (prompt('Type ARBITRUM to enable live arbitrage and gas spend on Arbitrum One.')?.trim() !== 'ARBITRUM') return;
      await api('/api/arbitrum/arm', { confirm: 'ARBITRUM' });
    } else {
      await api('/api/arbitrum/disarm');
    }
    refresh();
  } catch (error) { alert(error.message); }
};
$('solanaModeBtn').onclick = async () => {
  const arm = S?.networks?.solana?.mode !== 'live';
  try {
    if (arm) {
      if (prompt('Type SOLANA to enable live arbitrage and SOL fees.')?.trim() !== 'SOLANA') return;
      await api('/api/solana/arm', { confirm: 'SOLANA' });
    } else {
      await api('/api/solana/disarm');
    }
    refresh();
  } catch (error) { alert(error.message); }
};
const mevDeployDlg = $('mevDeployDlg');
function updateMevContractConfirm() {
  const action = mevContractActions[mevContractAction];
  $('mevDeployConfirm').disabled = !action || mevContractAction !== availableMevContractAction(S?.mev)
    || $('mevDeployBtn').disabled || mevContractQuote === null
    || $('mevDeployInput').value.trim() !== action.confirmation;
}
async function loadMevContractQuote(action) {
  mevContractQuote = null;
  updateMevContractConfirm();
  const releaseLabel = $('mevDeployRelease');
  releaseLabel.hidden = true;
  const transaction = action === 'upgrade' ? 'The upgrade' : 'Deployment';
  const fee = S.forkMode
    ? `${transaction} spends test ETH from the bot wallet on this local fork.`
    : `${transaction} sends a mainnet transaction and spends real ETH from the bot wallet.`;
  $('mevDeployGas').textContent = fee + ' Checking current gas prices…';
  const request = ++mevContractQuoteRequest;
  try {
    const response = await fetch(`/api/mev/${action}/quote`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error();
    const quote = await response.json();
    if (request !== mevContractQuoteRequest || !mevDeployDlg.open) return;
    if (quote.version !== 'proxy' || typeof quote.release !== 'string' || !/^0x[a-f0-9]{64}$/i.test(quote.release)
      || (quote.maximumWei === null) !== (quote.maximumEth === null)
      || (quote.maximumWei !== null && (typeof quote.maximumWei !== 'string' || !/^[1-9][0-9]{0,77}$/.test(quote.maximumWei)))) {
      throw new Error();
    }
    const eth = (value, amount = value.toFixed(8)) => {
      const price = S.chain?.ethUsd;
      return `${amount} ETH${price ? ` (about ${usd(value * price)})` : ''}`;
    };
    const wei = quote.maximumWei?.padStart(19, '0');
    const fraction = wei?.slice(-18).replace(/0+$/, '');
    const exactCap = wei && (wei.slice(0, -18) + (fraction ? '.' + fraction : ''));
    const cost = quote.maximumEth === null
      ? `Wallet balance is ${eth(quote.balanceEth)}. At current gas prices the wallet needs at least ${eth(quote.minimumEth)}.`
      : `Estimated fee is ${eth(quote.estimatedEth)}. The transaction gas cap is ${eth(quote.maximumEth, exactCap)}.`;
    $('mevDeployGas').textContent = `${fee} ${cost} Gas is rechecked when you confirm.`;
    releaseLabel.textContent = `Implementation code hash ${quote.release}`;
    releaseLabel.hidden = false;
    if (quote.maximumWei !== null) mevContractQuote = quote;
    updateMevContractConfirm();
  } catch {
    if (request === mevContractQuoteRequest && mevDeployDlg.open) {
      $('mevDeployGas').textContent = fee + ' Gas quote unavailable. Reopen this dialog to request a fresh quote.';
    }
  }
}
$('mevDeployBtn').onclick = async () => {
  const action = availableMevContractAction(S?.mev);
  if (!action || $('mevDeployBtn').disabled) return;
  mevContractAction = action;
  const details = mevContractActions[action];
  $('mevDeployTitle').textContent = details.label + '?';
  $('mevDeployImpact').textContent = details.impact;
  $('mevDeployKeyword').textContent = details.confirmation;
  $('mevDeployConfirm').textContent = details.label;
  $('mevDeployInput').value = '';
  $('mevDeployError').hidden = true;
  mevDeployDlg.showModal();
  await loadMevContractQuote(action);
};
$('mevDeployInput').oninput = updateMevContractConfirm;
$('mevDeployCancel').onclick = () => mevDeployDlg.close();
mevDeployDlg.oncancel = (event) => { if (mevContractSubmitting) event.preventDefault(); };
$('mevDeployConfirm').onclick = async () => {
  if ($('mevDeployConfirm').disabled) return;
  const action = mevContractAction;
  const { confirmation } = mevContractActions[action];
  const { maximumWei, release } = mevContractQuote;
  mevContractSubmitting = true;
  $('mevDeployCancel').disabled = true;
  $('mevDeployInput').disabled = true;
  $('mevDeployError').hidden = true;
  renderMevControls(S.mev);
  let retryQuote = false;
  try {
    await api(`/api/mev/${action}`, { confirm: confirmation, version: 'proxy', maximumWei, release });
    mevDeployDlg.close();
  } catch (error) {
    mevContractQuote = null;
    $('mevDeployInput').value = '';
    $('mevDeployError').textContent = error.message;
    $('mevDeployError').hidden = false;
    retryQuote = true;
  } finally {
    await refresh();
    mevContractSubmitting = false;
    $('mevDeployCancel').disabled = false;
    $('mevDeployInput').disabled = false;
    renderMevControls(S?.mev);
  }
  if (retryQuote && mevDeployDlg.open && !$('mevDeployBtn').disabled && action === availableMevContractAction(S?.mev)) {
    await loadMevContractQuote(action);
  }
};
const mevDlg = $('mevDlg');
let reviewedMevArm = null;
function mevArmSettings() {
  const settings = S?.mev?.settings;
  const gas = settings?.direct;
  return isDirectMev(S?.mev) ? `direct/${gas?.maxGasUsd}/${gas?.dailyGasUsd}/${settings.activeProfitPolicy?.minNetUsd}` : 'bundle';
}

function updateMevArmConfirm() {
  $('mevConfirm').disabled = $('mevArmBtn').disabled || reviewedMevArm !== mevArmSettings()
    || $('mevInput').value.trim() !== 'MEV';
}

$('mevArmBtn').onclick = () => {
  if ($('mevArmBtn').disabled) return;
  const direct = isDirectMev(S.mev);
  const gas = S.mev.settings?.direct;
  reviewedMevArm = mevArmSettings();
  $('mevArmTitle').textContent = direct ? 'Arm direct MEV?' : 'Arm MEV bundles?';
  $('mevArmTransport').textContent = direct
    ? 'The bot can publish qualifying flash-loan trades directly to Ethereum.'
    : 'The bot can submit qualifying flash-loan trades privately to configured builders.';
  $('mevArmGas').textContent = direct
    ? `Wallet gas limits are ${usd(gas.maxGasUsd)} per attempt and ${usd(gas.dailyGasUsd)} per 24 hours. A confirmed revert still costs gas.`
    : 'A bundle that lands can spend wallet gas and the configured builder bid.';
  $('mevInput').value = '';
  updateMevArmConfirm();
  mevDlg.showModal();
};
$('mevInput').oninput = updateMevArmConfirm;
$('mevCancel').onclick = () => mevDlg.close();
$('mevConfirm').onclick = async () => {
  updateMevArmConfirm();
  if ($('mevConfirm').disabled) return;
  try { await api('/api/mev/arm', { confirm: 'MEV' }); mevDlg.close(); refresh(); } catch (e) { alert(e.message); }
};
$('mevDisarmBtn').onclick = async () => {
  if (!confirm('Disarm MEV? Paper scanning continues. A submitted transaction can still settle.')) return;
  try { await api('/api/mev/disarm'); } catch (e) { alert(e.message); }
  refresh();
};
$('pauseBtn').onclick = async () => { await api('/api/pause', { paused: !S.entriesPaused }); refresh(); };
$('resumeLiveBtn').onclick = async () => { await api('/api/resume', { kind: 'live' }); refresh(); };
$('resumePaperBtn').onclick = async () => { await api('/api/resume', { kind: 'paper' }); refresh(); };
$('panicLiveBtn').onclick = async () => {
  if (!confirm('Disarm spot and MEV and request liquidation of tracked spot positions to USDC? A submitted transaction must settle first.')) return;
  panicPending = true;
  $('panicLiveBtn').disabled = true;
  try { await api('/api/panic', { kind: 'live' }); } catch (e) { alert(e.message); }
  panicPending = false;
  refresh();
};
$('panicPaperBtn').onclick = async () => { await api('/api/panic', { kind: 'paper' }); refresh(); };
$('resetPaperBtn').onclick = async () => { if (confirm('Reset the paper portfolio?')) { await api('/api/paper/reset'); refresh(); } };
$('btBtn').onclick = async () => { await api('/api/backtest'); refresh(); };

refresh();
setInterval(() => { if (!stateRequest) void refresh(); }, 4000);
setInterval(() => { if (S?.lastTickAt) $('cAgo').textContent = ago(S.lastTickAt); }, 1000);
