# Discord Presence Bot

A Discord bot built with **Python**, **discord.py**, and **SQLite** to track **future member presence changes** and **server channel activity**, then generate activity analytics over time.

> **Important:** Discord does **not** provide historical presence data. This bot only records events after **it has been configured and started**.

---

## Features

- Track member presence changes:
  - Online
  - Idle
  - Do Not Disturb
  - Offline
- Log future activity events while the bot is running
- Log selected server channel activity
- Store logs in SQLite
- View activity statistics with slash commands
- Export logs to CSV
- Generate activity summaries and charts
- Optional local dashboard via `dashboard.html`
- Optional API/web view via `api_server.py`
- Optional **Invisible mode** so the bot appears offline while still collecting data

---

## What This Bot Tracks

This project is built to monitor **future** server activity only.

### Presence events
- Offline -> Online
- Online -> Idle
- Idle -> Offline
- DND -> Online

### Channel activity
Depending on your enabled handlers in `bot.py`, the bot can also log:
- Messages
- Reactions
- Voice state changes
- Other server-side activity events you added

Presence updates require the correct privileged intents and `discord.py` intent configuration.

---

## Tech Stack

- Python 3.11+
- discord.py 2.x
- SQLite
- Matplotlib
- Pandas

---

## Requirements

Before running the bot, make sure you have:

- Python 3.11+
- A Discord bot application
- A Discord bot token
- A server where you can add the bot
- Privileged intents enabled in the Discord Developer Portal

### Required Discord Intents

Enable these in **Discord Developer Portal -> Bot -> Privileged Gateway Intents**:

- **Presence Intent**
- **Server Members Intent**

These are required for receiving presence updates and member-related events.

If your bot also depends on message content logging commands, you may also need **Message Content Intent**, depending on your implementation.

---

## Project Structure

```text
.
├── bot.py
├── api_server.py
├── dashboard.html
├── requirements.txt
├── Procfile
├── .gitignore
└── exports/
```

### File overview

- `bot.py` -> main Discord bot
- `api_server.py` -> optional local/hosted API layer for dashboard data
- `dashboard.html` -> static dashboard UI
- `requirements.txt` -> Python dependencies
- `Procfile` -> Railway process definition
- `exports/` -> exported charts / CSV files

---

## Installation

Clone the repository:

```bash
git clone https://github.com/harshsingh0930/Presence-bot.git
cd Presence-bot
```

Create a virtual environment:

### Windows
```bash
python -m venv .venv
.venv\Scripts\activate
```

### Linux / macOS
```bash
python -m venv .venv
source .venv/bin/activate
```

Install dependencies:

```bash
pip install -r requirements.txt
```

---

## Configuration

Create a local `.env` file:

```env
DISCORD_TOKEN=YOUR_BOT_TOKEN
```

Make sure `.env` is listed in `.gitignore` and never pushed to GitHub.

---

## Running Locally

Start the bot:

```bash
python bot.py
```

If everything is configured correctly, the console should show startup logs such as:
- database initialized
- Discord login successful
- gateway connected
- slash commands synced

---

## 24/7 Monitoring

For continuous activity tracking, run the bot on a system that stays online all the time, such as:

- A VPS
- A cloud VM
- A home server
- A hosting provider that supports long-running Python processes
- Free options such as Railway or Render

If the bot is offline, events during that time will not be recorded.

---

## Slash Commands

Your exact command set depends on the current `bot.py`, but the project supports commands such as:

- `/activity @user` -> show activity statistics for a user
- `/heatmap @user` -> generate an hourly activity heatmap
- `/daily-chart @user` -> generate daily activity charts
- `/top-active` -> show most active users
- `/export-csv` -> export collected data
- `/bot-status` -> check bot health/status
- `/setup` -> configure logging/report channel
- `/privacy` -> opt-in / opt-out related controls if enabled

---

## Database

SQLite is used by default.

Typical stored data includes:
- user ID
- guild ID
- username
- old status
- new status
- timestamp
- date
- hour
- activity/event metadata

### Important

Make sure all required tables are created in `init_db()` before the bot starts processing events. If a table such as `optouts` is queried before being created, SQLite will raise a `no such table` error.

---

## Invisible Mode

If you want the bot to keep running but appear offline, add this inside `on_ready()`:

```python
await bot.change_presence(status=discord.Status.invisible)
```

This lets the bot continue working while appearing offline in Discord.

---

## Dashboard

This project includes a dashboard frontend:

- `dashboard.html` -> static UI
- `api_server.py` -> optional backend/API for serving dashboard data

### Local dashboard options

#### Option 1: Open the HTML directly
Open `dashboard.html` in your browser.

#### Option 2: Use VS Code Live Server
Right-click `dashboard.html` -> **Open with Live Server**

#### Option 3: Run the API server
```bash
python api_server.py
```

Use this if your dashboard expects live API data instead of static file-only viewing.

---

## Limitations

- Discord does **not** provide historical presence data.
- Presence is recorded only while the bot is online.
- If the bot goes offline, events during downtime are lost.

---

## Common Issues

### Bot logs in but presence tracking does not work
Check:
- Presence Intent enabled
- Server Members Intent enabled
- `intents.presences = True`
- `intents.members = True`

### `sqlite3.OperationalError: no such table`
A required table was not created in `init_db()` before being queried.

### Bot looks online when you want it hidden
Use:

```python
await bot.change_presence(status=discord.Status.invisible)
```

Also make sure you are not running multiple instances of the same bot token at the same time.

### Dashboard not opening properly
Try:
- opening `dashboard.html` directly
- using Live Server
- running `python api_server.py`

---

## Roadmap

- Better daily / weekly / monthly reports
- Improved charts and summaries
- Timezone-aware analytics
- Better channel activity breakdown
- Role-based analytics
- Multi-guild configuration improvements
- Persistent storage improvements
- Full hosted dashboard

---

## Security Notes

- Never commit your bot token
- Keep `.env` in `.gitignore`
- If a token is exposed, reset it immediately in the Discord Developer Portal
- Avoid sharing raw presence logs publicly without server member awareness

Presence data can reveal user activity patterns, so handle it responsibly.

---

## License

MIT License
