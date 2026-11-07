#!/usr/bin/env node
'use strict';
// Test of Ask usage tracking (lib/assistant/usage.js, lib/assistant/limits.js) with no network.
//
//   node vm/dev/test-assistant-usage.js
//   PB_BIN=/path/to/pocketbase TEST_PB_PORT=8193 TEST_TMP=/some/scratch node vm/dev/test-assistant-usage.js
//
// Checks: token mapping from real provider responses (OpenAI-compatible / Gödel, DeepSeek's own cache
// field, Anthropic with cache reads and writes) into one row; the turn within a question; status codes;
// the ring buffer (last 2,000 calls) and that recording never breaks Ask; the limits profiles and their
// env overrides; the aggregation (totals, today vs the daily limits in %, peak requests a minute, the
// per-day / per-hour series, top users, errors, latency, the paid-tier cost); the admin-only handler.
// With a PocketBase binary (vm/pocketbase/local/pocketbase, v0.40.6, or PB_BIN) it also starts a
// throwaway PocketBase (temporary --dir, a copy of the migrations, --automigrate=false), checks that
// app_assistant_usage is created as specified, writes rows through the recorder and reads them back,
// and falls back to memory when PocketBase cannot be reached. Without the binary that part is skipped.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const U = require(path.join(ROOT, 'lib', 'assistant', 'usage.js'));
const L = require(path.join(ROOT, 'lib', 'assistant', 'limits.js'));
const A = require(path.join(ROOT, 'lib', 'assistant', 'index.js'));
const OC = require(path.join(ROOT, 'lib', 'assistant', 'openai_compat.js'));
const AN = require(path.join(ROOT, 'lib', 'assistant', 'anthropic.js'));
const CATALOG = require(path.join(ROOT, 'lib', 'assistant_catalog.js'));
const PB_BIN = process.env.PB_BIN || path.join(ROOT, 'vm', 'pocketbase', 'local', 'pocketbase');
const PB_PORT = Number(process.env.TEST_PB_PORT || 8193);
const PB_URL = `http://127.0.0.1:${PB_PORT}`;
const SU_EMAIL = 't@example.com';
const SU_PASS = 'testpass12345';

let passed = 0;
async function test(name, fn) {
    try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + ((e && e.stack) || e)); process.exitCode = 1; }
}

const NOW = Date.parse('2026-11-07T08:00:00Z'); // 13:30 IST
const at = (iso) => new Date(Date.parse(iso)).toISOString();
function row(created, o) {
    return Object.assign({ created: at(created), user_email: 'a@x.in', user_name: 'A', provider: 'goedel', model: 'deepseek/deepseek-v4.1-flash', turn: 0,
        input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 1000, status: 'ok', tool_calls_count: 0, data_policy: 'retained', retries: 0 }, o || {});
}

