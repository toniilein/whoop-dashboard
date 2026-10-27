#!/usr/bin/env node
// MCP server: exposes the dashboard's computed insights and your full local WHOOP history
// to Claude Desktop, Claude Code and any other MCP client, over stdio.
//
// Reuses the dashboard's login (data/tokens.json) and history cache (data/history.json).
// Log in once through the dashboard (npm start), then register this server:
//   claude mcp add whoop -- node /absolute/path/to/mcp.js
// stdout is the protocol channel, so all logging goes to stderr.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { createWhoopClient, AuthRequiredError } from './lib/whoop.js';
import { createHistory } from './lib/history.js';
import { buildPayload } from './lib/dashboard.js';
import { computeInsights } from './lib/insights.js';
import {
  METRICS, METRIC_KEYS, DEFAULT_METRICS, metricValue, formatValue, round, mean,
  bucket, bucketRows, autoUnit, trend, periodSummary, resolvePeriod, inRange, ts, isoDate,
} from './lib/metrics.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const log = (...a) => console.error('[whoop-mcp]', ...a);

const client = createWhoopClient({
  clientId: process.env.WHOOP_CLIENT_ID,
  clientSecret: process.env.WHOOP_CLIENT_SECRET,
  redirectUri: process.env.WHOOP_REDIRECT_URI,
  dataDir: path.join(ROOT, 'data'),
});
const history = createHistory({ client, dataDir: path.join(ROOT, 'data'), exportsDir: path.join(ROOT, 'exports'), log });

// ---------- data ----------
let cached = null;
async function getData({ force = false } = {}) {
  const h = await history.get({ force });
  if (cached && cached.syncedAt === h.syncedAt && !force) return cached;
  const payload = buildPayload({ profile: h.profile, body: h.body, cycles: h.cycles, recoveries: h.recovery, sleeps: h.sleep, workouts: h.workouts, days: 'all' });
  const insights = computeInsights(payload.days, payload.workouts, payload.days.map((d) => d.date), payload.body?.maxHr);
  const days = payload.days.map((d) => ({ ...d, ins: insights.byDate[d.date] || null }));
  cached = { syncedAt: h.syncedAt, source: h.source, days, workouts: payload.workouts, body: payload.body, profile: payload.profile, insights };
  return cached;
}
const anchorOf = (data) => data.days.at(-1)?.date;

