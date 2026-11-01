#!/usr/bin/env node
/* Local stand-in for the VM's mirror endpoints, in front of a running app:
 *
 *   node scripts/qa/uniform-stub.js --port 3800 --app http://127.0.0.1:3801 [--mirror <snapshotDir>]
 *
 * With --mirror it answers, from the snapshot folder (manifest.json, <key>.<ext>, <key>.rows.json):
 *   GET /api/data/manifest      the manifest minus sensitive entries (204 without --mirror, like Vercel)
 *   GET /api/data/file/:key     the raw snapshot (ETag = version, 304, br/gzip)
 *   GET /api/data/rows/:key     uniform rows through vm/sync/lib/rows.js (the VM's handler)
 * Everything else is proxied to --app unchanged. Sessions are checked like server.js does
 * (mzo_session HMAC with JWT_SECRET or the development fallback). Only GET/HEAD reach the data
 * routes; the app behind it should run with a write guard (parity-qa's guard-writes.js).
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rows = require('../../vm/sync/lib/rows');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; }
const PORT = Number(arg('port', 3800));
const APP = new URL(arg('app', 'http://127.0.0.1:3801'));
const DIR = arg('mirror') ? path.resolve(arg('mirror')) : null;
const SECRET = process.env.JWT_SECRET || 'mzo-portal-super-secret-key-123456';
const REPO = path.resolve(__dirname, '..', '..');

function session(req) {
  const m = /(?:^|;\s*)mzo_session=([^;]+)/.exec(req.headers.cookie || '');
  const parts = String(m ? decodeURIComponent(m[1]) : '').split('.');
  if (parts.length !== 2) return null;
  const want = crypto.createHmac('sha256', SECRET).update(parts[0]).digest('base64');
  if (want !== parts[1]) return null;
  try { const s = JSON.parse(Buffer.from(parts[0], 'base64').toString('utf8')); return Date.now() < s.expiry ? s.profile : null; } catch (_) { return null; }
}

let cache = { mtime: 0, m: null };
function manifest() {
  const f = path.join(DIR, 'manifest.json');
  const st = fs.statSync(f);
  if (st.mtimeMs !== cache.mtime) {
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    const entries = {};
    Object.keys(data.datasets || {}).forEach((k) => { if (!data.datasets[k].sensitive) entries[k] = data.datasets[k]; });
    cache = { mtime: st.mtimeMs, m: { data, entries } };
  }
  return Promise.resolve(cache.m);
}

// Minimal Express-like response helpers for the shared handler.
function wrap(res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); return res; };
  return res;
}
const rowsHandler = DIR ? rows.handler({ dir: DIR, app: REPO, on: () => true, manifest, log: console }) : null;

function sendFile(req, res, file, etag, type) {
  res.setHeader('Cache-Control', 'private, no-cache');
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('ETag', etag);
  if (String(req.headers['if-none-match'] || '').split(',').map((s) => s.trim()).includes(etag)) { res.statusCode = 304; return res.end(); }
  const ae = String(req.headers['accept-encoding'] || '');
  let f = file, enc = '';
  if (/\bbr\b/.test(ae) && fs.existsSync(file + '.br')) { f = file + '.br'; enc = 'br'; }
  else if (/\bgzip\b/.test(ae) && fs.existsSync(file + '.gz')) { f = file + '.gz'; enc = 'gzip'; }
  res.setHeader('Content-Type', type);
  if (enc) res.setHeader('Content-Encoding', enc);
  res.setHeader('Content-Length', fs.statSync(f).size);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(f).pipe(res);
}

function proxy(req, res) {
  const up = http.request({ host: APP.hostname, port: APP.port, method: req.method, path: req.url, headers: Object.assign({}, req.headers, { host: APP.host }) }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => { res.statusCode = 502; res.end('upstream: ' + e.message); });
  req.pipe(up);
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const m = /^\/api\/data\/(manifest|file|rows|status)(?:\/([^/]+))?$/.exec(u.pathname);
  if (!m) return proxy(req, res);
  wrap(res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).json({ status: 'error' });
  req.user = session(req);
  if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  if (!DIR) { res.statusCode = m[1] === 'manifest' ? 204 : 404; return res.end(); }
  manifest().then((man) => {
    if (m[1] === 'manifest') {
      const body = JSON.stringify({ generatedAt: man.data.generatedAt, datasets: man.entries });
      const etag = '"m-' + crypto.createHash('sha1').update(body).digest('hex').slice(0, 20) + '"';
      res.setHeader('Cache-Control', 'private, no-cache'); res.setHeader('ETag', etag); res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (req.headers['if-none-match'] === etag) { res.statusCode = 304; return res.end(); }
      return res.end(body);
    }
    if (m[1] === 'status') return res.json({ status: 'success', mode: 'mirror', generatedAt: man.data.generatedAt, datasets: Object.keys(man.entries).length });
    const key = m[2] || '';
    if (m[1] === 'rows') { req.params = { key }; return rowsHandler(req, res); }
    const e = man.entries[key];
    if (!e || !/^[a-z0-9_]+\.(csv|tsv|json)$/.test(e.file || '')) return res.status(404).json({ status: 'error', message: 'Not found' });
    return sendFile(req, res, path.join(DIR, e.file), '"' + e.version + '"', String(e.contentType || 'text/csv; charset=utf-8'));
  }).catch((err) => { res.status(500).json({ status: 'error', message: err.message }); });
}).listen(PORT, '127.0.0.1', () => console.log(`[uniform-stub] :${PORT} → ${APP.href}${DIR ? ' mirror ' + DIR : ' (no mirror: 204/404)'}`));
