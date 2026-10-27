// KPIs that need more history than the selected range. Computed from the full history:
//  - HRV versus baseline: 7-day average against a 60-day normal range
//  - Illness warning: resting HR, HRV, respiratory rate and skin temp versus a 30-day baseline
//  - Training load ratio: 7-day versus 28-day training load (acute:chronic). Load is
//    Edwards TRIMP from recorded activities: minutes in heart-rate zone N count N times.
//    (WHOOP strain is logarithmic, which squeezes the ratio, so it is not used here.)
//  - Sleep timing: bed and wake clock times per night (regularity is summarised in the browser)
//  - HRV stability: 7-day coefficient of variation of ln(RMSSD) against the previous 60 days
//  - Sleep Regularity Index (Phillips 2017): chance of the same sleep/wake state 24 h apart
//  - Step dose: 7-day average steps
//  - Chronotype: mid-sleep on free days, corrected for sleep debt (MSFsc, Munich ChronoType)
const DAY = 86_400_000;
const ts = (iso) => Date.parse(`${iso}T00:00:00Z`);

// The last 53 weeks, one compact row per day, for the calendar heatmaps. Sent with every
// range so the heatmaps always show a full year.
function calendarDays(days, series, weeks = 53) {
  if (!days.length) return [];
  const from = ts(days.at(-1).date) - (weeks * 7 - 1) * DAY;
  const out = [];
  days.forEach((d, i) => {
    if (ts(d.date) < from) return;
    const r = series[i] || {};
    out.push({
      date: d.date,
      recovery: d.recovery?.score ?? null,
      sleep: d.sleep?.performance ?? null,
      strain: d.strain ?? null,
      partial: Boolean(d.inProgress),
      illness: r.illness ?? null,
      signals: r.signals?.length ? r.signals.map((f) => f.label) : undefined,
    });
  });
  return out;
}
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
    // HRV stability: coefficient of variation of ln(RMSSD) over the last 7 days
    const lnHrv = win(i, 6, 0, (x) => (x.recovery?.hrv > 0 ? Math.log(x.recovery.hrv) : null));
    if (lnHrv.length >= 5) row.hrvCv = (sd(lnHrv) / mean(lnHrv)) * 100;

    // Step dose: 7-day average, leaving out today's unfinished count
    const steps = win(i, 6, 0, (x) => (x.inProgress ? null : x.steps));
    if (steps.length >= 4) row.steps7 = mean(steps);

    row.bedMin = clockMin(d.sleep?.startLocal);
    row.wakeMin = clockMin(d.sleep?.endLocal);
    return row;
  });

  // HRV stability band: the previous 60 days of 7-day CV values, mean ± 1 SD
  series.forEach((row, i) => {
    if (row.hrvCv == null) return;
    const prior = [];
    for (let j = i; j >= 0; j--) {
      const age = (time[i] - time[j]) / DAY;
      if (age > 66) break;
      if (age >= 7 && series[j].hrvCv != null) prior.push(series[j].hrvCv);
    }
    if (prior.length < 30) return;
    const m = mean(prior);
    const s1 = sd(prior);
    row.hrvCvLo = m - s1;
    row.hrvCvHi = m + s1;
    row.hrvCvStatus = row.hrvCv > row.hrvCvHi ? 'above' : row.hrvCv < row.hrvCvLo ? 'below' : 'normal';
  });

  sleepRegularity(days, series);

  const latest = (pick) => {
    for (let i = series.length - 1; i >= 0; i--) if (pick(series[i]) != null) return series[i];
    return null;
  };
  const end = time.at(-1) ?? 0;
  const last90 = series.filter((r, i) => end - time[i] < 90 * DAY);
  const hrvNow = latest((r) => r.hrv7);
  const illNow = latest((r) => r.illness);
  const loadNow = latest((r) => r.acwr);
  const cvNow = latest((r) => r.hrvCv);
  const sriNow = latest((r) => r.sri);
  const stepsNow = latest((r) => r.steps7);
  const last30 = days.filter((d, i) => end - time[i] < 30 * DAY && !d.inProgress && d.steps != null);

  const wanted = new Set(rangeDates);
  return {
    byDate: Object.fromEntries(series.filter((r) => wanted.has(r.date)).map((r) => [r.date, r])),
    calendar: calendarDays(days, series),
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
      hrvCv: cvNow && { date: cvNow.date, value: cvNow.hrvCv, lo: cvNow.hrvCvLo ?? null, hi: cvNow.hrvCvHi ?? null, status: cvNow.hrvCvStatus ?? null },
      sri: sriNow && { date: sriNow.date, value: sriNow.sri },
      steps: stepsNow && {
        date: stepsNow.date,
        mean7: stepsNow.steps7,
        days30: last30.length,
        share7k30: last30.length ? last30.filter((d) => d.steps >= 7000).length / last30.length : null,
      },
      chronotype: chronotype(days),
    },
    method: { hrvBandSd: HRV_BAND_SD, signalZ: SIGNAL_Z },
  };
}

