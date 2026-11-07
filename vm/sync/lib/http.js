'use strict';
// The fetch handed to source adapters: GET/HEAD only (the mirror never writes to a source),
// a timeout that also covers reading the body, the per-source abort signal, and retries on
// network errors, 429 and 5xx before any of the body is consumed.

const { sleep } = require('./util');

function makeSourceFetch({ timeoutMs = 300000, retries = 3, signal } = {}) {
    return async function sourceFetch(url, opts = {}) {
        const method = String(opts.method || 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
            throw new Error(`Sources are read-only: refusing ${method} ${String(url).split('?')[0]}`);
        }
        const tries = opts.retries !== undefined ? opts.retries : retries;
        for (let attempt = 0; ; attempt++) {
            if (signal && signal.aborted) throw signal.reason || new Error('Aborted');
            const signals = [AbortSignal.timeout(opts.timeoutMs || timeoutMs)];
            if (signal) signals.push(signal);
            if (opts.signal) signals.push(opts.signal);
            const init = Object.assign({}, opts, { method, redirect: 'follow', signal: AbortSignal.any(signals) });
            delete init.retries;
            delete init.timeoutMs;
            try {
                const res = await fetch(url, init);
                if ((res.status === 429 || res.status >= 500) && attempt < tries) {
                    try { await res.body?.cancel(); } catch (_) { /* ignore */ }
                    await sleep(2000 * Math.pow(3, attempt));
                    continue;
                }
                return res;
            } catch (err) {
                if (signal && signal.aborted) throw signal.reason || err;
                if (attempt < tries) {
                    await sleep(2000 * Math.pow(3, attempt));
                    continue;
                }
                throw err;
            }
        }
    };
}

module.exports = { makeSourceFetch };
