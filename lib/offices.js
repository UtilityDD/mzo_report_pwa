/* lib/offices.js: the canonical MZO office list, shared by the browser (window.MzoOffices) and
 * Node (require). Zone → region → division → CCC, with codes and every alias seen in the data:
 * the one place that every dataset maps to.
 *
 *   resolve({ codes, cccs, divisions, regions })  one row's office cells → canonical office + problems
 *   parseCode / parseCccName / parseDivision / parseRegion   one cell → office
 *   officeColumns(datasetKey, columns)             which columns of a dataset hold office values
 *   enricher(datasetKey, columns)                  per-row _region/_division/_ccc_code/_ccc + office.* issues
 *   dimRows()                                      the dim_offices records
 *   addCostCentres(list)                           map old SAP cost centres (data/costcenter.json)
 *
 * mzo_scope.js keeps the browser's scope rules; its HIERARCHY and CODE_TO_CCC must list the same
 * offices. When an office or an alias is added, change it here (and there for a new office).
 * See docs/architecture.md ("Offices") and docs/data-quality-offices.md.
 *
 * Office codes are 7 digits: 66 R D 1 CC for a CCC (6611101 = Manikchak), 66 R D 000 for a
 * division office (6611000), 66 R 0000 for a region office (6610000) and 6600000 for the zone.
 * SAP cost centres write them as C3 + code + 0 (C366111010). Divisions also appear as their
 * 4-digit prefix (6611) or as an old SAP plant code (3342 = Malda).
 * No dependencies and no Node-only APIs.
 */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.MzoOffices = api;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const VERSION = 'offices/1';

const ZONE = { code: '6600000', name: 'Malda Zone', plants: ['6600', '7201'], aliases: ['malda zone', 'malda (d) zone', 'mzo', 'malda zonal o', 'malda dist zonal o'] };

// district / LGD code: how district-wise sheets name the region.
const REGIONS = [
    { name: 'Malda', code: '6610000', prefix: '661', district: 'Malda', lgd: '316',
        aliases: ['malda', 'maldah', 'malda region', 'english bazar'] },
    { name: 'Raiganj', code: '6620000', prefix: '662', district: 'Uttar Dinajpur', lgd: '311',
        aliases: ['raiganj', 'raigunj', 'uttar dinajpur', 'uttardinajpur', 'dinajpur uttar', 'u dinajpur', 'u d', 'ud', 'north dinajpur'] },
    { name: 'Balurghat', code: '6630000', prefix: '663', district: 'Dakshin Dinajpur', lgd: '310',
        aliases: ['balurghat', 'dakshin dinajpur', 'dakshindinajpur', 'dakhsin dinajpur', 'dinajpur dakshin', 'd dinajpur', 'd d', 'dd', 'south dinajpur'] }
];

// plants: old SAP plant codes whose store is this division's (stock dump, O&M advance). The old
// plants' cost centres do not all follow: 3342 also held Aiho and Old Malda, 3343 Gazole, Pandua and
// Bamongola, 3433 the Buniadpur CCCs; those cost centres are mapped by unit (OLD_COST_CENTRES).
const DIVISIONS = [
    { name: 'Malda', code: '6611000', prefix: '6611', region: 'Malda', plants: ['3342'], aliases: ['malda', 'malda divisioin', 'malda divison'] },
    { name: 'Chanchal', code: '6612000', prefix: '6612', region: 'Malda', plants: ['3343'], aliases: ['chanchal'] },
    { name: 'Gazole', code: '6613000', prefix: '6613', region: 'Malda', plants: [], aliases: ['gazole', 'gazol', 'gajol'] },
    { name: 'Raiganj', code: '6621000', prefix: '6621', region: 'Raiganj', plants: ['3432'], aliases: ['raiganj', 'raigunj', 'uttar dinajpur', 'uttardinajpur'] },
    { name: 'Islampur', code: '6622000', prefix: '6622', region: 'Raiganj', plants: ['3434'], aliases: ['islampur'] },
    { name: 'Balurghat', code: '6631000', prefix: '6631', region: 'Balurghat', plants: ['3461', '3433'], aliases: ['balurghat', 'dakshin dinajpur', 'dakshindinajpur'] },
    { name: 'Buniadpur', code: '6632000', prefix: '6632', region: 'Balurghat', plants: ['3462'], aliases: ['buniadpur'] }
];

