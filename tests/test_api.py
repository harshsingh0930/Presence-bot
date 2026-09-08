"""Contract checks against a temporary database; the bot's DB is never touched."""
import json
import os
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import api_server


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixtures = Path(__file__).resolve().parents[1] / '.artifacts'
        fixtures.mkdir(exist_ok=True)
        cls.tmp = tempfile.TemporaryDirectory(prefix='api-test-', dir=fixtures)
        cls.path = Path(cls.tmp.name) / "fixture.db"
        conn = sqlite3.connect(cls.path)
        conn.executescript("""
            CREATE TABLE presence_logs (id INTEGER PRIMARY KEY,guild_id INTEGER,user_id INTEGER,
                username TEXT,old_status TEXT,new_status TEXT,timestamp TEXT,date TEXT,hour INTEGER);
            CREATE TABLE channel_logs (id INTEGER PRIMARY KEY,guild_id INTEGER,channel_id INTEGER,
                channel_name TEXT,user_id INTEGER,username TEXT,event_type TEXT,detail TEXT,
                timestamp TEXT,date TEXT,hour INTEGER);
            CREATE TABLE optouts (guild_id INTEGER,user_id INTEGER);
            CREATE TABLE tracked_guilds (guild_id INTEGER PRIMARY KEY);
            CREATE TABLE daily_stats (guild_id INTEGER,user_id INTEGER,date TEXT,online_minutes REAL);
            INSERT INTO tracked_guilds VALUES (1521170822872699002);
            INSERT INTO presence_logs VALUES
                (1,1521170822872699002,1521170822872699003,'Ada','offline','online','2026-10-25T23:00:00+00:00','2026-10-25',23),
                (2,1521170822872699002,1521170822872699003,'Ada','online','offline','2026-10-26T02:00:00+00:00','2026-10-26',2),
                (3,1521170822872699002,1521170822872699004,'Opted out','offline','online','2026-10-26T03:00:00+00:00','2026-10-26',3);
            INSERT INTO channel_logs VALUES
                (1,1521170822872699002,1521170822872699005,'general',1521170822872699003,'Ada','reaction','ok','2026-10-26T02:01:00+00:00','2026-10-26',2);
            INSERT INTO optouts VALUES (1521170822872699002,1521170822872699004);
            INSERT INTO daily_stats VALUES (1521170822872699002,1521170822872699003,'2099-01-01',60);
        """)
        conn.commit()
        conn.close()
        cls.patcher = patch.object(api_server, 'DB_PATH', cls.path)
        cls.patcher.start()
        cls.server = api_server.ThreadingHTTPServer(('127.0.0.1', 0), api_server.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.origin = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.patcher.stop()
        cls.tmp.cleanup()

    def get(self, path, headers=None):
        try:
            with urlopen(Request(self.origin + path, headers=headers or {})) as response:
                body = response.read()
                return response.status, json.loads(body) if 'application/json' in response.headers['Content-Type'] else body
        except HTTPError as error:
            return error.code, json.loads(error.read())

    def test_snapshot_preserves_ids_and_excludes_optouts(self):
        status, data = self.get('/api/snapshot?guild_id=1521170822872699002&from=2026-10-26T00:00:00Z&to=2026-10-27T00:00:00Z')
        self.assertEqual(status, 200)
        self.assertTrue(data['meta']['complete'])
        self.assertEqual(len(data['presence_logs']), 2)  # includes carry-in context
        self.assertEqual(data['members'][0]['user_id'], '1521170822872699003')
        self.assertEqual(data['members'][0]['status'], 'offline')
        self.assertEqual(data['presence_logs'][0]['guild_id'], '1521170822872699002')
        self.assertEqual(len(data['members']), 1)

    def test_legacy_leaderboard_resolves_name_from_presence(self):
        status, data = self.get('/api/leaderboard')
        self.assertEqual(status, 200)
        self.assertEqual(data[0]['username'], 'Ada')
        self.assertEqual(data[0]['total_mins'], 60)

    def test_invalid_queries_return_400(self):
        for path in ['/api/presence?limit=no', '/api/channels?limit=-1', '/api/leaderboard?days=0',
                     '/api/snapshot?guild_id=abc', '/api/snapshot?from=2026-10-26',
                     '/api/snapshot?from=2026-10-27T00:00Z&to=2026-10-26T00:00Z']:
            with self.subTest(path=path):
                self.assertEqual(self.get(path)[0], 400)

    def test_snapshot_never_silently_truncates(self):
        with patch.object(api_server, 'MAX_ROWS', 1):
            status, data = self.get('/api/snapshot')
            self.assertEqual(status, 413)
            self.assertIn('shorter', data['error'])

    def test_token_protects_api_but_not_the_frontend(self):
        with patch.dict(os.environ, {'DASHBOARD_API_TOKEN': 'test-access-token'}):
            self.assertEqual(self.get('/api/meta')[0], 401)
            self.assertEqual(self.get('/api/meta', {'Authorization': 'Bearer test-access-token'})[0], 200)
            self.assertEqual(self.get('/')[0], 200)

    def test_static_allowlist_does_not_expose_database_or_secrets(self):
        for path in ['/presence.db', '/.env.example', '/bot.py', '/assets/../presence.db', '/.git/config']:
            self.assertEqual(self.get(path)[0], 404)
        self.assertEqual(self.get('/assets/app.js')[0], 200)

    def test_database_is_read_only_and_missing_db_is_not_created(self):
        with api_server.db() as conn:
            with self.assertRaises(sqlite3.OperationalError):
                conn.execute('DELETE FROM presence_logs')
        conn.close()
        missing = Path(self.tmp.name) / 'missing.db'
        with patch.object(api_server, 'DB_PATH', missing):
            self.assertEqual(self.get('/api/meta')[0], 503)
            self.assertFalse(missing.exists())

    def test_stats_and_empty_server_scope(self):
        status, data = self.get('/api/stats')
        self.assertEqual(status, 200)
        self.assertEqual(data, {'presence_events': 2, 'channel_events': 1, 'unique_users': 1})
        status, data = self.get('/api/snapshot?guild_id=999')
        self.assertEqual(status, 200)
        self.assertEqual(data['presence_logs'], [])
        self.assertEqual(data['members'], [])

    def test_prior_state_is_retained_to_prevent_restarting_capped_sessions(self):
        status, data = self.get('/api/snapshot?guild_id=1521170822872699002&from=2026-10-26T12:00:00Z&to=2026-10-27T00:00:00Z')
        self.assertEqual(status, 200)
        self.assertEqual(len(data['presence_logs']), 1)
        self.assertEqual(data['presence_logs'][0]['new_status'], 'offline')

    def test_metadata_observation_window_is_scoped_to_selected_server(self):
        status, data = self.get('/api/meta?guild_id=999')
        self.assertEqual(status, 200)
        self.assertIsNone(data['first_event'])
        self.assertIsNone(data['last_event'])


if __name__ == '__main__':
    unittest.main()
