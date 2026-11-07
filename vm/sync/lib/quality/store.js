'use strict';
// quality.json: the latest data quality results next to the snapshots (docs/data-quality.md, "Admin → Data quality").
//
// {
//   format: 'mzo-quality/1', generatedAt, code,
//   lastRun: { startedAt, finishedAt, ms, checked: [key], failed: [{ key, error }], peakRssMb },
//   summary: { critical, warning, info, datasets (with a critical or warning finding), checked (datasets known), held },
//   datasets: { <key>: { label, version, checkedAt, rows, columns, asOn, maxAgeDays, personal, layout, ms, error,
//                        baseline: { rows, columns, filled, nonZero, version }, pending } },
//   findings: [ { id, dataset, check, column, severity, count, total, examples, message, fix, firstSeen, lastSeen, ... } ],
//   held: [ { dataset, since, lastTry, attempts, reason, rows, prevRows, lost } ],
//   resolved: { <id>: { firstSeen, resolvedAt } }   (14 days, so an issue that comes back keeps its age)
// }
// Findings of a dataset are replaced when it is checked again; an issue that is no longer found disappears.

const fs = require('fs');
const path = require('path');

const FORMAT = 'mzo-quality/1';
const FILE = 'quality.json';
const DAY = 86400000;
const RESOLVED_KEEP_MS = 14 * DAY;
const SEV_RANK = { critical: 3, warning: 2, info: 1 };

function empty() {
    return { format: FORMAT, generatedAt: null, code: '', lastRun: null, summary: null, datasets: {}, findings: [], held: [], resolved: {} };
}

function read(dir, file) {
    try {
        const v = JSON.parse(fs.readFileSync(file || path.join(dir, FILE), 'utf8'));
        if (!v || v.format !== FORMAT) return empty();
        return Object.assign(empty(), v);
    } catch (_) {
        return empty();
    }
}

