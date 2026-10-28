import { renderChart, trendLines } from './charts.js';

// The static demo site (GitHub Pages) has no server: it generates the sample data in the
// browser with the same code the local server uses, and never connects to WHOOP.
const STATIC_DEMO = document.documentElement.dataset.mode === 'static-demo';

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

const state = {
  days: store.get('days') === 'all' ? 'all' : [7, 30, 90].includes(Number(store.get('days'))) ? Number(store.get('days')) : 30,
  demo: false,
  data: null,
  status: null,
  tableMode: new Set(),
  showAllWorkouts: false,
  requestId: 0,
  pollTimer: null,
  view: store.get('view') === 'cockpit' ? 'cockpit' : 'dashboard',
  cockpit: [],
  editing: false,
  ctx: null,
};

// ---------- theme ----------
// system (follows the OS), light or dark; anything else saved earlier falls back to system
const THEMES = ['system', 'light', 'dark'];
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
const savedTheme = THEMES.includes(store.get('theme')) ? store.get('theme') : 'system';
applyTheme(savedTheme);
$('themeSelect').value = savedTheme;
$('themeSelect').addEventListener('change', (e) => {
  applyTheme(e.target.value);
  store.set('theme', e.target.value);
  // redraw so colors computed at draw time follow the theme
  if (state.data && !$('dashView').hidden) render();
});

