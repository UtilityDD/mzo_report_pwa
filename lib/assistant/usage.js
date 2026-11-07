'use strict';
// Ask usage tracking (server only): one row per model call, for Admin -> Ask usage.
//
//   const usage = create({ env, log, fetch })
//   usage.record(entry)        after every model call (lib/assistant/index.js onUsage); never throws
//   usage.turnOf(messages)     the call's index within the current question (0 = the question itself)
//   usage.handler(info)        GET /api/admin/assistant-usage?range=today|7d|30d (admins only);
//                              info() → { configured, provider, model, modelName, limits }
//
// Where rows go: PocketBase collection app_assistant_usage when PB_URL, PB_SUPERUSER_EMAIL and
// PB_SUPERUSER_PASSWORD are set (the VM), written in the background in small batches. Every row is
// also kept in an in-memory ring buffer (the last 2,000 calls), which the panel reads when there is
// no PocketBase (a local checkout, Vercel) or when PocketBase cannot be read.
//
// Metadata only: who asked, provider, model, tokens, latency, status, the number of tool calls and
// the X-Data-Policy header. Never the question, the answer or the tool results.
//
// Tokens, the same for every provider:
//   input_tokens         every input token, cached ones included
//   cached_input_tokens  the cached part of input_tokens (new input = input - cached)
//   output_tokens        every output token, reasoning included
//   reasoning_tokens     the reasoning part of output_tokens, when the provider reports it
// OpenAI-compatible (Gödel): prompt_tokens, prompt_tokens_details.cached_tokens, completion_tokens,
// completion_tokens_details.reasoning_tokens. Anthropic: input_tokens counts only uncached input, so
// input = input_tokens + cache_read_input_tokens + cache_creation_input_tokens.

const { isAdmin } = require('../sources_info');

const COLLECTION = 'app_assistant_usage';
const RING_MAX = 2000;
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const IST_MS = 330 * MIN;
const RANGES = { today: 1, '7d': 7, '30d': 30 };
const CACHE_MS = 15 * 1000;
const PB_TIMEOUT_MS = 8000;
const MAX_ROWS = 200000;
const FIELDS = 'created,user_email,user_name,provider,model,turn,input_tokens,cached_input_tokens,output_tokens,reasoning_tokens,latency_ms,status,tool_calls_count,data_policy,retries';
const ERROR_LABELS = {
    401: 'Key not valid', 403: 'Key not allowed', 402: 'Out of credit', 429: 'Rate limited',
    400: 'Bad request', 404: 'Model not found', 413: 'Request too large', 422: 'Bad request',
    timeout: 'Timed out', network: 'Network error', queue: 'Busy here (queue full)', upstream: 'Provider error', error: 'Other error'
};

const int = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };
const clip = (v, max) => String(v == null ? '' : v).slice(0, max);

// ---- One row per call ----------------------------------------------------------------------------
// usage: the provider layer's { input, output, cache_read, cache_write, reasoning } (see the header).
function normalizeTokens(provider, usage) {
    const u = usage || {};
    const cached = int(u.cache_read);
    const input = provider === 'anthropic' ? int(u.input) + cached + int(u.cache_write) : Math.max(int(u.input), cached);
    const output = int(u.output);
    return { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_tokens: Math.min(int(u.reasoning), output || int(u.reasoning)) };
}

// 'ok', the HTTP status ('401', '429', '502'…) or the kind of failure (timeout, network, queue, …).
function statusOf(err) {
    if (!err) return 'ok';
    const s = Number(err.status);
    if (Number.isInteger(s) && s >= 400 && s < 600) return String(s);
    if (err.kind === 'busy') return 'queue'; // the local gate: never reached the provider
    return clip(err.kind || 'error', 20);
}

function isTextBlock(b) { return b && b.type === 'text' && String(b.text || '').trim(); }

