// Fetches WHOOP v2 data for a date range and joins it into one dashboard payload.

function offsetMinutes(tz) {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(tz || '');
  if (!m) return 0;
  const mins = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -mins : mins;
}

// A WHOOP cycle starts around sleep onset. Shifting its local start by 12h lands on the
// calendar day the member woke up, which is how the WHOOP app labels the day.
function cycleDay(start, tz) {
  const t = Date.parse(start) + offsetMinutes(tz) * 60_000 + 12 * 3_600_000;
  return new Date(t).toISOString().slice(0, 10);
}

function localDate(ts, tz) {
  return new Date(Date.parse(ts) + offsetMinutes(tz) * 60_000).toISOString();
}

const scored = (r) => r && r.score_state === 'SCORED' && r.score;

function normalizeSleep(s) {
  const sc = scored(s) ? s.score : null;
  const st = sc?.stage_summary || {};
  const need = sc?.sleep_needed || {};
  return {
    id: s.id,
    start: s.start,
    // member's wall-clock bed and wake times (ISO without offset)
    startLocal: s.start ? localDate(s.start, s.timezone_offset).slice(0, 19) : null,
    endLocal: s.end ? localDate(s.end, s.timezone_offset).slice(0, 19) : null,
    end: s.end,
    nap: Boolean(s.nap),
    scored: Boolean(sc),
    performance: sc?.sleep_performance_percentage ?? null,
    efficiency: sc?.sleep_efficiency_percentage ?? null,
    consistency: sc?.sleep_consistency_percentage ?? null,
    respiratoryRate: sc?.respiratory_rate ?? null,
    inBedMs: st.total_in_bed_time_milli ?? null,
    awakeMs: st.total_awake_time_milli ?? null,
    lightMs: st.total_light_sleep_time_milli ?? null,
    swsMs: st.total_slow_wave_sleep_time_milli ?? null,
    remMs: st.total_rem_sleep_time_milli ?? null,
    sleepCycles: st.sleep_cycle_count ?? null,
    disturbances: st.disturbance_count ?? null,
    debtMs: sc ? need.need_from_sleep_debt_milli ?? null : null,
    neededMs: sc
      ? (need.baseline_milli || 0) +
        (need.need_from_sleep_debt_milli || 0) +
        (need.need_from_recent_strain_milli || 0) +
        (need.need_from_recent_nap_milli || 0)
      : null,
  };
}

export function buildPayload({ profile, body, cycles, recoveries, sleeps, workouts, days, demo = false }) {
  const recoveryByCycle = new Map();
  for (const r of recoveries) recoveryByCycle.set(String(r.cycle_id), r);

  // Main (non-nap) sleep per cycle; if several, keep the longest.
  const sleepByCycle = new Map();
  const napsByCycle = new Map();
  for (const s of sleeps) {
    const key = String(s.cycle_id);
    if (s.nap) {
      napsByCycle.set(key, (napsByCycle.get(key) || 0) + 1);
      continue;
    }
    const prev = sleepByCycle.get(key);
    const len = Date.parse(s.end) - Date.parse(s.start);
    if (!prev || len > Date.parse(prev.end) - Date.parse(prev.start)) sleepByCycle.set(key, s);
  }

  const dayRows = cycles
    .map((c) => {
      const key = String(c.id);
      const rec = recoveryByCycle.get(key);
      const sl = sleepByCycle.get(key);
      const cs = scored(c) ? c.score : null;
      const rs = scored(rec) ? rec.score : null;
      return {
        cycleId: c.id,
        date: cycleDay(c.start, c.timezone_offset),
        start: c.start,
        end: c.end,
        inProgress: !c.end,
        strain: cs?.strain ?? null,
        kilojoule: cs?.kilojoule ?? null,
        avgHr: cs?.average_heart_rate ?? null,
        maxHr: cs?.max_heart_rate ?? null,
        steps: c.step_count ?? cs?.step_count ?? null,
        recovery: rs
          ? {
              score: rs.recovery_score ?? null,
              rhr: rs.resting_heart_rate ?? null,
              hrv: rs.hrv_rmssd_milli ?? null,
              spo2: rs.spo2_percentage ?? null,
              skinTemp: rs.skin_temp_celsius ?? null,
              calibrating: Boolean(rs.user_calibrating),
            }
          : null,
        sleep: sl ? normalizeSleep(sl) : null,
        naps: napsByCycle.get(key) || 0,
      };
    })
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  const workoutRows = workouts
    .map((w) => {
      const sc = scored(w) ? w.score : null;
      const z = sc?.zone_durations || {};
      return {
        id: w.id,
        sport: w.sport_name || 'Activity',
        start: w.start,
        end: w.end,
        localStart: localDate(w.start, w.timezone_offset),
        durationMs: Date.parse(w.end) - Date.parse(w.start),
        strain: sc?.strain ?? null,
        avgHr: sc?.average_heart_rate ?? null,
        maxHr: sc?.max_heart_rate ?? null,
        kilojoule: sc?.kilojoule ?? null,
        distanceMeter: sc?.distance_meter ?? null,
        altitudeGainMeter: sc?.altitude_gain_meter ?? null,
        zonesMs: sc
          ? [
              z.zone_zero_milli || 0,
              z.zone_one_milli || 0,
              z.zone_two_milli || 0,
              z.zone_three_milli || 0,
              z.zone_four_milli || 0,
              z.zone_five_milli || 0,
            ]
          : null,
      };
    })
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start));

  return {
    demo,
    generatedAt: new Date().toISOString(),
    rangeDays: days,
    profile: profile
      ? { firstName: profile.first_name || '', lastName: profile.last_name || '', email: profile.email || '' }
      : null,
    body: body
      ? { heightMeter: body.height_meter ?? null, weightKg: body.weight_kilogram ?? null, maxHr: body.max_heart_rate ?? null }
      : null,
    days: dayRows,
    workouts: workoutRows,
  };
}

export async function fetchDashboard(client, days) {
  const end = new Date();
  // One extra day so the earliest cycle in range still has its sleep and recovery.
  const start = new Date(end.getTime() - (days + 1) * 86_400_000);
  const range = { start: start.toISOString(), end: end.toISOString() };

  const [profile, body, cycles, recoveries, sleeps, workouts] = await Promise.all([
    client.get('/v2/user/profile/basic'),
    client.get('/v2/user/measurement/body'),
    client.getAll('/v2/cycle', range),
    client.getAll('/v2/recovery', range),
    client.getAll('/v2/activity/sleep', range),
    client.getAll('/v2/activity/workout', range),
  ]);

  const payload = buildPayload({ profile, body, cycles, recoveries, sleeps, workouts, days });
  // Trim to the requested number of days (the extra day was only for joins).
  payload.days = payload.days.slice(-days);
  return payload;
}
