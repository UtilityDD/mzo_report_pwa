#!/usr/bin/env node
/* The office DB2 helper answers only the DISHA origin, on loopback, and returns whatever the
 * payment extract returns. No DB2 and no VM. Exit 1 on a failed check.
 */
'use strict';

const assert = require('assert/strict');
const http = require('http');
const { createServer, listen } = require('../../scripts/sync/office_helper');

const ORIGIN = 'https://130.210.43.11.sslip.io';

function call(port, method, path, { origin, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: Object.assign(
        origin ? { Origin: origin } : {},
        body != null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}
      )
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

async function main() {
  let ran = 0;
  const server = createServer({
    dbvisAvailable: () => true,
    runPayments: async (csv) => {
      ran += 1;
      assert.match(csv, /CON_ID/);
      return { status: 'success', message: 'ok', matchedCount: 1, csv: csv + '\n', payments: { consumers: {} }, meta: { stats: {} } };
    }
  });
  const addr = await listen(server, 0, '127.0.0.1');
  const port = addr.port;
  try {
    const health = await call(port, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.text).dbvis, true);
    assert.equal(health.headers['access-control-allow-private-network'], 'true');

    const pre = await call(port, 'OPTIONS', '/payment-sync', { origin: ORIGIN });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], ORIGIN);
    assert.equal(pre.headers['access-control-allow-private-network'], 'true');

    const denied = await call(port, 'OPTIONS', '/payment-sync', { origin: 'https://evil.example' });
    assert.equal(denied.status, 403);

    const bad = await call(port, 'POST', '/payment-sync', { origin: ORIGIN, body: JSON.stringify({ csv: 'nope' }) });
    assert.equal(bad.status, 400);
    assert.equal(ran, 0);

    const csv = 'CCC_CODE,NAME,CON_ID\n6611001,A,1001\n';
    const ok = await call(port, 'POST', '/payment-sync', { origin: ORIGIN, body: JSON.stringify({ csv }) });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.text).matchedCount, 1);
    assert.equal(ran, 1);
    assert.equal(ok.headers['access-control-allow-origin'], ORIGIN);

    const stranger = await call(port, 'POST', '/payment-sync', { origin: 'https://evil.example', body: JSON.stringify({ csv }) });
    assert.equal(stranger.status, 403);
    assert.equal(ran, 1);

    console.log('office helper ok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