// The two Malda divisions before Gazole division was formed. They do not map to one division
// (Old Malda and Aiho were South Malda; Gazole, Pandua and Bamongola were North Malda), so a row
// that has only this name keeps its region and takes the division from its CCC.
const LEGACY_DIVISIONS = {
    'south malda': { region: 'Malda', divisions: ['Malda', 'Gazole'] },
    'north malda': { region: 'Malda', divisions: ['Chanchal', 'Gazole'] }
};

// [code, canonical name, division, ...aliases]. Aliases are compared after key() below, so case,
// spaces, dots, "CCC", "Customer Care Center" and a trailing code never need listing.
const CCCS = [
    ['6611101', 'Manikchak', 'Malda', 'mathurapur'],
    ['6611102', 'Golapganj', 'Malda', 'golapgang'],
    ['6611103', 'Baishnabnagar', 'Malda', 'baisnabnagar', 'baishnab nagar'],
    ['6611104', 'Kaliachak', 'Malda'],
    ['6611105', 'Mothabari', 'Malda', 'mathabari'],
    ['6611106', 'Sujapur', 'Malda', 'sujpur'],
    ['6611107', 'Rathbari', 'Malda'],
    ['6611108', 'Fulbari', 'Malda'],
    ['6611109', 'Mokdumpur', 'Malda', 'mokdampur', 'makdumpur'],
    ['6612101', 'Bhaluka', 'Chanchal'],
    ['6612102', 'Samsi', 'Chanchal'],
    ['6612103', 'Paranpur', 'Chanchal'],
    ['6612104', 'Chanchal', 'Chanchal'],
    ['6612105', 'Malatipur', 'Chanchal'],
    ['6612106', 'Harishchandrapur', 'Chanchal', 'harischandrapur', 'h c pur', 'hc pur'],
    ['6612107', 'Kushida', 'Chanchal', 'kusida'],
    ['6613101', 'Gazole', 'Gazole', 'gazol', 'gajol'],
    ['6613102', 'Aiho', 'Gazole'],
    ['6613103', 'Pandua', 'Gazole', 'pandua i', 'pandua 1'],
    ['6613104', 'Bamongola', 'Gazole', 'bamangola'],
    ['6613105', 'Old Malda', 'Gazole'],
    ['6621101', 'Itahar', 'Raiganj'],
    ['6621102', 'Hemtabad', 'Raiganj'],
    ['6621103', 'Kaliyaganj', 'Raiganj', 'kaliaganj'],
    ['6621104', 'Raiganj', 'Raiganj', 'raigunj'],
    ['6621105', 'Birnagar', 'Raiganj'],
    ['6621106', 'Karandighi', 'Raiganj', 'karandeghi', 'karandigi'],
    ['6622101', 'Islampur', 'Islampur'],
    ['6622102', 'Chopra', 'Islampur'],
    ['6622103', 'Dalkhola', 'Islampur'],
    ['6622104', 'Goalpokher', 'Islampur', 'goalpokhar'],
    ['6622105', 'Kanki', 'Islampur'],
    ['6631101', 'Balurghat', 'Balurghat'],
    ['6631102', 'Tapan', 'Balurghat'],
    ['6631103', 'Kumarganj', 'Balurghat', 'kumargunj'],
    ['6631104', 'Hili', 'Balurghat'],
    ['6631105', 'Patiram', 'Balurghat'],
    ['6632101', 'Buniadpur', 'Buniadpur'],
    ['6632102', 'Kusmandi', 'Buniadpur', 'kushmandi', 'kushmundi'],
    ['6632103', 'Harirampur', 'Buniadpur'],
    ['6632104', 'Gangarampur', 'Buniadpur']
];

// Mistyped codes found in the sheets (kept so those rows still count; dq-audit lists them as source fixes).
const CODE_TYPOS = { '66111609': '6611109', '66131101': '6613101' };

// Truncated names that are unambiguous only inside their division (pending MC writes "Pa" for Pandua).
const SHORT_NAMES = { pa: { division: 'Gazole', ccc: 'Pandua' } };

