export const DAY = 86400000;
export const STATUS = { online: 'Online', idle: 'Idle', dnd: 'Do not disturb', offline: 'Offline', unknown: 'Unobserved' };
export const EVENT_LABEL = { presence: 'Presence', message: 'Message', reaction: 'Reaction', voice_join: 'Voice join', voice_leave: 'Voice leave', voice_move: 'Voice move' };
export const dateKey = (time, offset = 0) => new Date(Number(time) + offset * 60000).toISOString().slice(0, 10);
export const number = value => new Intl.NumberFormat('en-IN').format(value || 0);
export const duration = value => {
  const minutes = Math.round(value || 0);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function getRange(period, offset, firstEvent, custom = {}, now = Date.now()) {
  const today = dateKey(now, offset);
  const midnight = day => Date.parse(`${day}T00:00:00Z`) - offset * 60000;
  let end = midnight(today) + DAY;
  let start = end - Number(period || 14) * DAY;
  if (period === 'all') start = firstEvent ? midnight(dateKey(Date.parse(firstEvent), offset)) : midnight(today);
  if (period === 'custom') {
    start = midnight(custom.from || today);
    end = midnight(custom.to || today) + DAY;
  }
  return { start, end: Math.max(end, start + DAY), offset };
}

// Derive every view and export from one complete, server-scoped snapshot.
// Presence is observed state, not a heartbeat. Active time is a bounded estimate.
export function analyze(snapshot, range, userId = null, now = Date.now()) {
  const { start, end, offset } = range;
  const inRange = time => time >= start && time < end;
  const rawPresence = snapshot.presence_logs.filter(r => !userId || r.user_id === userId)
    .map(r => ({ ...r, ts: Date.parse(r.timestamp), type: 'presence' })).sort((a, b) => a.ts - b.ts);
  const presence = rawPresence.filter(r => inRange(r.ts));
  const channels = snapshot.channel_logs.filter(r => !userId || r.user_id === userId)
    .map(r => ({ ...r, ts: Date.parse(r.timestamp), type: r.event_type })).filter(r => inRange(r.ts));
  const events = [...presence, ...channels].sort((a, b) => b.ts - a.ts || String(b.id).localeCompare(String(a.id)));
  const members = new Map(snapshot.members.filter(r => !userId || r.user_id === userId).map(r => [r.user_id, {
    ...r, status: r.status || 'unknown', events: 0, messages: 0, reactions: 0, voice: 0,
    minutes: 0, daily: {}, active_days: new Set(),
  }]));
  const series = [];
  const byDate = new Map();
  for (let t = start; t < end; t += DAY) {
    const point = { date: dateKey(t, offset), events: 0, messages: 0, presence: 0, voice: 0, minutes: 0 };
    series.push(point);
    byDate.set(point.date, point);
  }
  const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
  const hourly = Array(24).fill(0);
  const channelMap = new Map();
  const typeCounts = {};
  for (const event of events) {
    const day = dateKey(event.ts, offset);
    const point = byDate.get(day);
    const shifted = new Date(event.ts + offset * 60000);
    const hour = shifted.getUTCHours();
    heatmap[(shifted.getUTCDay() + 6) % 7][hour]++;
    hourly[hour]++;
    typeCounts[event.type] = (typeCounts[event.type] || 0) + 1;
    if (point) { point.events++; if (event.type === 'presence') point.presence++; }
    let member = members.get(event.user_id);
    if (!member) {
      member = { user_id: event.user_id, username: event.username, status: 'unknown', last_seen: event.timestamp,
        events: 0, messages: 0, reactions: 0, voice: 0, minutes: 0, daily: {}, active_days: new Set() };
      members.set(event.user_id, member);
    }
    member.events++;
    member.active_days.add(day);
    member.daily[day] = (member.daily[day] || 0) + 1;
    if (event.type === 'message') { member.messages++; if (point) point.messages++; }
    if (event.type === 'reaction') member.reactions++;
    if (event.type === 'voice_join') { member.voice++; if (point) point.voice++; }
    if (event.type !== 'presence') {
      const key = event.channel_id;
      if (!channelMap.has(key)) channelMap.set(key, { id: key, name: event.channel_name || 'unnamed',
        events: 0, messages: 0, reactions: 0, voice: 0, people: new Set(), daily: {} });
      const channel = channelMap.get(key);
      channel.events++;
      channel.people.add(event.user_id);
      channel.daily[day] = (channel.daily[day] || 0) + 1;
      if (event.type === 'message') channel.messages++;
      if (event.type === 'reaction') channel.reactions++;
      if (event.type === 'voice_join') channel.voice++;
    }
  }
  const memberLogs = new Map();
  for (const row of rawPresence) {
    if (!memberLogs.has(row.user_id)) memberLogs.set(row.user_id, []);
    memberLogs.get(row.user_id).push(row);
  }
  const sessions = [];
  for (const [id, logs] of memberLogs) {
    let sessionStart = null;
    const close = until => {
      if (sessionStart === null) return;
      const a = Math.max(start, sessionStart);
      const b = Math.min(until, end, now, sessionStart + 6 * 3600000);
      if (b > a) {
        sessions.push({ user_id: id, start: a, end: b });
        const member = members.get(id);
        if (member) member.minutes += (b - a) / 60000;
        for (let cursor = a; cursor < b;) {
          const day = dateKey(cursor, offset);
          const next = Date.parse(`${day}T00:00:00Z`) - offset * 60000 + DAY;
          const finish = Math.min(next, b);
          if (byDate.has(day)) byDate.get(day).minutes += (finish - cursor) / 60000;
          cursor = finish;
        }
      }
      sessionStart = null;
    };
    for (const row of logs) {
      if (row.ts >= end) { close(end); break; }
      if (row.new_status === 'online' || row.new_status === 'dnd') {
        if (sessionStart === null) sessionStart = row.ts;
      } else close(row.ts);
    }
    close(Math.min(now, end));
  }
  const sortedMembers = [...members.values()].map(m => ({ ...m, active_days: m.active_days.size }))
    .sort((a, b) => b.events - a.events || a.username.localeCompare(b.username));
  const statusCounts = { online: 0, idle: 0, dnd: 0, offline: 0, unknown: 0 };
  for (const member of sortedMembers) statusCounts[member.status in statusCounts ? member.status : 'unknown']++;
  const peak = Math.max(...hourly);
  return { events, presence, channelEvents: channels, members: sortedMembers,
    channels: [...channelMap.values()].map(c => ({ ...c, people: c.people.size })).sort((a, b) => b.events - a.events),
    series, heatmap, hourly, sessions, statusCounts, typeCounts, range,
    totals: { events: events.length, presence: presence.length, messages: typeCounts.message || 0,
      reactions: typeCounts.reaction || 0, voice: typeCounts.voice_join || 0,
      active: sortedMembers.filter(m => m.events > 0).length, members: sortedMembers.length,
      minutes: sortedMembers.reduce((sum, m) => sum + m.minutes, 0), peakHour: peak ? hourly.indexOf(peak) : null } };
}

export function filterEvents(events, { search = '', type = 'all', user = 'all', channel = 'all' } = {}) {
  const term = search.toLocaleLowerCase().trim();
  return events.filter(e => (type === 'all' || (type === 'voice' ? e.type.startsWith('voice_') : e.type === type))
    && (user === 'all' || e.user_id === user) && (channel === 'all' || e.channel_id === channel)
    && (!term || `${e.username} ${e.channel_name || ''} ${e.type} ${e.new_status || ''} ${e.user_id}`.toLocaleLowerCase().includes(term)));
}

export function csv(rows, keys = rows.length ? Object.keys(rows[0]) : []) {
  const cell = value => {
    let text = String(value ?? '');
    // Prevent spreadsheet formulas, including whitespace-prefixed input.
    if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return '\uFEFF' + [keys.map(cell).join(','), ...rows.map(row => keys.map(key => cell(row[key])).join(','))].join('\r\n');
}

export function createSample(now = Date.now()) {
  let seed = 93;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const names = ['harsh.s', 'saanvi', 'aaditya', 'mira.jpg', 'devansh', 'ishaan', 'naina', 'rohan.exe', 'zoya', 'kabir', 'ananya', 'vivaan'];
  const guild_id = '1521170822872699002';
  const presence_logs = [], channel_logs = [];
  const dayStart = Math.floor(now / DAY) * DAY;
  let id = 0;
  const stamp = ts => ({ timestamp: new Date(ts).toISOString(), date: dateKey(ts), hour: new Date(ts).getUTCHours() });
  names.forEach((username, index) => {
    const user_id = String(1000000000000000000n + BigInt(index));
    for (let day = 29; day >= 0; day--) {
      if (rand() > 0.78 - index * 0.023) continue;
      const start = dayStart - day * DAY + (8 + Math.floor(rand() * 10)) * 3600000 + Math.floor(rand() * 1800000);
      if (start > now) continue;
      const length = (25 + rand() * 230) * 60000;
      const common = { guild_id, user_id, username };
      presence_logs.push({ ...common, id: String(++id), old_status: 'offline', new_status: 'online', ...stamp(start) });
      if (start + length * .6 < now) presence_logs.push({ ...common, id: String(++id), old_status: 'online', new_status: index % 3 ? 'idle' : 'dnd', ...stamp(start + length * .6) });
      if (start + length < now) presence_logs.push({ ...common, id: String(++id), old_status: index % 3 ? 'idle' : 'dnd', new_status: 'offline', ...stamp(start + length) });
      for (let n = 0, count = 4 + Math.floor(rand() * (24 - index)); n < count; n++) {
        const ts = start + rand() * length;
        if (ts > now) continue;
        const channelIndex = Math.floor(rand() ** 1.6 * 5);
        const channel_name = ['general', 'dev-talk', 'off-topic', 'showcase', 'music-room'][channelIndex];
        const event_type = rand() > .8 ? 'reaction' : 'message';
        channel_logs.push({ ...common, id: String(++id), channel_id: String(2000000000000000000n + BigInt(channelIndex)), channel_name,
          event_type, detail: event_type === 'message' ? `len:${12 + Math.floor(rand() * 150)}` : '🙌', ...stamp(ts) });
      }
      if (rand() > .5) {
        channel_logs.push({ ...common, id: String(++id), channel_id: '2000000000000000005', channel_name: 'the-lounge', event_type: 'voice_join', detail: 'the-lounge', ...stamp(start + 60000) });
        if (start + length < now) channel_logs.push({ ...common, id: String(++id), channel_id: '2000000000000000005', channel_name: 'the-lounge', event_type: 'voice_leave', detail: 'the-lounge', ...stamp(start + length) });
      }
    }
  });
  const all = [...presence_logs, ...channel_logs].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const members = names.map(username => {
    const latest = all.find(e => e.username === username);
    const status = [...presence_logs].reverse().filter(e => e.username === username).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
    return { user_id: latest.user_id, guild_id, username, last_seen: latest.timestamp, status: status?.new_status || 'unknown', status_at: status?.timestamp };
  });
  return { meta: { version: 1, complete: true, generated_at: new Date(now).toISOString(),
    guilds: [{ id: guild_id, name: 'The Common Room' }], first_event: all.at(-1)?.timestamp, last_event: all[0]?.timestamp },
    members, presence_logs, channel_logs };
}
