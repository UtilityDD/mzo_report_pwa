#!/usr/bin/env node
'use strict';
// Test of Ask's provider layer (lib/assistant/), with no network: a local mock answers as an
// OpenAI-compatible Chat Completions server (Gödel Machines) and as the Anthropic Messages API.
//
//   node vm/dev/test-assistant-provider.js
//
// Checks: the Anthropic → OpenAI translation and back over a full multi-turn tool loop with two
// tool calls (ids, arguments, tool results, the system prompt and its addendum, tools as functions,
// thinking blocks dropped); malformed tool arguments; finish_reason → stop_reason; one retry on
// 429 / 5xx with Retry-After (and none when it asks for more than 10 s); 401 / 402 / 429 / timeout
// errors and what the user is told; the concurrency gate (2 in flight, the rest queue); the env
// settings (provider choice, GOEDEL_API_KEY / GODEL_API_KEY, model and base URL overrides); the
// Anthropic path unchanged with a mocked client; and server.js end to end (POST /api/assistant and
// /api/auth/config, and GET /api/admin/assistant-usage from the in-memory ring buffer) with Gödel,
// with Anthropic (the real SDK pointed at the mock) and with no key. Usage capture in detail:
// vm/dev/test-assistant-usage.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const A = require(path.join(ROOT, 'lib', 'assistant', 'index.js'));
const OC = require(path.join(ROOT, 'lib', 'assistant', 'openai_compat.js'));
const AN = require(path.join(ROOT, 'lib', 'assistant', 'anthropic.js'));
const CATALOG = require(path.join(ROOT, 'lib', 'assistant_catalog.js'));
const SECRET = 'test-secret-for-assistant';
const FAKE_KEY = 'sk-gm-free-test-not-a-real-key';

// ---- Mock upstream ---------------------------------------------------------------------------------
// Each request is answered by the next handler in `mock.script` (or mock.fallback):
// handler(req) → { status, headers, body, delayMs }
function startMock() {
    const mock = { requests: [], script: [], fallback: null, inFlight: 0, maxInFlight: 0 };
    const srv = http.createServer((req, res) => {
        let data = '';
        req.on('data', (c) => { data += c; });
        req.on('end', () => {
            let body = null;
            try { body = JSON.parse(data || 'null'); } catch (_) { body = data; }
            const rec = { method: req.method, url: req.url, headers: req.headers, body };
            mock.requests.push(rec);
            const h = mock.script.shift() || mock.fallback;
            const r = h ? h(rec) : { status: 500, body: { error: { message: 'no handler' } } };
            mock.inFlight++;
            mock.maxInFlight = Math.max(mock.maxInFlight, mock.inFlight);
            const send = () => {
                mock.inFlight--;
                if (res.destroyed) return;
                res.writeHead(r.status || 200, Object.assign({ 'Content-Type': 'application/json' }, r.headers || {}));
                res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
            };
            if (r.delayMs) setTimeout(send, r.delayMs); else send();
        });
    });
    return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
        mock.base = `http://127.0.0.1:${srv.address().port}`;
        mock.close = () => new Promise((r) => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(r); });
        mock.reset = () => { mock.requests = []; mock.script = []; mock.fallback = null; mock.maxInFlight = 0; };
        resolve(mock);
    }));
}

const chat = (message, finish, extra) => ({
    status: 200,
    headers: { 'X-Data-Policy': 'retained' },
    body: Object.assign({
        id: 'chatcmpl-1', object: 'chat.completion', model: 'deepseek/deepseek-v4.1-flash',
        choices: [{ index: 0, message: Object.assign({ role: 'assistant', content: null }, message), finish_reason: finish }],
        usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280, prompt_tokens_details: { cached_tokens: 1024 }, completion_tokens_details: { reasoning_tokens: 40 } }
    }, extra || {})
});
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });

let passed = 0;
async function test(name, fn) {
    try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; }
}
const quiet = () => {};

