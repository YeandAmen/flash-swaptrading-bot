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

let S = null;
let tab = 'live';
let qrLoaded = false;
let panicPending = false;
let mevDeploySubmitting = false;
let mevDeployQuoteRequest = 0;

async function api(path, body) {
  const send = (authorization) => fetch(path, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-bot-ui': '1', ...(authorization ? { authorization } : {}) },
    body: JSON.stringify(body || {}),
  });
  let r = await send();
  if (r.status === 401) {
    const password = window.prompt('Authorize this live wallet action with the local operator password (npm run --silent dashboard:password).');
    if (!password) throw new Error('Live wallet action canceled.');
    r = await send(`Basic ${btoa(`operator:${password.trim()}`)}`);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

async function refresh() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.statusText);
    S = await r.json();
    render();
  } catch (e) {
    $('banner').className = 'banner bad';
    $('bannerText').textContent = 'Cannot reach the local bot. Start it with npm start and check the terminal output.';
  }
}

function posList(list, max) {
  if (!list || !list.length) return `<div class="posbox sub">No open positions — holding USDC (up to ${max || 1} at once)</div>`;
  return list.map((p) => `<div class="posbox"><b>${esc(p.symbol)}</b> ${p.qty.toPrecision(5)} · value ${usd(p.valueUsd)} · <span class="${cls(p.pnlPct)}">${pct(p.pnlPct)}</span> vs breakeven${p.ml != null ? ` · AI ${(p.ml * 100).toFixed(0)}%` : ''}
    <div class="sub">entry ${price(p.entryMid)} · stop ${price(p.stopPrice)}${p.trailActive ? ' (trailing)' : ''} · target ${price(p.targetPrice)} · since ${time(p.entryTime)}</div></div>`).join('');
}