// Other WBSEDCL zones, regions and districts that statewide sheets (WRIDD, accidents, PM Surya Ghar)
// include: recognised so they are reported as "outside the zone", not as unknown MZO offices.
const OUTSIDE = ['berhampore', 'siliguri', 'murshidabad', 'nadia', 'coochbehar', 'cooch behar', 'darjeeling', 'jalpaiguri',
    'alipurduar', 'hooghly', 'bankura', 'purulia', 'birbhum', 'burdwan', 'bardhaman', 'purba bardhaman', 'paschim bardhaman',
    'purba burdwan', 'paschim burdwan', 'medinipur', 'midnapore', 'midnapur', 'paschim medinipur', 'paschim midnapore',
    'paschim midnapur', 'purba medinipur', 'jhargram', 'kolkata', 'howrah', 'north 24 parganas', 'south 24 parganas', 'tcl'];

// ---------------------------------------------------------------------------------------------

/** Name → lookup key: lowercase ASCII words without office-type words, codes or punctuation. */
function key(raw) {
    return String(raw == null ? '' : raw)
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\(\s*c?3?66\d{5}0?\s*\)/g, ' ') // "(6611101)"
        .replace(/[-–:]?\s*\bc?3?66[0-3]\d{4}0?\b/g, ' ') // "CCC-6611101"
        .replace(/customer care cent(er|re)/g, ' ')
        .replace(/\(\s*d\s*\)|\(\s*o\s*(&|and)\s*m\s*\)|\bo\s*(&|and)\s*[mn]\b|\bd\s+o\s+and\s+[mn]\b/g, ' ')
        .replace(/\b(ccc|divisioin|divison|division|divn|div|region|regio|reg|circle|district|dist|zone|zonal|office)\b\.?/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Office-type words in a raw name: 'zone' | 'region' | 'division' | 'ccc' | 'substation' | ''. */
function levelHint(raw) {
    const s = String(raw == null ? '' : raw).toLowerCase();
    if (/\btotal\b/.test(s)) return 'total';
    if (/\b\d+\s*(kv|\/\d+\s*kv)\b|\bs\s*\/\s*s\b|substation|sub-station/.test(s)) return 'substation';
    if (/\bccc\b|customer care/.test(s)) return 'ccc';
    if (/\bdiv(ision|isioin|ison|n)?\b\.?/.test(s)) return 'division';
    if (/\bregi?on?\b|\breg\b|\bcircle\b/.test(s)) return 'region';
    if (/\bzon(e|al)\b/.test(s)) return 'zone';
    return '';
}

const REGION_BY = new Map();
const DIVISION_BY = new Map();
const CCC_BY_KEY = new Map();
const CCC_BY_CODE = new Map();
const DIVISION_BY_PREFIX = new Map();
const DIVISION_BY_NAME = new Map();
const REGION_BY_NAME = new Map();
const REGION_BY_PREFIX = new Map();

for (const r of REGIONS) {
    REGION_BY_NAME.set(r.name, r);
    REGION_BY_PREFIX.set(r.prefix, r);
    for (const a of [r.name, r.district, ...r.aliases]) REGION_BY.set(key(a), r);
}
for (const d of DIVISIONS) {
    DIVISION_BY_NAME.set(d.name, d);
    DIVISION_BY_PREFIX.set(d.prefix, d);
    for (const p of d.plants) DIVISION_BY_PREFIX.set(p, d);
    for (const a of [d.name, ...d.aliases]) DIVISION_BY.set(key(a), d);
}
const CCC_LIST = CCCS.map(([code, name, division, ...aliases]) => {
    const d = DIVISION_BY_NAME.get(division);
    const c = { code, name, division, region: d.region, aliases };
    CCC_BY_CODE.set(code, c);
    for (const a of [name, ...aliases]) {
        const k = key(a);
        if (CCC_BY_KEY.has(k) && CCC_BY_KEY.get(k) !== c) throw new Error(`offices.js: alias "${a}" names two CCCs`);
        CCC_BY_KEY.set(k, c);
    }
    return c;
});
const OUTSIDE_KEYS = new Set(OUTSIDE.map(key));

// Old SAP cost centres (C3 + old plant + unit, e.g. C334621020 = Kusmandi CCC under old plant 3462)
// still carry capex balances. data/costcenter.json names their unit; addCostCentres(list) maps a
// unit that is a CCC or a division office to that office in today's structure. Node callers get
// it loaded by vm/sync/lib/offices.js; pages pass the CACHE_COSTCENTER rows.
const OLD_COST_CENTRES = new Map();
function addCostCentres(list) {
    let n = 0;
    for (const e of Array.isArray(list) ? list : []) {
        const code = String((e && e['Cost Cen_Code']) || '').trim().toUpperCase();
        if (!/^C3\d{7}0$/.test(code) || /^C366/.test(code)) continue;
        const unit = String(e['Unit Name'] || '');
        const k = key(unit);
        const c = /\bccc\b/i.test(unit) ? CCC_BY_KEY.get(k) : null;
        const d = !c && /\bdiv(ision|n)?\b/i.test(unit) && !/store/i.test(unit) ? DIVISION_BY.get(k) : null;
        if (c) OLD_COST_CENTRES.set(code, { ccc: c });
        else if (d) OLD_COST_CENTRES.set(code, { division: d });
        if (c || d) n++;
    }
    return n;
}

/** A canonical office record for output. */
function officeOf(level, region, division, ccc) {
    return {
        level,
        region: region || '',
        division: division || '',
        ccc_code: ccc ? ccc.code : '',
        ccc: ccc ? ccc.name : ''
    };
}
function cccOffice(c) {
    return officeOf('ccc', c.region, c.division, c);
}
function divisionOffice(d) {
    return officeOf('division', d.region, d.name, null);
}
function regionOffice(r) {
    return officeOf('region', r.name, '', null);
}

/**
 * One code cell → office, or { level: 'unknown' | 'outside' | 'zone' }.
 * Accepts 6611101, " 6611101 ", 6611101.0, C366111010, 66111010 (padded), CCC-6611101 inside text,
 * 4-digit division prefixes and old plant codes, division/region/zone office codes.
 */
function parseCode(raw) {
    let s = String(raw == null ? '' : raw).trim().toUpperCase().replace(/\.0+$/, '');
    if (!s) return null;
    if (CODE_TYPOS[s]) s = CODE_TYPOS[s];
    let m = s.match(/^C3(\d{7})0$/);
    if (m) {
        const old = OLD_COST_CENTRES.get(s);
        if (old) return old.ccc ? cccOffice(old.ccc) : divisionOffice(old.division);
        if (!/^66/.test(m[1])) return { level: 'outside', raw: s };
        s = m[1];
    } else if (/^C3\d/.test(s)) {
        return { level: /^C366/.test(s) ? 'unknown' : 'outside', raw: s };
    }
    if (/^\d{4}$/.test(s)) {
        if (ZONE.plants.includes(s)) return { level: 'zone' };
        const d = DIVISION_BY_PREFIX.get(s);
        return d ? divisionOffice(d) : { level: /^66/.test(s) ? 'unknown' : 'outside', raw: s };
    }
    let digits = /^\d+$/.test(s) ? s : '';
    if (!digits) {
        // a code written inside a name: "SAMSI CCC-6612102", "BALURGHAT CCC (6631101)"
        const found = s.match(/(?:^|\D)(66[0-3]\d{4})(?:\D|$)/);
        if (!found) return { level: 'unknown', raw: s };
        digits = found[1];
    }
    if (digits.length === 8 && digits.endsWith('0')) digits = digits.slice(0, 7); // 66211010 → 6621101
    if (digits.length !== 7 || !/^66[0-3]/.test(digits)) return { level: 'unknown', raw: s };
    if (digits === ZONE.code) return { level: 'zone' };
    const c = CCC_BY_CODE.get(digits);
    if (c) return cccOffice(c);
    const r = REGION_BY_PREFIX.get(digits.slice(0, 3));
    if (r && digits.slice(3) === '0000') return regionOffice(r);
    const d = DIVISION_BY_PREFIX.get(digits.slice(0, 4));
    // 66RD000 is the division office; 66RD0xx, 66RD3xx … are its other units (stores, sub-stations,
    // DCC). Only 66RD1xx is a CCC, so an unknown one of those is a wrong code.
    if (d && digits[4] !== '1') return divisionOffice(d);
    return { level: 'unknown', raw: s, division: d ? d.name : '', region: d ? d.region : r ? r.name : '' };
}

function isOutside(k) {
    if (!k) return false;
    if (OUTSIDE_KEYS.has(k)) return true;
    for (const o of OUTSIDE_KEYS) if (k.startsWith(o + ' ')) return true;
    return false;
}

/** A name in a CCC-type column → office (a CCC, or a division/region/zone office named there). */
function parseCccName(raw, divisionHint) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s || /^\(?null\)?$/i.test(s) || /^(-|n\/?a|#n\/a|value|bulk)$/i.test(s)) return null;
    const code = parseCode(s);
    if (code && code.level !== 'unknown' && code.level !== 'outside') return code; // name carries a code
    const hint = levelHint(s);
    const k = key(s);
    if (!k) return null;
    if (hint === 'substation' || hint === 'total') return { level: 'other', raw: s };
    if (hint === 'zone' || /^mzo$/i.test(s)) return { level: 'zone' };
    if (hint === 'division') return parseDivision(s);
    if (hint === 'region') return parseRegion(s);
    const c = CCC_BY_KEY.get(k);
    if (c) return cccOffice(c);
    const short = SHORT_NAMES[k];
    if (short && (!divisionHint || divisionHint === short.division)) return cccOffice(CCC_BY_KEY.get(key(short.ccc)));
    if (isOutside(k)) return { level: 'outside', raw: s };
    return { level: 'unknown', raw: s };
}

/** A division-column value → division office, legacy division, or unknown. */
function parseDivision(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s || /^\(?null\)?$/i.test(s) || /^(-|n\/?a|value)$/i.test(s)) return null;
    if (/^\d{4}$/.test(s) || /^\d{7}$/.test(s) || /^C3\d/i.test(s)) {
        const c = parseCode(s);
        if (c && c.level === 'ccc') return divisionOffice(DIVISION_BY_NAME.get(c.division));
        return c;
    }
    const hint = levelHint(s);
    if (hint === 'total') return { level: 'other', raw: s };
    if (hint === 'zone') return { level: 'zone' };
    const k = key(s);
    if (!k) return null;
    const legacy = LEGACY_DIVISIONS[k];
    if (legacy) return { level: 'legacy', region: legacy.region, divisions: legacy.divisions, raw: s };
    const d = DIVISION_BY.get(k);
    if (d) return divisionOffice(d);
    if (levelHint(s) === 'region') return parseRegion(s);
    if (isOutside(k)) return { level: 'outside', raw: s };
    return { level: 'unknown', raw: s };
}

