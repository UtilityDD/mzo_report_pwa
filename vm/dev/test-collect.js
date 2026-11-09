'use strict';
// DISHA Collect (lib/collect.js): timing and office helpers, then every route against an in-memory
// PocketBase stub (offline), then the same checks against a throwaway local PocketBase with --pb.
//   node vm/dev/test-collect.js
//   node vm/dev/test-collect.js --pb   # needs vm/pocketbase/local/pocketbase or PB_BIN
const assert = require('assert');
const path = require('path');
const crypto = require('crypto');
const collectLib = require(path.join(__dirname, '..', '..', 'lib', 'collect.js'));
const localPb = require('./lib/local-pb');

let passed = 0;
function ok(cond, label) { assert.ok(cond, label); passed++; }

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
  assert.throws(() => normalizeOffice({ level: 'region', region: 'Nowhere' }), /Unknown region/);
  assert.throws(() => normalizeOffice({ level: 'ccc', ccc_code: '0000000' }), /Unknown CCC/);
  console.log('ok offices');
}

function schemaTests() {
  const { cleanSchema, cleanPayload, LIMITS } = collectLib;
  const s = cleanSchema({
    fields: [
      { id: '__proto__', type: 'text', label: 'P' },
      { id: 'constructor', type: 'number', label: 'C' },
      { id: 'a', type: 'text', label: 'A', extra: '<script>' },
      { id: 'a', type: 'evil', label: 'A2' },
      { id: 'has.dot', type: 'checkbox', label: 'D' },
      { id: 't', type: 'text', label: 'T', children: [{ id: 'x', type: 'date', label: 'X' }] }
    ],
    junk: 1
  }, true);
  const ids = s.fields.map((f) => f.id);
  ok(!ids.includes('__proto__') && !ids.includes('constructor'), 'prototype names are renamed');
  ok(new Set(ids).size === ids.length, 'sibling ids are unique');
  ok(s.fields[3].type === 'text' && !('extra' in s.fields[2]) && !('junk' in s), 'unknown types and keys are dropped');
  ok(/^f\d+$/.test(s.fields[4].id), 'an id with a dot is replaced');
  ok(s.fields[5].type === 'group' && s.fields[5].children[0].id === 'x', 'a column with children is a table');
  assert.throws(() => cleanSchema({ fields: [] }, true), /at least one field/);
  assert.throws(() => cleanSchema({ fields: Array.from({ length: LIMITS.fields + 1 }, (_, i) => ({ id: 'c' + i })) }, true), /too many columns/);
  let deep = { id: 'leaf', type: 'text' };
  for (let i = 0; i < LIMITS.depth; i++) deep = { id: 'g' + i, type: 'group', children: [deep] };
  assert.throws(() => cleanSchema({ fields: [deep] }, true), /nests too deep/);
  ok(cleanSchema({ fields: [deep] }, false).fields.length === 1, 'a stored format over the limits is cut, not refused');

  const fields = cleanSchema({ fields: [
    { id: 'n', type: 'number' }, { id: 'b', type: 'checkbox' }, { id: 'txt', type: 'text' },
    { id: 'rows', type: 'group', children: [{ id: 'name', type: 'text' }] }
  ] }, true).fields;
  const p = cleanPayload(fields, { fields: JSON.parse('{"n":"12","b":"true","txt":{"x":1},"rows":[{"name":"A","zzz":1}],"extra":"x","__proto__":{"polluted":1}}') });
  ok(p.fields.n === 12 && p.fields.b === true && p.fields.txt === '' && !('extra' in p.fields), 'draft values follow the column types');
  ok(!('zzz' in p.fields.rows[0]) && ({}).polluted === undefined, 'unknown keys are dropped and nothing is polluted');
  ok(cleanPayload(fields, { fields: { txt: 'y'.repeat(LIMITS.text + 50) } }).fields.txt.length === LIMITS.text, 'long text is clipped');
  assert.throws(() => cleanPayload(fields, { fields: { rows: Array.from({ length: LIMITS.rows + 1 }, () => ({})) } }), /rows/);
  console.log('ok schema and payload');
}

