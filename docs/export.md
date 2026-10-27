# Export your data

One command saves your whole WHOOP history as spreadsheet-friendly CSV files and the
untouched API responses. Use it for your own analysis, a backup, or to take your data
somewhere else.

Connect through the dashboard first, so the export can use your login. Then run:

```bash
npm run export
```

The export lands in `exports/whoop-export-<date>_<time>/`:

| File | Contents |
|---|---|
| `daily.csv` | One row per day: recovery, HRV, resting heart rate, SpO2, skin temperature, strain, calories, sleep stages, sleep scores and workouts |
| `csv/*.csv` | Every field of every cycle, recovery, sleep and workout record, flattened into columns |
| `raw/*.json` | The untouched API responses, including your profile and body measurements |
| `summary.json` | Record counts, date range, averages, personal bests and workouts by sport |

The export paces itself to about 85 requests a minute and retries when WHOOP slows
it down. About three years of history takes two minutes. The dashboard also uses
your newest export to seed its history cache, so it doesn't have to download
everything again.

## Rebuilding from a previous export

To regenerate the CSV files and the summary from an earlier export without calling
WHOOP, pass its folder:

```bash
npm run export -- --rebuild exports/whoop-export-<date>_<time>
```

## Good to know

- `exports/` is gitignored, because it holds personal health data. Don't attach
  these files to issues.
- Some activities, such as sauna sessions, are marked as scored but carry no score.
  Their strain and heart-rate columns are empty.
- Steps only appear for days WHOOP counted them. In the author's data they start in
  September 2024.
- The WHOOP API doesn't offer continuous heart rate, journal entries, Stress Monitor
  data or Healthspan, so those aren't in the export.
