// Deterministic sample data in the same raw shape the WHOOP v2 API returns,
// so the UI can be previewed before connecting an account.
import { buildPayload } from './dashboard.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const SPORTS = ['Running', 'Cycling', 'Weightlifting', 'Functional Fitness', 'Yoga', 'Tennis', 'Swimming'];

export function demoPayload(days) {
  const rand = rng(20261024);
  const now = Date.now();
  const tz = '+02:00';
  const cycles = [];
  const recoveries = [];
  const sleeps = [];
  const workouts = [];
  let prevStrain = 11;
  const total = 180; // generate a fixed history so every range shows the same days
  for (let i = total - 1; i >= 0; i--) {
    const dayStart = new Date(now - i * 86_400_000);
    dayStart.setUTCHours(21, 10 + Math.floor(rand() * 80), 0, 0); // ~23:10-00:30 local
    const cycleStart = new Date(dayStart.getTime() - 86_400_000);
    const sleepMs = (6 + rand() * 2.6) * 3_600_000;
    const sleepEnd = new Date(cycleStart.getTime() + sleepMs + 20 * 60_000);
    const id = 900000 + (total - i);
    const sleepPerf = clamp(Math.round((sleepMs / (8.2 * 3_600_000)) * 100 - rand() * 6), 52, 100);
    const recovery = clamp(Math.round(30 + sleepPerf * 0.55 - (prevStrain - 11) * 3 + (rand() - 0.5) * 30), 8, 99);
    const hrv = Math.round((38 + recovery * 0.42 + (rand() - 0.5) * 8) * 10) / 10;
    const rhr = Math.round(61 - recovery * 0.12 + (rand() - 0.5) * 3);
    const isToday = i === 0;
    const strain = isToday ? Math.round((4 + rand() * 6) * 10) / 10 : Math.round((6 + rand() * 11 + (recovery > 66 ? 2 : 0)) * 10) / 10;
    prevStrain = strain;
    const cycleEnd = isToday ? null : new Date(cycleStart.getTime() + 86_400_000 + (rand() - 0.5) * 3_600_000);

    cycles.push({
      id,
      start: cycleStart.toISOString(),
      end: cycleEnd ? cycleEnd.toISOString() : null,
      timezone_offset: tz,
      score_state: 'SCORED',
      score: { strain, kilojoule: Math.round(7000 + strain * 380 + rand() * 900), average_heart_rate: Math.round(62 + strain), max_heart_rate: Math.round(140 + strain * 2.6) },
      step_count: Math.round((isToday ? 2500 : 6000) + strain * 420 + rand() * 3000),
    });
    const sleepId = `demo-sleep-${id}`;
    const awake = (0.06 + rand() * 0.06) * sleepMs;
    const asleep = sleepMs - awake;
    const sws = asleep * (0.18 + rand() * 0.06);
    const rem = asleep * (0.2 + rand() * 0.07);
    sleeps.push({
      id: sleepId,
      cycle_id: id,
      start: cycleStart.toISOString(),
      end: sleepEnd.toISOString(),
      timezone_offset: tz,
      nap: false,
      score_state: 'SCORED',
      score: {
        stage_summary: {
          total_in_bed_time_milli: Math.round(sleepMs + 20 * 60_000),
          total_awake_time_milli: Math.round(awake),
          total_no_data_time_milli: 0,
          total_light_sleep_time_milli: Math.round(asleep - sws - rem),
          total_slow_wave_sleep_time_milli: Math.round(sws),
          total_rem_sleep_time_milli: Math.round(rem),
          sleep_cycle_count: 3 + Math.floor(rand() * 3),
          disturbance_count: Math.floor(rand() * 14),
        },
        sleep_needed: { baseline_milli: 27_900_000, need_from_sleep_debt_milli: Math.round(rand() * 2_400_000), need_from_recent_strain_milli: Math.round(rand() * 1_200_000), need_from_recent_nap_milli: 0 },
        respiratory_rate: Math.round((14.8 + rand() * 1.6) * 10) / 10,
        sleep_performance_percentage: sleepPerf,
        sleep_consistency_percentage: Math.round(62 + rand() * 30),
        sleep_efficiency_percentage: Math.round(((sleepMs - awake) / sleepMs) * 1000) / 10,
      },
    });
    recoveries.push({
      cycle_id: id,
      sleep_id: sleepId,
      score_state: 'SCORED',
      score: { user_calibrating: false, recovery_score: recovery, resting_heart_rate: rhr, hrv_rmssd_milli: hrv, spo2_percentage: Math.round((95 + rand() * 3.5) * 10) / 10, skin_temp_celsius: Math.round((33.4 + rand() * 1.2) * 100) / 100 },
    });
    if (!isToday && rand() < 0.62) {
      const sport = SPORTS[Math.floor(rand() * SPORTS.length)];
      const wStart = new Date(sleepEnd.getTime() + (2 + rand() * 9) * 3_600_000);
      const dur = (25 + rand() * 70) * 60_000;
      const wStrain = Math.round((5 + rand() * 11) * 10) / 10;
      const zones = [0.05, 0.2, 0.3, 0.25, 0.15, 0.05].map((f) => f * (0.6 + rand() * 0.8));
      const zsum = zones.reduce((a, b) => a + b, 0);
      const dist = ['Running', 'Cycling', 'Swimming'].includes(sport) ? Math.round(dur / 60_000 * (sport === 'Cycling' ? 420 : sport === 'Running' ? 170 : 40)) : null;
      workouts.push({
        id: `demo-workout-${id}`,
        sport_name: sport,
        start: wStart.toISOString(),
        end: new Date(wStart.getTime() + dur).toISOString(),
        timezone_offset: tz,
        score_state: 'SCORED',
        score: {
          strain: wStrain,
          average_heart_rate: Math.round(118 + wStrain * 3),
          max_heart_rate: Math.round(150 + wStrain * 2.5),
          kilojoule: Math.round(dur / 60_000 * (28 + rand() * 18)),
          percent_recorded: 100,
          distance_meter: dist,
          zone_durations: Object.fromEntries(['zero', 'one', 'two', 'three', 'four', 'five'].map((n, k) => [`zone_${n}_milli`, Math.round((zones[k] / zsum) * dur)])),
        },
      });
    }
  }

  const cutoff = now - (days + 1) * 86_400_000;
  const inRange = (r) => Date.parse(r.start) >= cutoff;
  const keepCycles = cycles.filter(inRange);
  const ids = new Set(keepCycles.map((c) => c.id));
  const payload = buildPayload({
    profile: { first_name: 'Sample', last_name: 'Member', email: 'sample@example.com' },
    body: { height_meter: 1.8, weight_kilogram: 78.4, max_heart_rate: 192 },
    cycles: keepCycles,
    recoveries: recoveries.filter((r) => ids.has(r.cycle_id)),
    sleeps: sleeps.filter((s) => ids.has(s.cycle_id)),
    workouts: workouts.filter(inRange),
    days,
    demo: true,
  });
  payload.days = payload.days.slice(-days);
  return payload;
}
