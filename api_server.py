
import sqlite3, json, os
from datetime import datetime, timezone, timedelta
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

DB_PATH = Path("presence.db")
PORT = 5000

def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = urlparse(self.path)
        qs = parse_qs(p.query)
        path = p.path

        if path == "/api/stats":
            conn = db()
            pcount = conn.execute("SELECT COUNT(*) FROM presence_logs").fetchone()[0]
            ccount = conn.execute("SELECT COUNT(*) FROM channel_logs").fetchone()[0]
            ucount = conn.execute("SELECT COUNT(DISTINCT user_id) FROM presence_logs").fetchone()[0]
            conn.close()
            self.send_json({"presence_events": pcount, "channel_events": ccount, "unique_users": ucount})

        elif path == "/api/presence":
            limit = int(qs.get("limit", [500])[0])
            conn = db()
            rows = conn.execute(
                "SELECT * FROM presence_logs ORDER BY timestamp DESC LIMIT ?", (limit,)
            ).fetchall()
            conn.close()
            self.send_json([dict(r) for r in rows])

        elif path == "/api/channels":
            limit = int(qs.get("limit", [500])[0])
            conn = db()
            rows = conn.execute(
                "SELECT * FROM channel_logs ORDER BY timestamp DESC LIMIT ?", (limit,)
            ).fetchall()
            conn.close()
            self.send_json([dict(r) for r in rows])

        elif path == "/api/leaderboard":
            days = int(qs.get("days", [7])[0])
            cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()
            conn = db()
            rows = conn.execute(
                """SELECT user_id, username, SUM(online_minutes) as total_mins
                   FROM daily_stats WHERE date>? GROUP BY user_id
                   ORDER BY total_mins DESC LIMIT 20""",
                (cutoff,)
            ).fetchall()
            conn.close()
            self.send_json([dict(r) for r in rows])

        elif path == "/":
            dash = Path("dashboard.html")
            if dash.exists():
                body = dash.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", len(body))
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_json({"error": "dashboard.html not found"}, 404)
        else:
            self.send_json({"error": "Not found"}, 404)

if __name__ == "__main__":
    if not DB_PATH.exists():
        print(f"[API] Warning: {DB_PATH} not found. Run bot.py first to create the database.")
    server = HTTPServer(("", PORT), Handler)
    print(f"[API] Running at http://localhost:{PORT}")
    print(f"[API] Dashboard at http://localhost:{PORT}/")
    print(f"[API] Press Ctrl+C to stop")
    server.serve_forever()
