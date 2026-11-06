'use strict';
// The app's own mzo_ui.js (UI.date, UI.fmtDate, …) in a Node context, so views compute dates with the
// exact functions the pages use. Loaded once per process; DOM calls hit inert stubs.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let cached = null;

/** → { UI, context } with mzo_ui.js (and the given extra scripts) loaded into one vm context. */
function load(app, extra) {
    const key = [app].concat(extra || []).join('|');
    if (cached && cached.key === key) return cached.value;
    const el = () => ({ textContent: '', innerHTML: '', style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, appendChild() {}, insertAdjacentHTML() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] });
    // querySelector('script[src*="auth.js"]') answers an element, so the login gate adds no script.
    const document = { readyState: 'complete', body: el(), head: el(), documentElement: el(), addEventListener() {}, querySelector: () => el(), querySelectorAll: () => [], getElementById: () => null, createElement: el };
    const store = {};
    const ctx = { console, document, localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } }, setTimeout, clearTimeout };
    ctx.window = ctx; ctx.self = ctx; ctx.top = ctx;
    vm.createContext(ctx);
    for (const f of ['mzo_ui.js'].concat(extra || [])) vm.runInContext(fs.readFileSync(path.join(app, f), 'utf8'), ctx, { filename: f });
    if (!ctx.UI || typeof ctx.UI.date !== 'function') throw new Error('mzo_ui.js did not define UI.date');
    cached = { key, value: { UI: ctx.UI, context: ctx } };
    return cached.value;
}

module.exports = { load };
