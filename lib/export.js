// Full-history export of everything the WHOOP v2 API exposes for a member.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WhoopApiError } from './whoop.js';
import { buildPayload } from './dashboard.js';

export const COLLECTIONS = [
  { name: 'cycles', path: '/v2/cycle', key: (r) => r.id },
  { name: 'recovery', path: '/v2/recovery', key: (r) => r.cycle_id },
  { name: 'sleep', path: '/v2/activity/sleep', key: (r) => r.id },
  { name: 'workouts', path: '/v2/activity/workout', key: (r) => r.id },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SPACING_MS = 700; // ~85 requests/minute, under WHOOP's 100/minute limit

export function createThrottledGet(client, log, spacingMs = SPACING_MS) {
  let last = 0;
  let count = 0;
  return async function get(pathname, params) {
    for (let attempt = 1; ; attempt++) {
      const wait = last + spacingMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      count += 1;
      try {
        return await client.get(pathname, params);
      } catch (err) {
        const retryable = err instanceof WhoopApiError && (err.status === 429 || err.status >= 500);
        if (!retryable || attempt >= 6) throw err;
        const pause = err.status === 429 ? 30_000 * attempt : 3_000 * attempt;
        log(`  WHOOP answered ${err.status}; waiting ${Math.round(pause / 1000)}s and retrying`);
        await sleep(pause);
      }
    }
  };
}

// Without a start filter WHOOP pages back through the member's whole history.
export async function fetchHistory(get, col, log, { start } = {}) {
  const seen = new Map();
  let nextToken;
  let page = 0;
  do {
    const res = await get(col.path, { limit: 25, start, nextToken });
    if (!res) break;
    for (const r of res.records || []) seen.set(String(col.key(r)), r);
    nextToken = res.next_token || res.nextToken;
    page += 1;
    if (page % 10 === 0 || !nextToken) log(`  ${col.name}: ${seen.size} records (${page} pages)`);
  } while (nextToken && page < 2000);
  return [...seen.values()].sort((a, b) => Date.parse(a.start || a.created_at) - Date.parse(b.start || b.created_at));
}

// ---------- CSV helpers ----------
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return out;
}

