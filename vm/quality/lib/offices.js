'use strict';
// Office resolution for the quality checks. The app's own matcher (mzo_scope.js, the browser's
// window.MzoScope) is loaded in a sandbox so a value counts as "known" exactly when the app can
// place it. On top of that this module answers what the app does not: is a name ambiguous, is
// a code outside the table, do a code and a name in the same row disagree.
//
// When dq-offices' canonical office list (dim_offices) is available, its aliases are added:
// pass `extraAliases` ({ region|division|ccc: { alias: canonical } }) to createResolver().

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..', '..', '..');

let scopeCache = null;

/** Stock plant code → division label, from stock/script.js PLANT_MAP (the stock page's own table). */
function loadPlantMap(file) {
    try {
        const src = fs.readFileSync(file || path.join(REPO, 'stock', 'script.js'), 'utf8');
        const m = /const PLANT_MAP = \{([\s\S]*?)\};/.exec(src);
        const out = {};
        if (m) {
            const re = /'(\d{4})'\s*:\s*'([^']+)'/g;
            let x;
            while ((x = re.exec(m[1])) !== null) out[x[1]] = x[2];
        }
        return out;
    } catch (_) {
        return {};
    }
}

/** window.MzoScope from mzo_scope.js, evaluated with a do-nothing window and document. */
function loadScope(file) {
    const src = fs.readFileSync(file || path.join(REPO, 'mzo_scope.js'), 'utf8');
    const doc = {
        readyState: 'complete',
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {},
        createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }),
        createTextNode: () => ({}),
        body: null
    };
    const win = { localStorage: { getItem: () => null } };
    const sandbox = { window: win, document: doc, console: { log() {}, warn() {} } };
    sandbox.window.document = doc;
    vm.createContext(sandbox);
    vm.runInContext(src.replace(/typeof window !== 'undefined' \? window : this/, 'window'), sandbox, { filename: 'mzo_scope.js', timeout: 2000 });
    if (!win.MzoScope) throw new Error('mzo_scope.js did not define window.MzoScope');
    return win.MzoScope;
}

// Division names from before the 2020s re-organisation (North / South Malda); they do not map
// one-to-one onto today's divisions.
const LEGACY_DIVISION_RE = /\b(north|south|east|west)\s*malda\b/i;

/**
 * A 7-digit office code that is not a CCC: 66RD000 (division office), 66R0000 (region office),
 * 6600000 (zone office) or 66RD[2-9]xx (substation, store or other unit of division D).
 */
function nonCccUnit(code) {
    if (code === '6600000') return { level: 'zone' };
    if (/^66[123]0000$/.test(code)) return { level: 'region' };
    if (/^66[123]\d000$/.test(code)) return { level: 'division' };
    if (/^66[123]\d[02-9]\d\d$/.test(code)) return { level: 'unit' };
    return null;
}

