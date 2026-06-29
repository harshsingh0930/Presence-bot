
import os
import sqlite3
import asyncio
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path
from io import BytesIO
from collections import defaultdict

import discord
from discord import app_commands
from discord.ext import commands, tasks
try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.patches as mpatches
    import matplotlib.colors as mcolors
    import numpy as np
    HAS_MPL = True
except ImportError:
    HAS_MPL = False
import os
TOKEN = os.getenv("DISCORD_TOKEN", "")
DB_PATH = Path("presence.db")
EXPORT_DIR = Path("exports")
EXPORT_DIR.mkdir(exist_ok=True)
def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def init_db():
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("""
    CREATE TABLE IF NOT EXISTS presence_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id    INTEGER NOT NULL,
        user_id     INTEGER NOT NULL,
        username    TEXT,
        old_status  TEXT,
        new_status  TEXT,
        timestamp   TEXT NOT NULL,
        date        TEXT NOT NULL,
        hour        INTEGER NOT NULL
    )""")
    cur.execute("""
    CREATE TABLE IF NOT EXISTS channel_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id    INTEGER NOT NULL,
        channel_id  INTEGER NOT NULL,
        channel_name TEXT,
        user_id     INTEGER NOT NULL,
        username    TEXT,
        event_type  TEXT NOT NULL,
        detail      TEXT,
        timestamp   TEXT NOT NULL,
        date        TEXT NOT NULL,
        hour        INTEGER NOT NULL
    )""")
    cur.execute("""
    CREATE TABLE IF NOT EXISTS daily_stats (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id       INTEGER NOT NULL,
        user_id        INTEGER NOT NULL,
        date           TEXT NOT NULL,
        online_minutes INTEGER DEFAULT 0,
        UNIQUE(guild_id, user_id, date)
    )""")
    cur.execute("""
    CREATE TABLE IF NOT EXISTS tracked_guilds (
        guild_id    INTEGER PRIMARY KEY,
        report_channel_id INTEGER,
        log_channel_id    INTEGER,
        enabled     INTEGER DEFAULT 1
    )""")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_presence_user ON presence_logs(guild_id, user_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_presence_date ON presence_logs(date)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_channel_user  ON channel_logs(guild_id, user_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_channel_date  ON channel_logs(date)")

    conn.commit()
    conn.close()
    print("[DB] Initialized presence.db")
def is_opted_out(guild_id: int, user_id: int) -> bool:
    conn = get_conn()
    row = conn.execute(
        "SELECT 1 FROM optouts WHERE guild_id=? AND user_id=?",
        (guild_id, user_id)
    ).fetchone()
    conn.close()
    return row is not None
def estimate_online_minutes(guild_id: int, user_id: int, date: str) -> float:
    conn = get_conn()
    rows = conn.execute(
        """SELECT new_status, timestamp FROM presence_logs
           WHERE guild_id=? AND user_id=? AND date=?
           ORDER BY timestamp""",
        (guild_id, user_id, date)
    ).fetchall()
    conn.close()

    minutes = 0.0
    session_start = None
    ACTIVE = {"online", "dnd"} 

    for row in rows:
        status = row["new_status"]
        ts = datetime.fromisoformat(row["timestamp"])
        if status in ACTIVE and session_start is None:
            session_start = ts
        elif status not in ACTIVE and session_start is not None:
            delta = (ts - session_start).total_seconds() / 60
            minutes += min(delta, 360)
            session_start = None
    if session_start:
        now = datetime.now(timezone.utc)
        delta = (now - session_start.replace(tzinfo=timezone.utc)).total_seconds() / 60
        minutes += min(delta, 360)

    return round(minutes, 1)
def chart_heatmap(guild_id: int, user_id: int, username: str) -> BytesIO | None:
    if not HAS_MPL:
        return None

    conn = get_conn()
    rows = conn.execute(
        """SELECT hour, new_status FROM presence_logs
           WHERE guild_id=? AND user_id=?
           AND new_status IN ('online','dnd')""",
        (guild_id, user_id)
    ).fetchall()
    conn.close()

    if not rows:
        return None
    grid = np.zeros((7, 24))
    conn2 = get_conn()
    full_rows = conn2.execute(
        """SELECT timestamp, new_status FROM presence_logs
           WHERE guild_id=? AND user_id=?""",
        (guild_id, user_id)
    ).fetchall()
    conn2.close()

    for r in full_rows:
        if r["new_status"] in ("online", "dnd"):
            ts = datetime.fromisoformat(r["timestamp"])
            grid[ts.weekday()][ts.hour] += 1

    fig, ax = plt.subplots(figsize=(12, 4))
    fig.patch.set_facecolor("#1c1b19")
    ax.set_facecolor("#1c1b19")

    im = ax.imshow(grid, cmap="YlGn", aspect="auto", interpolation="nearest")

    days = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]
    ax.set_yticks(range(7))
    ax.set_yticklabels(days, color="#cdccca")
    ax.set_xticks(range(0, 24, 2))
    ax.set_xticklabels([f"{h:02d}:00" for h in range(0, 24, 2)], color="#cdccca", fontsize=8)
    ax.set_title(f"Activity Heatmap — {username}", color="#cdccca", fontsize=13, pad=12)
    ax.tick_params(colors="#cdccca")
    for spine in ax.spines.values():
        spine.set_edgecolor("#393836")

    cbar = fig.colorbar(im, ax=ax, fraction=0.02, pad=0.01)
    cbar.ax.yaxis.set_tick_params(color="#cdccca")
    plt.setp(cbar.ax.yaxis.get_ticklabels(), color="#cdccca")

    plt.tight_layout()
    buf = BytesIO()
    plt.savefig(buf, format="png", dpi=120, bbox_inches="tight")
    buf.seek(0)
    plt.close(fig)
    return buf


def chart_daily_online(guild_id: int, user_id: int, username: str, days: int = 14) -> BytesIO | None:
    if not HAS_MPL:
        return None

    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()
    conn = get_conn()
    rows = conn.execute(
        """SELECT date, SUM(online_minutes) as mins FROM daily_stats
           WHERE guild_id=? AND user_id=? AND date>=?
           GROUP BY date ORDER BY date""",
        (guild_id, user_id, cutoff)
    ).fetchall()
    conn.close()

    if not rows:
        return None

    dates = [r["date"] for r in rows]
    mins = [r["mins"] or 0 for r in rows]
    hours = [m / 60 for m in mins]

    fig, ax = plt.subplots(figsize=(10, 4))
    fig.patch.set_facecolor("#1c1b19")
    ax.set_facecolor("#201f1d")

    bars = ax.bar(dates, hours, color="#4f98a3", edgecolor="#393836", linewidth=0.5)
    for bar, h in zip(bars, hours):
        if h > 0:
            ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.05,
                    f"{h:.1f}h", ha="center", va="bottom", fontsize=7, color="#cdccca")

    ax.set_xticks(range(len(dates)))
    ax.set_xticklabels(dates, rotation=45, ha="right", fontsize=7, color="#cdccca")
    ax.set_ylabel("Hours Online", color="#cdccca")
    ax.set_title(f"Daily Online Time — {username} (last {days} days)", color="#cdccca", fontsize=12, pad=10)
    ax.tick_params(colors="#cdccca")
    ax.yaxis.grid(True, color="#262523", linewidth=0.5)
    ax.set_axisbelow(True)
    for spine in ax.spines.values():
        spine.set_edgecolor("#393836")

    plt.tight_layout()
    buf = BytesIO()
    plt.savefig(buf, format="png", dpi=120, bbox_inches="tight")
    buf.seek(0)
    plt.close(fig)
    return buf


