/**
 * office_helper.js
 *
 * Listens on 127.0.0.1 only. The live Disconnection page (the Oracle VM) cannot reach DB2.
 * Sync Payments, and every Sync Now button on Admin → Data Sync, send the job here.
 * This process runs DbVisualizer against IBM DB2 and returns the files to publish.
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
const OFFICE_JOBS = new Set(['defective', 'unbilled', 'disconnection', 'disconnection_payments', 'osd']);

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

    if (req.method === 'GET' && url === '/osd-selected') {
      const selectedPath = path.resolve(__dirname, '../../data/osd_selected.csv');
      if (!ALLOWED_ORIGINS.has(origin)) {
        res.statusCode = 403;
        return res.end();
      }
      if (!fs.existsSync(selectedPath)) {
        return sendJson(res, 404, { status: 'error', message: 'No selected list on this PC yet.' }, origin);
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      corsHeaders(res, origin);
      fs.createReadStream(selectedPath).pipe(res);
      return;
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

    if (req.method === 'POST' && url === '/run') {
      if (!ALLOWED_ORIGINS.has(origin)) {
        return sendJson(res, 403, { status: 'error', message: 'This helper only answers the DISHA app.' }, origin);
      }
      if (busy) {
        return sendJson(res, 409, { status: 'error', message: 'A DB2 extract is already running on this PC.' }, origin);
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
        const job = body && typeof body.job === 'string' ? body.job : '';
        if (!OFFICE_JOBS.has(job)) {
          return sendJson(res, 400, { status: 'error', message: 'That report is not a DB2 extract yet.' }, origin);
        }
        const runner = opts.runJob || defaultRunJob;
        const run = (onProgress) => runner(job, body, onProgress);
        if (wantsStream(req)) {
          beginStream(res, origin);
          try {
            const result = await run(async (ev) => {
              writeEvent(res, Object.assign({ type: 'progress' }, ev));
              await new Promise((resolve) => setImmediate(resolve));
            });
            writeEvent(res, Object.assign({ type: 'result' }, result));
          } catch (err) {
            writeEvent(res, { type: 'result', status: 'error', message: err.message || 'DB2 extract failed.' });
          }
          res.end();
          return;
        }
        const result = await run();
        return sendJson(res, 200, result, origin);
      } catch (err) {
        if (res.headersSent) {
          try { res.end(); } catch (_) { /* closed */ }
          return;
        }
        return sendJson(res, err.status || 500, { status: 'error', message: err.message || 'DB2 extract failed.' }, origin);
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

function loadDotEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return; }
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 1) continue;
    const key = s.slice(0, i).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key]) continue;
    let val = s.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    process.env[key] = val;
  }
}

let envReady = false;
function ensureOfficeEnv() {
  if (envReady) return;
  envReady = true;
  loadDotEnv(path.resolve(__dirname, '../../.env'));
  loadDotEnv(path.resolve(__dirname, '../../.env.secrets'));
}

function filePart(field, name, type, filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return { field, name, type, text: fs.readFileSync(filePath, 'utf8') };
}