// ---- An in-memory PocketBase (records API only) ----------------------------------------------------
function parseFilter(src) {
  const toks = [];
  const re = /\s*(?:(&&|\|\||!=|=|\(|\))|"((?:[^"\\]|\\.)*)"|([A-Za-z_][A-Za-z0-9_.]*))/y;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < src.length && (m = re.exec(src))) {
    if (m[1]) toks.push({ op: m[1] });
    else if (m[2] !== undefined) toks.push({ str: m[2].replace(/\\(.)/g, '$1') });
    else toks.push({ id: m[3] });
  }
  if (re.lastIndex < src.trimEnd().length) throw Object.assign(new Error('bad filter: ' + src), { status: 400 });
  let i = 0;
  function primary() {
    const t = toks[i++];
    if (t && t.op === '(') { const e = or(); i++; return e; }
    const op = toks[i++];
    const v = toks[i++];
    if (!t || !t.id || !op || (op.op !== '=' && op.op !== '!=') || !v || v.str === undefined) {
      throw Object.assign(new Error('bad filter: ' + src), { status: 400 });
    }
    return (r) => (String(r[t.id] == null ? '' : r[t.id]) === v.str) === (op.op === '=');
  }
  function and() { let l = primary(); while (toks[i] && toks[i].op === '&&') { i++; const a = l, b = primary(); l = (r) => a(r) && b(r); } return l; }
  function or() { let l = and(); while (toks[i] && toks[i].op === '||') { i++; const a = l, b = and(); l = (r) => a(r) || b(r); } return l; }
  return or();
}

function stubPb() {
  const db = {};
  const calls = [];
  const state = { fail: null };
  const coll = (c) => (db[c] = db[c] || new Map());
  const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  async function fetch(url, init) {
    const u = new URL(url);
    const method = (init && init.method) || 'GET';
    calls.push(method + ' ' + u.pathname);
    if (state.fail === 'down') throw new TypeError('fetch failed');
    if (state.fail === 'error') return reply(500, { message: 'internal detail' });
    if (u.pathname === '/api/collections/_superusers/auth-with-password') return reply(200, { token: 'tok' });
    const m = /^\/api\/collections\/([^/]+)\/records(?:\/([^/]+))?$/.exec(u.pathname);
    if (!m) return reply(404, { message: 'no route' });
    const c = coll(m[1]);
    const body = init && init.body ? JSON.parse(init.body) : null;
    if (method === 'GET' && !m[2]) {
      let rows = [...c.values()];
      const f = u.searchParams.get('filter');
      if (f) { try { const fn = parseFilter(f); rows = rows.filter(fn); } catch (e) { return reply(400, { message: e.message }); } }
      const per = Number(u.searchParams.get('perPage') || 30);
      const page = Number(u.searchParams.get('page') || 1);
      return reply(200, { items: rows.slice((page - 1) * per, page * per) });
    }
    if (method === 'GET') return c.has(m[2]) ? reply(200, c.get(m[2])) : reply(404, {});
    if (method === 'POST') {
      const id = crypto.randomBytes(8).toString('hex').slice(0, 15);
      const rec = Object.assign({ id, created: new Date().toISOString(), updated: new Date().toISOString() }, body);
      c.set(id, rec);
      return reply(200, rec);
    }
    if (method === 'PATCH') {
      if (!c.has(m[2])) return reply(404, {});
      const rec = Object.assign({}, c.get(m[2]), body, { updated: new Date().toISOString() });
      c.set(m[2], rec);
      return reply(200, rec);
    }
    return reply(405, {});
  }
  return { fetch, db, coll, calls, state };
}

// ---- Route harness: mount on a fake app and call handlers directly ---------------------------------
function harness(collect) {
  const routes = [];
  const app = {};
  ['get', 'post', 'put', 'delete'].forEach((verb) => {
    app[verb] = (p, fn) => {
      const names = (p.match(/:[^/]+/g) || []).map((s) => s.slice(1));
      routes.push({ method: verb.toUpperCase(), re: new RegExp('^' + p.replace(/:[^/]+/g, '([^/]+)') + '$'), names, fn });
    };
  });
  collect.mount(app);
  return function run(method, urlPath, user, body) {
    return new Promise((resolve, reject) => {
      const r = routes.find((x) => x.method === method && x.re.test(urlPath));
      if (!r) return reject(new Error('no route ' + method + ' ' + urlPath));
      const mm = urlPath.match(r.re);
      const params = {};
      r.names.forEach((n, i) => { params[n] = decodeURIComponent(mm[i + 1]); });
      const res = {
        statusCode: 200,
        status(n) { this.statusCode = n; return this; },
        json(o) { resolve({ status: this.statusCode, body: o }); return this; }
      };
      Promise.resolve(r.fn({ user, body, params, method, path: urlPath, headers: {}, socket: { remoteAddress: '10.0.0.9' } }, res)).catch(reject);
    });
  };
}

