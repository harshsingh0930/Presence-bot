# Discord Presence Bot

A Discord activity tracker with a dashboard for presence changes, messages, reactions, voice events, and member reports. Python and SQLite handle collection; the frontend runs on Vercel.

[Live dashboard](https://presence-bot-chi.vercel.app/) · [Bot setup and commands](docs/BOT_GUIDE.md)

<a href="docs/dashboard-preview.png">
  <img src="docs/dashboard-preview.png" alt="Presence dashboard showing illustrative sample data" width="720">
</a>

*Preview uses sample data. Click the image for full size.*

## Features

- Community overview with activity charts, status breakdowns, and a heatmap.
- Searchable members, individual reports, channel analytics, and an activity log.
- Date filters in UTC or IST, CSV/JSON exports, and printable reports.
- Automatic refresh every 30 seconds while the dashboard tab is visible.

## Run locally

Follow the [bot guide](docs/BOT_GUIDE.md) to install dependencies, configure Discord, and start collecting activity. In a second terminal, run:

```sh
python api_server.py
```

Open [localhost:5000](http://localhost:5000). By default, the API reads `presence.db` beside the script. For a sample preview, open [localhost:5000/?demo=1](http://localhost:5000/?demo=1).

## Deploy

**Railway runs the bot and API against one persistent SQLite database. Vercel serves the frontend.**

### Railway

Keep both Python processes in the same service. Mount a volume at `/data` and use these variables:

| Variable | Value |
| --- | --- |
| `DISCORD_TOKEN` | Your Discord bot token |
| `HOST` | `0.0.0.0` |
| `PORT` | `8080` |
| `PRESENCE_DB_PATH` | `/data/presence.db` |
| `DASHBOARD_ORIGIN` | Your Vercel origin, without a trailing slash |
| `DASHBOARD_API_TOKEN` | A separate, long random dashboard token |

Back up an existing database before changing its location. Place it at `/data/presence.db` and set the Start Command to:

```sh
sh -c 'cd /data || exit 1; python -u /app/api_server.py & exec python -u /app/bot.py'
```

The working directory matters: the bot writes `presence.db` relative to it; `PRESENCE_DB_PATH` configures the API only. Generate a public Railway domain targeting port `8080`.

### Vercel

Import this repository with preset **Other** and the repository root. The included `vercel.json` sets the build command to `npm run build` and output directory to `dist`; no dependency install is needed.

Set `PRESENCE_API_URL` to your Railway HTTPS origin, without `/api`. Optionally set `PRESENCE_SERVER_NAME`. Redeploy after changing either build variable. Only the six frontend files are published.

Open **Connection settings** in the dashboard, confirm the API address, and enter your dashboard token. Tokens stay in the browser tab's session storage; never put them in frontend source or build variables. A fresh browser session needs its own token.

If connection fails, check that both Python processes are running, the domain port matches `PORT`, and `DASHBOARD_ORIGIN` matches the Vercel origin exactly. An unauthenticated `/api/meta` request should return **401** when token protection is enabled.

## Data notes

The bot records activity while running. Discord does not provide historical presence data. Estimated active time comes from observed transitions and caps continuous sessions at six hours; displayed statuses are the latest observations, not a live headcount. API reads respect member opt-outs.

## Checks

```sh
npm test
python -m unittest discover -s tests -p "test_*.py"
npm run build
```

Tests use temporary data. Local databases, credentials, exports, and build output are excluded from Git.

MIT License.
