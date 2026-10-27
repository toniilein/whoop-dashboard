// Metric registry and period math shared by the MCP server (and usable by other scripts).
// Works on the daily rows from buildPayload() plus the per-day insights from computeInsights().
const H = 3_600_000;
const DAY = 86_400_000;

const hrs = (ms) => (ms == null ? null : ms / H);
const asleepMs = (s) => (s && s.lightMs != null ? s.lightMs + s.swsMs + s.remMs : null);
const clock = (m) => {
  if (m == null || !Number.isFinite(m)) return null;
  const total = ((Math.round(m + 18 * 60) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

// key -> { get(day), unit, better: 'up' | 'down' | null, decimals, skipInProgress, format }
export const METRICS = {
  recovery: { get: (d) => d.recovery?.score, unit: '%', better: 'up', decimals: 0, label: 'Recovery score' },
  hrv: { get: (d) => d.recovery?.hrv, unit: 'ms', better: 'up', decimals: 1, label: 'HRV (RMSSD)' },
  rhr: { get: (d) => d.recovery?.rhr, unit: 'bpm', better: 'down', decimals: 1, label: 'Resting heart rate' },
  spo2: { get: (d) => d.recovery?.spo2, unit: '%', better: 'up', decimals: 1, label: 'Blood oxygen' },
  skin_temp: { get: (d) => d.recovery?.skinTemp, unit: '°C', better: null, decimals: 2, label: 'Skin temperature' },
  strain: { get: (d) => d.strain, unit: '0-21', better: null, decimals: 1, skipInProgress: true, label: 'Day strain' },
  calories: { get: (d) => (d.kilojoule == null ? null : d.kilojoule / 4.184), unit: 'kcal', better: null, decimals: 0, skipInProgress: true, label: 'Calories' },
  steps: { get: (d) => d.steps, unit: 'steps', better: 'up', decimals: 0, skipInProgress: true, label: 'Steps' },
  avg_hr: { get: (d) => d.avgHr, unit: 'bpm', better: null, decimals: 0, skipInProgress: true, label: 'Average heart rate' },
  max_hr: { get: (d) => d.maxHr, unit: 'bpm', better: null, decimals: 0, skipInProgress: true, label: 'Max heart rate' },
  sleep_hours: { get: (d) => hrs(asleepMs(d.sleep)), unit: 'h', better: 'up', decimals: 2, label: 'Hours asleep' },
  time_in_bed: { get: (d) => hrs(d.sleep?.inBedMs), unit: 'h', better: null, decimals: 2, label: 'Time in bed' },
  sleep_need: { get: (d) => hrs(d.sleep?.neededMs), unit: 'h', better: null, decimals: 2, label: 'Sleep need' },
  sleep_debt: { get: (d) => hrs(d.sleep?.debtMs), unit: 'h', better: 'down', decimals: 2, label: 'Sleep debt' },
  sleep_performance: { get: (d) => d.sleep?.performance, unit: '%', better: 'up', decimals: 0, label: 'Sleep performance' },
  sleep_consistency: { get: (d) => d.sleep?.consistency, unit: '%', better: 'up', decimals: 0, label: 'Sleep consistency' },
  sleep_efficiency: { get: (d) => d.sleep?.efficiency, unit: '%', better: 'up', decimals: 0, label: 'Sleep efficiency' },
  deep_hours: { get: (d) => hrs(d.sleep?.swsMs), unit: 'h', better: 'up', decimals: 2, label: 'Deep (slow-wave) sleep' },
  rem_hours: { get: (d) => hrs(d.sleep?.remMs), unit: 'h', better: 'up', decimals: 2, label: 'REM sleep' },
  light_hours: { get: (d) => hrs(d.sleep?.lightMs), unit: 'h', better: null, decimals: 2, label: 'Light sleep' },
  awake_hours: { get: (d) => hrs(d.sleep?.awakeMs), unit: 'h', better: 'down', decimals: 2, label: 'Awake in bed' },
  restorative_hours: { get: (d) => (d.sleep?.swsMs == null ? null : hrs(d.sleep.swsMs + d.sleep.remMs)), unit: 'h', better: 'up', decimals: 2, label: 'Restorative sleep (deep + REM)' },
  resp_rate: { get: (d) => d.sleep?.respiratoryRate, unit: 'rpm', better: null, decimals: 1, label: 'Respiratory rate' },
  disturbances: { get: (d) => d.sleep?.disturbances, unit: 'count', better: 'down', decimals: 0, label: 'Sleep disturbances' },
  naps: { get: (d) => d.naps, unit: 'count', better: null, decimals: 0, label: 'Naps' },
  bedtime: { get: (d) => d.ins?.bedMin, unit: 'clock', better: null, decimals: 0, format: clock, label: 'Bedtime' },
  wake_time: { get: (d) => d.ins?.wakeMin, unit: 'clock', better: null, decimals: 0, format: clock, label: 'Wake time' },
  hrv_7day: { get: (d) => d.ins?.hrv7, unit: 'ms', better: 'up', decimals: 1, label: '7-day average HRV' },
  hrv_baseline_low: { get: (d) => d.ins?.hrvLo, unit: 'ms', better: null, decimals: 1, label: 'HRV normal range, low' },
  hrv_baseline_high: { get: (d) => d.ins?.hrvHi, unit: 'ms', better: null, decimals: 1, label: 'HRV normal range, high' },
  hrv_cv: { get: (d) => d.ins?.hrvCv, unit: '%', better: 'down', decimals: 1, label: 'HRV stability (7-day CV of ln RMSSD)' },
  sri: { get: (d) => d.ins?.sri, unit: 'index', better: 'up', decimals: 0, label: 'Sleep Regularity Index (14-day)' },
  steps_7day: { get: (d) => d.ins?.steps7, unit: 'steps', better: 'up', decimals: 0, label: '7-day average steps' },
  training_load: { get: (d) => d.ins?.load, unit: 'zone-minutes', better: null, decimals: 0, label: 'Daily training load (zone-weighted minutes)' },
  acwr: { get: (d) => d.ins?.acwr, unit: 'ratio', better: 'range', decimals: 2, label: 'Training load ratio (7-day : 28-day)' },
  illness_signals: { get: (d) => d.ins?.signalCount, unit: 'count', better: 'down', decimals: 0, label: 'Illness warning signals out of range (0-4)' },
};
export const METRIC_KEYS = Object.keys(METRICS);
export const DEFAULT_METRICS = ['recovery', 'hrv', 'rhr', 'strain', 'sleep_hours', 'sleep_performance', 'steps'];

export const round = (v, decimals = 1) => (v == null || !Number.isFinite(v) ? null : +Number(v).toFixed(decimals));
export const mean = (arr) => {
  const v = arr.filter((x) => x != null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
export const ts = (iso) => Date.parse(`${iso}T00:00:00Z`);
export const isoDate = (t) => new Date(t).toISOString().slice(0, 10);

export function metricValue(key, day) {
  const m = METRICS[key];
  if (!m) return null;
  if (m.skipInProgress && day.inProgress) return null;
  const v = m.get(day);
  return v == null || !Number.isFinite(v) ? null : v;
}
export function formatValue(key, v) {
  const m = METRICS[key];
  if (v == null) return null;
  return m.format ? m.format(v) : round(v, m.decimals);
}

// Group days into week (Monday start) or month buckets with per-metric averages.
export function bucket(days, unit, metrics) {
  if (unit === 'day') return days.map((d) => ({ date: d.date, days: 1, source: [d] }));
  const key = (d) => {
    if (unit === 'month') return `${d.date.slice(0, 7)}-01`;
    const t = new Date(`${d.date}T12:00:00Z`);
    t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
    return t.toISOString().slice(0, 10);
  };
  const groups = new Map();
  for (const d of days) {
    const k = key(d);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  }
  return [...groups].map(([date, ds]) => ({ date, days: ds.length, source: ds }));
}
export function bucketRows(buckets, metrics) {
  return buckets.map((b) => {
    const row = { date: b.date };
    if (b.days > 1) row.days = b.days;
    for (const k of metrics) {
      const v = b.days === 1 ? metricValue(k, b.source[0]) : mean(b.source.map((d) => metricValue(k, d)));
      row[k] = formatValue(k, v);
    }
    return row;
  });
}
export function autoUnit(nDays) {
  return nDays <= 120 ? 'day' : nDays <= 3 * 365 ? 'week' : 'month';
}

// Least-squares trend of a metric over days (x = calendar day index, so gaps count).
export function trend(key, days) {
  const m = METRICS[key];
  const pts = [];
  const t0 = days.length ? ts(days[0].date) : 0;
  for (const d of days) {
    const v = metricValue(key, d);
    if (v != null) pts.push([(ts(d.date) - t0) / DAY, v, d.date]);
  }
  if (pts.length < 4) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const n = pts.length;
  const den = n * sxx - sx * sx;
  if (!den) return null;
  const slope = (n * sxy - sx * sy) / den; // per day
  const intercept = (sy - slope * sx) / n;
  const span = pts[n - 1][0] - pts[0][0];
  const level = Math.abs(intercept + (slope * (pts[0][0] + pts[n - 1][0])) / 2);
  const period = span <= 31 ? ['week', 7] : span <= 366 ? ['month', 30.44] : ['year', 365.25];
  const perPeriod = slope * period[1];
  const totalChange = slope * span;
  const flat = !level || Math.abs(totalChange) / level < 0.02;
  let direction = 'flat';
  if (!flat) direction = slope > 0 ? 'rising' : 'falling';
  let judgement = 'neutral';
  if (m.better === 'range') {
    const end = intercept + slope * pts[n - 1][0];
    judgement = end >= 0.8 && end <= 1.3 ? 'good' : 'bad';
  } else if (!flat && m.better) {
    judgement = (slope > 0) === (m.better === 'up') ? 'good' : 'bad';
  }
  const ys = pts.map((p) => p[1]);
  const minI = ys.indexOf(Math.min(...ys));
  const maxI = ys.indexOf(Math.max(...ys));
  const firstHalf = pts.slice(0, Math.floor(n / 2)).map((p) => p[1]);
  const secondHalf = pts.slice(Math.floor(n / 2)).map((p) => p[1]);
  return {
    metric: key,
    label: m.label,
    unit: m.unit,
    points: n,
    from: pts[0][2],
    to: pts[n - 1][2],
    direction,
    judgement,
    change_per: period[0],
    change: round(perPeriod, m.decimals + 1),
    total_change_over_range: round(totalChange, m.decimals + 1),
    average: formatValue(key, mean(ys)),
    first_half_average: formatValue(key, mean(firstHalf)),
    second_half_average: formatValue(key, mean(secondHalf)),
    min: { date: pts[minI][2], value: formatValue(key, ys[minI]) },
    max: { date: pts[maxI][2], value: formatValue(key, ys[maxI]) },
  };
}

export function periodSummary(key, days) {
  const vals = days.map((d) => metricValue(key, d)).filter((v) => v != null);
  if (!vals.length) return null;
  return { average: formatValue(key, mean(vals)), min: formatValue(key, Math.min(...vals)), max: formatValue(key, Math.max(...vals)), days_with_data: vals.length };
}

// Resolve a period spec into {start, end} ISO dates (inclusive). `anchor` is the latest date in the
// data; `other` is the first period when resolving the second one of a comparison.
export function resolvePeriod(spec, anchor, other) {
  const endT = ts(anchor);
  const rel = (n, back = 0) => ({ start: isoDate(endT - (n - 1 + back) * DAY), end: isoDate(endT - back * DAY) });
  if (!spec || spec === 'last_7_days') return rel(7);
  if (spec === 'last_30_days') return rel(30);
  if (spec === 'last_90_days') return rel(90);
  if (spec === 'last_365_days') return rel(365);
  // "previous" periods sit right before the other period when one is given, else before the anchor.
  const prev = (n) => {
    if (!other) return rel(n, n);
    const endPrev = ts(other.start) - DAY;
    return { start: isoDate(endPrev - (n - 1) * DAY), end: isoDate(endPrev) };
  };
  if (spec === 'previous_7_days') return prev(7);
  if (spec === 'previous_30_days') return prev(30);
  if (spec === 'previous_90_days') return prev(90);
  if (spec === 'previous_period' && other) return prev(Math.round((ts(other.end) - ts(other.start)) / DAY) + 1);
  if (spec === 'same_period_last_year') {
    const base = other || rel(30);
    const shift = (d) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCFullYear(x.getUTCFullYear() - 1); return x.toISOString().slice(0, 10); };
    return { start: shift(base.start), end: shift(base.end) };
  }
  if (spec === 'all_time') return { start: '2000-01-01', end: anchor }; // callers clamp start to the first day of data
  if (typeof spec === 'string' && /^\d{4}-\d{2}-\d{2}(\.\.|\/| to )\d{4}-\d{2}-\d{2}$/.test(spec)) {
    const [start, end] = spec.split(/\.\.|\/| to /);
    return { start, end };
  }
  if (typeof spec === 'object' && spec.start && spec.end) return { start: spec.start, end: spec.end };
  if (typeof spec === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(spec)) return { start: spec, end: spec };
  if (typeof spec === 'string' && /^\d{4}-\d{2}$/.test(spec)) {
    const [y, mo] = spec.split('-').map(Number);
    return { start: `${spec}-01`, end: isoDate(Date.UTC(y, mo, 0)) };
  }
  if (typeof spec === 'string' && /^\d{4}$/.test(spec)) return { start: `${spec}-01-01`, end: `${spec}-12-31` };
  throw new Error(`Unknown period "${spec}". Use a preset like last_30_days, a date (2026-10-01), a range (2026-10-01..2026-10-14), a month (2026-10), a year (2026), or start and end.`);
}
export const inRange = (days, { start, end }) => days.filter((d) => d.date >= start && d.date <= end);