async function unitTests() {
    await test('token mapping: OpenAI-compatible (Gödel) response → row', () => {
        const body = { model: 'deepseek/deepseek-v4.1-flash', choices: [{ message: { role: 'assistant', content: null, tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'query_report', arguments: '{}' } },
            { id: 'c2', type: 'function', function: { name: 'open_report', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 5200, completion_tokens: 300, total_tokens: 5500, prompt_tokens_details: { cached_tokens: 4096 }, completion_tokens_details: { reasoning_tokens: 120 } } };
        const r = OC.fromOpenAIResponse(body);
        const out = U.toRow({ meta: { user_email: ' Some.One@Example.com ', user_name: 'Some One', turn: 1 }, provider: 'goedel', model: body.model, usage: r.usage, latencyMs: 1450.4, content: r.content, dataPolicy: 'retained', retries: 1 });
        assert.deepStrictEqual(out, {
            user_email: 'some.one@example.com', user_name: 'Some One', provider: 'goedel', model: 'deepseek/deepseek-v4.1-flash', turn: 1,
            input_tokens: 5200, cached_input_tokens: 4096, output_tokens: 300, reasoning_tokens: 120,
            latency_ms: 1450, status: 'ok', tool_calls_count: 2, data_policy: 'retained', retries: 1
        });
        // DeepSeek's own field name for the cache hit, when a gateway passes it on instead
        const d = OC.fromOpenAIResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 640, prompt_cache_miss_tokens: 360 } });
        assert.deepStrictEqual(U.normalizeTokens('goedel', d.usage), { input_tokens: 1000, cached_input_tokens: 640, output_tokens: 10, reasoning_tokens: 0 });
        // no usage at all: zeros, never NaN
        assert.deepStrictEqual(U.normalizeTokens('goedel', undefined), { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 });
    });

    await test('token mapping: Anthropic response (input_tokens excludes cache reads and writes) → row', async () => {
        const client = { messages: { create: async () => ({ model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }],
            usage: { input_tokens: 40, output_tokens: 90, cache_read_input_tokens: 7000, cache_creation_input_tokens: 500 } }) } };
        const p = AN.create({ sdk: function Anthropic() {}, client });
        const r = await p.complete({ system: ['s'], tools: [], messages: [{ role: 'user', content: 'q' }] });
        assert.deepStrictEqual(r.usage, { input: 40, output: 90, cache_read: 7000, cache_write: 500 });
        assert.deepStrictEqual(U.normalizeTokens('anthropic', r.usage), { input_tokens: 7540, cached_input_tokens: 7000, output_tokens: 90, reasoning_tokens: 0 });
        assert.deepStrictEqual(U.normalizeTokens('anthropic', { input: 10, output: 5, cache_read: 7000 }), { input_tokens: 7010, cached_input_tokens: 7000, output_tokens: 5, reasoning_tokens: 0 });
    });

    await test('turn within a question, and status codes', () => {
        const q = { role: 'user', content: 'How many NSC pending?' };
        const tu = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'query_report', input: {} }] };
        const tr = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }] };
        const ans = { role: 'assistant', content: [{ type: 'text', text: '12.' }] };
        assert.strictEqual(U.turnOf([q]), 0);
        assert.strictEqual(U.turnOf([q, tu, tr]), 1);
        assert.strictEqual(U.turnOf([q, tu, tr, tu, tr]), 2);
        assert.strictEqual(U.turnOf([q, tu, tr, ans, { role: 'user', content: [{ type: 'text', text: 'And Malda?' }] }]), 0, 'a follow-up question starts again');
        assert.strictEqual(U.turnOf(null), 0);
        const E = A.AssistantError;
        assert.deepStrictEqual([null, new E('auth', 'x', { status: 401 }), new E('credit', 'x', { status: 402 }), new E('busy', 'x', { status: 429 }),
            new E('timeout', 'x'), new E('busy', 'queue full'), new E('network', 'x'), new E('upstream', 'x', { status: 503 })].map(U.statusOf),
        ['ok', '401', '402', '429', 'timeout', 'queue', 'network', '503']);
    });

    await test('ring buffer: last 2,000 calls, no PocketBase → memory', () => {
        const usage = U.create({ env: {}, now: () => NOW });
        assert.strictEqual(usage.store, 'memory');
        for (let i = 0; i < 2105; i++) usage.record({ meta: { user_email: 'u' + i + '@x.in', turn: 0 }, provider: 'goedel', usage: { input: i } });
        assert.strictEqual(usage.ring.size, U.RING_MAX);
        const all = usage.ring.since(0);
        assert.strictEqual(all[0].user_email, 'u105@x.in', 'the oldest calls are dropped');
        assert.strictEqual(all[all.length - 1].input_tokens, 2104);
        assert.doesNotThrow(() => usage.record(null));
        assert.doesNotThrow(() => usage.record({ meta: { turn: -3 }, usage: { input: 'x', output: -5 }, content: 'not-an-array' }));
    });

    await test('recording never breaks Ask (onUsage throws), and records successes and failures', async () => {
        const fetchOk = async () => new Response(JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5 } }), { status: 200, headers: { 'X-Data-Policy': 'retained' } });
        const logs = [];
        const boom = A.createAssistant({ env: { GOEDEL_API_KEY: 'sk-gm-free-x' }, catalog: CATALOG, fetch: fetchOk, log: (m) => logs.push(m), onUsage: () => { throw new Error('disk full'); } });
        const r = await boom.complete({ userNote: 'n', messages: [{ role: 'user', content: 'q' }] });
        assert.strictEqual(r.stop_reason, 'end_turn');
        assert.ok(logs.some((l) => /usage not recorded: disk full/.test(l)));
        const seen = [];
        const fetch402 = async () => new Response('{"error":{"message":"balance"}}', { status: 402 });
        const a = A.createAssistant({ env: { GOEDEL_API_KEY: 'sk-gm-free-x' }, catalog: CATALOG, fetch: fetch402, log: () => {}, onUsage: (e) => seen.push(U.toRow(e)) });
        await a.complete({ userNote: 'n', messages: [{ role: 'user', content: 'q' }], meta: { user_email: 'a@x.in', user_name: 'A', turn: 0 } }).catch(() => {});
        assert.deepStrictEqual([seen.length, seen[0].status, seen[0].user_email, seen[0].provider, seen[0].input_tokens], [1, '402', 'a@x.in', 'goedel', 0]);
        assert.deepStrictEqual(Object.keys(seen[0]).sort(), ['cached_input_tokens', 'data_policy', 'input_tokens', 'latency_ms', 'model', 'output_tokens', 'provider', 'reasoning_tokens', 'retries', 'status', 'tool_calls_count', 'turn', 'user_email', 'user_name'], 'metadata only');
    });

    await test('limits: Gödel free / paid, Anthropic (no daily cap), env overrides', () => {
        const free = L.limitsFor('goedel', 'sk-gm-free-abc', {});
        assert.deepStrictEqual([free.profile, free.tier, free.rpm, free.inputPerMinute, free.inputPerDay, free.outputPerDay], ['goedel_free', 'free', 60, 100000, 10000000, 1000000]);
        assert.deepStrictEqual(free.prices, { currency: 'INR', input: 12, cached: 0.25, output: 50, gst: 0.18 });
        assert.strictEqual(L.limitsFor('goedel', 'sk-gm-paid-abc', {}).profile, 'goedel_paid');
        assert.strictEqual(L.limitsFor('goedel', 'sk-gm-paid-abc', { ASSISTANT_TIER: 'free' }).profile, 'goedel_free');
        const claude = L.limitsFor('anthropic', 'sk-ant', {});
        assert.deepStrictEqual([claude.rpm, claude.inputPerDay, claude.outputPerDay, claude.prices], [null, null, null, null]);
        const o = L.limitsFor('goedel', 'sk-gm-free-abc', { ASSISTANT_LIMIT_INPUT_DAY: '20000000', ASSISTANT_LIMIT_OUTPUT_DAY: 'none', ASSISTANT_LIMIT_RPM: '0', ASSISTANT_PRICE_OUTPUT: '40', ASSISTANT_PRICE_GST: 'x' });
        assert.deepStrictEqual([o.inputPerDay, o.outputPerDay, o.rpm, o.prices.output, o.prices.gst], [20000000, null, null, 40, 0.18]);
        assert.strictEqual(free.prices === L.PROFILES.goedel_free.prices, false, 'profiles are not mutated by overrides');
        const cp = L.limitsFor('anthropic', 'k', { ASSISTANT_PRICE_INPUT: '80', ASSISTANT_PRICE_OUTPUT: '400', ASSISTANT_LIMIT_INPUT_DAY: '5000000' });
        assert.deepStrictEqual([cp.prices.input, cp.prices.output, cp.inputPerDay], [80, 400, 5000000]);
        // the assistant exposes them; no key inside
        const asst = A.createAssistant({ env: { GOEDEL_API_KEY: 'sk-gm-free-secret' }, catalog: CATALOG, log: () => {} });
        assert.strictEqual(asst.limits.profile, 'goedel_free');
        assert.ok(!JSON.stringify(asst.limits).includes('secret'));
    });

    await test('aggregation: totals, today vs daily limits, peak minute, series, top users, errors, cost', () => {
        const limits = L.limitsFor('goedel', 'sk-gm-free-x', {});
        const rows = [
            // 3 days ago (in 7d, not in today)
            row('2026-11-04T10:00:00Z', { user_email: 'b@x.in', user_name: 'B', input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 }),
            // yesterday 23:59 UTC (= 05:29 IST today): still yesterday's UTC day
            row('2026-11-06T23:59:00Z', { input_tokens: 9e6, output_tokens: 9e5 }),
            // today: one question of 3 calls by A, heavy tokens; one by B with an error; 2 retries in the peak minute
            row('2026-11-07T01:00:10Z', { turn: 0, input_tokens: 4e6, cached_input_tokens: 1e6, output_tokens: 5e5, reasoning_tokens: 2e5, tool_calls_count: 1, latency_ms: 800, retries: 1 }),
            row('2026-11-07T01:00:40Z', { turn: 1, input_tokens: 4.6e6, cached_input_tokens: 0.1e6, output_tokens: 4.5e5, tool_calls_count: 1, latency_ms: 1200, retries: 1 }),
            row('2026-11-07T01:00:55Z', { turn: 2, input_tokens: 1e3, cached_input_tokens: 0, output_tokens: 1e3, latency_ms: 3000 }),
            row('2026-11-07T07:30:00Z', { user_email: 'b@x.in', user_name: 'B', turn: 0, status: '429', latency_ms: 200, data_policy: '' }),
            row('2026-11-07T07:31:00Z', { user_email: 'b@x.in', user_name: 'B', turn: 0, status: 'queue', latency_ms: 0, data_policy: '' }),
            // future and too old: ignored
            row('2026-10-01T00:00:00Z', { input_tokens: 5 })
        ];
        const today = U.aggregate(rows, { range: 'today', now: NOW, limits, provider: 'goedel', model: 'deepseek/deepseek-v4.1-flash', modelName: 'DeepSeek V4.1 Flash', configured: true });
        assert.deepStrictEqual([today.range, today.days, today.bucket, today.from], ['today', 1, 'hour', '2026-11-07T00:00:00.000Z']);
        assert.deepStrictEqual([today.totals.calls, today.totals.questions, today.totals.users, today.totals.errors], [5, 3, 2, 2]);
        assert.deepStrictEqual(today.totals.errorsByCode, { 429: 1, queue: 1 });
        assert.deepStrictEqual(today.errors.map((e) => [e.code, e.label, e.count]), [['429', 'Rate limited', 1], ['queue', 'Busy here (queue full)', 1]]);
        assert.deepStrictEqual([today.totals.input_tokens, today.totals.cached_input_tokens, today.totals.new_input_tokens, today.totals.output_tokens, today.totals.reasoning_tokens],
            [8601000, 1100000, 7501000, 951000, 200000]);
        assert.deepStrictEqual(today.totals.latency, { p50: 1200, p90: 3000 });
        // today against the free key: 7.501M of 10M new input = 75.0 %, 951K of 1M output = 95.1 %
        assert.deepStrictEqual(today.today.newInput, { used: 7501000, limit: 10000000, pct: 75 });
        assert.deepStrictEqual(today.today.output, { used: 951000, limit: 1000000, pct: 95.1 });
        assert.deepStrictEqual([today.today.rpm.peak, today.today.rpm.at, today.today.rpm.limit, today.today.rpm.pct], [5, '2026-11-07T01:00:00.000Z', 60, 8.3], 'calls + retries in the busiest minute; the queued call never reached the provider');
        assert.deepStrictEqual([today.today.inputPerMinute.peak, today.today.inputPerMinute.limit], [7501000, 100000]);
        assert.deepStrictEqual([today.today.calls, today.today.requests, today.today.resetsAt], [4, 6, '2026-11-08T00:00:00.000Z']);
        // 24 hourly buckets labelled in IST: 00:00 UTC is 05:30 IST
        assert.strictEqual(today.series.length, 24);
        assert.deepStrictEqual([today.series[0].label, today.series[1].label, today.series[1].calls, today.series[7].calls, today.series[7].errors], ['05:30', '06:30', 3, 2, 2]);
        assert.deepStrictEqual(today.topUsers.map((u) => [u.email, u.questions, u.calls, u.errors]), [['b@x.in', 2, 2, 2], ['a@x.in', 1, 3, 0]]);
        assert.deepStrictEqual([today.provider.dataPolicy, today.provider.tier, today.provider.modelName, today.limits.dailyLabel], ['retained', 'free', 'DeepSeek V4.1 Flash', 'free-tier daily limit']);
        // cost if paid: 7.501M × ₹12 + 1.1M × ₹0.25 + 0.951M × ₹50 = 90.012 + 0.275 + 47.55 = 137.837; GST 18 % = 24.81
        assert.deepStrictEqual(today.cost && [today.cost.input, today.cost.cached, today.cost.output, today.cost.subtotal, today.cost.gst, today.cost.total], [90.01, 0.28, 47.55, 137.84, 24.81, 162.65]);

        const week = U.aggregate(rows, { range: '7d', now: NOW, limits });
        assert.deepStrictEqual([week.days, week.bucket, week.series.length, week.from, week.totals.calls], [7, 'day', 7, '2026-11-01T00:00:00.000Z', 7]);
        assert.deepStrictEqual(week.series.slice(-4).map((d) => [d.label, d.calls]), [['2026-11-04', 1], ['2026-11-05', 0], ['2026-11-06', 1], ['2026-11-07', 5]]);
        assert.deepStrictEqual(week.today.newInput, today.today.newInput, 'today is the same whatever the range');
        assert.strictEqual(U.aggregate(rows, { range: '30d', now: NOW, limits }).series.length, 30);
        assert.strictEqual(U.aggregate(rows, { range: 'bogus', now: NOW, limits }).range, 'today');
        // no daily cap (Claude): no percentages
        const claude = U.aggregate(rows, { range: 'today', now: NOW, limits: L.limitsFor('anthropic', 'k', {}) });
        assert.deepStrictEqual([claude.today.newInput.limit, claude.today.newInput.pct, claude.today.output.pct, claude.today.rpm.pct, claude.cost], [null, null, null, null, null]);
        // empty
        const none = U.aggregate([], { range: '7d', now: NOW, limits });
        assert.deepStrictEqual([none.totals.calls, none.totals.latency.p50, none.today.newInput.pct, none.topUsers.length, none.errors.length], [0, null, 0, 0, 0]);
    });

    await test('handler: admins only, range, cache and refresh', async () => {
        let t = NOW;
        const usage = U.create({ env: {}, now: () => t });
        usage.record({ meta: { user_email: 'a@x.in', user_name: 'A', turn: 0 }, provider: 'goedel', model: 'm', usage: { input: 3000, cache_read: 1000, output: 10 } });
        const info = { configured: true, provider: 'goedel', model: 'm', modelName: 'M', limits: L.limitsFor('goedel', '', {}) };
        const h = usage.handler(() => info);
        const call = async (user, query) => {
            const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
            await h({ user, query: query || {} }, res);
            return res;
        };
        assert.strictEqual((await call(null)).code, 401);
        assert.strictEqual((await call({ role: 'viewer' })).code, 403);
        const r = await call({ role: 'admin' }, { range: '30d' });
        assert.deepStrictEqual([r.code, r.body.status, r.body.range, r.body.source, r.body.totals.calls, r.body.today.newInput.used, r.body.memory.max], [200, 'success', '30d', 'memory', 1, 2000, 2000]);
        usage.record({ meta: { turn: 0 }, provider: 'goedel', usage: { input: 1 } });
        assert.strictEqual((await call({ isAdmin: true }, { range: '30d' })).body.totals.calls, 1, 'cached for 15 s');
        assert.strictEqual((await call({ role: 'admin' }, { range: '30d', refresh: '1' })).body.totals.calls, 2, 'refresh=1 reads again');
        t += 16000;
        assert.strictEqual((await call({ role: 'admin' }, { range: '30d' })).body.totals.calls, 2);
    });
}