// ---------- formatting ----------
const nf1 = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const fmt = {
  int: (v) => (v == null ? '–' : nf0.format(v)),
  one: (v) => (v == null ? '–' : nf1.format(v)),
  dur: (ms) => {
    if (ms == null) return '–';
    const m = Math.round(ms / 60000);
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  },
  mins: (ms) => (ms == null ? '–' : `${Math.round(ms / 60000)}m`),
  auto: (v) => (v == null ? '–' : Math.abs(v - Math.round(v)) < 1e-9 ? nf0.format(v) : nf1.format(v)),
  sig: (v) => (Math.abs(v) < 0.1 ? nf2.format(v) : Math.abs(v) < 10 ? nf1.format(v) : nf0.format(v)),
  compact: (v) => (v == null ? '–' : Math.abs(v) >= 1000 ? `${nf1.format(v / 1000).replace(/[.,]0$/, '')}K` : nf0.format(v)),
  day: (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }),
  // localStart is the member's wall-clock time encoded as UTC
  wall: (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }),
  time: (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
};
const kcal = (kj) => (kj == null ? null : kj / 4.184);
const asleepMs = (s) => (s && s.lightMs != null ? (s.lightMs || 0) + (s.swsMs || 0) + (s.remMs || 0) : null);
const hrs = (ms) => (ms == null ? null : ms / 3_600_000);
const mean = (arr) => {
  const v = arr.filter((x) => x != null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
function todayIso() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
const isAll = () => state.days === 'all';
const rangeName = () => (isAll() ? 'all-time' : `${state.days}-day`);
const fmtDate = (iso, opts) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
const fmtMonthYear = (iso) => fmtDate(iso, { month: 'short', year: 'numeric' });

// Long ranges are grouped into weekly (or monthly) averages so every bar stays readable.
function weekStart(iso) {
  const t = new Date(`${iso}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); // back to Monday
  return t.toISOString().slice(0, 10);
}
function aggregate(days) {
  if (days.length <= 120) return { rows: days, unit: 'day' };
  const unit = days.length > 3 * 365 ? 'month' : 'week';
  const groups = new Map();
  for (const d of days) {
    const key = unit === 'month' ? `${d.date.slice(0, 7)}-01` : weekStart(d.date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  const rows = [...groups].map(([date, ds]) => {
    const avg = (f) => mean(ds.map(f));
    const done = (f) => (x) => (x.inProgress ? null : f(x)); // today's partial strain would drag the average down
    return {
      date,
      bucket: unit,
      bucketDays: ds.length,
      inProgress: false,
      strain: avg(done((x) => x.strain)),
      kilojoule: avg(done((x) => x.kilojoule)),
      avgHr: avg(done((x) => x.avgHr)),
      maxHr: avg(done((x) => x.maxHr)),
      steps: avg(done((x) => x.steps)),
      ins: ds.some((x) => x.ins)
        ? (() => {
            const worst = ds.reduce((w, x) => ((x.ins?.signalCount ?? -1) > (w?.ins?.signalCount ?? -1) ? x : w), null);
            return {
              hrv7: avg((x) => x.ins?.hrv7),
              hrvLo: avg((x) => x.ins?.hrvLo),
              hrvHi: avg((x) => x.ins?.hrvHi),
              acwr: avg((x) => x.ins?.acwr),
              acute: avg((x) => x.ins?.acute),
              chronic: avg((x) => x.ins?.chronic),
              bedMin: avg((x) => x.ins?.bedMin),
              hrvCv: avg((x) => x.ins?.hrvCv),
              hrvCvLo: avg((x) => x.ins?.hrvCvLo),
              hrvCvHi: avg((x) => x.ins?.hrvCvHi),
              sri: avg((x) => x.ins?.sri),
              steps7: avg((x) => x.ins?.steps7),
              wakeMin: avg((x) => x.ins?.wakeMin),
              signalCount: worst?.ins?.signalCount ?? null,
              signals: worst?.ins?.signals || [],
              illness: worst?.ins?.illness ?? null,
            };
          })()
        : null,
      act: ['workouts', 'zone13Ms', 'zone45Ms', 'strengthMs', 'kcal', 'distanceKm', 'climbM'].reduce((o, k) => ((o[k] = ds.reduce((a, x) => a + (x.act?.[k] || 0), 0)), o), {}),
      recovery: ds.some((x) => x.recovery)
        ? {
            score: avg((x) => x.recovery?.score),
            hrv: avg((x) => x.recovery?.hrv),
            rhr: avg((x) => x.recovery?.rhr),
            spo2: avg((x) => x.recovery?.spo2),
            skinTemp: avg((x) => x.recovery?.skinTemp),
            calibrating: false,
          }
        : null,
      sleep: ds.some((x) => x.sleep)
        ? {
            swsMs: avg((x) => x.sleep?.swsMs),
            remMs: avg((x) => x.sleep?.remMs),
            lightMs: avg((x) => x.sleep?.lightMs),
            awakeMs: avg((x) => x.sleep?.awakeMs),
            performance: avg((x) => x.sleep?.performance),
            efficiency: avg((x) => x.sleep?.efficiency),
            consistency: avg((x) => x.sleep?.consistency),
            neededMs: avg((x) => x.sleep?.neededMs),
            debtMs: avg((x) => x.sleep?.debtMs),
            inBedMs: avg((x) => x.sleep?.inBedMs),
            respiratoryRate: avg((x) => x.sleep?.respiratoryRate),
            disturbances: avg((x) => x.sleep?.disturbances),
          }
        : null,
    };
  });
  return { rows, unit };
}
function periodLabel(d, short = false) {
  if (d.bucket === 'week') {
    const day = fmtDate(d.date, { month: 'short', day: 'numeric', year: 'numeric' });
    return short ? day : `Week of ${day}`;
  }
  if (d.bucket === 'month') return fmtDate(d.date, { month: 'long', year: 'numeric' });
  return fmt.day(d.date);
}

function h(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}

// WHOOP recovery zones: green 67–100, yellow 34–66, red 0–33
function zoneOf(score) {
  if (score == null) return null;
  if (score >= 67) return { key: 'good', label: 'Green', color: 'var(--good)' };
  if (score >= 34) return { key: 'warning', label: 'Yellow', color: 'var(--warning)' };
  return { key: 'critical', label: 'Red', color: 'var(--critical)' };
}
const statusIcon = (key) => h('span', { class: `status-icon status-${key}`, 'aria-hidden': 'true' });

// ---------- views ----------
function showView(name) {
  $('connectView').hidden = name !== 'connect';
  $('dashView').hidden = name !== 'dash';
  const real = name === 'dash' && !state.demo;
  $('refreshBtn').hidden = !real;
  $('logoutBtn').hidden = !real;
  $('exitDemoBtn').hidden = STATIC_DEMO || !(name === 'dash' && state.demo);
  if (name !== 'connect') stopPolling();
}

function showError(msg) {
  $('errorBanner').textContent = msg;
  $('errorBanner').hidden = !msg;
}

async function getJSON(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

// ---------- connect flow ----------
function renderConnect(message) {
  const st = state.status || {};
  state.demo = false;
  $('who').textContent = '';
  showView('connect');
  showError('');
  const needsSetup = !st.manualMode && st.redirectRegistered === false;
  $('setupNotice').hidden = !needsSetup;
  $('redirectValue').textContent = st.redirectUri || '';
  $('connectError').textContent = message || '';
  $('connectError').hidden = !message;
  if (!st.configured) {
    $('connectError').textContent = 'Missing WHOOP_CLIENT_ID or WHOOP_CLIENT_SECRET in .env. Add them and restart the server.';
    $('connectError').hidden = false;
  }
  $('connectBtn').disabled = !st.configured;
  if (needsSetup) startPolling();
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    const { body } = await getJSON('/api/status').catch(() => ({ body: null }));
    if (!body) return;
    state.status = body;
    if (body.redirectRegistered !== false) {
      $('setupNotice').hidden = true;
      stopPolling();
    }
  }, 15_000);
}
function stopPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

$('copyRedirect').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('redirectValue').textContent);
    $('copyRedirect').textContent = 'Copied';
    setTimeout(() => ($('copyRedirect').textContent = 'Copy'), 1600);
  } catch {
    $('copyRedirect').textContent = 'Select and copy';
  }
});

$('connectBtn').addEventListener('click', () => {
  if (state.status?.manualMode) {
    window.open('/login', '_blank', 'noopener');
    $('manualForm').hidden = false;
    $('manualUrl').focus();
  } else {
    location.href = '/login';
  }
});

$('manualForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  if (btn) btn.disabled = true;
  try {
    const { res, body } = await getJSON('/api/manual-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirectedUrl: $('manualUrl').value }),
    });
    if (!res.ok) throw new Error(body.message || 'Login failed');
    $('manualUrl').value = '';
    $('manualForm').hidden = true;
    state.status = { ...state.status, connected: true };
    await openDashboard();
  } catch (err) {
    $('connectError').textContent = err.message;
    $('connectError').hidden = false;
  } finally {
    if (btn) btn.disabled = false;
  }
});

$('demoBtn').addEventListener('click', () => {
  state.demo = true;
  openDashboard();
});
$('exitDemoBtn').addEventListener('click', () => {
  state.demo = false;
  state.data = null;
  renderConnect();
});
$('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  state.data = null;
  state.status = { ...state.status, connected: false };
  renderConnect('You are logged out. Your login and cached WHOOP history were removed from this computer. Files in the exports folder are kept.');
});
$('refreshBtn').addEventListener('click', () => load({ fresh: true }));

// ---------- range filter ----------
function syncView() {
  for (const b of $('viewControl').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
  $('classicView').hidden = state.view !== 'dashboard';
  $('cockpitView').hidden = state.view !== 'cockpit';
}
$('viewControl').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (!b || b.dataset.view === state.view) return;
  state.view = b.dataset.view;
  store.set('view', state.view);
  if (state.data) render();
  else syncView();
});

function syncRange() {
  for (const b of $('rangeControl').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.days === String(state.days)));
}
$('rangeControl').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-days]');
  if (!b) return;
  state.days = b.dataset.days === 'all' ? 'all' : Number(b.dataset.days);
  store.set('days', String(state.days));
  syncRange();
  load();
});

// ---------- loading ----------
function setLoading(on) {
  for (const n of document.querySelectorAll('.chart-host, .table-wrap, .overview, .tiles')) n.classList.toggle('loading', on);
  $('refreshBtn').disabled = on;
}

async function openDashboard() {
  showView('dash');
  syncRange();
  await load();
}

async function staticDemo(days) {
  const { demoResponse } = await import('./lib/demo.js');
  return { res: { ok: true, status: 200 }, body: demoResponse(days === 'all' ? 'all' : Number(days)) };
}

async function load({ fresh = false } = {}) {
  const id = ++state.requestId;
  setLoading(true);
  if (isAll() && !state.demo) $('updatedAt').textContent = 'Loading full history…';
  try {
    const url = state.demo ? `/api/demo?days=${state.days}` : `/api/dashboard?days=${state.days}${fresh ? '&fresh=1' : ''}`;
    const { res, body } = STATIC_DEMO ? await staticDemo(state.days) : await getJSON(url);
    if (id !== state.requestId) return; // a newer request superseded this one
    if (res.status === 401) {
      state.data = null;
      state.status = { ...state.status, connected: false };
      renderConnect(body.message || 'Your WHOOP session ended. Please connect again.');
      return;
    }
    if (!res.ok) throw new Error(body.message || `Request failed (${res.status})`);
    state.data = body;
    showError('');
    render();
  } catch (err) {
    if (id === state.requestId) showError(`Could not load WHOOP data. ${err.message}`);
  } finally {
    if (id === state.requestId) setLoading(false);
  }
}

// ---------- dashboard rendering ----------
const STRENGTH = /weight|power|strength|functional|crossfit|bodybuild|kettlebell|calisthenic/i;
const EMPTY_ACT = { workouts: 0, zone13Ms: 0, zone45Ms: 0, strengthMs: 0, kcal: 0, distanceKm: 0, climbM: 0 };
const restorativeMs = (s) => (s && s.swsMs != null ? (s.swsMs || 0) + (s.remMs || 0) : null);
const minutes = (ms) => (ms == null ? null : ms / 60_000);
const fmtMin = (m) => {
  if (m == null || !Number.isFinite(m)) return '–';
  const r = Math.round(m);
  return r >= 60 ? `${Math.floor(r / 60)}h ${String(r % 60).padStart(2, '0')}m` : `${r}m`;
};
// Uth–Sørensen estimate: VO2 max ≈ 15.3 × max HR ÷ resting HR (ml/kg/min). Not WHOOP's own method.
const vo2 = (maxHr, rhr) => (maxHr && rhr ? (15.3 * maxHr) / rhr : null);
let currentUnit = 'day';
let currentSpanDays = 30;

// How each chart's trend slope is written, per period (absolute value; the sign is added separately).
const minSig = (m) => (Math.abs(m) < 1 ? `${fmt.sig(m)}m` : fmtMin(m));
const TREND_FMT = {
  recovery: (v) => `${fmt.sig(v)} pts`,
  hrv: (v) => `${fmt.sig(v)} ms`,
  rhr: (v) => `${fmt.sig(v)} bpm`,
  resp: (v) => `${fmt.sig(v)} breaths/min`,
  spo2: (v) => `${fmt.sig(v)} pts`,
  skin: (v) => `${fmt.sig(v)} °C`,
  sleep: (v) => minSig(v * 60),
  sleepNeed: (v) => minSig(v * 60),
  sleepPerf: (v) => `${fmt.sig(v)} pts`,
  sleepQuality: (v) => `${fmt.sig(v)} pts`,
  strain: (v) => fmt.sig(v),
  steps: (v) => `${fmt.int(v)} steps`,
  zones: (v) => minSig(v),
  strength: (v) => minSig(v),
  vo2: (v) => `${fmt.sig(v)} ml/kg/min`,
  hrvBase: (v) => `${fmt.sig(v)} ms`,
  illness: (v) => `${fmt.sig(v)} signals`,
  load: (v) => fmt.sig(v),
  sleepTiming: (v) => minSig(v),
  hrvCv: (v) => `${fmt.sig(v)} pts`,
  sri: (v) => `${fmt.sig(v)} pts`,
  stepsDose: (v) => `${fmt.int(v)} steps`,
  energy: (v) => `${fmt.int(v)} kcal`,
  distance: (v) => `${fmt.sig(v)} km`,
};
// Which direction is healthy for each chart's trend (per series for two-series charts).
// Charts not listed (strain, skin temp, respiratory rate, sleep timing) stay neutral grey.
const TREND_BETTER = {
  recovery: 'up',
  hrv: 'up',
  rhr: 'down',
  spo2: 'up',
  sleep: 'up',
  sleepPerf: 'up',
  sleepNeed: { Asleep: 'up' },
  sleepQuality: { Consistency: 'up', Efficiency: 'up' },
  steps: 'up',
  zones: 'up',
  strength: 'up',
  vo2: 'up',
  hrvBase: 'up',
  illness: 'down',
  hrvCv: 'down',
  sri: 'up',
  stepsDose: 'up',
  distance: 'up',
};
function trendInfo(id, spec) {
  const trends = trendLines(spec);
  if (!trends.length) return null;
  const period = currentSpanDays <= 31 ? ['week', 7] : currentSpanDays <= 366 ? ['month', 30.44] : ['year', 365.25];
  const daysPerRow = currentUnit === 'day' ? 1 : currentUnit === 'week' ? 7 : 30.44;
  const f = TREND_FMT[id] || ((v) => fmt.sig(v));
  const items = trends.map((t) => {
    const v = (t.slope / daysPerRow) * period[1];
    const shown = f(Math.abs(v));
    // a change smaller than 2% of the metric's level over the shown period counts as flat
    const level = Math.abs(t.intercept + (t.slope * (t.first + t.last)) / 2);
    const tiny = !level || Math.abs(t.slope * (t.last - t.first)) / level < 0.02;
    const flat = tiny || /^0([.,]0+)?( |m|$)/.test(shown);
    let status = 'neutral';
    let word = '';
    if (id === 'load') {
      // the load ratio is judged by where its trend ends up, not by direction
      const end = t.intercept + t.slope * t.last;
      status = end >= 0.8 && end <= 1.3 ? 'good' : 'bad';
      word = status === 'good' ? 'holding in the 0.8–1.3 range' : 'heading outside the 0.8–1.3 range';
    } else if (!flat) {
      const b = TREND_BETTER[id];
      const better = b && typeof b === 'object' ? b[t.label] : b;
      if (better) status = (v > 0) === (better === 'up') ? 'good' : 'bad';
    }
    if (!word && status !== 'neutral') word = status === 'good' ? 'improving' : 'worsening';
    return { label: t.label, text: flat ? 'flat' : `${v > 0 ? '▲' : '▼'} ${shown}`, status, word };
  });
  return { period: period[0], items, multi: trends.length > 1, stack: spec.type === 'stack' };
}
function warnIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ width: '13', height: '13', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  for (const d of ['M12 3 2 21h20L12 3z', 'M12 10v5', 'M12 18h.01']) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}
function trendChips(info) {
  return h('div', { class: 'trend-row' }, info.items.map((it) => {
    const prefix = info.multi ? `${it.label}: ` : info.stack ? 'Total trend ' : 'Trend ';
    const text = it.text === 'flat' ? `${prefix}flat` : `${prefix}${it.text} per ${info.period}`;
    const chip = h('span', { class: `trend-chip ${it.status}`, title: it.word ? `${text}, ${it.word}` : text });
    if (it.status === 'bad') chip.append(warnIcon());
    const key = h('span', { class: 'swatch trend' });
    key.style.setProperty('--key', 'currentColor');
    chip.append(key, text);
    if (it.word) chip.append(h('span', { class: 'sr-only', text: `, ${it.word}` }));
    return chip;
  }));
}

// Attach per-day workout totals (heart-rate zone time, strength time) by the member's local date.
function withActivity(days, workouts) {
  const byDate = new Map();
  for (const w of workouts) {
    const date = w.localStart.slice(0, 10);
    const a = byDate.get(date) || { ...EMPTY_ACT };
    a.workouts += 1;
    if (w.zonesMs) {
      a.zone13Ms += w.zonesMs[1] + w.zonesMs[2] + w.zonesMs[3];
      a.zone45Ms += w.zonesMs[4] + w.zonesMs[5];
    }
    if (STRENGTH.test(w.sport)) a.strengthMs += w.durationMs || 0;
    if (w.kilojoule != null) a.kcal += w.kilojoule / 4.184;
    if (w.distanceMeter) a.distanceKm += w.distanceMeter / 1000;
    if (w.altitudeGainMeter > 0) a.climbM += w.altitudeGainMeter;
    byDate.set(date, a);
  }
  return days.map((d) => ({ ...d, act: byDate.get(d.date) || { ...EMPTY_ACT } }));
}

function render() {
  const d = state.data;
  $('demoBanner').hidden = !d.demo;
  const p = d.profile;
  $('who').textContent = p ? `${p.firstName} ${p.lastName}`.trim() + (d.demo ? ' (sample)' : '') : '';
  const since = d.history?.firstDate ? ` · history since ${fmtDate(d.history.firstDate, { month: 'short', day: 'numeric', year: 'numeric' })}` : '';
  $('updatedAt').textContent = `Updated ${fmt.time(d.generatedAt)}${since}`;
  const insByDate = d.insights?.byDate || {};
  const days = withActivity(d.days, d.workouts).map((x) => ({ ...x, ins: insByDate[x.date] || null }));
  const { rows, unit } = aggregate(days);
  const ctx = { days, rows, unit, maxHr: d.body?.maxHr ?? null, insights: d.insights || null, body: d.body || null, workouts: d.workouts };
  state.ctx = ctx;
  syncView();
  if (state.view === 'cockpit') {
    $('overview').replaceChildren();
    $('sections').replaceChildren();
    renderCockpit(ctx);
  } else {
    $('cockpitCanvas').replaceChildren();
    $('paletteList').replaceChildren();
    renderOverview(ctx);
    renderSections(ctx);
    renderWorkouts(d.workouts);
    renderBody(d.body);
  }
}

function latest(days, pick) {
  for (let i = days.length - 1; i >= 0; i--) if (pick(days[i]) != null) return { day: days[i], index: i };
  return null;
}
const dayLabel = (iso) => (iso === todayIso() ? 'Today' : fmt.day(iso));

// ---------- overview: recovery, strain, sleep ----------
function meterEl(pct, color, label) {
  const fill = h('span');
  fill.style.width = `${Math.max(2, Math.min(100, pct))}%`;
  fill.style.background = color;
  const m = h('div', { class: 'meter', role: 'img', 'aria-label': label }, fill);
  m.style.background = `color-mix(in srgb, ${color} 18%, var(--surface))`;
  return m;
}
const strainLevel = (s) => (s >= 18 ? 'All out' : s >= 14 ? 'High' : s >= 10 ? 'Moderate' : 'Light');
function sleepZone(p) {
  if (p >= 85) return { key: 'good', label: 'Optimal', color: 'var(--good)' };
  if (p >= 70) return { key: 'warning', label: 'Sufficient', color: 'var(--warning)' };
  return { key: 'critical', label: 'Poor', color: 'var(--critical)' };
}
function overviewCard({ label, value, unit, chip, meter, sub, empty }) {
  const card = h('article', { class: 'card ov-card' });
  if (empty) {
    card.append(h('span', { class: 'label', text: label }), h('p', { class: 'muted', text: empty }));
    return card;
  }
  card.append(
    h('span', { class: 'label', text: label }),
    h('div', { class: 'value' }, value, unit ? h('span', { class: 'unit', text: unit }) : null),
    chip,
    meter,
    sub ? h('span', { class: 'sub', text: sub }) : null,
  );
  return card;
}
function overviewCardList({ days }) {
  const cards = [];
  const rec = latest(days, (d) => d.recovery?.score);
  if (rec) {
    const r = rec.day.recovery;
    const z = zoneOf(r.score);
    cards.push(overviewCard({
      label: `Recovery · ${dayLabel(rec.day.date)}`,
      value: String(Math.round(r.score)),
      unit: '%',
      chip: h('span', { class: 'zone-chip' }, statusIcon(z.key), `${z.label} recovery${r.calibrating ? ' · calibrating' : ''}`),
      meter: meterEl(r.score, z.color, `Recovery ${Math.round(r.score)} percent`),
      sub: `HRV ${fmt.int(r.hrv)} ms · Resting HR ${fmt.int(r.rhr)} bpm`,
    }));
  } else cards.push(overviewCard({ label: 'Recovery', empty: 'No scored recovery in this range yet.' }));

  const str = latest(days, (d) => d.strain);
  if (str) {
    const d = str.day;
    cards.push(overviewCard({
      label: `Strain · ${dayLabel(d.date)}${d.inProgress ? ' so far' : ''}`,
      value: fmt.one(d.strain),
      unit: '/ 21',
      chip: h('span', { class: 'zone-chip', text: `${strainLevel(d.strain)} strain` }),
      meter: meterEl((d.strain / 21) * 100, 'var(--series-1)', `Strain ${fmt.one(d.strain)} of 21`),
      sub: `${fmt.int(kcal(d.kilojoule))} kcal · avg HR ${fmt.int(d.avgHr)} bpm${d.steps != null ? ` · ${fmt.int(d.steps)} steps` : ''}`,
    }));
  } else cards.push(overviewCard({ label: 'Strain', empty: 'No strain recorded in this range yet.' }));

  const slp = latest(days, (d) => d.sleep?.performance);
  if (slp) {
    const s = slp.day.sleep;
    const z = sleepZone(s.performance);
    cards.push(overviewCard({
      label: `Sleep · ${dayLabel(slp.day.date)}`,
      value: fmt.int(s.performance),
      unit: '%',
      chip: h('span', { class: 'zone-chip' }, statusIcon(z.key), `${z.label} sleep`),
      meter: meterEl(s.performance, z.color, `Sleep performance ${fmt.int(s.performance)} percent`),
      sub: `${fmt.dur(asleepMs(s))} asleep of ${fmt.dur(s.neededMs)} needed`,
    }));
  } else cards.push(overviewCard({ label: 'Sleep', empty: 'No scored sleep in this range yet.' }));
  return [
    { key: 'recovery', name: 'Recovery today', el: cards[0] },
    { key: 'strain', name: 'Strain today', el: cards[1] },
    { key: 'sleep', name: 'Sleep last night', el: cards[2] },
  ];
}
function renderOverview(ctx) {
  $('overview').replaceChildren(...overviewCardList(ctx).map((c) => c.el));
}

// ---------- KPI tiles ----------
function deltaEl(value, avg, def, vsText) {
  const delta = h('span', { class: 'delta' });
  if (avg == null || value == null) {
    delta.textContent = def.kind === 'week' ? 'Choose a longer range to compare' : 'Not enough history';
    return delta;
  }
  const diff = value - avg;
  const shown = def.diff(diff);
  if (/^0([.,]0)?( pts|m)?$/.test(shown)) {
    delta.textContent = `Same as ${vsText}`;
    return delta;
  }
  const up = diff > 0;
  const cls = def.better == null ? 'neutral' : up === (def.better === 'up') ? (up ? 'up-good' : 'down-good') : up ? 'up-bad' : 'down-bad';
  delta.append(h('span', { class: cls, text: `${up ? '▲' : '▼'} ${shown}` }), ` vs ${vsText}`);
  return delta;
}

function tileEl(def, days) {
  const tile = h('article', { class: 'card tile' });
  let label = def.label;
  let value = null;
  let avg = null;
  let sub = null;
  let partialText = null;
  let status = null;
  let vs = `${rangeName()} avg`;
  if (def.kind === 'week') {
    const end = days.at(-1)?.date;
    if (end) {
      const cutoff = new Date(Date.parse(`${end}T12:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
      value = days.filter((d) => d.date >= cutoff).reduce((a, d) => a + (def.get(d) || 0), 0);
      const total = days.reduce((a, d) => a + (def.get(d) || 0), 0);
      avg = days.length >= 14 ? (total / days.length) * 7 : null;
    }
    label = `${def.label} · last 7 days`;
    vs = `${rangeName()} weekly avg`;
  } else if (def.kind === 'custom') {
    ({ value = null, avg = null, sub = null, status = null } = def.compute(days));
  } else {
    const hit = latest(days, def.get);
    if (hit) {
      value = def.get(hit.day);
      if (hit.day.date !== todayIso()) label += ` · ${fmt.day(hit.day.date)}`;
      sub = def.sub?.(hit.day) || null;
      avg = mean(days.filter((x, i) => i !== hit.index && !(def.partial && x.inProgress)).map(def.get));
      if (def.partial && hit.day.inProgress) partialText = `So far today · avg ${def.show(avg)}`;
    }
  }
  if (value == null) {
    tile.append(h('span', { class: 'label', text: def.label }), h('span', { class: 'value', text: '–' }), h('span', { class: 'delta', text: def.emptyText || 'No data in this range' }));
    return tile;
  }
  tile.append(
    h('span', { class: 'label', text: label }),
    h('span', { class: 'value' }, def.show(value), def.unit ? h('span', { class: 'unit', text: def.unit }) : null),
  );
  if (sub) tile.append(h('span', { class: 'tile-sub', text: sub }));
  if (status) {
    tile.append(h('span', { class: 'delta status-line' }, status.key === 'neutral' ? null : statusIcon(status.key), status.text));
    return tile;
  }
  if (def.noDelta) return tile;
  tile.append(partialText ? h('span', { class: 'delta', text: partialText }) : deltaEl(value, avg, def, vs));
  return tile;
}

const num1 = (v) => fmt.one(Math.abs(v));
const int0 = (v) => fmt.int(Math.abs(v));
const minsDiff = (v) => fmt.mins(Math.abs(v));

// ---------- chart cards ----------
function legendEl(items) {
  return h('div', { class: 'legend' }, items.map((it) => {
    const key = it.icon ? statusIcon(it.icon) : h('span', { class: it.shape ? `swatch ${it.shape}` : 'swatch' });
    if (!it.icon) key.style.setProperty('--key', it.color);
    return h('span', { class: 'item' }, key, it.label);
  }));
}

function tableEl(rows, columns) {
  const thead = h('thead', {}, h('tr', {}, columns.map((c) => h('th', { class: c.num ? 'num' : null, scope: 'col', text: c.label }))));
  const tbody = h('tbody', {}, [...rows].reverse().map((r) => h('tr', {}, columns.map((c) => h('td', { class: c.num ? 'num' : null, text: c.value(r) })))));
  return h('div', { class: 'table-wrap data-table' }, h('table', {}, thead, tbody));
}

function chartCard({ id, title, subtitle, legend, spec, columns, totals = false, peak = false, fixedAxis = false, wide = false }) {
  const period = currentUnit === 'week' ? 'week' : 'month';
  const note = currentUnit === 'day' || fixedAxis ? '' : peak ? ` · highest day each ${period}` : ` · ${period}ly ${totals ? 'totals' : 'averages'}`;
  if (currentUnit !== 'day' && !fixedAxis) spec.xFormat = fmtMonthYear;
  const tInfo = spec.trend === false ? null : trendInfo(id, spec);
  let trendNote = null;
  if (tInfo) {
    // the dashed trendline in the chart takes the same good / bad color as its chip
    spec.trendColors = Object.fromEntries(tInfo.items.map((it) => [it.label, it.status === 'good' ? 'var(--good)' : it.status === 'bad' ? 'var(--critical)' : null]));
    trendNote = trendChips(tInfo);
  }
  const host = h('div', { class: 'chart-host' });
  const tableHost = h('div');
  const isTable = state.tableMode.has(id);
  const toggle = h('button', { type: 'button', class: 'linkbtn', 'aria-pressed': String(isTable), text: isTable ? 'Show chart' : 'Show table' });
  const card = h('article', { class: wide ? 'card chart-card wide' : 'card chart-card', 'aria-labelledby': `${id}-title` },
    h('header', { class: 'card-head' },
      h('div', {},
        h('h3', { id: `${id}-title`, text: title }),
        subtitle ? h('p', { class: 'muted small', text: subtitle + note }) : null,
        trendNote,
      ),
      h('div', { class: 'card-tools' }, legend ? legendEl(legend) : null, toggle),
    ),
    host,
    tableHost,
  );
  const apply = () => {
    const tableOn = state.tableMode.has(id);
    toggle.textContent = tableOn ? 'Show chart' : 'Show table';
    toggle.setAttribute('aria-pressed', String(tableOn));
    host.hidden = tableOn;
    tableHost.replaceChildren(tableOn ? tableEl(spec.tableData || spec.data, columns) : '');
    if (!tableOn) renderChart(host, spec);
  };
  toggle.addEventListener('click', () => {
    if (state.tableMode.has(id)) state.tableMode.delete(id);
    else state.tableMode.add(id);
    apply();
  });
  return { card, apply };
}

// Single-series line chart with the common table + tooltip wiring.
function lineCard({ id, title, subtitle, rows, value, color, label, show, yTicks, yFloor }) {
  return {
    id,
    title,
    subtitle,
    spec: {
      type: 'line',
      data: rows,
      x: (d) => d.date,
      series: [{ label, value, color }],
      yTicks,
      yFloor,
      yFormat: show,
      ariaLabel: `${title} line chart`,
      tooltip: (d) => ({ title: periodLabel(d), rows: [{ color, value: value(d) == null ? 'No data' : show(value(d)), label }] }),
    },
    columns: [
      { label: currentUnit === 'day' ? 'Date' : currentUnit === 'week' ? 'Week of' : 'Month', value: (d) => periodLabel(d, true) },
      { label, num: true, value: (d) => (value(d) == null ? '–' : show(value(d))) },
    ],
  };
}

function healthspanCard({ days, maxHr }) {
  const weeks = Math.max(1, days.length / 7);
  const sum = (f) => days.reduce((a, d) => a + (f(d) || 0), 0);
  const rhrs = days.map((d) => d.recovery?.rhr).filter((v) => v != null);
  const v = vo2(maxHr, mean(rhrs.slice(-30)));
  const items = [
    ['Sleep consistency', mean(days.map((d) => d.sleep?.consistency)) == null ? '–' : `${fmt.int(mean(days.map((d) => d.sleep?.consistency)))}%`, 'Average'],
    ['Hours of sleep', fmt.dur(mean(days.map((d) => asleepMs(d.sleep)))), 'Average per night'],
    ['Time in HR zones 1–3', fmtMin(minutes(sum((d) => d.act.zone13Ms)) / weeks), 'Per week, during recorded activities'],
    ['Time in HR zones 4–5', fmtMin(minutes(sum((d) => d.act.zone45Ms)) / weeks), 'Per week, during recorded activities'],
    ['Strength activity time', fmtMin(minutes(sum((d) => d.act.strengthMs)) / weeks), 'Per week'],
    ['Daily steps', fmt.int(mean(days.map((d) => (d.inProgress ? null : d.steps)))), 'Average per day'],
    ['VO2 max', v == null ? '–' : `${fmt.one(v)} ml/kg/min`, 'Estimate, last 30 days'],
    ['Resting heart rate', rhrs.length ? `${fmt.int(mean(rhrs))} bpm` : '–', 'Average'],
    ['Lean body mass', '–', 'Only in the WHOOP app'],
  ];
  const tbody = h('tbody', {}, items.map(([m, val, basis]) => h('tr', {}, h('td', { text: m }), h('td', { class: 'num', text: val }), h('td', { class: 'muted', text: basis }))));
  return h('article', { class: 'card' },
    h('header', { class: 'card-head' }, h('div', {},
      h('h3', { text: 'Healthspan inputs' }),
      h('p', { class: 'muted small', text: `The nine metrics WHOOP uses to calculate WHOOP Age, for the ${isAll() ? 'whole history' : `last ${state.days} days`}. WHOOP Age itself is not available through the API.` }),
    )),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Metric' }), h('th', { scope: 'col', class: 'num', text: 'Value' }), h('th', { scope: 'col', text: 'Basis' }))),
      tbody)),
  );
}

