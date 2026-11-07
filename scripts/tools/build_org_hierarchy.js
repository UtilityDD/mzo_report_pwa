#!/usr/bin/env node
// Builds data/org/wbsedcl_hierarchy.json (Admin → Organisation, GET /api/admin/org) from a researched
// WBSEDCL hierarchy file, and fills in the zone this app covers from the app's own office master:
//
//   node scripts/tools/build_org_hierarchy.js <researched hierarchy.json> [out]
//
// Input schema: {asOf, sources[], root:{level, name, children:[(chief_engineer →) zone → region → division → ccc]}}, each
// node with name, code (optional), aliases, confidence (confirmed / partial / inferred) and source
// (indices into sources[]). Office names, codes and post titles only: no personal data.
//
// What it changes:
//   - region names use the app's canonical names (Uttar Dinajpur, Dakshin Dinajpur; the old Raiganj and
//     Balurghat region names become aliases);
//   - in the app's zone (lib/offices.js), every region, division and CCC the office master has is matched by
//     code, name or alias; a missing code is filled in, and a missing division or CCC is added with
//     confidence "confirmed" and the office master as its source;
//   - counts are recomputed. Everything else is copied as it is.
// See docs/org-hierarchy.md.
'use strict';

const fs = require('fs');
const path = require('path');
const O = require('../../lib/offices.js');
const H = require('../../lib/org_hierarchy.js');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'data', 'org', 'wbsedcl_hierarchy.json');
// The app's old region names → the canonical (district) names now used for regions.
const CANONICAL_REGION = { raiganj: 'Uttar Dinajpur', balurghat: 'Dakshin Dinajpur' };
const MASTER_SOURCE = { url: '', title: 'MZO Reports office master (lib/offices.js): Malda Zone office codes, divisions and CCCs' };

function build(data) {
    const out = JSON.parse(JSON.stringify(data));
    const root = out.root;
    const key = O.key;
    const master = H.appMaster(O);
    const filled = { codes: 0, divisions: 0, cccs: 0, renamed: 0 };
    let srcIndex = -1;
    const masterSource = () => {
        if (srcIndex < 0) {
            out.sources = Array.isArray(out.sources) ? out.sources : [];
            srcIndex = out.sources.findIndex((s) => s && /office master/i.test(String(s.title || ''))); // the research may cite it already
            if (srcIndex < 0) { out.sources.push(Object.assign({ fetched: new Date().toISOString().slice(0, 10) }, MASTER_SOURCE)); srcIndex = out.sources.length - 1; }
        }
        return srcIndex;
    };
    const addSource = (node) => {
        const i = masterSource();
        const list = Array.isArray(node.source) ? node.source : (node.source != null ? [node.source] : []);
        if (list.indexOf(i) < 0) list.push(i);
        node.source = list;
    };
    const fillCode = (node, office) => {
        if (!node.code && office.code) { node.code = office.code; filled.codes++; addSource(node); }
    };

    // Canonical region names everywhere.
    (function walk(n) {
        if (n.level === 'region') {
            const canon = CANONICAL_REGION[key(n.name)];
            if (canon) {
                n.aliases = Array.isArray(n.aliases) ? n.aliases : [];
                if (!n.aliases.some((a) => key(a) === key(n.name))) n.aliases.unshift(n.name);
                n.name = canon;
                filled.renamed++;
            }
        }
        (n.children || []).forEach(walk);
    })(root);

    const zone = H.zonesOf(root).find((z) => H.matchOffice(z, master.zone, key));
    if (!zone) throw new Error('the app zone (' + O.ZONE.name + ') is not in the researched file');
    fillCode(zone, master.zone[0]);
    zone.children = zone.children || [];
    O.REGIONS.forEach((r) => {
        const office = master.region.find((x) => x.code === r.code);
        let rn = zone.children.find((n) => n.level === 'region' && H.matchOffice(n, [office], key));
        if (!rn) {
            rn = { level: 'region', name: CANONICAL_REGION[key(r.name)] || r.name, code: r.code, aliases: [r.name], district: r.district, confidence: 'confirmed', children: [] };
            addSource(rn);
            zone.children.push(rn);
        }
        fillCode(rn, office);
        rn.children = rn.children || [];
        O.DIVISIONS.filter((d) => d.region === r.name).forEach((d) => {
            const dOffice = master.division.find((x) => x.code === d.code);
            let dn = rn.children.find((n) => n.level === 'division' && H.matchOffice(n, [dOffice], key));
            if (!dn) {
                dn = { level: 'division', name: d.name, code: d.code, aliases: [], confidence: 'confirmed', children: [] };
                addSource(dn);
                rn.children.push(dn);
                filled.divisions++;
            }
            fillCode(dn, dOffice);
            dn.children = dn.children || [];
            O.CCCS.filter((c) => c.division === d.name).forEach((c) => {
                const cOffice = master.ccc.find((x) => x.code === c.code);
                let cn = dn.children.find((n) => n.level === 'ccc' && H.matchOffice(n, [cOffice], key));
                if (!cn) {
                    cn = { level: 'ccc', name: c.name, code: c.code, aliases: (c.aliases || []).filter((a) => key(a) !== key(c.name)).slice(0, 4), confidence: 'confirmed' };
                    addSource(cn);
                    dn.children.push(cn);
                    filled.cccs++;
                }
                fillCode(cn, cOffice);
            });
        });
    });

    const counts = { chief_engineer: 0, zone: 0, region: 0, division: 0, ccc: 0 };
    const conf = {};
    (function walk(n, d) {
        if (d > 0 && counts[n.level] != null) {
            counts[n.level]++;
            conf[n.level] = conf[n.level] || {};
            conf[n.level][n.confidence || 'confirmed'] = (conf[n.level][n.confidence || 'confirmed'] || 0) + 1;
        }
        (n.children || []).forEach((c) => walk(c, d + 1));
        if (Array.isArray(n.unplacedCccs) && n.unplacedCccs.length) counts.ccc_unplaced = (counts.ccc_unplaced || 0) + n.unplacedCccs.length;
    })(root, 0);
    if (!counts.chief_engineer) delete counts.chief_engineer;
    out.counts = counts;
    out.confidenceByLevel = conf;
    delete out.seed;
    return { out, filled };
}

if (require.main === module) {
    const src = process.argv[2];
    if (!src) { console.error('usage: node scripts/tools/build_org_hierarchy.js <hierarchy.json> [out]'); process.exit(2); }
    const dest = process.argv[3] ? path.resolve(process.argv[3]) : OUT;
    const { out, filled } = build(JSON.parse(fs.readFileSync(src, 'utf8')));
    const problems = H.check(out.root);
    if (problems.length) { console.error('dataset problems:\n' + problems.join('\n')); process.exit(1); }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
    console.log(`wrote ${path.relative(ROOT, dest)}: asOf ${out.asOf}, ${JSON.stringify(out.counts)}; from the office master: ` +
        `${filled.codes} codes, ${filled.divisions} divisions, ${filled.cccs} CCCs; ${filled.renamed} region names made canonical`);
}

module.exports = { build };