// ---- In-process tests --------------------------------------------------------------------------------
async function unitTests(mock) {
    const provider = (o) => OC.create(Object.assign({ name: 'goedel', apiKey: FAKE_KEY, baseUrl: mock.base + '/v1', warn: quiet, maxRetryWaitMs: 10000 }, o || {}));
    const tools = A.createAssistant({ env: {}, catalog: CATALOG, log: quiet }).tools;
    const SYSTEM = ['SHARED PROMPT', 'Today is 7 November 2026. Office scope: whole zone.'];

    await test('full multi-turn tool loop with two tool calls, both ways', async () => {
        mock.reset();
        const p = provider();
        // Turn 1: the model asks for two tools at once.
        mock.script.push(() => chat({ content: '', reasoning: 'Let me think about which tools to call…', tool_calls: [
            call('call_aa1', 'query_report', { report: 'nsc', view: 'over_30_days', group_by: 'division' }),
            call('call_bb2', 'open_report', { report: 'nsc', division: 'Gazole', view: 'over_30_days', label: 'Gazole · over 30 days' })
        ] }, 'tool_calls'));
        const history = [
            // an earlier turn from an Anthropic session in sessionStorage: its thinking block must be dropped
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret', signature: 'sig' }, { type: 'text', text: 'Hello. Ask me about the reports.' }] },
            { role: 'user', content: 'Which division has the most NSC pending over 30 days? Open Gazole.' }
        ];
        const r1 = await p.complete({ system: SYSTEM, tools, messages: history, maxTokens: 8000 });
        assert.strictEqual(r1.stop_reason, 'tool_use');
        assert.deepStrictEqual(r1.content, [
            { type: 'tool_use', id: 'call_aa1', name: 'query_report', input: { report: 'nsc', view: 'over_30_days', group_by: 'division' } },
            { type: 'tool_use', id: 'call_bb2', name: 'open_report', input: { report: 'nsc', division: 'Gazole', view: 'over_30_days', label: 'Gazole · over 30 days' } }
        ]);
        assert.ok(!JSON.stringify(r1.content).includes('Let me think'), 'reasoning text is not passed on');
        assert.deepStrictEqual(r1.usage, { input: 1200, output: 80, cache_read: 1024, reasoning: 40 });
        assert.strictEqual(r1.dataPolicy, 'retained');
        assert.strictEqual(r1.provider, 'goedel');
        const q1 = mock.requests[0];
        assert.strictEqual(q1.url, '/v1/chat/completions');
        assert.strictEqual(q1.headers.authorization, 'Bearer ' + FAKE_KEY);
        assert.strictEqual(q1.body.model, 'deepseek/deepseek-v4.1-flash');
        assert.strictEqual(q1.body.max_tokens, 8000);
        assert.strictEqual(q1.body.tool_choice, 'auto');
        assert.strictEqual(q1.body.stream, false);
        assert.strictEqual(q1.body.tools.length, 3);
        assert.deepStrictEqual(q1.body.tools[0], { type: 'function', function: { name: tools[0].name, description: tools[0].description, parameters: tools[0].input_schema } });
        assert.strictEqual(q1.body.messages[0].role, 'system');
        assert.strictEqual(q1.body.messages[0].content, ['SHARED PROMPT', OC.ADDENDUM, SYSTEM[1]].join('\n\n'), 'shared prompt, addendum, per-user note');
        assert.deepStrictEqual(q1.body.messages.slice(1), [
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hello. Ask me about the reports.' },
            { role: 'user', content: 'Which division has the most NSC pending over 30 days? Open Gazole.' }
        ]);

        // Turn 2: the browser ran both tools (one failed) and sends the results in one user message.
        const results = { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'call_aa1', content: JSON.stringify({ report: 'NSC', by_office: [{ office: 'Alpha', count: 12 }, { office: 'Beta', count: 7 }] }) },
            { type: 'tool_result', tool_use_id: 'call_bb2', content: 'Report nsc has no view "x".', is_error: true }
        ] };
        const history2 = history.concat([{ role: 'assistant', content: r1.content }, results]);
        mock.script.push(() => chat({ content: 'Alpha has the most: 12 pending over 30 days.' }, 'stop'));
        const r2 = await p.complete({ system: SYSTEM, tools, messages: history2, maxTokens: 8000 });
        assert.strictEqual(r2.stop_reason, 'end_turn');
        assert.deepStrictEqual(r2.content, [{ type: 'text', text: 'Alpha has the most: 12 pending over 30 days.' }]);
        const m2 = mock.requests[1].body.messages.slice(4);
        assert.deepStrictEqual(m2, [
            { role: 'assistant', content: null, tool_calls: [
                { id: 'call_aa1', type: 'function', function: { name: 'query_report', arguments: JSON.stringify({ report: 'nsc', view: 'over_30_days', group_by: 'division' }) } },
                { id: 'call_bb2', type: 'function', function: { name: 'open_report', arguments: JSON.stringify({ report: 'nsc', division: 'Gazole', view: 'over_30_days', label: 'Gazole · over 30 days' }) } }
            ] },
            { role: 'tool', tool_call_id: 'call_aa1', content: results.content[0].content },
            { role: 'tool', tool_call_id: 'call_bb2', content: 'Error: Report nsc has no view "x".' }
        ]);

        // Turn 3: a follow-up question in the same conversation, answered with text and a tool call.
        const history3 = history2.concat([{ role: 'assistant', content: r2.content }, { role: 'user', content: 'And Beta?' }]);
        mock.script.push(() => chat({ content: 'Opening Beta.', tool_calls: [call('call_cc3', 'open_report', { report: 'nsc', division: 'Beta', label: 'Beta' })] }, 'tool_calls'));
        const r3 = await p.complete({ system: SYSTEM, tools, messages: history3 });
        assert.strictEqual(r3.stop_reason, 'tool_use');
        assert.deepStrictEqual(r3.content.map((b) => b.type), ['text', 'tool_use']);
        const m3 = mock.requests[2].body.messages;
        assert.deepStrictEqual(m3.slice(-2), [{ role: 'assistant', content: 'Alpha has the most: 12 pending over 30 days.' }, { role: 'user', content: 'And Beta?' }]);
        assert.strictEqual(m3.length, 9);
        assert.strictEqual(mock.requests[2].body.max_tokens, 8000, 'default max_tokens');
        // The answer stays valid for the server's own check when the browser sends it back.
        assert.ok(A.messagesValid(history3.concat([{ role: 'assistant', content: r3.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: r3.content[1].id, content: '{}' }] }])));
    });

    await test('malformed tool arguments', async () => {
        assert.deepStrictEqual(OC.parseArguments('{"report":"nsc","group_by'), { input: {}, ok: false });
        assert.deepStrictEqual(OC.parseArguments('not json'), { input: {}, ok: false });
        assert.deepStrictEqual(OC.parseArguments('[1,2]'), { input: {}, ok: false });
        assert.deepStrictEqual(OC.parseArguments('```json\n{"report":"loss"}\n```'), { input: { report: 'loss' }, ok: true });
        assert.deepStrictEqual(OC.parseArguments(JSON.stringify(JSON.stringify({ report: 'solar' }))), { input: { report: 'solar' }, ok: true });
        assert.deepStrictEqual(OC.parseArguments(''), { input: {}, ok: true });
        assert.deepStrictEqual(OC.parseArguments({ report: 'nsc' }), { input: { report: 'nsc' }, ok: true });
        mock.reset();
        const warned = [];
        const p = provider({ warn: (m) => warned.push(m) });
        mock.script.push(() => chat({ tool_calls: [call('call_x', 'query_report', '{"report": "nsc", "group_by": '), call('call_y', 'get_briefing', '')] }, 'tool_calls'));
        const r = await p.complete({ system: SYSTEM, tools, messages: [{ role: 'user', content: 'q' }] });
        assert.strictEqual(r.stop_reason, 'tool_use');
        assert.deepStrictEqual(r.content, [{ type: 'tool_use', id: 'call_x', name: 'query_report', input: {} }, { type: 'tool_use', id: 'call_y', name: 'get_briefing', input: {} }]);
        assert.strictEqual(r.malformed, 1);
        assert.ok(warned.some((m) => /malformed arguments for query_report/.test(m)));
        assert.ok(!warned.join(' ').includes('"report"'), 'the arguments themselves are not logged');
    });

    await test('finish_reason → stop_reason, ids, empty answers', () => {
        const f = (msg, finish) => OC.fromOpenAIResponse(chat(msg, finish).body);
        assert.strictEqual(f({ content: 'x' }, 'stop').stop_reason, 'end_turn');
        assert.strictEqual(f({ content: 'x' }, 'length').stop_reason, 'max_tokens');
        assert.strictEqual(f({ content: 'x' }, 'content_filter').stop_reason, 'refusal');
        assert.strictEqual(f({ content: 'x' }, 'something_new').stop_reason, 'end_turn');
        assert.strictEqual(f({ content: 'x' }, 'tool_calls').stop_reason, 'end_turn', 'tool_calls without calls');
        assert.strictEqual(f({ tool_calls: [call('c1', 'get_briefing', '{}')] }, 'tool_calls').stop_reason, 'tool_use');
        assert.strictEqual(f({ tool_calls: [call('c1', 'get_briefing', '{}')] }, 'stop').stop_reason, 'tool_use', 'calls with "stop"');
        assert.strictEqual(f({ tool_calls: [call('c1', 'get_briefing', '{"a"')] }, 'length').stop_reason, 'max_tokens');
        // Empty answer (all output spent on reasoning): still a non-empty assistant turn.
        const e = f({ content: null, reasoning: 'long thoughts' }, 'length');
        assert.strictEqual(e.stop_reason, 'max_tokens');
        assert.strictEqual(e.content.length, 1);
        assert.strictEqual(e.content[0].type, 'text');
        assert.ok(e.content[0].text.length > 0);
        // <think> left in content is removed
        assert.deepStrictEqual(f({ content: '<think>hmm</think>\nAnswer.' }, 'stop').content, [{ type: 'text', text: 'Answer.' }]);
        // bad or duplicate ids are replaced with valid, unique ones
        const d = f({ tool_calls: [call('dup', 'get_briefing', '{}'), call('dup', 'get_briefing', '{}'), call('has space', 'get_briefing', '{}'), call('', 'get_briefing', '{}')] }, 'tool_calls');
        const ids = d.content.map((b) => b.id);
        assert.strictEqual(new Set(ids).size, 4);
        assert.strictEqual(ids[0], 'dup');
        ids.forEach((id) => assert.ok(/^[a-zA-Z0-9_-]+$/.test(id), id));
    });

    await test('one retry on 429 honouring Retry-After; none beyond 10 s; 5xx retried once', async () => {
        mock.reset();
        const p = provider();
        mock.script.push(() => ({ status: 429, headers: { 'Retry-After': '1' }, body: { error: { message: 'rate limited' } } }));
        mock.script.push(() => chat({ content: 'ok' }, 'stop'));
        const t0 = Date.now();
        const r = await p.complete({ system: SYSTEM, tools, messages: [{ role: 'user', content: 'q' }] });
        assert.strictEqual(r.retries, 1);
        assert.ok(Date.now() - t0 >= 950, 'waited for Retry-After');
        assert.strictEqual(mock.requests.length, 2);

        mock.reset();
        mock.script.push(() => ({ status: 429, headers: { 'Retry-After': '30' }, body: { error: { message: 'capacity' } } }));
        await assert.rejects(p.complete({ system: SYSTEM, tools, messages: [{ role: 'user', content: 'q' }] }), (e) => e.kind === 'busy' && e.retries === 0);
        assert.strictEqual(mock.requests.length, 1, 'no retry when asked to wait 30 s');

        mock.reset();
        mock.fallback = () => ({ status: 503, body: 'upstream down' });
        await assert.rejects(provider({ maxRetryWaitMs: 10000 }).complete({ system: SYSTEM, tools, messages: [{ role: 'user', content: 'q' }] }), (e) => e.kind === 'upstream' && e.retries === 1);
        assert.strictEqual(mock.requests.length, 2, 'one retry only');

        assert.strictEqual(OC.retryAfterMs('2'), 2000);
        assert.ok(Math.abs(OC.retryAfterMs(new Date(Date.now() + 5000).toUTCString()) - 5000) < 1500);
        assert.strictEqual(OC.retryAfterMs(null), null);
    });

    await test('401 / 402 / 400 / 413 / timeout → what the user is told', async () => {
        const p = provider({ timeoutMs: 300 });
        const cases = [
            [401, 'auth', 503, 'not_configured'],
            [402, 'credit', 503, 'no_credit'],
            [400, 'bad_request', 400, 'bad_request'],
            [413, 'bad_request', 400, 'bad_request']
        ];
        for (const [status, kind, httpStatus, code] of cases) {
            mock.reset();
            mock.script.push(() => ({ status, body: { error: { message: 'x', code: status === 402 ? 'insufficient_balance' : 'e' } } }));
            const err = await p.complete({ system: SYSTEM, tools, messages: [{ role: 'user', content: 'q' }] }).then(() => null, (e) => e);
            assert.ok(err, 'rejects on ' + status);
            assert.strictEqual(err.kind, kind);
            assert.strictEqual(mock.requests.length, 1, 'no retry on ' + status);
            const reply = A.replyFor(err);
            assert.strictEqual(reply.status, httpStatus);
            assert.strictEqual(reply.code, code);
            assert.ok(!reply.message.includes(FAKE_KEY));
        }
        assert.match(A.replyFor({ kind: 'credit' }).message, /credit/);
        assert.match(A.replyFor({ kind: 'busy' }).message, /busy/);
        assert.strictEqual(A.replyFor({ kind: 'busy' }).status, 429);
        mock.reset();
        mock.fallback = () => ({ delayMs: 1500, ...chat({ content: 'late' }, 'stop') });
        const t0 = Date.now();
        const err = await p.complete({ system: SYSTEM, tools, messages: [{ role: 'user', content: 'q' }] }).then(() => null, (e) => e);
        assert.ok(err && err.kind === 'timeout', 'timeout: ' + (err && err.kind));
        assert.ok(Date.now() - t0 < 1400, 'gave up at the timeout');
        assert.strictEqual(A.replyFor(err).status, 504);
        // the caller going away aborts the request
        mock.reset();
        mock.fallback = () => ({ delayMs: 800, ...chat({ content: 'late' }, 'stop') });
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 100);
        const ab = await provider().complete({ system: SYSTEM, tools, messages: [{ role: 'user', content: 'q' }], signal: ctrl.signal }).then(() => null, (e) => e);
        assert.ok(ab && ab.kind === 'aborted');
    });

    await test('concurrency gate: 2 in flight, the rest queue and all succeed', async () => {
        while (mock.inFlight > 0) await new Promise((r) => setTimeout(r, 50)); // late answers of the timeout test
        mock.reset();
        mock.fallback = () => ({ delayMs: 200, ...chat({ content: 'ok' }, 'stop') });
        const logs = [];
        const asst = A.createAssistant({ env: { GOEDEL_API_KEY: FAKE_KEY, ASSISTANT_BASE_URL: mock.base + '/v1' }, catalog: CATALOG, log: (m) => logs.push(m) });
        const rs = await Promise.all(Array.from({ length: 5 }, () => asst.complete({ userNote: 'note', messages: [{ role: 'user', content: 'q' }] })));
        assert.strictEqual(rs.length, 5);
        assert.strictEqual(mock.maxInFlight, 2);
        assert.strictEqual(asst.gate.active, 0);
        assert.strictEqual(asst.gate.waiting, 0);
        // per-request log: provider, model, latency, usage, data policy; never the key or the conversation
        const ok = logs.filter((l) => / ok \d+ ms/.test(l));
        assert.strictEqual(ok.length, 5);
        assert.match(ok[0], /^goedel deepseek\/deepseek-v4\.1-flash ok \d+ ms.* stop=end_turn in=1200 out=80 cached=1024 reasoning=40 data-policy=retained/);
        assert.ok(ok.some((l) => /queued \d+ ms/.test(l)), 'queued requests say so');
        assert.ok(!logs.join('\n').includes(FAKE_KEY), 'key never logged');
        assert.ok(!logs.join('\n').includes('note'), 'conversation never logged');
        // a queued request whose caller goes away leaves the queue
        const g = A.createGate(1);
        let release;
        const first = g.run(() => new Promise((r) => { release = r; }));
        const ctrl = new AbortController();
        const second = g.run(() => 'never', ctrl.signal).then(() => 'ran', (e) => e.kind);
        assert.strictEqual(g.waiting, 1);
        ctrl.abort();
        assert.strictEqual(await second, 'aborted');
        assert.strictEqual(g.waiting, 0);
        release('done');
        assert.strictEqual(await first, 'done');
        assert.strictEqual(await A.createGate(0).run(() => 'unlimited'), 'unlimited');
    });

    await test('env settings', () => {
        const R = A.resolveConfig;
        assert.strictEqual(R({}).provider, null);
        assert.strictEqual(R({ ANTHROPIC_API_KEY: 'a' }).provider, 'anthropic');
        assert.strictEqual(R({}, { anthropicApiKey: 'a' }).provider, 'anthropic');
        const g = R({ GOEDEL_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' });
        assert.deepStrictEqual([g.provider, g.apiKey, g.model, g.baseUrl, g.maxConcurrency, g.maxTokens], ['goedel', 'g', 'deepseek/deepseek-v4.1-flash', 'https://api.goedelmachines.com/v1', 2, 8000]);
        assert.strictEqual(R({ GODEL_API_KEY: 'g2' }).apiKey, 'g2', 'GODEL_API_KEY accepted');
        assert.strictEqual(R({ GODEL_API_KEY: 'g2', GOEDEL_API_KEY: 'g1' }).apiKey, 'g1', 'GOEDEL_API_KEY wins');
        assert.strictEqual(R({ GOEDEL_API_KEY: '  ', ANTHROPIC_API_KEY: 'a' }).provider, 'anthropic', 'blank key is no key');
        const an = R({ ASSISTANT_PROVIDER: 'anthropic', GOEDEL_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' });
        assert.deepStrictEqual([an.provider, an.apiKey, an.model, an.baseUrl, an.maxConcurrency, an.maxTokens], ['anthropic', 'a', 'claude-haiku-5-5', '', 0, 16000]);
        assert.strictEqual(R({ ASSISTANT_PROVIDER: 'anthropic', GOEDEL_API_KEY: 'g' }).provider, null, 'chosen provider without its key: off');
        assert.strictEqual(R({ ASSISTANT_PROVIDER: 'goedel', ANTHROPIC_API_KEY: 'a' }).provider, null);
        assert.strictEqual(R({ ASSISTANT_PROVIDER: 'Goedel', GOEDEL_API_KEY: 'g' }).provider, 'goedel');
        const unk = R({ ASSISTANT_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'a' });
        assert.strictEqual(unk.provider, 'anthropic');
        assert.ok(unk.warning);
        const o = R({ GOEDEL_API_KEY: 'g', ASSISTANT_MODEL: 'some/other-model', ASSISTANT_BASE_URL: 'https://llm.example/v1', ASSISTANT_MAX_CONCURRENCY: '5' });
        assert.deepStrictEqual([o.model, o.baseUrl, o.maxConcurrency], ['some/other-model', 'https://llm.example/v1', 5]);
        assert.strictEqual(R({ ANTHROPIC_API_KEY: 'a', ASSISTANT_MAX_CONCURRENCY: '3' }).maxConcurrency, 3);
        assert.strictEqual(A.modelName('deepseek/deepseek-v4.1-flash'), 'DeepSeek V4.1 Flash');
        assert.strictEqual(A.modelName('claude-haiku-5-5'), 'Claude Haiku');
        assert.strictEqual(A.modelName('x/y'), 'x/y');
        const off = A.createAssistant({ env: {}, catalog: CATALOG, log: quiet });
        assert.strictEqual(off.configured, false);
    });

    await test('Anthropic path unchanged (mocked client)', async () => {
        const SDK = require(path.join(ROOT, 'node_modules', '@anthropic-ai', 'sdk'));
        const Anthropic = SDK.default || SDK;
        const seen = [];
        let next = null;
        const client = { messages: { create: async (params, options) => { seen.push({ params, options }); if (next) { const e = next; next = null; throw e; } return {
            id: 'msg_1', model: 'claude-haiku-5-5', stop_reason: 'tool_use',
            content: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'tool_use', id: 'toolu_01', name: 'get_briefing', input: {} }],
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7000 }
        }; } } };
        const asst = A.createAssistant({ env: { ANTHROPIC_API_KEY: 'sk-ant-test', ASSISTANT_PROVIDER: 'anthropic', GOEDEL_API_KEY: FAKE_KEY }, catalog: CATALOG, anthropicClient: client, log: quiet });
        assert.strictEqual(asst.provider, 'anthropic');
        const messages = [
            { role: 'user', content: 'What needs attention?' },
            { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 'y' }, { type: 'tool_use', id: 'toolu_00', name: 'get_briefing', input: {} }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_00', content: '{"items":[]}' }] }
        ];
        const r = await asst.complete({ userNote: 'Today is X.', messages });
        const p = seen[0].params;
        assert.strictEqual(p.model, 'claude-haiku-5-5');
        assert.strictEqual(p.max_tokens, 16000);
        assert.deepStrictEqual(p.output_config, { effort: 'low' });
        assert.deepStrictEqual(p.system, [{ type: 'text', text: asst.system, cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'Today is X.' }]);
        assert.ok(!p.system[0].text.includes('Tool rules:'), 'no DeepSeek addendum for Claude');
        assert.strictEqual(p.tools, asst.tools);
        assert.strictEqual(p.messages, messages, 'conversation passed through unchanged');
        assert.strictEqual(r.stop_reason, 'tool_use');
        assert.strictEqual(r.content[0].type, 'thinking', 'thinking blocks returned unchanged');
        assert.deepStrictEqual(r.usage, { input: 10, output: 5, cache_read: 7000 });
        // SDK errors → the same replies as before
        const mk = (Cls, status) => Object.assign(Object.create(Cls.prototype), { message: 'm', status });
        for (const [err, status, code] of [[mk(Anthropic.RateLimitError, 429), 429, 'busy'], [mk(Anthropic.AuthenticationError, 401), 503, 'not_configured'],
            [mk(Anthropic.PermissionDeniedError, 403), 503, 'not_configured'], [mk(Anthropic.BadRequestError, 400), 400, 'bad_request'],
            [mk(Anthropic.InternalServerError, 500), 502, 'upstream'], [new Error('boom'), 500, 'error']]) {
            next = err;
            const e = await asst.complete({ userNote: 'n', messages: [{ role: 'user', content: 'q' }] }).then(() => null, (x) => x);
            const reply = A.replyFor(e);
            assert.deepStrictEqual([reply.status, reply.code], [status, code], err.constructor.name);
        }
        // default client options, as before
        const made = AN.create({ apiKey: 'k', sdk: { default: function F(o) { this.o = o; this.messages = {}; } } });
        assert.strictEqual(made.model, 'claude-haiku-5-5');
    });
}