// ---------- insights: HRV baseline, illness warning, training load, sleep timing, year over year ----------
// Clock values are minutes since 18:00 local (see lib/insights.js).
const fmtClock = (m) => {
  if (m == null || !Number.isFinite(m)) return '–';
  const total = Math.round(m + 18 * 60) % 1440;
  return new Date(Date.UTC(2000, 0, 1, Math.floor(total / 60), total % 60)).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
};
const signedMin = (m) => `${m >= 0 ? '+' : '−'}${fmtMin(Math.abs(m))}`;
const sdOf = (arr) => {
  const v = arr.filter((x) => x != null && Number.isFinite(x));
  if (v.length < 2) return null;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1));
};
const LOAD_STATUS = {
  low: { key: 'warning', text: 'Below 0.8: lighter than your usual load' },
  optimal: { key: 'good', text: 'In the 0.8–1.3 range' },
  high: { key: 'warning', text: '1.3–1.5: ramping up quickly' },
  'very high': { key: 'critical', text: 'Above 1.5: sharp jump in load' },
};
const ILLNESS = {
  clear: { key: 'good', label: 'Clear' },
  watch: { key: 'warning', label: 'Watch' },
  warning: { key: 'critical', label: 'Warning' },
};
const sinceLabel = (iso) => (iso === todayIso() ? '' : ` · ${fmt.day(iso)}`);

function sleepTiming(days) {
  const nights = days.filter((d) => d.ins?.bedMin != null && d.ins?.wakeMin != null);
  if (nights.length < 3) return null;
  const isWeekend = (d) => [0, 6].includes(new Date(`${d.date}T12:00:00Z`).getUTCDay()); // woke Sat/Sun
  const mid = (d) => (d.ins.bedMin + d.ins.wakeMin) / 2;
  const we = nights.filter(isWeekend).map(mid);
  const wd = nights.filter((d) => !isWeekend(d)).map(mid);
  return {
    nights: nights.length,
    bed: mean(nights.map((d) => d.ins.bedMin)),
    bedSd: sdOf(nights.map((d) => d.ins.bedMin)),
    wake: mean(nights.map((d) => d.ins.wakeMin)),
    wakeSd: sdOf(nights.map((d) => d.ins.wakeMin)),
    weekendShift: we.length >= 2 && wd.length >= 3 ? mean(we) - mean(wd) : null,
  };
}

function insightsSection({ days, rows, unit, insights }) {
  if (!insights) {
    return {
      id: 'insights',
      title: 'Insights',
      tiles: [],
      charts: [],
      extra: [h('article', { class: 'card wide' }, h('p', { class: 'muted', text: 'Insights need your full history, which could not be loaded. Try Refresh.' }))],
    };
  }
  const cur = insights.current || {};
  const dateCol = { label: unit === 'day' ? 'Date' : unit === 'week' ? 'Week of' : 'Month', value: (d) => periodLabel(d, true) };
  const timing = sleepTiming(days);
  const flagged = (lvl) => days.filter((d) => d.ins?.illness === lvl).length;
  const clockTicks = (() => {
    const vals = rows.flatMap((d) => [d.ins?.bedMin, d.ins?.wakeMin]).filter((v) => v != null);
    if (!vals.length) return undefined;
    const step = Math.max(...vals) - Math.min(...vals) > 8 * 60 ? 120 : 60;
    const lo = Math.floor(Math.min(...vals) / step) * step;
    const hi = lo + step * Math.ceil((Math.max(...vals) - lo) / step);
    const out = [];
    for (let v = lo; v <= hi; v += step) out.push(v);
    return out.length >= 2 ? out : undefined;
  })();
  const signalColor = (n) => (n >= 3 ? 'var(--critical)' : n === 2 ? 'var(--warning)' : 'var(--mark-neutral)');

  return {
    id: 'insights',
    title: 'Insights',
    tiles: [
      {
        kind: 'custom',
        label: `HRV versus baseline${cur.hrv ? sinceLabel(cur.hrv.date) : ''}`,
        unit: 'ms',
        show: fmt.int,
        emptyText: 'Needs about 10 weeks of HRV data',
        compute: () => {
          const x = cur.hrv;
          if (!x) return {};
          const pct = Math.round(((x.hrv7 - x.base) / x.base) * 100);
          return {
            value: x.hrv7,
            sub: `7-day average · normal ${fmt.int(x.lo)}–${fmt.int(x.hi)} ms`,
            status: x.status === 'below'
              ? { key: 'warning', text: `${Math.abs(pct)}% below your baseline` }
              : x.status === 'above'
                ? { key: 'good', text: `${pct}% above your baseline` }
                : { key: 'good', text: 'Within your normal range' },
          };
        },
      },
      {
        kind: 'custom',
        label: `Illness warning${cur.illness ? sinceLabel(cur.illness.date) : ''}`,
        unit: '',
        show: (v) => v,
        emptyText: 'Needs about 2 weeks of data',
        compute: () => {
          const x = cur.illness;
          if (!x) return {};
          const lv = ILLNESS[x.level];
          return {
            value: lv.label,
            sub: `${x.warningDays90} warning and ${x.watchDays90} watch days in the last 90 days`,
            status: { key: lv.key, text: x.signals.length ? `Out of range: ${x.signals.map((s) => s.label.toLowerCase()).join(', ')}` : 'All signals in your normal range' },
          };
        },
      },
      {
        kind: 'custom',
        label: `Training load ratio${cur.load ? sinceLabel(cur.load.date) : ''}`,
        unit: '',
        show: (v) => nf2.format(v),
        emptyText: 'Needs 4 weeks of recorded activities',
        compute: () => {
          const x = cur.load;
          if (!x) return {};
          return { value: x.acwr, sub: `7-day ${fmt.int(x.acute)} versus 28-day ${fmt.int(x.chronic)} load per day`, status: LOAD_STATUS[x.zone] };
        },
      },
      {
        kind: 'custom',
        label: 'Average bedtime',
        unit: '',
        show: fmtClock,
        emptyText: 'Not enough nights in this range',
        compute: () => (timing ? { value: timing.bed, sub: `Varies ±${fmtMin(timing.bedSd)} night to night`, status: timing.bedSd <= 30 ? { key: 'good', text: 'Regular' } : timing.bedSd <= 60 ? { key: 'warning', text: 'Somewhat irregular' } : { key: 'critical', text: 'Irregular' } } : {}),
      },
      {
        kind: 'custom',
        label: 'Average wake time',
        unit: '',
        show: fmtClock,
        emptyText: 'Not enough nights in this range',
        compute: () => (timing ? { value: timing.wake, sub: `Varies ±${fmtMin(timing.wakeSd)} night to night`, status: timing.wakeSd <= 30 ? { key: 'good', text: 'Regular' } : timing.wakeSd <= 60 ? { key: 'warning', text: 'Somewhat irregular' } : { key: 'critical', text: 'Irregular' } } : {}),
      },
      {
        kind: 'custom',
        label: 'Weekend shift',
        unit: '',
        show: signedMin,
        emptyText: 'Needs weekday and weekend nights',
        compute: () => (timing?.weekendShift != null
          ? {
              value: timing.weekendShift,
              sub: `Sleep midpoint on weekends versus weekdays`,
              status: Math.abs(timing.weekendShift) <= 30 ? { key: 'good', text: 'Small shift' } : Math.abs(timing.weekendShift) <= 60 ? { key: 'warning', text: 'Moderate shift' } : { key: 'critical', text: 'Large shift' },
            }
          : {}),
      },
    ],
    charts: [
      ...(calendarDefs(insights).illness ? [calendarDefs(insights).illness] : []),
      {
        id: 'hrvBase',
        title: 'HRV versus baseline',
        subtitle: `7-day average against your normal range: the previous 60 days' average ± half a standard deviation`,
        legend: [{ color: 'var(--series-7)', label: '7-day HRV', shape: 'line' }, { color: 'var(--series-7)', label: 'Normal range', shape: 'band' }],
        spec: {
          type: 'line',
          data: rows,
          x: (d) => d.date,
          series: [{ label: '7-day HRV', value: (d) => d.ins?.hrv7 ?? null, color: 'var(--series-7)' }],
          band: { lo: (d) => d.ins?.hrvLo ?? null, hi: (d) => d.ins?.hrvHi ?? null, color: 'var(--series-7)' },
          yFormat: (v) => fmt.int(v),
          ariaLabel: 'HRV versus baseline line chart',
          emptyText: 'Needs about 10 weeks of HRV data.',
          tooltip: (d) => ({
            title: periodLabel(d),
            rows: d.ins?.hrv7 != null
              ? [
                  { color: 'var(--series-7)', value: `${fmt.int(d.ins.hrv7)} ms`, label: '7-day HRV' },
                  { value: `${fmt.int(d.ins.hrvLo)}–${fmt.int(d.ins.hrvHi)} ms`, label: 'Normal range' },
                ]
              : [{ value: 'Not enough history', label: '' }],
          }),
        },
        columns: [
          dateCol,
          { label: '7-day HRV', num: true, value: (d) => fmt.int(d.ins?.hrv7) },
          { label: 'Normal low', num: true, value: (d) => fmt.int(d.ins?.hrvLo) },
          { label: 'Normal high', num: true, value: (d) => fmt.int(d.ins?.hrvHi) },
          { label: 'Status', value: (d) => d.ins?.hrvStatus || '–' },
        ],
      },
      {
        id: 'illness',
        peak: true,
        title: 'Illness warning signals',
        subtitle: `Resting HR, HRV, respiratory rate and skin temp unusually far from your last 30 days · ${flagged('warning')} warning and ${flagged('watch')} watch days in this range`,
        legend: [{ color: 'var(--mark-neutral)', label: '1 signal' }, { icon: 'warning', label: '2: watch' }, { icon: 'critical', label: '3–4: warning' }],
        spec: {
          type: 'bar',
          data: rows,
          x: (d) => d.date,
          series: [{ label: 'Signals out of range', value: (d) => d.ins?.signalCount ?? null, color: 'var(--mark-neutral)' }],
          colorFor: (d) => signalColor(d.ins?.signalCount ?? 0),
          yTicks: [0, 1, 2, 3, 4],
          ariaLabel: 'Illness warning signals bar chart',
          tooltip: (d) => {
            const sig = d.ins?.signals || [];
            const n = d.ins?.signalCount;
            const lvl = ILLNESS[d.ins?.illness || 'clear'];
            return {
              title: `${periodLabel(d)}${d.bucket ? ' · highest day' : ''}`,
              rows: n == null
                ? [{ value: 'Not enough history', label: '' }]
                : [
                    { icon: lvl.key, value: lvl.label, label: `${n} of 4 signals` },
                    ...sig.map((s) => ({ value: `${fmt.auto(+s.value.toFixed(1))} ${s.unit}`, label: `${s.label}, usual ${fmt.auto(+s.baseline.toFixed(1))}` })),
                  ],
            };
          },
        },
        columns: [
          dateCol,
          { label: 'Signals', num: true, value: (d) => fmt.int(d.ins?.signalCount) },
          { label: 'Level', value: (d) => (d.ins?.illness ? ILLNESS[d.ins.illness].label : '–') },
          { label: 'Out of range', value: (d) => (d.ins?.signals || []).map((s) => s.label).join(', ') || '–' },
        ],
      },
      {
        id: 'load',
        title: 'Training load ratio',
        subtitle: '7-day versus 28-day load from recorded activities. Load counts each minute in heart-rate zone N as N',
        legend: [{ color: 'var(--series-1)', label: 'Ratio', shape: 'line' }, { color: 'var(--good)', label: '0.8–1.3', shape: 'band' }],
        spec: {
          type: 'line',
          data: rows,
          x: (d) => d.date,
          series: [{ label: 'Load ratio', value: (d) => d.ins?.acwr ?? null, color: 'var(--series-1)' }],
          band: { lo: () => 0.8, hi: () => 1.3, color: 'var(--good)' },
          yFloor: 0,
          yFormat: (v) => nf2.format(v),
          ariaLabel: 'Training load ratio line chart',
          emptyText: 'Needs 4 weeks of recorded activities.',
          tooltip: (d) => ({
            title: periodLabel(d),
            rows: d.ins?.acwr != null
              ? [
                  { color: 'var(--series-1)', value: nf2.format(d.ins.acwr), label: 'Load ratio' },
                  { value: fmt.int(d.ins.acute), label: '7-day load per day' },
                  { value: fmt.int(d.ins.chronic), label: '28-day load per day' },
                ]
              : [{ value: 'Not enough history', label: '' }],
          }),
        },
        columns: [
          dateCol,
          { label: 'Ratio', num: true, value: (d) => (d.ins?.acwr == null ? '–' : nf2.format(d.ins.acwr)) },
          { label: '7-day load', num: true, value: (d) => fmt.int(d.ins?.acute) },
          { label: '28-day load', num: true, value: (d) => fmt.int(d.ins?.chronic) },
          { label: 'Zone', value: (d) => d.ins?.loadZone || '–' },
        ],
      },
      {
        id: 'sleepTiming',
        title: 'Bedtime and wake time',
        subtitle: timing ? `Average ${fmtClock(timing.bed)} to ${fmtClock(timing.wake)} over ${timing.nights} nights` : 'Main sleep each night',
        legend: [{ color: 'var(--series-1)', label: 'Bedtime', shape: 'line' }, { color: 'var(--series-2)', label: 'Wake time', shape: 'line' }],
        spec: {
          type: 'line',
          data: rows,
          x: (d) => d.date,
          series: [
            { label: 'Bedtime', value: (d) => d.ins?.bedMin ?? null, color: 'var(--series-1)' },
            { label: 'Wake time', value: (d) => d.ins?.wakeMin ?? null, color: 'var(--series-2)' },
          ],
          yTicks: clockTicks,
          yFormat: fmtClock,
          ariaLabel: 'Bedtime and wake time line chart',
          tooltip: (d) => ({
            title: periodLabel(d),
            rows: d.ins?.bedMin != null
              ? [
                  { color: 'var(--series-2)', value: fmtClock(d.ins.wakeMin), label: 'Wake time' },
                  { color: 'var(--series-1)', value: fmtClock(d.ins.bedMin), label: 'Bedtime' },
                ]
              : [{ value: 'No sleep recorded', label: '' }],
          }),
        },
        columns: [
          dateCol,
          { label: 'Bedtime', num: true, value: (d) => fmtClock(d.ins?.bedMin) },
          { label: 'Wake time', num: true, value: (d) => fmtClock(d.ins?.wakeMin) },
        ],
      },
    ],
  };
}