// Model calls already made for the question being answered: the assistant turns after the last user
// message that has text (tool results alone continue the same question). 0 = a new question.
function turnOf(messages) {
    if (!Array.isArray(messages)) return 0;
    let turn = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i] || {};
        if (m.role === 'assistant') { turn++; continue; }
        if (typeof m.content === 'string' ? m.content.trim() : Array.isArray(m.content) && m.content.some(isTextBlock)) break;
    }
    return turn;
}

// entry: { meta: { user_email, user_name, turn }, provider, model, usage, latencyMs, error, content, dataPolicy, retries }
function toRow(entry) {
    const e = entry || {};
    const meta = e.meta || {};
    const tokens = normalizeTokens(e.provider, e.usage);
    return Object.assign({
        user_email: clip(String(meta.user_email || '').trim().toLowerCase(), 254),
        user_name: clip(meta.user_name, 200),
        provider: clip(e.provider, 40),
        model: clip(e.model, 120),
        turn: Number.isInteger(meta.turn) && meta.turn >= 0 ? Math.min(meta.turn, 1000) : null
    }, tokens, {
        latency_ms: int(e.latencyMs),
        status: statusOf(e.error),
        tool_calls_count: Array.isArray(e.content) ? e.content.filter((b) => b && b.type === 'tool_use').length : 0,
        data_policy: clip(e.dataPolicy, 40),
        retries: int(e.retries)
    });
}

// ---- In-memory ring buffer -----------------------------------------------------------------------
function createRing(max) {
    const rows = [];
    return {
        push(row) { rows.push(row); if (rows.length > max) rows.splice(0, rows.length - max); },
        since(ms) { return rows.filter((r) => Date.parse(r.created) >= ms); },
        get size() { return rows.length; },
        clear() { rows.length = 0; }
    };
}

// ---- PocketBase (superuser, REST) ----------------------------------------------------------------
function pbClient(env, fetchImpl) {
    const url = String(env.PB_URL || '').trim().replace(/\/+$/, '');
    const email = String(env.PB_SUPERUSER_EMAIL || '').trim();
    const password = String(env.PB_SUPERUSER_PASSWORD || '');
    if (!url || !email || !password) return null;
    const doFetch = fetchImpl || globalThis.fetch;
    let token = '';
    let authing = null;

    async function raw(method, path, body, withAuth) {
        const headers = { Accept: 'application/json' };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (withAuth && token) headers.Authorization = token;
        const res = await doFetch(url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(PB_TIMEOUT_MS) });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
        if (!res.ok) {
            const err = new Error(`PocketBase ${method} ${path.split('?')[0]}: HTTP ${res.status}${data && data.message ? ' ' + data.message : ''}`);
            err.status = res.status;
            throw err;
        }
        return data;
    }
    function auth() {
        if (!authing) {
            authing = raw('POST', '/api/collections/_superusers/auth-with-password', { identity: email, password }, false)
                .then((r) => { token = r && r.token; })
                .finally(() => { authing = null; });
        }
        return authing;
    }
    async function req(method, path, body) {
        if (!token) await auth();
        try { return await raw(method, path, body, true); } catch (err) {
            if (err.status !== 401) throw err;
            await auth();
            return raw(method, path, body, true);
        }
    }
    const records = `/api/collections/${COLLECTION}/records`;
    return {
        create: (body) => req('POST', records, body),
        batch: (rows) => req('POST', '/api/batch', { requests: rows.map((body) => ({ method: 'POST', url: records, body })) }),
        async since(ms) {
            const out = [];
            const filter = `created >= "${new Date(ms).toISOString().replace('T', ' ')}"`;
            for (let page = 1; out.length < MAX_ROWS; page++) {
                const q = new URLSearchParams({ page: String(page), perPage: '1000', skipTotal: '1', sort: 'created', filter, fields: FIELDS });
                const r = await req('GET', `${records}?${q}`);
                const items = (r && r.items) || [];
                out.push(...items);
                if (items.length < 1000) break;
            }
            return out.map((r) => Object.assign({}, r, { created: String(r.created || '').replace(' ', 'T') }));
        }
    };
}