// ---- server.js end to end (child process per configuration) --------------------------------------------
async function child() {
    const DATA = path.join(ROOT, 'data') + path.sep;
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mzo-test-data-'));
    const inData = (p) => (path.resolve(String(p)) + path.sep).startsWith(DATA);
    const moved = (p) => path.join(sandbox, path.relative(DATA, path.resolve(String(p))));
    const { writeFileSync, mkdirSync, readFileSync } = fs;
    fs.writeFileSync = (p, ...a) => writeFileSync(inData(p) ? moved(p) : p, ...a);
    fs.mkdirSync = (p, ...a) => (inData(p) ? undefined : mkdirSync(p, ...a));
    fs.readFileSync = (p, ...a) => readFileSync(inData(p) && fs.existsSync(moved(p)) ? moved(p) : p, ...a);
    const realFetch = global.fetch;
    const upstream = [];
    global.fetch = async (input, opts) => {
        const url = String(input && input.url ? input.url : input);
        if (url.startsWith('http://127.0.0.1:')) return realFetch(input, opts);
        upstream.push(String((opts && opts.method) || 'GET') + ' ' + url.replace(/\?.*$/, ''));
        return new Response('{"message":"refused by the test"}', { status: 599 });
    };
    const logs = [];
    const origLog = console.log, origWarn = console.warn, origErr = console.error;
    const keep = (f) => (...a) => { const s = a.join(' '); if (s.includes('[Assistant]')) logs.push(s); else f(...a); };
    console.log = keep(origLog); console.warn = keep(origWarn); console.error = keep(origErr);
    const app = require(path.join(ROOT, 'server.js'));
    const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${srv.address().port}`;
    const payload = Buffer.from(JSON.stringify({ profile: { Username: 'tester', Name: 'Tester', role: 'admin', office_level: 'CE' }, expiry: Date.now() + 3600e3 })).toString('base64');
    const cookie = 'mzo_session=' + encodeURIComponent(payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64'));
    const out = {};
    const post = async (name, messages) => {
        const res = await realFetch(base + '/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Cookie: cookie, Origin: base }, body: JSON.stringify({ messages, context: { scope: '' } }) });
        out[name] = { status: res.status, body: await res.json() };
    };
    out.config = await realFetch(base + '/api/auth/config').then((r) => r.json());
    out.private = await Promise.all(['/lib/assistant/index.js', '/lib/assistant/openai_compat.js', '/lib/%61ssistant/prompt.js', '/LIB/ASSISTANT/anthropic.js'].map((p) => realFetch(base + p).then((r) => r.status)));
    out.catalog = await realFetch(base + '/lib/assistant_catalog.js').then((r) => r.status);
    await post('ask', [{ role: 'user', content: 'What needs attention today?' }]);
    await post('loop', [
        { role: 'user', content: 'What needs attention today?' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_briefing', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"items":[{"item":"Synthetic item","value":"3"}]}' }] }
    ]);
    await post('invalid', [{ role: 'assistant', content: 'x' }]);
    if (process.env.TEST_MODE === 'goedel') await post('credit', [{ role: 'user', content: 'credit?' }]);
    // Admin -> Ask usage: the ring buffer (no PocketBase here), admins only.
    const viewerPayload = Buffer.from(JSON.stringify({ profile: { Username: 'viewer1', Name: 'Viewer', role: 'viewer', office_level: 'CE' }, expiry: Date.now() + 3600e3 })).toString('base64');
    const viewerCookie = 'mzo_session=' + encodeURIComponent(viewerPayload + '.' + crypto.createHmac('sha256', SECRET).update(viewerPayload).digest('base64'));
    const getUsage = async (c, q) => { const res = await realFetch(base + '/api/admin/assistant-usage' + (q || ''), { headers: Object.assign({ Accept: 'application/json' }, c ? { Cookie: c } : {}) }); return { status: res.status, body: await res.json().catch(() => null) }; };
    out.usage = await getUsage(cookie, '?range=7d');
    out.usageViewer = (await getUsage(viewerCookie)).status;
    out.usageAnon = (await getUsage(null)).status;
    srv.close();
    console.log = origLog;
    fs.writeFileSync(process.env.TEST_OUT, JSON.stringify({ out, logs, upstream }));
    fs.rmSync(sandbox, { recursive: true, force: true });
    process.exit(0);
}

function runChild(env) {
    const out = path.join(os.tmpdir(), `mzo-test-assistant-${process.pid}-${env.TEST_MODE}.json`);
    const clean = Object.assign({}, process.env);
    ['GOEDEL_API_KEY', 'GODEL_API_KEY', 'ANTHROPIC_API_KEY', 'ASSISTANT_PROVIDER', 'PB_URL', 'PB_SUPERUSER_EMAIL', 'PB_SUPERUSER_PASSWORD', 'ASSISTANT_TIER', 'ASSISTANT_MODEL', 'ASSISTANT_BASE_URL', 'ASSISTANT_MAX_CONCURRENCY', 'ANTHROPIC_BASE_URL', 'MZO_DATA_MODE', 'MZO_USER_STORE', 'MZO_LOCAL_ADMINS', 'NODE_OPTIONS'].forEach((k) => delete clean[k]);
    const sandboxFiles = fs.mkdtempSync(path.join(os.tmpdir(), 'mzo-test-files-'));
    return new Promise((resolve, reject) => {
        const p = spawn(process.execPath, [__filename, '--child'], { env: Object.assign(clean, { JWT_SECRET: SECRET, MZO_FILES_DIR: sandboxFiles, TEST_OUT: out, PORT: '0' }, env), stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '';
        p.stdout.on('data', () => {});
        p.stderr.on('data', (d) => { err += d; });
        p.on('exit', (code) => {
            fs.rmSync(sandboxFiles, { recursive: true, force: true });
            if (code !== 0 || !fs.existsSync(out)) return reject(new Error(`child ${env.TEST_MODE} exited ${code}: ${err.slice(-2000)}`));
            const r = JSON.parse(fs.readFileSync(out, 'utf8'));
            fs.rmSync(out, { force: true });
            resolve(r);
        });
    });
}

async function serverTests(mock) {
    await test('server.js with Gödel (GODEL_API_KEY): /api/assistant and /api/auth/config', async () => {
        mock.reset();
        mock.script.push(() => chat({ tool_calls: [call('call_1', 'get_briefing', '{}')] }, 'tool_calls'));
        mock.script.push(() => chat({ content: 'One synthetic item needs attention.' }, 'stop'));
        mock.script.push(() => ({ status: 402, body: { error: { code: 'insufficient_balance', message: 'balance' } } }));
        const r = await runChild({ TEST_MODE: 'goedel', GODEL_API_KEY: FAKE_KEY, ASSISTANT_BASE_URL: mock.base + '/v1' });
        assert.deepStrictEqual([r.out.config.assistantProvider, r.out.config.assistantModel], ['goedel', 'DeepSeek V4.1 Flash']);
        assert.ok(!JSON.stringify(r.out.config).includes(FAKE_KEY));
        assert.strictEqual(r.out.ask.status, 200);
        assert.deepStrictEqual(r.out.ask.body, { status: 'success', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'call_1', name: 'get_briefing', input: {} }], usage: { input: 1200, output: 80, cache_read: 1024 } });
        assert.strictEqual(r.out.loop.body.stop_reason, 'end_turn');
        assert.deepStrictEqual(r.out.loop.body.content, [{ type: 'text', text: 'One synthetic item needs attention.' }]);
        assert.strictEqual(r.out.invalid.status, 400);
        assert.deepStrictEqual([r.out.credit.status, r.out.credit.body.code], [503, 'no_credit']);
        const sys = mock.requests[0].body.messages[0].content;
        assert.ok(sys.startsWith('You are the assistant inside MZO Reports'));
        assert.ok(sys.includes('Tool rules:'));
        assert.match(sys, /The signed-in user is Tester \(administrator\)\. Office scope: whole zone\.$/);
        assert.deepStrictEqual(mock.requests[1].body.messages.slice(2), [
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_briefing', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'call_1', content: '{"items":[{"item":"Synthetic item","value":"3"}]}' }
        ]);
        assert.strictEqual(mock.requests.length, 3);
        assert.ok(r.logs.some((l) => /provider goedel, model deepseek\/deepseek-v4\.1-flash/.test(l)));
        assert.ok(r.logs.some((l) => /goedel deepseek\/deepseek-v4\.1-flash ok \d+ ms .*data-policy=retained/.test(l)));
        assert.ok(r.logs.some((l) => /failed .*kind=credit status=402/.test(l)));
        assert.ok(!r.logs.join('\n').includes(FAKE_KEY) && !r.logs.join('\n').includes('What needs attention'), 'no key or content in logs');
        assert.deepStrictEqual(r.upstream.filter((u) => !u.startsWith('GET')), [], 'no upstream writes');
        // Ask usage: one row per model call (the invalid conversation never reached the model)
        assert.deepStrictEqual([r.out.usage.status, r.out.usageViewer, r.out.usageAnon], [200, 403, 401]);
        const u = r.out.usage.body;
        assert.strictEqual(u.source, 'memory');
        assert.deepStrictEqual([u.totals.calls, u.totals.questions, u.totals.users, u.totals.errors], [3, 2, 1, 1]);
        assert.deepStrictEqual([u.totals.input_tokens, u.totals.cached_input_tokens, u.totals.new_input_tokens, u.totals.output_tokens, u.totals.reasoning_tokens, u.totals.tool_calls], [2400, 2048, 352, 160, 80, 1]);
        assert.deepStrictEqual(u.totals.errorsByCode, { 402: 1 });
        assert.deepStrictEqual([u.provider.provider, u.provider.model, u.provider.tier, u.provider.dataPolicy], ['goedel', 'deepseek/deepseek-v4.1-flash', 'free', 'retained']);
        assert.deepStrictEqual([u.today.newInput.used, u.today.newInput.limit, u.today.output.limit, u.today.rpm.limit], [352, 10000000, 1000000, 60]);
        assert.strictEqual(u.topUsers[0].name, 'Tester');
        assert.strictEqual(u.series.length, 7);
        const text = JSON.stringify(u);
        assert.ok(!text.includes('What needs attention') && !text.includes('Synthetic item') && !text.includes('credit?') && !text.includes(FAKE_KEY), 'no conversation or key in the usage report');
    });

    await test('server.js with Anthropic (real SDK against the mock)', async () => {
        mock.reset();
        const msg = (content, stop) => () => ({ status: 200, headers: { 'request-id': 'req_1' }, body: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 6, cache_read_input_tokens: 7000 } } });
        mock.script.push(msg([{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'tool_use', id: 'toolu_1', name: 'get_briefing', input: {} }], 'tool_use'));
        mock.script.push(msg([{ type: 'text', text: 'Done.' }], 'end_turn'));
        const r = await runChild({ TEST_MODE: 'anthropic', ASSISTANT_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test-not-real', GOEDEL_API_KEY: FAKE_KEY, ANTHROPIC_BASE_URL: mock.base });
        assert.deepStrictEqual([r.out.config.assistantProvider, r.out.config.assistantModel], ['anthropic', 'Claude Haiku']);
        assert.strictEqual(r.out.ask.status, 200);
        assert.deepStrictEqual(r.out.ask.body, { status: 'success', stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'tool_use', id: 'toolu_1', name: 'get_briefing', input: {} }], usage: { input: 20, output: 6, cache_read: 7000 } });
        assert.strictEqual(r.out.loop.body.stop_reason, 'end_turn');
        // Ask usage: Anthropic's input_tokens excludes the cache read, so input = 20 + 7000 per call
        const u = r.out.usage.body;
        assert.deepStrictEqual([u.totals.calls, u.totals.questions, u.totals.input_tokens, u.totals.cached_input_tokens, u.totals.output_tokens], [2, 1, 14040, 14000, 12]);
        assert.deepStrictEqual([u.provider.provider, u.today.newInput.limit, u.today.rpm.limit, u.cost], ['anthropic', null, null, null]);
        const q = mock.requests[0];
        assert.strictEqual(q.url, '/v1/messages');
        assert.ok([q.headers['x-api-key'], q.headers.authorization].some((h) => String(h || '').includes('sk-ant-test-not-real')), 'the Anthropic key is sent');
        assert.strictEqual(q.body.model, 'claude-haiku-5-5');
        assert.strictEqual(q.body.max_tokens, 16000);
        assert.deepStrictEqual(q.body.output_config, { effort: 'low' });
        assert.deepStrictEqual(q.body.system[0].cache_control, { type: 'ephemeral' });
        assert.ok(q.body.system[0].text.startsWith('You are the assistant inside MZO Reports') && !q.body.system[0].text.includes('Tool rules:'));
        assert.strictEqual(q.body.tools[0].name, 'open_report');
        assert.ok(q.body.tools[0].input_schema);
        assert.deepStrictEqual(mock.requests[1].body.messages[1].content, [{ type: 'tool_use', id: 'call_1', name: 'get_briefing', input: {} }]);
        assert.strictEqual(r.out.invalid.status, 400);
    });

    await test('server.js with no key: not configured', async () => {
        mock.reset();
        const r = await runChild({ TEST_MODE: 'off' });
        assert.deepStrictEqual(r.out.private, [404, 404, 404, 404], 'lib/assistant/ is server code, never served');
        assert.strictEqual(r.out.catalog, 200, 'the shared catalogue is still served');
        assert.strictEqual(r.out.config.assistantProvider, undefined);
        assert.strictEqual(r.out.config.assistantModel, undefined);
        assert.deepStrictEqual([r.out.ask.status, r.out.ask.body.code], [503, 'not_configured']);
        assert.strictEqual(mock.requests.length, 0);
    });
}

if (process.argv.includes('--child')) {
    child().catch((e) => { console.error(e); process.exit(1); });
} else {
    (async () => {
        const mock = await startMock();
        console.log('[assistant-provider] translation, retries, errors, gate, settings, Anthropic');
        await unitTests(mock);
        console.log('[assistant-provider] server.js end to end');
        await serverTests(mock);
        await mock.close();
        console.log(process.exitCode ? 'FAILED' : `all ${passed} passed`);
    })().catch((e) => { console.error(e); process.exit(1); });
}
