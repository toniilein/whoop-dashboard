// Regenerates the documentation screenshots in docs/screenshots/ from the dashboard's
// built-in SAMPLE data (?demo), so no real health data ever ends up in the docs.
//
// Usage: start the dashboard (npm start), then
//   node scripts/screenshots.mjs
// Needs Google Chrome; set CHROME_PATH to use another Chromium-based browser.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const BASE = process.env.DASHBOARD_URL || 'http://localhost:3000';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A cockpit layout for the screenshots (ids match the dashboard's KPI catalog).
const COCKPIT = {
  activeId: 'ck:docs',
  list: [
    {
      id: 'ck:docs',
      name: 'Morning check-in',
      items: [
        { id: 'div:docs1', size: 12, title: 'Today' },
        { id: 'ov:recovery', size: 4 }, { id: 'ov:strain', size: 4 }, { id: 'ov:sleep', size: 4 },
        { id: 'div:docs2', size: 12, title: 'Warning signs' },
        { id: 'tile:insights:hrv-versus-baseline', size: 3 }, { id: 'tile:insights:illness-warning', size: 3 },
        { id: 'tile:insights:training-load-ratio', size: 3 }, { id: 'tile:markers:sleep-regularity', size: 3 },
        { id: 'div:docs3', size: 12, title: 'Trends' },
        { id: 'chart:hrvBase', size: 6 }, { id: 'chart:sleep', size: 6 },
      ],
    },
    { id: 'ck:docs2', name: 'Training', items: [] },
  ],
};

async function launchChrome() {
  const profile = await mkdtemp(path.join(tmpdir(), 'whoop-shots-'));
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return { proc, profile };
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error('Chrome did not start. Set CHROME_PATH to a Chromium-based browser.');
}

async function openPage() {
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed');
    return r.result.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

async function setup(page, { width, height, scheme = 'light', mobile = false }) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile });
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
}

async function load(page, storage) {
  // set this origin's localStorage, then load the dashboard on SAMPLE data
  await page.send('Page.navigate', { url: `${BASE}/?demo` });
  await sleep(600);
  await page.evaluate(`(() => { localStorage.clear(); ${Object.entries(storage).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join(' ')} })()`);
  await page.send('Page.navigate', { url: `${BASE}/?demo` });
  await page.evaluate(`new Promise((resolve) => { const t0 = Date.now(); (function poll() {
    const ready = document.getElementById('demoBanner') && !document.getElementById('demoBanner').hidden && document.querySelectorAll('svg.chart').length > 0;
    if (ready || Date.now() - t0 > 20000) resolve(ready); else setTimeout(poll, 150); })(); })`);
  await sleep(700); // let charts finish their resize pass
  const demo = await page.evaluate(`document.getElementById('who').textContent`);
  if (!/sample/i.test(demo)) throw new Error(`Refusing to capture: the page is not on sample data (${demo})`);
}

// Capture from the top of the page down to the bottom of `untilSelector` (or a fixed height).
async function shoot(page, name, { fromSelector, untilSelector, height, pad = 16 }) {
  const rect = await page.evaluate(`(() => {
    const top = ${fromSelector ? `document.querySelector(${JSON.stringify(fromSelector)}).getBoundingClientRect().top + scrollY - ${pad}` : 0};
    const bottom = ${untilSelector ? `document.querySelector(${JSON.stringify(untilSelector)}).getBoundingClientRect().bottom + scrollY + ${pad}` : `top + ${height}`};
    return { top: Math.max(0, top), bottom, width: document.documentElement.clientWidth };
  })()`);
  const h = height || Math.round(rect.bottom - rect.top);
  const shot = await page.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: rect.top, width: rect.width, height: h, scale: 1 },
  });
  await writeFile(path.join(OUT, name), Buffer.from(shot.data, 'base64'));
  console.log(`  ${name}  ${rect.width}x${h}`);
}

const { proc, profile } = await launchChrome();
try {
  await mkdir(OUT, { recursive: true });
  const page = await openPage();
  const common = { days: '90', theme: 'system', view: 'dashboard' };

  console.log('Dashboard (light)');
  await setup(page, { width: 1440, height: 1000 });
  await load(page, common);
  await shoot(page, 'dashboard-light.png', { untilSelector: '#sec-markers ~ .tiles' });
  await shoot(page, 'insights.png', { fromSelector: '#sec-insights', height: 980 });
  await shoot(page, 'health-monitor.png', { fromSelector: '#sec-recovery', height: 1060 });
  await shoot(page, 'sleep.png', { fromSelector: '#sec-sleep', height: 1060 });

  console.log('Dashboard (dark)');
  await setup(page, { width: 1440, height: 1000, scheme: 'dark' });
  await load(page, common);
  await shoot(page, 'dashboard-dark.png', { untilSelector: '#sec-markers ~ .tiles' });

  console.log('Cockpit');
  await setup(page, { width: 1440, height: 1000 });
  await load(page, { ...common, view: 'cockpit', 'cockpits.v1': JSON.stringify(COCKPIT), 'cockpit.editing': '0' });
  await shoot(page, 'cockpit.png', { height: 1180 });
  await load(page, { ...common, view: 'cockpit', 'cockpits.v1': JSON.stringify(COCKPIT), 'cockpit.editing': '1' });
  await shoot(page, 'cockpit-edit.png', { height: 940 });

  console.log('Phone');
  await setup(page, { width: 390, height: 844, mobile: true });
  await load(page, common);
  await shoot(page, 'mobile.png', { height: 844 });

  page.close();
} finally {
  proc.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
console.log(`Saved to ${path.relative(ROOT, OUT)}/`);
