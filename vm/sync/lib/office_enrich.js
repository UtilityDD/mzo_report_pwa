'use strict';
// Office enrichment for the sync (owned by dq-offices; the framework calls it from three places):
//
//   sync.js    const oe = officeEnrich.prepare(src, columns)   after buildColumns()
//              ensureCollection(pb, name, fieldList(columns).concat(oe ? oe.fields : []))
//              writeRows({ …, enrich: oe && oe.enrich })      and ctx.officeIssues = oe ? oe.issues() : []
//              the spool salt includes officeEnrich.VERSION, so a new office list rewrites the rows
//   upsert.js  each row: Object.assign(record, enrich(values)) before the row hash
//   run.js     await officeEnrich.syncDim(pb) once per run (writes dim_offices when the list changed)
//
// Rows of a ds_ collection with office columns get _region, _division, _ccc_code and _ccc: the
// canonical office (empty when unknown). Unknown and mismatched values come back from issues() in
// the sys_quality_issues shape for dq-audit's hook.

const offices = require('./offices');
const { recordId, log, errMessage } = require('./util');

const VERSION = offices.VERSION;
const DIM = 'dim_offices';

/**
 * @param {object} src source adapter (key)
 * @param {{name, source_name, index}[]} columns from buildColumns()
 * @returns {null | { fields: {name,type}[], enrich(values) → object, issues() → object[], stats }}
 */
function prepare(src, columns) {
    if (src && src.officeColumns === false) return null;
    const e = offices.enricher(src.key, columns);
    if (!e) return null;
    return {
        fields: offices.ENRICH_FIELDS.map((f) => ({ name: f.name, type: f.type })),
        enrich: (values) => e.enrich(values),
        issues: () => e.issues(),
        stats: e.stats
    };
}

/** Write dim_offices from lib/offices.js when its rows differ from what the collection holds. */
async function syncDim(pb) {
    try {
        if (!(await pb.getCollection(DIM))) return { skipped: 'no dim_offices collection (migration not applied)' };
        const want = offices.dimRows().map((r) => Object.assign({ id: recordId('dim_offices:' + r.code), version: VERSION }, r));
        const have = new Map();
        for await (const page of pb.pages(DIM, { fields: '*' })) for (const r of page) have.set(r.id, r);
        const same = (a, b) => Object.keys(a).every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
        const reqs = [];
        for (const r of want) {
            const ex = have.get(r.id);
            if (!ex) reqs.push({ method: 'POST', url: `/api/collections/${DIM}/records`, body: r });
            else if (!same(r, ex)) reqs.push({ method: 'PATCH', url: `/api/collections/${DIM}/records/${r.id}`, body: r });
            have.delete(r.id);
        }
        for (const id of have.keys()) reqs.push({ method: 'DELETE', url: `/api/collections/${DIM}/records/${id}` });
        if (reqs.length) {
            await pb.batch(reqs);
            log(`dim_offices: ${reqs.length} office rows written (${VERSION})`);
        }
        return { written: reqs.length };
    } catch (err) {
        log('dim_offices not written: ' + errMessage(err));
        return { error: errMessage(err) };
    }
}

module.exports = { VERSION, prepare, syncDim };
