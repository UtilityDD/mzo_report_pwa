'use strict';
// WBSEDCL office hierarchy for Admin → Organisation: GET /api/admin/org (admin only).
//
// The data is data/org/wbsedcl_hierarchy.json (office names, codes and post titles from public WBSEDCL
// sources, no personal data): {asOf, sources[], root:{level, name, children:[chief_engineer → zone → region
// → division → ccc]}} (the chief engineer level is optional), each node with a confidence of confirmed /
// partial / inferred and source (indexes into sources[]); a region may list unplacedCccs[] (CCCs whose
// current division is not public). server.js passes the file's path.
//
// The answer marks the zone this app covers (the zone of lib/offices.js) as live, and each office
// in it that the app's own office master also has (by code, else by name or alias) as inApp, so the
// chart can highlight them. Offices the app has but the dataset lacks are listed under live.missing.
// See docs/org-hierarchy.md.

const fs = require('fs');
const path = require('path');

// Levels below the root, top down. chief_engineer may be skipped (root → zone).
const LEVELS = ['chief_engineer', 'zone', 'region', 'division', 'ccc'];
const CONFIDENCE = new Set(['confirmed', 'partial', 'inferred']);

function isAdmin(user) {
    if (!user) return false;
    if (user.isAdmin === true) return true;
    return String(user.role || user.Role || '').trim().toLowerCase() === 'admin';
}

/** The app's office master as code and name-key lookups per level. */
function appMaster(offices) {
    const k = offices.key;
    const levels = { zone: [], region: [], division: [], ccc: [] };
    levels.zone.push({ name: offices.ZONE.name, code: offices.ZONE.code, keys: [offices.ZONE.name].concat(offices.ZONE.aliases || []).map(k) });
    offices.REGIONS.forEach((r) => levels.region.push({ name: r.name, code: r.code, keys: [r.name, r.district].concat(r.aliases || []).map(k) }));
    offices.DIVISIONS.forEach((d) => levels.division.push({ name: d.name, code: d.code, region: d.region, keys: [d.name].concat(d.aliases || []).map(k) }));
    offices.CCCS.forEach((c) => levels.ccc.push({ name: c.name, code: c.code, division: c.division, keys: [c.name].concat(c.aliases || []).map(k) }));
    return levels;
}

function nodeKeys(node, key) {
    return [node.name].concat(Array.isArray(node.aliases) ? node.aliases : []).map(key).filter(Boolean);
}

/** The app office this dataset node is, from candidates of its level: same code first, then a shared name key. */
function matchOffice(node, candidates, key) {
    const code = String(node.code || '').trim();
    if (code) {
        const byCode = candidates.find((c) => c.code === code);
        if (byCode) return byCode;
    }
    const keys = nodeKeys(node, key);
    return candidates.find((c) => c.keys.some((x) => keys.indexOf(x) >= 0)) || null;
}

/** The zone nodes of a tree, wherever they sit (under the root or under a chief engineer). */
function zonesOf(root) {
    const out = [];
    (function walk(n) {
        if (String(n.level || '').toLowerCase() === 'zone') { out.push(n); return; }
        (n.children || []).forEach(walk);
    })(root);
    return out;
}