async function defaultRunJob(job, body, onProgress) {
  ensureOfficeEnv();
  if (job === 'disconnection_payments') {
    const csv = body && typeof body.csv === 'string' ? body.csv : '';
    const header = csv.split(/\r?\n/).slice(0, 5).join('\n');
    if (csv.length < 20 || !/CON_ID/i.test(header)) {
      throw new Error('The disconnection list is missing a CON_ID column.');
    }
    const extracted = await runPaymentsFromCsv(csv, onProgress);
    return {
      status: 'success',
      message: extracted.message,
      uploads: [
        {
          url: '/api/disconnection/payments-upload',
          files: [
            { field: 'file', name: 'disconnection_payments.json', type: 'application/json', text: JSON.stringify(extracted.payments) },
            { field: 'meta', name: 'disconnection_meta.json', type: 'application/json', text: JSON.stringify(extracted.meta) }
          ]
        },
        {
          url: '/api/disconnection/upload',
          files: [{ field: 'file', name: 'disconnection.csv', type: 'text/csv', text: extracted.csv }]
        }
      ]
    };
  }
  if (job === 'disconnection') {
    const { syncDisconnectionFromCrm } = require('./sync_disconnection_from_crm');
    const result = await syncDisconnectionFromCrm({ fresh: true, skipUpload: true, isCli: false, onProgress });
    const file = filePart('file', 'disconnection.csv', 'text/csv', result.csvPath);
    if (!file) throw new Error('The disconnection extract did not write a file.');
    return { status: 'success', message: result.message, uploads: [{ url: '/api/disconnection/upload', files: [file] }] };
  }
  if (job === 'unbilled') {
    const { syncUnbilledFromCrm } = require('./sync_unbilled_from_crm');
    const result = await syncUnbilledFromCrm({ fresh: true, skipUpload: true, isCli: false, onProgress });
    const files = [
      filePart('outsort', 'unbilled_outsort.csv', 'text/csv', result.files && result.files.outsort),
      filePart('chronic', 'unbilled_chronic.csv', 'text/csv', result.files && result.files.chronic),
      filePart('summary', 'unbilled_summary.csv', 'text/csv', result.files && result.files.summary)
    ].filter(Boolean);
    if (!files.length) throw new Error('The unbilled extract did not write a file.');
    return { status: 'success', message: result.message, uploads: [{ url: '/api/unbilled/upload', files }] };
  }
  if (job === 'defective') {
    const { syncDefectiveFromCrm } = require('./sync_defective_from_crm');
    const meta = await syncDefectiveFromCrm({ fresh: true, dryRun: false, skipDb: false, onProgress });
    const n = meta && meta.stats && meta.stats.totalDefective;
    return {
      status: 'success',
      message: n != null
        ? `Defective meters published. ${Number(n).toLocaleString('en-IN')} defective.`
        : 'Defective meters published.',
      uploads: []
    };
  }
  if (job === 'osd') {
    const { buildFromDir, writeSummary } = require('./osd_notice_summary');
    const { appendSnapshot } = require('./osd_history');
    const { spawnSync } = require('child_process');
    const dir = path.resolve(__dirname, '../../data/temp/osd');
    const summaryPath = path.resolve(__dirname, '../../data/osd_summary.json');
    const historyPath = path.resolve(__dirname, '../../data/osd_summary_history.json');
    const selectedPath = path.resolve(__dirname, '../../data/osd_selected.csv');
    const dbvis = 'C:\\Program Files\\DbVisualizer\\dbviscmd.bat';
    let summary = null;
    let fromDb = false;
    if (onProgress) await onProgress({ phase: 'division', index: 1, total: 2, name: 'OSD summary', state: 'run' });
    if (fs.existsSync(dbvis)) {
      const sqlFiles = ['summary_agg.sql', 'agg_ccc.sql'].map((name) => path.join(dir, name)).filter((file) => fs.existsSync(file));
      let sqlOk = sqlFiles.length > 0;
      for (const sqlFile of sqlFiles) {
        const res = spawnSync('cmd.exe', ['/c', 'dbviscmd.bat', '-connection', 'ibm db2', '-sqlfile', sqlFile, '-stoponerror'], {
          encoding: 'utf8',
          cwd: path.dirname(dbvis),
          timeout: 180000
        });
        const failed = res.error || res.status !== 0 || (res.stdout && res.stdout.includes('ERROR:'));
        if (failed) { sqlOk = false; break; }
      }
      if (sqlOk) {
        try {
          summary = buildFromDir(dir);
          writeSummary(summary, summaryPath);
          appendSnapshot(summary, historyPath);
          fromDb = true;
        } catch (_) { summary = null; }
      }
    }
    if (!summary && fs.existsSync(summaryPath)) {
      summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    }
    if (!summary || !summary.totals) throw new Error('No OSD summary on this PC. Run the office extract first.');
    if (onProgress) await onProgress({ phase: 'division', index: 1, total: 2, name: 'OSD summary', state: 'done' });
    const selectedReady = fs.existsSync(selectedPath);
    if (onProgress) {
      await onProgress({ phase: 'division', index: 2, total: 2, name: selectedReady ? 'Selected consumers' : 'Selected list not on this PC', state: 'done' });
    }
    const cr = (Number(summary.totals.osd) / 1e7).toFixed(2);
    const rem = summary.totals.remConsumers ? ` REM ${Number(summary.totals.remConsumers).toLocaleString('en-IN')}.` : '';
    return {
      status: 'success',
      message: `OSD summary ${Number(summary.totals.consumers).toLocaleString('en-IN')} consumers, ₹${cr} Cr, as on ${summary.asOn}.${rem}`
        + (fromDb ? ' Refreshed from NOTICE_OSD.' : ' Published the saved snapshot.')
        + (selectedReady ? ' The selected-consumer list uploads with it.' : ' The selected-consumer list is not on this PC yet.'),
      selectedFetch: selectedReady ? `http://${HOST}:${PORT}/osd-selected` : '',
      uploads: [{
        url: '/api/osd/upload',
        files: [{ field: 'summary', name: 'osd_summary.json', type: 'application/json', text: JSON.stringify(summary) }]
      }]
    };
  }
  throw new Error('That report is not a DB2 extract yet.');
}

module.exports = { createServer, listen, ALLOWED_ORIGINS, OFFICE_JOBS, PORT, HOST };

if (require.main === module) {
  const { isDbvisAvailable } = require('./sync_disconnection_payments');
  const server = createServer({ runPayments: runPaymentsFromCsv, dbvisAvailable: isDbvisAvailable });
  listen(server, PORT, HOST).then(() => {
    console.log(`[Office helper] Listening on http://${HOST}:${PORT}`);
    console.log('[Office helper] Leave this running, then use Sync Now on Admin → Data Sync, or Sync Payments on Disconnection.');
    if (!isDbvisAvailable()) {
      console.error('[Office helper] DbVisualizer CLI was not found at C:\\Program Files\\DbVisualizer\\dbviscmd.bat');
    }
  });
}
