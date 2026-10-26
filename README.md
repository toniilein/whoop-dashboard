# WHOOP Dashboard

A local dashboard for your WHOOP data. It talks to the official WHOOP Developer
API (v2) and keeps your tokens on this computer.

No npm install needed. It runs on plain Node.js (20.12 or newer).

## Run it

```bash
npm start
```

Then open http://localhost:3000.

Click **Preview with sample data** to look around before connecting an account.

The range buttons show the last 7, 30 or 90 days, or **All time**. Over 120 days,
charts switch to weekly averages so each bar stays readable. Over three years they
switch to monthly averages. Tiles and subtitles always use daily values.

## What the dashboard shows

The page follows the WHOOP app: today's **Recovery**, **Strain** and **Sleep**
at the top, then five sections.

| Section | KPI tiles | Charts |
|---|---|---|
| Insights | HRV versus baseline, illness warning, training load ratio, average bedtime, average wake time, weekend shift | HRV versus baseline, illness warning signals, training load ratio, bedtime and wake time, year-over-year tables |
| Recovery and health monitor | HRV, resting heart rate, respiratory rate, blood oxygen, skin temperature | Recovery, HRV, resting heart rate, respiratory rate, blood oxygen, skin temperature |
| Sleep | Hours of sleep, sleep need, sleep debt, restorative sleep, performance, consistency, efficiency, time in bed, disturbances | Sleep stages, hours versus need, performance, consistency and efficiency |
| Strain and activity | Day strain, calories, steps, average heart rate, and for the last 7 days: workouts, HR zones 1–3, HR zones 4–5, strength activity | Day strain, steps, heart rate zone time, strength activity time |
| Fitness and Healthspan | VO2 max estimate, max heart rate, resting heart rate | VO2 max estimate, Healthspan inputs table, list of app-only metrics |

- **Comparisons:** each tile compares the latest value with the average for the
  selected range. Tiles marked "last 7 days" compare with the weekly average.
- **Trendlines:** every chart has a dashed least-squares trendline. The rate under
  the chart title is per week for ranges up to a month, per month up to a year,
  and per year beyond that. Today's unfinished strain and steps are left out of
  the trend.
- **VO2 max** is an estimate: 15.3 × max heart rate ÷ resting heart rate. WHOOP's
  own value uses a different method and is not in the API.
- **Healthspan inputs** are the nine metrics WHOOP uses for WHOOP Age. Eight can be
  derived from the API. Lean body mass and WHOOP Age itself cannot.
- **Heart rate zone time** only covers recorded activities, because the API has no
  all-day heart rate.
- **Strength activity** counts weightlifting, powerlifting, functional fitness and
  similar sports.

### How the insights are calculated

They always use your full history, whatever range you pick, so the baselines are
right even on the 7-day view. `lib/insights.js` holds the calculations.

- **HRV versus baseline:** your 7-day average HRV against a normal range. The
  range is the average of the 60 days before that week, plus or minus half a
  standard deviation.
- **Illness warning:** each night, resting heart rate, HRV, respiratory rate and
  skin temperature are compared with your previous 30 days. A signal counts as
  out of range when it is 1.5 standard deviations or more in the unhealthy
  direction. Two signals mean "watch" and three or four mean "warning". This is
  a heads-up, not a diagnosis.
- **Training load ratio:** the 7-day average training load divided by the 28-day
  average. Load is zone-weighted minutes from recorded activities (Edwards TRIMP):
  a minute in heart-rate zone 3 counts as 3. WHOOP strain is not used because it
  is logarithmic, which squeezes the ratio towards 1. The common guideline is
  0.8 to 1.3, and above 1.5 means a sharp jump in load.
- **Bedtime, wake time and weekend shift:** these use the main sleep of each
  night in the selected range. Regularity is the standard deviation night to night.
  The weekend shift compares the sleep midpoint of nights before Saturday and
  Sunday with the other nights.
- **Year over year:** the last 30 days against the same 30 days a year earlier,
  plus averages for each calendar year.

