#!/usr/bin/env node
'use strict';
// Test of GET /api/admin/org (Admin → Organisation) and lib/org_hierarchy.js, with no network.
//
//   node vm/dev/test-org-api.js
//
// Checks:
//   - access: no session 401, a non-admin 403, role admin and isAdmin: true 200; the data file itself is not served;
//   - shape of the repo file's answer: asOf, sources[], root with zone → region → division → ccc children,
//     every confidence one of confirmed / partial / inferred, no dataset warnings;
//   - exactly one zone is marked live, it is the app's zone (lib/offices.js), and every app region, division
//     and CCC is matched inside it (none missing);
//   - annotate() on fixtures: matching by code, by name and by alias (Uttar Dinajpur = Raiganj), offices the
//     app has but the dataset lacks are listed as missing, a zone that is not the app's is never live,
//     and check() reports a level out of order.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const SECRET = 'mzo-portal-super-secret-key-123456';
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); checks++; };

function cookie(profile) {
    const payload = Buffer.from(JSON.stringify({ profile, expiry: Date.now() + 3600e3 })).toString('base64');
    return `mzo_session=${encodeURIComponent(payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64'))}`;
}

function units() {
    const O = require(path.join(ROOT, 'lib', 'offices.js'));
    const H = require(path.join(ROOT, 'lib', 'org_hierarchy.js'));
    const ccc = (name, code) => ({ level: 'ccc', name, code, confidence: 'confirmed' });
    const data = {
        root: { level: 'chief_engineer', name: 'CE', children: [
            { level: 'zone', name: 'Berhampore Zone', code: '', confidence: 'partial', children: [
                { level: 'region', name: 'Malda', code: '', children: [] } // same name as an app region, other zone: not matched
            ] },
            { level: 'zone', name: 'Malda Zone', code: '', confidence: 'confirmed', children: [
                { level: 'region', name: 'Malda Region', code: '6610000', children: [
                    { level: 'division', name: 'Malda', code: '6611000', children: [ccc('Manikchak', '6611101'), ccc('Mathurapur', '')] }
                ] },
                { level: 'region', name: 'Uttar Dinajpur', code: '', aliases: [], children: [
                    { level: 'division', name: 'Islampur', code: '', children: [ccc('Goalpokhar', '')] },
                    { level: 'division', name: 'Nowhere', code: '', children: [] }
                ] }
            ] }
        ] }
    };
    const { root, live } = H.annotate(data, O);
    const [berh, malda] = root.children;
    ok(!berh.live && !berh.children[0].inApp, 'another zone is never live, nor its offices in the app');
    ok(malda.live === true, 'the app zone is live (by name)');
    eq(malda.children[0].inApp, { name: 'Malda', code: '6610000' }, 'region matched by code');
    eq(malda.children[1].inApp, { name: 'Uttar Dinajpur', code: '6620000' }, 'Uttar Dinajpur matched to the app region');
    eq(malda.children[0].children[0].children[1].inApp, { name: 'Manikchak', code: '6611101' }, 'a CCC alias (Mathurapur) matches');
    eq(malda.children[1].children[0].children[0].inApp.code, '6622104', 'Goalpokhar (alias) matched in Islampur');
    ok(!malda.children[1].children[1].inApp, 'an unknown division is not in the app');
    eq(live.zone, 'Malda Zone', 'live zone name');
    eq(live.matched, { regions: 2, divisions: 2, cccs: 2 }, 'matched counts');
    eq(live.app, { regions: O.REGIONS.length, divisions: O.DIVISIONS.length, cccs: O.CCCS.length }, 'app counts');
    ok(live.missing.some((m) => m.level === 'region' && m.code === '6630000'), 'Balurghat region listed as missing');
    eq(live.missing.filter((m) => m.level === 'ccc').length, O.CCCS.length - 2, 'all other CCCs missing');
    ok(!data.root.children[1].live, 'annotate does not change its input');
    const problems = H.check({ name: 'CE', children: [{ level: 'region', name: 'X', confidence: 'maybe' }] });
    ok(problems.some((p) => /"chief_engineer" or "zone" was expected/.test(p)) && problems.some((p) => /confidence "maybe"/.test(p)), 'check() reports level and confidence problems');
    eq(H.check({ level: 'director', name: 'D', children: [{ level: 'chief_engineer', name: 'CE N', children: [{ level: 'zone', name: 'Z', children: [
        { level: 'region', name: 'R', unplacedCccs: [{ level: 'ccc', name: 'U' }], children: [] }] }] }] }), [], 'check(): director → chief engineer → zone → region with unplaced CCCs is fine');
    const ce = H.annotate({ root: { level: 'director', name: 'D', children: [{ level: 'chief_engineer', name: 'CE North', children: [{ level: 'zone', name: 'Malda Zone', code: '6600000', children: [] }] }] } }, O);
    ok(ce.root.children[0].children[0].live === true && !ce.root.children[0].live, 'the live zone is found under a chief engineer');
}

