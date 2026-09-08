import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY, analyze, createSample, csv, duration, filterEvents, getRange } from '../assets/data.js';

const now = Date.parse('2026-10-26T16:00:00Z');
const member = { user_id: '1521170822872699002', username: 'a,<b>', last_seen: new Date(now).toISOString(), status: 'online' };
const event = (at, status, id = '1') => ({ user_id: member.user_id, username: member.username, guild_id: '1', id,
  timestamp: at, new_status: status, old_status: 'offline' });
const blank = () => ({ meta: {}, members: [member], presence_logs: [], channel_logs: [] });
const windowRange = { start: Date.parse('2026-10-26T00:00:00Z'), end: Date.parse('2026-10-27T00:00:00Z'), offset: 0 };

test('empty windows retain observed members without inventing activity', () => {
  const data = analyze(blank(), windowRange, null, now);
  assert.equal(data.totals.active, 0); assert.equal(data.totals.events, 0);
  assert.equal(data.members.length, 1); assert.equal(data.totals.minutes, 0);
  assert.equal(data.totals.peakHour, null);
});
test('continuous online/DND sessions share one six-hour cap', () => {
  const snapshot = blank(); snapshot.presence_logs = [event('2026-10-26T01:00:00Z', 'online'), event('2026-10-26T05:00:00Z', 'dnd', '2'), event('2026-10-26T12:00:00Z', 'offline', '3')];
  const d = analyze(snapshot, windowRange, null, now);
  assert.equal(d.totals.minutes, 360); assert.equal(d.totals.presence, 3);
  assert.equal(d.members[0].user_id, '1521170822872699002');
});
test('a session spanning midnight is clipped to the window and split into daily buckets', () => {
  const snapshot = blank(); snapshot.presence_logs = [event('2026-10-25T23:00:00Z', 'online'), event('2026-10-26T02:00:00Z', 'offline', '2')];
  const d = analyze(snapshot, windowRange, null, now);
  assert.equal(d.totals.minutes, 120); assert.equal(d.series[0].minutes, 120);
  assert.equal(d.totals.presence, 1);
});
test('idle ends active time and a later session starts independently', () => {
  const snapshot = blank(); snapshot.presence_logs = [event('2026-10-26T01:00:00Z', 'online'), event('2026-10-26T02:00:00Z', 'idle', '2'), event('2026-10-26T04:00:00Z', 'dnd', '3'), event('2026-10-26T05:00:00Z', 'offline', '4')];
  assert.equal(analyze(snapshot, windowRange, null, now).totals.minutes, 120);
});
test('an open session is clipped to now and never grows beyond six hours', () => {
  const snapshot = blank(); snapshot.presence_logs = [event('2026-10-26T14:00:00Z', 'online')];
  assert.equal(analyze(snapshot, windowRange, null, now).totals.minutes, 120);
  snapshot.presence_logs = [event('2026-10-26T01:00:00Z', 'online')];
  assert.equal(analyze(snapshot, windowRange, null, now).totals.minutes, 360);
});
test('a state preceding context prevents old sessions restarting at an online-to-DND transition', () => {
  const snapshot = blank(); snapshot.presence_logs = [event('2026-10-25T15:00:00Z', 'online'), event('2026-10-25T20:00:00Z', 'dnd', '2'), event('2026-10-26T02:00:00Z', 'offline', '3')];
  const d = analyze(snapshot, windowRange, null, now);
  assert.equal(d.totals.minutes, 0);
});
test('duration carries rounded minutes into the next hour', () => {
  assert.equal(duration(59.9), '1h 0m'); assert.equal(duration(119.9), '2h 0m');
});
test('timezone boundaries and heatmap use the same local day', () => {
  const range = getRange('7', 330, null, {}, now);
  assert.equal(range.end - range.start, 7 * DAY);
  assert.equal(new Date(range.start).toISOString(), '2026-10-19T18:30:00.000Z');
  const snapshot = blank(); snapshot.presence_logs = [event('2026-10-25T20:00:00Z', 'online')];
  const d = analyze(snapshot, { start: Date.parse('2026-10-25T18:30Z'), end: Date.parse('2026-10-26T18:30Z'), offset: 330 }, null, now);
  assert.equal(d.series[0].date, '2026-10-26'); assert.equal(d.heatmap[0][1], 1);
});
test('one member report excludes other members and all event types can be filtered', () => {
  const snapshot = createSample(now), data = analyze(snapshot, getRange('14', 330, snapshot.meta.first_event, {}, now), null, now);
  const id = snapshot.members[0].user_id;
  const one = analyze(snapshot, data.range, id, now);
  assert.ok(one.events.length > 0); assert.ok(one.events.every(e => e.user_id === id));
  const voice = filterEvents(data.events, { type: 'voice', user: id });
  assert.ok(voice.length > 0); assert.ok(voice.every(e => e.type.startsWith('voice_') && e.user_id === id));
  assert.equal(filterEvents(data.events, { search: '<no such member>' }).length, 0);
});
test('CSV quotes names and multiline fields and neutralizes formula injection', () => {
  const output = csv([{ name: '=SUM(1,2)', detail: 'a,"b"\nc', spaced: '  @cmd' }]);
  assert.ok(output.startsWith('\uFEFF')); assert.ok(output.includes('"\'=SUM(1,2)"'));
  assert.ok(output.includes('"a,""b""\nc"')); assert.ok(output.includes('"\'  @cmd"'));
});
test('sample totals reconcile with member, date, channel, and type breakdowns', () => {
  const snapshot = createSample(now), data = analyze(snapshot, getRange('30', 0, snapshot.meta.first_event, {}, now), null, now);
  assert.equal(data.totals.events, data.members.reduce((n, m) => n + m.events, 0));
  assert.equal(data.totals.events, data.series.reduce((n, p) => n + p.events, 0));
  assert.equal(data.channelEvents.length, data.channels.reduce((n, c) => n + c.events, 0));
  assert.equal(data.totals.events, Object.values(data.typeCounts).reduce((a, b) => a + b, 0));
});
