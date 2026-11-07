'use strict';
// Ask provider for OpenAI-compatible Chat Completions endpoints (default: Gödel Machines,
// DeepSeek V4.1 Flash). The browser keeps the conversation in Anthropic Messages format, so this
// module translates both ways:
//   request:  system strings → one system message; tools → {type:'function', function:{…}};
//             assistant tool_use → tool_calls; user tool_result → role:'tool' messages;
//             thinking / redacted_thinking blocks are dropped.
//   response: tool_calls → tool_use blocks (ids kept, JSON arguments parsed, malformed → {});
//             reasoning text is ignored; finish_reason → stop_reason.
// One retry on 429 / 5xx / network error (Retry-After honoured up to 10 s), 60 s per attempt.

const { AssistantError } = require('./errors.js');

const DEFAULT_BASE_URL = 'https://api.goedelmachines.com/v1';
const DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash';
const MAX_RETRY_WAIT_MS = 10 * 1000;

// Added to the shared system prompt for this provider: DeepSeek follows explicit tool rules better.
const ADDENDUM = [
    'Tool rules:',
    '- For any count, total, comparison, ranking or "how many" question, call query_report (or get_briefing for "what needs attention") first and answer only from its result. If you have no tool result for a number, do not write that number.',
    '- When the question asks to show, open, list or see something, your reply must include an open_report call (you may also call query_report for the number). Mention "the button" only when you called open_report for it.',
    '- In tool inputs use only the report keys, view names and canonical office names listed above, as bare names ("Malda", not "Malda division"). Leave a field out rather than guess. Always give group_by for query_report ("none" for one total).',
    '- Call the tool directly; do not announce or describe the call in your text. You may call several tools at once when the question needs them.',
    '- Write plain text with short bullets only: no tables, no headings, no code blocks.'
].join('\n');

const FINISH_TO_STOP = { tool_calls: 'tool_use', function_call: 'tool_use', stop: 'end_turn', length: 'max_tokens', content_filter: 'refusal' };
const ID_OK = /^[a-zA-Z0-9_-]{1,64}$/;

function textOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content == null ? '' : String(content);
    return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

// ---- Anthropic → OpenAI ------------------------------------------------------------------------
function toOpenAITools(tools) {
    return (tools || []).map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } }
    }));
}

function toOpenAIMessages(system, messages) {
    const out = [];
    const sys = (Array.isArray(system) ? system : [system]).filter((s) => s && String(s).trim()).join('\n\n');
    if (sys) out.push({ role: 'system', content: sys });
    for (const m of messages || []) {
        if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
        const blocks = Array.isArray(m.content) ? m.content : [];
        if (m.role === 'assistant') {
            const text = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n').trim();
            const calls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({
                id: String(b.id),
                type: 'function',
                function: { name: String(b.name || ''), arguments: JSON.stringify(b.input && typeof b.input === 'object' ? b.input : {}) }
            }));
            if (!text && !calls.length) continue; // only thinking blocks: nothing to send
            const msg = { role: 'assistant', content: text || null };
            if (calls.length) msg.tool_calls = calls;
            out.push(msg);
            continue;
        }
        // user: tool results first (they answer the previous assistant turn), then any text
        for (const b of blocks) {
            if (b.type !== 'tool_result') continue;
            let content = textOf(b.content);
            if (b.is_error) content = 'Error: ' + (content || 'the tool failed');
            out.push({ role: 'tool', tool_call_id: String(b.tool_use_id), content: content || '(empty)' });
        }
        const text = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n').trim();
        if (text) out.push({ role: 'user', content: text });
    }
    return out;
}

// ---- OpenAI → Anthropic ------------------------------------------------------------------------
// Arguments arrive as a JSON string; models sometimes wrap it in a code fence, double-encode it or
// cut it short. Returns { input, ok }: a malformed one becomes {} so the browser's tool code
// rejects it as a normal tool error and the model can try again.
function parseArguments(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { input: raw, ok: true };
    let s = String(raw == null ? '' : raw).trim();
    if (!s) return { input: {}, ok: true };
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    for (let i = 0; i < 2; i++) {
        let v;
        try { v = JSON.parse(s); } catch (_) { break; }
        if (typeof v === 'string') { s = v; continue; }
        if (v && typeof v === 'object' && !Array.isArray(v)) return { input: v, ok: true };
        break;
    }
    return { input: {}, ok: false };
}

function stripReasoning(text) {
    // Some servers leave <think>…</think> in content instead of a separate reasoning field.
    return String(text || '').replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '').replace(/^\s*<think>[\s\S]*$/i, '');
}

