// WHOOP OAuth 2.0 + v2 REST client.
// Docs: https://developer.whoop.com/docs/developing/oauth and https://developer.whoop.com/api
import { readFile, writeFile, rm, mkdir, open, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const API_BASE = 'https://api.prod.whoop.com/developer';

export const SCOPES = [
  'offline', // required to receive a refresh token
  'read:recovery',
  'read:cycles',
  'read:workout',
  'read:sleep',
  'read:profile',
  'read:body_measurement',
];

export class AuthRequiredError extends Error {
  constructor(message = 'Not connected to WHOOP') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export class WhoopApiError extends Error {
  constructor(status, body, pathname) {
    super(`WHOOP API ${status} on ${pathname}: ${String(body).slice(0, 300)}`);
    this.name = 'WhoopApiError';
    this.status = status;
  }
}

export function createWhoopClient({ clientId, clientSecret, redirectUri, dataDir }) {
  const tokenFile = path.join(dataDir, 'tokens.json');
  let refreshing = null;

  // WHOOP requires the state parameter to be exactly 8 characters.
  function newState() {
    return randomBytes(6).toString('base64url'); // 6 bytes -> 8 chars
  }

  function authorizeUrl(state) {
    const url = new URL(AUTH_URL);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', SCOPES.join(' '));
    url.searchParams.set('state', state);
    return url.toString();
  }

  async function loadTokens() {
    try {
      return JSON.parse(await readFile(tokenFile, 'utf8'));
    } catch {
      return null;
    }
  }

  async function saveTokens(json) {
    const tokens = {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      scope: json.scope,
      expires_at: Date.now() + (Number(json.expires_in) || 3600) * 1000,
      saved_at: new Date().toISOString(),
    };
    await mkdir(dataDir, { recursive: true });
    await writeFile(tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    return tokens;
  }

  async function clearTokens() {
    await rm(tokenFile, { force: true });
  }

  async function tokenRequest(params) {
    const body = new URLSearchParams({ ...params, client_id: clientId, client_secret: clientSecret });
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: 'invalid_response', error_description: text.slice(0, 200) };
    }
    if (!res.ok || !json.access_token) {
      const err = new Error(json.error_description || json.error || `Token request failed (${res.status})`);
      err.oauthError = json.error;
      err.status = res.status;
      throw err;
    }
    return json;
  }

  async function exchangeCode(code) {
    const json = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    return saveTokens(json);
  }

  // Refresh tokens rotate: the old refresh token dies as soon as a new one is issued.
  // Callers inside this process share one in-flight refresh, and a lock file keeps the
  // dashboard server and the MCP server (separate processes) from refreshing at once.
  const lockFile = path.join(dataDir, 'refresh.lock');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function withRefreshLock(fn) {
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        const handle = await open(lockFile, 'wx');
        try {
          return await fn(true);
        } finally {
          await handle.close();
          await rm(lockFile, { force: true });
        }
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        // Another process holds the lock: wait for it, then reuse whatever it saved.
        const age = Date.now() - (await stat(lockFile).then((s) => s.mtimeMs).catch(() => Date.now()));
        if (age > 30_000) {
          await rm(lockFile, { force: true }); // stale lock from a crashed process
          continue;
        }
        if (Date.now() > deadline) return fn(false);
        await sleep(200);
      }
    }
  }

  function refresh(current) {
    if (!refreshing) {
      refreshing = withRefreshLock(async (locked) => {
        // Re-read: the other process may have already rotated the tokens while we waited.
        const latest = await loadTokens();
        if (latest?.access_token && latest.refresh_token !== current?.refresh_token && Date.now() < latest.expires_at - 60_000) {
          return latest;
        }
        const useToken = latest?.refresh_token || current?.refresh_token;
        if (!useToken) throw new AuthRequiredError('Session expired, please reconnect');
        if (!locked) throw new Error('Could not acquire the token refresh lock');
        try {
          const json = await tokenRequest({ grant_type: 'refresh_token', refresh_token: useToken, scope: 'offline' });
          return await saveTokens(json);
        } catch (err) {
          if (err.oauthError === 'invalid_grant' || err.status === 400 || err.status === 401) {
            // If another process rotated the tokens meanwhile, theirs are the valid ones: keep them.
            const onDisk = await loadTokens();
            if (onDisk?.access_token && onDisk.refresh_token !== useToken) return onDisk;
            await clearTokens();
            throw new AuthRequiredError('WHOOP session expired, please reconnect');
          }
          throw err;
        }
      }).finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  async function getAccessToken() {
    if (refreshing) return (await refreshing).access_token;
    const tokens = await loadTokens();
    if (!tokens?.access_token) throw new AuthRequiredError();
    if (Date.now() < tokens.expires_at - 60_000) return tokens.access_token;
    return (await refresh(tokens)).access_token;
  }

  // Called after a 401: refresh only if nobody else already replaced the failing token.
  async function recoverFrom401(failedToken) {
    if (refreshing) return (await refreshing).access_token;
    const tokens = await loadTokens();
    if (!tokens) throw new AuthRequiredError();
    if (tokens.access_token !== failedToken) return tokens.access_token;
    return (await refresh(tokens)).access_token;
  }

  async function get(pathname, params = {}) {
    const url = new URL(API_BASE + pathname);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
    let token = await getAccessToken();
    let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) {
      token = await recoverFrom401(token);
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) {
        await clearTokens();
        throw new AuthRequiredError('WHOOP rejected the access token, please reconnect');
      }
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new WhoopApiError(res.status, await res.text(), pathname);
    return res.json();
  }

  // Collection endpoints page with next_token; max 25 records per page.
  async function getAll(pathname, { start, end, maxPages = 30 } = {}) {
    const records = [];
    let nextToken;
    let pages = 0;
    do {
      const page = await get(pathname, { limit: 25, start, end, nextToken });
      if (!page) break;
      records.push(...(page.records || []));
      nextToken = page.next_token || page.nextToken;
      pages += 1;
    } while (nextToken && pages < maxPages);
    return records;
  }

  async function isConnected() {
    const tokens = await loadTokens();
    return Boolean(tokens?.access_token);
  }

  // Forgets the stored tokens. Access can be fully revoked from the WHOOP app settings.
  async function disconnect() {
    await clearTokens();
  }

  // Asks WHOOP whether redirectUri is registered for this client, without logging anyone in.
  async function checkRedirectRegistered() {
    try {
      const res = await fetch(authorizeUrl('abcdefgh'), { redirect: 'manual' });
      const location = res.headers.get('location') || '';
      if (location.includes('pre-registered') || location.includes('redirect_uri')) return false;
      if (location.includes('login_challenge') || location.includes('/login')) return true;
      return null;
    } catch {
      return null;
    }
  }

  return {
    newState,
    authorizeUrl,
    exchangeCode,
    get,
    getAll,
    isConnected,
    disconnect,
    checkRedirectRegistered,
    redirectUri,
  };
}