// Sleep Regularity Index over the trailing 14 days, per day (Phillips et al. 2017).
// Builds a minute-by-minute asleep/awake series on the member's local clock from each
// day's main sleep, and only compares minute pairs where both days had the strap on.
function sleepRegularity(days, series) {
  if (!days.length) return;
  const base = ts(days[0].date);
  const nDays = Math.round((ts(days.at(-1).date) - base) / DAY) + 2;
  const covered = new Uint8Array(nDays);
  for (const d of days) covered[Math.round((ts(d.date) - base) / DAY)] = 1;
  const M = nDays * 1440;
  const asleep = new Uint8Array(M);
  const toMin = (local) => Math.round((Date.parse(`${local}Z`) - base) / 60_000);
  for (const d of days) {
    if (!d.sleep?.startLocal || !d.sleep?.endLocal) continue;
    const a = Math.max(0, toMin(d.sleep.startLocal));
    const b = Math.min(M, toMin(d.sleep.endLocal));
    for (let t = a; t < b; t++) asleep[t] = 1;
  }
  // prefix sums over minute pairs (t, t + 1440): valid pairs and matching pairs
  const P = M - 1440;
  const validSum = new Int32Array(P + 1);
  const matchSum = new Int32Array(P + 1);
  for (let t = 0; t < P; t++) {
    const ok = covered[Math.floor(t / 1440)] && covered[Math.floor((t + 1440) / 1440)];
    validSum[t + 1] = validSum[t] + (ok ? 1 : 0);
    matchSum[t + 1] = matchSum[t] + (ok && asleep[t] === asleep[t + 1440] ? 1 : 0);
  }
  series.forEach((row) => {
    const endDay = Math.round((ts(row.date) - base) / DAY) + 1; // end of this day
    const hi = Math.min(P, endDay * 1440 - 1440);
    const lo = Math.max(0, endDay * 1440 - 14 * 1440);
    if (hi <= lo) return;
    const valid = validSum[hi] - validSum[lo];
    if (valid < 7 * 1440) return; // need at least a week of comparable days
    row.sri = -100 + (200 * (matchSum[hi] - matchSum[lo])) / valid;
  });
}

// Chronotype from the last 8 weeks: mid-sleep on free days (nights before Saturday and
// Sunday), corrected for catch-up sleep when free-day sleep is longer (MSFsc).
function chronotype(days) {
  if (!days.length) return null;
  const endT = ts(days.at(-1).date);
  const nights = days.filter((d) => endT - ts(d.date) < 56 * DAY && d.sleep?.startLocal && d.sleep?.endLocal);
  const onset = (d) => clockMin(d.sleep.startLocal); // minutes after 18:00
  const dur = (d) => (Date.parse(`${d.sleep.endLocal}Z`) - Date.parse(`${d.sleep.startLocal}Z`)) / 60_000;
  const isFree = (d) => [0, 6].includes(new Date(`${d.date}T12:00:00Z`).getUTCDay());
  const free = nights.filter(isFree);
  const work = nights.filter((d) => !isFree(d));
  if (free.length < 4 || work.length < 8) return null;
  const sdF = mean(free.map(dur));
  const sdW = mean(work.map(dur));
  const msf = mean(free.map(onset)) + sdF / 2;
  const sdWeek = (5 * sdW + 2 * sdF) / 7;
  const msfsc = sdF > sdW ? msf - (sdF - sdWeek) / 2 : msf;
  const afterMidnight = (((msfsc + 18 * 60) % 1440) + 1440) % 1440;
  const minutesPastMidnight = afterMidnight > 18 * 60 ? afterMidnight - 1440 : afterMidnight; // before 6 PM wraps negative
  const type = minutesPastMidnight < 4 * 60 ? 'early' : minutesPastMidnight < 5 * 60 ? 'intermediate' : 'late';
  return { msfsc: afterMidnight, type, freeNights: free.length, workNights: work.length, sleepFree: sdF, sleepWork: sdW };
}