def chart_guild_heatmap(guild_id: int) -> BytesIO | None:
    if not HAS_MPL:
        return None

    conn = get_conn()
    rows = conn.execute(
        """SELECT timestamp FROM presence_logs
           WHERE guild_id=? AND new_status IN ('online','dnd')""",
        (guild_id,)
    ).fetchall()
    conn.close()

    if not rows:
        return None

    grid = np.zeros((7, 24))
    for r in rows:
        ts = datetime.fromisoformat(r["timestamp"])
        grid[ts.weekday()][ts.hour] += 1

    fig, ax = plt.subplots(figsize=(12, 4))
    fig.patch.set_facecolor("#1c1b19")
    ax.set_facecolor("#1c1b19")
    im = ax.imshow(grid, cmap="PuBuGn", aspect="auto", interpolation="nearest")

    days = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]
    ax.set_yticks(range(7))
    ax.set_yticklabels(days, color="#cdccca")
    ax.set_xticks(range(0, 24, 2))
    ax.set_xticklabels([f"{h:02d}:00" for h in range(0, 24, 2)], color="#cdccca", fontsize=8)
    ax.set_title("Guild Activity Heatmap — All Members", color="#cdccca", fontsize=13, pad=12)
    ax.tick_params(colors="#cdccca")
    for spine in ax.spines.values():
        spine.set_edgecolor("#393836")

    cbar = fig.colorbar(im, ax=ax, fraction=0.02, pad=0.01)
    cbar.ax.yaxis.set_tick_params(color="#cdccca")
    plt.setp(cbar.ax.yaxis.get_ticklabels(), color="#cdccca")

    plt.tight_layout()
    buf = BytesIO()
    plt.savefig(buf, format="png", dpi=120, bbox_inches="tight")
    buf.seek(0)
    plt.close(fig)
    return buf
