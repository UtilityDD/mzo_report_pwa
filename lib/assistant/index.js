'use strict';
// Ask: picks the model provider from env settings and gives server.js one interface:
//   assistant.complete({ system: [sharedPrompt, userNote], tools, messages, signal })
//     → { content (Anthropic blocks), stop_reason, usage, provider, model }
// The browser keeps the conversation in Anthropic Messages format whatever the provider.
//
// Settings (env only; switching needs no code change):
//   ASSISTANT_PROVIDER         goedel | anthropic. Unset: goedel when a Gödel key is set, else
//                              anthropic when ANTHROPIC_API_KEY is set, else Ask is off.
//   GOEDEL_API_KEY             Gödel Machines key (GODEL_API_KEY is accepted too; GOEDEL wins)
//   ANTHROPIC_API_KEY          Anthropic key (or anthropicApiKey in data/supabase_config.json)
//   ASSISTANT_MODEL            model override (default deepseek/deepseek-v4.1-flash / claude-haiku-5-5)
//   ASSISTANT_BASE_URL         OpenAI-compatible base URL (default https://api.goedelmachines.com/v1)
//   ASSISTANT_MAX_CONCURRENCY  requests in flight to the provider from this process; more wait in a
//                              queue (default 2 for goedel, the free tier's limit; unlimited for anthropic)

const openaiCompat = require('./openai_compat.js');
const anthropic = require('./anthropic.js');
const { AssistantError, replyFor } = require('./errors.js');
const { assistantSystemPrompt, assistantTools } = require('./prompt.js');

const PROVIDERS = {
    goedel: { defaultModel: openaiCompat.DEFAULT_MODEL, maxTokens: 8000, concurrency: 2 },
    anthropic: { defaultModel: anthropic.DEFAULT_MODEL, maxTokens: 16000, concurrency: 0 }
};
const ALIASES = { goedel: 'goedel', godel: 'goedel', 'gödel': 'goedel', anthropic: 'anthropic', claude: 'anthropic' };
const MODEL_NAMES = { 'deepseek/deepseek-v4.1-flash': 'DeepSeek V4.1 Flash', 'deepseek-v4.1-flash': 'DeepSeek V4.1 Flash', 'claude-haiku-5-5': 'Claude Haiku' };
const QUEUE_MAX = 30; // waiting requests beyond the in-flight limit; more are told "busy"
const QUEUE_WAIT_MS = 45 * 1000;

function clean(v) { return String(v == null ? '' : v).trim(); }

// → { provider, apiKey, model, baseUrl, maxConcurrency, maxTokens } or { provider: null, reason }
function resolveConfig(env, fileConfig) {
    env = env || {};
    fileConfig = fileConfig || {};
    const keys = {
        goedel: clean(env.GOEDEL_API_KEY) || clean(env.GODEL_API_KEY),
        anthropic: clean(env.ANTHROPIC_API_KEY) || clean(fileConfig.anthropicApiKey)
    };
    const asked = clean(env.ASSISTANT_PROVIDER).toLowerCase();
    let provider = ALIASES[asked] || '';
    let warning = '';
    if (asked && !provider) warning = `ASSISTANT_PROVIDER "${asked}" is not known (goedel | anthropic); choosing by key`;
    if (!provider) provider = keys.goedel ? 'goedel' : keys.anthropic ? 'anthropic' : '';
    if (!provider) return { provider: null, reason: 'no key', warning };
    if (!keys[provider]) return { provider: null, reason: `ASSISTANT_PROVIDER=${provider} but its key is not set`, warning };
    const p = PROVIDERS[provider];
    const conc = clean(env.ASSISTANT_MAX_CONCURRENCY);
    const n = conc === '' ? p.concurrency : Math.max(0, Math.floor(Number(conc)) || 0);
    return {
        provider,
        apiKey: keys[provider],
        model: clean(env.ASSISTANT_MODEL) || p.defaultModel,
        baseUrl: provider === 'goedel' ? (clean(env.ASSISTANT_BASE_URL) || openaiCompat.DEFAULT_BASE_URL) : '',
        maxConcurrency: n,
        maxTokens: p.maxTokens,
        warning
    };
}

function modelName(model) { return MODEL_NAMES[model] || model; }

