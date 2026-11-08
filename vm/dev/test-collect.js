'use strict';
// Offline unit tests for DISHA Collect helpers + optional live PocketBase round-trip.
//   node vm/dev/test-collect.js
//   node vm/dev/test-collect.js --pb   # needs vm/pocketbase/local/pocketbase or PB_BIN
const assert = require('assert');
const path = require('path');
const collectLib = require(path.join(__dirname, '..', '..', 'lib', 'collect.js'));
const localPb = require('./lib/local-pb');

function timingTests() {
  const { timingOf } = collectLib;
  const due = '2026-11-10T12:00:00.000Z';
  const ext = '2026-11-12T12:00:00.000Z';
  const before = timingOf(due, null, Date.parse('2026-11-09T12:00:00.000Z'));
  assert.strictEqual(before.locked, false);
  assert.strictEqual(before.late, false);
  assert.strictEqual(before.can_edit, true);
  const locked = timingOf(due, null, Date.parse('2026-11-11T12:00:00.000Z'));
  assert.strictEqual(locked.locked, true);
  assert.strictEqual(locked.can_edit, false);
  const late = timingOf(due, ext, Date.parse('2026-11-11T12:00:00.000Z'));
  assert.strictEqual(late.locked, false);
  assert.strictEqual(late.late, true);
  assert.strictEqual(late.can_edit, true);
  const afterExt = timingOf(due, ext, Date.parse('2026-11-13T12:00:00.000Z'));
  assert.strictEqual(afterExt.locked, true);
  console.log('ok timing');
}

function officeTests() {
  const { normalizeOffice } = collectLib;
  const c = normalizeOffice({ level: 'ccc', ccc_code: '6612102' });
  assert.strictEqual(c.ccc_code, '6612102');
  assert.ok(/Samsi/i.test(c.office_label));
  const d = normalizeOffice({ level: 'division', division: 'Chanchal' });
  assert.strictEqual(d.division, 'Chanchal');
  assert.strictEqual(d.region, 'Malda');
  const r = normalizeOffice({ level: 'region', region: 'Raiganj' });
  assert.strictEqual(r.region, 'Uttar Dinajpur');
  console.log('ok offices');
}

async function pbRoundTrip() {
  if (!localPb.available()) {
    console.log('skip pb (no binary at vm/pocketbase/local/pocketbase)');
    return;
  }
  const pb = await localPb.start();
  try {
    const collect = collectLib.create({
      env: { PB_URL: pb.url, PB_SUPERUSER_EMAIL: pb.email, PB_SUPERUSER_PASSWORD: pb.password },
      clientIp: () => '127.0.0.1'
    });
    assert.strictEqual(collect.on, true);

    // Drive handlers without Express: call mount with a fake app that captures routes.
    const routes = {};
    const app = {
      get(p, fn) { routes['GET ' + p] = fn; },
      post(p, fn) { routes['POST ' + p] = fn; },
      put(p, fn) { routes['PUT ' + p] = fn; }
    };
    collect.mount(app);

    function run(method, path, user, body) {
      return new Promise((resolve, reject) => {
        const params = {};
        let pattern = null;
        Object.keys(routes).forEach((k) => {
          if (!k.startsWith(method + ' ')) return;
          const raw = k.slice(method.length + 1);
          const re = new RegExp('^' + raw.replace(/:[^/]+/g, '([^/]+)') + '$');
          const m = path.match(re);
          if (m) {
            pattern = k;
            const names = (raw.match(/:[^/]+/g) || []).map((s) => s.slice(1));
            names.forEach((n, i) => { params[n] = m[i + 1]; });
          }
        });
        if (!pattern) return reject(new Error('no route ' + method + ' ' + path));
        const res = {
          statusCode: 200,
          body: null,
          status(n) { this.statusCode = n; return this; },
          json(o) { this.body = o; resolve({ status: this.statusCode, body: o }); }
        };
        routes[pattern]({ user, body, params, headers: {} }, res).catch(reject);
      });
    }

    const admin = {
      email: 'admin@example.com', Name: 'Admin', Username: 'admin',
      role: 'admin', isAdmin: true, scope_level: 'zone'
    };
    const cccUser = {
      email: 'samsi@example.com', Name: 'Samsi AE', Username: 'samsi',
      role: 'viewer', scope_level: 'ccc', scope_ccc_code: '6612102', region_code: 'Malda', division_code: 'Chanchal'
    };

    const due = new Date(Date.now() + 2 * 86400000).toISOString();
    const created = await run('POST', '/api/collect/requests', admin, {
      title: 'Test tribal villages',
      due_at: due,
      offices: [{ level: 'ccc', ccc_code: '6612102' }],
      schema: {
        fields: [
          { id: 'block', type: 'group', label: 'Block', repeat: true, children: [
            { id: 'name', type: 'text', label: 'Block name', required: true }
          ]}
        ]
      }
    });
    assert.strictEqual(created.status, 201);
    assert.ok(created.body.request && created.body.request.id);
    const asgId = created.body.assignments[0].id;

    const inbox = await run('GET', '/api/collect/inbox', cccUser);
    assert.ok(inbox.body.items.some((i) => i.assignment_id === asgId));

    const draft = await run('PUT', '/api/collect/assignments/' + asgId + '/draft', cccUser, {
      payload: { fields: { block: [{ name: 'Habibpur' }] } }
    });
    assert.ok(draft.body.ok);

    const submitted = await run('POST', '/api/collect/assignments/' + asgId + '/submit', cccUser, {
      payload: { fields: { block: [{ name: 'Habibpur' }] } }
    });
    assert.ok(submitted.body.ok);

    const detail = await run('GET', '/api/collect/requests/' + created.body.request.id, admin);
    assert.strictEqual(detail.body.assignments[0].status, 'submitted');

    const exported = await run('GET', '/api/collect/requests/' + created.body.request.id + '/export', admin);
    assert.ok(exported.body.offices[0].rows.length);

    console.log('ok pb round-trip');
  } finally {
    await pb.stop();
  }
}

(async () => {
  timingTests();
  officeTests();
  if (process.argv.includes('--pb')) await pbRoundTrip();
  else console.log('tip: pass --pb to run a live PocketBase round-trip when the binary is present');
  console.log('collect tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
