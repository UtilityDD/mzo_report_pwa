#!/usr/bin/env node
'use strict';
// Test of the VM user store's activity queue and user cache (lib/users_store.js), no PocketBase: the
// store's client is replaced by stand-ins.
//
//   node vm/dev/test-users-queue.js
//
// Checks: rows survive PocketBase being down (kept and written on the next flush, nothing lost or
// doubled); a row PocketBase refuses (4xx) loses only itself; a reload that started before a write
// does not bring back the older copy of that user.

const path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, '..', '..');
const usersStore = require(path.join(ROOT, 'lib', 'users_store.js'));

let passed = 0;
function ok(cond, label) { assert.ok(cond, label); passed++; console.log('  ok  ' + label); }
const quiet = { log() {}, warn() {}, error() {} };

function makeStore() {
    return usersStore.create({
        env: { MZO_USER_STORE: 'pocketbase', PB_URL: 'http://127.0.0.1:9', PB_SUPERUSER_EMAIL: 'su@example.com', PB_SUPERUSER_PASSWORD: 'x' },
        secret: 's', appRoot: ROOT, log: quiet
    });
}
const httpErr = (status) => Object.assign(new Error('HTTP ' + status), { status });

async function main() {
    // PocketBase down: the batch fails without a status; the rows are kept, then written once.
    const store = makeStore();
    const pb = store._pb;
    const written = [];
    let down = true;
    pb.batch = async (requests) => { if (down) throw new Error('fetch failed'); requests.forEach((r) => written.push(r.body.details.text)); };
    pb.create = async () => { throw new Error('create must not be tried while PocketBase is down'); };
    for (let i = 0; i < 3; i++) store.logActivity({ username: 'u', type: 'event', details: 'row ' + i });
    await store.flush();
    ok(written.length === 0, 'PocketBase down: nothing written');
    down = false;
    await store.flush();
    ok(JSON.stringify(written) === JSON.stringify(['row 0', 'row 1', 'row 2']), 'back up: every kept row written once, in order');

    // A refused row (400) loses only itself.
    const s2 = makeStore();
    const created = [];
    s2._pb.batch = async () => { throw httpErr(400); };
    s2._pb.create = async (coll, body) => { if (body.details.text === 'bad') throw httpErr(400); created.push(body.details.text); };
    ['a', 'bad', 'b', 'c'].forEach((t) => s2.logActivity({ username: 'u', type: 'event', details: t }));
    await s2.flush();
    ok(JSON.stringify(created) === JSON.stringify(['a', 'b', 'c']), 'a refused row is skipped, the rows after it are written');

    // Reload race: the list read before a write must not undo it.
    const s3 = makeStore();
    let release;
    s3._pb.all = async () => [{ id: 'r1', username: 'x', email: 'x@example.com', status: 'active', role: 'viewer' }];
    await s3.reload();
    s3._pb.all = () => new Promise((resolve) => { release = () => resolve([{ id: 'r1', username: 'x', email: 'x@example.com', status: 'active', role: 'viewer' }]); });
    const pending = s3.reload();
    // A sign-in write lands while the reload is reading (signIn → pb.update → put).
    s3._pb.list = async () => ({ items: [{ id: 'r1', username: 'x', email: 'x@example.com', status: 'active', role: 'viewer', google_sub: '' }] });
    s3._pb.update = async (coll, id, body) => Object.assign({ id: 'r1', username: 'x', email: 'x@example.com', status: 'active', role: 'viewer' }, body, { name: 'After write' });
    await s3.signIn({ email: 'x@example.com', sub: '', name: 'After write' });
    release();
    await pending;
    const u = s3.legacyUsers().find((p) => p.Username === 'x');
    ok(u && u.Name === 'After write', 'a reload that started before a write keeps the written copy');
    s3._pb.all = async () => [{ id: 'r1', username: 'x', email: 'x@example.com', status: 'active', role: 'viewer', name: 'Edited in the dashboard' }];
    await new Promise((r) => setTimeout(r, 5)); // a later millisecond than the write
    await s3.reload();
    const v = s3.legacyUsers().find((p) => p.Username === 'x');
    ok(v && v.Name === 'Edited in the dashboard', 'a reload that started after the write replaces the cache as usual');

    console.log(`users queue test: ${passed} checks passed`);
}

main().catch((err) => { console.error('FAIL:', err && err.message); process.exit(1); });