// Small FIFO gate: at most `limit` calls run at once (0 = no limit).
function createGate(limit) {
    let active = 0;
    const queue = [];
    function next() {
        while (active < limit && queue.length) {
            const w = queue.shift();
            active++;
            w.start();
        }
    }
    return {
        get active() { return active; },
        get waiting() { return queue.length; },
        async run(fn, signal) {
            if (!limit) return fn();
            if (active >= limit) {
                if (queue.length >= QUEUE_MAX) throw new AssistantError('busy', 'queue full');
                await new Promise((resolve, reject) => {
                    const w = {};
                    const stop = (err) => { const i = queue.indexOf(w); if (i >= 0) queue.splice(i, 1); clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); reject(err); };
                    const onAbort = () => stop(new AssistantError('aborted', 'aborted while queued'));
                    const timer = setTimeout(() => stop(new AssistantError('busy', 'waited too long in the queue')), QUEUE_WAIT_MS);
                    w.start = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); resolve(); };
                    if (signal) signal.addEventListener('abort', onAbort, { once: true });
                    queue.push(w);
                });
            } else {
                active++;
            }
            try { return await fn(); } finally { active--; next(); }
        }
    };
}

const BLOCK_TYPES = new Set(['text', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking']);
function messagesValid(messages) {
    if (!Array.isArray(messages) || !messages.length || messages.length > 60) return false;
    if (JSON.stringify(messages).length > 200000) return false;
    if (messages[0].role !== 'user' || messages[messages.length - 1].role !== 'user') return false;
    return messages.every((m) => {
        if (!m || (m.role !== 'user' && m.role !== 'assistant')) return false;
        if (typeof m.content === 'string') return m.content.length > 0 && m.content.length <= 4000;
        return Array.isArray(m.content) && m.content.length > 0 && m.content.every((b) => b && BLOCK_TYPES.has(b.type));
    });
}

// opts: { env, fileConfig, catalog, fetch, log, anthropicSdk, anthropicClient }
function createAssistant(opts) {
    const log = opts.log || ((m) => console.log('[Assistant] ' + m));
    const cfg = resolveConfig(opts.env || process.env, opts.fileConfig);
    if (cfg.warning) log(cfg.warning);
    const system = assistantSystemPrompt(opts.catalog);
    const tools = assistantTools(opts.catalog);
    if (!cfg.provider) {
        if (cfg.reason !== 'no key') log('off: ' + cfg.reason);
        return { configured: false, provider: null, model: null, modelName: null, system, tools };
    }
    let impl = null; // created on first use
    const make = () => impl || (impl = cfg.provider === 'anthropic'
        ? anthropic.create({ apiKey: cfg.apiKey, model: cfg.model, sdk: opts.anthropicSdk, client: opts.anthropicClient })
        : openaiCompat.create({ name: 'goedel', apiKey: cfg.apiKey, model: cfg.model, baseUrl: cfg.baseUrl, fetch: opts.fetch, timeoutMs: opts.timeoutMs, maxRetryWaitMs: opts.maxRetryWaitMs, warn: log }));
    const gate = createGate(cfg.maxConcurrency);
    log(`provider ${cfg.provider}, model ${cfg.model}${cfg.baseUrl ? ', ' + cfg.baseUrl : ''}, max ${cfg.maxConcurrency || 'unlimited'} in flight`);

    async function complete({ userNote, messages, signal }) {
        const queuedAt = Date.now();
        let startedAt = queuedAt;
        try {
            const r = await gate.run(() => {
                startedAt = Date.now();
                return make().complete({ system: [system, userNote], tools, messages, maxTokens: cfg.maxTokens, signal });
            }, signal);
            const u = r.usage || {};
            // Metadata only: never the conversation, never the key.
            log(`${r.provider} ${r.model} ok ${Date.now() - startedAt} ms` + (startedAt - queuedAt > 50 ? ` (queued ${startedAt - queuedAt} ms)` : '') +
                ` stop=${r.stop_reason} in=${u.input ?? '-'} out=${u.output ?? '-'}` + (u.cache_read ? ` cached=${u.cache_read}` : '') + (u.reasoning ? ` reasoning=${u.reasoning}` : '') +
                (r.dataPolicy ? ` data-policy=${r.dataPolicy}` : '') + (r.retries ? ` retries=${r.retries}` : '') + (r.malformed ? ` malformed-args=${r.malformed}` : ''));
            return r;
        } catch (err) {
            const e = err instanceof AssistantError ? err : new AssistantError('error', (err && err.message) || 'error');
            if (e.kind !== 'aborted') {
                log(`${cfg.provider} ${cfg.model} failed ${Date.now() - startedAt} ms kind=${e.kind}${e.status ? ' status=' + e.status : ''}${e.retries ? ' retries=' + e.retries : ''}${e.dataPolicy ? ' data-policy=' + e.dataPolicy : ''}: ${String(e.message).slice(0, 200)}`);
            }
            throw e;
        }
    }

    return { configured: true, provider: cfg.provider, model: cfg.model, modelName: modelName(cfg.model), system, tools, complete, gate };
}

module.exports = { createAssistant, resolveConfig, messagesValid, createGate, modelName, replyFor, AssistantError };
