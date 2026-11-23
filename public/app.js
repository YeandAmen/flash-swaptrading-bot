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

const networkExplorers = {
  ethereum: { origin: 'https://etherscan.io', address: /^0x[0-9a-f]{40}$/i, tx: /^0x[0-9a-f]{64}$/i },
  arbitrum: { origin: 'https://arbiscan.io', address: /^0x[0-9a-f]{40}$/i, tx: /^0x[0-9a-f]{64}$/i },
  solana: { origin: 'https://explorer.solana.com', address: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, tx: /^[1-9A-HJ-NP-Za-km-z]{64,88}$/ },
};

function networkLink(network, kind, id, label) {
  const explorer = networkExplorers[network];
  if (typeof id !== 'string' || !explorer[kind].test(id)) return '';
  return `<a href="${explorer.origin}/${kind}/${id}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
}

function networkLogLink(network, href) {
  if (typeof href !== 'string') return '';
  try {
    const url = new URL(href);
    if (url.origin !== networkExplorers[network].origin || url.username || url.password) return '';
    const match = /^\/(tx|address)\/([^/]+)\/?$/.exec(url.pathname);
    return match ? networkLink(network, match[1], match[2], 'Explorer ↗') : '';
  } catch {
    return '';
  }
}

function compactAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const networkNumber = (value) => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : '–';
const networkAge = (value) => Number.isFinite(value) && value > 0 ? ` · last scan ${ago(value)}` : '';
const networkUsd = (value) => usd(value, Math.abs(value) < 0.01 ? 4 : 2);
function networkGas(value, unit) {
  if ((typeof value !== 'number' && (typeof value !== 'string' || value.trim() === ''))
    || !Number.isFinite(Number(value)) || Number(value) < 0) return '–';
  return `${Number(value).toLocaleString('en-US', { maximumFractionDigits: 9 })} ${unit}`;
}

function setNetworkMarkup(id, html) {
  const element = $(id);
  if (element.innerHTML !== html) element.innerHTML = html;
}

function networkMode(network, state, canArm) {
  const mode = state?.mode;
  const active = mode === 'live';
  const badge = $(network + 'Mode');
  badge.className = `pill ${active ? 'live' : mode === 'paper' ? 'paper' : 'wait'}`;
  badge.textContent = active ? 'LIVE' : mode === 'paper' ? 'PAPER' : mode === 'off' ? 'OFF' : 'UNAVAILABLE';
  $(network + 'Controls').hidden = !state?.canArm && !active;
  const button = $(network + 'ModeBtn');
  button.disabled = !active && !canArm;
  button.textContent = `${active ? 'Disarm' : 'Arm'} ${network === 'arbitrum' ? 'Arbitrum' : 'Solana'}`;
}

function renderNetworkLog(network, entries, fallback) {
  const reported = Array.isArray(entries) ? entries.filter((entry) => typeof entry?.message === 'string' && entry.message) : [];
  const rows = reported.length ? reported.slice().sort((a, b) => (b.t ?? 0) - (a.t ?? 0)) : fallback;
  setNetworkMarkup(network + 'Log', rows.length ? rows.slice(0, 12).map((entry) => {
    const level = ['error', 'warn', 'trade'].includes(entry.level) ? entry.level : '';
    const timestamp = Number.isFinite(entry.t) && entry.t > 0 ? hm(entry.t) : '–';
    const link = networkLogLink(network, entry.link);
    return `<div><span class="t">${timestamp}</span><span class="${level}">${esc(entry.message)}${link ? ` ${link}` : ''}</span></div>`;
  }).join('') : '<div class="empty">No activity recorded.</div>');
}

function renderNetworkScanWindow(network, scanWindow) {
  const element = $(network + 'ScanWindow');
  element.hidden = !scanWindow;
  if (!scanWindow) return;
  const { minutes, scans, routes } = scanWindow;
  element.textContent = `Last ${minutes} minutes · ${networkNumber(scans)} ${scans === 1 ? 'scan' : 'scans'} · ${networkNumber(routes)} route checks`;
}

const networkOutcomes = {
  landed: 'Landed', finalized: 'Finalized', reverted: 'Reverted', replaced: 'Replaced',
  failed: 'Failed', expired: 'Expired', 'invariant-breach': 'Invariant breach',
  queued: 'Queued', scanning: 'Scanning', submitted: 'Submitted', pending: 'Pending',
  succeeded: 'Succeeded', confirmed: 'Confirmed', complete: 'Complete', completed: 'Completed',
  'not-found': 'No qualifying route', 'timed-out': 'Timed out',
};

function networkOutcome(status) {
  return typeof status === 'string' ? Object.hasOwn(networkOutcomes, status)
    ? networkOutcomes[status] : status.replaceAll('-', ' ') : 'Unknown status';
}

function renderNetworkTest(network, test) {
  const label = $(network + 'Test');
  label.hidden = !test;
  if (!test) return;
  const outcome = networkOutcome(test.status);
  const checked = test.checked ?? test.routesChecked;
  const checks = Number.isSafeInteger(checked) && checked >= 0 ? ` · ${networkNumber(checked)} checks` : '';
  const queuedAt = Number.isFinite(test.queuedAt) && test.queuedAt > 0 ? ` · queued ${time(test.queuedAt)}` : '';
  const transaction = networkLink(network, 'tx', test.hash, 'Test transaction ↗');
  const note = typeof test.note === 'string' && test.note ? ` · ${esc(test.note)}` : '';
  setNetworkMarkup(network + 'Test', `<b>Mainnet test</b> ${esc(outcome)}${checks}${queuedAt}${note}${transaction ? ` · ${transaction}` : ''}`);
}

function renderNetworkSettlement(network, pending, outcome) {
  const links = [];
  const submission = networkLink(network, 'tx', pending, 'Pending transaction ↗');
  if (submission) links.push(submission);
  if (outcome) {
    const status = networkOutcome(outcome.status);
    const settledHash = outcome.status === 'expired' ? null
      : outcome.status === 'replaced' ? outcome.replacementHash : outcome.hash ?? outcome.signature;
    const receipt = networkLink(network, 'tx', settledHash, `${status} ↗`) || esc(status);
    const profit = network === 'arbitrum' ? outcome.netUsd : outcome.netUsdc;
    const fee = network === 'arbitrum'
      ? (Number.isFinite(outcome.gasUsd) ? networkUsd(outcome.gasUsd) : '')
      : (Number.isFinite(outcome.feeLamports) ? networkGas(outcome.feeLamports / 1e9, 'SOL') : '');
    const loan = Number.isFinite(outcome.loanUsd) ? ` · ${networkUsd(outcome.loanUsd)} loan` : '';
    links.push(`<span>${receipt}${loan}${Number.isFinite(profit) ? ` · ${networkUsd(profit)} net` : ''}${fee ? ` · ${fee} fee` : ''}</span>`);
  }
  setNetworkMarkup(network + 'Settlement', links.join('') || '<span class="sub">No settled transaction recorded.</span>');
}

function renderAutoProfit(network, record) {
  const id = network + 'AutoProfit';
  $(id).hidden = record === undefined;
  if (record === undefined) return;
  if (record === null) {
    setNetworkMarkup(id, 'No confirmed profitable automatic trade recorded.');
    return;
  }
  const solana = network === 'solana';
  const net = solana ? record.netUsdc : record.netUsd;
  const link = networkLink(network, 'tx', solana ? record.signature : record.hash, 'View transaction ↗');
  if (!link || !Number.isFinite(net) || net <= 0 || !Number.isFinite(record.at) || record.at <= 0) {
    setNetworkMarkup(id, 'Automatic trade receipt unavailable.');
    return;
  }
  const amount = solana ? net.toLocaleString('en-US', { maximumFractionDigits: 6 }) + ' USDC' : '≈' + networkUsd(net);
  setNetworkMarkup(id, 'Last profitable automatic trade · <b class="pos">' + amount + ' net</b> · ' + esc(time(record.at)) + ' · ' + link);
}

function mevRowLabel(row) {
  if (row.status === 'failed' && !row.hash && !row.submission && /^(?:multi-hop )?simulation:/i.test(row.note ?? '')) {
    return 'Simulation failed';
  }
  if (row.status === 'failed' && row.note === 'confirmed revert; gas spent') return 'Confirmed revert';
  return row.status;
}

function arbitrumRecoveryDetail(recovery) {
  if (!(recovery?.remaining > 0)) return '';
  const counts = [
    [recovery.untriedCap, 'outside retry budget'], [recovery.untriedNoReader, 'without an eligible retry reader'],
    [recovery.retryOutOfGas, 'out of gas on retry'], [recovery.retryTimeout, 'timed out on retry'],
    [recovery.retryRateLimited, 'rate-limited on retry'], [recovery.retryOther, 'other or missing retry result'],
  ];
  if (counts.some(([n]) => !Number.isSafeInteger(n) || n < 0)) return '';
  const reasons = counts.filter(([n]) => n > 0).map(([n, label]) => networkNumber(n) + ' ' + label);
  return reasons.length ? ' · ' + reasons.join(', ') : '';
}

function renderArbitrum(arb) {
  const verified = arb?.deployment?.verified === true;
  const canArm = arb?.canArm && (arb.deployment ? verified : arb.executor && arb.block > 0);
  networkMode('arbitrum', arb, canArm);
  const scanned = arb?.block > 0;
  const status = arb?.status || 'Arbitrum state unavailable.';
  const quote = arb?.bestQuote;
  const quoteDetail = Number.isFinite(quote?.payoutUsd) && !status.startsWith('Best ')
    ? ` · ${quote.symbol} ${networkUsd(quote.payoutUsd)} after lender fee, before gas on ${networkUsd(quote.loanUsd)}` : '';
  const largestLoan = arb?.largestQuote?.loanUsd;
  const depth = Number.isFinite(largestLoan) && largestLoan > (quote?.loanUsd ?? 0)
    ? ` · Quoted loans up to ${usd(largestLoan, 0)}` : '';
  const screened = Number.isSafeInteger(arb?.prunedRoutes) && arb.prunedRoutes > 0
    ? ` · ${networkNumber(arb.prunedRoutes)} quotes screened out` : '';
  $('arbitrumStatus').textContent = status + quoteDetail + depth + screened + arbitrumRecoveryDetail(arb?.quoteRecovery)
    + (scanned ? networkAge(arb.updatedAt) : '');
  const pathStatus = $('arbitrumPathStatus');
  pathStatus.hidden = !arb?.pathStatus || arb.mode === 'off';
  const pathBlock = arb?.pathBlock > 0 ? ' · L2 block ' + networkNumber(arb.pathBlock) : '';
  const pathBest = Number.isFinite(arb?.pathBest?.payoutUsd)
    ? ' · ' + arb.pathBest.route + ' ' + networkUsd(arb.pathBest.payoutUsd) + ' before gas'
      + (Number.isFinite(arb.pathBest.loanUsd) ? ' on a ' + networkUsd(arb.pathBest.loanUsd) + ' loan' : '') : '';
  const sizing = arb?.pathRefinement;
  const fixedBest = Number.isFinite(sizing?.bestPayoutUsd) && Number.isFinite(sizing?.baselineBestPayoutUsd)
    && sizing.bestPayoutUsd > sizing.baselineBestPayoutUsd
    ? ' · Best at fixed loan sizes was ' + networkUsd(sizing.baselineBestPayoutUsd) + ' before gas' : '';
  pathStatus.textContent = (arb?.pathStatus ?? '') + pathBlock + pathBest + fixedBest;
  $('arbitrumBlock').textContent = scanned ? networkNumber(arb.block) : '–';
  $('arbitrumRoutes').textContent = scanned ? networkNumber(arb.routes) : '–';
  $('arbitrumGas').textContent = networkGas(arb?.balanceEth, 'ETH');
  renderNetworkScanWindow('arbitrum', arb?.scanWindow);

  const deployment = arb?.deployment;
  const address = deployment?.address ?? arb?.executor;
  const links = [];
  if (typeof address === 'string') links.push(networkLink('arbitrum', 'address', address, `Executor ${compactAddress(address)} ↗`));
  if (deployment?.kind === 'proxy') {
    links.push('<span class="sub">Upgradeable ERC-1967 proxy</span>');
    links.push(networkLink('arbitrum', 'address', deployment.implementation, 'Implementation ↗'));
  }
  if (verified) links.push('<span class="pos">Bytecode verified</span>');
  else if (typeof deployment?.status === 'string' && deployment.status) links.push(`<span class="sub">${esc(deployment.status)}</span>`);
  if (typeof deployment?.owner === 'string') {
    links.push(networkLink('arbitrum', 'address', deployment.owner, `Owner ${compactAddress(deployment.owner)} ↗`));
  }
  links.push(networkLink('arbitrum', 'tx', deployment?.hash, 'Deployment receipt ↗'));
  if (Number.isSafeInteger(deployment?.block) && deployment.block > 0) {
    links.push(`<span class="sub">Deployed at L2 block ${networkNumber(deployment.block)}</span>`);
  }
  if (Number.isFinite(deployment?.deployedAt) && deployment.deployedAt > 0) {
    links.push(`<span class="sub">${time(deployment.deployedAt)}</span>`);
  }
  setNetworkMarkup('arbitrumDeployment', links.join('') || '<span class="sub">No executor deployment recorded.</span>');
  renderNetworkSettlement('arbitrum', arb?.pending, arb?.settled);
  renderNetworkTest('arbitrum', arb?.test);
  renderNetworkLog('arbitrum', arb?.logs, scanned ? [{ t: arb.updatedAt, message: status }] : []);
}

function renderSolana(solana) {
  const execution = solana?.execution;
  networkMode('solana', solana, solana?.canArm && execution?.ready);
  const result = solana?.result;
  const routes = Array.isArray(result?.routes) ? result.routes : null;
  const checkedAt = solana?.updatedAt || Date.parse(result?.checkedAt ?? '');
  const completed = ['Unsigned scan completed', 'Guarded live scan completed'].includes(solana?.status);
  const qualified = routes?.filter((route) => route.qualified).length;
  const status = completed && qualified !== undefined
    ? `${qualified} qualifying ${qualified === 1 ? 'route' : 'routes'}` : solana?.status;
  const principal = Number.isFinite(result?.loanUsdc) ? ` · ${networkGas(result.loanUsdc, 'USDC')} loan` : '';
  const probe = solana?.marketProbe;
  const sizeDetail = completed && probe && Number.isFinite(probe.maxLoanUsdc)
    ? ` · ${probe.reason === 'refinement' ? 'Size refinement' : 'Depth scan'} · ${probe.limitMode === 'lender-liquidity' ? 'available to borrow' : 'cap'} ${networkGas(probe.maxLoanUsdc, 'USDC')}` : '';
  $('solanaStatus').textContent = (status || 'Solana state unavailable.') + principal + sizeDetail + networkAge(checkedAt);
  $('solanaSlot').textContent = result?.slot > 0 ? networkNumber(result.slot) : '–';
  $('solanaRoutes').textContent = routes ? networkNumber(routes.length) : '–';
  $('solanaGas').textContent = networkGas(result?.walletSol, 'SOL');
  renderNetworkScanWindow('solana', solana?.scanWindow);

  const executionStatus = execution?.status;
  const showExecution = Boolean(solana?.mode === 'live' && executionStatus && executionStatus !== 'Live Solana scanning'
    && (execution.pending || (completed && qualified > 0)));
  $('solanaExecutionStatus').hidden = !showExecution;
  $('solanaExecutionStatus').textContent = showExecution ? executionStatus : '';

  const deployment = solana?.deployment;
  const programLinks = [
    networkLink('solana', 'address', deployment?.guardAddress, 'Lighthouse guard ↗'),
    networkLink('solana', 'address', deployment?.lenderAddress, 'Kamino lender ↗'),
    networkLink('solana', 'address', deployment?.routerAddress, 'Jupiter router ↗'),
  ];
  if (deployment?.guardVerified === true) programLinks.push('<span class="pos">Guard verified</span>');
  else if (typeof deployment?.status === 'string' && deployment.status) programLinks.push(`<span class="sub">${esc(deployment.status)}</span>`);
  setNetworkMarkup('solanaDeployment', programLinks.join('') || '<span class="sub">Program information unavailable.</span>');
  renderNetworkSettlement('solana', execution?.pending, execution?.lastOutcome);
  renderNetworkTest('solana', solana?.test);
  const fallback = routes?.map((route) => {
    const routeName = `${route.buy} → ${route.sell}`;
    return { t: checkedAt, level: route.status === 'quote-error' || route.status === 'simulation-failed' ? 'warn' : '',
      message: `${routeName} · ${networkOutcome(route.status)}${route.detail ? ` · ${route.detail}` : ''}` };
  }) ?? [];
  renderNetworkLog('solana', solana?.logs, fallback);
}

function renderNetworks(networks) {
  renderArbitrum(networks?.arbitrum);
  renderSolana(networks?.solana);
}

function render() {
  if (!S) return;
  renderNetworks(S.networks);
  renderAutoProfit('ethereum', S.mev?.lastAutoProfit);
  renderAutoProfit('arbitrum', S.networks?.arbitrum?.lastAutoProfit);
  renderAutoProfit('solana', S.networks?.solana?.execution?.lastAutoProfit);
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
  renderNetworkTest('ethereum', mev?.gasOnlyTest);
  const now = Number.isFinite(S.now) ? S.now : Date.now();
  const scanAt = mev?.lastBlock?.at;
  const directPending = mev?.pending?.kind === 'direct';
  const scanAge = (mev?.mode === 'live' || directPending) && Number.isFinite(scanAt) && scanAt > 0 ? now - scanAt : null;
  const staleScan = scanAge !== null && scanAge > MEV_STALE_AFTER_MS
    ? `Last MEV scan was ${Math.floor(scanAge / 1000)} seconds ago.` : '';
  const liveScanners = [
    mev?.mode === 'live' && scanAge !== null && !staleScan && 'Ethereum',
    S.networks?.arbitrum?.mode === 'live' && now - S.networks.arbitrum.updatedAt < 90_000 && 'Arbitrum',
    S.networks?.solana?.mode === 'live' && now - S.networks.solana.updatedAt < 90_000 && 'Solana',
  ].filter(Boolean);
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
  } else if (liveScanners.length) {
    pill.className = 'pill live'; pill.textContent = 'LIVE';
    banner.className = 'banner ok'; $('bannerText').textContent = `Flash-loan scanners active on ${liveScanners.join(', ')}.`;
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
  $('spotStatus').hidden = S.liveStatus.ready;
  $('spotStatus').textContent = S.liveStatus.reason;
  $('lDecision').hidden = !S.armed || !L.lastDecision || L.lastDecision === S.liveStatus.reason;
  $('lDecision').textContent = L.lastDecision || '';
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
    const loanCap = X.settings?.loanLimitMode === 'lender-liquidity' ? ' · Loan size follows lender liquidity'
      : Number.isFinite(maxLoanUsd) ? ` · Loan cap ${usd(maxLoanUsd, Number.isInteger(maxLoanUsd) ? 0 : 2)}` : '';
    const padding = P?.gasPaddingPct == null ? '' : ` · ${Math.round(P.gasPaddingPct * 100)}% gas buffer`;
    const bidding = direct && Number.isFinite(P?.minNetUsd) ? ` · ${usd(P.minNetUsd)} minimum net per attempt${padding}`
      : P?.idle ? ` · idle bidding with a ${usd(P.minNetUsd)} net floor and up to ${Math.round(P.builderTipPct * 100)}% of after-gas profit bid${padding}` : '';
    const transport = X.mode === 'live' ? '' : direct ? 'Direct Ethereum transactions · ' : 'Private bundles · ';
    $('mevStatus').textContent = (staleScan ? 'Scan is stale · ' : '') + `${transport}${X.status} · watching ${X.tokens} tokens in ${X.pools} pools${venues ? ` (${venues})` : ''}` +
      coverage + loanCap + bidding + (lb ? ` · last block ${lb.number.toLocaleString()} ${ago(lb.at)}` : '') + timing + missingReads + (X.lastError ? ` · last error: ${X.lastError}` : '');
    const path = X.multiHop?.market;
    $('ethPathStatus').hidden = !path;
    if (path) {
      const routeMode = X.multiHop.supported && X.mode === 'live' ? 'Live' : 'Quote only';
      const best = Number.isFinite(path.bestNetUsd) ? ' · best estimated net ' + networkUsd(path.bestNetUsd) : '';
      const release = X.multiHop.supported ? '' : ' · execution requires a verified multi-hop proxy';
      $('ethPathStatus').textContent = routeMode + ' · 3–4 swaps · block ' + networkNumber(path.block) + ' · '
        + networkNumber(path.pools) + ' pools · ' + networkNumber(path.exactQuotes) + ' exact quotes · ' + path.status + best + release;
    }
    const st = X.stats;
    $('mevBlocks').textContent = st.blocks.toLocaleString();
    const B = X.bestThisHour?.exact ? X.bestThisHour : null;
    const bestVal = !B ? '<span class="sub">No successful simulation this hour</span>' : B.grossUsd != null
      ? `<span class="${B.grossUsd > B.gasUsd ? 'pos' : ''}">${usd(B.grossUsd)}</span> <span class="sub">vs ${usd(B.gasUsd)} gas</span>`
      : `${B.grossEth.toFixed(5)} <span class="sub">vs ${B.gasEth.toFixed(5)} ETH gas</span>`;
    $('mevGap').innerHTML = bestVal + (B ? `<div class="sub">${esc(B.symbol)}${direct ? '' : ' · before builder bid'}</div>` : '');
    $('mevSims').textContent = `${st.simulated} / ${st.profitable}`;
    $('mevSubmissionLabel').textContent = direct ? 'All direct attempts / landed' : 'All bundles sent / landed';
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
      <td><span class="tag ${rTag[o.status] || 'flat'}">${esc(mevRowLabel(o))}</span>${o.gasOnlyTestId ? ' <span class="sub">Manual test</span>' : ''}${o.count > 1 ? ` <span class="sub">${networkNumber(o.count)} evaluations</span>` : ''}
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
  if (gas) costs.textContent = `Direct gas · ${usd(gas.spentGasUsd)} spent in 24 hours · ${mevGasLimits(gas)}`;
}

function renderMevCadence(cadence) {
  const element = $('mevDirectCadence');
  element.hidden = !cadence;
  if (!cadence) return;

  const { state, elapsedMs, lastLandedAt, intervalMs, routeLimit, baseRouteLimit } = cadence;
  const minuteMs = 60_000;
  const target = Math.round(intervalMs / minuteMs);
  const remainingMs = Number.isFinite(elapsedMs) ? intervalMs - elapsedMs : null;
  const timing = state === 'paper' ? 'paper mode'
    : state === 'overdue' ? 'still searching for a qualifying route'
    : remainingMs === null ? 'checking routes' : `fill target in ${Math.max(0, Math.ceil(remainingMs / minuteMs))} min`;
  const parts = [`${target}-minute search target`, timing];
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
    const laterHeads = Array.isArray(submission.relayAtLaterTargetHeads) ? submission.relayAtLaterTargetHeads : [];
    const observedHeads = [submission.relayAtTargetHead, ...laterHeads].filter(Boolean);
    const relay = [['after acknowledgement', submission.relayAfterAck],
      ...observedHeads.map(head => [`when requested at block ${head.block}${head.inWindow === false ? ' (reply outside verified window)' : ''}`,
        head.result ?? { status: 'No response recorded' }]),
      ['after expiry', submission.relayAfterExpiry]]
      .filter(([, result]) => result)
      .map(([when, result]) => {
        const fields = [result.status, result.simError, result.revertReason];
        if (result.maxBlockNumber) fields.push('relay deadline block ' + result.maxBlockNumber);
        return `<div>Flashbots ${esc(when)} · ${esc(fields.filter(Boolean).join(' · '))}</div>`;
      }).join('');
    const signedGas = submission.gasLimit && submission.maxFeePerGasWei
      ? `<div>Gas limit ${esc(submission.gasLimit)} · fee cap ${esc(submission.maxFeePerGasWei)} wei/gas</div>` : '';
    const t = submission.directTiming;
    const stages = [
      ['Head age at first read', t?.headAgeMs], ['pool snapshot', t?.snapshotReadMs],
      ['selection and preparation', t?.quoteAndPrepareMs], ['final checks', t?.finalValidationMs],
      ['signing and head check', t?.signAndHeadCheckMs], ['journal to RPC acknowledgement', t?.journalToAckMs],
    ].filter(([, ms]) => Number.isFinite(ms));
    const timings = stages.length
      ? `<div>${stages.map(([label, ms]) => `${label} ${Math.round(ms)} ms`).join(' · ')}</div>` : '';
    const lead = Number.isFinite(leadMs)
      ? `<div>Order prepared ${(Math.abs(leadMs) / 1000).toFixed(2)} s ${leadMs >= 0 ? 'before' : 'after'} next expected slot</div>` : '';
    const sims = submission.directSimulation;
    const quotesDiffer = sims && [sims.preparedNetUsd, sims.blockNetUsd, sims.pendingNetUsd].every(Number.isFinite)
      && (sims.preparedNetUsd !== sims.blockNetUsd || sims.blockNetUsd !== sims.pendingNetUsd);
    const comparison = quotesDiffer
      ? `<div>Net estimates after padded gas · initial ${usd(sims.preparedNetUsd, 4)} · block ${usd(sims.blockNetUsd, 4)} · pending ${usd(sims.pendingNetUsd, 4)}</div>` : '';
    return `<details class="sub" data-target="${esc(key)}"${open}><summary>Direct transaction · route deadline block ${esc(target)}</summary>
      <div>Maximum network fee ${gasEth.toFixed(6)} ETH · simulated net ${usd(netUsd, 4)}</div>${comparison}${signedGas}${lead}${timings}${relay}</details>`;
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
function mevGasLimits(gas) {
  const regular = `standard limits ${usd(gas.maxGasUsd)} per attempt and ${usd(gas.dailyGasUsd)} per 24 hours`;
  if (!(gas.premiumMaxGasUsd > 0)) return regular;
  const daily = gas.premiumDailyGasUsd ?? gas.premiumMaxGasUsd;
  return `${regular} · high-profit limits ${usd(gas.premiumMaxGasUsd)} per attempt and ${usd(daily)} per 24 hours`;
}
let reviewedMevArm = null;
function mevArmSettings() {
  const settings = S?.mev?.settings;
  const gas = settings?.direct;
  return isDirectMev(S?.mev) ? `direct/${gas?.maxGasUsd}/${gas?.dailyGasUsd}/${gas?.premiumMaxGasUsd}/${gas?.premiumDailyGasUsd}/${settings.activeProfitPolicy?.minNetUsd}` : 'bundle';
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
    ? `Wallet gas · ${mevGasLimits(gas)}. A confirmed revert still costs gas.`
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

function syncNetworkNav() {
  const links = [...$('networkNav').querySelectorAll('a')];
  const selected = links.find((link) => link.hash === location.hash) ?? links[0];
  for (const link of links) {
    if (link === selected) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}

window.addEventListener('hashchange', syncNetworkNav);
syncNetworkNav();
refresh();
setInterval(() => { if (!stateRequest) void refresh(); }, 4000);
setInterval(() => { if (S?.lastTickAt) $('cAgo').textContent = ago(S.lastTickAt); }, 1000);
