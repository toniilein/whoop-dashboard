// Local cache of a member's full WHOOP history, so the all-time view loads quickly.
// First use: seeded from the newest export in exports/, otherwise downloaded in full.
// Afterwards each sync only re-fetches records from the last week onward and merges them.
import { readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { COLLECTIONS, createThrottledGet, fetchHistory } from './export.js';

const OVERLAP_MS = 7 * 86_400_000; // re-fetch a week back to pick up rescored records
const MIN_SYNC_GAP_MS = 60_000;

const startOf = (r) => Date.parse(r.start || r.created_at);

export function createHistory({ client, dataDir, exportsDir, log = console.log }) {
  const file = path.join(dataDir, 'history.json');
  let mem = null;
  let inflight = null;
  let lastSync = 0;

  async function readStore() {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      return null;
    }
  }

  async function seedFromExport(userId) {
    let dirs;
    try {
      dirs = (await readdir(exportsDir)).filter((d) => d.startsWith('whoop-export-')).sort().reverse();
    } catch {
      return null;
    }
    for (const dir of dirs) {
      try {
        const read = async (f) => JSON.parse(await readFile(path.join(exportsDir, dir, 'raw', f), 'utf8'));
        const profile = await read('profile.json');
        if (String(profile?.user_id) !== String(userId)) continue; // never mix members
        const store = { userId, source: `export ${dir}` };
        for (const col of COLLECTIONS) store[col.name] = await read(`${col.name}.json`);
        log(`History: seeded from ${dir}`);
        return store;
      } catch {
        // incomplete export folder, try the next one
      }
    }
    return null;
  }

  function merge(existing, incoming, key) {
    const byKey = new Map(existing.map((r) => [String(key(r)), r]));
    for (const r of incoming) byKey.set(String(key(r)), r);
    return [...byKey.values()].sort((a, b) => startOf(a) - startOf(b));
  }

  async function doSync() {
    const fast = createThrottledGet(client, log, 120);
    const profile = await fast('/v2/user/profile/basic');
    const body = await fast('/v2/user/measurement/body');
    const userId = profile?.user_id;

    if (!mem) mem = await readStore();
    if (mem && String(mem.userId) !== String(userId)) mem = null;
    if (!mem) mem = await seedFromExport(userId);

    if (!mem) {
      log('History: downloading full history (first time only)');
      const slow = createThrottledGet(client, log); // stay under 100 requests/minute
      mem = { userId, source: 'full download' };
      for (const col of COLLECTIONS) mem[col.name] = await fetchHistory(slow, col, (m) => log(`History:${m}`));
    } else {
      const latest = Math.max(0, ...mem.cycles.map(startOf));
      const start = new Date(Math.max(0, latest - OVERLAP_MS)).toISOString();
      for (const col of COLLECTIONS) {
        const fresh = await fetchHistory(fast, col, () => {}, { start });
        mem[col.name] = merge(mem[col.name] || [], fresh, col.key);
      }
    }
    mem.profile = profile;
    mem.body = body;
    mem.syncedAt = new Date().toISOString();
    await mkdir(dataDir, { recursive: true });
    await writeFile(file, JSON.stringify(mem), { mode: 0o600 });
    lastSync = Date.now();
    return mem;
  }

  // Returns the cached history, syncing with WHOOP at most once a minute unless forced.
  async function get({ force = false } = {}) {
    if (inflight) return inflight;
    if (mem && !force && Date.now() - lastSync < MIN_SYNC_GAP_MS) return mem;
    inflight = doSync().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function clear() {
    mem = null;
    lastSync = 0;
    await rm(file, { force: true });
  }

  return { get, clear };
}