const USERS = {
  admin: { email: 'admin@example.com', Name: 'Admin', Username: 'admin', role: 'admin', isAdmin: true, scope_level: 'zone' },
  maldaRm: { email: 'rm.malda@example.com', Name: 'RM Malda', Username: 'rmm', role: 'viewer', scope_level: 'region', region_code: 'Malda' },
  udRm: { email: 'rm.ud@example.com', Name: 'RM UD', Username: 'rmu', role: 'viewer', scope_level: 'region', region_code: 'Uttar Dinajpur' },
  chanchalDm: { email: 'dm.chanchal@example.com', Name: 'DM Chanchal', Username: 'dmc', role: 'viewer', scope_level: 'division', region_code: 'Malda', division_code: 'Chanchal' },
  samsi: { email: 'samsi@example.com', Name: 'Samsi AE', Username: 'samsi', role: 'viewer', scope_level: 'ccc', scope_ccc_code: '6612102', region_code: 'Malda', division_code: 'Chanchal' },
  manikchak: { email: 'mk@example.com', Name: 'Manikchak AE', Username: 'mk', role: 'viewer', scope_level: 'ccc', scope_ccc_code: '6611101', region_code: 'Malda', division_code: 'Malda' },
  blank: { email: 'new@example.com', Name: 'New', Username: 'new', role: 'viewer', scope_level: '' }
};

const SCHEMA = { fields: [{ id: 'block', type: 'group', label: 'Block', children: [{ id: 'name', type: 'text', label: 'Block name' }] }, { id: 'count', type: 'number', label: 'Count' }] };
const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();

