// KPIs that need more history than the selected range. Computed from the full history:
//  - HRV versus baseline: 7-day average against a 60-day normal range
//  - Illness warning: resting HR, HRV, respiratory rate and skin temp versus a 30-day baseline
//  - Training load ratio: 7-day versus 28-day training load (acute:chronic). Load is
//    Edwards TRIMP from recorded activities: minutes in heart-rate zone N count N times.
//    (WHOOP strain is logarithmic, which squeezes the ratio, so it is not used here.)
//  - Sleep timing: bed and wake clock times per night (regularity is summarised in the browser)
//  - Year over year: last 30 days versus the same days a year earlier, plus yearly averages
const DAY = 86_400_000;
const ts = (iso) => Date.parse(`${iso}T00:00:00Z`);
const valid = (a) => a.filter((x) => x != null && Number.isFinite(x));
const mean = (a) => {
  const v = valid(a);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};
const sd = (a) => {
  const v = valid(a);
  if (v.length < 2) return null;
  const m = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
};
const asleepMs = (s) => (s && s.lightMs != null ? s.lightMs + s.swsMs + s.remMs : null);
// Minutes since 18:00 local, so a night's bedtime and wake time sit on one continuous axis.
const clockMin = (local) => {
  if (!local) return null;
  const m = Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));
  return (m - 18 * 60 + 1440) % 1440;
};

export const HRV_BAND_SD = 0.5;
export const SIGNAL_Z = 1.5;
const SIGNALS = [
  { key: 'rhr', label: 'Resting HR', unit: 'bpm', get: (d) => d.recovery?.rhr, dir: 1, minSd: 1 },
  { key: 'hrv', label: 'HRV', unit: 'ms', get: (d) => d.recovery?.hrv, dir: -1, minSd: 3 },
  { key: 'resp', label: 'Respiratory rate', unit: 'rpm', get: (d) => d.sleep?.respiratoryRate, dir: 1, minSd: 0.3 },
  { key: 'skin', label: 'Skin temp', unit: '°C', get: (d) => d.recovery?.skinTemp, dir: 1, minSd: 0.15 },
];

export function loadZone(r) {
  if (r == null) return null;
  if (r < 0.8) return 'low';
  if (r <= 1.3) return 'optimal';
  if (r <= 1.5) return 'high';
  return 'very high';
}

// Zone-weighted training minutes per local calendar day.
function dailyLoad(workouts) {
  const load = new Map();
  for (const w of workouts) {
    if (!w.zonesMs) continue;
    const date = w.localStart.slice(0, 10);
    const trimp = w.zonesMs.reduce((a, ms, zone) => a + (ms / 60_000) * zone, 0);
    load.set(date, (load.get(date) || 0) + trimp);
  }
  return load;
}

