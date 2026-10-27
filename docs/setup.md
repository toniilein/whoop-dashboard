# Setup

This guide takes you from a fresh clone to your own data on screen, in about ten
minutes. You need:

- [Node.js](https://nodejs.org) 20.12 or newer. Check with `node --version`.
- A WHOOP membership and the account you use in the WHOOP app.

Want to look around first? Run `npm start` and click **Preview with sample data**.
That works without any WHOOP setup.

## 1. Create a WHOOP developer app

WHOOP only lets apps it knows about read your data, so everyone creates their own
small developer app. It's free and takes a few minutes.

1. Sign in to the [WHOOP Developer Dashboard](https://developer-dashboard.whoop.com)
   with your WHOOP account.
2. Create an app and fill in its details:

   | Field | What to enter |
   |---|---|
   | Name | Anything you like. WHOOP shows it when you approve access. |
   | Contacts | Your email address. |
   | Privacy policy | A URL, if the form asks for one. For an app only you use, you can link to this project's [privacy notes](../README.md#privacy-and-security). |
   | Redirect URLs | `http://localhost:3000/`, exactly like this, **with** the trailing slash. |
   | Scopes | `read:recovery`, `read:cycles`, `read:workout`, `read:sleep`, `read:profile` and `read:body_measurement`. |

3. Copy the app's **Client ID** and **Client Secret**. Treat the secret like a
   password.

During login the dashboard also asks for offline access. That gives it a refresh
token, so it stays connected without asking you to log in every hour.

### About the Sandbox tier

WHOOP has no separate sandbox server and no fake accounts. New apps start on the
**Sandbox tier**, which uses the real API but allows at most 10 WHOOP members to
connect. You log in with your real WHOOP account and see your real data. For a
personal dashboard you never need more. WHOOP's
[app approval guide](https://developer.whoop.com/docs/developing/app-approval/)
explains the higher tiers.

## 2. Configure the dashboard

```bash
cp .env.example .env
```

Open `.env` and fill in your values:

| Variable | Meaning |
|---|---|
| `WHOOP_CLIENT_ID` | Your app's client ID |
| `WHOOP_CLIENT_SECRET` | Your app's client secret. It stays on the server and never reaches the browser. |
| `WHOOP_REDIRECT_URI` | Must match a redirect URL registered for your app exactly: `http://localhost:3000/` |
| `PORT` | Local port, default 3000. If you change it, change the redirect URL to match. |

`.env` is gitignored, so it can't be committed by accident.

## 3. Start it and connect

```bash
npm start
```

Open http://localhost:3000 and click **Connect WHOOP**. WHOOP asks you to log in and
approve access, then sends you back to the dashboard.

The first load downloads your whole history, because the insights compare each day
with your personal baseline. A few years of data takes a minute or two. After that
the dashboard only fetches the last week, at most once a minute, or when you click
**Refresh**. The history cache lives in `data/history.json`.

For development, `npm run dev` restarts the server whenever a file changes.

## Using it

- **Ranges:** 7, 30 or 90 days, or **All time**. Over 120 days the charts show weekly
  averages so each bar stays readable, and over three years they show monthly
  averages. Tiles and subtitles always use daily values.
- **Views:** **Dashboard** shows every section. **Cockpit** shows only the cards you
  picked. See the [cockpit guide](cockpit.md).
- **Theme:** the picker in the top bar switches between System, Light and Dark.
- **Tables:** every chart has a **Show table** link with the numbers behind it.
- **Log out** deletes the stored login and the cached history. Files in `exports/`
  stay.

## Logging in without a localhost redirect

If you can't register a localhost URL, register `https://whoop.com` as the redirect
URL instead. Set `WHOOP_REDIRECT_URI=https://whoop.com` in `.env` and restart. After
you approve access you land on whoop.com. Copy that tab's full address and paste it
into the dashboard to finish logging in.

## Troubleshooting

**The connect screen says WHOOP doesn't accept the redirect URL.** The URL in `.env`
must match the one registered for your app character for character. The most
common mistake is a missing or extra trailing slash.

**The console says "Missing WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET".** The server
didn't find your credentials. Check that `.env` sits next to `server.js` and that
the variable names are spelled exactly as in `.env.example`.

**Port 3000 is already in use.** Another program is using the port. Find it with the
command below, then stop it. Or pick another port: set `PORT` and
`WHOOP_REDIRECT_URI` in `.env`, and register the new redirect URL with WHOOP.

```bash
lsof -i :3000
```

**The dashboard asks you to connect again.** WHOOP replaces the refresh token every
time it's used, and a token stops working if you revoke access in the WHOOP app.
Click **Connect WHOOP** again.

**Requests fail with "429 Too Many Requests".** WHOOP allows 100 requests a minute
and 10,000 a day per app. A normal load uses far fewer, and the export paces itself.
Wait a minute and click **Refresh**.

**`process.loadEnvFile is not a function`.** Your Node.js is older than 20.12.
Update Node.js.

**Some numbers are missing.** The WHOOP API only shares what it has scored. Workouts
without a score, nights without a recovery, and days you didn't wear the strap show
as gaps. Steps only appear for days WHOOP counted them; in the author's data
they start in September 2024.