/** The authorisation and validation checks, against either PocketBase. */
async function routeChecks(run, label) {
  const { admin, maldaRm, udRm, chanchalDm, samsi, manikchak, blank } = USERS;
  const base = { title: 'Test villages', due_at: inDays(2), schema: SCHEMA };

  // Who may create, and for which offices.
  ok((await run('POST', '/api/collect/requests', samsi, Object.assign({}, base, { offices: [{ level: 'ccc', ccc_code: '6612102' }] }))).status === 403, 'a CCC user cannot create');
  ok((await run('POST', '/api/collect/requests', blank, Object.assign({}, base, { offices: [{ level: 'ccc', ccc_code: '6612102' }] }))).status === 403, 'a user with no office cannot create');
  ok((await run('POST', '/api/collect/requests', maldaRm, Object.assign({}, base, { offices: [{ level: 'division', division: 'Raiganj' }] }))).status === 403, 'a region officer cannot target another region');
  ok((await run('POST', '/api/collect/requests', chanchalDm, Object.assign({}, base, { offices: [{ level: 'ccc', ccc_code: '6611101' }] }))).status === 403, 'a division officer cannot target another division');
  ok((await run('POST', '/api/collect/requests', maldaRm, Object.assign({}, base, { offices: [{ level: 'region', region: 'Malda' }, { level: 'zone' }] }))).status === 403, 'a region officer cannot target the zone');
  ok((await run('POST', '/api/collect/requests', admin, Object.assign({}, base, { due_at: inDays(-1), offices: [{ level: 'zone' }] }))).status === 400, 'a past due time is refused');
  ok((await run('POST', '/api/collect/requests', admin, Object.assign({}, base, { due_at: inDays(400), offices: [{ level: 'zone' }] }))).status === 400, 'a due time over a year ahead is refused');
  ok((await run('POST', '/api/collect/requests', admin, Object.assign({}, base, { offices: Array.from({ length: 201 }, () => ({ level: 'zone' })) }))).status === 400, 'too many office picks are refused');
  ok((await run('POST', '/api/collect/requests', admin, Object.assign({}, base, { offices: [{ level: 'zone' }], schema: { fields: [] } }))).status === 400, 'an empty format is refused');

  const created = await run('POST', '/api/collect/requests', maldaRm, Object.assign({}, base, {
    offices: [{ level: 'ccc', ccc_code: '6612102' }, { level: 'ccc', ccc_code: '6611101' }, { level: 'ccc', ccc_code: '6612102' }],
    schema: { fields: SCHEMA.fields.concat([{ id: '__proto__', type: 'text', label: 'X' }]) }
  }));
  ok(created.status === 201 && created.body.assignments.length === 2, 'a region officer creates for CCCs in the region (duplicates fold)');
  ok(!created.body.request.schema.fields.some((f) => f.id === '__proto__'), 'the stored format has no prototype id');
  const reqId = created.body.request.id;
  const asgSamsi = created.body.assignments.find((a) => a.ccc_code === '6612102').id;
  const asgMk = created.body.assignments.find((a) => a.ccc_code === '6611101').id;

  // Inbox and fill: only the office's own users.
  ok((await run('GET', '/api/collect/inbox', samsi)).body.items.some((i) => i.assignment_id === asgSamsi), 'the CCC sees its assignment');
  ok(!(await run('GET', '/api/collect/inbox', samsi)).body.items.some((i) => i.assignment_id === asgMk), 'the CCC does not see another CCC\'s assignment');
  ok((await run('GET', '/api/collect/status', samsi)).body.pending_count === 1, 'status counts the pending assignment');
  ok((await run('GET', '/api/collect/assignments/' + asgMk, samsi)).status === 403, 'another office cannot read the assignment');
  ok((await run('PUT', '/api/collect/assignments/' + asgMk + '/draft', samsi, { payload: { fields: {} } })).status === 403, 'another office cannot save the draft');
  ok((await run('POST', '/api/collect/assignments/' + asgMk + '/submit', samsi, { payload: { fields: {} } })).status === 403, 'another office cannot submit');
  ok((await run('PUT', '/api/collect/assignments/' + asgSamsi + '/draft', udRm, { payload: { fields: {} } })).status === 403, 'a requester elsewhere cannot save an office draft');

  // Requester-only routes.
  for (const [m, p, b] of [
    ['GET', '/api/collect/requests/' + reqId], ['GET', '/api/collect/requests/' + reqId + '/export'],
    ['POST', '/api/collect/requests/' + reqId + '/extend', { extended_due_at: inDays(3) }],
    ['POST', '/api/collect/requests/' + reqId + '/offices', { offices: [{ level: 'ccc', ccc_code: '6612101' }] }],
    ['POST', '/api/collect/requests/' + reqId + '/offices/remove', { assignment_ids: [asgMk] }],
    ['POST', '/api/collect/assignments/' + asgSamsi + '/return']
  ]) {
    ok((await run(m, p, udRm, b)).status === 403, `another region officer: ${m} ${p.replace(reqId, ':id').replace(asgSamsi, ':aid')} is 403`);
    ok((await run(m, p, samsi, b)).status === 403, `the assignee: ${m} ${p.replace(reqId, ':id').replace(asgSamsi, ':aid')} is 403`);
  }
  ok((await run('GET', '/api/collect/requests/' + reqId, maldaRm)).status === 200, 'the requester sees the tree');
  ok((await run('GET', '/api/collect/requests/' + reqId, admin)).status === 200, 'an admin sees the tree');
  const moved = Object.assign({}, maldaRm, { scope_level: 'ccc', scope_ccc_code: '6611101', division_code: 'Malda' });
  ok((await run('GET', '/api/collect/requests/' + reqId, moved)).status === 403, 'a requester moved to a CCC loses the request');
  ok((await run('GET', '/api/collect/requests/' + reqId, Object.assign({}, maldaRm, { region_code: 'Uttar Dinajpur' }))).status === 403, 'a requester moved to another region loses the request');
  ok(!(await run('GET', '/api/collect/requests', moved)).body.items.length, 'a moved requester no longer lists it');

  // Ids that are not PocketBase ids never reach PocketBase.
  for (const bad of ['..', '%2e%2e', 'abc', 'a'.repeat(15) + '/x']) {
    ok([404].includes((await run('GET', '/api/collect/requests/' + encodeURIComponent(bad), maldaRm)).status), `request id ${JSON.stringify(bad)} is 404`);
  }

  // Withdraw: an id from another request is ignored.
  const other = await run('POST', '/api/collect/requests', udRm, Object.assign({}, base, { offices: [{ level: 'division', division: 'Raiganj' }] }));
  ok(other.status === 201, 'a second requester creates in their region');
  const otherAsg = other.body.assignments[0].id;
  const rm = await run('POST', '/api/collect/requests/' + reqId + '/offices/remove', maldaRm, { assignment_ids: [otherAsg] });
  ok(rm.status === 200 && rm.body.removed === 0, 'withdraw ignores another request\'s assignment');
  ok((await run('GET', '/api/collect/requests/' + other.body.request.id, udRm)).body.assignments[0].status === 'pending', 'that assignment is untouched');

  // Draft: cleaned to the format, optimistic revision, size limits.
  const d1 = await run('PUT', '/api/collect/assignments/' + asgSamsi + '/draft', samsi, { payload: { fields: { block: [{ name: 'Habibpur', junk: 'x' }], count: '7', stray: 1 } } });
  ok(d1.status === 200 && d1.body.revision === 1, 'the office saves its draft');
  const view = await run('GET', '/api/collect/assignments/' + asgSamsi, samsi);
  ok(view.body.payload.fields.count === 7 && !('stray' in view.body.payload.fields) && !('junk' in view.body.payload.fields.block[0]), 'the saved draft follows the format');
  ok(view.body.revision === 1, 'the fill view carries the revision');
  ok((await run('PUT', '/api/collect/assignments/' + asgSamsi + '/draft', samsi, { base_revision: 0, payload: { fields: {} } })).status === 409, 'a save from an older revision is refused');
  ok((await run('PUT', '/api/collect/assignments/' + asgSamsi + '/draft', samsi, { base_revision: 1, payload: { fields: { count: 8 } } })).status === 200, 'a save from the current revision goes through');
  ok((await run('PUT', '/api/collect/assignments/' + asgSamsi + '/draft', samsi, { payload: { fields: { block: Array.from({ length: 501 }, () => ({ name: 'x' })) } } })).status === 413, 'a table over the row limit is refused');

  // Submit, return, extend.
  ok((await run('POST', '/api/collect/assignments/' + asgSamsi + '/submit', samsi, { payload: { fields: { count: 9 } } })).body.ok, 'the office submits');
  ok((await run('PUT', '/api/collect/assignments/' + asgSamsi + '/draft', samsi, { payload: { fields: {} } })).status === 400, 'a submitted draft is read-only');
  ok((await run('GET', '/api/collect/status', samsi)).body.pending_count === 0, 'status no longer counts a submitted assignment');
  ok((await run('POST', '/api/collect/requests/' + reqId + '/extend', maldaRm, { extended_due_at: inDays(-1) })).status === 400, 'an extension in the past is refused');
  ok((await run('POST', '/api/collect/requests/' + reqId + '/extend', maldaRm, { extended_due_at: inDays(500) })).status === 400, 'an extension over a year ahead is refused');
  ok((await run('POST', '/api/collect/requests/' + reqId + '/extend', maldaRm, { extended_due_at: inDays(5) })).status === 200, 'the requester extends');
  const tree = await run('GET', '/api/collect/requests/' + reqId, maldaRm);
  ok(tree.body.assignments.every((a) => a.timing.extended_due_at), 'the extension reaches submitted offices too');
  ok((await run('POST', '/api/collect/assignments/' + asgSamsi + '/return', maldaRm)).body.ok, 'the requester returns the submission');
  const exp = await run('GET', '/api/collect/requests/' + reqId + '/export', maldaRm);
  ok(exp.status === 200 && exp.body.offices.some((o) => o.rows.some((r) => r.value === '9')), 'the export carries the answers');

  // People pick: in scope, no usernames or phones.
  const people = await run('GET', '/api/collect/users', chanchalDm);
  ok(people.status === 200, 'a division officer lists people');
  ok(people.body.users.every((u) => u.division === 'Chanchal' && !('username' in u) && !('phone' in u)), 'only people under the division, without usernames or phones');
  ok((await run('GET', '/api/collect/users', samsi)).status === 403, 'a CCC user cannot list people');
  ok((await run('GET', '/api/collect/offices', samsi)).status === 403, 'a CCC user cannot list offices');
  console.log('ok routes (' + label + ')');
}