// ---------- health markers: chronotype, BMI, HRV stability, sleep regularity, step dose, workout timing ----------
const clockAbs = (m) => {
  const total = ((Math.round(m) % 1440) + 1440) % 1440;
  return new Date(Date.UTC(2000, 0, 1, Math.floor(total / 60), total % 60)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
};
const hourLabel = (hr) => new Date(Date.UTC(2000, 0, 1, hr)).toLocaleTimeString(undefined, { hour: 'numeric', timeZone: 'UTC' });
const DAYPARTS = [
  { key: 'morning', label: 'Morning', from: 5, to: 12, color: 'var(--series-1)' },
  { key: 'afternoon', label: 'Afternoon', from: 12, to: 17, color: 'var(--series-2)' },
  { key: 'evening', label: 'Evening', from: 17, to: 21, color: 'var(--series-3)' },
  { key: 'night', label: 'Night', from: 21, to: 29, color: 'var(--series-4)' },
];
const partOf = (hr) => DAYPARTS.find((p) => (hr >= p.from && hr < p.to) || (hr + 24 >= p.from && hr + 24 < p.to));
const pct = (x) => `${Math.round(x * 100)}%`;

// Workouts by local start hour, plus how many hard ones (strain 10+) ended within 4 h of the
// next main sleep: Leota et al. 2025 linked those to later, shorter sleep and lower HRV.
const HARD_STRAIN = 10;
function workoutTiming(workouts, days) {
  const sleepStarts = days.map((d) => (d.sleep?.startLocal ? Date.parse(`${d.sleep.startLocal}Z`) : null)).filter((x) => x != null).sort((a, b) => a - b);
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0, part: partOf(hour) }));
  let late = 0;
  let judged = 0;
  for (const w of workouts) {
    const startT = Date.parse(w.localStart);
    hours[new Date(startT).getUTCHours()].count += 1;
    if (!(w.strain >= HARD_STRAIN)) continue;
    const endT = startT + (w.durationMs || 0);
    const next = sleepStarts.find((s) => s > endT);
    if (next != null && next - endT < 24 * 3_600_000) {
      judged += 1;
      if (next - endT < 4 * 3_600_000) late += 1;
    }
  }
  const total = workouts.length;
  const parts = DAYPARTS.map((p) => ({ ...p, count: hours.filter((x) => x.part.key === p.key).reduce((a, x) => a + x.count, 0) }));
  const top = [...parts].sort((a, b) => b.count - a.count)[0];
  return { hours, parts, top, total, late, judged };
}

function markersSection({ days, rows, unit, insights, body, workouts }) {
  const cur = insights?.current || {};
  const dateCol = { label: unit === 'day' ? 'Date' : unit === 'week' ? 'Week of' : 'Month', value: (d) => periodLabel(d, true) };
  const timing = workoutTiming(workouts, days);
  const share7k = (() => {
    const ds = days.filter((d) => !d.inProgress && d.steps != null);
    return ds.length ? ds.filter((d) => d.steps >= 7000).length / ds.length : null;
  })();
  const bmi = body?.weightKg && body?.heightMeter ? body.weightKg / body.heightMeter ** 2 : null;

  return {
    id: 'markers',
    title: 'Health markers and habits',
    tiles: [
      {
        kind: 'custom',
        label: 'Chronotype',
        unit: '',
        show: (v) => v,
        emptyText: 'Needs 8 weeks of sleep with weekends',
        compute: () => {
          const c = cur.chronotype;
          if (!c) return {};
          return {
            value: c.type[0].toUpperCase() + c.type.slice(1),
            sub: `Mid-sleep on free days ${clockAbs(c.msfsc)}, corrected for catch-up sleep`,
            status: { key: 'neutral', text: `Last 8 weeks: ${c.freeNights} free and ${c.workNights} work nights` },
          };
        },
      },
      {
        kind: 'custom',
        label: 'BMI',
        unit: '',
        show: fmt.one,
        emptyText: 'Add height and weight in the WHOOP app',
        compute: () => {
          if (bmi == null) return {};
          const status = bmi < 18.5
            ? { key: 'warning', text: 'Underweight range, below 18.5' }
            : bmi < 25
              ? { key: 'good', text: 'Healthy range, 18.5–24.9' }
              : bmi < 30
                ? { key: 'warning', text: 'Overweight range, 25–29.9' }
                : { key: 'critical', text: 'Obesity range, 30 or more' };
          return { value: bmi, sub: `${fmt.one(body.weightKg)} kg and ${Math.round(body.heightMeter * 100)} cm from your WHOOP profile`, status };
        },
      },
      {
        kind: 'custom',
        label: `HRV stability${cur.hrvCv ? sinceLabel(cur.hrvCv.date) : ''}`,
        unit: '%',
        show: fmt.one,
        emptyText: 'Needs a week of HRV data',
        compute: () => {
          const x = cur.hrvCv;
          if (!x) return {};
          const band = x.lo != null ? ` · your usual ${fmt.one(x.lo)}–${fmt.one(x.hi)}%` : '';
          const status = x.status === 'above'
            ? { key: 'warning', text: 'Less stable than usual' }
            : x.status === 'below'
              ? { key: 'neutral', text: 'More stable than usual' }
              : x.status === 'normal'
                ? { key: 'good', text: 'Within your usual range' }
                : { key: 'neutral', text: 'Building your usual range' };
          return { value: x.value, sub: `Day-to-day variation of HRV over 7 days${band}`, status };
        },
      },
      {
        kind: 'custom',
        label: `Sleep regularity${cur.sri ? sinceLabel(cur.sri.date) : ''}`,
        unit: '/ 100',
        show: fmt.int,
        emptyText: 'Needs 2 weeks of sleep data',
        compute: () => {
          const x = cur.sri;
          if (!x) return {};
          const status = x.value >= 87.3
            ? { key: 'good', text: 'Top fifth of UK adults' }
            : x.value >= 71.6
              ? { key: 'neutral', text: 'Middle range of UK adults' }
              : { key: 'warning', text: 'Bottom fifth: irregular' };
          return { value: x.value, sub: 'Sleep Regularity Index, last 14 days · UK median 81', status };
        },
      },
      {
        kind: 'custom',
        label: `Step dose${cur.steps ? sinceLabel(cur.steps.date) : ''}`,
        unit: 'a day',
        show: fmt.int,
        emptyText: 'WHOOP reports steps from Sept 2024',
        compute: () => {
          const x = cur.steps;
          if (!x) return {};
          const status = x.mean7 >= 8000
            ? { key: 'good', text: 'At or above 8,000, where benefits level off' }
            : x.mean7 >= 7000
              ? { key: 'good', text: 'Above 7,000 a day' }
              : { key: 'warning', text: 'Below 7,000 a day' };
          return { value: x.mean7, sub: `7-day average · ${x.share7k30 == null ? '–' : pct(x.share7k30)} of the last 30 days at 7,000+`, status };
        },
      },
      {
        kind: 'custom',
        label: 'Workout time',
        unit: '',
        show: (v) => v,
        emptyText: 'No workouts in this range',
        compute: () => {
          if (!timing.total) return {};
          const sub = timing.parts.map((p) => `${p.label} ${pct(p.count / timing.total)}`).join(' · ');
          const lateShare = timing.judged ? timing.late / timing.judged : 0;
          return {
            value: timing.top.label,
            sub,
            status: timing.judged
              ? { key: lateShare > 0.25 ? 'warning' : 'good', text: `${timing.late} of ${timing.judged} hard workouts ended within 4 h of bedtime` }
              : { key: 'neutral', text: 'No hard workouts (strain 10+) in this range' },
          };
        },
      },
    ],
    charts: [
      {
        id: 'hrvCv',
        title: 'HRV stability',
        subtitle: '7-day coefficient of variation of ln HRV against your usual range (previous 60 days ± 1 SD). Higher means less stable',
        legend: [{ color: 'var(--series-7)', label: '7-day variation', shape: 'line' }, { color: 'var(--series-7)', label: 'Usual range', shape: 'band' }],
        spec: {
          type: 'line',
          data: rows,
          x: (d) => d.date,
          series: [{ label: '7-day variation', value: (d) => d.ins?.hrvCv ?? null, color: 'var(--series-7)' }],
          band: { lo: (d) => d.ins?.hrvCvLo ?? null, hi: (d) => d.ins?.hrvCvHi ?? null, color: 'var(--series-7)' },
          yFloor: 0,
          yFormat: (v) => `${fmt.auto(v)}%`,
          ariaLabel: 'HRV stability line chart',
          tooltip: (d) => ({
            title: periodLabel(d),
            rows: d.ins?.hrvCv != null
              ? [
                  { color: 'var(--series-7)', value: `${fmt.one(d.ins.hrvCv)}%`, label: '7-day variation' },
                  ...(d.ins.hrvCvLo != null ? [{ value: `${fmt.one(d.ins.hrvCvLo)}–${fmt.one(d.ins.hrvCvHi)}%`, label: 'Usual range' }] : []),
                ]
              : [{ value: 'Not enough data', label: '' }],
          }),
        },
        columns: [
          dateCol,
          { label: 'Variation', num: true, value: (d) => (d.ins?.hrvCv == null ? '–' : `${fmt.one(d.ins.hrvCv)}%`) },
          { label: 'Usual low', num: true, value: (d) => (d.ins?.hrvCvLo == null ? '–' : `${fmt.one(d.ins.hrvCvLo)}%`) },
          { label: 'Usual high', num: true, value: (d) => (d.ins?.hrvCvHi == null ? '–' : `${fmt.one(d.ins.hrvCvHi)}%`) },
        ],
      },
      {
        id: 'sri',
        title: 'Sleep regularity',
        subtitle: 'Sleep Regularity Index over the previous 14 days. Shaded: the middle 60% of UK adults (71.6–87.3)',
        legend: [{ color: 'var(--series-1)', label: 'Your index', shape: 'line' }, { color: 'var(--series-1)', label: 'Middle 60%', shape: 'band' }],
        spec: {
          type: 'line',
          data: rows,
          x: (d) => d.date,
          series: [{ label: 'Sleep Regularity Index', value: (d) => d.ins?.sri ?? null, color: 'var(--series-1)' }],
          band: { lo: () => 71.6, hi: () => 87.3, color: 'var(--series-1)' },
          yFormat: (v) => fmt.int(v),
          ariaLabel: 'Sleep regularity line chart',
          tooltip: (d) => ({ title: periodLabel(d), rows: [{ color: 'var(--series-1)', value: d.ins?.sri == null ? 'Not enough data' : fmt.int(d.ins.sri), label: 'Sleep Regularity Index' }] }),
        },
        columns: [dateCol, { label: 'Sleep Regularity Index', num: true, value: (d) => fmt.int(d.ins?.sri) }],
      },
      {
        id: 'stepsDose',
        title: 'Step dose',
        subtitle: `7-day average steps. Shaded: 8,000–10,000 a day, where the health benefit levels off under age 60${share7k == null ? '' : ` · ${pct(share7k)} of days at 7,000+`}`,
        legend: [{ color: 'var(--series-3)', label: '7-day average', shape: 'line' }, { color: 'var(--good)', label: '8,000–10,000', shape: 'band' }],
        spec: {
          type: 'line',
          data: rows,
          x: (d) => d.date,
          series: [{ label: '7-day average steps', value: (d) => d.ins?.steps7 ?? null, color: 'var(--series-3)' }],
          band: { lo: () => 8000, hi: () => 10000, color: 'var(--good)' },
          yFloor: 0,
          yFormat: fmt.compact,
          ariaLabel: 'Step dose line chart',
          emptyText: 'No step data in this range. WHOOP reports steps from September 2024 onward.',
          tooltip: (d) => ({ title: periodLabel(d), rows: [{ color: 'var(--series-3)', value: d.ins?.steps7 == null ? 'No data' : fmt.int(d.ins.steps7), label: '7-day average steps' }] }),
        },
        columns: [dateCol, { label: '7-day average steps', num: true, value: (d) => fmt.int(d.ins?.steps7) }],
      },
      {
        id: 'workoutTime',
        fixedAxis: true,
        title: 'Workout time of day',
        subtitle: timing.total
          ? `${timing.total} workouts by local start hour · mostly ${timing.top.label.toLowerCase()} · ${timing.late} hard workouts (strain 10+) ended within 4 h of bedtime`
          : 'No workouts in this range',
        legend: DAYPARTS.map((p) => ({ color: p.color, label: `${p.label} ${hourLabel(p.from % 24)}–${hourLabel(p.to % 24)}` })),
        spec: {
          type: 'bar',
          trend: false,
          data: timing.hours,
          x: (d) => d.hour,
          xFormat: hourLabel,
          series: [{ label: 'Workouts', value: (d) => d.count || null, color: 'var(--series-1)' }],
          colorFor: (d) => d.part.color,
          yFormat: (v) => fmt.int(v),
          ariaLabel: 'Workouts by hour of day bar chart',
          emptyText: 'No workouts in this range.',
          tooltip: (d) => ({ title: `${hourLabel(d.hour)}–${hourLabel((d.hour + 1) % 24)} · ${d.part.label}`, rows: [{ color: d.part.color, value: fmt.int(d.count), label: d.count === 1 ? 'workout' : 'workouts' }] }),
        },
        columns: [
          { label: 'Hour', value: (d) => `${hourLabel(d.hour)}–${hourLabel((d.hour + 1) % 24)}` },
          { label: 'Part of day', value: (d) => d.part.label },
          { label: 'Workouts', num: true, value: (d) => fmt.int(d.count) },
        ],
      },
    ],
  };
}

// ---------- energy and distance ----------
const prettySport = (s) => s.replace(/[-_]+/g, ' ').replace(/^\S/, (c) => c.toUpperCase());
// Per-day workout calories, also for weekly/monthly buckets (which hold totals in act).
const workoutKcalPerDay = (d) => (d.bucket ? d.act.kcal / d.bucketDays : d.act.kcal);
const totalKcal = (d) => kcal(d.kilojoule);