async function api() {
    const app = require(path.join(ROOT, 'server.js'));
    const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${srv.address().port}`;
    const get = async (p, profile) => {
        const headers = { Accept: 'application/json' };
        if (profile) headers.Cookie = cookie(profile);
        const res = await fetch(base + p, { headers });
        const text = await res.text();
        let body = null;
        try { body = JSON.parse(text); } catch (_) { /* not JSON */ }
        return { status: res.status, body, cache: res.headers.get('cache-control') };
    };
    try {
        eq((await get('/api/admin/org')).status, 401, 'no session: 401');
        eq((await get('/api/admin/org', { Username: 'viewer', role: 'viewer' })).status, 403, 'non-admin: 403');
        eq((await get('/api/admin/org', { Username: 'flagged', role: 'viewer', isAdmin: true })).status, 200, 'isAdmin flag: 200');
        eq((await get('/data/org/wbsedcl_hierarchy.json')).status, 404, 'the data file is not served statically');
        const r = await get('/api/admin/org', { Username: 'admin', role: 'admin', email: 'a@example.com' });
        eq(r.status, 200, 'admin: 200');
        ok(/no-store/.test(r.cache || ''), 'not cached');
        const b = r.body;
        eq(b.status, 'success', 'status');
        ok(typeof b.asOf === 'string' && b.asOf.length >= 4, 'asOf');
        ok(Array.isArray(b.sources), 'sources[]');
        eq(b.warnings, [], 'no dataset warnings: ' + JSON.stringify(b.warnings));
        ok(b.root && b.root.name && Array.isArray(b.root.children) && b.root.children.length >= 1, 'root with children');
        // Levels top down; the root's children are chief engineers or zones. Region unplacedCccs count as CCCs.
        const NEXT = { chief_engineer: ['zone'], zone: ['region'], region: ['division'], division: ['ccc'], ccc: [] };
        const counts = { chief_engineer: 0, zone: 0, region: 0, division: 0, ccc: 0, unplaced: 0 };
        const zones = [];
        (function walk(n, allowed) {
            if (allowed) { ok(allowed.includes(n.level), `level of ${n.name}: ${n.level}`); counts[n.level]++; }
            if (n.level === 'zone') zones.push(n);
            ok(!n.confidence || ['confirmed', 'partial', 'inferred'].includes(n.confidence), `confidence of ${n.name}`);
            ok(typeof n.name === 'string' && n.name, 'a name');
            (n.unplacedCccs || []).forEach((c) => { ok(n.level === 'region' && c.name, 'unplaced CCC in a region'); counts.unplaced++; });
            (n.children || []).forEach((c) => walk(c, allowed ? NEXT[n.level] : ['chief_engineer', 'zone']));
        })(b.root, null);
        const liveZones = zones.filter((z) => z.live);
        eq(liveZones.length, 1, 'one live zone');
        const O = require(path.join(ROOT, 'lib', 'offices.js'));
        eq(b.live.zone, liveZones[0].name, 'live.zone names it');
        eq(b.live.missing, [], 'every app office is in the dataset: ' + JSON.stringify(b.live.missing.slice(0, 5)));
        eq(b.live.matched, { regions: O.REGIONS.length, divisions: O.DIVISIONS.length, cccs: O.CCCS.length }, 'all app offices matched');
        console.log(`  repo dataset: ${counts.chief_engineer} chief engineers, ${counts.zone} zones, ${counts.region} regions, ${counts.division} divisions, ` +
            `${counts.ccc} CCCs placed + ${counts.unplaced} unplaced (asOf ${b.asOf}${b.seed ? ', seed' : ''})`);
    } finally {
        srv.close();
    }
}

(async () => {
    units();
    await api();
    console.log(`test-org-api: ${checks} checks passed`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