intents = discord.Intents.default()
intents.members = True
intents.presences = True
intents.message_content = True
intents.reactions = True
intents.voice_states = True

bot = commands.Bot(command_prefix="!", intents=intents)
tree = bot.tree
STATUS_EMOJI = {
    "online":  "🟢",
    "idle":    "🟡",
    "dnd":     "🔴",
    "offline": "⚫",
}
@bot.event
async def on_ready():
    print(f"[BOT] Logged in as {bot.user} ({bot.user.id})")
    print(f"[BOT] Guilds: {[g.name for g in bot.guilds]}")
    try:
        synced = await tree.sync()
        print(f"[BOT] Synced {len(synced)} slash commands")
    except Exception as e:
        print(f"[BOT] Sync error: {e}")
    daily_stats_job.start()
@bot.event
async def on_presence_update(before: discord.Member, after: discord.Member):
    if before.status == after.status:
        return
    if is_opted_out(after.guild.id, after.id):
        return

    now = datetime.now(timezone.utc)
    ts = now.isoformat()
    date = now.date().isoformat()
    hour = now.hour

    conn = get_conn()
    conn.execute(
        """INSERT INTO presence_logs
           (guild_id,user_id,username,old_status,new_status,timestamp,date,hour)
           VALUES (?,?,?,?,?,?,?,?)""",
        (after.guild.id, after.id, str(after), str(before.status),
         str(after.status), ts, date, hour)
    )
    conn.commit()
    conn.close()
    conn2 = get_conn()
    cfg = conn2.execute(
        "SELECT log_channel_id FROM tracked_guilds WHERE guild_id=? AND enabled=1",
        (after.guild.id,)
    ).fetchone()
    conn2.close()

    if cfg and cfg["log_channel_id"]:
        ch = bot.get_channel(cfg["log_channel_id"])
        if ch:
            old_e = STATUS_EMOJI.get(str(before.status), "❓")
            new_e = STATUS_EMOJI.get(str(after.status), "❓")
            try:
                await ch.send(
                    f"{old_e} → {new_e}  **{after.display_name}** "
                    f"(`{before.status}` → `{after.status}`) "
                    f"<t:{int(now.timestamp())}:T>",
                    silent=True
                )
            except discord.Forbidden:
                pass
@bot.event
async def on_message(message: discord.Message):
    if message.author.bot:
        await bot.process_commands(message)
        return
    if not message.guild:
        await bot.process_commands(message)
        return
    if is_opted_out(message.guild.id, message.author.id):
        await bot.process_commands(message)
        return

    now = datetime.now(timezone.utc)
    conn = get_conn()
    conn.execute(
        """INSERT INTO channel_logs
           (guild_id,channel_id,channel_name,user_id,username,event_type,detail,timestamp,date,hour)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (message.guild.id, message.channel.id,
         getattr(message.channel, "name", "DM"),
         message.author.id, str(message.author),
         "message", f"len:{len(message.content)}",
         now.isoformat(), now.date().isoformat(), now.hour)
    )
    conn.commit()
    conn.close()
    await bot.process_commands(message)
@bot.event
async def on_reaction_add(reaction: discord.Reaction, user: discord.User | discord.Member):
    if user.bot:
        return
    if not reaction.message.guild:
        return
    if is_opted_out(reaction.message.guild.id, user.id):
        return

    now = datetime.now(timezone.utc)
    conn = get_conn()
    conn.execute(
        """INSERT INTO channel_logs
           (guild_id,channel_id,channel_name,user_id,username,event_type,detail,timestamp,date,hour)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (reaction.message.guild.id,
         reaction.message.channel.id,
         getattr(reaction.message.channel, "name", "?"),
         user.id, str(user),
         "reaction", str(reaction.emoji),
         now.isoformat(), now.date().isoformat(), now.hour)
    )
    conn.commit()
    conn.close()
