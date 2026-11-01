// Preload for local QA runs: the app server may read upstream (Google, Supabase) but never write.
//   NODE_OPTIONS="--require ./scripts/qa/guard-writes.js" PORT=3600 node server.js
// Page visits by a signed-in user normally log to Supabase; with this guard they are dropped.
'use strict';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const isLocal = (u) => /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(String(u || ''));

const realFetch = globalThis.fetch;
if (realFetch) {
  globalThis.fetch = function (input, init) {
    const m = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    const u = typeof input === 'string' ? input : (input && input.url) || String(input || '');
    if (!SAFE.has(m) && !isLocal(u)) {
      console.log('[qa-guard] blocked outbound ' + m + ' ' + String(u).replace(/\?.*$/, ''));
      return Promise.reject(new Error('blocked by QA write guard'));
    }
    return realFetch.apply(this, arguments);
  };
}

for (const mod of ['https', 'http']) {
  const lib = require(mod);
  for (const fn of ['request']) {
    const orig = lib[fn];
    lib[fn] = function (...args) {
      const o = args.find((a) => a && typeof a === 'object' && !(a instanceof URL)) || {};
      const m = String(o.method || 'GET').toUpperCase();
      let host = String(o.hostname || o.host || '');
      if (!host && args[0] instanceof URL) host = args[0].hostname;
      if (!host && typeof args[0] === 'string') { try { host = new URL(args[0]).hostname; } catch (_) {} }
      host = host.replace(/:\d+$/, '');
      if (!SAFE.has(m) && !/^(127\.0\.0\.1|localhost)$/i.test(host)) {
        console.log('[qa-guard] blocked outbound ' + mod + ' ' + m + ' ' + host);
        throw new Error('blocked by QA write guard');
      }
      return orig.apply(this, args);
    };
  }
}
