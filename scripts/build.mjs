import { mkdir, copyFile, readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, 'dist');
await mkdir(path.join(out, 'assets'), { recursive: true });
// Explicit allowlist: database files, exports, bot source, and secrets never ship.
await copyFile(path.join(root, 'dashboard.html'), path.join(out, 'index.html'));
for (const file of ['app.js', 'data.js', 'dashboard.css', 'favicon.svg', 'config.js']) {
  await copyFile(path.join(root, 'assets', file), path.join(out, 'assets', file));
}
if (process.env.PRESENCE_API_URL) {
  const url = new URL(process.env.PRESENCE_API_URL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('PRESENCE_API_URL must be an HTTP(S) address without credentials or query parameters.');
  }
  await writeFile(path.join(out, 'assets', 'config.js'), `window.PRESENCE_CONFIG = ${JSON.stringify({
    apiBase: url.href.replace(/\/$/, ''), serverName: process.env.PRESENCE_SERVER_NAME || '', refreshSeconds: 30,
  })};\n`);
}
const html = await readFile(path.join(out, 'index.html'), 'utf8');
if (!html.includes('assets/app.js')) throw new Error('Dashboard entrypoint missing');
const allowed = new Set(['index.html', 'assets', ...['app.js', 'data.js', 'dashboard.css', 'favicon.svg', 'config.js'].map(f => path.join('assets', f))]);
const unexpected = (await readdir(out, { recursive: true })).filter(file => !allowed.has(file));
if (unexpected.length) throw new Error('dist/ contains unexpected files. Remove them before publishing: ' + unexpected.join(', '));
console.log('Built Presence dashboard → dist/ (6 static files, no dependencies)');