Not available through the API, so not shown: WHOOP Age and Pace of Aging,
WHOOP's VO2 max value, Stress Monitor, strain target, Strength Trainer muscular
load, journal and behaviors, lean body mass, blood pressure and ECG.

## Redirect URL

WHOOP only sends the login back to URLs registered for your app. This app has
`http://localhost:3000/` registered, and `.env` uses the same value. The two must
match exactly, including the trailing slash. The server handles the login
callback on the page itself.

If you change the registered URL, update `WHOOP_REDIRECT_URI` in `.env` and restart.
The connect screen warns you when WHOOP does not accept the configured URL.

To log in without a localhost URL, register `https://whoop.com`, set
`WHOOP_REDIRECT_URI=https://whoop.com` and restart. After approving access you
land on whoop.com. Paste that tab's full address into the dashboard to finish.

## Export all your data

Log in through the dashboard first, then run:

```bash
npm run export
```

This pulls your whole WHOOP history, not just the last 90 days, into
`exports/whoop-export-<date>_<time>/`:

| File | Contents |
|---|---|
| `daily.csv` | One row per day: recovery, HRV, resting HR, SpO2, skin temp, strain, calories, sleep stages, sleep scores, workouts |
| `csv/*.csv` | Every field of every cycle, recovery, sleep and workout record, flattened |
| `raw/*.json` | The untouched API responses, including profile and body measurements |
| `summary.json` | Record counts, date range, averages, personal bests and workouts by sport |

The export paces itself to about 85 requests a minute and retries when WHOOP
throttles it. About 2.7 years of history took two minutes.

To regenerate the CSVs and summary from a previous export without calling WHOOP:

```bash
npm run export -- --rebuild exports/whoop-export-<date>_<time>
```

Some activities, such as sauna sessions, are marked scored but carry no score.
Their strain and heart-rate columns are empty. Step counts start in September 2024.

`exports/` is gitignored because it holds personal health data.

The WHOOP API does not offer continuous heart rate, journal entries, stress
monitor data or Healthspan, so those are not in the export.

## About the "sandbox"

WHOOP has no separate sandbox server or fake accounts. New apps start on the
**Sandbox tier**, which uses the real API but allows at most 10 WHOOP members to
connect. You log in with a real WHOOP account and see real data.

## Configuration (`.env`)

| Variable | Meaning |
|---|---|
| `WHOOP_CLIENT_ID` | Your app's client ID |
| `WHOOP_CLIENT_SECRET` | Your app's client secret (server side only) |
| `WHOOP_REDIRECT_URI` | Must match a registered redirect URL exactly, here `http://localhost:3000/` |
| `PORT` | Local port, default 3000 |

## How it works

- `server.js` serves the page and handles login, logout and the data API.
- `lib/whoop.js` handles OAuth. It requests the `offline` scope so it gets a refresh
  token, and refreshes the access token automatically. Only one refresh runs at a
  time, because WHOOP invalidates the old refresh token on every refresh.
- `lib/dashboard.js` pages through cycles, recovery, sleep and workouts for the
  chosen range. It attaches each night's recovery and sleep to its day.
- `lib/demo.js` generates the sample data.
- `lib/export.js` and `export.js` run the full-history export.
- `lib/history.js` caches your full history in `data/history.json` for the All time
  view. The first load seeds it from your newest export, or downloads everything if
  there is none. After that it re-fetches only the last week, at most once a minute,
  or when you click **Refresh**.
- `public/` holds the page, styles and the dependency-free SVG charts.

Data is cached for 60 seconds per range. **Refresh** bypasses the cache. WHOOP
allows 100 requests a minute, and a 90-day load uses about 20.

## Privacy and security

- The server listens on 127.0.0.1 only and rejects requests for any other host name.
- Tokens are stored in `data/tokens.json` with owner-only permissions.
- `.env` and `data/` are gitignored.
- **Log out** deletes the stored tokens and the cached history. Files in `exports/` stay. To revoke the app's access completely,
  remove it in the WHOOP app's settings.
- Anyone using this computer can open the dashboard while you are logged in.