function fromOpenAIResponse(body, opts) {
    const log = (opts && opts.warn) || (() => {});
    const choice = (body && Array.isArray(body.choices) && body.choices[0]) || {};
    const msg = choice.message || {};
    const content = [];
    const text = stripReasoning(typeof msg.content === 'string' ? msg.content : textOf(msg.content)).trim();
    if (text) content.push({ type: 'text', text });
    const seen = new Set();
    let malformed = 0;
    (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).forEach((c, i) => {
        if (!c || !c.function || !c.function.name) return;
        let id = String(c.id || '');
        if (!ID_OK.test(id) || seen.has(id)) id = 'toolu_' + Date.now().toString(36) + '_' + i + Math.random().toString(36).slice(2, 8);
        seen.add(id);
        const parsed = parseArguments(c.function.arguments);
        if (!parsed.ok) { malformed++; log(`malformed arguments for ${c.function.name}`); }
        content.push({ type: 'tool_use', id, name: String(c.function.name), input: parsed.input });
    });
    const hasTools = content.some((b) => b.type === 'tool_use');
    let stop = FINISH_TO_STOP[choice.finish_reason] || 'end_turn';
    if (hasTools && stop === 'end_turn') stop = 'tool_use'; // some servers say "stop" with tool calls
    if (!hasTools && stop === 'tool_use') stop = 'end_turn';
    // The browser stores this turn and sends it back; an empty assistant turn would be invalid.
    if (!content.length) {
        content.push({ type: 'text', text: stop === 'max_tokens' ? '(The answer was cut short.)' : 'I could not work that out. Try asking in a different way.' });
    }
    const u = (body && body.usage) || {};
    return {
        content,
        stop_reason: stop,
        malformed,
        usage: {
            input: u.prompt_tokens,
            output: u.completion_tokens,
            cache_read: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || undefined,
            reasoning: (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || undefined
        }
    };
}

// ---- HTTP ----------------------------------------------------------------------------------------
function retryAfterMs(h) {
    if (!h) return null;
    const n = Number(h);
    if (Number.isFinite(n)) return Math.max(0, n * 1000);
    const t = Date.parse(h);
    return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) return reject(new AssistantError('aborted', 'aborted'));
        const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', on); resolve(); }, ms);
        const on = () => { clearTimeout(t); reject(new AssistantError('aborted', 'aborted')); };
        if (signal) signal.addEventListener('abort', on, { once: true });
    });
}

function create(opts) {
    const apiKey = String(opts.apiKey || '');
    const model = opts.model || DEFAULT_MODEL;
    const baseUrl = String(opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const doFetch = opts.fetch || globalThis.fetch;
    const timeoutMs = opts.timeoutMs || 60 * 1000;
    const maxRetryWaitMs = opts.maxRetryWaitMs == null ? MAX_RETRY_WAIT_MS : opts.maxRetryWaitMs;
    const warn = opts.warn || ((m) => console.warn('[Assistant] ' + m));
    const addendum = opts.addendum == null ? ADDENDUM : opts.addendum;

    async function attempt(body, signal) {
        const ctrl = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
        const onAbort = () => ctrl.abort();
        if (signal) { if (signal.aborted) ctrl.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
        try {
            let res;
            try {
                res = await doFetch(baseUrl + '/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + apiKey },
                    body: JSON.stringify(body),
                    signal: ctrl.signal
                });
            } catch (e) {
                if (timedOut) throw new AssistantError('timeout', 'no answer within ' + Math.round(timeoutMs / 1000) + ' s');
                if (signal && signal.aborted) throw new AssistantError('aborted', 'aborted');
                throw new AssistantError('network', (e && e.message) || 'network error', { retryable: true });
            }
            let text = '';
            try { text = await res.text(); } catch (e) {
                if (timedOut) throw new AssistantError('timeout', 'no answer within ' + Math.round(timeoutMs / 1000) + ' s');
                throw new AssistantError('network', 'could not read the answer', { retryable: true });
            }
            const dataPolicy = (res.headers && res.headers.get && res.headers.get('x-data-policy')) || '';
            if (!res.ok) {
                let detail = '';
                try { const j = JSON.parse(text); detail = (j.error && (j.error.message || j.error.code || j.error)) || j.message || ''; } catch (_) { detail = text.slice(0, 200); }
                const s = res.status;
                const kind = s === 401 || s === 403 ? 'auth' : s === 402 ? 'credit' : s === 429 ? 'busy' : s === 400 || s === 404 || s === 413 || s === 422 ? 'bad_request' : 'upstream';
                throw new AssistantError(kind, `HTTP ${s}${detail ? ': ' + String(detail).slice(0, 200) : ''}`, {
                    status: s, retryable: s === 429 || s >= 500, retryAfterMs: retryAfterMs(res.headers && res.headers.get && res.headers.get('retry-after')), dataPolicy
                });
            }
            let json;
            try { json = JSON.parse(text); } catch (_) { throw new AssistantError('upstream', 'answer is not JSON', { status: res.status, retryable: true }); }
            if (json && json.error) throw new AssistantError('upstream', 'error in answer: ' + String(json.error.message || json.error).slice(0, 200), { status: res.status });
            return { json, dataPolicy };
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
        }
    }

    async function complete({ system, tools, messages, maxTokens, signal }) {
        const sys = (Array.isArray(system) ? system.slice() : [system]);
        if (addendum) sys.splice(1, 0, addendum); // after the shared prompt, before the per-user note
        const body = {
            model,
            messages: toOpenAIMessages(sys, messages),
            max_tokens: maxTokens || 8000,
            stream: false
        };
        if (tools && tools.length) { body.tools = toOpenAITools(tools); body.tool_choice = 'auto'; }
        let out, retries = 0;
        for (;;) {
            try { out = await attempt(body, signal); break; } catch (e) {
                if (!(e instanceof AssistantError) || !e.retryable || retries >= 1) { e.retries = retries; throw e; }
                const wait = e.retryAfterMs == null ? 1000 : e.retryAfterMs;
                if (wait > maxRetryWaitMs) { e.retries = retries; throw e; }
                retries++;
                warn(`retrying after ${e.message} (wait ${wait} ms)`);
                await sleep(wait, signal);
            }
        }
        const r = fromOpenAIResponse(out.json, { warn });
        return {
            content: r.content,
            stop_reason: r.stop_reason,
            usage: r.usage,
            provider: opts.name || 'openai_compat',
            model: (out.json && out.json.model) || model,
            dataPolicy: out.dataPolicy,
            retries,
            malformed: r.malformed
        };
    }

    return { name: opts.name || 'openai_compat', model, baseUrl, complete };
}

module.exports = { create, toOpenAITools, toOpenAIMessages, fromOpenAIResponse, parseArguments, retryAfterMs, DEFAULT_BASE_URL, DEFAULT_MODEL, ADDENDUM };