function toCsv(rows, columns) {
  let cols = columns || [...new Set(rows.flatMap((r) => Object.keys(r)))];
  // A record with a null object (e.g. an unscored sauna workout has score: null) would
  // otherwise add an always-empty "score" column next to the real "score.*" columns.
  cols = cols.filter((c) => !(cols.some((o) => o.startsWith(`${c}.`)) && rows.every((r) => r[c] == null)));
  const cell = (v) => {
    if (v == null) return '';
    const s = typeof v === 'number' ? String(+v.toFixed(4)) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `${[cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n')}\n`;
}

const h = (ms) => (ms == null ? null : ms / 3_600_000);
const zone = (s) => (s == null ? null : s >= 67 ? 'green' : s >= 34 ? 'yellow' : 'red');

function offsetMinutes(tz) {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(tz || '');
  if (!m) return 0;
  const mins = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -mins : mins;
}
const localIso = (ts, tz) => (ts ? new Date(Date.parse(ts) + offsetMinutes(tz) * 60_000).toISOString().slice(0, 19) : null);

function dailyRows(raw) {
  const payload = buildPayload({ ...raw, days: 0 });
  const cycleById = new Map(raw.cycles.map((c) => [String(c.id), c]));
  const workoutsByDate = new Map();
  for (const w of payload.workouts) {
    const d = w.localStart.slice(0, 10);
    const e = workoutsByDate.get(d) || { n: 0, strain: 0, minutes: 0, sports: new Set() };
    e.n += 1;
    e.strain = Math.max(e.strain, w.strain || 0);
    e.minutes += w.durationMs / 60_000;
    e.sports.add(w.sport);
    workoutsByDate.set(d, e);
  }
  return payload.days.map((d) => {
    const raw = cycleById.get(String(d.cycleId));
    const r = d.recovery;
    const s = d.sleep;
    const w = workoutsByDate.get(d.date);
    const asleep = s && s.lightMs != null ? s.lightMs + s.swsMs + s.remMs : null;
    return {
      date: d.date,
      cycle_id: d.cycleId,
      cycle_start_local: localIso(d.start, raw?.timezone_offset),
      cycle_end_local: localIso(d.end, raw?.timezone_offset),
      timezone_offset: raw?.timezone_offset,
      day_strain: d.strain,
      calories_kcal: d.kilojoule == null ? null : d.kilojoule / 4.184,
      avg_hr_bpm: d.avgHr,
      max_hr_bpm: d.maxHr,
      steps: raw?.step_count ?? raw?.score?.step_count ?? null,
      recovery_pct: r?.score,
      recovery_zone: zone(r?.score),
      hrv_rmssd_ms: r?.hrv,
      resting_hr_bpm: r?.rhr,
      spo2_pct: r?.spo2,
      skin_temp_c: r?.skinTemp,
      calibrating: r ? r.calibrating : null,
      sleep_start_local: localIso(s?.start, raw?.timezone_offset),
      sleep_end_local: localIso(s?.end, raw?.timezone_offset),
      in_bed_h: h(s?.inBedMs),
      asleep_h: h(asleep),
      light_h: h(s?.lightMs),
      deep_sws_h: h(s?.swsMs),
      rem_h: h(s?.remMs),
      awake_h: h(s?.awakeMs),
      sleep_needed_h: h(s?.neededMs),
      sleep_performance_pct: s?.performance,
      sleep_efficiency_pct: s?.efficiency,
      sleep_consistency_pct: s?.consistency,
      respiratory_rate: s?.respiratoryRate,
      disturbances: s?.disturbances,
      sleep_cycles: s?.sleepCycles,
      naps: d.naps,
      workouts: w?.n ?? 0,
      workout_minutes: w ? Math.round(w.minutes) : 0,
      top_workout_strain: w ? w.strain : null,
      sports: w ? [...w.sports].join('; ') : '',
    };
  });
}

function summarize(raw, daily) {
  const nums = (arr) => arr.filter((v) => v != null && Number.isFinite(v));
  const avg = (arr) => {
    const v = nums(arr);
    return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : null;
  };
  const range = (arr, f) => (arr.length ? { first: f(arr[0]), last: f(arr[arr.length - 1]) } : null);
  const sports = {};
  for (const w of raw.workouts) sports[w.sport_name || 'activity'] = (sports[w.sport_name || 'activity'] || 0) + 1;
  const zones = { green: 0, yellow: 0, red: 0 };
  for (const d of daily) if (d.recovery_zone) zones[d.recovery_zone] += 1;
  const best = (key, dir = 1) => {
    const v = daily.filter((d) => d[key] != null).sort((a, b) => dir * (b[key] - a[key]))[0];
    return v ? { date: v.date, value: +Number(v[key]).toFixed(1) } : null;
  };
  return {
    exportedAt: new Date().toISOString(),
    member: raw.profile ? { name: `${raw.profile.first_name} ${raw.profile.last_name}`.trim(), userId: raw.profile.user_id } : null,
    body: raw.body,
    counts: {
      cycles: raw.cycles.length,
      recovery: raw.recovery.length,
      sleep: raw.sleep.length,
      naps: raw.sleep.filter((s) => s.nap).length,
      workouts: raw.workouts.length,
    },
    dateRange: range(daily, (d) => d.date),
    averages: {
      recovery_pct: avg(daily.map((d) => d.recovery_pct)),
      hrv_rmssd_ms: avg(daily.map((d) => d.hrv_rmssd_ms)),
      resting_hr_bpm: avg(daily.map((d) => d.resting_hr_bpm)),
      day_strain: avg(daily.map((d) => d.day_strain)),
      asleep_h: avg(daily.map((d) => d.asleep_h)),
      sleep_performance_pct: avg(daily.map((d) => d.sleep_performance_pct)),
      calories_kcal: avg(daily.map((d) => d.calories_kcal)),
    },
    recoveryZones: zones,
    records: {
      highest_recovery: best('recovery_pct'),
      lowest_recovery: best('recovery_pct', -1),
      highest_hrv: best('hrv_rmssd_ms'),
      lowest_resting_hr: best('resting_hr_bpm', -1),
      highest_day_strain: best('day_strain'),
      longest_sleep_h: best('asleep_h'),
    },
    workoutsBySport: Object.fromEntries(Object.entries(sports).sort((a, b) => b[1] - a[1])),
    scoreStates: Object.fromEntries(
      ['cycles', 'recovery', 'sleep', 'workouts'].map((k) => [
        k,
        raw[k].reduce((acc, r) => ((acc[r.score_state || 'UNKNOWN'] = (acc[r.score_state || 'UNKNOWN'] || 0) + 1), acc), {}),
      ]),
    ),
  };
}

export async function writeExportFiles(raw, outDir) {
  const { profile, body } = raw;
  const rawDir = path.join(outDir, 'raw');
  const csvDir = path.join(outDir, 'csv');
  await mkdir(rawDir, { recursive: true });
  await mkdir(csvDir, { recursive: true });
  const opts = { mode: 0o600 };

  await writeFile(path.join(rawDir, 'profile.json'), JSON.stringify(profile, null, 2), opts);
  await writeFile(path.join(rawDir, 'body_measurement.json'), JSON.stringify(body, null, 2), opts);
  for (const col of COLLECTIONS) {
    await writeFile(path.join(rawDir, `${col.name}.json`), JSON.stringify(raw[col.name], null, 2), opts);
    await writeFile(path.join(csvDir, `${col.name}.csv`), toCsv(raw[col.name].map((r) => flatten(r))), opts);
  }

  const daily = dailyRows({ profile, body, cycles: raw.cycles, recoveries: raw.recovery, sleeps: raw.sleep, workouts: raw.workouts });
  await writeFile(path.join(outDir, 'daily.csv'), toCsv(daily), opts);

  const summary = summarize(raw, daily);
  await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), opts);
  return summary;
}

// Rebuilds CSVs and the summary from a previous export's raw JSON, without calling WHOOP.
export async function rebuildFromRaw(outDir) {
  const read = async (f) => JSON.parse(await readFile(path.join(outDir, 'raw', f), 'utf8'));
  const raw = { profile: await read('profile.json'), body: await read('body_measurement.json') };
  for (const col of COLLECTIONS) raw[col.name] = await read(`${col.name}.json`);
  return writeExportFiles(raw, outDir);
}

export async function exportAll(client, outDir, log = console.log) {
  const get = createThrottledGet(client, log);
  log('Fetching profile and body measurements');
  const profile = await get('/v2/user/profile/basic');
  const body = await get('/v2/user/measurement/body');
  const raw = { profile, body };
  for (const col of COLLECTIONS) {
    log(`Fetching all ${col.name}`);
    raw[col.name] = await fetchHistory(get, col, log);
  }

  const summary = await writeExportFiles(raw, outDir);
  return { summary, outDir };
}
