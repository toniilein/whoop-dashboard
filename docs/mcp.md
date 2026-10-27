# Ask Claude about your data (MCP server)

`mcp.js` is a [Model Context Protocol](https://modelcontextprotocol.io) server. It
gives Claude Desktop, Claude Code or any other MCP client read access to your full
local history and every computed insight. Then you can simply ask:

- "How did I sleep this week compared with last week?"
- "How has my HRV trended since the summer, and is that good?"
- "Which nights did I sleep under six hours, and what happened to my recovery the
  next day?"
- "Do my late workouts hurt my sleep?"
- "Give me my morning briefing."
- "Compare October with the same month last year."

## Set it up

The MCP server reuses the dashboard's login and history cache. So
[set up the dashboard](setup.md) and connect WHOOP there once. Then install the MCP
server's two dependencies:

```bash
npm install
```

### Claude Code

Register the server once for all your projects:

```bash
claude mcp add --scope user whoop -- node /absolute/path/to/whoop-dashboard/mcp.js
```

Check that it shows as connected:

```bash
claude mcp list
```

### Claude Desktop

Add this to `claude_desktop_config.json`, then restart Claude Desktop. On macOS the
file is in `~/Library/Application Support/Claude/`, and on Windows in
`%APPDATA%\Claude\`.

```json
{
  "mcpServers": {
    "whoop": {
      "command": "node",
      "args": ["/absolute/path/to/whoop-dashboard/mcp.js"]
    }
  }
}
```

If Claude Desktop can't find `node`, replace `"node"` with the full path that
`which node` prints.

### Other MCP clients

Any client that can start a local stdio server works. The command is `node` with
the absolute path to `mcp.js` as its only argument.

## What it offers

### Tools

| Tool | What it answers |
|---|---|
| `whoop_today` | Today's recovery, strain, sleep, all current insights, recent workouts and warning flags |
| `whoop_history` | Daily, weekly or monthly values of any of 36 metrics over a period |
| `whoop_trend` | The direction and rate of change of one metric, and whether that is good or bad |
| `whoop_compare` | Two periods side by side, including the same period last year |
| `whoop_workouts` | Workouts in a period with heart-rate zones, plus totals by sport and by time of day |
| `whoop_find_days` | Days where a metric was below, above or between values, or the lowest or highest |
| `whoop_status` | The connection state and what the cache covers |
| `whoop_sync` | Fetch the latest data from WHOOP now. Other tools already sync at most once a minute. |

All tools are read-only.

### Resources

| Resource | Contents |
|---|---|
| `whoop://summary` | Today, yesterday, current insights and flags |
| `whoop://methods` | How every metric is calculated, with thresholds and sources |
| `whoop://day/{date}` | Everything recorded for one day, for example `whoop://day/2026-10-20` |

### Prompts

| Prompt | What it does |
|---|---|
| `morning_briefing` | A short, honest read of today's recovery, sleep and warning signs, with one suggestion for the day |
| `weekly_review` | The last 7 days against the previous 7, workouts and sleep timing, and one experiment for next week |
| `explain_metric` | How one computed metric works and what your current value means |

### Periods

Tools that take a period accept:

- presets: `last_7_days`, `last_30_days`, `last_90_days`, `last_365_days`, `all_time`
- relative periods: `previous_7_days`, `previous_30_days`, `previous_90_days`,
  `same_period_last_year`
- a day (`2026-10-01`), a month (`2026-10`), a year (`2026`) or a range
  (`2026-10-01..2026-10-14`)

Long periods are averaged per week or per month, so answers stay compact.

### Metrics

Recovery and health: `recovery`, `hrv`, `rhr`, `spo2`, `skin_temp`, `resp_rate`.

Strain and activity: `strain`, `calories`, `steps`, `avg_hr`, `max_hr`.

Sleep: `sleep_hours`, `time_in_bed`, `sleep_need`, `sleep_debt`,
`sleep_performance`, `sleep_consistency`, `sleep_efficiency`, `deep_hours`,
`rem_hours`, `light_hours`, `awake_hours`, `restorative_hours`, `disturbances`,
`naps`, `bedtime`, `wake_time`.

Insights: `hrv_7day`, `hrv_baseline_low`, `hrv_baseline_high`, `hrv_cv`, `sri`,
`steps_7day`, `training_load`, `acwr`, `illness_signals`.

The [metrics guide](metrics.md) explains how each insight is calculated.

## Privacy

The MCP server runs on your computer and reads only the local cache. What leaves
your machine is whatever your MCP client sends to its model provider: the tool
results you ask for, not your raw history. The dashboard and the MCP server share
the WHOOP login safely, because a lock file stops them refreshing the token at the
same moment.

## Troubleshooting

**Tools answer "Not connected to WHOOP".** Open the dashboard and click **Connect
WHOOP**. The MCP server picks up the login on the next call.

**The server doesn't start.** Run `npm install` in the project folder, and check that
the path in your client's settings is absolute and points to `mcp.js`.

**Answers seem out of date.** Ask Claude to sync, which runs `whoop_sync`.