/** Copy of the dataset with live / inApp marks, and the live zone's summary. */
function annotate(data, offices) {
    const key = offices.key;
    const master = appMaster(offices);
    const root = JSON.parse(JSON.stringify(data.root || {}));
    const matched = { region: new Set(), division: new Set(), ccc: new Set() };
    let liveZone = null;

    function walk(node, scope) {
        // scope: the app office matched at the parent level (limits name matching to its children)
        const level = String(node.level || '').toLowerCase();
        let mine = null;
        if (level === 'region') mine = matchOffice(node, master.region, key);
        else if (level === 'division') mine = matchOffice(node, master.division.filter((d) => !scope || d.region === scope.name), key);
        else if (level === 'ccc') mine = matchOffice(node, master.ccc.filter((c) => !scope || c.division === scope.name), key);
        if (mine) {
            node.inApp = { name: mine.name, code: mine.code };
            matched[level].add(mine.code);
        }
        (node.children || []).forEach((ch) => { if (mine) walk(ch, mine); });
    }

    zonesOf(root).forEach((zone) => {
        if (liveZone || !matchOffice(zone, master.zone, key)) return;
        zone.live = true;
        zone.inApp = { name: master.zone[0].name, code: master.zone[0].code };
        liveZone = zone;
        (zone.children || []).forEach((ch) => walk(ch, null));
    });

    const missing = [];
    ['region', 'division', 'ccc'].forEach((lv) => master[lv].forEach((o) => { if (!matched[lv].has(o.code)) missing.push({ level: lv, name: o.name, code: o.code }); }));
    return {
        root,
        live: {
            zone: liveZone ? liveZone.name : null,
            code: offices.ZONE.code,
            appName: offices.ZONE.name,
            app: { regions: master.region.length, divisions: master.division.length, cccs: master.ccc.length },
            matched: { regions: matched.region.size, divisions: matched.division.size, cccs: matched.ccc.size },
            missing
        }
    };
}

/** The level a child of this level must have (the root's children may be chief engineers or zones). */
function childLevels(level, isRoot) {
    if (isRoot) return ['chief_engineer', 'zone'];
    const i = LEVELS.indexOf(level);
    return i >= 0 && i < LEVELS.length - 1 ? [LEVELS[i + 1]] : [];
}

/** Shape problems in the dataset (unknown level, bad confidence, a child out of order), for the answer's warnings. */
function check(root) {
    const problems = [];
    function walk(node, isRoot, where) {
        const level = String(node.level || '').toLowerCase();
        if (node.confidence && !CONFIDENCE.has(node.confidence)) problems.push(`${where}: confidence "${node.confidence}"`);
        if (!node.name) problems.push(`${where}: no name`);
        const allowed = childLevels(level, isRoot);
        (node.children || []).forEach((ch, i) => {
            const at = `${where} > ${ch.name || '#' + i}`;
            if (allowed.indexOf(String(ch.level || '').toLowerCase()) < 0) problems.push(`${at}: level "${ch.level}" where "${allowed.join('" or "') || 'none'}" was expected`);
            walk(ch, false, at);
        });
        (Array.isArray(node.unplacedCccs) ? node.unplacedCccs : []).forEach((c, i) => {
            if (level !== 'region') problems.push(`${where}: unplacedCccs outside a region`);
            if (!c || !c.name) problems.push(`${where}: unplaced CCC #${i} has no name`);
        });
    }
    walk(root, true, root.name || 'root');
    return problems.slice(0, 50);
}

function create(opts) {
    const file = opts.file;
    const offices = opts.offices || require('./offices');
    const log = opts.log || console;
    let cache = { mtime: 0, body: null };

    function load() {
        const st = fs.statSync(file);
        if (cache.body && cache.mtime === st.mtimeMs) return cache.body;
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const { root, live } = annotate(data, offices);
        const body = {
            status: 'success',
            asOf: data.asOf || null,
            seed: !!data.seed,
            note: data.note || '',
            sources: Array.isArray(data.sources) ? data.sources : [],
            officialCounts: data.officialCounts && typeof data.officialCounts === 'object' ? data.officialCounts : null,
            confidenceKey: data.confidenceKey && typeof data.confidenceKey === 'object' ? data.confidenceKey : null,
            root,
            live,
            warnings: check(root),
            file: path.basename(file),
            updatedAt: new Date(st.mtimeMs).toISOString()
        };
        cache = { mtime: st.mtimeMs, body };
        return body;
    }

    function handler(req, res) {
        if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
        if (!isAdmin(req.user)) return res.status(403).json({ status: 'error', message: 'Forbidden: Admin access required.' });
        try {
            const body = load();
            res.setHeader('Cache-Control', 'private, no-store');
            return res.json(body);
        } catch (err) {
            log.error('[Org] hierarchy unavailable:', err.message);
            return res.status(500).json({ status: 'error', message: 'Office hierarchy unavailable.' });
        }
    }

    return { handler, load };
}

module.exports = { create, annotate, check, isAdmin, appMaster, matchOffice, zonesOf, LEVELS };
