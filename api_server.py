"""Read-only dashboard API. Run beside the bot with `python api_server.py`."""

import hmac
import json
import mimetypes
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("PRESENCE_DB_PATH", str(ROOT / "presence.db")))
PORT = int(os.environ.get("PORT", "5000"))
MAX_ROWS = 100_000
STATIC_FILES = {"/": "dashboard.html", "/dashboard.html": "dashboard.html"}
for name in ("app.js", "data.js", "config.js", "dashboard.css", "favicon.svg"):
    STATIC_FILES[f"/assets/{name}"] = f"assets/{name}"


def db():
    conn = sqlite3.connect(DB_PATH.resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    return conn


def serialize(row):
    return {key: str(value) if value is not None and (key == "id" or key.endswith("_id"))
            else value for key, value in dict(row).items()}


def rows(conn, table, guild=None, start=None, end=None, limit=None, descending=False):
    where = ["NOT EXISTS (SELECT 1 FROM optouts o WHERE o.guild_id=t.guild_id AND o.user_id=t.user_id)"]
    args = []
    if guild:
        where.append("t.guild_id=?")
        args.append(guild)
    if start:
        where.append("julianday(t.timestamp)>=julianday(?)")
        args.append(start)
    if end:
        where.append("julianday(t.timestamp)<julianday(?)")
        args.append(end)
    direction = "DESC" if descending else "ASC"
    sql = f"SELECT t.* FROM {table} t WHERE {' AND '.join(where)} ORDER BY t.timestamp {direction},t.id {direction}"
    if limit is not None:
        sql += " LIMIT ?"
        args.append(limit)
    return [serialize(r) for r in conn.execute(sql, args)]


def metadata(conn, guild=None):
    names = json.loads(os.environ.get("DASHBOARD_GUILD_NAMES", "{}"))
    guilds = conn.execute("""SELECT guild_id FROM tracked_guilds UNION
        SELECT guild_id FROM presence_logs UNION SELECT guild_id FROM channel_logs""").fetchall()
    scope = "AND guild_id=?" if guild else ""
    timestamps = conn.execute(f"""SELECT MIN(timestamp), MAX(timestamp) FROM (
        SELECT p.timestamp FROM presence_logs p WHERE NOT EXISTS
        (SELECT 1 FROM optouts o WHERE o.guild_id=p.guild_id AND o.user_id=p.user_id) {scope}
        UNION ALL SELECT c.timestamp FROM channel_logs c WHERE NOT EXISTS
        (SELECT 1 FROM optouts o WHERE o.guild_id=c.guild_id AND o.user_id=c.user_id) {scope})""",
        [guild, guild] if guild else []).fetchone()
    return {"version": 1, "generated_at": datetime.now(timezone.utc).isoformat(),
            "guilds": [{"id": str(r[0]), "name": names.get(str(r[0]), f"Server · {str(r[0])[-6:]}")}
                       for r in guilds], "first_event": timestamps[0], "last_event": timestamps[1]}


def snapshot(conn, qs):
    guild = qs.get("guild_id", [None])[0]
    if guild is not None and (not guild.isdigit() or len(guild) > 20):
        raise ValueError("guild_id must be a Discord server ID")
    bounds = {}
    for key in ("from", "to"):
        value = qs.get(key, [None])[0]
        if value:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                raise ValueError("Date boundaries must include a timezone")
            bounds[key] = parsed.astimezone(timezone.utc)
    if bounds.get("from") and bounds.get("to") and bounds["from"] >= bounds["to"]:
        raise ValueError("The start of the range must precede its end")
    start = (bounds["from"] - timedelta(hours=6)).isoformat() if "from" in bounds else None
    end = bounds["to"].isoformat() if "to" in bounds else None
    presence = rows(conn, "presence_logs", guild, start, end, MAX_ROWS + 1)
    if start:
        # A pre-context state prevents an already-capped online/DND run from
        # restarting when its first transition falls outside the six-hour context.
        scope = "AND p.guild_id=?" if guild else ""
        prior = conn.execute(f"""SELECT * FROM (SELECT p.*,
            ROW_NUMBER() OVER (PARTITION BY guild_id,user_id ORDER BY timestamp DESC,id DESC) rn
            FROM presence_logs p WHERE julianday(timestamp)<julianday(?) {scope}
            AND NOT EXISTS (SELECT 1 FROM optouts o WHERE o.guild_id=p.guild_id AND o.user_id=p.user_id))
            WHERE rn=1 LIMIT ?""", [start, *([guild] if guild else []), MAX_ROWS + 1]).fetchall()
        presence = [{k: v for k, v in serialize(row).items() if k != 'rn'} for row in prior] + presence
    channels = rows(conn, "channel_logs", guild, bounds["from"].isoformat() if "from" in bounds else None,
                    end, MAX_ROWS + 1)
    if len(presence) + len(channels) > MAX_ROWS:
        raise OverflowError("This range exceeds 100,000 events. Choose a shorter date range.")
    args = [guild] if guild else []
    scope = "AND e.guild_id=?" if guild else ""
    members = conn.execute(f"""WITH events AS (
        SELECT guild_id,user_id,username,timestamp,new_status FROM presence_logs
        UNION ALL SELECT guild_id,user_id,username,timestamp,NULL FROM channel_logs
    ), ranked AS (
        SELECT e.*,ROW_NUMBER() OVER (PARTITION BY guild_id,user_id ORDER BY timestamp DESC) rn
        FROM events e WHERE NOT EXISTS
        (SELECT 1 FROM optouts o WHERE o.guild_id=e.guild_id AND o.user_id=e.user_id) {scope}
    ), statuses AS (
        SELECT guild_id,user_id,new_status,timestamp,
        ROW_NUMBER() OVER (PARTITION BY guild_id,user_id ORDER BY timestamp DESC,id DESC) rn
        FROM presence_logs
    ) SELECT r.guild_id,r.user_id,r.username,r.timestamp last_seen,
        s.new_status status,s.timestamp status_at FROM ranked r LEFT JOIN statuses s
        ON r.guild_id=s.guild_id AND r.user_id=s.user_id AND s.rn=1 WHERE r.rn=1
        ORDER BY r.timestamp DESC""", args).fetchall()
    meta = metadata(conn, guild)
    meta["complete"] = True
    return {"meta": meta, "members": [serialize(r) for r in members],
            "presence_logs": presence, "channel_logs": channels}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", os.environ.get("DASHBOARD_ORIGIN", "*"))
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")

    def send_body(self, body, status=200, content_type="application/json; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.cors()
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, data, status=200):
        self.send_body(json.dumps(data, ensure_ascii=False).encode("utf-8"), status)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path, qs = parsed.path, parse_qs(parsed.query)
        if path in STATIC_FILES:
            target = ROOT / STATIC_FILES[path]
            if target.is_file():
                mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
                self.send_body(target.read_bytes(), content_type=mime + "; charset=utf-8")
            else:
                self.send_json({"error": "Asset not found"}, 404)
            return
        if not path.startswith("/api/"):
            self.send_json({"error": "Not found"}, 404)
            return
        token = os.environ.get("DASHBOARD_API_TOKEN", "")
        if token and not hmac.compare_digest(self.headers.get("Authorization", "").encode('utf-8'), f"Bearer {token}".encode('utf-8')):
            self.send_json({"error": "An API access token is required"}, 401)
            return
        conn = None
        try:
            conn = db()
            conn.execute("BEGIN")
            if path == "/api/meta":
                self.send_json(metadata(conn, qs.get("guild_id", [None])[0]))
            elif path == "/api/snapshot":
                self.send_json(snapshot(conn, qs))
            elif path == "/api/stats":
                counts = []
                for table in ('presence_logs', 'channel_logs'):
                    counts.append(conn.execute(f"SELECT COUNT(*) FROM {table} t WHERE NOT EXISTS "
                        "(SELECT 1 FROM optouts o WHERE o.guild_id=t.guild_id AND o.user_id=t.user_id)").fetchone()[0])
                users = conn.execute("""SELECT COUNT(*) FROM (SELECT guild_id,user_id FROM presence_logs
                    UNION SELECT guild_id,user_id FROM channel_logs) t WHERE NOT EXISTS
                    (SELECT 1 FROM optouts o WHERE o.guild_id=t.guild_id AND o.user_id=t.user_id)""").fetchone()[0]
                self.send_json({"presence_events": counts[0], "channel_events": counts[1], "unique_users": users})
            elif path in ("/api/presence", "/api/channels"):
                limit = int(qs.get("limit", [500])[0])
                if not 1 <= limit <= 10_000:
                    raise ValueError("limit must be between 1 and 10000")
                result = rows(conn, "presence_logs" if path.endswith("presence") else "channel_logs", limit=limit, descending=True)
                self.send_json(result)
            elif path == "/api/leaderboard":
                days = int(qs.get("days", [7])[0])
                if not 1 <= days <= 3660:
                    raise ValueError("days must be between 1 and 3660")
                cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()
                result = conn.execute("""SELECT d.user_id,
                    COALESCE((SELECT p.username FROM presence_logs p WHERE p.guild_id=d.guild_id
                    AND p.user_id=d.user_id ORDER BY p.timestamp DESC LIMIT 1),'Unknown member') username,
                    SUM(d.online_minutes) total_mins FROM daily_stats d
                    WHERE d.date>=? AND NOT EXISTS (SELECT 1 FROM optouts o
                    WHERE o.guild_id=d.guild_id AND o.user_id=d.user_id)
                    GROUP BY d.guild_id,d.user_id ORDER BY total_mins DESC LIMIT 20""", (cutoff,))
                self.send_json([serialize(r) for r in result])
            else:
                self.send_json({"error": "Not found"}, 404)
        except (ValueError, TypeError):
            self.send_json({"error": "Invalid query. Check the date range, server ID, or limit."}, 400)
        except OverflowError as exc:
            self.send_json({"error": str(exc)}, 413)
        except (sqlite3.Error, OSError):
            self.send_json({"error": "The presence database is unavailable. Run the bot to initialize it, then check PRESENCE_DB_PATH."}, 503)
        finally:
            if conn is not None:
                conn.close()


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    server = ThreadingHTTPServer((host, PORT), Handler)
    print(f"Presence dashboard: http://{host}:{PORT}", flush=True)
    print("Read-only API. Press Ctrl+C to stop.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