function norm(v) {
    return String(v == null ? '' : v)
        .toLowerCase()
        .replace(/region|division|divn|\bdiv\b|ccc/g, ' ')
        .replace(/[^a-z0-9/]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Looser key for spotting spelling variants: also drops "(d)", "zone", "circle", "office", "s/d". */
function looseKey(v) {
    return norm(String(v || '').replace(/\(d\)|\bzone\b|\bcircle\b|\boffice\b|\bs\/d\b|\bsub[- ]?division\b|\bdistrict\b/gi, ' '));
}

function createResolver(opts = {}) {
    const S = opts.scope || scopeCache || (scopeCache = loadScope(opts.scopeFile));
    const H = S.HIERARCHY;
    const regions = Object.keys(H);
    const divisions = [];
    const cccs = [];
    const divOf = {};
    const regionOfDiv = {};
    const regionOfCcc = {};
    for (const r of regions) {
        for (const d of Object.keys(H[r].divisions)) {
            divisions.push(d);
            regionOfDiv[d] = r;
            for (const c of H[r].divisions[d].cccs) {
                cccs.push(c);
                divOf[c] = d;
                regionOfCcc[c] = r;
            }
        }
    }
    // Code table: CODE_TO_CCC is private in mzo_scope.js; listAllUnits() exposes one code per
    // CCC, and cccNameOf() resolves every code in the table (including the 8-digit extras).
    const codeToCcc = {};
    for (const u of S.listAllUnits()) if (u.code) codeToCcc[u.code] = u.name;
    const extra = opts.extraAliases || {};

    const cache = new Map();
    function memo(kind, raw, fn) {
        const k = kind + '\u0000' + raw;
        let v = cache.get(k);
        if (v === undefined) {
            v = fn();
            if (cache.size < 20000) cache.set(k, v);
        }
        return v;
    }

    /** All office codes in a value (same rule as MzoScope's extractOfficeCodes). */
    function codesIn(raw) {
        const s = String(raw == null ? '' : raw);
        const out = [];
        const re = /66[123]\d{4}/g;
        let m;
        while ((m = re.exec(s)) !== null) if (!out.includes(m[0])) out.push(m[0]);
        const digits = s.replace(/\D/g, '');
        if (digits.length >= 7) {
            const last7 = digits.slice(-7);
            if (/^66[123]\d{4}$/.test(last7) && !out.includes(last7)) out.push(last7);
        }
        return out;
    }

    /**
     * Region value → { status: 'ok'|'variant'|'unknown'|'ambiguous', canonical, candidates }.
     * 'variant' = the app places it, but it is not spelled like the canonical name or an alias.
     */
    function region(raw) {
        return memo('r', raw, () => {
            const s = String(raw).trim();
            const n = norm(s);
            if (!n) return { status: 'blank', canonical: '' };
            if (extra.region && extra.region[n]) return { status: 'ok', canonical: extra.region[n] };
            const exact = regions.find((r) => norm(r) === n || H[r].aliases.includes(n));
            if (exact) return { status: 'ok', canonical: exact };
            const app = S.regionNameOf(s);
            const cands = regions.filter((r) => H[r].aliases.some((a) => n.includes(a) || a.includes(n)) || n.includes(norm(r)));
            if (cands.length > 1) return { status: 'ambiguous', canonical: app, candidates: cands };
            if (app) return { status: 'variant', canonical: app };
            return { status: 'unknown', canonical: '' };
        });
    }

    function division(raw) {
        return memo('d', raw, () => {
            const s = String(raw).trim();
            if (!s) return { status: 'blank', canonical: '' };
            if (/\bzone\b/i.test(s) && /malda/i.test(s)) return { status: 'ok', canonical: '', level: 'zone' };
            if (LEGACY_DIVISION_RE.test(s)) return { status: 'legacy', canonical: '' };
            const n = norm(s);
            if (extra.division && extra.division[n]) return { status: 'ok', canonical: extra.division[n] };
            if (/^66[123]\d$/.test(s)) {
                const app = S.divisionNameOf(s);
                return app ? { status: 'ok', canonical: app, byCode: true } : { status: 'unknown_code', canonical: '' };
            }
            const codes = codesIn(s);
            if (codes.length && n.replace(/\d+/g, '').trim() === '') {
                const c = codeToCccFull(codes[0]);
                return c ? { status: 'ok', canonical: divOf[c], byCode: true } : { status: 'unknown_code', canonical: '' };
            }
            if (!n) return { status: 'unknown', canonical: '' };
            const exact = divisions.find((d) => norm(d) === n);
            if (exact) return { status: 'ok', canonical: exact };
            const cands = divisions.filter((d) => n.includes(norm(d)) || norm(d).includes(n));
            const app = S.divisionNameOf(s);
            if (cands.length > 1) return { status: 'ambiguous', canonical: app, candidates: cands };
            if (app) {
                // "Old Malda" in a division column reads as Malda division in the app: a CCC name, not a division.
                const asCcc = cccs.find((c) => norm(c) === n);
                if (asCcc && norm(asCcc) !== norm(app)) return { status: 'ambiguous', canonical: app, candidates: [app, asCcc + ' (CCC)'] };
                const loose = looseKey(s);
                return { status: divisions.some((d) => norm(d) === loose) ? 'ok' : 'variant', canonical: app };
            }
            return { status: 'unknown', canonical: '' };
        });
    }

    function codeToCccFull(code) {
        if (codeToCcc[code]) return codeToCcc[code];
        const viaApp = S.cccNameOf(code);
        return viaApp && cccs.includes(viaApp) ? viaApp : '';
    }

    function ccc(raw) {
        return memo('c', raw, () => {
            const s = String(raw).trim().replace(/\.0+$/, '');
            if (!s) return { status: 'blank', canonical: '' };
            const n = norm(s);
            if (extra.ccc && extra.ccc[n]) return { status: 'ok', canonical: extra.ccc[n] };
            if (/^\d{7,8}$/.test(s) && cccs.includes(S.cccNameOf(s))) return { status: 'ok', canonical: S.cccNameOf(s), byCode: true, code: s };
            const codes = codesIn(s);
            if (codes.length) {
                const c = codeToCccFull(codes[0]);
                if (!c) {
                    const u = nonCccUnit(codes[0]);
                    if (u) return { status: 'non_ccc_unit', canonical: '', code: codes[0], level: u.level, division: S.divisionNameOf(codes[0].slice(0, 4)) || '' };
                    return { status: 'unknown_code', canonical: '', code: codes[0] };
                }
                // "Fulbari (6611108)": code and name in one cell must agree.
                const rest = norm(s.replace(/\d+/g, ' '));
                if (rest && rest.length >= 3 && !norm(c).includes(rest) && !rest.includes(norm(c))) {
                    return { status: 'code_name_mismatch', canonical: c, code: codes[0] };
                }
                return { status: 'ok', canonical: c, byCode: true, code: codes[0] };
            }
            if (s === '6600000') return { status: 'non_ccc_unit', canonical: '', code: s, level: 'zone' };
            if (/^\d{7,8}$/.test(s)) return { status: 'unknown_code', canonical: '', code: s };
            if (!n) return { status: 'unknown', canonical: '' };
            const exact = cccs.find((c) => norm(c) === n);
            if (exact) return { status: 'ok', canonical: exact };
            const app = S.cccNameOf(s);
            const known = cccs.includes(app);
            const cands = cccs.filter((c) => {
                const cn = norm(c);
                return n.includes(cn) || (n.length >= 4 && cn.includes(n));
            });
            if (cands.length > 1) return { status: 'ambiguous', canonical: known ? app : '', candidates: cands };
            // A division/region name in a CCC column ("Malda") resolves to a different office in the app.
            const asDiv = divisions.find((d) => norm(d) === n) || regions.find((r) => norm(r) === n);
            if (asDiv && known && norm(app) !== n) return { status: 'ambiguous', canonical: app, candidates: [app, asDiv + ' (division/region)'] };
            if (known) {
                const loose = looseKey(s);
                return { status: cccs.some((c) => norm(c) === loose) ? 'ok' : 'variant', canonical: app };
            }
            return { status: 'unknown', canonical: '' };
        });
    }

    /** A value in an office-code column: CCC code (7 digits), division code (4 digits) or other. */
    function code(raw) {
        return memo('k', raw, () => {
            const s = String(raw).trim().replace(/\.0+$/, '');
            if (!s) return { status: 'blank', canonical: '' };
            if (/^\d{7,8}$/.test(s) && cccs.includes(S.cccNameOf(s))) {
                const c = S.cccNameOf(s);
                return { status: 'ok', level: 'ccc', ccc: c, division: divOf[c], region: regionOfCcc[c], code: s };
            }
            if (/^66[123]\d$/.test(s)) {
                const d = S.divisionNameOf(s);
                return d ? { status: 'ok', level: 'division', division: d, region: regionOfDiv[d] } : { status: 'unknown_code', level: 'division' };
            }
            if (s === '6600000') return { status: 'non_ccc_unit', level: 'zone', code: s };
            const codes = codesIn(s);
            if (codes.length) {
                const c = codeToCccFull(codes[0]);
                if (!c) {
                    const d = S.divisionNameOf(codes[0].slice(0, 4));
                    const u = nonCccUnit(codes[0]);
                    if (u) return { status: 'non_ccc_unit', level: u.level, code: codes[0], division: u.level === 'region' ? '' : d || '' };
                    return { status: 'unknown_code', level: 'ccc', code: codes[0], division: d || '' };
                }
                return { status: 'ok', level: 'ccc', ccc: c, division: divOf[c], region: regionOfCcc[c], code: codes[0] };
            }
            if (/^66\d{2,6}$/.test(s)) return { status: 'outside_zone', level: s.length <= 4 ? 'division' : 'ccc' };
            if (/^\d{4,8}$/.test(s)) return { status: 'not_office_code' };
            return { status: 'not_code' };
        });
    }

    const plantMap = opts.plantMap || loadPlantMap();
    /** Stock plant code (4 digits) → { status, division } from the stock page's PLANT_MAP. */
    function plant(raw) {
        return memo('p', raw, () => {
            const s = String(raw).trim();
            if (!s) return { status: 'blank', canonical: '' };
            const label = plantMap[s];
            if (!label) return { status: 'unknown', canonical: '' };
            if (/zone/i.test(label)) return { status: 'ok', canonical: label, level: 'zone' };
            const d = division(label);
            return { status: 'ok', canonical: label, division: d.canonical, level: 'division' };
        });
    }

    return {
        plant, plantMap,
        scope: S, regions, divisions, cccs, divOf, regionOfDiv, regionOfCcc, codeToCcc,
        region, division, ccc, code, codesIn, norm, looseKey
    };
}

module.exports = { createResolver, loadScope, loadPlantMap, nonCccUnit, norm, looseKey, LEGACY_DIVISION_RE };