function energySection({ days, rows, unit, workouts }) {
  const dateCol = { label: unit === 'day' ? 'Date' : unit === 'week' ? 'Week of' : 'Month', value: (d) => periodLabel(d, true) };
  const per = unit === 'day' ? 'per day' : unit === 'week' ? 'per week' : 'per month';
  const complete = days.filter((d) => !d.inProgress && d.kilojoule != null);
  const avgBurn = mean(complete.map(totalKcal));
  const avgWorkoutKcal = mean(complete.map((d) => d.act.kcal));

  // calories by sport over the selected range
  const bySport = new Map();
  for (const w of workouts) {
    if (w.kilojoule == null) continue;
    const e = bySport.get(w.sport) || { sport: w.sport, kcal: 0, count: 0, minutes: 0 };
    e.kcal += w.kilojoule / 4.184;
    e.count += 1;
    e.minutes += (w.durationMs || 0) / 60_000;
    bySport.set(w.sport, e);
  }
  const sports = [...bySport.values()].sort((a, b) => b.kcal - a.kcal).slice(0, 8);
  const workoutKcalTotal = [...bySport.values()].reduce((a, s) => a + s.kcal, 0);

  // last 7 days (including today so far) for the share tile
  const end = days.at(-1)?.date;
  const cutoff = end ? new Date(Date.parse(`${end}T12:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10) : null;
  const week = days.filter((d) => d.date >= cutoff);
  const weekTotal = week.reduce((a, d) => a + (totalKcal(d) || 0), 0);
  const weekWorkout = week.reduce((a, d) => a + d.act.kcal, 0);

  // Many workouts (auto-detected walks, gym sessions) record no distance, so only show
  // distance and elevation when this range actually has some.
  const rangeKm = days.reduce((a, d) => a + d.act.distanceKm, 0);
  const rangeClimb = days.reduce((a, d) => a + d.act.climbM, 0);
  const showDistance = rangeKm >= 1;

  return {
    id: 'energy',
    title: showDistance ? 'Energy and distance' : 'Energy',
    tiles: [
      { label: 'Calories', unit: 'kcal', get: (d) => totalKcal(d), show: fmt.int, diff: int0, better: null, partial: true },
      { kind: 'week', label: 'Total burn', unit: 'kcal', get: (d) => totalKcal(d), show: fmt.int, diff: int0, better: null },
      { kind: 'week', label: 'Workout calories', unit: 'kcal', get: (d) => d.act.kcal, show: fmt.int, diff: int0, better: 'up' },
      {
        kind: 'custom',
        label: 'Workout share',
        unit: '%',
        show: fmt.int,
        noDelta: true,
        emptyText: 'No calories recorded in the last 7 days',
        compute: () => (weekTotal ? { value: (weekWorkout / weekTotal) * 100, sub: `of the ${fmt.int(weekTotal)} kcal you burned in the last 7 days came from workouts` } : {}),
      },
      showDistance && { kind: 'week', label: 'Distance', unit: 'km', get: (d) => d.act.distanceKm, show: fmt.one, diff: num1, better: 'up' },
      showDistance && rangeClimb > 0 && { kind: 'week', label: 'Elevation gain', unit: 'm', get: (d) => d.act.climbM, show: fmt.int, diff: int0, better: null },
    ].filter(Boolean),
    charts: [
      {
        id: 'energy',
        title: 'Calories burned',
        subtitle: avgBurn == null ? null : `Average ${fmt.int(avgBurn)} kcal a day, ${fmt.int(avgWorkoutKcal)} of it from workouts`,
        legend: [{ color: 'var(--series-1)', label: 'Rest of day' }, { color: 'var(--series-2)', label: 'Workouts' }],
        spec: {
          type: 'stack',
          data: rows,
          x: (d) => d.date,
          series: [
            { label: 'Rest of day', short: 'Rest', value: (d) => (totalKcal(d) == null ? null : Math.max(0, totalKcal(d) - workoutKcalPerDay(d))), color: 'var(--series-1)' },
            { label: 'Workouts', short: 'Workouts', value: (d) => (totalKcal(d) == null ? null : Math.min(workoutKcalPerDay(d), totalKcal(d))), color: 'var(--series-2)' },
          ],
          yFormat: fmt.compact,
          trendSkip: (d) => d.inProgress,
          ariaLabel: 'Daily calories burned stacked bar chart',
          tooltip: (d) => {
            const total = totalKcal(d);
            const work = workoutKcalPerDay(d);
            return {
              title: `${periodLabel(d)}${d.inProgress ? ' · so far' : ''}`,
              rows: total == null
                ? [{ value: 'No data', label: '' }]
                : [
                    { value: `${fmt.int(total)} kcal`, label: d.bucket ? 'Total, daily average' : 'Total' },
                    { color: 'var(--series-2)', value: `${fmt.int(Math.min(work, total))} kcal`, label: 'Workouts' },
                    { color: 'var(--series-1)', value: `${fmt.int(Math.max(0, total - work))} kcal`, label: 'Rest of day' },
                  ],
            };
          },
        },
        columns: [
          dateCol,
          { label: 'Total kcal', num: true, value: (d) => fmt.int(totalKcal(d)) },
          { label: 'Workouts kcal', num: true, value: (d) => (totalKcal(d) == null ? '–' : fmt.int(workoutKcalPerDay(d))) },
          { label: 'Rest of day kcal', num: true, value: (d) => (totalKcal(d) == null ? '–' : fmt.int(Math.max(0, totalKcal(d) - workoutKcalPerDay(d)))) },
        ],
      },
      {
        id: 'sportKcal',
        fixedAxis: true,
        title: 'Calories by sport',
        subtitle: sports.length ? `${fmt.int(workoutKcalTotal)} kcal across ${workouts.length} workouts in this range · top ${sports.length} sports` : 'No workouts in this range',
        spec: {
          type: 'bar',
          trend: false,
          data: sports,
          x: (d) => d.sport,
          xFormat: (s) => prettySport(s),
          series: [{ label: 'Calories', value: (d) => d.kcal, color: 'var(--series-2)' }],
          yFormat: fmt.compact,
          ariaLabel: 'Calories by sport bar chart',
          emptyText: 'No workouts in this range.',
          tooltip: (d) => ({
            title: prettySport(d.sport),
            rows: [
              { color: 'var(--series-2)', value: `${fmt.int(d.kcal)} kcal`, label: 'Calories' },
              { value: fmt.int(d.count), label: d.count === 1 ? 'workout' : 'workouts' },
              { value: `${fmt.int(d.kcal / d.count)} kcal`, label: 'Per workout' },
              { value: `${fmt.int(d.kcal / (d.minutes / 60))} kcal`, label: 'Per hour' },
            ],
          }),
        },
        columns: [
          { label: 'Sport', value: (d) => prettySport(d.sport) },
          { label: 'Workouts', num: true, value: (d) => fmt.int(d.count) },
          { label: 'Calories', num: true, value: (d) => fmt.int(d.kcal) },
          { label: 'Per workout', num: true, value: (d) => fmt.int(d.kcal / d.count) },
          { label: 'Per hour', num: true, value: (d) => fmt.int(d.kcal / (d.minutes / 60)) },
        ],
      },
      showDistance && {
        id: 'distance',
        totals: true,
        title: 'Distance',
        subtitle: `Kilometres ${per} from workouts that record distance (walking, running, cycling and similar)`,
        spec: {
          type: 'bar',
          data: rows,
          x: (d) => d.date,
          series: [{ label: 'Distance', value: (d) => d.act.distanceKm, color: 'var(--series-3)' }],
          yFormat: (v) => `${fmt.auto(v)}`,
          ariaLabel: 'Distance bar chart',
          emptyText: 'No workouts with distance in this range.',
          tooltip: (d) => ({
            title: periodLabel(d),
            rows: [
              { color: 'var(--series-3)', value: `${fmt.one(d.act.distanceKm)} km`, label: 'Distance' },
              { value: `${fmt.int(d.act.climbM)} m`, label: 'Elevation gain' },
            ],
          }),
        },
        columns: [
          dateCol,
          { label: 'Distance (km)', num: true, value: (d) => fmt.one(d.act.distanceKm) },
          { label: 'Elevation gain (m)', num: true, value: (d) => fmt.int(d.act.climbM) },
        ],
      },
    ].filter(Boolean),
  };
}

// ---------- calendar heatmaps: the last 12 months, one square per day ----------
// The server sends a compact year of daily values with every range (insights.calendar).
const CAL_DAY = 86_400_000;
function calendarCard({ id, title, subtitle, cal, cats, classify, describe }) {
  const byKey = new Map(cats.map((c) => [c.key, c]));
  const catOf = (d) => byKey.get(classify(d)) || null;
  const end = cal.at(-1)?.date || null;
  const counts = new Map(cats.map((c) => [c.key, 0]));
  for (const d of cal) {
    const c = catOf(d);
    if (c) counts.set(c.key, counts.get(c.key) + 1);
  }
  // the table view: days per category, per month
  const byDate = new Map(cal.map((d) => [d.date, d]));
  const months = new Map();
  if (end) {
    for (let t = Date.parse(`${cal[0].date}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += CAL_DAY) {
      const iso = new Date(t).toISOString().slice(0, 10);
      const key = iso.slice(0, 7);
      if (!months.has(key)) months.set(key, { date: `${key}-01`, none: 0, ...Object.fromEntries(cats.map((c) => [c.key, 0])) });
      const row = months.get(key);
      const d = byDate.get(iso);
      const c = d ? catOf(d) : null;
      if (c) row[c.key] += 1;
      else row.none += 1;
    }
  }
  const plural = (n) => `${fmt.int(n)} day${n === 1 ? '' : 's'}`;
  return {
    id,
    title,
    subtitle,
    wide: true,
    fixedAxis: true,
    legend: cats.map((c) => ({ icon: c.icon, color: c.color, label: `${c.label} ${c.range} · ${plural(counts.get(c.key))}` })),
    spec: {
      type: 'calendar',
      trend: false,
      days: cal,
      end,
      weeks: 53,
      category: catOf,
      tableData: [...months.values()],
      emptyText: 'No data in the last 12 months yet.',
      ariaLabel: `${title}, last 12 months: ${cats.map((c) => `${plural(counts.get(c.key))} ${c.label.toLowerCase()}`).join(', ')}`,
      tooltip: (d, cat, date) => ({
        title: fmtDate(date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
        rows: cat ? describe(d, cat) : [{ value: 'No data', label: '' }],
      }),
    },
    columns: [
      { label: 'Month', value: (r) => fmtDate(r.date, { month: 'long', year: 'numeric' }) },
      ...cats.map((c) => ({ label: c.label, num: true, value: (r) => fmt.int(r[c.key]) })),
      { label: 'No data', num: true, value: (r) => fmt.int(r.none) },
    ],
  };
}

const STRAIN_STEPS = [
  { key: 'light', label: 'Light', range: '0–9.9', min: 0, color: 'var(--zone-0)' },
  { key: 'moderate', label: 'Moderate', range: '10–13.9', min: 10, color: 'var(--zone-2)' },
  { key: 'high', label: 'High', range: '14–17.9', min: 14, color: 'var(--zone-4)' },
  { key: 'allout', label: 'All out', range: '18–21', min: 18, color: 'var(--zone-5)' },
];

function calendarDefs(insights) {
  const cal = insights?.calendar;
  if (!cal?.length) return {};
  const statusRow = (cat, value, label) => [{ icon: cat.icon, swatch: !cat.icon, color: cat.color, value, label }];
  return {
    recovery: calendarCard({
      id: 'calRecovery',
      title: 'Recovery, every day',
      subtitle: 'The last 12 months, one square per day, in WHOOP’s recovery zones',
      cal,
      cats: [
        { key: 'critical', label: 'Red', range: '0–33', icon: 'critical', color: 'var(--critical)' },
        { key: 'warning', label: 'Yellow', range: '34–66', icon: 'warning', color: 'var(--warning)' },
        { key: 'good', label: 'Green', range: '67–100', icon: 'good', color: 'var(--good)' },
      ],
      classify: (d) => zoneOf(d.recovery)?.key,
      describe: (d, cat) => statusRow(cat, `${fmt.int(d.recovery)}%`, `${cat.label} recovery`),
    }),
    sleep: calendarCard({
      id: 'calSleep',
      title: 'Sleep, every night',
      subtitle: 'The last 12 months, by sleep performance: the sleep you got versus the sleep you needed',
      cal,
      cats: [
        { key: 'critical', label: 'Poor', range: 'under 70%', icon: 'critical', color: 'var(--critical)' },
        { key: 'warning', label: 'Sufficient', range: '70–84%', icon: 'warning', color: 'var(--warning)' },
        { key: 'good', label: 'Optimal', range: '85%+', icon: 'good', color: 'var(--good)' },
      ],
      classify: (d) => (d.sleep == null ? null : sleepZone(d.sleep).key),
      describe: (d, cat) => statusRow(cat, `${fmt.int(d.sleep)}%`, `${cat.label} sleep performance`),
    }),
    illness: calendarCard({
      id: 'calIllness',
      title: 'Illness warning, every day',
      subtitle: 'The last 12 months. Grey days had at most one overnight signal out of range',
      cal,
      cats: [
        { key: 'clear', label: 'Clear', range: '0–1 signals', color: 'var(--cal-neutral)' },
        { key: 'watch', label: 'Watch', range: '2 signals', icon: 'warning', color: 'var(--warning)' },
        { key: 'warning', label: 'Warning', range: '3–4 signals', icon: 'critical', color: 'var(--critical)' },
      ],
      classify: (d) => d.illness,
      describe: (d, cat) => {
        const n = d.signals?.length || 0;
        const rows = statusRow(cat, cat.label, `${n} of 4 signals out of range`);
        if (n) rows.push({ value: '', label: d.signals.join(', ') });
        return rows;
      },
    }),
    strain: calendarCard({
      id: 'calStrain',
      title: 'Strain, every day',
      subtitle: 'The last 12 months, by WHOOP strain level. Today counts the strain so far',
      cal,
      cats: STRAIN_STEPS,
      classify: (d) => (d.strain == null ? null : [...STRAIN_STEPS].reverse().find((st) => d.strain >= st.min).key),
      describe: (d, cat) => statusRow(cat, fmt.one(d.strain), `${cat.label} strain${d.partial ? ' so far' : ''}`),
    }),
  };
}

function sectionDefs(ctx) {
  const { days, rows, unit, maxHr } = ctx;
  const cals = calendarDefs(ctx.insights);
  const dateCol = { label: unit === 'day' ? 'Date' : unit === 'week' ? 'Week of' : 'Month', value: (d) => periodLabel(d, true) };
  const per = unit === 'day' ? 'per day' : unit === 'week' ? 'per week' : 'per month';
  const avgOf = (f) => mean(days.map(f));
  const zoneCounts = { good: 0, warning: 0, critical: 0 };
  for (const d of days) {
    const z = zoneOf(d.recovery?.score);
    if (z) zoneCounts[z.key] += 1;
  }
  const strainVals = days.filter((d) => !d.inProgress).map((d) => d.strain).filter((v) => v != null);
  const recAvg = avgOf((d) => d.recovery?.score);
  const pct = (v) => `${fmt.int(v)}%`;
  const hoursFmt = (v) => `${fmt.auto(v)}h`;
  const vo2ByDate = new Map(rows.map((d, i) => {
    const win = unit === 'day' ? rows.slice(Math.max(0, i - 6), i + 1) : [d];
    return [d.date, vo2(maxHr, mean(win.map((x) => x.recovery?.rhr)))];
  }));

  return [
    markersSection(ctx),
    insightsSection(ctx),
    {
      id: 'recovery',
      title: 'Recovery and health monitor',
      tiles: [
        { label: 'HRV', unit: 'ms', get: (d) => d.recovery?.hrv, show: fmt.int, diff: num1, better: 'up' },
        { label: 'Resting heart rate', unit: 'bpm', get: (d) => d.recovery?.rhr, show: fmt.int, diff: num1, better: 'down' },
        { label: 'Respiratory rate', unit: 'rpm', get: (d) => d.sleep?.respiratoryRate, show: fmt.one, diff: num1, better: null },
        { label: 'Blood oxygen', unit: '%', get: (d) => d.recovery?.spo2, show: fmt.one, diff: num1, better: null },
        { label: 'Skin temperature', unit: '°C', get: (d) => d.recovery?.skinTemp, show: fmt.one, diff: (v) => `${fmt.one(Math.abs(v))} °C`, better: null },
      ],
      charts: [
        ...(cals.recovery ? [cals.recovery] : []),
        {
          id: 'recovery',
          title: 'Recovery',
          subtitle: recAvg == null ? null : `Average ${fmt.int(recAvg)}% · ${zoneCounts.good} green, ${zoneCounts.warning} yellow, ${zoneCounts.critical} red days`,
          legend: [{ icon: 'good', label: 'Green 67–100' }, { icon: 'warning', label: 'Yellow 34–66' }, { icon: 'critical', label: 'Red 0–33' }],
          spec: {
            type: 'bar',
            data: rows,
            x: (d) => d.date,
            series: [{ label: 'Recovery', value: (d) => d.recovery?.score ?? null, color: 'var(--good)' }],
            colorFor: (d) => zoneOf(d.recovery?.score)?.color,
            yTicks: [0, 33, 67, 100],
            yFormat: pct,
            ariaLabel: 'Recovery bar chart',
            tooltip: (d) => {
              const r = d.recovery;
              const z = zoneOf(r?.score);
              return {
                title: periodLabel(d),
                rows: r
                  ? [
                      { icon: z.key, value: pct(r.score), label: `${z.label} recovery` },
                      { value: `${fmt.int(r.hrv)} ms`, label: 'HRV' },
                      { value: `${fmt.int(r.rhr)} bpm`, label: 'Resting HR' },
                    ]
                  : [{ value: 'No score', label: '' }],
              };
            },
          },
          columns: [
            dateCol,
            { label: 'Recovery', num: true, value: (d) => (d.recovery ? pct(d.recovery.score) : '–') },
            { label: 'Zone', value: (d) => zoneOf(d.recovery?.score)?.label || '–' },
            { label: 'HRV (ms)', num: true, value: (d) => fmt.int(d.recovery?.hrv) },
            { label: 'RHR (bpm)', num: true, value: (d) => fmt.int(d.recovery?.rhr) },
          ],
        },
        lineCard({ id: 'hrv', title: 'Heart rate variability', subtitle: `RMSSD in milliseconds · average ${fmt.int(avgOf((d) => d.recovery?.hrv))} ms`, rows, value: (d) => d.recovery?.hrv ?? null, color: 'var(--series-7)', label: 'HRV', show: (v) => `${fmt.int(v)}`, yFloor: 0 }),
        lineCard({ id: 'rhr', title: 'Resting heart rate', subtitle: `Beats per minute · average ${fmt.int(avgOf((d) => d.recovery?.rhr))} bpm`, rows, value: (d) => d.recovery?.rhr ?? null, color: 'var(--series-2)', label: 'Resting HR', show: (v) => `${fmt.int(v)}`, yFloor: 0 }),
        lineCard({ id: 'resp', title: 'Respiratory rate', subtitle: `Breaths per minute during sleep · average ${fmt.one(avgOf((d) => d.sleep?.respiratoryRate))}`, rows, value: (d) => d.sleep?.respiratoryRate ?? null, color: 'var(--series-1)', label: 'Respiratory rate', show: (v) => fmt.auto(v), yFloor: 0 }),
        lineCard({ id: 'spo2', title: 'Blood oxygen', subtitle: `SpO2 during sleep · average ${fmt.one(avgOf((d) => d.recovery?.spo2))}%`, rows, value: (d) => d.recovery?.spo2 ?? null, color: 'var(--series-3)', label: 'SpO2', show: (v) => `${fmt.auto(v)}%`, yFloor: 0 }),
        lineCard({ id: 'skin', title: 'Skin temperature', subtitle: `°C during sleep · average ${fmt.one(avgOf((d) => d.recovery?.skinTemp))} °C`, rows, value: (d) => d.recovery?.skinTemp ?? null, color: 'var(--series-7)', label: 'Skin temp', show: (v) => `${fmt.auto(v)}°`, yFloor: 0 }),
      ],
    },
    {
      id: 'sleep',
      title: 'Sleep',
      tiles: [
        { label: 'Hours of sleep', unit: '', get: (d) => asleepMs(d.sleep), show: fmt.dur, diff: minsDiff, better: 'up', sub: (d) => `of ${fmt.dur(d.sleep?.neededMs)} needed` },
        { label: 'Sleep need', unit: '', get: (d) => d.sleep?.neededMs, show: fmt.dur, diff: minsDiff, better: null },
        { label: 'Sleep debt', unit: '', get: (d) => d.sleep?.debtMs, show: fmt.dur, diff: minsDiff, better: 'down' },
        { label: 'Restorative sleep', unit: '', get: (d) => restorativeMs(d.sleep), show: fmt.dur, diff: minsDiff, better: 'up', sub: (d) => `${fmt.int((restorativeMs(d.sleep) / asleepMs(d.sleep)) * 100)}% of sleep, deep and REM` },
        { label: 'Sleep performance', unit: '%', get: (d) => d.sleep?.performance, show: fmt.int, diff: (v) => `${fmt.int(Math.abs(v))} pts`, better: 'up' },
        { label: 'Sleep consistency', unit: '%', get: (d) => d.sleep?.consistency, show: fmt.int, diff: (v) => `${fmt.int(Math.abs(v))} pts`, better: 'up' },
        { label: 'Sleep efficiency', unit: '%', get: (d) => d.sleep?.efficiency, show: fmt.int, diff: (v) => `${fmt.int(Math.abs(v))} pts`, better: 'up' },
        { label: 'Time in bed', unit: '', get: (d) => d.sleep?.inBedMs, show: fmt.dur, diff: minsDiff, better: null },
        { label: 'Disturbances', unit: '', get: (d) => d.sleep?.disturbances, show: fmt.int, diff: int0, better: 'down' },
      ],
      charts: [
        ...(cals.sleep ? [cals.sleep] : []),
        {
          id: 'sleep',
          title: 'Sleep stages',
          subtitle: `Hours per night · average ${fmt.dur(avgOf((d) => asleepMs(d.sleep)))} asleep`,
          legend: [
            { color: 'var(--series-1)', label: 'Deep' },
            { color: 'var(--series-2)', label: 'REM' },
            { color: 'var(--series-3)', label: 'Light' },
            { color: 'var(--series-4)', label: 'Awake' },
          ],
          spec: {
            type: 'stack',
            data: rows,
            x: (d) => d.date,
            series: [
              { label: 'Deep (SWS)', short: 'Deep', value: (d) => hrs(d.sleep?.swsMs), color: 'var(--series-1)' },
              { label: 'REM', short: 'REM', value: (d) => hrs(d.sleep?.remMs), color: 'var(--series-2)' },
              { label: 'Light', short: 'Light', value: (d) => hrs(d.sleep?.lightMs), color: 'var(--series-3)' },
              { label: 'Awake', short: 'Awake', value: (d) => hrs(d.sleep?.awakeMs), color: 'var(--series-4)' },
            ],
            yFormat: hoursFmt,
            ariaLabel: 'Sleep stages stacked bar chart',
            tooltip: (d) => {
              const s = d.sleep;
              if (!s) return { title: periodLabel(d), rows: [{ value: 'No sleep recorded', label: '' }] };
              return {
                title: `${periodLabel(d)} · ${fmt.dur(asleepMs(s))} asleep`,
                rows: [
                  { color: 'var(--series-4)', value: fmt.dur(s.awakeMs), label: 'Awake' },
                  { color: 'var(--series-3)', value: fmt.dur(s.lightMs), label: 'Light' },
                  { color: 'var(--series-2)', value: fmt.dur(s.remMs), label: 'REM' },
                  { color: 'var(--series-1)', value: fmt.dur(s.swsMs), label: 'Deep (SWS)' },
                ],
              };
            },
          },
          columns: [
            dateCol,
            { label: 'Asleep', num: true, value: (d) => fmt.dur(asleepMs(d.sleep)) },
            { label: 'Deep', num: true, value: (d) => fmt.dur(d.sleep?.swsMs) },
            { label: 'REM', num: true, value: (d) => fmt.dur(d.sleep?.remMs) },
            { label: 'Light', num: true, value: (d) => fmt.dur(d.sleep?.lightMs) },
            { label: 'Awake', num: true, value: (d) => fmt.dur(d.sleep?.awakeMs) },
          ],
        },
        {
          id: 'sleepNeed',
          title: 'Hours of sleep versus need',
          subtitle: `Average ${fmt.dur(avgOf((d) => asleepMs(d.sleep)))} asleep, ${fmt.dur(avgOf((d) => d.sleep?.neededMs))} needed`,
          legend: [{ color: 'var(--series-1)', label: 'Asleep', shape: 'line' }, { color: 'var(--series-2)', label: 'Needed', shape: 'line' }],
          spec: {
            type: 'line',
            data: rows,
            x: (d) => d.date,
            series: [
              { label: 'Asleep', value: (d) => hrs(asleepMs(d.sleep)), color: 'var(--series-1)' },
              { label: 'Needed', value: (d) => hrs(d.sleep?.neededMs), color: 'var(--series-2)' },
            ],
            yFloor: 0,
            yFormat: hoursFmt,
            ariaLabel: 'Hours of sleep versus sleep need line chart',
            tooltip: (d) => ({
              title: periodLabel(d),
              rows: d.sleep
                ? [
                    { color: 'var(--series-1)', value: fmt.dur(asleepMs(d.sleep)), label: 'Asleep' },
                    { color: 'var(--series-2)', value: fmt.dur(d.sleep.neededMs), label: 'Needed' },
                    { value: fmt.dur(d.sleep.debtMs), label: 'Of which sleep debt' },
                  ]
                : [{ value: 'No sleep recorded', label: '' }],
            }),
          },
          columns: [
            dateCol,
            { label: 'Asleep', num: true, value: (d) => fmt.dur(asleepMs(d.sleep)) },
            { label: 'Needed', num: true, value: (d) => fmt.dur(d.sleep?.neededMs) },
            { label: 'Sleep debt', num: true, value: (d) => fmt.dur(d.sleep?.debtMs) },
            { label: 'Time in bed', num: true, value: (d) => fmt.dur(d.sleep?.inBedMs) },
          ],
        },
        lineCard({ id: 'sleepPerf', title: 'Sleep performance', subtitle: `Sleep you got versus sleep you needed · average ${fmt.int(avgOf((d) => d.sleep?.performance))}%`, rows, value: (d) => d.sleep?.performance ?? null, color: 'var(--series-3)', label: 'Performance', show: pct, yTicks: [0, 25, 50, 75, 100] }),
        {
          id: 'sleepQuality',
          title: 'Sleep consistency and efficiency',
          subtitle: `Average ${fmt.int(avgOf((d) => d.sleep?.consistency))}% consistency, ${fmt.int(avgOf((d) => d.sleep?.efficiency))}% efficiency`,
          legend: [{ color: 'var(--series-1)', label: 'Consistency', shape: 'line' }, { color: 'var(--series-3)', label: 'Efficiency', shape: 'line' }],
          spec: {
            type: 'line',
            data: rows,
            x: (d) => d.date,
            series: [
              { label: 'Consistency', value: (d) => d.sleep?.consistency ?? null, color: 'var(--series-1)' },
              { label: 'Efficiency', value: (d) => d.sleep?.efficiency ?? null, color: 'var(--series-3)' },
            ],
            yTicks: [0, 25, 50, 75, 100],
            yFormat: pct,
            ariaLabel: 'Sleep consistency and efficiency line chart',
            tooltip: (d) => ({
              title: periodLabel(d),
              rows: d.sleep
                ? [
                    { color: 'var(--series-1)', value: pct(d.sleep.consistency), label: 'Consistency' },
                    { color: 'var(--series-3)', value: pct(d.sleep.efficiency), label: 'Efficiency' },
                  ]
                : [{ value: 'No sleep recorded', label: '' }],
            }),
          },
          columns: [
            dateCol,
            { label: 'Consistency', num: true, value: (d) => (d.sleep ? pct(d.sleep.consistency) : '–') },
            { label: 'Efficiency', num: true, value: (d) => (d.sleep ? pct(d.sleep.efficiency) : '–') },
            { label: 'Disturbances', num: true, value: (d) => fmt.int(d.sleep?.disturbances) },
          ],
        },
      ],
    },
    {
      id: 'strain',
      title: 'Strain and activity',
      tiles: [
        { label: 'Day strain', unit: '', get: (d) => d.strain, show: fmt.one, diff: num1, better: null, partial: true },
        { label: 'Steps', unit: '', get: (d) => d.steps, show: fmt.int, diff: int0, better: 'up', partial: true, emptyText: 'WHOOP reports steps from Sept 2024' },
        { label: 'Average heart rate', unit: 'bpm', get: (d) => d.avgHr, show: fmt.int, diff: int0, better: null, partial: true },
        { kind: 'week', label: 'Workouts', unit: '', get: (d) => d.act.workouts, show: fmt.int, diff: num1, better: 'up' },
        { kind: 'week', label: 'HR zones 1–3', unit: '', get: (d) => minutes(d.act.zone13Ms), show: fmtMin, diff: (v) => fmtMin(Math.abs(v)), better: 'up' },
        { kind: 'week', label: 'HR zones 4–5', unit: '', get: (d) => minutes(d.act.zone45Ms), show: fmtMin, diff: (v) => fmtMin(Math.abs(v)), better: 'up' },
        { kind: 'week', label: 'Strength activity', unit: '', get: (d) => minutes(d.act.strengthMs), show: fmtMin, diff: (v) => fmtMin(Math.abs(v)), better: 'up' },
      ],
      charts: [
        ...(cals.strain ? [cals.strain] : []),
        {
          id: 'strain',
          title: 'Day strain',
          subtitle: strainVals.length ? `Average ${fmt.one(mean(strainVals))} · peak ${fmt.one(Math.max(...strainVals))} on a 0–21 scale` : null,
          spec: {
            type: 'bar',
            data: rows,
            x: (d) => d.date,
            series: [{ label: 'Strain', value: (d) => d.strain, color: 'var(--series-1)' }],
            yTicks: [0, 7, 14, 21],
            trendSkip: (d) => d.inProgress,
            ariaLabel: 'Day strain bar chart',
            tooltip: (d) => ({
              title: `${periodLabel(d)}${d.inProgress ? ' · in progress' : ''}`,
              rows: [
                { color: 'var(--series-1)', value: fmt.one(d.strain), label: 'Strain' },
                { value: `${fmt.int(kcal(d.kilojoule))} kcal`, label: 'Calories' },
                { value: `${fmt.int(d.avgHr)} / ${fmt.int(d.maxHr)} bpm`, label: 'Avg / max HR' },
              ],
            }),
          },
          columns: [
            dateCol,
            { label: 'Strain', num: true, value: (d) => fmt.one(d.strain) + (d.inProgress ? ' (so far)' : '') },
            { label: 'Calories', num: true, value: (d) => fmt.int(kcal(d.kilojoule)) },
            { label: 'Avg HR', num: true, value: (d) => fmt.int(d.avgHr) },
            { label: 'Max HR', num: true, value: (d) => fmt.int(d.maxHr) },
          ],
        },
        {
          id: 'steps',
          title: 'Steps',
          subtitle: (() => {
            const a = mean(days.map((d) => (d.inProgress ? null : d.steps)));
            return a == null ? 'WHOOP reports steps from September 2024 onward' : `Average ${fmt.int(a)} a day`;
          })(),
          spec: {
            type: 'bar',
            data: rows,
            x: (d) => d.date,
            series: [{ label: 'Steps', value: (d) => d.steps ?? null, color: 'var(--series-7)' }],
            yFormat: fmt.compact,
            trendSkip: (d) => d.inProgress,
            ariaLabel: 'Steps bar chart',
            emptyText: 'No step data in this range. WHOOP reports steps from September 2024 onward.',
            tooltip: (d) => ({ title: `${periodLabel(d)}${d.inProgress ? ' · in progress' : ''}`, rows: [{ color: 'var(--series-7)', value: fmt.int(d.steps), label: 'Steps' }] }),
          },
          columns: [dateCol, { label: 'Steps', num: true, value: (d) => fmt.int(d.steps) }],
        },
        {
          id: 'zones',
          totals: true,
          title: 'Heart rate zone time',
          subtitle: `Minutes ${per} during recorded activities`,
          legend: [{ color: 'var(--series-1)', label: 'Zones 1–3' }, { color: 'var(--series-2)', label: 'Zones 4–5' }],
          spec: {
            type: 'stack',
            data: rows,
            x: (d) => d.date,
            series: [
              { label: 'Zones 1–3', short: 'Z1–3', value: (d) => minutes(d.act.zone13Ms), color: 'var(--series-1)' },
              { label: 'Zones 4–5', short: 'Z4–5', value: (d) => minutes(d.act.zone45Ms), color: 'var(--series-2)' },
            ],
            yFormat: (v) => `${fmt.int(v)}m`,
            ariaLabel: 'Heart rate zone minutes stacked bar chart',
            emptyText: 'No recorded activities in this range.',
            tooltip: (d) => ({
              title: periodLabel(d),
              rows: [
                { color: 'var(--series-2)', value: fmtMin(minutes(d.act.zone45Ms)), label: 'Zones 4–5' },
                { color: 'var(--series-1)', value: fmtMin(minutes(d.act.zone13Ms)), label: 'Zones 1–3' },
                { value: fmt.int(d.act.workouts), label: 'Activities' },
              ],
            }),
          },
          columns: [
            dateCol,
            { label: 'Zones 1–3', num: true, value: (d) => fmtMin(minutes(d.act.zone13Ms)) },
            { label: 'Zones 4–5', num: true, value: (d) => fmtMin(minutes(d.act.zone45Ms)) },
            { label: 'Activities', num: true, value: (d) => fmt.int(d.act.workouts) },
          ],
        },
        {
          id: 'strength',
          totals: true,
          title: 'Strength activity time',
          subtitle: `Minutes ${per} of weightlifting, powerlifting and functional fitness`,
          spec: {
            type: 'bar',
            data: rows,
            x: (d) => d.date,
            series: [{ label: 'Strength', value: (d) => minutes(d.act.strengthMs), color: 'var(--series-2)' }],
            yFormat: (v) => `${fmt.int(v)}m`,
            ariaLabel: 'Strength activity minutes bar chart',
            emptyText: 'No strength activities in this range.',
            tooltip: (d) => ({ title: periodLabel(d), rows: [{ color: 'var(--series-2)', value: fmtMin(minutes(d.act.strengthMs)), label: 'Strength activity' }] }),
          },
          columns: [dateCol, { label: 'Strength activity', num: true, value: (d) => fmtMin(minutes(d.act.strengthMs)) }],
        },
      ],
    },
    energySection(ctx),
    {
      id: 'fitness',
      title: 'Fitness and Healthspan',
      tiles: [
        {
          kind: 'custom',
          label: 'VO2 max (estimate)',
          unit: 'ml/kg/min',
          show: fmt.one,
          diff: num1,
          better: 'up',
          emptyText: maxHr ? 'Not enough resting heart rate data' : 'Needs max heart rate in your WHOOP profile',
          compute: (ds) => {
            const rhrs = ds.map((d) => d.recovery?.rhr).filter((v) => v != null);
            if (!maxHr || rhrs.length < 3) return {};
            return {
              value: vo2(maxHr, mean(rhrs.slice(-30))),
              avg: rhrs.length > 30 ? vo2(maxHr, mean(rhrs)) : null,
              sub: 'Last 30 days, from resting and max heart rate',
            };
          },
        },
        { kind: 'custom', label: 'Max heart rate', unit: 'bpm', show: fmt.int, noDelta: true, compute: () => ({ value: maxHr, sub: 'From your WHOOP profile' }) },
        { kind: 'custom', label: 'Resting heart rate', unit: 'bpm', show: fmt.int, diff: num1, better: 'down', compute: (ds) => {
          const rhrs = ds.map((d) => d.recovery?.rhr).filter((v) => v != null);
          return { value: mean(rhrs.slice(-30)), avg: rhrs.length > 30 ? mean(rhrs) : null, sub: 'Last 30 days average' };
        } },
      ],
      charts: [
        lineCard({ id: 'vo2', title: 'VO2 max (estimate)', subtitle: `ml/kg/min from 15.3 × max HR ÷ resting HR${unit === 'day' ? ', 7-day rolling' : ''}`, rows, value: (d) => vo2ByDate.get(d.date) ?? null, color: 'var(--series-1)', label: 'VO2 max estimate', show: (v) => fmt.one(v) }),
      ],
      extra: [healthspanCard({ days, maxHr })],
    },
  ];
}

function renderSections(ctx) {
  setChartContext(ctx);
  const built = sectionDefs(ctx).map((sec) => {
    const cards = sec.charts.map((c) => chartCard(c));
    const el = h('section', { class: 'section', 'aria-labelledby': `sec-${sec.id}` },
      h('h2', { class: 'section-title', id: `sec-${sec.id}`, text: sec.title }),
      h('div', { class: 'tiles' }, sec.tiles.map((t) => tileEl(t, ctx.days))),
      h('div', { class: 'grid' }, cards.map((c) => c.card), sec.extra || []),
    );
    return { el, cards };
  });
  $('sections').replaceChildren(...built.map((b) => b.el));
  built.forEach((b) => b.cards.forEach((c) => c.apply()));
}

// ---------- cockpit: build your own dashboard by drag and drop ----------
// The layout is a list of { id, size } saved in this browser. Ids are stable names for every
// overview card, tile, chart and table the dashboard can draw, so a saved layout survives
// reloads and range changes. Size is a column span on a 12-column grid.
const COCKPIT_KEY = 'cockpit.v1';
const SIZES = { card: [4, 6, 12], tile: [3, 4, 6], chart: [6, 12], table: [6, 12], divider: [12] };
const SIZE_NAME = { 3: 'quarter', 4: 'third', 6: 'half', 12: 'full' };
const KIND_NAME = { card: 'Card', tile: 'Tile', chart: 'Chart', table: 'Table', divider: 'Layout' };
const SUGGESTED = [
  { title: 'Today' },
  ['ov:recovery', 4], ['ov:strain', 4], ['ov:sleep', 4],
  { title: 'Warning signs' },
  ['tile:insights:hrv-versus-baseline', 3], ['tile:insights:illness-warning', 3],
  ['tile:insights:training-load-ratio', 3], ['tile:markers:sleep-regularity', 3],
  { title: 'Trends' },
  ['chart:hrvBase', 6], ['chart:recovery', 6], ['chart:sleep', 6], ['chart:energy', 6],
  ['chart:calRecovery', 12],
];
// Dividers are layout-only: any number of them, each with its own id and editable title.
const DIVIDER = { id: 'divider', name: 'Section divider', kind: 'divider' };
const isDivider = (id) => id.startsWith('div:');
const newDividerId = () => `div:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
let dragPayload = null; // { add: id } from the palette, or { move: index } within the canvas
let pendingFocus = null; // re-focus a control after a button-driven re-render

// Several named cockpits: { activeId, list: [{ id, name, items }] }. state.cockpit always
// holds the active cockpit's items; saveCockpit() writes them back with all the others.
const COCKPITS_KEY = 'cockpits.v1';
const newCockpitId = () => `ck:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const cleanName = (s) => String(s ?? '').replace(/\s+/g, ' ').slice(0, 40);

function sanitizeItems(v) {
  return Array.isArray(v)
    ? v.filter((x) => x && typeof x.id === 'string' && Number.isFinite(x.size)).map((x) => (isDivider(x.id) ? { ...x, title: typeof x.title === 'string' ? x.title.slice(0, 80) : '' } : x))
    : [];
}
function loadCockpit() {
  try {
    const v = JSON.parse(store.get(COCKPIT_KEY) || 'null');
    return Array.isArray(v) ? sanitizeItems(v) : null;
  } catch {
    return null;
  }
}
function loadCockpits() {
  try {
    const v = JSON.parse(store.get(COCKPITS_KEY) || 'null');
    if (v && Array.isArray(v.list)) {
      const list = v.list
        .filter((c) => c && typeof c.id === 'string')
        .map((c) => ({ id: c.id, name: cleanName(c.name) || 'Cockpit', items: sanitizeItems(c.items) }));
      if (list.length) return { activeId: list.some((c) => c.id === v.activeId) ? v.activeId : list[0].id, list };
    }
  } catch {
    // fall through to a fresh start
  }
  const first = { id: newCockpitId(), name: 'My cockpit', items: loadCockpit() || [] };
  return { activeId: first.id, list: [first] };
}
const activeCockpit = () => state.cockpits.list.find((c) => c.id === state.cockpits.activeId);
function saveCockpit() {
  activeCockpit().items = state.cockpit;
  store.set(COCKPITS_KEY, JSON.stringify(state.cockpits));
}
function selectCockpit(id, focus) {
  if (!state.cockpits.list.some((c) => c.id === id)) return;
  state.cockpits.activeId = id;
  state.cockpit = activeCockpit().items;
  saveCockpit();
  pendingFocus = focus || { act: 'tab' };
  renderCockpit(state.ctx);
}
function addCockpit(name, items) {
  const taken = new Set(state.cockpits.list.map((c) => c.name));
  let n = state.cockpits.list.length + 1;
  let finalName = name;
  while (!finalName || taken.has(finalName)) finalName = `${name || 'Cockpit'} ${n++}`;
  const c = { id: newCockpitId(), name: cleanName(finalName), items };
  state.cockpits.list.push(c);
  state.editing = true;
  store.set('cockpit.editing', '1');
  selectCockpit(c.id, { act: 'cockpitName' });
}

// Tabs for every saved cockpit, and the title: plain heading, or a name field while editing.
function renderCockpitHeader() {
  const active = activeCockpit();
  $('cockpitTabs').replaceChildren(...state.cockpits.list.map((c) => h('button', {
    type: 'button',
    class: 'cockpit-tab',
    title: c.name || 'Untitled cockpit',
    'data-cockpit': c.id,
    'aria-pressed': String(c.id === active.id),
    onclick: () => selectCockpit(c.id),
  }, c.name || 'Untitled cockpit')));
  if (state.editing) {
    const input = h('input', { type: 'text', id: 'cockpitNameInput', class: 'cockpit-name', value: active.name, maxlength: '40', placeholder: 'Cockpit name' });
    input.addEventListener('input', () => {
      active.name = cleanName(input.value);
      saveCockpit();
      const tab = $('cockpitTabs').querySelector(`[data-cockpit="${CSS.escape(active.id)}"]`);
      if (tab) tab.textContent = active.name || 'Untitled cockpit';
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    input.addEventListener('blur', () => {
      if (!active.name.trim()) {
        active.name = 'Untitled cockpit';
        input.value = active.name;
        saveCockpit();
        renderCockpitHeader();
      }
    });
    $('cockpitTitle').replaceChildren(input);
  } else {
    $('cockpitTitle').replaceChildren();
  }
  $('cockpitEditRow').hidden = !state.editing;
  $('cockpitDuplicate').hidden = !state.editing;
  $('cockpitDelete').hidden = !state.editing;
  $('cockpitDelete').disabled = state.cockpits.list.length < 2;
  $('cockpitDelete').title = state.cockpits.list.length < 2 ? 'You need at least one cockpit' : '';
}

function setChartContext(ctx) {
  currentUnit = ctx.unit;
  currentSpanDays = ctx.days.length;
}

// Every widget the dashboard can draw, grouped like the dashboard's sections.
function buildCatalog(ctx) {
  setChartContext(ctx);
  const groups = [{
    title: 'Today',
    items: overviewCardList(ctx).map((o) => ({ id: `ov:${o.key}`, name: o.name, kind: 'card', make: () => ({ el: o.el }) })),
  }];
  for (const sec of sectionDefs(ctx)) {
    const items = [];
    for (const t of sec.tiles) {
      const base = t.label.split(' · ')[0];
      items.push({ id: `tile:${sec.id}:${slug(base)}`, name: t.kind === 'week' ? `${base} (7 days)` : base, kind: 'tile', make: () => ({ el: tileEl(t, ctx.days) }) });
    }
    for (const c of sec.charts) {
      items.push({ id: `chart:${c.id}`, name: c.title, kind: 'chart', size: c.wide ? 12 : undefined, make: () => { const cc = chartCard(c); return { el: cc.card, apply: cc.apply }; } });
    }
    for (const el of sec.extra || []) {
      const name = el.querySelector('h3')?.textContent;
      if (name) items.push({ id: `extra:${sec.id}:${slug(name)}`, name, kind: 'table', make: () => ({ el }) });
    }
    groups.push({ title: sec.title, items });
  }
  return groups;
}

function cockpitIcon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  const paths = {
    grip: ['M9 6h.01', 'M9 12h.01', 'M9 18h.01', 'M15 6h.01', 'M15 12h.01', 'M15 18h.01'],
    left: ['M15 18l-6-6 6-6'],
    right: ['M9 18l6-6-6-6'],
    width: ['M3 12h18', 'M7 8l-4 4 4 4', 'M17 8l4 4-4 4'],
    remove: ['M18 6 6 18', 'M6 6l12 12'],
    plus: ['M12 5v14', 'M5 12h14'],
  }[name];
  for (const d of paths) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

function updateCockpit(mutator, focus) {
  const next = state.cockpit.slice();
  mutator(next);
  state.cockpit = next;
  saveCockpit();
  pendingFocus = focus || null;
  renderCockpit(state.ctx);
}

function addWidget(item, index) {
  if (item.kind === 'divider') {
    const id = newDividerId();
    updateCockpit((list) => list.splice(index ?? list.length, 0, { id, size: 12, title: 'New section' }), { id, act: 'title' });
    return;
  }
  if (state.cockpit.some((x) => x.id === item.id)) return;
  updateCockpit((list) => list.splice(index ?? list.length, 0, { id: item.id, size: item.size || SIZES[item.kind][0] }), { id: item.id, act: 'name' });
}
function renameDivider(id, title) {
  const entry = state.cockpit.find((x) => x.id === id);
  if (!entry) return;
  entry.title = title.slice(0, 80);
  saveCockpit(); // no re-render, so typing keeps focus
}
function moveWidget(from, to, act) {
  if (to < 0 || to >= state.cockpit.length || from === to) return;
  const id = state.cockpit[from].id;
  updateCockpit((list) => list.splice(to, 0, list.splice(from, 1)[0]), act ? { id, act } : null);
}

function clearDropMarks() {
  for (const n of document.querySelectorAll('.drop-before, .drop-after, .drop-above, .drop-below, .drag-over')) n.classList.remove('drop-before', 'drop-after', 'drop-above', 'drop-below', 'drag-over');
}
// Where a drop lands: before or after the widget under the pointer, else at the end.
function dropTarget(e) {
  const w = e.target.closest?.('.cw');
  if (!w || !$('cockpitCanvas').contains(w)) return { index: state.cockpit.length, el: null };
  const r = w.getBoundingClientRect();
  const fullRow = r.width > $('cockpitCanvas').getBoundingClientRect().width * 0.9;
  const after = fullRow ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
  const side = fullRow ? (after ? 'below' : 'above') : after ? 'after' : 'before';
  return { index: Number(w.dataset.index) + (after ? 1 : 0), el: w, side };
}

function widgetEl(item, entry, index, total) {
  const size = SIZES[item.kind].includes(entry.size) ? entry.size : SIZES[item.kind][0];
  const w = h('div', { class: `cw span-${size}`, 'data-id': item.id, 'data-index': String(index), 'data-kind': item.kind });
  if (!state.editing) return w;

  const btn = (act, icon, label, onclick, disabled) => {
    const b = h('button', { type: 'button', class: 'cw-btn', 'data-act': act, 'aria-label': label, title: label, disabled: disabled || null, onclick }, cockpitIcon(icon));
    return b;
  };
  const sizes = SIZES[item.kind];
  const nextSize = sizes[(sizes.indexOf(size) + 1) % sizes.length];
  const divider = item.kind === 'divider';
  let title = null;
  if (divider) {
    title = h('input', { type: 'text', class: 'cw-title', value: entry.title ?? '', maxlength: '80', placeholder: 'Section name', 'aria-label': 'Section name', 'data-act': 'title' });
    title.addEventListener('input', () => renameDivider(item.id, title.value));
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') title.blur(); });
  }
  // Text fields inside a draggable element can't be selected with the mouse, so a divider
  // drags by its grip; other cards drag by the whole toolbar.
  const grip = h('span', { class: 'cw-grip', draggable: divider ? 'true' : null, title: divider ? 'Drag to move' : null }, cockpitIcon('grip'));
  const bar = h('div', { class: `cw-bar${divider ? ' is-divider' : ''}`, draggable: divider ? null : 'true', title: divider ? null : 'Drag to move' },
    grip,
    divider ? title : h('span', { class: 'cw-name', text: item.name }),
    btn('left', 'left', `Move ${item.name} earlier`, () => moveWidget(index, index - 1, 'left'), index === 0),
    btn('right', 'right', `Move ${item.name} later`, () => moveWidget(index, index + 1, 'right'), index === total - 1),
    sizes.length > 1 ? btn('width', 'width', `Make ${item.name} ${SIZE_NAME[nextSize]} width (now ${SIZE_NAME[size]})`, () => updateCockpit((list) => { list[index] = { ...list[index], size: nextSize }; }, { id: item.id, act: 'width' })) : null,
    btn('remove', 'remove', `Remove ${item.name}`, () => updateCockpit((list) => list.splice(index, 1), { act: 'canvas' })),
  );
  const dragSource = divider ? grip : bar;
  dragSource.addEventListener('dragstart', (e) => {
    if (e.target.closest('button, input')) return; // let buttons and fields be themselves
    dragPayload = { move: index };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', item.id);
    e.dataTransfer.setDragImage(w, 24, 18);
    requestAnimationFrame(() => w.classList.add('dragging'));
  });
  dragSource.addEventListener('dragend', () => {
    dragPayload = null;
    w.classList.remove('dragging');
    clearDropMarks();
  });
  w.append(bar);
  return w;
}

// A divider outside edit mode is a plain section heading.
function dividerEl(entry) {
  return h('div', { class: 'cockpit-divider' }, h('h2', { class: 'section-title', text: entry.title?.trim() || 'Untitled section' }));
}

function renderPalette(catalog) {
  const used = new Set(state.cockpit.map((x) => x.id));
  const list = $('paletteList');
  const groups = [{ title: 'Layout', items: [DIVIDER] }, ...catalog];
  list.replaceChildren(...groups.map((g) => h('section', { class: 'palette-group' },
    h('h3', { text: g.title }),
    h('ul', {}, g.items.map((item) => {
      const added = used.has(item.id);
      const li = h('li', { class: `palette-item${added ? ' is-added' : ''}`, draggable: added ? 'false' : 'true', 'data-name': item.name.toLowerCase(), 'data-id': item.id },
        h('span', { class: 'cw-grip' }, cockpitIcon('grip')),
        h('span', { class: 'palette-name', text: item.name }),
        h('span', { class: 'palette-kind', text: KIND_NAME[item.kind] }),
        h('button', { type: 'button', class: 'palette-add', 'data-act': 'add', disabled: added || null, 'aria-label': added ? `${item.name} is in your cockpit` : `Add ${item.name}`, title: added ? 'Already in your cockpit' : 'Add to cockpit', onclick: () => addWidget(item) }, cockpitIcon('plus')),
      );
      if (!added) {
        li.addEventListener('dragstart', (e) => {
          dragPayload = { add: item.id, item };
          e.dataTransfer.effectAllowed = 'copy';
          e.dataTransfer.setData('text/plain', item.id);
          li.classList.add('dragging');
        });
        li.addEventListener('dragend', () => {
          dragPayload = null;
          li.classList.remove('dragging');
          clearDropMarks();
        });
      }
      return li;
    })),
  )));
  filterPalette();
}

function filterPalette() {
  const q = $('paletteSearch').value.trim().toLowerCase();
  for (const g of document.querySelectorAll('.palette-group')) {
    let any = false;
    for (const li of g.querySelectorAll('.palette-item')) {
      const show = !q || li.dataset.name.includes(q);
      li.hidden = !show;
      any ||= show;
    }
    g.hidden = !any;
  }
}

function renderCockpit(ctx) {
  if (!ctx) return;
  const catalog = buildCatalog(ctx);
  const byId = new Map(catalog.flatMap((g) => g.items).map((it) => [it.id, it]));
  // drop saved widgets the dashboard no longer has
  const kept = state.cockpit.filter((x) => byId.has(x.id) || isDivider(x.id));
  if (kept.length !== state.cockpit.length) {
    state.cockpit = kept;
    saveCockpit();
  }

  renderCockpitHeader();
  $('cockpitBody').classList.toggle('is-editing', state.editing);
  $('cockpitPalette').hidden = !state.editing;
  $('cockpitEdit').textContent = state.editing ? 'Done' : 'Edit layout';
  $('cockpitEdit').classList.toggle('primary', state.editing);
  $('cockpitSuggest').hidden = !state.editing;
  $('cockpitClear').hidden = !state.editing || !state.cockpit.length;
  $('cockpitHint').textContent = state.editing
    ? 'Drag KPIs from the left into your cockpit and drag them around to reorder. The buttons on each card do the same without a mouse.'
    : '';
  if (state.editing) renderPalette(catalog);

  const canvas = $('cockpitCanvas');
  canvas.classList.toggle('is-empty', !state.cockpit.length);
  const toApply = [];
  const nodes = state.cockpit.map((entry, i) => {
    if (isDivider(entry.id)) {
      const item = { id: entry.id, name: entry.title?.trim() || 'Untitled section', kind: 'divider' };
      const w = widgetEl(item, entry, i, state.cockpit.length);
      w.classList.add('cw-divider');
      if (!state.editing) w.append(dividerEl(entry));
      return w;
    }
    const item = byId.get(entry.id);
    const made = item.make();
    const w = widgetEl(item, entry, i, state.cockpit.length);
    w.append(made.el);
    if (made.apply) toApply.push(made.apply);
    return w;
  });
  if (!nodes.length) {
    nodes.push(h('div', { class: 'cockpit-empty' },
      h('p', { class: 'cockpit-empty-title', text: 'Your cockpit is empty' }),
      h('p', { class: 'muted', text: state.editing ? 'Drag KPIs here from the list on the left, or start from the suggested layout.' : 'Choose Edit layout to add KPIs.' }),
    ));
  }
  canvas.replaceChildren(...nodes);
  toApply.forEach((f) => f());

  if (pendingFocus) {
    const f = pendingFocus;
    pendingFocus = null;
    const target = f.act === 'cockpitName'
      ? $('cockpitNameInput')
      : f.act === 'tab'
        ? $('cockpitTabs').querySelector('[aria-pressed="true"]')
        : f.act === 'canvas'
      ? canvas.querySelector('.cw-btn') || $('paletteSearch')
      : canvas.querySelector(`.cw[data-id="${CSS.escape(f.id)}"] [data-act="${f.act}"]:not([disabled])`) || canvas.querySelector(`.cw[data-id="${CSS.escape(f.id)}"] .cw-btn`);
    target?.focus();
    if (target?.select) target.select();
  }
}

// One-time wiring for drop zones and toolbar buttons (the elements persist across renders).
function initCockpit() {
  const canvas = $('cockpitCanvas');
  canvas.addEventListener('dragover', (e) => {
    if (!dragPayload) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = dragPayload.add ? 'copy' : 'move';
    const t = dropTarget(e);
    clearDropMarks();
    if (t.el) t.el.classList.add(`drop-${t.side}`);
    else canvas.classList.add('drag-over');
  });
  canvas.addEventListener('dragleave', (e) => {
    if (!canvas.contains(e.relatedTarget)) clearDropMarks();
  });
  canvas.addEventListener('drop', (e) => {
    if (!dragPayload) return;
    e.preventDefault();
    const t = dropTarget(e);
    const payload = dragPayload;
    dragPayload = null;
    clearDropMarks();
    if (payload.add) addWidget(payload.item, t.index);
    else if (payload.move != null) moveWidget(payload.move, t.index > payload.move ? t.index - 1 : t.index);
  });

  // dragging a card back onto the palette removes it
  const palette = $('cockpitPalette');
  palette.addEventListener('dragover', (e) => {
    if (dragPayload?.move == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    palette.classList.add('drag-over');
  });
  palette.addEventListener('dragleave', (e) => {
    if (!palette.contains(e.relatedTarget)) palette.classList.remove('drag-over');
  });
  palette.addEventListener('drop', (e) => {
    if (dragPayload?.move == null) return;
    e.preventDefault();
    const index = dragPayload.move;
    dragPayload = null;
    clearDropMarks();
    updateCockpit((list) => list.splice(index, 1));
  });

  $('paletteSearch').addEventListener('input', filterPalette);
  $('cockpitNew').addEventListener('click', () => addCockpit('New cockpit', []));
  $('cockpitDuplicate').addEventListener('click', () => {
    const src = activeCockpit();
    const items = src.items.map((x) => (isDivider(x.id) ? { ...x, id: newDividerId() } : { ...x }));
    addCockpit(`${src.name} copy`, items);
  });
  $('cockpitDelete').addEventListener('click', () => {
    if (state.cockpits.list.length < 2) return;
    const c = activeCockpit();
    if (!window.confirm(`Delete the cockpit "${c.name}"? This can't be undone.`)) return;
    const i = state.cockpits.list.indexOf(c);
    state.cockpits.list.splice(i, 1);
    selectCockpit(state.cockpits.list[Math.max(0, i - 1)].id);
  });
  $('cockpitEdit').addEventListener('click', () => {
    state.editing = !state.editing;
    store.set('cockpit.editing', state.editing ? '1' : '0');
    renderCockpit(state.ctx);
  });
  $('cockpitSuggest').addEventListener('click', () => {
    if (state.cockpit.length && !window.confirm('Replace your cockpit with the suggested layout?')) return;
    const known = new Set(buildCatalog(state.ctx).flatMap((g) => g.items).map((it) => it.id));
    const layout = SUGGESTED.map((x) => (Array.isArray(x) ? (known.has(x[0]) ? { id: x[0], size: x[1] } : null) : { id: newDividerId(), size: 12, title: x.title })).filter(Boolean);
    updateCockpit((list) => list.splice(0, list.length, ...layout));
  });
  $('cockpitClear').addEventListener('click', () => {
    if (!window.confirm('Remove every KPI from your cockpit?')) return;
    updateCockpit((list) => list.splice(0, list.length), { act: 'canvas' });
  });
}

// ---------- workouts ----------
const ZONES = ['Zone 0', 'Zone 1', 'Zone 2', 'Zone 3', 'Zone 4', 'Zone 5'];
function renderWorkouts(workouts) {
  const total = workouts.reduce((a, w) => a + (w.durationMs || 0), 0);
  const avgStrain = mean(workouts.map((w) => w.strain));
  $('workoutsSub').textContent = workouts.length
    ? `${fmt.int(workouts.length)} workouts ${isAll() ? 'all time' : `in the last ${state.days} days`} · ${fmt.dur(total)} total · average strain ${fmt.one(avgStrain)}`
    : `No workouts ${isAll() ? 'yet' : `in the last ${state.days} days`}`;
  $('zoneLegend').replaceWith(Object.assign(legendEl(ZONES.map((z, i) => ({ color: `var(--zone-${i})`, label: z }))), { id: 'zoneLegend' }));
  const wrap = $('workoutsTable');
  wrap.replaceChildren();
  if (!workouts.length) return;
  const LIMIT = 10;
  const rows = state.showAllWorkouts ? workouts : workouts.slice(0, LIMIT);
  const cols = ['Date', 'Activity', 'Duration', 'Strain', 'Avg HR', 'Max HR', 'Calories', 'Distance', 'Heart rate zones'];
  const numeric = new Set(['Duration', 'Strain', 'Avg HR', 'Max HR', 'Calories', 'Distance']);
  const thead = h('thead', {}, h('tr', {}, cols.map((c) => h('th', { scope: 'col', class: numeric.has(c) ? 'num' : null, text: c }))));
  const tbody = h('tbody', {}, rows.map((w) => {
    const zoneText = w.zonesMs ? w.zonesMs.map((ms, i) => `Z${i} ${fmt.mins(ms)}`).join(' · ') : 'Not scored';
    const bar = h('div', { class: 'zonebar', role: 'img', 'aria-label': zoneText, title: zoneText });
    if (w.zonesMs) {
      w.zonesMs.forEach((ms, i) => {
        if (ms <= 0) return;
        const seg = h('span');
        seg.style.flexGrow = String(ms);
        seg.style.setProperty('--key', `var(--zone-${i})`);
        bar.append(seg);
      });
    }
    return h('tr', {},
      h('td', { text: fmt.wall(w.localStart) }),
      h('td', { text: w.sport.replace(/[-_]+/g, ' ').replace(/^\S/, (c) => c.toUpperCase()) }),
      h('td', { class: 'num', text: fmt.dur(w.durationMs) }),
      h('td', { class: 'num', text: fmt.one(w.strain) }),
      h('td', { class: 'num', text: fmt.int(w.avgHr) }),
      h('td', { class: 'num', text: fmt.int(w.maxHr) }),
      h('td', { class: 'num', text: fmt.int(kcal(w.kilojoule)) }),
      h('td', { class: 'num', text: w.distanceMeter ? `${(w.distanceMeter / 1000).toFixed(2)} km` : '–' }),
      h('td', {}, bar),
    );
  }));
  wrap.append(h('table', {}, thead, tbody));
  if (workouts.length > LIMIT) {
    wrap.append(h('div', { class: 'more-row' }, h('button', {
      type: 'button',
      class: 'linkbtn',
      text: state.showAllWorkouts ? 'Show fewer' : `Show all ${workouts.length} workouts`,
      onclick: () => { state.showAllWorkouts = !state.showAllWorkouts; renderWorkouts(workouts); },
    })));
  }
}

// ---------- body ----------
function renderBody(body) {
  const wrap = $('bodyStats');
  wrap.replaceChildren();
  if (!body) {
    wrap.append(h('p', { class: 'muted', text: 'No body measurements on file.' }));
    return;
  }
  const items = [];
  if (body.heightMeter) {
    const inches = body.heightMeter / 0.0254;
    items.push(['Height', `${Math.round(body.heightMeter * 100)}`, 'cm', `${Math.floor(inches / 12)}′${Math.round(inches % 12)}″`]);
  }
  if (body.weightKg) items.push(['Weight', fmt.one(body.weightKg), 'kg', `${fmt.one(body.weightKg * 2.20462)} lb`]);
  if (body.maxHr) items.push(['Max heart rate', fmt.int(body.maxHr), 'bpm', 'Used for heart rate zones']);
  for (const [label, value, unit, note] of items) {
    wrap.append(h('div', { class: 'tile' },
      h('span', { class: 'label', text: label }),
      h('span', { class: 'value' }, value, h('span', { class: 'unit', text: unit })),
      h('span', { class: 'delta', text: note }),
    ));
  }
}

// ---------- boot ----------
async function boot() {
  if (STATIC_DEMO) {
    state.demo = true;
    return openDashboard();
  }
  const params = new URLSearchParams(location.search);
  const loginError = params.get('login_error');
  const wantDemo = params.has('demo');
  if (loginError || wantDemo) history.replaceState(null, '', '/');
  try {
    state.status = (await getJSON('/api/status')).body;
  } catch {
    state.status = null;
  }
  if (!state.status) {
    showView('connect');
    showError('Cannot reach the local server. Is it running?');
    return;
  }
  if (wantDemo) {
    state.demo = true;
    return openDashboard();
  }
  if (state.status.connected) return openDashboard();
  renderConnect(loginError ? `WHOOP login failed: ${loginError}` : '');
}

window.addEventListener('focus', async () => {
  if ($('connectView').hidden || $('setupNotice').hidden) return;
  const { body } = await getJSON('/api/status').catch(() => ({ body: null }));
  if (body) {
    state.status = body;
    if (body.redirectRegistered !== false) $('setupNotice').hidden = true;
  }
});

state.cockpits = loadCockpits();
state.cockpit = activeCockpit().items;
store.set(COCKPITS_KEY, JSON.stringify(state.cockpits)); // persist a migrated layout right away
state.editing = store.get('cockpit.editing') === '1' || !state.cockpit.length;
initCockpit();
boot();