export function computeInsights(days, workouts, rangeDates, maxHr) {
  const time = days.map((d) => ts(d.date));
  const load = dailyLoad(workouts);
  const loadSum = (endT, n) => {
    let s = 0;
    for (let k = 0; k < n; k++) s += load.get(new Date(endT - k * DAY).toISOString().slice(0, 10)) || 0;
    return s;
  };
  // values of pick() for days dated between (date - fromDays) and (date - toDays), inclusive
  const win = (i, fromDays, toDays, pick, skip = () => false) => {
    const out = [];
    for (let j = i; j >= 0; j--) {
      const age = (time[i] - time[j]) / DAY;
      if (age > fromDays) break;
      if (age < toDays || skip(days[j])) continue;
      const v = pick(days[j]);
      if (v != null && Number.isFinite(v)) out.push(v);
    }
    return out;
  };

  const series = days.map((d, i) => {
    const row = { date: d.date };

    // HRV versus a 60-day normal range (the 60 days before the current week)
    const acuteHrv = win(i, 6, 0, (x) => x.recovery?.hrv);
    const baseHrv = win(i, 66, 7, (x) => x.recovery?.hrv);
    if (acuteHrv.length >= 4 && baseHrv.length >= 30) {
      const m = mean(baseHrv);
      const s = sd(baseHrv);
      row.hrv7 = mean(acuteHrv);
      row.hrvBase = m;
      row.hrvLo = m - HRV_BAND_SD * s;
      row.hrvHi = m + HRV_BAND_SD * s;
      row.hrvStatus = row.hrv7 < row.hrvLo ? 'below' : row.hrv7 > row.hrvHi ? 'above' : 'normal';
    }

    // Illness warning: how many signals are unusually far from the last 30 days
    const flags = [];
    let checked = 0;
    for (const sig of SIGNALS) {
      const v = sig.get(d);
      const base = win(i, 30, 1, sig.get);
      if (v == null || base.length < 14) continue;
      checked += 1;
      const m = mean(base);
      const z = (v - m) / Math.max(sd(base) || 0, sig.minSd);
      if (sig.dir * z >= SIGNAL_Z) flags.push({ key: sig.key, label: sig.label, unit: sig.unit, value: v, baseline: m });
    }
    if (checked >= 3) {
      row.signals = flags;
      row.signalCount = flags.length;
      row.illness = flags.length >= 3 ? 'warning' : flags.length === 2 ? 'watch' : 'clear';
    }

    // Training load ratio: 7-day versus 28-day zone-weighted minutes per day
    row.load = load.get(d.date) || 0;
    if (time[i] - time[0] >= 27 * DAY) {
      const acute = loadSum(time[i], 7) / 7;
      const chronic = loadSum(time[i], 28) / 28;
      if (chronic > 0) {
        row.acute = acute;
        row.chronic = chronic;
        row.acwr = acute / chronic;
        row.loadZone = loadZone(row.acwr);
      }
    }

    // Sleep timing of the main sleep that ended on this day
    row.bedMin = clockMin(d.sleep?.startLocal);
    row.wakeMin = clockMin(d.sleep?.endLocal);
    return row;
  });

  const latest = (pick) => {
    for (let i = series.length - 1; i >= 0; i--) if (pick(series[i]) != null) return series[i];
    return null;
  };
  const end = time.at(-1) ?? 0;
  const last90 = series.filter((r, i) => end - time[i] < 90 * DAY);
  const hrvNow = latest((r) => r.hrv7);
  const illNow = latest((r) => r.illness);
  const loadNow = latest((r) => r.acwr);

  const wanted = new Set(rangeDates);
  return {
    byDate: Object.fromEntries(series.filter((r) => wanted.has(r.date)).map((r) => [r.date, r])),
    current: {
      hrv: hrvNow && {
        date: hrvNow.date,
        hrv7: hrvNow.hrv7,
        base: hrvNow.hrvBase,
        lo: hrvNow.hrvLo,
        hi: hrvNow.hrvHi,
        status: hrvNow.hrvStatus,
      },
      illness: illNow && {
        date: illNow.date,
        level: illNow.illness,
        signals: illNow.signals,
        warningDays90: last90.filter((r) => r.illness === 'warning').length,
        watchDays90: last90.filter((r) => r.illness === 'watch').length,
      },
      load: loadNow && { date: loadNow.date, acute: loadNow.acute, chronic: loadNow.chronic, acwr: loadNow.acwr, zone: loadNow.loadZone },
    },
    yoy: yearOverYear(days, workouts, maxHr),
    method: { hrvBandSd: HRV_BAND_SD, signalZ: SIGNAL_Z },
  };
}

function periodMetrics(ds, workoutCount, maxHr) {
  const rhr = mean(ds.map((d) => d.recovery?.rhr));
  return {
    days: ds.length,
    recovery: mean(ds.map((d) => d.recovery?.score)),
    hrv: mean(ds.map((d) => d.recovery?.hrv)),
    rhr,
    sleepHours: (mean(ds.map((d) => asleepMs(d.sleep))) ?? NaN) / 3_600_000 || null,
    sleepPerformance: mean(ds.map((d) => d.sleep?.performance)),
    strain: mean(ds.filter((d) => !d.inProgress).map((d) => d.strain)),
    steps: mean(ds.filter((d) => !d.inProgress).map((d) => d.steps)),
    workoutsPerWeek: ds.length ? workoutCount / (ds.length / 7) : null,
    vo2: maxHr && rhr ? (15.3 * maxHr) / rhr : null,
  };
}

function yearOverYear(days, workouts, maxHr) {
  if (!days.length) return null;
  const wDates = workouts.map((w) => w.localStart.slice(0, 10));
  const between = (from, to) => days.filter((d) => d.date > from && d.date <= to);
  const countW = (from, to) => wDates.filter((x) => x > from && x <= to).length;
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const endT = ts(days.at(-1).date);
  const r = { from: iso(endT - 30 * DAY), to: iso(endT) };
  const p = { from: iso(endT - 395 * DAY), to: iso(endT - 365 * DAY) };
  const recentDays = between(r.from, r.to);
  const priorDays = between(p.from, p.to);

  const years = [...new Set(days.map((d) => d.date.slice(0, 4)))].sort().map((y) => {
    const ds = days.filter((d) => d.date.startsWith(y));
    return {
      year: y,
      first: ds[0].date,
      last: ds.at(-1).date,
      ...periodMetrics(ds, wDates.filter((x) => x.startsWith(y)).length, maxHr),
    };
  });
  return {
    recent: { ...r, ...periodMetrics(recentDays, countW(r.from, r.to), maxHr) },
    prior: priorDays.length >= 10 ? { ...p, ...periodMetrics(priorDays, countW(p.from, p.to), maxHr) } : null,
    years,
  };
}
