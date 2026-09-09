import { DAY, STATUS, EVENT_LABEL, analyze, createSample, csv, dateKey, duration, escapeHTML as esc, filterEvents, getRange, number } from './data.js';

const $ = selector => document.querySelector(selector);
const config = window.PRESENCE_CONFIG || {};
const stored = (key, fallback = '') => { try { return localStorage.getItem(`presence.${key}`) ?? fallback; } catch { return fallback; } };
const save = (key, value) => { try { localStorage.setItem(`presence.${key}`, value); } catch {} };
const tokenStored = () => { try { return sessionStorage.getItem('presence.token') || ''; } catch { return ''; } };
const state = {
  mode: stored('mode', 'live'), base: stored('api', config.apiBase || ''), token: tokenStored(),
  name: stored('name', config.serverName || ''), guild: stored('guild'), period: stored('period', '14'),
  offset: Number(stored('offset', '330')), custom: { from: stored('from'), to: stored('to') },
  snapshot: null, meta: null, data: null, route: 'overview', detail: '', busy: false,
  error: '', fatal: false, synced: null, request: 0, sampleDismissed: false,
  chart: 'events', memberSearch: '', memberStatus: 'all', memberSort: 'events', memberPage: 1,
  channelSearch: '', eventSearch: '', eventType: 'all', eventUser: 'all', eventPage: 1,
  report: 'summary', reportUser: 'all',
};
if (!['7', '14', '30', 'all', 'custom'].includes(state.period)) state.period = '14';
if (![0, 330].includes(state.offset)) state.offset = 330;

