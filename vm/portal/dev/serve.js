#!/usr/bin/env node
/* Local development server for the admin portal. Mirrors what Caddy does on the VM:
 *
 *   /kit/mzo_theme.css, /kit/mzo_theme.js, /kit/mzo_ui.js  → the three kit files at the repo root
 *   /api/*, /_/*                                         → PocketBase (default http://127.0.0.1:8093)
 *   /dev/*, *.md                                         → 404 (never served)
 *   everything else                                      → static files from vm/portal
 *
 *   node vm/portal/dev/serve.js        PORT=3300  PB_URL=http://127.0.0.1:8093
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3300);
const PB = new URL(process.env.PB_URL || 'http://127.0.0.1:8093');
const ROOT = path.resolve(__dirname, '..');          // vm/portal
const REPO = path.resolve(__dirname, '..', '..', '..'); // repo root
const KIT = { 'mzo_theme.css': 1, 'mzo_theme.js': 1, 'mzo_ui.js': 1 };

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8'
};
// Same headers the VM should send for the portal's static files (see README).
const SECURITY = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-cache'
};

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, SECURITY, headers || {}));
  res.end(body);
}

function serveFile(res, file, method) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, Object.assign({}, SECURITY, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size
    }));
    if (method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function proxy(req, res) {
  const headers = Object.assign({}, req.headers, { host: PB.host });
  delete headers.connection;
  const up = http.request({ hostname: PB.hostname, port: PB.port || 80, method: req.method, path: req.url, headers }, (r) => {
    const h = Object.assign({}, r.headers);
    // Data responses must not land in the browser's disk cache.
    if (req.url.startsWith('/api/')) h['cache-control'] = 'no-store';
    res.writeHead(r.statusCode || 502, h);
    r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) send(res, 502, 'PocketBase is not reachable at ' + PB.origin); else res.end(); });
  req.pipe(up);
}

http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { return send(res, 400, 'Bad request'); }

  if (pathname.startsWith('/api/') || pathname === '/_' || pathname.startsWith('/_/')) return proxy(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });

  if (pathname.startsWith('/kit/')) {
    const name = pathname.slice(5);
    return KIT[name] ? serveFile(res, path.join(REPO, name), req.method) : send(res, 404, 'Not found');
  }
  if (pathname === '/dev' || pathname.startsWith('/dev/') || /\.md$/i.test(pathname) || pathname.split('/').some((s) => s.startsWith('.'))) {
    return send(res, 404, 'Not found');
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.resolve(ROOT, '.' + pathname);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return send(res, 404, 'Not found');
  serveFile(res, file, req.method);
}).listen(PORT, '127.0.0.1', () => {
  console.log('Portal on http://127.0.0.1:' + PORT + '  (PocketBase ' + PB.origin + ')');
});