/** A region / circle / district value → region office, or unknown. */
function parseRegion(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s || /^\(?null\)?$/i.test(s) || /^(-|n\/?a|value|not known)$/i.test(s)) return null;
    if (/^\d{3}$/.test(s)) {
        const r = REGIONS.find((x) => x.lgd === s);
        return r ? regionOffice(r) : { level: 'outside', raw: s };
    }
    if (/^66[0-3]0000$/.test(s)) return parseCode(s);
    if (levelHint(s) === 'zone') return { level: 'zone' };
    const k = key(s);
    if (!k) return null;
    const r = REGION_BY.get(k);
    if (r) return regionOffice(r);
    if (isOutside(k)) return { level: 'outside', raw: s };
    return { level: 'unknown', raw: s };
}

/**
 * One row → canonical office.
 * @param {{codes?: string[], cccs?: string[], divisions?: string[], regions?: string[]}} cells raw cell values by role
 * @returns {{ office: {level, region, division, ccc_code, ccc}, problems: {check, role, value, detail}[] }}
 */
function resolve(cells) {
    const problems = [];
    const nonEmpty = (list) => (list || []).map((v) => (v == null ? '' : String(v))).filter((v) => v.trim() !== '');
    const regionCells = nonEmpty(cells.regions).map((v) => [v, parseRegion(v)]).filter((x) => x[1]);
    const divisionCells = nonEmpty(cells.divisions).map((v) => [v, parseDivision(v)]).filter((x) => x[1]);
    const regionGuess = regionCells.map((x) => x[1]).find((o) => o.level === 'region');
    const divGuess = divisionCells.map((x) => x[1]).find((o) => o.level === 'division');
    // A "code" cell that holds a name (portal_users.ccc_code = "Kaliyaganj") is read as a CCC name.
    const codeCells = nonEmpty(cells.codes).map((v) => [v, /\d/.test(v) ? parseCode(v) : parseCccName(v, divGuess && divGuess.division)]).filter((x) => x[1]);
    const cccCells = nonEmpty(cells.cccs).map((v) => [v, parseCccName(v, divGuess && divGuess.division)]).filter((x) => x[1]);

    for (const [v, o] of codeCells) if (o.level === 'unknown') problems.push({ check: 'office.unknown_code', role: 'code', value: v });
    for (const [v, o] of cccCells) if (o.level === 'unknown') problems.push({ check: 'office.unknown_ccc', role: 'ccc', value: v });
    for (const [v, o] of divisionCells) if (o.level === 'unknown') problems.push({ check: 'office.unknown_division', role: 'division', value: v });
    for (const [v, o] of regionCells) if (o.level === 'unknown') problems.push({ check: 'office.unknown_region', role: 'region', value: v });
    const outside = [...codeCells, ...cccCells, ...divisionCells, ...regionCells].filter((x) => x[1].level === 'outside');
    const mzoCell = [...codeCells, ...cccCells, ...divisionCells, ...regionCells].some((x) => ['ccc', 'division', 'region', 'zone', 'legacy'].includes(x[1].level));
    if (outside.length && !mzoCell) {
        // A statewide sheet's row from another zone: its other names are not "unknown MZO offices".
        return { office: officeOf('outside', '', '', null), problems: [{ check: 'office.outside_zone', role: '', value: outside[0][0] }] };
    }

    const rank = { ccc: 4, division: 3, region: 2, zone: 1 };
    const best = (list) => list.map((x) => x[1]).filter((o) => rank[o.level]).sort((a, b) => rank[b.level] - rank[a.level])[0] || null;
    const byCode = best(codeCells);
    const byName = best(cccCells);

    let office = null;
    if (byCode && byCode.level === 'ccc' && byName && byName.level === 'ccc' && byCode.ccc_code !== byName.ccc_code) {
        // The code and the name disagree: let the division / region cells decide, else trust the code.
        const votes = (o) => (divGuess && divGuess.division === o.division ? 1 : 0) + (regionGuess && regionGuess.region === o.region ? 1 : 0);
        office = votes(byName) > votes(byCode) ? byName : byCode;
        problems.push({ check: 'office.code_name_mismatch', role: 'ccc', value: `${codeCells[0][0]} / ${cccCells[0][0]}`,
            detail: `code says ${byCode.ccc}, name says ${byName.ccc}; used ${office.ccc}` });
    } else {
        const cands = [byCode, byName].filter(Boolean).sort((a, b) => rank[b.level] - rank[a.level]);
        office = cands[0] || null;
    }
    if (!office || rank[office.level] < rank.division) {
        if (divGuess) office = divGuess;
    }
    const legacy = divisionCells.map((x) => x[1]).find((o) => o.level === 'legacy');
    if ((!office || rank[office.level] < rank.region) && legacy) {
        office = regionOffice(REGION_BY_NAME.get(legacy.region));
        problems.push({ check: 'office.legacy_division', role: 'division', value: legacy.raw, detail: `could be ${legacy.divisions.join(' or ')}` });
    }
    if ((!office || rank[office.level] < rank.region) && regionGuess) office = regionGuess;
    if (!office && outside.length) {
        problems.push({ check: 'office.outside_zone', role: '', value: outside[0][0] });
        return { office: officeOf('outside', '', '', null), problems };
    }
    const zoneCell = [...codeCells, ...cccCells, ...divisionCells, ...regionCells].some((x) => x[1].level === 'zone');
    if (!office) office = officeOf(zoneCell ? 'zone' : '', '', '', null);

    // Parents named in the row must agree with the office found.
    if (office.division && divGuess && divGuess.division !== office.division) {
        problems.push({ check: 'office.parent_mismatch', role: 'division', value: divisionCells[0][0],
            detail: `row's ${office.level} ${office.ccc || office.division} is in ${office.division} division` });
    }
    if (office.division && legacy && !legacy.divisions.includes(office.division)) {
        problems.push({ check: 'office.parent_mismatch', role: 'division', value: legacy.raw,
            detail: `row's CCC ${office.ccc} is in ${office.division} division` });
    }
    if (office.region && regionGuess && regionGuess.region !== office.region) {
        problems.push({ check: 'office.parent_mismatch', role: 'region', value: regionCells[0][0],
            detail: `row's ${office.level} ${office.ccc || office.division || office.region} is in ${office.region} region` });
    }
    return { office, problems };
}

