'use strict';
/* lib/report_modules.js: the report keys a user's `modules` list can name, read from the NAV registry in
 * app.html (the sidebar's single source of truth), so a new report needs no second list here.
 *
 *   load(appRoot)  -> { list: [{ key, name, url, group }], byKey: Map, keysForPath(path) -> [keys] }
 *
 * The Administration group is left out: admins open everything and nobody else can.
 * Server-only (in server.js's PRIVATE_PATH list).
 */
const fs = require('fs');
const path = require('path');

function parseNav(html) {
    const start = html.indexOf('var NAV = [');
    const end = start === -1 ? -1 : html.indexOf('var HOME =', start);
    if (start === -1 || end === -1) return [];
    const block = html.slice(start, end);
    const list = [];
    // Each group: { id: '…', label: '…', …, admin: true?, items: [ ['key', 'Name', 'url', …], … ] }
    const groupRe = /\{\s*id:\s*'([^']+)',\s*label:\s*'([^']+)'([^\[]*?)items:\s*\[([\s\S]*?)\]\s*\}/g;
    let g;
    while ((g = groupRe.exec(block))) {
        if (/admin:\s*true/.test(g[3])) continue;
        const itemRe = /\[\s*'([a-z0-9_]+)'\s*,\s*'((?:[^'\\]|\\.)*)'\s*,\s*'([^']+)'/g;
        let it;
        while ((it = itemRe.exec(g[4]))) list.push({ key: it[1], name: it[2].replace(/\\'/g, "'"), url: it[3], group: g[2] });
    }
    return list;
}

/** Old key -> current key, for menu entries that were merged away (the second Performance index entry, 3.55). */
const LEGACY_KEYS = { perf_index_imp: 'performance_index' };

function normPath(p) {
    return String(p || '').replace(/[?#].*$/, '').replace(/^\/+/, '').toLowerCase();
}

function load(appRoot) {
    let html = '';
    try { html = fs.readFileSync(path.join(appRoot, 'app.html'), 'utf8'); } catch (_) { /* empty catalogue */ }
    const list = parseNav(html);
    const byKey = new Map(list.map((m) => [m.key, m]));
    const byPath = new Map();
    for (const m of list) {
        const p = normPath(m.url);
        if (!byPath.has(p)) byPath.set(p, []);
        byPath.get(p).push(m.key);
    }
    // Retired menu keys still found in saved `modules` lists keep opening their page (not listed as reports).
    for (const [legacy, current] of Object.entries(LEGACY_KEYS)) {
        const m = byKey.get(current);
        if (!m) continue;
        const keys = byPath.get(normPath(m.url));
        if (keys && !keys.includes(legacy)) keys.push(legacy);
    }
    return {
        list,
        byKey,
        /** Report keys whose page is this path ('' or unknown path: none, i.e. not a gated report). */
        keysForPath: (p) => byPath.get(normPath(p)) || []
    };
}

module.exports = { load, parseNav };