function seedUsers(add) {
  add({ email: 'samsi@example.com', name: 'Samsi AE', username: 'samsi', role: 'viewer', status: 'active', scope_level: 'ccc', region: 'Malda', division: 'Chanchal', ccc_code: '6612102', phone: '9000000000' });
  add({ email: 'mk@example.com', name: 'Manikchak AE', username: 'mk', role: 'viewer', status: 'active', scope_level: 'ccc', region: 'Malda', division: 'Malda', ccc_code: '6611101', phone: '9000000001' });
  add({ email: 'off@example.com', name: 'Disabled', username: 'off', role: 'viewer', status: 'disabled', scope_level: 'ccc', region: 'Malda', division: 'Chanchal', ccc_code: '6612102' });
}

async function stubSuite() {
  const stub = stubPb();
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub.fetch;
  const errors = [];
  const realErr = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    seedUsers((u) => { const id = crypto.randomBytes(8).toString('hex').slice(0, 15); stub.coll('app_users').set(id, Object.assign({ id }, u)); });
    const collect = collectLib.create({ env: { PB_URL: 'http://pb.stub', PB_SUPERUSER_EMAIL: 'x@example.com', PB_SUPERUSER_PASSWORD: 'x' }, clientIp: () => '10.0.0.9' });
    const run = harness(collect);
    await routeChecks(run, 'stub');
    ok(!stub.calls.some((c) => /\/records\/(\.\.|%2e)/i.test(c)), 'no path traversal reached PocketBase');

    // The status badge leaves out an assignment locked past its due and extended time.
    ok((await run('GET', '/api/collect/status', USERS.manikchak)).body.pending_count === 1, 'status counts an open assignment');
    const past = new Date(Date.now() - 86400000).toISOString();
    for (const [id, a] of stub.coll('app_collect_assignments')) {
      if (a.ccc_code === '6611101') stub.coll('app_collect_assignments').set(id, Object.assign({}, a, { due_at: past, extended_due_at: past }));
    }
    const lockedInbox = await run('GET', '/api/collect/inbox', USERS.manikchak);
    ok(lockedInbox.body.items.length === 1 && lockedInbox.body.items[0].timing.locked, 'the locked assignment still shows in the inbox');
    ok((await run('GET', '/api/collect/status', USERS.manikchak)).body.pending_count === 0, 'status does not count an assignment locked past its deadline');

    // A signed-out or cut-off user (currentUser returns null) gets 401 everywhere.
    const gated = harness(collectLib.create({ env: { PB_URL: 'http://pb.stub', PB_SUPERUSER_EMAIL: 'x@example.com', PB_SUPERUSER_PASSWORD: 'x' }, currentUser: async () => null }));
    ok((await gated('GET', '/api/collect/inbox', USERS.admin)).status === 401, 'a disabled user (no current profile) gets 401');
    ok((await gated('GET', '/api/collect/status', USERS.admin)).status === 401, 'status also refuses a disabled user');

    // PocketBase trouble: plain messages, no internals.
    stub.state.fail = 'error';
    const e1 = await run('GET', '/api/collect/inbox', USERS.samsi);
    ok(e1.status === 502 && !/PocketBase|records|internal/i.test(e1.body.error), 'a PocketBase error answers 502 without internals');
    stub.state.fail = 'down';
    const e2 = await run('GET', '/api/collect/inbox', USERS.samsi);
    ok(e2.status === 503 && !/fetch failed/.test(e2.body.error), 'PocketBase down answers 503');
    const st = await run('GET', '/api/collect/status', USERS.samsi);
    ok(st.status === 200 && st.body.available === false && !('error' in st.body), 'status degrades without an error text');
    stub.state.fail = null;
  } finally {
    globalThis.fetch = realFetch;
    console.error = realErr;
  }

  // Off (no PocketBase): status is a plain answer, the rest 503.
  const off = harness(collectLib.create({ env: {} }));
  ok((await off('GET', '/api/collect/status', USERS.admin)).body.available === false, 'status off: available false');
  ok((await off('GET', '/api/collect/inbox', USERS.admin)).status === 503, 'routes off: 503');
  console.log('ok stub suite');
}

async function pbSuite() {
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
    // Seed app_users through the superuser API, as the user store would.
    const auth = await (await fetch(pb.url + '/api/collections/_superusers/auth-with-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identity: pb.email, password: pb.password })
    })).json();
    const adds = [];
    seedUsers((u) => adds.push(fetch(pb.url + '/api/collections/app_users/records', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth.token }, body: JSON.stringify(u)
    })));
    await Promise.all(adds);
    // The collections are superuser-only: an anonymous list is refused.
    const anon = await fetch(pb.url + '/api/collections/app_collect_submissions/records');
    ok(anon.status === 403 || anon.status === 401 || anon.status === 404, 'anonymous PocketBase access to Collect is refused');
    await routeChecks(harness(collect), 'pb');
  } finally {
    await pb.stop();
  }
}

(async () => {
  timingTests();
  officeTests();
  schemaTests();
  await stubSuite();
  if (process.argv.includes('--pb')) await pbSuite();
  else console.log('tip: pass --pb to run the same checks against a local PocketBase');
  console.log(`collect tests passed (${passed} checks)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