@bot.event
async def on_voice_state_update(member: discord.Member,
                                 before: discord.VoiceState,
                                 after: discord.VoiceState):
    if is_opted_out(member.guild.id, member.id):
        return

    now = datetime.now(timezone.utc)

    if before.channel is None and after.channel is not None:
        event_type = "voice_join"
        detail = after.channel.name
        ch_id = after.channel.id
        ch_name = after.channel.name
    elif before.channel is not None and after.channel is None:
        event_type = "voice_leave"
        detail = before.channel.name
        ch_id = before.channel.id
        ch_name = before.channel.name
    elif before.channel != after.channel:
        event_type = "voice_move"
        detail = f"{before.channel.name} → {after.channel.name}"
        ch_id = after.channel.id
        ch_name = after.channel.name
    else:
        return

    conn = get_conn()
    conn.execute(
        """INSERT INTO channel_logs
           (guild_id,channel_id,channel_name,user_id,username,event_type,detail,timestamp,date,hour)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (member.guild.id, ch_id, ch_name,
         member.id, str(member),
         event_type, detail,
         now.isoformat(), now.date().isoformat(), now.hour)
    )
    conn.commit()
    conn.close()
@tasks.loop(hours=1)
async def daily_stats_job():
    yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).date().isoformat()
    conn = get_conn()
    users = conn.execute(
        """SELECT DISTINCT guild_id, user_id FROM presence_logs WHERE date=?""",
        (yesterday,)
    ).fetchall()
    conn.close()

    for row in users:
        mins = estimate_online_minutes(row["guild_id"], row["user_id"], yesterday)
        conn2 = get_conn()
        conn2.execute(
            """INSERT INTO daily_stats (guild_id, user_id, date, online_minutes)
               VALUES (?,?,?,?)
               ON CONFLICT(guild_id,user_id,date) DO UPDATE SET online_minutes=excluded.online_minutes""",
            (row["guild_id"], row["user_id"], yesterday, mins)
        )
        conn2.commit()
        conn2.close()
@tree.command(name="setup", description="Set channels for presence logs and reports")
@app_commands.describe(
    log_channel="Channel to post real-time presence changes",
    report_channel="Channel for weekly/daily reports"
)
@app_commands.default_permissions(manage_guild=True)
async def setup(interaction: discord.Interaction,
                log_channel: discord.TextChannel = None,
                report_channel: discord.TextChannel = None):
    conn = get_conn()
    conn.execute(
        """INSERT INTO tracked_guilds (guild_id, log_channel_id, report_channel_id, enabled)
           VALUES (?,?,?,1)
           ON CONFLICT(guild_id) DO UPDATE SET
               log_channel_id=COALESCE(excluded.log_channel_id, log_channel_id),
               report_channel_id=COALESCE(excluded.report_channel_id, report_channel_id),
               enabled=1""",
        (interaction.guild_id,
         log_channel.id if log_channel else None,
         report_channel.id if report_channel else None)
    )
    conn.commit()
    conn.close()

    lines = ["✅ **Bot configured for this server!**"]
    if log_channel:
        lines.append(f"📋 Log channel: {log_channel.mention}")
    if report_channel:
        lines.append(f"📊 Report channel: {report_channel.mention}")
    await interaction.response.send_message("\n".join(lines), ephemeral=True)
@tree.command(name="activity", description="Show activity summary for a user")
@app_commands.describe(member="The user to check (leave blank for yourself)")
async def activity(interaction: discord.Interaction,
                   member: discord.Member = None):
    await interaction.response.defer(thinking=True)
    member = member or interaction.user

    if is_opted_out(interaction.guild_id, member.id):
        await interaction.followup.send("❌ That user has opted out of analytics.")
        return

    today = datetime.now(timezone.utc).date().isoformat()
    yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).date().isoformat()

    today_mins = estimate_online_minutes(interaction.guild_id, member.id, today)
    yday_mins = estimate_online_minutes(interaction.guild_id, member.id, yesterday)
    week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).date().isoformat()
    conn = get_conn()
    week_row = conn.execute(
        """SELECT SUM(online_minutes) as total FROM daily_stats
           WHERE guild_id=? AND user_id=? AND date>?""",
        (interaction.guild_id, member.id, week_ago)
    ).fetchone()
    peak_rows = conn.execute(
        """SELECT hour, COUNT(*) as cnt FROM presence_logs
           WHERE guild_id=? AND user_id=? AND new_status IN ('online','dnd')
           GROUP BY hour ORDER BY cnt DESC LIMIT 3""",
        (interaction.guild_id, member.id)
    ).fetchall()
    chan_rows = conn.execute(
        """SELECT channel_name, COUNT(*) as cnt FROM channel_logs
           WHERE guild_id=? AND user_id=? AND event_type='message'
           GROUP BY channel_name ORDER BY cnt DESC LIMIT 3""",
        (interaction.guild_id, member.id)
    ).fetchall()
    conn.close()

    week_total = (week_row["total"] or 0) / 60

    em = discord.Embed(
        title=f"📊 Activity — {member.display_name}",
        color=0x4f98a3
    )
    em.set_thumbnail(url=member.display_avatar.url)
    em.add_field(name="Today",     value=f"{today_mins/60:.1f}h ({today_mins:.0f} min)", inline=True)
    em.add_field(name="Yesterday", value=f"{yday_mins/60:.1f}h ({yday_mins:.0f} min)",   inline=True)
    em.add_field(name="7-day total", value=f"{week_total:.1f}h",                          inline=True)

    if peak_rows:
        peak_str = ", ".join([f"`{r['hour']:02d}:xx`" for r in peak_rows])
        em.add_field(name="Peak Hours (UTC)", value=peak_str, inline=False)

    if chan_rows:
        chan_str = "\n".join([f"#{r['channel_name']} — {r['cnt']} msgs" for r in chan_rows])
        em.add_field(name="Top Channels", value=chan_str, inline=False)

    em.set_footer(text="All times UTC • /privacy optout to stop tracking")
    await interaction.followup.send(embed=em)
@tree.command(name="heatmap", description="Generate activity heatmap for a user")
@app_commands.describe(member="The user to visualize")
async def heatmap(interaction: discord.Interaction,
                  member: discord.Member = None):
    await interaction.response.defer(thinking=True)
    member = member or interaction.user

    if is_opted_out(interaction.guild_id, member.id):
        await interaction.followup.send("❌ That user has opted out.")
        return

    if not HAS_MPL:
        await interaction.followup.send("⚠️ Matplotlib not installed. Run: `pip install matplotlib numpy`")
        return

    buf = chart_heatmap(interaction.guild_id, member.id, member.display_name)
    if not buf:
        await interaction.followup.send("❌ Not enough data yet. Try again after the bot has logged some activity.")
        return

    file = discord.File(buf, filename="heatmap.png")
    await interaction.followup.send(
        content=f"🌡️ Heatmap for **{member.display_name}**",
        file=file
    )
@tree.command(name="daily-chart", description="Bar chart of daily online time")
@app_commands.describe(member="User to chart", days="How many days back (default 14)")
async def daily_chart(interaction: discord.Interaction,
                      member: discord.Member = None,
                      days: int = 14):
    await interaction.response.defer(thinking=True)
    member = member or interaction.user

    if is_opted_out(interaction.guild_id, member.id):
        await interaction.followup.send("❌ That user has opted out.")
        return

    if not HAS_MPL:
        await interaction.followup.send("⚠️ Matplotlib not installed.")
        return

    buf = chart_daily_online(interaction.guild_id, member.id, member.display_name, days)
    if not buf:
        await interaction.followup.send("❌ No daily stats yet. The bot runs stats every hour.")
        return

    file = discord.File(buf, filename="daily_chart.png")
    await interaction.followup.send(
        content=f"📈 Daily online time for **{member.display_name}** (last {days} days)",
        file=file
    )
@tree.command(name="guild-heatmap", description="Heatmap of server-wide activity")
async def guild_heatmap(interaction: discord.Interaction):
    await interaction.response.defer(thinking=True)

    if not HAS_MPL:
        await interaction.followup.send("⚠️ Matplotlib not installed.")
        return

    buf = chart_guild_heatmap(interaction.guild_id)
    if not buf:
        await interaction.followup.send("❌ No data yet.")
        return

    file = discord.File(buf, filename="guild_heatmap.png")
    await interaction.followup.send(
        content="🌍 **Server Activity Heatmap** — all members combined",
        file=file
    )
@tree.command(name="top-active", description="Most active members this week")
@app_commands.describe(limit="Number of members to show (default 10)")
async def top_active(interaction: discord.Interaction, limit: int = 10):
    await interaction.response.defer(thinking=True)

    week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).date().isoformat()
    conn = get_conn()
    rows = conn.execute(
        """SELECT user_id, SUM(online_minutes) as total_mins
           FROM daily_stats
           WHERE guild_id=? AND date>?
           GROUP BY user_id
           ORDER BY total_mins DESC
           LIMIT ?""",
        (interaction.guild_id, week_ago, limit)
    ).fetchall()
    conn.close()

    if not rows:
        await interaction.followup.send("❌ No stats yet for this week.")
        return

    medals = ["🥇","🥈","🥉"] + ["🏅"] * 20
    lines = []
    for i, r in enumerate(rows):
        member = interaction.guild.get_member(r["user_id"])
        name = member.display_name if member else f"User {r['user_id']}"
        hours = (r["total_mins"] or 0) / 60
        lines.append(f"{medals[i]} **{name}** — `{hours:.1f}h`")

    em = discord.Embed(
        title="🏆 Most Active Members (Last 7 Days)",
        description="\n".join(lines),
        color=0x4f98a3
    )
    em.set_footer(text="Based on logged online/dnd presence")
    await interaction.followup.send(embed=em)
@tree.command(name="channel-stats", description="Most active channels by message count")
@app_commands.describe(days="Look back how many days (default 7)")
async def channel_stats(interaction: discord.Interaction, days: int = 7):
    await interaction.response.defer(thinking=True)

    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()
    conn = get_conn()
    rows = conn.execute(
        """SELECT channel_name, COUNT(*) as cnt FROM channel_logs
           WHERE guild_id=? AND event_type='message' AND date>=?
           GROUP BY channel_name ORDER BY cnt DESC LIMIT 10""",
        (interaction.guild_id, cutoff)
    ).fetchall()
    conn.close()

    if not rows:
        await interaction.followup.send("❌ No message data yet.")
        return

    lines = [f"#{r['channel_name']} — **{r['cnt']}** messages" for r in rows]
    em = discord.Embed(
        title=f"💬 Most Active Channels (Last {days} Days)",
        description="\n".join(lines),
        color=0x4f98a3
    )
    await interaction.followup.send(embed=em)
@tree.command(name="user-channel-log", description="Recent channel activity log for a user")
@app_commands.describe(member="User to view", limit="Number of entries (max 25)")
@app_commands.default_permissions(manage_guild=True)
async def user_channel_log(interaction: discord.Interaction,
                            member: discord.Member,
                            limit: int = 15):
    await interaction.response.defer(thinking=True, ephemeral=True)

    if is_opted_out(interaction.guild_id, member.id):
        await interaction.followup.send("That user has opted out.", ephemeral=True)
        return

    conn = get_conn()
    rows = conn.execute(
        """SELECT event_type, channel_name, detail, timestamp FROM channel_logs
           WHERE guild_id=? AND user_id=?
           ORDER BY timestamp DESC LIMIT ?""",
        (interaction.guild_id, member.id, min(limit, 25))
    ).fetchall()
    conn.close()

    if not rows:
        await interaction.followup.send("No channel activity logged yet.", ephemeral=True)
        return

    EVENT_ICONS = {
        "message": "💬",
        "reaction": "👍",
        "voice_join": "🎙️",
        "voice_leave": "🔇",
        "voice_move": "↕️",
    }

    lines = []
    for r in rows:
        icon = EVENT_ICONS.get(r["event_type"], "•")
        ts = datetime.fromisoformat(r["timestamp"])
        ts_unix = int(ts.timestamp())
        lines.append(
            f"{icon} `{r['event_type']}` in **#{r['channel_name']}** "
            f"<t:{ts_unix}:R>"
        )

    em = discord.Embed(
        title=f"📋 Channel Log — {member.display_name}",
        description="\n".join(lines),
        color=0x4f98a3
    )
    await interaction.followup.send(embed=em, ephemeral=True)
@tree.command(name="export-csv", description="Export this server's presence data as CSV")
@app_commands.default_permissions(manage_guild=True)
async def export_csv(interaction: discord.Interaction):
    await interaction.response.defer(thinking=True, ephemeral=True)

    conn = get_conn()
    rows = conn.execute(
        """SELECT username, old_status, new_status, timestamp
           FROM presence_logs WHERE guild_id=? ORDER BY timestamp DESC LIMIT 5000""",
        (interaction.guild_id,)
    ).fetchall()
    conn.close()

    if not rows:
        await interaction.followup.send("No data to export yet.", ephemeral=True)
        return

    lines = ["username,old_status,new_status,timestamp"]
    for r in rows:
        lines.append(f"{r['username']},{r['old_status']},{r['new_status']},{r['timestamp']}")

    buf = BytesIO("\n".join(lines).encode())
    buf.seek(0)
    fname = f"presence_{interaction.guild_id}_{datetime.now().strftime('%Y%m%d')}.csv"
    file = discord.File(buf, filename=fname)
    await interaction.followup.send("📁 Here's your export:", file=file, ephemeral=True)
privacy_group = app_commands.Group(name="privacy", description="Manage your analytics preferences")

@privacy_group.command(name="optout", description="Stop tracking your presence and activity")
async def privacy_optout(interaction: discord.Interaction):
    conn = get_conn()
    conn.execute(
        "INSERT OR IGNORE INTO optouts (guild_id, user_id) VALUES (?,?)",
        (interaction.guild_id, interaction.user.id)
    )
    conn.commit()
    conn.close()
    await interaction.response.send_message(
        "✅ You've opted out. Your data will no longer be logged in this server.\n"
        "Use `/privacy optin` to re-enable.",
        ephemeral=True
    )

@privacy_group.command(name="optin", description="Re-enable presence and activity tracking")
async def privacy_optin(interaction: discord.Interaction):
    conn = get_conn()
    conn.execute(
        "DELETE FROM optouts WHERE guild_id=? AND user_id=?",
        (interaction.guild_id, interaction.user.id)
    )
    conn.commit()
    conn.close()
    await interaction.response.send_message(
        "✅ You've opted back in. Your presence will be tracked again.",
        ephemeral=True
    )

@privacy_group.command(name="status", description="Check your current tracking status")
async def privacy_status(interaction: discord.Interaction):
    opted = is_opted_out(interaction.guild_id, interaction.user.id)
    msg = "❌ You are **opted out**." if opted else "✅ You are **opted in** (default)."
    await interaction.response.send_message(msg, ephemeral=True)

tree.add_command(privacy_group)
@tree.command(name="bot-status", description="Check bot health and database stats")
async def bot_status(interaction: discord.Interaction):
    conn = get_conn()
    pcount = conn.execute("SELECT COUNT(*) FROM presence_logs").fetchone()[0]
    ccount = conn.execute("SELECT COUNT(*) FROM channel_logs").fetchone()[0]
    ucount = conn.execute(
        "SELECT COUNT(DISTINCT user_id) FROM presence_logs WHERE guild_id=?",
        (interaction.guild_id,)
    ).fetchone()[0]
    conn.close()

    uptime = datetime.now(timezone.utc) - bot.uptime if hasattr(bot, "uptime") else None
    em = discord.Embed(title="🤖 Bot Status", color=0x4f98a3)
    em.add_field(name="Presence Events", value=f"{pcount:,}", inline=True)
    em.add_field(name="Channel Events",  value=f"{ccount:,}", inline=True)
    em.add_field(name="Tracked Users",   value=f"{ucount:,}", inline=True)
    em.add_field(name="DB", value=str(DB_PATH.resolve()), inline=False)
    em.add_field(name="Matplotlib", value="✅ Ready" if HAS_MPL else "❌ Not installed", inline=True)
    await interaction.response.send_message(embed=em, ephemeral=True)
@bot.command(name="sync")
@commands.is_owner()
async def sync_commands(ctx):
    """Force re-sync slash commands (owner only)"""
    synced = await tree.sync()
    await ctx.send(f"✅ Synced {len(synced)} commands.")

@bot.command(name="ping")
async def ping(ctx):
    await ctx.send(f"🏓 Pong! `{round(bot.latency * 1000)}ms`")

if __name__ == "__main__":
    init_db()
    bot.run(TOKEN)
