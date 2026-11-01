'use strict';
// sys_quality_issues and sys_quality_scores in PocketBase.
//
// One record per (dataset, check, column), id derived from those three, so a re-run updates the
// same record: first_seen stays, last_seen moves, count and sample are replaced. Issues of an
// evaluated family that did not come back are marked resolved (kept for history). Issues of
// families that were not evaluated this time (e.g. a cross check whose partner was unavailable)
// are left alone.

const crypto = require('crypto');
const { score } = require('./score');
const { sanitizeSample } = require('./mask');

const ISSUES = 'sys_quality_issues';
const SCORES = 'sys_quality_scores';
const FIELDS = ['dataset', 'check', 'severity', 'column', 'count', 'sample', 'first_seen', 'last_seen', 'status', 'source_fix', 'hint'];

// Same scheme as vm/sync/lib/util.js recordId: 15 characters of [a-z0-9] from a sha1.
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function recordId(text) {
    const b = crypto.createHash('sha1').update(String(text)).digest();
    let out = '';
    for (let i = 0; i < 15; i++) out += ID_ALPHABET[b[i] % 36];
    return out;
}

function pbDate(d) {
    return (d instanceof Date ? d : new Date(d)).toISOString().replace('T', ' ');
}

function issueId(dataset, check, column) {
    return recordId(`${ISSUES}:${dataset}|${check}|${column || ''}`);
}

function clean(issue) {
    const out = {};
    for (const f of FIELDS) if (issue[f] !== undefined) out[f] = issue[f];
    out.column = String(out.column || '').slice(0, 500);
    out.hint = String(out.hint || '').slice(0, 2000);
    out.count = Math.round(Number(out.count) || 0);
    out.source_fix = !!out.source_fix;
    let sample = Array.isArray(issue.sample) ? issue.sample.slice(0, 10) : [];
    if (issue.other_dataset) sample = sample.concat([{ compared_with: issue.other_dataset }]).slice(0, 11);
    out.sample = sanitizeSample(sample, out.column);
    return out;
}

async function listExisting(pb, dataset) {
    const out = [];
    for (let page = 1; ; page++) {
        const res = await pb.listRecords(ISSUES, { page, perPage: 500, skipTotal: 1, filter: `dataset = "${String(dataset).replace(/"/g, '')}"` });
        const items = (res && res.items) || [];
        out.push(...items);
        if (items.length < 500) return out;
    }
}

async function writeAll(pb, requests) {
    if (!requests.length) return;
    for (let i = 0; i < requests.length; i += 100) {
        const chunk = requests.slice(i, i + 100);
        try {
            await pb.batch(chunk.map((r) => ({ method: r.method, url: r.url, body: r.body })));
        } catch (err) {
            // Batch API off or PUT not supported: one request at a time.
            for (const r of chunk) {
                if (r.method === 'PUT') await pb.upsertRecord(r.collection, r.body.id, Object.assign({}, r.body, { id: undefined }));
                else await pb.updateRecord(r.collection, r.id, r.body);
            }
        }
    }
}

/**
 * Save the issues of one dataset and its score.
 * @param {object} pb vm/sync PocketBase client (superuser)
 * @param {string} dataset key
 * @param {object[]} issues found this run (all for this dataset)
 * @param {{ families: (check: string) => boolean, rows: number, now?: Date }} opts
 *   families(check) is true for every check id that was evaluated in this run
 * @returns {Promise<{score:number, open:number, opened:number, resolved:number}>}
 */
async function saveDataset(pb, dataset, issues, opts) {
    const now = pbDate(opts.now || new Date());
    const existing = await listExisting(pb, dataset);
    const byId = new Map(existing.map((r) => [r.id, r]));
    const seen = new Set();
    const requests = [];
    let opened = 0;
    for (const raw of issues) {
        const issue = clean(Object.assign({ dataset }, raw));
        const id = issueId(dataset, issue.check, issue.column);
        if (seen.has(id)) continue; // same check and column twice: keep the first
        seen.add(id);
        const old = byId.get(id);
        if (!old || old.status !== 'open') opened++;
        const body = Object.assign(issue, {
            id,
            status: 'open',
            first_seen: old && old.first_seen ? old.first_seen : now,
            last_seen: now
        });
        requests.push({ method: 'PUT', url: `/api/collections/${ISSUES}/records`, collection: ISSUES, body });
    }
    let resolved = 0;
    const stillOpen = [];
    for (const r of existing) {
        if (seen.has(r.id) || r.status !== 'open') continue;
        if (opts.families(r.check)) {
            resolved++;
            requests.push({ method: 'PATCH', url: `/api/collections/${ISSUES}/records/${r.id}`, collection: ISSUES, id: r.id, body: { status: 'resolved' } });
        } else {
            stillOpen.push(r);
        }
    }
    await writeAll(pb, requests);
    const open = issues.concat(stillOpen);
    const sc = score(open, opts.rows || 0);
    await writeAll(pb, [{
        method: 'PUT', url: `/api/collections/${SCORES}/records`, collection: SCORES,
        body: { id: recordId(`${SCORES}:${dataset}`), dataset, score: sc, issues_open: seen.size + stillOpen.length, checked_at: now }
    }]);
    return { score: sc, open: seen.size + stillOpen.length, opened, resolved };
}

module.exports = { saveDataset, issueId, recordId, ISSUES, SCORES };