// ---- PocketBase -----------------------------------------------------------------------------------------
async function startPocketBase(base) {
    const dir = path.join(base, 'pb_data');
    const mig = path.join(base, 'pb_migrations'); // a copy: PocketBase never writes into the repo's folder
    fs.cpSync(path.join(ROOT, 'vm', 'pocketbase', 'pb_migrations'), mig, { recursive: true });
    const up = spawnSync(PB_BIN, ['superuser', 'upsert', SU_EMAIL, SU_PASS, `--dir=${dir}`, `--migrationsDir=${mig}`, '--automigrate=false'], { encoding: 'utf8' });
    if (up.status !== 0) throw new Error('superuser upsert failed: ' + up.stderr + up.stdout);
    const proc = spawn(PB_BIN, ['serve', `--http=127.0.0.1:${PB_PORT}`, `--dir=${dir}`, `--migrationsDir=${mig}`, '--automigrate=false'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    for (let i = 0; i < 100; i++) {
        try { if ((await fetch(`${PB_URL}/api/health`)).ok) return { proc, log: () => out }; } catch (_) { /* not up yet */ }
        if (proc.exitCode !== null) break;
        await new Promise((r) => setTimeout(r, 100));
    }
    proc.kill();
    throw new Error(`PocketBase did not start on ${PB_URL} (is the port free?):\n${out}`);
}

async function pbTests() {
    if (!fs.existsSync(PB_BIN)) {
        console.log(`  skip PocketBase tests: no binary at ${PB_BIN} (set PB_BIN)`);
        return;
    }
    const base = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'mzo-askusage-'));
    let pb;
    try {
        pb = await startPocketBase(base);
        const env = { PB_URL, PB_SUPERUSER_EMAIL: SU_EMAIL, PB_SUPERUSER_PASSWORD: SU_PASS };
        const auth = await (await fetch(`${PB_URL}/api/collections/_superusers/auth-with-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identity: SU_EMAIL, password: SU_PASS }) })).json();
        const admin = (p) => fetch(PB_URL + p, { headers: { Authorization: auth.token } }).then((r) => r.json());

        await test('migration: app_assistant_usage as specified (fields, null rules, index on created)', async () => {
            const c = await admin(`/api/collections/${U.COLLECTION}`);
            assert.strictEqual(c.type, 'base');
            for (const r of ['listRule', 'viewRule', 'createRule', 'updateRule', 'deleteRule']) assert.strictEqual(c[r], null, r);
            const f = Object.fromEntries(c.fields.filter((x) => !x.system).map((x) => [x.name, x.type]));
            assert.deepStrictEqual(f, {
                user_email: 'text', user_name: 'text', provider: 'text', model: 'text', turn: 'number', input_tokens: 'number', cached_input_tokens: 'number',
                output_tokens: 'number', reasoning_tokens: 'number', latency_ms: 'number', status: 'text', tool_calls_count: 'number', retries: 'number', data_policy: 'text', created: 'autodate'
            });
            assert.ok(c.indexes.some((i) => /idx_app_assistant_usage_created.*\(`created`\)/.test(i)));
            // the anonymous API sees nothing
            const anon = await fetch(`${PB_URL}/api/collections/${U.COLLECTION}/records`);
            assert.strictEqual(anon.status, 403);
        });

        await test('PocketBase path: rows written in the background, read back by the report', async () => {
            const usage = U.create({ env, flushMs: 20 });
            assert.strictEqual(usage.store, 'pocketbase');
            usage.record({ meta: { user_email: 'a@x.in', user_name: 'A', turn: 0 }, provider: 'goedel', model: 'deepseek/deepseek-v4.1-flash', usage: { input: 5000, cache_read: 4000, output: 200, reasoning: 50 }, latencyMs: 900, content: [{ type: 'tool_use' }], dataPolicy: 'retained' });
            usage.record({ meta: { user_email: 'a@x.in', user_name: 'A', turn: 1 }, provider: 'goedel', model: 'deepseek/deepseek-v4.1-flash', usage: { input: 5400, cache_read: 5000, output: 80 }, latencyMs: 700, dataPolicy: 'retained' });
            usage.record({ meta: { user_email: 'b@x.in', user_name: 'B', turn: 0 }, provider: 'goedel', model: 'deepseek/deepseek-v4.1-flash', latencyMs: 60000, error: new A.AssistantError('timeout', 'x') });
            await new Promise((r) => setTimeout(r, 60));
            await usage.flush();
            const list = await admin(`/api/collections/${U.COLLECTION}/records?sort=created`);
            assert.strictEqual(list.totalItems, 3);
            assert.deepStrictEqual([list.items[0].input_tokens, list.items[0].cached_input_tokens, list.items[0].reasoning_tokens, list.items[0].tool_calls_count, list.items[2].status], [5000, 4000, 50, 1, 'timeout']);
            usage.ring.clear(); // prove the report reads PocketBase, not memory
            const rep = await usage.report('today', { limits: L.limitsFor('goedel', '', {}), configured: true, provider: 'goedel', model: 'deepseek/deepseek-v4.1-flash' });
            assert.deepStrictEqual([rep.source, rep.totals.calls, rep.totals.questions, rep.totals.users, rep.totals.errors], ['pocketbase', 3, 2, 2, 1]);
            assert.deepStrictEqual([rep.today.newInput.used, rep.today.output.used, rep.totals.errorsByCode.timeout], [1400, 280, 1]);
            assert.strictEqual(rep.today.newInput.pct, 0);
            assert.strictEqual(rep.provider.dataPolicy, 'retained');
        });

        await test('PocketBase unreachable or refusing: Ask goes on, rows stay in memory, the report says so', async () => {
            const logs = [];
            const down = U.create({ env: { PB_URL: 'http://127.0.0.1:9', PB_SUPERUSER_EMAIL: SU_EMAIL, PB_SUPERUSER_PASSWORD: SU_PASS }, flushMs: 10, log: (m) => logs.push(m) });
            down.record({ meta: { turn: 0 }, provider: 'goedel', usage: { input: 10 } });
            await down.flush();
            const rep = await down.report('today', { limits: L.limitsFor('goedel', '', {}) });
            assert.deepStrictEqual([rep.source, rep.totals.calls, !!rep.warning], ['memory', 1, true]);
            const wrong = U.create({ env: { PB_URL, PB_SUPERUSER_EMAIL: SU_EMAIL, PB_SUPERUSER_PASSWORD: 'wrong-password' }, flushMs: 10, log: (m) => logs.push(m) });
            wrong.record({ meta: { turn: 0 }, provider: 'goedel', usage: { input: 10 } });
            await wrong.flush();
            assert.strictEqual(wrong.ring.size, 1);
            assert.ok(logs.length >= 1 && logs.length <= 3, 'warned, not once per call');
        });
    } finally {
        if (pb) pb.proc.kill();
        fs.rmSync(base, { recursive: true, force: true });
    }
}

(async () => {
    console.log('[assistant-usage] mapping, ring buffer, limits, aggregation, handler');
    await unitTests();
    console.log('[assistant-usage] PocketBase');
    await pbTests();
    console.log(process.exitCode ? 'FAILED' : `all ${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