// ---- Aggregation ---------------------------------------------------------------------------------
function utcDayStart(ms) { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
function dayKey(ms) { return new Date(ms).toISOString().slice(0, 10); }
function pct(used, limit) { return limit ? Math.round((used / limit) * 1000) / 10 : null; }
function percentile(sorted, p) {
    if (!sorted.length) return null;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
const reachedProvider = (r) => r.status !== 'queue';
const userKey = (r) => r.user_email || (r.user_name ? 'name:' + String(r.user_name).toLowerCase() : 'unknown');

function sumRows(rows) {
    const t = { calls: 0, questions: 0, input_tokens: 0, cached_input_tokens: 0, new_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, tool_calls: 0, errors: 0 };
    for (const r of rows) {
        t.calls++;
        if (r.turn === 0 || r.turn == null) t.questions++;
        t.input_tokens += int(r.input_tokens);
        t.cached_input_tokens += int(r.cached_input_tokens);
        t.output_tokens += int(r.output_tokens);
        t.reasoning_tokens += int(r.reasoning_tokens);
        t.tool_calls += int(r.tool_calls_count);
        if (r.status !== 'ok') t.errors++;
    }
    t.new_input_tokens = Math.max(0, t.input_tokens - t.cached_input_tokens);
    return t;
}

function peakPerMinute(rows, value) {
    const by = new Map();
    for (const r of rows) {
        const m = Math.floor(Date.parse(r.created) / MIN) * MIN;
        by.set(m, (by.get(m) || 0) + value(r));
    }
    let peak = 0, at = null;
    for (const [m, n] of by) if (n > peak) { peak = n; at = m; }
    return { peak, at: at == null ? null : new Date(at).toISOString() };
}

function costOf(t, prices) {
    if (!prices || prices.input == null || prices.output == null) return null;
    const round = (n) => Math.round(n * 100) / 100;
    const input = (t.new_input_tokens / 1e6) * prices.input;
    const cached = (t.cached_input_tokens / 1e6) * (prices.cached == null ? prices.input : prices.cached);
    const output = (t.output_tokens / 1e6) * prices.output;
    const subtotal = input + cached + output;
    const gst = subtotal * (prices.gst || 0);
    return { currency: prices.currency || 'INR', prices, input: round(input), cached: round(cached), output: round(output), subtotal: round(subtotal), gst: round(gst), total: round(subtotal + gst) };
}

// rows: usage rows ({ created ISO, … }) from at least the start of the range.
// opts: { range, now, limits, provider, model, modelName, configured }
function aggregate(rowsIn, opts) {
    const o = opts || {};
    const range = RANGES[o.range] ? o.range : 'today';
    const days = RANGES[range];
    const now = o.now || Date.now();
    const limits = o.limits || {};
    const todayStart = utcDayStart(now);
    const from = todayStart - (days - 1) * DAY;
    const all = (rowsIn || []).filter((r) => { const t = Date.parse(r.created); return t >= from && t <= now + MIN; })
        .sort((a, b) => Date.parse(a.created) - Date.parse(b.created));

    const totals = sumRows(all);
    totals.users = new Set(all.map(userKey)).size;
    const codes = {};
    for (const r of all) if (r.status !== 'ok') codes[r.status] = (codes[r.status] || 0) + 1;
    totals.errorsByCode = codes;
    const lat = all.filter((r) => r.status === 'ok' && r.latency_ms > 0).map((r) => r.latency_ms).sort((a, b) => a - b);
    totals.latency = { p50: percentile(lat, 50), p90: percentile(lat, 90) };
    const errors = Object.keys(codes).map((code) => ({ code, label: ERROR_LABELS[code] || (/^5\d\d$/.test(code) ? 'Provider error' : code), count: codes[code] }))
        .sort((a, b) => b.count - a.count);

    // Today (UTC day) against the provider's daily and per-minute limits.
    const todayRows = all.filter((r) => Date.parse(r.created) >= todayStart && reachedProvider(r));
    const td = sumRows(todayRows);
    const rpm = peakPerMinute(todayRows, (r) => 1 + int(r.retries));
    const ipm = peakPerMinute(todayRows, (r) => Math.max(0, int(r.input_tokens) - int(r.cached_input_tokens)));
    const today = {
        date: dayKey(todayStart),
        calls: td.calls,
        requests: todayRows.reduce((n, r) => n + 1 + int(r.retries), 0),
        newInput: { used: td.new_input_tokens, limit: limits.inputPerDay || null, pct: pct(td.new_input_tokens, limits.inputPerDay) },
        output: { used: td.output_tokens, limit: limits.outputPerDay || null, pct: pct(td.output_tokens, limits.outputPerDay) },
        rpm: { peak: rpm.peak, at: rpm.at, limit: limits.rpm || null, pct: pct(rpm.peak, limits.rpm) },
        inputPerMinute: { peak: ipm.peak, at: ipm.at, limit: limits.inputPerMinute || null, pct: pct(ipm.peak, limits.inputPerMinute) },
        resetsAt: new Date(todayStart + DAY).toISOString()
    };

    // Chart series: hours of today (labelled in IST) or UTC days.
    const bucket = range === 'today' ? 'hour' : 'day';
    const step = bucket === 'hour' ? HOUR : DAY;
    const n = bucket === 'hour' ? 24 : days;
    const series = [];
    for (let i = 0; i < n; i++) {
        const start = from + i * step;
        const label = bucket === 'hour' ? new Date(start + IST_MS).toISOString().slice(11, 16) : dayKey(start);
        const t = sumRows(all.filter((r) => { const x = Date.parse(r.created); return x >= start && x < start + step; }));
        series.push({ start: new Date(start).toISOString(), label, calls: t.calls, questions: t.questions, input_tokens: t.input_tokens,
            cached_input_tokens: t.cached_input_tokens, new_input_tokens: t.new_input_tokens, output_tokens: t.output_tokens, errors: t.errors });
    }

    // Top users by questions, then tokens.
    const byUser = new Map();
    for (const r of all) {
        const k = userKey(r);
        if (!byUser.has(k)) byUser.set(k, { email: r.user_email || '', name: r.user_name || '', rows: [] });
        const u = byUser.get(k);
        if (r.user_name) u.name = r.user_name;
        u.rows.push(r);
    }
    const topUsers = [...byUser.values()].map((u) => {
        const t = sumRows(u.rows);
        return { email: u.email, name: u.name, questions: t.questions, calls: t.calls, input_tokens: t.input_tokens, new_input_tokens: t.new_input_tokens,
            output_tokens: t.output_tokens, tokens: t.input_tokens + t.output_tokens, errors: t.errors, last: u.rows[u.rows.length - 1].created };
    }).sort((a, b) => b.questions - a.questions || b.tokens - a.tokens).slice(0, 10);

    const latestPolicy = [...all].reverse().find((r) => r.data_policy);
    return {
        range, days, bucket,
        from: new Date(from).toISOString(),
        to: new Date(now).toISOString(),
        totals, errors, today, series, topUsers,
        provider: {
            configured: !!o.configured,
            provider: o.provider || null,
            model: o.model || null,
            modelName: o.modelName || o.model || null,
            label: limits.label || '',
            tier: limits.tier || '',
            dataPolicy: latestPolicy ? latestPolicy.data_policy : '',
            dataPolicyNote: limits.dataPolicyNote || ''
        },
        limits: {
            profile: limits.profile || '', dailyLabel: limits.dailyLabel || 'daily limit',
            rpm: limits.rpm || null, inputPerMinute: limits.inputPerMinute || null, inputPerDay: limits.inputPerDay || null, outputPerDay: limits.outputPerDay || null
        },
        cost: costOf(totals, limits.prices)
    };
}

// ---- The recorder --------------------------------------------------------------------------------
function create(options) {
    const opts = options || {};
    const env = opts.env || process.env;
    const log = opts.log || ((m) => console.warn('[AssistantUsage] ' + m));
    const now = opts.now || Date.now;
    const ring = opts.ring || createRing(opts.ringSize || RING_MAX);
    const pb = opts.pb === undefined ? pbClient(env, opts.fetch) : opts.pb;
    const flushMs = opts.flushMs == null ? 1000 : opts.flushMs;
    let queue = [];
    let timer = null;
    let flushing = null;
    let lastWarn = 0;
    const cache = new Map();

    function warn(msg) {
        if (now() - lastWarn < 10 * MIN) return; // one line per 10 minutes, not one per question
        lastWarn = now();
        log(msg);
    }

    function record(entry) {
        try {
            const row = toRow(entry);
            ring.push(Object.assign({ created: new Date(now()).toISOString() }, row));
            if (!pb) return;
            queue.push(row);
            if (queue.length > 5000) queue = queue.slice(-5000);
            if (!timer) {
                timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, flushMs);
                if (timer.unref) timer.unref();
            }
        } catch (err) {
            warn('could not record a call: ' + (err && err.message));
        }
    }

    async function flush() {
        if (flushing) await flushing;
        if (!pb || !queue.length) return;
        const rows = queue.splice(0, 100);
        flushing = (async () => {
            try {
                await pb.batch(rows);
            } catch (err) {
                // One by one (the batch API may be off); a failure keeps the rows in memory only.
                for (const row of rows) {
                    try { await pb.create(row); } catch (e) { warn(`${COLLECTION} write failed (kept in memory): ${e.message}`); break; }
                }
            }
        })();
        try { await flushing; } finally { flushing = null; }
        if (queue.length) return flush();
    }

    async function rowsSince(ms) {
        if (pb) {
            try { return { source: 'pocketbase', rows: await pb.since(ms) }; } catch (err) {
                warn(`${COLLECTION} read failed: ${err.message}`);
                return { source: 'memory', rows: ring.since(ms), warning: 'PocketBase could not be read; showing the calls this server process remembers (the last 2,000).' };
            }
        }
        return { source: 'memory', rows: ring.since(ms) };
    }

    async function report(range, info) {
        const r = RANGES[range] ? range : 'today';
        const t = now();
        const from = utcDayStart(t) - (RANGES[r] - 1) * DAY;
        const got = await rowsSince(from);
        const body = aggregate(got.rows, Object.assign({}, info, { range: r, now: t }));
        body.source = got.source;
        if (got.source === 'memory') body.memory = { size: ring.size, max: opts.ringSize || RING_MAX };
        if (got.warning) body.warning = got.warning;
        return body;
    }

    function handler(info) {
        return async (req, res) => {
            if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
            if (!isAdmin(req.user)) return res.status(403).json({ status: 'error', message: 'Forbidden: Admin access required.' });
            const range = RANGES[req.query && req.query.range] ? req.query.range : 'today';
            const hit = cache.get(range);
            if (hit && now() - hit.at < CACHE_MS && !(req.query && req.query.refresh)) return res.json(hit.body);
            try {
                const body = Object.assign({ status: 'success', generatedAt: new Date(now()).toISOString() }, await report(range, typeof info === 'function' ? info() : info));
                cache.set(range, { at: now(), body });
                return res.json(body);
            } catch (err) {
                return res.status(500).json({ status: 'error', message: 'Ask usage could not be read: ' + clip(err && err.message, 200) });
            }
        };
    }

    return { record, flush, report, handler, turnOf, ring, store: pb ? 'pocketbase' : 'memory' };
}

module.exports = { create, aggregate, toRow, normalizeTokens, statusOf, turnOf, createRing, pbClient, COLLECTION, RING_MAX, RANGES };