// ---- column roles --------------------------------------------------------------------------

/** Header → comparable form: lowercase words. */
function headerKey(h) {
    return String(h == null ? '' : h).replace(/^﻿/, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Exact header names (after headerKey) for each role. Free-text "Location", unit-of-measure and
// billing "unit" columns are deliberately absent.
const ROLE_HEADERS = {
    // Region / division "code" columns go to their own role: they hold codes (6610000, 6611, 3342) in
    // the dumps but office names in portal_users (region_code "Malda"), and both parse there.
    codes: ['ccc code', 'ccccode', 'cccode', 'cc code', 'office code', 'location code', 'ccc code hes', 'ccc crm', 'ccc final',
        'cost center', 'cost centre', 'cost cen code', 'substr a supp off 7 7', 'supp off code', 'unit code',
        'code of ccc substation re project'],
    cccs: ['ccc', 'ccc name', 'ccc1', 'supp off', 'support office', 'unit name', 'sub division name', 'office',
        'name of ccc substation re project', 'ccc office'],
    divisions: ['division', 'divn', 'divn name', 'division name', 'name of division re project', 'name 1',
        'division code', 'divn code', 'div code', 'plant', 'plant code', 'substr a supp off 7 4'],
    regions: ['region', 'reg', 'region name', 'circle name', 'name of the region', 'district', 'region code']
};
const ROLE_OF = new Map();
for (const [role, list] of Object.entries(ROLE_HEADERS)) for (const h of list) ROLE_OF.set(h, role);

// Per dataset: columns to leave out (another office's column, e.g. the source store of an allotment)
// or to use only (when a sheet has several code columns and one is the one the page uses).
const DATASET_COLUMNS = {
    stock_allotments: { codes: ['plant_code'], divisions: ['division'] },
    smart_meter_status: { codes: ['ccc_final'], cccs: [], divisions: [] }, // the page maps meters by ccc_final only
    wridd_schemes: { skip: ['name of circle division'] },
    capex_details: { skip: ['plant'] }, // the cost centre is more specific; old plants have no CCC
    costcenter: { cccs: [], divisions: [] }, // the code decides; old cost centres keep their old division name
    onm_advance: {},
    accident_reports: {}
};

/**
 * Office columns of one dataset.
 * @param {string} datasetKey
 * @param {{source_name: string, name?: string, index: number}[]} columns
 * @returns {{ codes: object[], cccs: object[], divisions: object[], regions: object[] } | null}
 */
function officeColumns(datasetKey, columns) {
    const cfg = DATASET_COLUMNS[datasetKey] || {};
    const skip = new Set((cfg.skip || []).map(headerKey));
    const out = { codes: [], cccs: [], divisions: [], regions: [] };
    let any = false;
    for (const col of columns) {
        const hk = headerKey(col.source_name);
        if (!hk || skip.has(hk)) continue;
        let role = ROLE_OF.get(hk);
        for (const r of Object.keys(out)) {
            if (cfg[r] && cfg[r].map(headerKey).includes(hk)) role = r;
            else if (cfg[r] && role === r) role = null;
        }
        if (!role) continue;
        out[role].push(col);
        any = true;
    }
    return any ? out : null;
}

const ENRICH_FIELDS = [
    { name: '_region', type: 'text' },
    { name: '_division', type: 'text' },
    { name: '_ccc_code', type: 'text' },
    { name: '_ccc', type: 'text' }
];

const CHECK_TEXT = {
    'office.unknown_code': ['warn', true, 'Office code is not an MZO CCC, division or region code. Correct the code in the sheet.'],
    'office.unknown_ccc': ['warn', true, 'CCC name is not a known MZO CCC or alias. Use the standard CCC name, or add the alias in vm/sync/lib/offices.js if it is a real spelling.'],
    'office.unknown_division': ['warn', true, 'Division name is not one of the 7 MZO divisions. Use the standard division name.'],
    'office.unknown_region': ['warn', true, 'Region / district is not Malda, Raiganj (Uttar Dinajpur) or Balurghat (Dakshin Dinajpur). Use the standard name.'],
    'office.code_name_mismatch': ['error', true, 'The CCC code and the CCC name point to different CCCs. Fix whichever is wrong in the sheet.'],
    'office.parent_mismatch': ['warn', true, 'The division or region written in the row does not contain the row\'s CCC. Fix the division / region cell.'],
    'office.legacy_division': ['info', true, 'Old division name (North / South Malda) that covers parts of two current divisions; the row needs a CCC to be placed in one.'],
    'office.outside_zone': ['info', false, 'Row belongs to an office outside Malda Zone (statewide sheet); it is kept but not mapped.']
};

/**
 * Per-dataset enrichment for the sync.
 * @returns {null | { fields, enrich(values) → {_region,_division,_ccc_code,_ccc}, issues() → issue[] , stats }}
 */
function enricher(datasetKey, columns) {
    const roles = officeColumns(datasetKey, columns);
    if (!roles) return null;
    const agg = new Map(); // check|column → { check, column, count, values: Map }
    const stats = { rows: 0, ccc: 0, division: 0, region: 0, zone: 0, outside: 0, none: 0 };
    const colName = (role, value, cells) => {
        const list = roles[role] || [];
        for (let i = 0; i < list.length; i++) if (cells[role][i] === value) return list[i].name || list[i].source_name;
        return list[0] ? list[0].name || list[0].source_name : '';
    };
    return {
        fields: ENRICH_FIELDS,
        roles,
        stats,
        enrich(values) {
            const cells = {};
            for (const role of Object.keys(roles)) cells[role] = roles[role].map((c) => values[c.index]);
            const { office, problems } = resolve(cells);
            stats.rows++;
            stats[office.level || 'none'] = (stats[office.level || 'none'] || 0) + 1;
            for (const p of problems) {
                const column = p.role ? colName(p.role === 'code' ? 'codes' : p.role + 's', p.value.split(' / ')[0], cells) : '';
                const k = p.check + '|' + column;
                let a = agg.get(k);
                if (!a) agg.set(k, (a = { check: p.check, column, count: 0, values: new Map() }));
                a.count++;
                const vk = p.value + (p.detail ? ' → ' + p.detail : '');
                a.values.set(vk, (a.values.get(vk) || 0) + 1);
            }
            return {
                _region: office.region || '',
                _division: office.division || '',
                _ccc_code: office.ccc_code || '',
                _ccc: office.ccc || ''
            };
        },
        issues() {
            const out = [];
            for (const a of agg.values()) {
                const [severity, sourceFix, hint] = CHECK_TEXT[a.check] || ['warn', true, ''];
                const sample = [...a.values.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([value, count]) => ({ value, count }));
                out.push({ dataset: datasetKey, check: a.check, severity, column: a.column, count: a.count, sample, source_fix: sourceFix, hint });
            }
            return out.sort((x, y) => y.count - x.count);
        }
    };
}

// ---- dim_offices ---------------------------------------------------------------------------

/** Every office as a dim_offices record (id derived from the code by the caller). */
function dimRows() {
    const rows = [];
    rows.push({ code: ZONE.code, level: 'zone', name: ZONE.name, region: '', division: '', ccc: '', parent_code: '', prefix: '66',
        district: '', lgd_code: '', plants: ZONE.plants, aliases: ZONE.aliases, sort: 0 });
    let sort = 1;
    for (const r of REGIONS) {
        rows.push({ code: r.code, level: 'region', name: r.name, region: r.name, division: '', ccc: '', parent_code: ZONE.code,
            prefix: r.prefix, district: r.district, lgd_code: r.lgd, plants: [], aliases: r.aliases, sort: sort++ });
        for (const d of DIVISIONS.filter((x) => x.region === r.name)) {
            const legacy = Object.keys(LEGACY_DIVISIONS).filter((k) => LEGACY_DIVISIONS[k].divisions.includes(d.name));
            rows.push({ code: d.code, level: 'division', name: d.name, region: r.name, division: d.name, ccc: '', parent_code: r.code,
                prefix: d.prefix, district: r.district, lgd_code: r.lgd, plants: d.plants, aliases: d.aliases.concat(legacy.map((k) => k + ' (old, part)')), sort: sort++ });
            for (const c of CCC_LIST.filter((x) => x.division === d.name)) {
                const typos = Object.keys(CODE_TYPOS).filter((t) => CODE_TYPOS[t] === c.code);
                rows.push({ code: c.code, level: 'ccc', name: c.name, region: r.name, division: d.name, ccc: c.name, parent_code: d.code,
                    prefix: c.code, district: r.district, lgd_code: r.lgd, plants: [], aliases: c.aliases.concat(typos.map((t) => 'code ' + t)), sort: sort++ });
            }
        }
    }
    return rows;
}

return {
    VERSION,
    ZONE,
    REGIONS,
    DIVISIONS,
    LEGACY_DIVISIONS,
    CCCS: CCC_LIST,
    CODE_TYPOS,
    ENRICH_FIELDS,
    key,
    levelHint,
    parseCode,
    parseCccName,
    parseDivision,
    parseRegion,
    resolve,
    headerKey,
    officeColumns,
    enricher,
    dimRows,
    addCostCentres
};
});
