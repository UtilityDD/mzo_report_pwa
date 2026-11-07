'use strict';
// Ask: the provider's usage limits and paid prices, for Admin -> Ask usage (lib/assistant/usage.js).
// One profile per provider and key tier; any value can be replaced by an env setting, so moving to a
// paid key or to Claude needs no code change. null = no cap (or no price known).
//
//   ASSISTANT_TIER               free | paid. Unset: from the Gödel key prefix (sk-gm-paid-… = paid,
//                                anything else = free). Claude is always "paid".
//   ASSISTANT_LIMIT_RPM          requests per minute
//   ASSISTANT_LIMIT_INPUT_MINUTE new (uncached) input tokens per minute
//   ASSISTANT_LIMIT_INPUT_DAY    new (uncached) input tokens per UTC day
//   ASSISTANT_LIMIT_OUTPUT_DAY   output tokens per UTC day (reasoning counts as output)
//   ASSISTANT_PRICE_INPUT        ₹ per million new input tokens
//   ASSISTANT_PRICE_CACHED       ₹ per million cached input tokens
//   ASSISTANT_PRICE_OUTPUT       ₹ per million output tokens
//   ASSISTANT_PRICE_GST          tax added to the prices, as a fraction (0.18)
// A limit set to 0 or "none" means no cap.

const GOEDEL_PRICES = { currency: 'INR', input: 12, cached: 0.25, output: 50, gst: 0.18 };

const PROFILES = {
    // Gödel Machines free key (sk-gm-free-…): 2 in flight, 60 RPM, 100K new input tokens a minute,
    // 10M new input and 1M output tokens a UTC day. Cached input does not count. It stores requests.
    goedel_free: {
        label: 'Gödel free key', tier: 'free', dailyLabel: 'free-tier daily limit',
        rpm: 60, inputPerMinute: 100000, inputPerDay: 10000000, outputPerDay: 1000000,
        prices: GOEDEL_PRICES, dataPolicyNote: 'Free key: Gödel stores requests and may train on them.'
    },
    // Gödel paid key (sk-gm-paid-…): 8 in flight, billed per token (the prices above), keeps nothing.
    goedel_paid: {
        label: 'Gödel paid key', tier: 'paid', dailyLabel: 'daily limit',
        rpm: null, inputPerMinute: null, inputPerDay: null, outputPerDay: null,
        prices: GOEDEL_PRICES, dataPolicyNote: 'Paid key: Gödel keeps nothing.'
    },
    // Anthropic: no daily cap; prices only when set by env.
    anthropic: {
        label: 'Anthropic API', tier: 'paid', dailyLabel: 'daily limit',
        rpm: null, inputPerMinute: null, inputPerDay: null, outputPerDay: null,
        prices: null, dataPolicyNote: ''
    }
};

const LIMIT_ENV = { rpm: 'ASSISTANT_LIMIT_RPM', inputPerMinute: 'ASSISTANT_LIMIT_INPUT_MINUTE', inputPerDay: 'ASSISTANT_LIMIT_INPUT_DAY', outputPerDay: 'ASSISTANT_LIMIT_OUTPUT_DAY' };
const PRICE_ENV = { input: 'ASSISTANT_PRICE_INPUT', cached: 'ASSISTANT_PRICE_CACHED', output: 'ASSISTANT_PRICE_OUTPUT', gst: 'ASSISTANT_PRICE_GST' };

function envValue(env, name) {
    const v = String(env[name] == null ? '' : env[name]).trim();
    return v === '' ? undefined : v;
}

function tierOf(provider, apiKey, env) {
    const asked = String(envValue(env, 'ASSISTANT_TIER') || '').toLowerCase();
    if (provider === 'anthropic') return 'paid';
    if (asked === 'free' || asked === 'paid') return asked;
    return /^sk-gm-paid-/i.test(String(apiKey || '')) ? 'paid' : 'free';
}

// → { profile, label, tier, dailyLabel, rpm, inputPerMinute, inputPerDay, outputPerDay, prices, dataPolicyNote }
// provider: 'goedel' | 'anthropic' | null (Ask off: the Gödel free profile, so the panel still reads).
function limitsFor(provider, apiKey, envIn) {
    const env = envIn || {};
    const tier = tierOf(provider, apiKey, env);
    const key = provider === 'anthropic' ? 'anthropic' : tier === 'paid' ? 'goedel_paid' : 'goedel_free';
    const p = PROFILES[key];
    const out = Object.assign({ profile: key }, p, { prices: p.prices ? Object.assign({}, p.prices) : null });
    for (const [k, name] of Object.entries(LIMIT_ENV)) {
        const v = envValue(env, name);
        if (v === undefined) continue;
        const n = Number(v);
        out[k] = /^none$/i.test(v) || !(n > 0) ? null : Math.floor(n);
    }
    for (const [k, name] of Object.entries(PRICE_ENV)) {
        const v = envValue(env, name);
        if (v === undefined || !Number.isFinite(Number(v)) || Number(v) < 0) continue;
        if (!out.prices) out.prices = { currency: 'INR', input: null, cached: null, output: null, gst: 0 };
        out.prices[k] = Number(v);
    }
    return out;
}

module.exports = { limitsFor, PROFILES };