function render() {
  if (!S) return;
  const c = S.chain;
  $('cBlock').textContent = c ? c.block.toLocaleString() : '–';
  const g = (x) => (x < 0.01 ? x.toPrecision(2) : x.toFixed(2));
  $('cGas').textContent = c ? g(c.baseFeeGwei) + ' + ' + g(c.tipGwei) + ' gwei' : '–';
  $('cEth').textContent = c ? usd(c.ethUsd, 0) : '–';
  $('cAgo').textContent = S.lastTickAt ? ago(S.lastTickAt) : '–';

  // mode + banner
  const pill = $('modePill');
  const banner = $('banner');
  if (S.liveFault) {
    pill.className = 'pill err'; pill.textContent = 'RECOVERY';
    banner.className = 'banner bad'; $('bannerText').textContent = S.liveFault;
  } else if (S.status === 'starting') {
    pill.className = 'pill wait'; pill.textContent = 'STARTING';
    banner.className = 'banner warn'; $('bannerText').textContent = 'Starting: ' + S.startupStep + '…';
  } else if (S.status === 'error' || S.lastError) {
    pill.className = 'pill err'; pill.textContent = S.status === 'error' ? 'ERROR' : (S.armed ? 'LIVE' : 'PAPER');
    banner.className = 'banner bad'; $('bannerText').textContent = 'Problem: ' + (S.lastError || 'unknown') + ' — the bot retries automatically.';
  } else if (!S.health.ready) {
    pill.className = 'pill err'; pill.textContent = 'UNREADY';
    banner.className = 'banner bad'; $('bannerText').textContent = S.health.reason;
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
    const venues = Object.entries(X.venues || {}).map(([k, v]) => `${v} ${k}`).join(', ');
    const lb = X.lastBlock;
    const C = X.coverage;
    const coverage = C?.mode === 'all'
      ? ` · discovery ${C.phase}: ${C.checked.toLocaleString()}/${C.candidates.toLocaleString()} addresses checked, ${C.eligible.toLocaleString()} eligible, ${C.maxPools} pool limit`
      : '';
    const timing = lb?.decisionMs == null ? '' : ` · ${lb.readMs} ms pool reads, ${lb.decisionMs} ms decisions`;
    $('mevStatus').textContent = `${X.status} · watching ${X.tokens} tokens in ${X.pools} pools${venues ? ` (${venues})` : ''}` +
      coverage + (lb ? ` · last block ${lb.number.toLocaleString()} ${ago(lb.at)}` : '') + timing + (X.lastError ? ` · last error: ${X.lastError}` : '');
    const st = X.stats;
    $('mevBlocks').textContent = st.blocks.toLocaleString();
    const B = X.bestThisHour;
    const bestVal = !B ? '–' : B.grossUsd != null
      ? `<span class="${B.grossUsd > B.gasUsd ? 'pos' : ''}">${usd(B.grossUsd)}</span> <span class="sub">vs ${usd(B.gasUsd)} gas</span>`
      : `${B.grossEth.toFixed(5)} <span class="sub">vs ${B.gasEth.toFixed(5)} ETH gas</span>`;
    $('mevGap').innerHTML = bestVal + (B ? `<div class="sub">${esc(B.symbol || '')} · ${B.exact ? 'exact simulation' : 'estimate'}</div>` : '');
    $('mevSims').textContent = `${st.simulated} / ${st.profitable}`;
    $('mevBundles').textContent = `${st.bundles} / ${st.landed}`;
    $('mevProfit').innerHTML = `<span class="${cls(st.netEth)}">${st.netEth.toFixed(5)} ETH</span> <span class="sub">${usd(st.netUsd)}</span>`;
    $('mevRpc').textContent = st.rpcCalls.toLocaleString();
    const rTag = { landed: 'buy', 'would send': 'buy', sent: 'sell', failed: 'down' };
    $('mevBody').innerHTML = (X.recent || []).length ? X.recent.map((o) => `<tr><td>${hm(o.t)}</td><td><b>${esc(o.symbol)}</b></td>
      <td class="why">${esc(o.buy)} → ${esc(o.sell)}${o.funding ? `<div class="sub">${esc(o.funding)}</div>` : ''}</td><td class="r">${o.sizeEth.toFixed(3)}</td><td class="r">${o.grossEth.toFixed(5)}</td>
      <td class="r">${o.gasEth.toFixed(5)}</td><td class="r ${cls(o.netEth)}">${o.netEth.toFixed(5)}</td>
      <td><span class="tag ${rTag[o.status] || 'flat'}">${esc(o.status)}</span>${o.count > 1 ? ` <span class="sub">×${o.count}</span>` : ''}
      <span class="why">${esc(o.note || '')}</span>${o.hash && o.status === 'landed' ? ` <a href="https://etherscan.io/tx/${esc(o.hash)}" target="_blank" rel="noopener noreferrer">tx↗</a>` : ''}</td></tr>`).join('')
      : '<tr><td colspan="8" class="empty">No price gap has beaten pool fees + gas yet. Small gaps are usually closed by professional bots in the same block.</td></tr>';
  }
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

function renderMevControls(X) {
  const contract = X?.contract || X?.configuredContract;
  const off = X?.mode === 'off';
  let reason = '';
  if (!X) reason = 'Waiting for bot status.';
  else if (off) reason = 'MEV scanning is disabled by MEV=off in .env.';
  else if (X.deploymentPending) reason = 'Waiting for the FlashArbV2 deployment receipt.';
  else if (mevDeploySubmitting || X.mode === 'deploying') reason = 'Preparing FlashArbV2 deployment…';
  else if (X.mode === 'arming') reason = 'Checking FlashArbV2 before arming…';
  else if (!S.liveTradingAllowed) reason = 'Set ALLOW_LIVE_TRADING=on in .env and restart to enable deployment and live MEV.';
  else if (!S.health.ready) reason = S.health.reason || 'Waiting for the bot to be ready.';
  else if (X.pending) reason = 'Waiting for a submitted MEV bundle to settle.';

  $('mevDeployBtn').hidden = Boolean(contract || off);
  $('mevDeployBtn').disabled = Boolean(reason || contract);
  $('mevArmBtn').hidden = Boolean(X?.armed || off);
  $('mevArmBtn').disabled = Boolean(reason || !contract);
  $('mevDisarmBtn').hidden = !X?.armed;
  $('mevContract').hidden = !contract;
  $('mevContract').textContent = contract ? `FlashArbV2 ${contract}${X.contract ? '' : ' (configured)'}` : '';
  const status = reason || (contract ? '' : 'Deploy FlashArbV2 to enable MEV arming.');
  const statusNode = $('mevDeploy');
  if (statusNode.textContent !== status) statusNode.textContent = status;
  statusNode.hidden = !status;
  updateMevDeployConfirm();
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
  if (!confirm('Disarm spot and MEV? Open positions stay in the wallet. Submitted transactions can still settle.')) return;
  try { await api('/api/disarm'); } catch (e) { alert(e.message); }
  refresh();
};
const mevDeployDlg = $('mevDeployDlg');
function updateMevDeployConfirm() {
  $('mevDeployConfirm').disabled = $('mevDeployBtn').disabled || $('mevDeployInput').value.trim() !== 'DEPLOY';
}
$('mevDeployBtn').onclick = async () => {
  if ($('mevDeployBtn').disabled) return;
  const fee = S.forkMode
    ? 'Deployment spends test ETH from the bot wallet on this local fork.'
    : 'Deployment sends a mainnet transaction and spends real ETH from the bot wallet.';
  $('mevDeployGas').textContent = fee + ' Checking current gas prices…';
  $('mevDeployInput').value = '';
  $('mevDeployError').hidden = true;
  updateMevDeployConfirm();
  mevDeployDlg.showModal();
  const request = ++mevDeployQuoteRequest;
  try {
    const response = await fetch('/api/mev/deploy/quote', { cache: 'no-store' });
    if (!response.ok) throw new Error();
    const quote = await response.json();
    if (request !== mevDeployQuoteRequest || !mevDeployDlg.open) return;
    const eth = (value) => {
      const price = S.chain?.ethUsd;
      return `${value.toFixed(8)} ETH${price ? ` (about ${usd(value * price)})` : ''}`;
    };
    const cost = quote.maximumEth === null
      ? `Wallet balance is ${eth(quote.balanceEth)}. At current gas prices the wallet needs at least ${eth(quote.minimumEth)}.`
      : `Estimated fee is ${eth(quote.estimatedEth)}. The transaction gas cap is ${eth(quote.maximumEth)}.`;
    $('mevDeployGas').textContent = `${fee} ${cost} Gas is rechecked when you confirm.`;
  } catch {
    if (request === mevDeployQuoteRequest && mevDeployDlg.open) {
      $('mevDeployGas').textContent = fee + ' Gas quote unavailable. Gas is rechecked when you confirm.';
    }
  }
};
$('mevDeployInput').oninput = updateMevDeployConfirm;
$('mevDeployCancel').onclick = () => mevDeployDlg.close();
mevDeployDlg.oncancel = (event) => { if (mevDeploySubmitting) event.preventDefault(); };
$('mevDeployConfirm').onclick = async () => {
  if ($('mevDeployConfirm').disabled) return;
  mevDeploySubmitting = true;
  $('mevDeployCancel').disabled = true;
  $('mevDeployInput').disabled = true;
  $('mevDeployError').hidden = true;
  renderMevControls(S.mev);
  try {
    await api('/api/mev/deploy', { confirm: 'DEPLOY' });
    mevDeployDlg.close();
  } catch (error) {
    $('mevDeployError').textContent = error.message;
    $('mevDeployError').hidden = false;
  } finally {
    await refresh();
    mevDeploySubmitting = false;
    $('mevDeployCancel').disabled = false;
    $('mevDeployInput').disabled = false;
    renderMevControls(S?.mev);
  }
};
const mevDlg = $('mevDlg');
$('mevArmBtn').onclick = () => {
  $('mevInput').value = '';
  $('mevConfirm').disabled = true;
  mevDlg.showModal();
};
$('mevInput').oninput = () => ($('mevConfirm').disabled = $('mevInput').value.trim() !== 'MEV');
$('mevCancel').onclick = () => mevDlg.close();
$('mevConfirm').onclick = async () => {
  const typed = $('mevInput').value.trim();
  if (typed !== 'MEV') return;
  try { await api('/api/mev/arm', { confirm: typed }); mevDlg.close(); refresh(); } catch (e) { alert(e.message); }
};
$('mevDisarmBtn').onclick = async () => {
  if (!confirm('Disarm MEV? Paper scanning continues. A submitted bundle can still settle.')) return;
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
setInterval(refresh, 4000);
setInterval(() => { if (S?.lastTickAt) $('cAgo').textContent = ago(S.lastTickAt); }, 1000);