// ---------- formatting helpers ----------
const zoneOf = (s) => (s == null ? null : s >= 67 ? 'green' : s >= 34 ? 'yellow' : 'red');
const strainLevel = (s) => (s == null ? null : s >= 18 ? 'all out' : s >= 14 ? 'high' : s >= 10 ? 'moderate' : 'light');
const h2 = (ms) => round(ms == null ? null : ms / 3_600_000, 2);
// Chronotype's MSFsc counts minutes after midnight, unlike bedtime and wake time,
// which count from 18:00, so it needs its own formatter.
const clockFromMidnight = (m) => {
  if (m == null || !Number.isFinite(m)) return null;
  const total = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

function daySummary(d) {
  const r = d.recovery;
  const s = d.sleep;
  return {
    date: d.date,
    in_progress: Boolean(d.inProgress),
    recovery: r
      ? { score: round(r.score, 0), zone: zoneOf(r.score), hrv_ms: round(r.hrv, 1), resting_hr_bpm: round(r.rhr, 0), spo2_pct: round(r.spo2, 1), skin_temp_c: round(r.skinTemp, 2), calibrating: Boolean(r.calibrating) }
      : null,
    strain: { value: round(d.strain, 1), level: strainLevel(d.strain), calories_kcal: round(d.kilojoule == null ? null : d.kilojoule / 4.184, 0), avg_hr_bpm: d.avgHr ?? null, max_hr_bpm: d.maxHr ?? null, steps: d.steps ?? null },
    sleep: s
      ? {
          bedtime: s.startLocal?.slice(11, 16) ?? null,
          wake_time: s.endLocal?.slice(11, 16) ?? null,
          hours_asleep: h2(s.lightMs == null ? null : s.lightMs + s.swsMs + s.remMs),
          need_hours: h2(s.neededMs),
          debt_hours: h2(s.debtMs),
          performance_pct: round(s.performance, 0),
          consistency_pct: round(s.consistency, 0),
          efficiency_pct: round(s.efficiency, 0),
          deep_hours: h2(s.swsMs),
          rem_hours: h2(s.remMs),
          light_hours: h2(s.lightMs),
          awake_hours: h2(s.awakeMs),
          disturbances: s.disturbances ?? null,
          respiratory_rate: round(s.respiratoryRate, 1),
          naps: d.naps,
        }
      : null,
  };
}

function currentInsights(data) {
  const c = data.insights.current || {};
  const out = {};
  if (c.hrv) {
    const pct = Math.round(((c.hrv.hrv7 - c.hrv.base) / c.hrv.base) * 100);
    out.hrv_vs_baseline = { date: c.hrv.date, seven_day_avg_ms: round(c.hrv.hrv7, 1), normal_range_ms: [round(c.hrv.lo, 1), round(c.hrv.hi, 1)], status: c.hrv.status, percent_vs_baseline: pct };
  }
  if (c.illness) {
    out.illness_warning = { date: c.illness.date, level: c.illness.level, signals_out_of_range: c.illness.signals.map((s) => ({ signal: s.label, value: round(s.value, 1), usual: round(s.baseline, 1), unit: s.unit })), warning_days_last_90: c.illness.warningDays90, watch_days_last_90: c.illness.watchDays90 };
  }
  if (c.load) out.training_load = { date: c.load.date, ratio: round(c.load.acwr, 2), zone: c.load.zone, seven_day_load: round(c.load.acute, 0), twenty_eight_day_load: round(c.load.chronic, 0), optimal_range: [0.8, 1.3] };
  if (c.hrvCv) out.hrv_stability = { date: c.hrvCv.date, cv_pct: round(c.hrvCv.value, 1), usual_range_pct: c.hrvCv.lo == null ? null : [round(c.hrvCv.lo, 1), round(c.hrvCv.hi, 1)], status: c.hrvCv.status, note: 'Higher means less stable day to day' };
  if (c.sri) out.sleep_regularity = { date: c.sri.date, index: round(c.sri.value, 0), reference: 'UK Biobank median 81; bottom fifth < 71.6; top fifth > 87.3' };
  if (c.steps) out.step_dose = { date: c.steps.date, seven_day_avg: round(c.steps.mean7, 0), share_of_last_30_days_at_7000_plus: round(c.steps.share7k30, 2), reference: 'Benefit levels off around 8,000-10,000 a day under age 60' };
  if (c.chronotype) out.chronotype = { type: c.chronotype.type, mid_sleep_free_days: clockFromMidnight(c.chronotype.msfsc), free_nights: c.chronotype.freeNights, work_nights: c.chronotype.workNights, note: 'MSFsc over the last 8 weeks; invalid if an alarm is used on weekends' };
  return out;
}

function flagsFor(data) {
  const flags = [];
  const c = data.insights.current || {};
  const d = data.days.at(-1);
  if (d?.recovery?.score != null) flags.push(`Recovery ${Math.round(d.recovery.score)}% (${zoneOf(d.recovery.score)})`);
  if (c.hrv?.status === 'below') flags.push(`7-day HRV ${Math.abs(Math.round(((c.hrv.hrv7 - c.hrv.base) / c.hrv.base) * 100))}% below the 60-day baseline`);
  if (c.illness?.level === 'warning') flags.push(`Illness warning: ${c.illness.signals.map((s) => s.label.toLowerCase()).join(', ')} out of range`);
  else if (c.illness?.level === 'watch') flags.push(`Illness watch: ${c.illness.signals.map((s) => s.label.toLowerCase()).join(', ')} out of range`);
  if (c.load && c.load.zone !== 'optimal') flags.push(`Training load ratio ${round(c.load.acwr, 2)} (${c.load.zone})`);
  if (c.hrvCv?.status === 'above') flags.push('HRV less stable than usual this week');
  if (d?.sleep?.debtMs > 45 * 60_000) flags.push(`Sleep debt ${Math.round(d.sleep.debtMs / 60_000)} min`);
  return flags;
}

function workoutRow(w) {
  return {
    start_local: w.localStart.slice(0, 16).replace('T', ' '),
    sport: w.sport,
    duration_min: Math.round(w.durationMs / 60_000),
    strain: round(w.strain, 1),
    avg_hr_bpm: w.avgHr ?? null,
    max_hr_bpm: w.maxHr ?? null,
    calories_kcal: w.kilojoule == null ? null : Math.round(w.kilojoule / 4.184),
    distance_km: w.distanceMeter ? round(w.distanceMeter / 1000, 2) : null,
    zone_minutes: w.zonesMs ? w.zonesMs.map((ms) => Math.round(ms / 60_000)) : null,
  };
}

// Validation problems are reported to the model without a stack trace in the log.
class InputError extends Error {}
function periodArgs(args, data) {
  const anchor = anchorOf(data);
  let range;
  if (args.start || args.end) {
    if (!args.start || !args.end) throw new InputError('Give both start and end (YYYY-MM-DD), or use period.');
    range = { start: args.start, end: args.end };
  } else {
    try {
      range = resolvePeriod(args.period || 'last_30_days', anchor);
    } catch (e) {
      throw new InputError(e.message);
    }
  }
  const first = data.days[0]?.date;
  if (first && range.start < first) range = { ...range, start: first };
  return range;
}

// ---------- tool plumbing ----------
const ok = (result) => ({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });
const NOT_CONNECTED = 'Not connected to WHOOP. In the project folder run `npm start`, open http://localhost:3000, click Connect WHOOP and approve access. This server reuses that login.';
const wrap = (fn) => async (args) => {
  try {
    return ok(await fn(args || {}));
  } catch (err) {
    if (err instanceof AuthRequiredError) return fail(NOT_CONNECTED);
    if (!(err instanceof InputError)) log(err.stack || err.message);
    return fail(`Error: ${err.message}`);
  }
};
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const periodField = z.string().optional().describe('Preset or date: last_7_days, last_30_days (default), last_90_days, last_365_days, previous_7_days, previous_30_days, previous_90_days, same_period_last_year, all_time, a day (2026-10-01), a range (2026-10-01..2026-10-14), a month (2026-10) or a year (2026). Or give start and end instead.');
const dateField = (what) => z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(`${what} date, YYYY-MM-DD`);
const metricField = z.enum(METRIC_KEYS);

const METHODS_DOC = `# How the WHOOP dashboard computes its metrics

All values come from the official WHOOP Developer API v2 and are computed locally. A "day" is a WHOOP cycle, labelled by the calendar day the member woke up. Recovery and sleep belong to the night that ended that day.

- Recovery zones: green 67-100, yellow 34-66, red 0-33 (WHOOP's own bands).
- Strain is WHOOP's 0-21 logarithmic scale; today's value is partial until the day ends.
- HRV versus baseline: 7-day average HRV against the previous 60 days' average +/- 0.5 SD. "below" means the week sits under that range.
- Illness warning: each night resting HR, HRV, respiratory rate and skin temperature are compared with the previous 30 days; a signal is out of range at >= 1.5 SD in the unhealthy direction. 2 signals = watch, 3-4 = warning. A heads-up, not a diagnosis.
- Training load ratio (ACWR): 7-day average load / 28-day average load, where load = Edwards TRIMP (minutes in heart-rate zone N count N) from recorded workouts. Guideline 0.8-1.3; above 1.5 is a sharp jump. WHOOP strain is not used because its log scale compresses the ratio.
- HRV stability: 7-day coefficient of variation of ln(RMSSD), compared with the previous 60 days (mean +/- 1 SD). Higher = less stable; linked with fatigue (Flatt 2017).
- Sleep Regularity Index: Phillips et al. 2017, over the previous 14 days, from each night's main sleep. UK Biobank: median 81, bottom fifth < 71.6, top fifth > 87.3 (Windred 2024). Reads a little high because WHOOP does not share wake bouts.
- Step dose: 7-day average steps; benefit levels off around 8,000-10,000/day under 60 (Paluch 2022). Steps exist from Sept 2024.
- Chronotype: mid-sleep on free days (nights before Sat/Sun) corrected for catch-up sleep (MSFsc, Munich ChronoType). Early < 04:00, intermediate 04:00-04:59, late >= 05:00.
- VO2 max estimate (dashboard only): 15.3 x max HR / resting HR (Uth 2004). Not WHOOP's own value.
- Sleep timing: bedtime and wake time of the main sleep, in the member's local time.
- Not available from the API: WHOOP Age, WHOOP's VO2 max, Stress Monitor, strain target, journal, lean body mass, all-day heart rate.`;

// ---------- server ----------
function createServer() {
  const server = new McpServer(
    { name: 'whoop-dashboard', version: VERSION },
    {
      instructions:
        'Local WHOOP health data for one member: daily recovery, strain, sleep, workouts and computed insights (HRV baseline, illness signals, training load, sleep regularity, chronotype). ' +
        'Start with whoop_today for the current picture, whoop_trend or whoop_history for changes over time, whoop_compare for period-versus-period questions, whoop_find_days for "when was my worst/best ..." questions. ' +
        'Read whoop://methods before explaining how a metric is calculated. Dates are the member\'s local calendar days. ' +
        'Estimates are estimates and the illness warning is a heads-up, not a diagnosis; say so when it matters.',
    },
  );

  server.registerTool(
    'whoop_status',
    { title: 'Connection and data status', description: 'Whether WHOOP is connected, how much history is cached, when it last synced, and the member\'s profile basics.', inputSchema: z.object({}), annotations: RO },
    wrap(async () => {
      const connected = await client.isConnected();
      if (!connected) return { connected: false, how_to_connect: NOT_CONNECTED };
      const data = await getData();
      return {
        connected: true,
        member: data.profile ? `${data.profile.firstName} ${data.profile.lastName}`.trim() : null,
        body: data.body,
        history: { first_date: data.days[0]?.date, last_date: anchorOf(data), days: data.days.length, workouts: data.workouts.length, synced_at: data.syncedAt, source: data.source },
        metrics_available: METRIC_KEYS,
      };
    }),
  );

  server.registerTool(
    'whoop_today',
    { title: 'Today\'s picture', description: 'The latest day: recovery, strain so far, last night\'s sleep, the current insights (HRV vs baseline, illness warning, training load ratio, HRV stability, sleep regularity, step dose, chronotype), workouts from the last two days, and short flags worth mentioning.', inputSchema: z.object({}), annotations: RO },
    wrap(async () => {
      const data = await getData();
      const today = data.days.at(-1);
      const yesterday = data.days.at(-2);
      const since = ts(today.date) - 86_400_000;
      return {
        today: daySummary(today),
        yesterday: yesterday ? daySummary(yesterday) : null,
        insights: currentInsights(data),
        flags: flagsFor(data),
        recent_workouts: data.workouts.filter((w) => Date.parse(w.localStart) >= since).map(workoutRow),
        synced_at: data.syncedAt,
      };
    }),
  );

  server.registerTool(
    'whoop_history',
    {
      title: 'Daily history',
      description: 'Daily (or weekly/monthly averaged) values of chosen metrics over a period. Long periods are averaged per week or month unless granularity is set. Use whoop_trend for a single metric\'s direction.',
      inputSchema: z.object({
        period: periodField,
        start: dateField('Start'),
        end: dateField('End'),
        metrics: z.array(metricField).optional().describe(`Metrics to include. Default: ${DEFAULT_METRICS.join(', ')}. Available: ${METRIC_KEYS.join(', ')}`),
        granularity: z.enum(['auto', 'day', 'week', 'month']).optional().describe('auto picks day up to 120 days, week up to 3 years, else month'),
      }),
      annotations: RO,
    },
    wrap(async (args) => {
      const data = await getData();
      const range = periodArgs(args, data);
      const days = inRange(data.days, range);
      const metrics = args.metrics?.length ? args.metrics : DEFAULT_METRICS;
      const unit = !args.granularity || args.granularity === 'auto' ? autoUnit(days.length) : args.granularity;
      const rows = bucketRows(bucket(days, unit, metrics), metrics);
      return {
        period: range,
        granularity: unit,
        units: Object.fromEntries(metrics.map((k) => [k, METRICS[k].unit])),
        rows,
        summary: Object.fromEntries(metrics.map((k) => [k, periodSummary(k, days)])),
      };
    }),
  );

  server.registerTool(
    'whoop_trend',
    {
      title: 'Trend of one metric',
      description: 'Least-squares trend of a metric over a period: direction, rate of change per week/month/year, whether that is good or bad for health, first-half vs second-half averages, and the min and max days.',
      inputSchema: z.object({ metric: metricField, period: periodField, start: dateField('Start'), end: dateField('End') }),
      annotations: RO,
    },
    wrap(async (args) => {
      const data = await getData();
      const range = periodArgs(args, data);
      const days = inRange(data.days, range);
      const t = trend(args.metric, days);
      if (!t) return { period: range, metric: args.metric, note: 'Not enough data points in this period for a trend (need 4+).' };
      return { period: range, ...t, healthy_direction: METRICS[args.metric].better };
    }),
  );

  server.registerTool(
    'whoop_compare',
    {
      title: 'Compare two periods',
      description: 'Average of each metric in period A versus period B, with the change and whether it is good or bad. Defaults: last_30_days versus previous_30_days. Use same_period_last_year for year-over-year.',
      inputSchema: z.object({
        period_a: periodField,
        period_b: z.string().optional().describe('Same forms as period_a; default previous_30_days. previous_* periods and previous_period (same length as A) sit right before period A; same_period_last_year is period A shifted back one year.'),
        metrics: z.array(metricField).optional(),
      }),
      annotations: RO,
    },
    wrap(async (args) => {
      const data = await getData();
      const anchor = anchorOf(data);
      let a;
      let b;
      try {
        a = resolvePeriod(args.period_a || 'last_30_days', anchor);
        b = resolvePeriod(args.period_b || 'previous_30_days', anchor, a);
      } catch (e) {
        throw new InputError(e.message);
      }
      const metrics = args.metrics?.length ? args.metrics : [...DEFAULT_METRICS, 'sleep_consistency', 'sri', 'hrv_cv'];
      const daysA = inRange(data.days, a);
      const daysB = inRange(data.days, b);
      const rows = metrics.map((k) => {
        const m = METRICS[k];
        const va = mean(daysA.map((d) => metricValue(k, d)));
        const vb = mean(daysB.map((d) => metricValue(k, d)));
        const diff = va != null && vb != null ? va - vb : null;
        let judgement = 'neutral';
        if (diff != null && vb && Math.abs(diff) / Math.abs(vb) >= 0.02 && m.better && m.better !== 'range') judgement = (diff > 0) === (m.better === 'up') ? 'good' : 'bad';
        return { metric: k, unit: m.unit, period_a: formatValue(k, va), period_b: formatValue(k, vb), change: round(diff, m.decimals + 1), change_pct: vb ? round((diff / Math.abs(vb)) * 100, 1) : null, judgement };
      });
      const count = (ds) => ds.filter((d) => d.recovery?.score != null).length;
      return { period_a: { ...a, days_with_data: count(daysA) }, period_b: { ...b, days_with_data: count(daysB) }, rows };
    }),
  );

  server.registerTool(
    'whoop_workouts',
    {
      title: 'Workouts',
      description: 'Recorded workouts in a period with duration, strain, heart rate, calories, distance and heart-rate zone minutes, plus totals by sport and by time of day.',
      inputSchema: z.object({ period: periodField, start: dateField('Start'), end: dateField('End'), sport: z.string().optional().describe('Filter by sport name, case-insensitive substring'), limit: z.number().int().min(1).max(500).optional().describe('Max workouts to list, newest first (default 50)') }),
      annotations: RO,
    },
    wrap(async (args) => {
      const data = await getData();
      const range = periodArgs(args, data);
      let ws = data.workouts.filter((w) => { const d = w.localStart.slice(0, 10); return d >= range.start && d <= range.end; });
      if (args.sport) ws = ws.filter((w) => w.sport.toLowerCase().includes(args.sport.toLowerCase()));
      const bySport = {};
      const byPart = { morning: 0, afternoon: 0, evening: 0, night: 0 };
      for (const w of ws) {
        const s = (bySport[w.sport] ||= { count: 0, minutes: 0, strain_sum: 0 });
        s.count += 1;
        s.minutes += Math.round(w.durationMs / 60_000);
        s.strain_sum += w.strain || 0;
        const hr = Number(w.localStart.slice(11, 13));
        byPart[hr >= 5 && hr < 12 ? 'morning' : hr >= 12 && hr < 17 ? 'afternoon' : hr >= 17 && hr < 21 ? 'evening' : 'night'] += 1;
      }
      for (const s of Object.values(bySport)) { s.avg_strain = round(s.strain_sum / s.count, 1); delete s.strain_sum; }
      return {
        period: range,
        total: ws.length,
        total_minutes: ws.reduce((a, w) => a + Math.round(w.durationMs / 60_000), 0),
        by_sport: Object.fromEntries(Object.entries(bySport).sort((x, y) => y[1].count - x[1].count)),
        by_time_of_day: byPart,
        workouts: ws.slice(0, args.limit || 50).map(workoutRow),
      };
    }),
  );

  server.registerTool(
    'whoop_find_days',
    {
      title: 'Find days by condition',
      description: 'Days where a metric was below/above a value, between two values, or the lowest/highest in a period. Good for "when was my worst recovery" or "nights under 6 hours". Returns each day with context (recovery, strain, hours asleep).',
      inputSchema: z.object({
        metric: metricField,
        condition: z.enum(['below', 'above', 'between', 'lowest', 'highest']),
        value: z.number().optional().describe('Threshold for below/above, or lower bound for between'),
        value2: z.number().optional().describe('Upper bound for between'),
        period: periodField,
        start: dateField('Start'),
        end: dateField('End'),
        limit: z.number().int().min(1).max(200).optional().describe('Max days to return (default 20)'),
      }),
      annotations: RO,
    },
    wrap(async (args) => {
      const data = await getData();
      const range = periodArgs(args, data);
      const m = METRICS[args.metric];
      let rows = inRange(data.days, range).map((d) => ({ d, v: metricValue(args.metric, d) })).filter((x) => x.v != null);
      const daysWithData = rows.length;
      const { condition, value, value2 } = args;
      if ((condition === 'below' || condition === 'above') && value == null) throw new InputError(`${condition} needs a value.`);
      if (condition === 'between' && (value == null || value2 == null)) throw new InputError('between needs value and value2.');
      if (condition === 'below') rows = rows.filter((x) => x.v < value);
      else if (condition === 'above') rows = rows.filter((x) => x.v > value);
      else if (condition === 'between') rows = rows.filter((x) => x.v >= value && x.v <= value2);
      rows.sort((x, y) => (condition === 'highest' ? y.v - x.v : condition === 'lowest' ? x.v - y.v : y.d.date.localeCompare(x.d.date)));
      const limit = args.limit || 20;
      return {
        period: range,
        metric: args.metric,
        unit: m.unit,
        days_with_data: daysWithData,
        ...(condition === 'lowest' || condition === 'highest' ? {} : { matching_days: rows.length }),
        days: rows.slice(0, limit).map(({ d, v }) => ({
          date: d.date,
          value: formatValue(args.metric, v),
          recovery: round(d.recovery?.score, 0),
          strain: round(d.strain, 1),
          hours_asleep: h2(d.sleep?.lightMs == null ? null : d.sleep.lightMs + d.sleep.swsMs + d.sleep.remMs),
          illness_signals: d.ins?.signalCount ?? null,
        })),
      };
    }),
  );

  server.registerTool(
    'whoop_sync',
    { title: 'Sync with WHOOP now', description: 'Fetches the latest data from WHOOP (last week re-fetched and merged) and reports what the cache now covers. Normally not needed: other tools sync automatically at most once a minute.', inputSchema: z.object({}), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
    wrap(async () => {
      const before = cached ? { days: cached.days.length, workouts: cached.workouts.length, last_date: anchorOf(cached) } : null;
      const data = await getData({ force: true });
      return { before, after: { days: data.days.length, workouts: data.workouts.length, last_date: anchorOf(data) }, synced_at: data.syncedAt };
    }),
  );

  // ---------- resources ----------
  server.registerResource(
    'summary',
    'whoop://summary',
    { title: 'Current WHOOP summary', description: 'Today, yesterday, current insights and flags, as JSON', mimeType: 'application/json' },
    async (uri) => {
      const data = await getData();
      const body = { today: daySummary(data.days.at(-1)), insights: currentInsights(data), flags: flagsFor(data), synced_at: data.syncedAt };
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body, null, 1) }] };
    },
  );
  server.registerResource(
    'methods',
    'whoop://methods',
    { title: 'How each metric is calculated', description: 'Definitions, thresholds and sources for every computed metric', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: METHODS_DOC }] }),
  );
  server.registerResource(
    'day',
    new ResourceTemplate('whoop://day/{date}', { list: undefined }),
    { title: 'One day in full', description: 'Everything recorded for a calendar day (YYYY-MM-DD): recovery, strain, sleep, insights and workouts', mimeType: 'application/json' },
    async (uri, { date }) => {
      const data = await getData();
      const d = data.days.find((x) => x.date === date);
      if (!d) throw new Error(`No WHOOP data for ${date}. History covers ${data.days[0]?.date} to ${anchorOf(data)}.`);
      const body = { ...daySummary(d), insights: d.ins, workouts: data.workouts.filter((w) => w.localStart.slice(0, 10) === date).map(workoutRow) };
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body, null, 1) }] };
    },
  );

  // ---------- prompts ----------
  server.registerPrompt(
    'morning_briefing',
    { title: 'Morning briefing', description: 'A short, honest read of today\'s recovery, sleep and warning signs, with one suggestion for the day.', argsSchema: z.object({ focus: z.string().optional().describe('Optional: what matters today, e.g. "race on Saturday" or "feeling tired"') }) },
    ({ focus }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Give me a morning briefing from my WHOOP data. Call whoop_today first, then whoop_trend for hrv and rhr over last_30_days. ` +
            `Write at most 6 short lines: today's recovery and what drove it, sleep versus need, any flags (HRV below baseline, illness signals, training load), the 30-day HRV and resting-HR direction, and one concrete suggestion for today. ` +
            `Keep estimates labelled as estimates and treat illness signals as a heads-up, not a diagnosis.${focus ? ` Context from me: ${focus}` : ''}`,
        },
      }],
    }),
  );
  server.registerPrompt(
    'weekly_review',
    { title: 'Weekly review', description: 'Compare the last 7 days with the previous 7, review workouts and sleep timing, and propose one experiment for next week.', argsSchema: z.object({ week_ending: z.string().optional().describe('Optional end date YYYY-MM-DD; default is the latest day') }) },
    ({ week_ending }) => {
      const a = week_ending ? `period_a "${isoDate(ts(week_ending) - 6 * 86_400_000)}..${week_ending}"` : 'period_a last_7_days';
      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `Review my week from WHOOP data. Use whoop_compare (${a}, period_b previous_7_days), whoop_workouts for the same period, and whoop_history with metrics bedtime, wake_time, sleep_hours, recovery for the same period. ` +
              `Report: what improved, what slipped, training volume and intensity mix, sleep timing regularity, and the two or three days that stood out (use whoop_find_days if helpful). ` +
              `End with exactly one experiment for next week that the data supports, stated as a measurable target. Be concrete and brief.`,
          },
        }],
      };
    },
  );
  server.registerPrompt(
    'explain_metric',
    { title: 'Explain a metric', description: 'Explain how one of the computed metrics works and what the member\'s current value means.', argsSchema: z.object({ metric: z.string().describe(`One of: ${METRIC_KEYS.join(', ')}`) }) },
    ({ metric }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Explain the WHOOP dashboard metric "${metric}". Read the whoop://methods resource for the definition and thresholds, then call whoop_trend for ${metric} over last_90_days and whoop_today. Explain in plain language what it measures, how it is computed here, what my current value and 90-day trend mean, and the main caveat.`,
        },
      }],
    }),
  );

  return server;
}

const handle = await serveStdio(() => createServer());
log(`whoop-dashboard MCP server ${VERSION} ready (stdio)`);
process.on('SIGINT', async () => {
  await handle.close();
  process.exit(0);
});
