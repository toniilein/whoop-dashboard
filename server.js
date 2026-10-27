// Local WHOOP dashboard server. No dependencies: Node >= 20.12.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWhoopClient, AuthRequiredError, WhoopApiError } from './lib/whoop.js';
import { fetchDashboard, buildPayload } from './lib/dashboard.js';
import { createHistory } from './lib/history.js';
import { computeInsights } from './lib/insights.js';
import { demoPayload } from './lib/demo.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1';
const CLIENT_ID = process.env.WHOOP_CLIENT_ID || '';
const CLIENT_SECRET = process.env.WHOOP_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.WHOOP_REDIRECT_URI || `http://localhost:${PORT}/callback`;

const LOCAL_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
const redirect = new URL(REDIRECT_URI);
// If WHOOP redirects back to this server we handle the callback ourselves;
// otherwise the user pastes the URL they landed on ("manual" mode).
const MANUAL_MODE = !LOCAL_ORIGINS.has(redirect.origin);
const CALLBACK_PATH = MANUAL_MODE ? '/callback' : redirect.pathname;

const client = createWhoopClient({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  redirectUri: REDIRECT_URI,
  dataDir: path.join(ROOT, 'data'),
});

const history = createHistory({
  client,
  dataDir: path.join(ROOT, 'data'),
  exportsDir: path.join(ROOT, 'exports'),
});

const allFromHistory = (h) =>
  buildPayload({ profile: h.profile, body: h.body, cycles: h.cycles, recoveries: h.recovery, sleeps: h.sleep, workouts: h.workouts, days: 'all' });