const paths = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  members: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M15 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
  channels: '<path d="m5 9 15 0M4 15h15M11 3 7 21M17 3l-4 18"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  reports: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm0 0v6h6M8 13h8M8 17h5"/>',
  settings: '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3l-1 3-3 1-2 3 2 2-1 3 3 2 1 3h4l1-3 3-1 2-3-2-2 1-3-3-2-1-3z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2"/>',
  arrowRight: '<path d="M4 12h16m-6-6 6 6-6 6"/>', arrowLeft: '<path d="M20 12H4m6-6-6 6 6 6"/>',
  arrowUpRight: '<path d="M7 17 17 7M7 7h10v10"/>', chevrons: '<path d="m8 9 4-4 4 4m-8 6 4 4 4-4"/>',
  chevronRight: '<path d="m9 5 7 7-7 7"/>', chevronLeft: '<path d="m15 5-7 7 7 7"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18m-12 5h2m3 0h2"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  message: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0Z"/><path d="M7 9h9M7 13h6"/>',
  voice: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  reaction: '<circle cx="12" cy="12" r="9"/><path d="M8 14c2 3 6 3 8 0M8 8h.01M16 8h.01"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>', menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  print: '<path d="M6 9V3h12v6M6 17H3V9h18v8h-3M6 14h12v7H6zM17 11h.01"/>',
  leaf: '<path d="M20 3c-14-1-18 6-13 12S22 18 20 3ZM3 21 15 9"/>',
};
function icon(name, className = '') { return `<svg class="${className}" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.activity}</svg>`; }
function hydrateIcons(root = document) { root.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon); }); }
hydrateIcons();
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').classList.remove('show'), 3500); }
function colorFor(value) {
  let hash = 0; for (const char of String(value)) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return [['#e8eadb', '#75815b'], ['#f0e2d9', '#a2775c'], ['#e1e8e7', '#6b8684'], ['#e8e3d8', '#918261'], ['#e4e7ee', '#7c88a0']][Math.abs(hash) % 5];
}
function avatar(member, size = '') {
  const [bg, ink] = colorFor(member.user_id);
  const initials = (member.username || '?').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase();
  return `<span class="avatar ${size}" style="--avatar-bg:${bg};--avatar-ink:${ink}">${esc(initials)}</span>`;
}
function timeFormat(time, options = {}) { return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...options }).format(new Date(Number(time) + state.offset * 60000)); }
const shortDate = time => timeFormat(time, { month: 'short', day: 'numeric' });
const fullDate = time => timeFormat(time, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const zone = () => state.offset ? 'IST' : 'UTC';
function relative(time) {
  if (!time) return 'Never observed';
  const delta = Math.max(0, Date.now() - Date.parse(time));
  if (delta < 60000) return 'just now';
  if (delta < 3600000) return `${Math.floor(delta / 60000)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / 3600000)}h ago`;
  if (delta < DAY * 7) return `${Math.floor(delta / DAY)}d ago`;
  return shortDate(Date.parse(time));
}
function statusBadge(member) {
  return `<span class="status-badge ${esc(member.status)}" title="Last status observed ${member.status_at ? esc(fullDate(Date.parse(member.status_at))) + ' ' + zone() : 'at an unknown time'}. This is not a live heartbeat."><i class="legend-dot ${esc(member.status)}"></i>${esc(STATUS[member.status] || 'Unobserved')}</span>`;
}
const community = () => state.mode === 'sample' ? 'The Common Room' : state.name || state.meta?.guilds.find(g => g.id === state.guild)?.name || 'Your community';
const selected = (a, b) => a === b ? ' selected' : '';
function range() { return getRange(state.period, state.offset, state.meta?.first_event, state.custom); }
function rangeText() { const r = range(); return `${shortDate(r.start)} – ${timeFormat(r.end - 1, { day: 'numeric', month: 'short', year: 'numeric' })}`; }
function heading(title, description, eyebrow = 'COMMUNITY ANALYTICS') {
  return `<div class="page-heading"><div><div class="eyebrow"><i class="eyebrow-dot"></i>${eyebrow}</div><h1>${title}</h1><p class="page-description">${description}</p></div><div class="page-heading-actions"><a class="button" href="#reports">${icon('reports')}View reports</a><button class="button primary" data-action="export">${icon('download')}Export data</button></div></div>`;
}
function toolbar() {
  return `<div class="toolbar"><span class="range-label">${icon('calendar')}${rangeText()}${state.period === 'all' ? ' <span class="tag">All time</span>' : ''}</span><div class="filters"><div class="segment" aria-label="Date range">${[['7', '7 days'], ['14', '14 days'], ['30', '30 days'], ['all', 'All time']].map(([id, label]) => `<button data-action="period" data-value="${id}" class="${state.period === id ? 'active' : ''}" aria-pressed="${state.period === id}">${label}</button>`).join('')}<button data-action="custom-range" class="${state.period === 'custom' ? 'active' : ''}" aria-pressed="${state.period === 'custom'}">Custom</button></div><select class="select timezone" id="timezoneSelect" aria-label="Timezone"><option value="330"${selected(state.offset, 330)}>IST · UTC+5:30</option><option value="0"${selected(state.offset, 0)}>UTC</option></select></div></div>`;
}
function banners() {
  let html = '';
  if (state.mode === 'sample' && !state.sampleDismissed) html += `<div class="banner">${icon('info')}<span>You’re exploring a sample workspace. Bring your own community into the picture.</span><button data-action="connect">Connect your bot ${icon('arrowRight')}</button><button class="dismiss" data-action="dismiss-sample" aria-label="Dismiss sample explanation">${icon('close')}</button></div>`;
  if (state.error) html += `<div class="banner error" role="alert">${icon('info')}<span>${esc(state.error)}${state.synced && !state.fatal ? ` Last successful sync: ${esc(fullDate(state.synced))} ${zone()}.` : ''}</span><button data-action="refresh">Try again ${icon('refresh')}</button><button data-action="connect">Settings</button></div>`;
  return html;
}
function kpis(data, person = false) {
  const t = data.totals;
  const items = person ? [
    ['Messages sent', number(t.messages), 'message', 'Conversations contributed to'],
    ['Estimated active time', duration(t.minutes), 'clock', 'Online + DND · sessions capped at 6h'],
    ['Voice sessions', number(t.voice), 'voice', 'Recorded voice joins'],
    ['Presence changes', number(t.presence), 'activity', 'Observed status transitions'],
  ] : [
    ['Active members', number(t.active), 'members', `of ${number(t.members)} observed members`],
    ['Messages sent', number(t.messages), 'message', `across ${number(data.channels.filter(c => c.messages).length)} text channels`],
    ['Voice sessions', number(t.voice), 'voice', 'Recorded voice joins'],
    ['Presence changes', number(t.presence), 'activity', 'Observed status transitions'],
  ];
  return `<div class="kpis">${items.map(([label, value, ico, note]) => `<div class="kpi"><div class="kpi-label">${label}${icon(ico)}</div><div class="kpi-value">${value}</div><div class="kpi-note">${note}</div></div>`).join('')}</div>`;
}
function empty(title = 'A quiet window.', description = 'There are no recorded events in this period. Try another date range.', action = 'all-time', label = 'View all time') {
  return `<div class="empty"><span class="empty-icon">${icon('leaf')}</span><h3>${esc(title)}</h3><p>${esc(description)}</p>${action ? `<button class="button" data-action="${action}">${label}${icon('arrowRight')}</button>` : ''}</div>`;
}
function sparkline(values) {
  const max = Math.max(...values, 1), step = 64 / Math.max(values.length - 1, 1);
  return `<svg class="sparkline" viewBox="0 0 66 24" aria-hidden="true"><path d="${values.map((v, i) => `${i ? 'L' : 'M'}${1 + i * step},${21 - v / max * 18}`).join(' ')}"/></svg>`;
}
function chart(data, title = 'The rhythm of your community', subtitle = 'Small moments, seen over time') {
  const metric = state.chart;
  const total = data.series.reduce((sum, p) => sum + p[metric], 0);
  const points = data.series;
  const max = Math.max(...points.map(p => p[metric]), 1);
  const top = Math.ceil(max / 4) * 4;
  const width = 620, left = 42, right = 20, height = 154, base = 176;
  const x = i => left + i / Math.max(points.length - 1, 1) * (width - left - right);
  const y = value => base - value / top * height;
  const coordinates = points.map((p, i) => `${x(i).toFixed(1)},${y(p[metric]).toFixed(1)}`);
  const ticks = [...new Set([0, ...Array.from({ length: Math.min(6, points.length) }, (_, i) => Math.round(i / Math.max(Math.min(6, points.length) - 1, 1) * (points.length - 1)))])];
  return `<section class="panel"><div class="panel-top"><div><h2 class="panel-title">${title}</h2><p class="panel-subtitle">${subtitle}</p></div><div class="panel-tabs" aria-label="Chart metric">${[['events', 'All events'], ['messages', 'Messages'], ['presence', 'Presence']].map(([id, label]) => `<button data-action="chart" data-value="${id}" class="${metric === id ? 'active' : ''}" aria-pressed="${metric === id}">${label}</button>`).join('')}</div></div><div class="chart-summary"><strong>${number(total)}</strong><span>${metric === 'events' ? 'recorded events' : metric === 'messages' ? 'messages sent' : 'status changes'}</span></div><div class="trend-chart"><svg viewBox="0 0 620 205" role="img" aria-label="Daily ${metric}: ${number(total)} total from ${rangeText()}">${[0, 1, 2, 3, 4].map(i => `<line class="chart-grid-line" x1="${left}" y1="${y(i * top / 4)}" x2="600" y2="${y(i * top / 4)}"/><text class="chart-axis" x="30" y="${y(i * top / 4) + 3}" text-anchor="end">${number(i * top / 4)}</text>`).join('')}${total ? `<path class="chart-area" d="M${left},${base} L${coordinates.join(' L')} L${x(points.length - 1)},${base} Z"/><path class="chart-line" d="M${coordinates.join(' L')}"/>${points.length === 1 ? `<circle class="chart-point" cx="${x(0)}" cy="${y(points[0][metric])}" r="3"/>` : ''}` : ''}${ticks.map(i => `<text class="chart-axis" x="${x(i)}" y="198" text-anchor="${i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}">${esc(timeFormat(Date.parse(points[i].date + 'T00:00:00Z') - state.offset * 60000, { month: 'short', day: 'numeric' }))}</text>`).join('')}${points.map((p, i) => `<circle class="chart-hit" cx="${x(i)}" cy="${y(p[metric])}" r="${Math.max(4, Math.min(13, 280 / points.length))}" tabindex="${i === 0 ? 0 : -1}" data-tooltip="${esc(p.date)} · ${number(p[metric])} ${metric}" aria-label="${esc(p.date)}: ${number(p[metric])} ${metric}"><title>${esc(p.date)} · ${number(p[metric])} ${metric}</title></circle>`).join('')}</svg>${!total ? '<div class="chart-empty">No events recorded in this window</div>' : ''}<div class="chart-tooltip" hidden></div></div><div class="chart-foot"><span class="legend-line"></span>${metric === 'events' ? 'All activity' : metric === 'messages' ? 'Messages' : 'Presence changes'}<span class="right">DAILY · ${zone()}</span></div></section>`;
}
function statusPanel(data) {
  const colors = { online: '#568267', idle: '#b29045', dnd: '#b96757', offline: '#b8bcb0', unknown: '#dedfd7' };
  const total = data.members.length, circumference = 276.46;
  let offset = 0;
  const segments = Object.entries(data.statusCounts).map(([key, count]) => {
    const length = count / Math.max(total, 1) * circumference;
    const svg = count ? `<circle cx="63" cy="63" r="44" fill="none" stroke="${colors[key]}" stroke-width="12" stroke-dasharray="${Math.max(0, length - 3)} ${circumference}" stroke-dashoffset="${-offset}"><title>${esc(STATUS[key])}: ${count}</title></circle>` : '';
    offset += length; return svg;
  }).join('');
  return `<section class="panel status-panel"><div class="panel-top"><div><h2 class="panel-title">A snapshot of presence</h2><p class="panel-subtitle">Latest observed status · all recorded members</p></div>${icon('members', 'muted')}</div><div class="status-layout"><div class="donut"><svg viewBox="0 0 126 126" role="img" aria-label="Last observed member statuses"><circle class="donut-bg" cx="63" cy="63" r="44"/>${segments}</svg><div class="donut-value"><strong>${number(total)}</strong><span>MEMBERS OBSERVED</span></div></div><div class="status-legend">${Object.entries(data.statusCounts).filter(([key, count]) => key !== 'unknown' || count).map(([key, count]) => `<div><i class="legend-dot ${key}"></i><span>${esc(STATUS[key])}</span><strong>${count}</strong></div>`).join('')}</div></div><div class="panel-note">${icon('info')}<span>Observed states, not a live headcount. A status can remain unchanged while the bot is offline.</span></div></section>`;
}
function memberRows(members, compact = false) {
  return members.map((m, i) => `<tr><td><div class="member-cell"><span class="rank ${i === 0 ? 'first' : ''}">${String(i + 1).padStart(2, '0')}</span><a href="#member/${encodeURIComponent(m.user_id)}" class="member-cell">${avatar(m)}<div><strong>${esc(m.username)}</strong>${!compact ? `<small>ID ${esc(m.user_id)}</small>` : ''}</div></a></div></td><td>${number(m.messages)}</td><td>${compact ? number(m.events) : duration(m.minutes)}</td><td>${compact ? sparkline(state.data.series.map(p => m.daily[p.date] || 0)) : statusBadge(m)}</td><td><a class="row-arrow" href="#member/${encodeURIComponent(m.user_id)}" aria-label="View report for ${esc(m.username)}">${icon('arrowUpRight')}</a></td></tr>`).join('');
}
function contributors(data) {
  const members = data.members.filter(m => m.events).slice(0, 5);
  return `<section class="panel table-panel"><div class="panel-top"><div><h2 class="panel-title">The familiar faces</h2><p class="panel-subtitle">Members making their presence felt · ranked by events</p></div><a href="#members" class="button text">All members ${icon('arrowRight')}</a></div>${members.length ? `<div class="table-wrap"><table><thead><tr><th>Member</th><th>Messages</th><th>Events</th><th>Activity</th><th></th></tr></thead><tbody>${memberRows(members, true)}</tbody></table></div>` : empty('Room for a conversation.', 'Active members will appear here as your bot records activity.', '', '')}<div class="table-bottom"><span>${number(data.totals.active)} active of ${number(data.totals.members)} observed members</span><a href="#reports" class="button text">Member reports ${icon('arrowUpRight')}</a></div></section>`;
}
function eventDescription(event) {
  if (event.type === 'presence') return `${STATUS[event.old_status] || event.old_status || 'Unknown'} → ${STATUS[event.new_status] || event.new_status}`;
  if (event.type === 'message') return `Sent a message in #${event.channel_name}`;
  if (event.type === 'reaction') return `Added a reaction in #${event.channel_name}`;
  return `${event.type === 'voice_join' ? 'Joined' : event.type === 'voice_leave' ? 'Left' : 'Moved to'} #${event.channel_name}`;
}
function activityFeed(data, count = 5, title = 'A little happening, lately') {
  const events = data.events.slice(0, count);
  return `<section class="panel activity-panel"><div class="panel-top"><div><h2 class="panel-title">${title}</h2><p class="panel-subtitle">The latest moments in the selected window</p></div><span class="tag">${state.mode === 'sample' ? 'Sample' : 'Recorded'}</span></div>${events.length ? `<div class="event-list">${events.map(e => `<div class="event-row"><span class="event-symbol ${e.type}">${icon(e.type.startsWith('voice') ? 'voice' : e.type === 'presence' ? 'activity' : e.type)}</span><div class="event-details"><a href="#member/${encodeURIComponent(e.user_id)}"><strong>${esc(e.username)}</strong></a><p>${esc(eventDescription(e))}</p></div><time datetime="${esc(e.timestamp)}" title="${esc(fullDate(e.ts))} ${zone()}">${esc(relative(e.timestamp))}</time></div>`).join('')}</div>` : empty('Nothing to catch up on.', 'Recorded events will appear here.', '', '')}<div class="table-bottom"><span>${state.mode === 'sample' ? 'Illustrative data' : `Updated ${state.synced ? timeFormat(state.synced, { hour: '2-digit', minute: '2-digit' }) + ' ' + zone() : '—'}`}</span><a href="#activity/${state.route === 'member' ? encodeURIComponent(state.detail) : ''}" class="button text">Activity log ${icon('arrowRight')}</a></div></section>`;
}
function heatmap(data, title = 'When your community comes together') {
  const max = Math.max(...data.heatmap.flat(), 1), days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const level = count => count ? Math.max(1, Math.ceil(count / max * 4)) : 0;
  return `<section class="panel"><div class="panel-top"><div><h2 class="panel-title">${title}</h2><p class="panel-subtitle">All recorded events by day of the week and hour · ${zone()}</p></div>${icon('calendar', 'muted')}</div><div class="heatmap"><div class="heatmap-grid" aria-label="Weekly activity heatmap"><span></span>${Array.from({ length: 24 }, (_, h) => `<span class="heatmap-hour">${h % 3 === 0 ? String(h).padStart(2, '0') : ''}</span>`).join('')}${data.heatmap.map((hours, d) => `<span class="heatmap-label">${days[d]}</span>${hours.map((count, h) => `<div class="heatmap-cell level-${level(count)}" tabindex="${d === 0 && h === 0 ? 0 : -1}" role="img" aria-label="${days[d]} ${String(h).padStart(2, '0')}:00 ${zone()}: ${count} events" title="${days[d]} · ${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00 ${zone()} · ${number(count)} events"></div>`).join('')}`).join('')}</div><div class="heatmap-bottom"><span>A pattern of recorded activity, aggregated across the selected dates.</span><div class="heatmap-legend">Less ${['#eff1e7', '#dee4d1', '#bac7a4', '#92a67a', '#697f53'].map(c => `<i style="background:${c}"></i>`).join('')} More</div></div></div></section>`;
}
function overview() {
  const d = state.data, peak = d.totals.peakHour;
  const busiest = d.channels[0];
  const activeDay = [...d.series].sort((a, b) => b.events - a.events)[0];
  return heading('The Server’s <em>pulse.</em>', `A closer look at the people and moments that make ${esc(community())}.`)
    + banners() + toolbar() + kpis(d)
    + (!d.events.length ? `<div class="banner">${icon('clock')}<span>No activity was recorded in this window.${state.meta?.last_event ? ` Latest available record: ${esc(fullDate(Date.parse(state.meta.last_event)))} ${zone()}.` : ''}</span><button data-action="all-time">View all time ${icon('arrowRight')}</button></div>` : '')
    + `<div class="dashboard-grid">${chart(d)}${statusPanel(d)}</div><div class="dashboard-grid">${contributors(d)}${activityFeed(d)}</div>`
    + `<div class="insight-strip"><div class="insight">${icon('clock')}<div><p>Your busiest hour</p><strong>${peak === null ? 'Still taking shape' : `${String(peak).padStart(2, '0')}:00–${String(peak + 1).padStart(2, '0')}:00 ${zone()}`}</strong></div></div><div class="insight">${icon('channels')}<div><p>Where it’s happening</p><strong>${busiest ? '#' + esc(busiest.name) : 'No channel activity yet'}</strong></div></div><div class="insight">${icon('calendar')}<div><p>The most active day</p><strong>${activeDay?.events ? esc(shortDate(Date.parse(activeDay.date + 'T00:00Z') - state.offset * 60000)) : 'Waiting for a little activity'}</strong></div></div></div>` + heatmap(d);
}
function filteredMembers() {
  const q = state.memberSearch.toLocaleLowerCase().trim();
  return state.data.members.filter(m => (!q || `${m.username} ${m.user_id}`.toLocaleLowerCase().includes(q)) && (state.memberStatus === 'all' || m.status === state.memberStatus))
    .sort((a, b) => state.memberSort === 'name' ? a.username.localeCompare(b.username) : b[state.memberSort] - a[state.memberSort]);
}
function pageFooter(total, page, size, prefix) {
  const pages = Math.max(1, Math.ceil(total / size));
  return `<div class="table-bottom"><span>${total ? `${number((page - 1) * size + 1)}–${number(Math.min(page * size, total))} of ${number(total)}` : '0 results'}</span><div class="pagination"><button data-action="${prefix}-page" data-value="${page - 1}" ${page === 1 ? 'disabled' : ''} aria-label="Previous page">${icon('chevronLeft')}</button><span>${page} / ${pages}</span><button data-action="${prefix}-page" data-value="${page + 1}" ${page >= pages ? 'disabled' : ''} aria-label="Next page">${icon('chevronRight')}</button></div></div>`;
}
function membersPage() {
  const members = filteredMembers(), size = 12;
  state.memberPage = Math.min(state.memberPage, Math.max(1, Math.ceil(members.length / size)));
  return heading('People make the <em>place.</em>', 'Every familiar name, with a story in the details.', 'MEMBER DIRECTORY') + banners() + toolbar()
    + `<section class="panel"><div class="list-toolbar"><label class="search-field">${icon('search')}<input id="memberSearch" type="search" placeholder="Search names or Discord IDs…" value="${esc(state.memberSearch)}" aria-label="Search members"></label><select class="select" id="memberStatus" aria-label="Filter by last observed status"><option value="all">All observed statuses</option>${Object.entries(STATUS).map(([key, value]) => `<option value="${key}"${selected(state.memberStatus, key)}>${value}</option>`).join('')}</select><select class="select" id="memberSort" aria-label="Sort members">${[['events', 'Most activity'], ['messages', 'Most messages'], ['minutes', 'Active time'], ['name', 'Name A–Z']].map(([key, label]) => `<option value="${key}"${selected(state.memberSort, key)}>${label}</option>`).join('')}</select><span class="push">${number(members.length)} members</span></div>${members.length ? `<div class="table-wrap"><table><thead><tr><th>Member</th><th>Messages</th><th>Est. active time</th><th>Last observed status</th><th></th></tr></thead><tbody>${memberRows(members.slice((state.memberPage - 1) * size, state.memberPage * size))}</tbody></table></div>` : empty('No familiar faces here.', 'Try another name or status filter.', '', '')}${pageFooter(members.length, state.memberPage, size, 'member')}<div class="panel-note">${icon('info')}<span>Only members observed by the bot are listed. Estimated active time includes online and DND states, capped at 6 hours per continuous session. Opted-out members are excluded.</span></div></section>`;
}
function timeline(data) {
  const days = data.series.slice(-7);
  return `<section class="panel"><div class="panel-top"><div><h2 class="panel-title">Observed active windows</h2><p class="panel-subtitle">Online + DND estimates · most recent 7 days in this range · ${zone()}</p></div></div><div class="timeline">${days.map(day => {
    const start = Date.parse(day.date + 'T00:00:00Z') - state.offset * 60000;
    const slices = data.sessions.filter(s => s.end > start && s.start < start + DAY);
    return `<div class="timeline-row"><span>${esc(timeFormat(start, { day: 'numeric', month: 'short' }))}</span><div class="timeline-track" aria-label="${esc(day.date)}: ${duration(day.minutes)} estimated active">${slices.map(s => `<i style="left:${Math.max(0, (s.start - start) / DAY * 100)}%;width:${(Math.min(s.end, start + DAY) - Math.max(s.start, start)) / DAY * 100}%" title="${esc(fullDate(Math.max(s.start, start)))} – ${esc(timeFormat(Math.min(s.end, start + DAY), { hour: '2-digit', minute: '2-digit' }))} ${zone()}"></i>`).join('')}</div></div>`;
  }).join('')}<div class="timeline-axis"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div></div><div class="panel-note">${icon('info')}<span>Blank space means no estimated active session. It does not establish that a member was offline.</span></div></section>`;
}
function memberPage() {
  const member = state.data.members.find(m => m.user_id === state.detail);
  if (!member) return heading('A missing <em>face.</em>', 'This member is not available in this workspace.') + empty('Member not found.', 'Choose a member from the current server’s directory.', 'go-members', 'Browse members');
  const d = analyze(state.snapshot, range(), member.user_id);
  return `<a class="back-link" href="#members">${icon('arrowLeft')}Back to members</a><div class="profile-heading">${avatar(member, 'large')}<div><div class="eyebrow">MEMBER REPORT</div><h1>${esc(member.username)}</h1><div class="profile-meta"><span>ID ${esc(member.user_id)}</span>${statusBadge(member)}<span>Last observed ${esc(relative(member.last_seen))}</span></div></div><div class="profile-actions"><button class="button" data-action="member-report">${icon('reports')}Full report</button><button class="button primary" data-action="export">${icon('download')}Export CSV</button></div></div>`
    + banners() + toolbar() + kpis(d, true)
    + `<div class="detail-grid">${chart(d, 'A personal rhythm', 'Recorded activity throughout the selected period')}<section class="panel"><div class="panel-top"><h2 class="panel-title">In a little more detail</h2>${icon('members', 'muted')}</div><div class="metric-rows">${[['Total events', number(d.totals.events)], ['Active days', number(d.members[0]?.active_days)], ['Reactions', number(d.totals.reactions)], ['Channels visited', number(d.channels.length)], ['Busiest hour', d.totals.peakHour === null ? 'Unobserved' : `${String(d.totals.peakHour).padStart(2, '0')}:00 ${zone()}`], ['Last seen', esc(fullDate(Date.parse(member.last_seen))) + ' ' + zone()]].map(([label, value]) => `<div class="metric-row"><span>${label}</span><strong>${value}</strong></div>`).join('')}</div></section></div><div class="detail-grid">${timeline(d)}${activityFeed(d, 5, 'Their latest moments')}</div>${heatmap(d, 'A familiar pattern')}`;
}
function channelRows(channels) {
  const total = state.data.channelEvents.length;
  return channels.map(c => `<tr><td><a href="#channel/${encodeURIComponent(c.id)}" class="channel-name"><span class="channel-hash">${c.voice && !c.messages ? icon('voice') : '#'}</span>${esc(c.name)}</a></td><td>${number(c.messages)}</td><td>${number(c.reactions)}</td><td>${number(c.voice)}</td><td>${number(c.people)}</td><td><span class="share-bar"><span class="share-track"><i style="width:${c.events / Math.max(1, total) * 100}%"></i></span>${Math.round(c.events / Math.max(1, total) * 100)}%</span></td><td><a class="row-arrow" href="#channel/${encodeURIComponent(c.id)}" aria-label="View channel ${esc(c.name)}">${icon('arrowUpRight')}</a></td></tr>`).join('');
}
function channelsPage() {
  const channels = state.data.channels.filter(c => c.name.toLocaleLowerCase().includes(state.channelSearch.toLocaleLowerCase().trim()));
  return heading('Where the conversation <em>lives.</em>', 'A room-by-room view of the community.', 'CHANNEL ANALYTICS') + banners() + toolbar()
    + `<div class="insight-strip"><div class="insight">${icon('channels')}<div><p>Observed channels</p><strong>${number(state.data.channels.length)}</strong></div></div><div class="insight">${icon('message')}<div><p>Messages this period</p><strong>${number(state.data.totals.messages)}</strong></div></div><div class="insight">${icon('reaction')}<div><p>Reactions this period</p><strong>${number(state.data.totals.reactions)}</strong></div></div></div><section class="panel"><div class="list-toolbar"><label class="search-field">${icon('search')}<input type="search" id="channelSearch" value="${esc(state.channelSearch)}" placeholder="Find a channel…" aria-label="Search channels"></label><span class="push">${channels.length} channels · ranked by events</span></div>${channels.length ? `<div class="table-wrap"><table><thead><tr><th>Channel</th><th>Messages</th><th>Reactions</th><th>Voice joins</th><th>Members</th><th>Share of activity</th><th></th></tr></thead><tbody>${channelRows(channels)}</tbody></table></div>` : empty('A room waiting to fill.', state.channelSearch ? 'Try a different channel name.' : 'Channels appear when your bot records messages, reactions, or voice events.', state.channelSearch ? '' : 'all-time', 'View all time')}<div class="panel-note">${icon('info')}<span>Channel activity is based on recorded metadata. Message content is not collected by this dashboard.</span></div></section>`;
}
function channelPage() {
  const c = state.data.channels.find(c => c.id === state.detail);
  if (!c) return heading('An empty <em>room.</em>', 'This channel has no recorded activity in the current date range.') + toolbar() + empty('No events for this channel.', 'Try a wider date range or browse the other channels.', 'go-channels', 'Browse channels');
  const events = state.data.events.filter(e => e.channel_id === c.id);
  const data = { ...state.data, events, series: state.data.series.map(p => ({ ...p, events: c.daily[p.date] || 0,
    messages: events.filter(e => e.type === 'message' && dateKey(e.ts, state.offset) === p.date).length, presence: 0 })) };
  return `<a class="back-link" href="#channels">${icon('arrowLeft')}Back to channels</a>` + heading(`#${esc(c.name)}`, 'The people and moments keeping this room alive.', 'CHANNEL REPORT') + banners() + toolbar()
    + `<div class="kpis">${[['Messages', c.messages], ['Reactions', c.reactions], ['Voice joins', c.voice], ['Contributors', c.people]].map(([label, value]) => `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${number(value)}</div><div class="kpi-note">In the selected window</div></div>`).join('')}</div><div class="dashboard-grid">${chart(data, 'The conversation over time', 'Recorded channel events, day by day')}${activityFeed(data, 5, 'Latest in this room')}</div><section class="panel table-panel"><div class="panel-top"><div><h2 class="panel-title">People in the conversation</h2><p class="panel-subtitle">Member contributions to this channel</p></div></div><div class="table-wrap"><table><thead><tr><th>Member</th><th>Channel events</th><th>Messages</th><th></th></tr></thead><tbody>${state.data.members.map(m => ({ ...m, channelEvents: events.filter(e => e.user_id === m.user_id) })).filter(m => m.channelEvents.length).sort((a, b) => b.channelEvents.length - a.channelEvents.length).map(m => `<tr><td><a class="member-cell" href="#member/${encodeURIComponent(m.user_id)}">${avatar(m)}${esc(m.username)}</a></td><td>${number(m.channelEvents.length)}</td><td>${number(m.channelEvents.filter(e => e.type === 'message').length)}</td><td><a class="row-arrow" href="#member/${encodeURIComponent(m.user_id)}" aria-label="View ${esc(m.username)}">${icon('arrowUpRight')}</a></td></tr>`).join('')}</tbody></table></div></section>`;
}
function visibleEvents() { return filterEvents(state.data.events, { search: state.eventSearch, type: state.eventType, user: state.eventUser }); }
function eventTable(events) {
  return `<div class="table-wrap"><table><thead><tr><th>Member</th><th>Event</th><th>Detail</th><th>Recorded at · ${zone()}</th></tr></thead><tbody>${events.map(e => `<tr><td><a href="#member/${encodeURIComponent(e.user_id)}" class="member-cell">${avatar(e, 'small')}<strong>${esc(e.username)}</strong></a></td><td><span class="tag">${esc(EVENT_LABEL[e.type] || e.type)}</span></td><td>${esc(eventDescription(e))}</td><td title="${esc(e.timestamp)}">${esc(fullDate(e.ts))}</td></tr>`).join('')}</tbody></table></div>`;
}
function activityPage() {
  const events = visibleEvents(), size = 20;
  state.eventPage = Math.min(state.eventPage, Math.max(1, Math.ceil(events.length / size)));
  return heading('The moments <em>in between.</em>', 'A searchable record of presence, conversations, and drop-ins.', 'ACTIVITY LOG') + banners() + toolbar()
    + `<section class="panel"><div class="list-toolbar"><label class="search-field">${icon('search')}<input type="search" id="eventSearch" value="${esc(state.eventSearch)}" placeholder="Search names, channels, statuses…" aria-label="Search activity"></label><select class="select" id="eventType" aria-label="Filter event type">${[['all', 'All event types'], ['presence', 'Presence changes'], ['message', 'Messages'], ['reaction', 'Reactions'], ['voice', 'Voice activity']].map(([value, label]) => `<option value="${value}"${selected(state.eventType, value)}>${label}</option>`).join('')}</select><select class="select" id="eventUser" aria-label="Filter events by member"><option value="all">All members</option>${state.data.members.map(m => `<option value="${esc(m.user_id)}"${selected(state.eventUser, m.user_id)}>${esc(m.username)}</option>`).join('')}</select><span class="push">${number(events.length)} events</span></div>${events.length ? eventTable(events.slice((state.eventPage - 1) * size, state.eventPage * size)) : empty('Nothing in this window.', 'Try another filter or date range.', '', '')}${pageFooter(events.length, state.eventPage, size, 'event')}<div class="panel-note">${icon('info')}<span>Exports include every matching event in the loaded range, across all pages. Times are displayed in ${zone()}; exported timestamps retain their original timezone.</span></div></section>`;
}
function reportData() { return state.report === 'member' && state.reportUser !== 'all' ? analyze(state.snapshot, range(), state.reportUser) : state.data; }
function reportsPage() {
  const d = reportData(), t = d.totals, reportMember = d.members.find(m => m.user_id === state.reportUser);
  const title = state.report === 'member' ? (reportMember ? `${esc(reportMember.username)} / Activity report` : 'Member activity report') : state.report === 'channels' ? 'Channel activity report' : 'Community field notes';
  return heading('A clearer <em>picture.</em>', 'Useful reports for your community. Ready to take with you.', 'REPORT STUDIO') + banners() + toolbar()
    + `<div class="report-options">${[['summary', 'overview', 'Community summary', 'The full picture, in a single report.'], ['member', 'members', 'Member report', 'Individual activity, habits, and contributions.'], ['channels', 'channels', 'Channel report', 'See where your community comes together.']].map(([value, ico, label, detail]) => `<button class="report-option ${state.report === value ? 'active' : ''}" data-action="report-type" data-value="${value}" aria-pressed="${state.report === value}"><span>${icon(ico)}</span><strong>${label}</strong><small>${detail}</small></button>`).join('')}</div><section class="panel"><div class="list-toolbar"><div class="report-actions"><button class="button primary" data-action="export">${icon('download')}Download CSV</button><button class="button" data-action="json">${icon('reports')}JSON</button><button class="button" data-action="print">${icon('print')}Print / PDF</button></div>${state.report === 'member' ? `<select class="select report-member-select" id="reportUser" aria-label="Select member for report"><option value="all">All members</option>${state.data.members.map(m => `<option value="${esc(m.user_id)}"${selected(state.reportUser, m.user_id)}>${esc(m.username)}</option>`).join('')}</select>` : '<span class="push">REPORT PREVIEW</span>'}</div><div class="report-preview"><div class="report-masthead"><div><div class="eyebrow">PRESENCE / ${state.mode === 'sample' ? 'SAMPLE REPORT' : 'COMMUNITY INTELLIGENCE'}</div><h2>${title}</h2><p>${esc(community())} · ${rangeText()} · ${zone()}</p></div><span>GENERATED ${esc(shortDate(Date.now()))}<br>${state.mode === 'sample' ? 'ILLUSTRATIVE WORKSPACE' : 'COMPLETE SELECTED WINDOW'}</span></div><p class="report-summary">${reportMember ? `<strong>${esc(reportMember.username)}</strong> contributed` : 'This window contains'} <strong>${number(t.events)} recorded events</strong>${reportMember ? '' : ` from <strong>${number(t.active)} active members</strong>`}, including <strong>${number(t.messages)} messages</strong> and <strong>${number(t.voice)} voice joins</strong>. ${d.channels.length ? `Activity was recorded across <strong>${number(d.channels.length)} channels</strong>.` : 'No channel activity was recorded.'}</p><div class="report-kpis">${[['Recorded events', number(t.events)], ['Messages', number(t.messages)], ['Voice joins', number(t.voice)], ['Est. active time', duration(t.minutes)]].map(([label, value]) => `<div><p>${label}</p><strong>${value}</strong></div>`).join('')}</div>${state.report === 'channels' ? `<h3>Channel breakdown</h3>${d.channels.length ? `<div class="table-wrap"><table><thead><tr><th>Channel</th><th>Messages</th><th>Reactions</th><th>Voice joins</th><th>Members</th></tr></thead><tbody>${d.channels.map(c => `<tr><td><strong>#${esc(c.name)}</strong></td><td>${number(c.messages)}</td><td>${number(c.reactions)}</td><td>${number(c.voice)}</td><td>${number(c.people)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="no-data-note">No channel records in this period.</p>'}` : `<h3>${state.report === 'member' ? 'Member breakdown' : 'Community contributors'}</h3>${d.members.length ? `<div class="table-wrap"><table><thead><tr><th>Member</th><th>Events</th><th>Messages</th><th>Voice joins</th><th>Est. active time</th></tr></thead><tbody>${d.members.map(m => `<tr><td><strong>${esc(m.username)}</strong></td><td>${number(m.events)}</td><td>${number(m.messages)}</td><td>${number(m.voice)}</td><td>${duration(m.minutes)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="no-data-note">No member records available.</p>'}`}<p class="report-footnote">${state.mode === 'sample' ? 'SAMPLE DATA. This report is illustrative and does not represent your Discord community. ' : ''}Presence reflects the latest observed status, not guaranteed current availability. Active time is estimated from online and DND transitions, capped at 6 hours per continuous session and clipped to the report window. Unobserved time is unknown. Opted-out members are excluded by the API. CSV exports retain Discord IDs as text values; import ID columns as text in spreadsheet software.</p></div></section>`;
}

function render() {
  if (!state.data) return;
  const active = document.activeElement;
  const focus = active?.id, selection = active?.selectionStart;
  const page = state.route;
  document.querySelectorAll('[data-page]').forEach(a => {
    const yes = a.dataset.page === (page === 'member' ? 'members' : page === 'channel' ? 'channels' : page);
    a.classList.toggle('active', yes);
    if (yes) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $('#breadcrumb').textContent = ({ overview: 'Overview', members: 'Members', member: 'Member report', channels: 'Channels', channel: 'Channel report', activity: 'Activity log', reports: 'Reports' })[page];
  document.title = `${$('#breadcrumb').textContent} — Presence`;
  $('#workspaceName').textContent = community();
  $('#workspaceMark').textContent = community().slice(0, 1).toUpperCase();
  $('#memberCount').textContent = state.data.members.length;
  $('#guildSelect').innerHTML = (state.meta?.guilds || []).map(g => `<option value="${esc(g.id)}"${selected(state.guild, g.id)}>${esc(g.name)}</option>`).join('');
  $('#guildSelect').disabled = state.mode === 'sample' || !state.meta?.guilds.length;
  $('#sourceLabel').textContent = state.error ? 'Connection interrupted' : state.mode === 'sample' ? 'Sample workspace' : 'API connected';
  $('#sourceDot').className = `status-dot ${state.error ? 'error' : state.mode === 'sample' ? 'sample' : ''}`;
  $('#footerSource').textContent = state.mode === 'sample' ? 'SAMPLE WORKSPACE / ILLUSTRATIVE DATA' : `READ-ONLY API / REFRESHES EVERY ${Math.max(15, Number(config.refreshSeconds) || 30)}s`;
  const views = { overview, members: membersPage, member: memberPage, channels: channelsPage, channel: channelPage, activity: activityPage, reports: reportsPage };
  $('#main').innerHTML = state.fatal ? heading('A moment of <em>disconnect.</em>', 'The selected view could not be loaded.') + banners() + toolbar() + empty('Let’s reconnect.', 'Check your API address, access token, or date range. Your last good snapshot has been kept in memory.', 'connect', 'Connection settings') : views[page]();
  if (focus && document.getElementById(focus) && focus !== 'guildSelect') {
    const node = document.getElementById(focus); node.focus({ preventScroll: true });
    try { if (selection !== null) node.setSelectionRange(selection, selection); } catch {}
  }
}
function routeChanged() {
  let [page, detail = ''] = location.hash.slice(1).split('/');
  if (!['overview', 'members', 'member', 'channels', 'channel', 'activity', 'reports'].includes(page)) page = 'overview';
  state.route = page;
  try { state.detail = decodeURIComponent(detail); } catch { state.detail = ''; }
  if (page === 'activity' && state.detail) { state.eventUser = state.detail; state.eventPage = 1; state.eventSearch = ''; state.eventType = 'all'; }
  $('#sidebar').classList.remove('open'); $('#sidebarOverlay').classList.remove('show');
  $('.mobile-menu').setAttribute('aria-expanded', 'false');
  $('#searchResults').hidden = true; $('#globalSearch').setAttribute('aria-expanded', 'false');
  render(); window.scrollTo({ top: 0, behavior: 'instant' });
}
function validateBase(value) {
  if (!value.trim()) return '';
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP or HTTPS API address without credentials, query parameters, or fragments.');
  if (location.protocol === 'https:' && url.protocol !== 'https:') throw new Error('Use an HTTPS API address when this dashboard is on HTTPS.');
  return url.href.replace(/\/$/, '');
}
async function api(path, base = state.base, token = state.token) {
  const response = await fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(15000), cache: 'no-store' });
  let data;
  try { data = await response.json(); } catch { throw new Error('That address did not return the Presence API. Check the API address in Connection settings.'); }
  if (!response.ok) throw new Error(data.error || `API returned HTTP ${response.status}`);
  return data;
}
function validateMeta(meta) { if (meta.version !== 1 || !Array.isArray(meta.guilds)) throw new Error('This API uses an unsupported dashboard format.'); }
function validateSnapshot(snapshot) {
  validateMeta(snapshot.meta || {});
  if (!snapshot.meta.complete || !['members', 'presence_logs', 'channel_logs'].every(key => Array.isArray(snapshot[key]))) throw new Error('The API returned an incomplete dataset.');
  for (const event of [...snapshot.members, ...snapshot.presence_logs, ...snapshot.channel_logs]) {
    if (typeof event.user_id !== 'string') throw new Error('The API must return Discord IDs as strings to preserve their precision.');
  }
}
async function refresh(background = false) {
  const request = ++state.request;
  state.busy = true;
  $('.sync-button').classList.add('busy');
  $('.sync-button').disabled = true;
  try {
    let meta, snapshot;
    if (state.mode === 'sample') { snapshot = createSample(); meta = snapshot.meta; state.guild = meta.guilds[0].id; }
    else {
      const requestedGuild = state.guild;
      meta = await api('/api/meta' + (requestedGuild ? '?guild_id=' + encodeURIComponent(requestedGuild) : '')); validateMeta(meta);
      if (request !== state.request) return;
      if (!meta.guilds.some(g => g.id === state.guild)) state.guild = meta.guilds[0]?.id || '';
      if (state.guild !== requestedGuild && meta.guilds.length > 1) meta = await api('/api/meta?guild_id=' + encodeURIComponent(state.guild));
      const windowRange = getRange(state.period, state.offset, meta.first_event, state.custom);
      const qs = new URLSearchParams({ from: new Date(windowRange.start).toISOString(), to: new Date(windowRange.end).toISOString() });
      if (state.guild) qs.set('guild_id', state.guild);
      snapshot = await api(`/api/snapshot?${qs}`); validateSnapshot(snapshot);
    }
    if (request !== state.request) return;
    state.meta = snapshot.meta; state.snapshot = snapshot;
    state.data = analyze(snapshot, range()); state.synced = Date.now(); state.error = ''; state.fatal = false;
    if (state.mode === 'live') save('guild', state.guild);
    render(); $('#appStatus').textContent = `Dashboard updated. ${number(state.data.totals.events)} events in the selected window.`;
  } catch (error) {
    if (request !== state.request) return;
    state.error = error.message || 'Could not reach the API. Check the connection settings.';
    state.fatal = !background;
    if (!state.data) {
      const blank = { meta: { guilds: [], first_event: null }, presence_logs: [], channel_logs: [], members: [] };
      state.meta = blank.meta; state.snapshot = blank; state.data = analyze(blank, range());
    }
    render();
  } finally {
    if (request === state.request) { state.busy = false; $('.sync-button').classList.remove('busy'); $('.sync-button').disabled = false; }
  }
}
function changePeriod(period) { state.period = period; save('period', period); state.memberPage = 1; state.eventPage = 1; refresh(); }
function openConnection() {
  $('#apiUrl').value = state.base; $('#apiToken').value = state.token; $('#serverName').value = state.name;
  $('#connectionError').textContent = ''; $('#connectionDialog').showModal();
}
function exportRows() {
  const memberRows = members => members.map(m => ({ user_id: m.user_id, username: m.username, events: m.events, messages: m.messages,
    reactions: m.reactions, voice_joins: m.voice, estimated_active_minutes: Number(m.minutes.toFixed(1)), active_days: m.active_days,
    last_observed_status: m.status, last_observed_at: m.last_seen, period_start: new Date(range().start).toISOString(),
    period_end_exclusive: new Date(range().end).toISOString(), data_source: state.mode }));
  const channelRows = channels => channels.map(c => ({ channel_id: c.id, channel_name: c.name, events: c.events, messages: c.messages,
    reactions: c.reactions, voice_joins: c.voice, contributors: c.people, data_source: state.mode }));
  const eventRows = events => events.map(e => ({ id: e.id, guild_id: e.guild_id, user_id: e.user_id, username: e.username,
    event_type: e.type, channel_id: e.channel_id || '', channel_name: e.channel_name || '', old_status: e.old_status || '',
    new_status: e.new_status || '', timestamp: e.timestamp, data_source: state.mode }));
  if (state.route === 'activity') return eventRows(visibleEvents());
  if (state.route === 'members') return memberRows(filteredMembers());
  if (state.route === 'member') return memberRows(state.data.members.filter(m => m.user_id === state.detail));
  if (state.route === 'channel') return eventRows(state.data.events.filter(e => e.channel_id === state.detail));
  if (state.route === 'channels') return channelRows(state.data.channels.filter(c => c.name.toLocaleLowerCase().includes(state.channelSearch.toLocaleLowerCase().trim())));
  if (state.route === 'reports') {
    const d = reportData();
    if (state.report === 'member') return memberRows(d.members);
    if (state.report === 'channels') return channelRows(d.channels);
    return [{ community: community(), data_source: state.mode, period_start: new Date(range().start).toISOString(),
      period_end_exclusive: new Date(range().end).toISOString(), timezone: zone(), ...d.totals,
      minutes: Number(d.totals.minutes.toFixed(1)) }];
  }
  return memberRows(state.data.members);
}
function download(contents, extension, mime) {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = `presence-${state.mode === 'sample' ? 'sample-' : ''}${state.route}-${dateKey(Date.now(), state.offset)}.${extension}`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Your ${extension.toUpperCase()} report is ready.`);
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.action, value = button.dataset.value;
  if (action === 'connect') openConnection();
  if (action === 'close-dialog') button.closest('dialog').close();
  if (action === 'refresh') refresh(true);
  if (action === 'period') changePeriod(value);
  if (action === 'all-time') changePeriod('all');
  if (action === 'chart') { state.chart = value; render(); }
  if (action === 'custom-range') {
    $('#rangeFrom').value = state.custom.from || dateKey(range().start, state.offset);
    $('#rangeTo').value = state.custom.to || dateKey(range().end - 1, state.offset);
    $('#rangeFrom').max = dateKey(Date.now(), state.offset); $('#rangeTo').max = dateKey(Date.now(), state.offset);
    $('#rangeError').textContent = ''; $('#rangeDialog').showModal();
  }
  if (action === 'sample') {
    state.mode = 'sample'; save('mode', 'sample'); state.sampleDismissed = false;
    $('#connectionDialog').close(); refresh(); toast('Sample workspace opened. All data is illustrative.');
  }
  if (action === 'dismiss-sample') { state.sampleDismissed = true; render(); }
  if (action === 'menu') {
    const open = !$('#sidebar').classList.contains('open');
    $('#sidebar').classList.toggle('open', open); $('#sidebarOverlay').classList.toggle('show', open);
    button.setAttribute('aria-expanded', String(open));
  }
  if (action === 'member-page') { state.memberPage = Number(value); render(); }
  if (action === 'event-page') { state.eventPage = Number(value); render(); }
  if (action === 'report-type') { state.report = value; render(); }
  if (action === 'go-members') location.hash = '#members';
  if (action === 'go-channels') location.hash = '#channels';
  if (action === 'member-report') { state.report = 'member'; state.reportUser = state.detail; location.hash = '#reports'; }
  if (action === 'export') {
    const rows = exportRows();
    if (!rows.length) { toast('No records match this view. Adjust your filters first.'); return; }
    download(csv(rows), 'csv', 'text/csv;charset=utf-8');
  }
  if (action === 'json') {
    const d = reportData();
    download(JSON.stringify({ source: state.mode, community: community(), generated_at: new Date().toISOString(),
      range: { from: new Date(range().start).toISOString(), to_exclusive: new Date(range().end).toISOString(), timezone: zone() },
      totals: d.totals, rows: exportRows(), methodology: 'Active time is estimated from online/DND transitions, capped at six hours per continuous session.' }, null, 2), 'json', 'application/json');
  }
  if (action === 'print') window.print();
});
$('#sidebarOverlay').addEventListener('click', () => { $('#sidebar').classList.remove('open'); $('#sidebarOverlay').classList.remove('show'); $('.mobile-menu').setAttribute('aria-expanded', 'false'); });
document.addEventListener('change', event => {
  const { id, value } = event.target;
  if (id === 'guildSelect') { state.guild = value; state.name = ''; save('name', ''); refresh(); return; }
  if (id === 'timezoneSelect') { state.offset = Number(value); save('offset', value); refresh(); return; }
  const fields = { memberStatus: 'memberStatus', memberSort: 'memberSort', eventType: 'eventType', eventUser: 'eventUser', reportUser: 'reportUser' };
  if (fields[id]) { state[fields[id]] = value; state.memberPage = 1; state.eventPage = 1; render(); }
});
document.addEventListener('input', event => {
  const { id, value } = event.target;
  if (['memberSearch', 'channelSearch', 'eventSearch'].includes(id)) { state[id] = value; state.memberPage = 1; state.eventPage = 1; render(); }
  if (id === 'globalSearch') {
    const term = value.toLocaleLowerCase().trim();
    const results = state.data?.members.filter(m => `${m.username} ${m.user_id}`.toLocaleLowerCase().includes(term)).slice(0, 6) || [];
    $('#searchResults').innerHTML = results.length ? results.map(m => `<a href="#member/${encodeURIComponent(m.user_id)}">${avatar(m, 'small')}<div>${esc(m.username)}<small>View member report</small></div>${icon('arrowUpRight')}</a>`).join('') : '<p>No matching members</p>';
    $('#searchResults').hidden = !term; event.target.setAttribute('aria-expanded', String(!!term));
  }
});
document.addEventListener('click', event => { if (!event.target.closest('.global-search')) { $('#searchResults').hidden = true; $('#globalSearch').setAttribute('aria-expanded', 'false'); } });
document.addEventListener('keydown', event => {
  const cell = event.target.closest('.heatmap-cell, [data-tooltip]');
  if (cell && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    const heatmap = cell.classList.contains('heatmap-cell');
    const cells = [...cell.closest(heatmap ? '.heatmap-grid' : '.trend-chart').querySelectorAll(heatmap ? '.heatmap-cell' : '[data-tooltip]')];
    const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: heatmap ? -24 : -1, ArrowDown: heatmap ? 24 : 1 })[event.key];
    const target = cells[Math.max(0, Math.min(cells.length - 1, cells.indexOf(cell) + step))];
    event.preventDefault(); cell.tabIndex = -1; target.tabIndex = 0; target.focus({ preventScroll: true });
  }
  if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !document.querySelector('dialog[open]')) { event.preventDefault(); $('#globalSearch').focus(); }
  if (event.key === 'Escape') { $('#searchResults').hidden = true; $('#globalSearch').setAttribute('aria-expanded', 'false'); $('#sidebar').classList.remove('open'); $('#sidebarOverlay').classList.remove('show'); $('.mobile-menu').setAttribute('aria-expanded', 'false'); }
  if (event.key === 'ArrowDown' && document.activeElement.id === 'globalSearch' && !$('#searchResults').hidden) { event.preventDefault(); $('#searchResults a')?.focus(); }
  if (event.key === 'Enter' && document.activeElement.id === 'globalSearch' && !$('#searchResults').hidden && $('#searchResults a')) { event.preventDefault(); location.hash = $('#searchResults a').getAttribute('href'); }
});
function showChartTip(event) {
  const node = event.target.closest('[data-tooltip]');
  if (!node) return;
  const tooltip = node.closest('.trend-chart').querySelector('.chart-tooltip');
  tooltip.textContent = node.dataset.tooltip; tooltip.hidden = false;
}
function hideChartTip(event) { const node = event.target.closest('[data-tooltip]'); if (node) node.closest('.trend-chart').querySelector('.chart-tooltip').hidden = true; }
document.addEventListener('pointerover', showChartTip); document.addEventListener('focusin', showChartTip);
document.addEventListener('pointerout', hideChartTip); document.addEventListener('focusout', hideChartTip);
$('#rangeForm').addEventListener('submit', event => {
  event.preventDefault(); const from = $('#rangeFrom').value, to = $('#rangeTo').value;
  if (from > to) { $('#rangeError').textContent = 'Choose an end date on or after the start date.'; return; }
  if (Date.parse(to) - Date.parse(from) > 3660 * DAY) { $('#rangeError').textContent = 'Choose a range shorter than 10 years.'; return; }
  state.custom = { from, to }; save('from', from); save('to', to); $('#rangeDialog').close(); changePeriod('custom');
});
$('#connectionForm').addEventListener('submit', async event => {
  event.preventDefault(); $('#connectionError').textContent = ''; $('#connectSubmit').disabled = true;
  try {
    const base = validateBase($('#apiUrl').value), token = $('#apiToken').value.trim();
    const meta = await api('/api/meta', base, token); validateMeta(meta);
    state.base = base; state.token = token; state.name = $('#serverName').value.trim(); state.mode = 'live';
    save('api', base); save('name', state.name); save('mode', 'live');
    try { sessionStorage.setItem('presence.token', token); } catch {}
    $('#connectionDialog').close(); await refresh();
    if (!state.error) toast('Connected. Your community is in the picture.');
  } catch (error) { $('#connectionError').textContent = error.message || 'Could not connect to this API.'; }
  finally { $('#connectSubmit').disabled = false; }
});
window.addEventListener('hashchange', routeChanged);
async function boot() {
  routeChanged();
  if (new URLSearchParams(location.search).get('demo') === '1') state.mode = 'sample';
  if (state.mode === 'live' && !state.base && !stored('mode') && !new URLSearchParams(location.search).has('live')) {
    // A static deployment starts in an explicitly labelled sample workspace.
    // Once a real connection is chosen, failures never switch it back to sample.
    try { const meta = await api('/api/meta'); validateMeta(meta); }
    catch (error) { if (!state.token && !config.apiBase) state.mode = 'sample'; }
  }
  await refresh();
  setInterval(() => { if (state.mode === 'live' && !state.busy && !document.hidden && !document.querySelector('dialog[open]')) refresh(true); }, Math.max(15, Number(config.refreshSeconds) || 30) * 1000);
}
boot();