function write(dir, state, file) {
    const final = file || path.join(dir, FILE);
    const tmp = path.join(path.dirname(final), `.${path.basename(final)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, final);
}

const fmt = (n) => Number(n).toLocaleString('en-IN');

/** source.stale for a dataset's "as on" date, judged now. */
function staleFinding(key, asOn, maxAgeDays, now) {
    if (!asOn || !asOn.date || !maxAgeDays) return null;
    const age = Math.floor((now - Date.parse(asOn.date + 'T00:00:00+05:30')) / DAY);
    if (!(age > maxAgeDays)) return null;
    const months = age >= 60 ? ` (about ${Math.round(age / 30.4)} months)` : '';
    return {
        dataset: key, check: 'source.stale', column: asOn.column, severity: age > Math.max(3 * maxAgeDays, 90) ? 'critical' : 'warning',
        count: age, total: maxAgeDays, examples: [asOn.date],
        message: `The newest ${asOn.column} in the data is ${asOn.date}, ${fmt(age)} days ago${months}; this report is normally refreshed within ${maxAgeDays} days. The copy is current; the source itself is old.`,
        fix: 'Ask the sheet owner to paste or upload the latest report. Sources shows when the VM last copied it.',
        asOn: asOn.date
    };
}

function heldFinding(key, h) {
    return {
        dataset: key, check: 'copy.held', column: '', severity: 'critical', count: h.rows || 0, total: h.prevRows || 0, examples: [],
        message: `Held: new copy looks incomplete (${h.reason}). The site keeps serving the previous good copy; the sync reads the source again on every run (${h.attempts || 1} attempt${(h.attempts || 1) > 1 ? 's' : ''} since ${String(h.since || '').slice(0, 16).replace('T', ' ')} UTC).`,
        fix: 'Check whether an upload to this sheet is still running or was cut short, and finish it. If the smaller copy is correct, it is accepted automatically after 24 hours, or at once with `node vm/sync/run.js --only <key> --force` on the VM.',
        since: h.since
    };
}

/**
 * Fold one run into the state.
 * @param {object} state  previous quality.json (read())
 * @param {object} o
 *   results   { <key>: checkDataset() result, or { error } }
 *   manifest  manifest.json datasets
 *   held      quality-held.json contents
 *   maxAge    (key, result) → max age in days or null
 *   now, code, startedAt, peakRssMb
 */
function merge(state, o) {
    const now = o.now || Date.now();
    const nowIso = new Date(now).toISOString();
    const next = empty();
    next.code = o.code || state.code || '';
    next.generatedAt = nowIso;
    const manifest = o.manifest || {};
    const results = o.results || {};
    const prevFindings = new Map((state.findings || []).map((f) => [f.id, f]));
    const resolved = Object.assign({}, state.resolved || {});
    const out = [];
    const failed = [];

    for (const key of Object.keys(manifest).sort()) {
        const e = manifest[key] || {};
        if (e.sensitive) continue;
        const old = (state.datasets || {})[key] || null;
        const res = results[key];
        let ds;
        let data;
        if (res && !res.error) {
            const drop = res.findings.find((f) => f.check === 'rows.drop' || f.check === 'rows.empty');
            let baseline = Object.assign({ version: e.version }, res.baseline);
            let pending = null;
            if (drop && old && old.baseline) {
                const p = old.pending;
                if (p && p.version !== e.version && Math.abs(res.rows - p.rows) <= 0.2 * Math.max(1, p.rows)) {
                    // The second copy in a row at the lower level: the drop is real, the new copy becomes the baseline.
                    drop.severity = 'info';
                    drop.message += ' The next copy had about as many rows, so the drop looks intended.';
                } else {
                    baseline = old.baseline;
                    pending = { rows: res.rows, version: e.version };
                }
            }
            ds = {
                label: e.label || key, version: e.version, checkedAt: nowIso, rows: res.rows, columns: res.columns.length,
                asOn: res.asOn || null, personal: !!res.personal, layout: !!res.layout, ms: res.ms, error: '', baseline, pending
            };
            data = res.findings;
        } else {
            if (res && res.error) failed.push({ key, error: String(res.error).slice(0, 300) });
            ds = old ? Object.assign({}, old, { label: e.label || old.label || key }) : { label: e.label || key, version: null, checkedAt: null, rows: e.rows || null, columns: null, asOn: null, baseline: null, pending: null };
            if (res && res.error) ds.error = String(res.error).slice(0, 300);
            data = (state.findings || []).filter((f) => f.dataset === key && f.check !== 'source.stale' && f.check !== 'copy.held');
        }
        ds.maxAgeDays = o.maxAge ? o.maxAge(key, ds) : null;
        next.datasets[key] = ds;
        const stale = staleFinding(key, ds.asOn, ds.maxAgeDays, now);
        if (stale) data = data.concat([stale]);
        const h = (o.held || {})[key];
        if (h) data = data.concat([heldFinding(key, h)]);
        for (const f of data) out.push(Object.assign({}, f, { dataset: key }));
    }
    // Held datasets that are not in the manifest (a source held before it ever had a snapshot).
    for (const key of Object.keys(o.held || {})) {
        if (next.datasets[key]) continue;
        next.datasets[key] = { label: key, version: null, checkedAt: null, rows: null, columns: null, asOn: null, baseline: null, pending: null };
        out.push(heldFinding(key, o.held[key]));
    }

    const seen = new Set();
    next.findings = [];
    for (const f of out) {
        const id = f.id || `${f.dataset}|${f.check}|${f.column || ''}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const before = prevFindings.get(id);
        const back = resolved[id];
        const firstSeen = (before && before.firstSeen) || (back && back.firstSeen) || nowIso;
        if (back) delete resolved[id];
        next.findings.push(Object.assign({}, f, { id, firstSeen, lastSeen: nowIso }));
    }
    for (const [id, f] of prevFindings) {
        if (!seen.has(id)) resolved[id] = { firstSeen: f.firstSeen, resolvedAt: nowIso };
    }
    for (const id of Object.keys(resolved)) if (now - Date.parse(resolved[id].resolvedAt) > RESOLVED_KEEP_MS) delete resolved[id];
    next.resolved = resolved;
    next.findings.sort((a, b) => (SEV_RANK[b.severity] - SEV_RANK[a.severity]) || a.dataset.localeCompare(b.dataset) || a.check.localeCompare(b.check));

    next.held = Object.keys(o.held || {}).sort().map((k) => { const h = Object.assign({ dataset: k }, o.held[k]); delete h.hash; delete h.hashSince; return h; });
    next.summary = summarize(next);
    next.lastRun = {
        startedAt: o.startedAt ? new Date(o.startedAt).toISOString() : nowIso,
        finishedAt: nowIso,
        ms: o.startedAt ? now - o.startedAt : 0,
        checked: Object.keys(results).filter((k) => results[k] && !results[k].error).sort(),
        failed,
        peakRssMb: o.peakRssMb || null
    };
    return next;
}

function summarize(state) {
    const s = { critical: 0, warning: 0, info: 0, datasets: 0, checked: 0, held: (state.held || []).length };
    const affected = new Set();
    for (const f of state.findings || []) {
        s[f.severity] = (s[f.severity] || 0) + 1;
        if (f.severity !== 'info') affected.add(f.dataset);
    }
    s.datasets = affected.size;
    s.checked = Object.values(state.datasets || {}).filter((d) => d.checkedAt).length;
    return s;
}

module.exports = { read, write, merge, summarize, staleFinding, heldFinding, empty, FILE, FORMAT };