// Insights need the full history (baselines, 28-day load, last year), whatever range is shown.
async function attachInsights(payload, all) {
  try {
    all = all || allFromHistory(await history.get());
    payload.insights = computeInsights(all.days, all.workouts, payload.days.map((d) => d.date), all.body?.maxHr);
  } catch (e) {
    if (e instanceof AuthRequiredError) throw e;
    console.error('Insights failed:', e.message);
    payload.insights = null;
  }
  return payload;
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/charts.js': ['charts.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

const cache = new Map(); // days -> { at, payload }
const CACHE_MS = 60_000;

let redirectStatus = { value: null, checkedAt: 0 };
async function redirectRegistered() {
  if (redirectStatus.value === true) return true;
  if (Date.now() - redirectStatus.checkedAt < 15_000) return redirectStatus.value;
  redirectStatus = { value: await client.checkRedirectRegistered(), checkedAt: Date.now() };
  return redirectStatus.value;
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function redirectTo(res, location, headers = {}) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const STATE_COOKIE = 'whoop_oauth_state';
const setStateCookie = (state) => `${STATE_COOKIE}=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`;
const clearStateCookie = `${STATE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;

async function readJsonBody(req, limit = 8192) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function completeLogin(req, code, state) {
  const expected = cookies(req)[STATE_COOKIE];
  if (!code) throw Object.assign(new Error('No authorization code was returned.'), { userFacing: true });
  if (!expected || !state || state !== expected) {
    throw Object.assign(new Error('Login state did not match. Please click Connect again.'), { userFacing: true });
  }
  await client.exchangeCode(code);
  cache.clear();
}

function parseDays(url) {
  if (url.searchParams.get('days') === 'all') return 'all';
  const n = Number(url.searchParams.get('days'));
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.round(n), 180) : 30;
}

function apiError(res, err) {
  if (err instanceof AuthRequiredError) return send(res, 401, { error: 'auth_required', message: err.message });
  if (err instanceof WhoopApiError && err.status === 429) {
    return send(res, 429, { error: 'rate_limited', message: 'WHOOP rate limit reached. Try again in a minute.' });
  }
  console.error(err);
  return send(res, 502, { error: 'upstream', message: err.message || 'Request to WHOOP failed' });
}

async function handle(req, res) {
  // Only answer requests addressed to this machine (blocks DNS-rebinding tricks).
  const host = req.headers.host || '';
  if (!LOCAL_ORIGINS.has(`http://${host}`)) return send(res, 403, 'Forbidden host');
  const url = new URL(req.url, `http://${host}`);
  const isPost = req.method === 'POST';
  if (isPost) {
    const origin = req.headers.origin;
    if (origin && !LOCAL_ORIGINS.has(origin)) return send(res, 403, 'Forbidden origin');
  }

  // OAuth callback. Checked before static files because the redirect URL may be the page itself ("/").
  const isCallback = url.searchParams.has('code') || url.searchParams.has('error');
  if (req.method === 'GET' && url.pathname === CALLBACK_PATH && !MANUAL_MODE && isCallback) {
    const err = url.searchParams.get('error');
    if (err) {
      const msg = url.searchParams.get('error_description') || err;
      return redirectTo(res, `/?login_error=${encodeURIComponent(msg)}`, { 'Set-Cookie': clearStateCookie });
    }
    try {
      await completeLogin(req, url.searchParams.get('code'), url.searchParams.get('state'));
      return redirectTo(res, '/', { 'Set-Cookie': clearStateCookie });
    } catch (e) {
      console.error('OAuth callback failed:', e.message);
      return redirectTo(res, `/?login_error=${encodeURIComponent(e.message)}`, { 'Set-Cookie': clearStateCookie });
    }
  }

  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    const body = await readFile(path.join(ROOT, 'public', file));
    return send(res, 200, body, {
      'Content-Type': type,
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
  }

  if (req.method === 'GET' && url.pathname === '/login') {
    if (!CLIENT_ID || !CLIENT_SECRET) return send(res, 500, 'Set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET in .env');
    const state = client.newState();
    return redirectTo(res, client.authorizeUrl(state), { 'Set-Cookie': setStateCookie(state) });
  }

  // Manual mode: the browser posts the full URL WHOOP redirected to.
  if (isPost && url.pathname === '/api/manual-callback') {
    try {
      const { redirectedUrl } = await readJsonBody(req);
      const landed = new URL(String(redirectedUrl || '').trim());
      if (landed.searchParams.get('error')) {
        throw Object.assign(new Error(landed.searchParams.get('error_description') || landed.searchParams.get('error')), { userFacing: true });
      }
      await completeLogin(req, landed.searchParams.get('code'), landed.searchParams.get('state'));
      return send(res, 200, { ok: true }, { 'Set-Cookie': clearStateCookie });
    } catch (e) {
      const message = e.userFacing ? e.message : e instanceof TypeError ? 'That does not look like a full URL.' : `Login failed: ${e.message}`;
      return send(res, 400, { error: 'login_failed', message });
    }
  }

  if (isPost && url.pathname === '/api/logout') {
    await client.disconnect();
    await history.clear();
    cache.clear();
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    const connected = await client.isConnected();
    return send(res, 200, {
      configured: Boolean(CLIENT_ID && CLIENT_SECRET),
      connected,
      manualMode: MANUAL_MODE,
      redirectUri: REDIRECT_URI,
      suggestedRedirectUri: `http://localhost:${PORT}/callback`,
      redirectRegistered: connected ? true : await redirectRegistered(),
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard' && url.searchParams.get('days') === 'all') {
    try {
      const h = await history.get({ force: url.searchParams.has('fresh') });
      const payload = allFromHistory(h);
      payload.history = { syncedAt: h.syncedAt, source: h.source, firstDate: payload.days[0]?.date || null };
      await attachInsights(payload, payload);
      return send(res, 200, payload);
    } catch (e) {
      return apiError(res, e);
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard') {
    const days = parseDays(url);
    const hit = cache.get(days);
    if (hit && !url.searchParams.has('fresh') && Date.now() - hit.at < CACHE_MS) return send(res, 200, hit.payload);
    try {
      const payload = await attachInsights(await fetchDashboard(client, days));
      cache.set(days, { at: Date.now(), payload });
      return send(res, 200, payload);
    } catch (e) {
      return apiError(res, e);
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/demo') {
    const days = parseDays(url);
    const payload = demoPayload(days === 'all' ? 400 : days);
    const full = demoPayload(400);
    payload.insights = computeInsights(full.days, full.workouts, payload.days.map((d) => d.date), full.body?.maxHr);
    return send(res, 200, payload);
  }

  return send(res, 404, 'Not found');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, 'Internal error');
    else res.end();
  });
});

// A first-time full history download can take a few minutes.
server.requestTimeout = 15 * 60_000;

server.listen(PORT, HOST, async () => {
  console.log(`WHOOP dashboard running at http://localhost:${PORT}`);
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn('! Missing WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET in .env');
    return;
  }
  console.log(`  Redirect URI: ${REDIRECT_URI}${MANUAL_MODE ? '  (manual paste mode)' : ''}`);
  const ok = await redirectRegistered();
  if (ok === false) {
    console.warn(`! WHOOP does not recognise ${REDIRECT_URI} as a redirect URL for this app.`);
    console.warn('  Add it under Redirect URLs in https://developer-dashboard.whoop.com, then reload the page.');
  } else if (ok === true) {
    console.log('  Redirect URL is registered with WHOOP.');
  }
});
