/**
 * office_helper.js
 *
 * Listens on 127.0.0.1 only. The live Disconnection page (the Oracle VM) cannot reach DB2.
 * Sync Payments on that page sends the current consumer list here; this process runs
 * DbVisualizer against IBM DB2 and returns the updated list and payment history.
 * The page then uploads those files with the signed-in session. No VM sync key is required.
 *
 *   npm run office:db2
 *
 * Leave it running on the office PC that has DbVisualizer and a path to 10.251.64.65.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.OFFICE_HELPER_PORT) || 3921;
const HOST = '127.0.0.1';
const MAX_BODY = 40 * 1024 * 1024;
const ALLOWED_ORIGINS = new Set([
  'https://130.210.43.11.sslip.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
]);

function wantsStream(req) {
  return /application\/x-ndjson/i.test(String(req.headers.accept || ''));
}

function corsHeaders(res, origin) {
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

/** One JSON object per line. A flush tick lets the browser paint before a blocking DB2 call. */
function writeEvent(res, obj) {
  res.write(JSON.stringify(obj) + '\n');
  if (res.socket) {
    res.socket.uncork();
    if (typeof res.socket.setNoDelay === 'function') res.socket.setNoDelay(true);
  }
}

function beginStream(res, origin) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  corsHeaders(res, origin);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

function sendJson(res, status, body, origin) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.setHeader('Cache-Control', 'no-store');
  corsHeaders(res, origin);
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('The disconnection list is too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {{ runPayments: (csvText: string) => Promise<object>, dbvisAvailable?: () => boolean }} opts
 */
function createServer(opts) {
  const runPayments = opts.runPayments;
  const dbvisAvailable = opts.dbvisAvailable || (() => true);
  let busy = false;

  return http.createServer(async (req, res) => {
    const origin = String(req.headers.origin || '');
    const url = String(req.url || '/').split('?')[0];

    if (req.method === 'OPTIONS') {
      if (!ALLOWED_ORIGINS.has(origin)) {
        res.statusCode = 403;
        return res.end();
      }
      res.statusCode = 204;
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.setHeader('Access-Control-Max-Age', '600');
      return res.end();
    }

    if (req.method === 'GET' && url === '/health') {
      const dbvis = !!dbvisAvailable();
      return sendJson(res, 200, { status: 'ok', dbvis }, origin);
    }

    if (req.method === 'POST' && url === '/payment-sync') {
      if (!ALLOWED_ORIGINS.has(origin)) {
        return sendJson(res, 403, { status: 'error', message: 'This helper only answers the DISHA app.' }, origin);
      }
      if (busy) {
        return sendJson(res, 409, { status: 'error', message: 'A payment extract is already running on this PC.' }, origin);
      }
      if (!dbvisAvailable()) {
        return sendJson(res, 500, {
          status: 'error',
          message: 'DbVisualizer CLI was not found at C:\\Program Files\\DbVisualizer\\dbviscmd.bat.'
        }, origin);
      }
      busy = true;
      try {
        let body;
        try {
          body = JSON.parse(await readBody(req) || '{}');
        } catch (err) {
          const status = err.status || 400;
          return sendJson(res, status, { status: 'error', message: err.status ? err.message : 'The request was not valid JSON.' }, origin);
        }
        const csv = body && typeof body.csv === 'string' ? body.csv : '';
        const header = csv.split(/\r?\n/).slice(0, 5).join('\n');
        if (csv.length < 20 || !/CON_ID/i.test(header)) {
          return sendJson(res, 400, { status: 'error', message: 'The disconnection list is missing a CON_ID column.' }, origin);
        }
        if (wantsStream(req)) {
          beginStream(res, origin);
          try {
            const result = await runPayments(csv, async (ev) => {
              writeEvent(res, Object.assign({ type: 'progress' }, ev));
              await new Promise((resolve) => setImmediate(resolve));
            });
            writeEvent(res, Object.assign({ type: 'result' }, result));
          } catch (err) {
            writeEvent(res, { type: 'result', status: 'error', message: err.message || 'Payment extract failed.' });
          }
          res.end();
          return;
        }
        const result = await runPayments(csv);
        return sendJson(res, 200, result, origin);
      } catch (err) {
        if (res.headersSent) {
          try { res.end(); } catch (_) { /* closed */ }
          return;
        }
        return sendJson(res, 500, { status: 'error', message: err.message || 'Payment extract failed.' }, origin);
      } finally {
        busy = false;
      }
    }

    return sendJson(res, 404, { status: 'error', message: 'Not found' }, origin);
  });
}

function listen(server, port, host) {
  server.requestTimeout = 0;
  server.timeout = 0;
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server.address()));
  });
}

async function runPaymentsFromCsv(csvText, onProgress) {
  const { syncDisconnectionPayments } = require('./sync_disconnection_payments');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mzo-pay-'));
  const baseline = path.join(dir, 'baseline.csv');
  fs.writeFileSync(baseline, csvText, 'utf8');
  const result = await syncDisconnectionPayments({ fresh: true, skipUpload: true, baselineCsv: baseline, onProgress });
  return {
    status: 'success',
    message: result.message,
    matchedCount: result.matchedCount,
    totalCollected: result.totalCollected,
    csv: fs.readFileSync(result.csvPath, 'utf8'),
    payments: JSON.parse(fs.readFileSync(result.paymentsPath, 'utf8')),
    meta: JSON.parse(fs.readFileSync(result.metaPath, 'utf8'))
  };
}

module.exports = { createServer, listen, ALLOWED_ORIGINS, PORT, HOST };

if (require.main === module) {
  const { isDbvisAvailable } = require('./sync_disconnection_payments');
  const server = createServer({ runPayments: runPaymentsFromCsv, dbvisAvailable: isDbvisAvailable });
  listen(server, PORT, HOST).then(() => {
    console.log(`[Office helper] Listening on http://${HOST}:${PORT}`);
    console.log('[Office helper] Leave this running, then click Sync Payments on the live Disconnection page.');
    if (!isDbvisAvailable()) {
      console.error('[Office helper] DbVisualizer CLI was not found at C:\\Program Files\\DbVisualizer\\dbviscmd.bat');
    }
  });
}
