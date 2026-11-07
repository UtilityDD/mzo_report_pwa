'use strict';
// Admin → Data quality (server only, never loaded in the browser): GET /api/admin/data-quality (admin only).
//
// Reads quality.json, which vm/sync/quality.js writes next to the snapshots after each sync run
// (docs/data-quality.md, "Admin → Data quality"), and joins it with the Sources tab's report list
// (lib/sources_info.js) so each dataset names the menu reports that read it. Read-only; no network
// except what the Sources payload itself reads (PocketBase GETs, cached 60 s).
//
// Answer: { status, generatedAt, available, reason, summary, lastRun, datasets: [ { key, label, reports, pages,
//   checkedAt, rows, asOn, held, worst, counts, findings: [...] } ], held: [...] }.
// Without a quality.json (Vercel, a local checkout without snapshots) available is false and the lists are empty.

const fs = require('fs');
const path = require('path');

const SEV_RANK = { critical: 3, warning: 2, info: 1 };

function isAdmin(user) {
    if (!user) return false;
    if (user.isAdmin === true) return true;
    return String(user.role || user.Role || '').trim().toLowerCase() === 'admin';
}

/** quality.json → the API body (pure; tests call it directly). */
function aggregate(q, sources, now) {
    const body = {
        status: 'success',
        generatedAt: new Date(now || Date.now()).toISOString(),
        available: !!q,
        reason: q ? '' : 'No data quality results on this server yet (they are written by the VM sync after each run).',
        qualityAt: q ? q.generatedAt || null : null,
        summary: { critical: 0, warning: 0, info: 0, datasets: 0, held: 0, checked: 0, lastRun: null },
        lastRun: q ? q.lastRun || null : null,
        datasets: [],
        held: [],
        reports: []
    };
    if (!q) return body;
    const reportsByKey = {};
    const srcByKey = {};
    ((sources && sources.datasets) || []).forEach((d) => { srcByKey[d.key] = d; });
    ((sources && sources.reports) || []).forEach((r) => {
        (r.sources || []).forEach((k) => { (reportsByKey[k] = reportsByKey[k] || []).push({ id: r.id, label: r.label, page: r.page, group: r.group }); });
    });
    const byDataset = new Map();
    for (const f of q.findings || []) {
        if (!byDataset.has(f.dataset)) byDataset.set(f.dataset, []);
        byDataset.get(f.dataset).push(f);
    }
    const heldKeys = new Set((q.held || []).map((h) => h.dataset));
    for (const [key, list] of byDataset) {
        const ds = (q.datasets || {})[key] || {};
        const src = srcByKey[key] || {};
        const counts = { critical: 0, warning: 0, info: 0 };
        list.forEach((f) => { counts[f.severity] = (counts[f.severity] || 0) + 1; });
        list.sort((a, b) => (SEV_RANK[b.severity] - SEV_RANK[a.severity]) || (b.count - a.count));
        body.datasets.push({
            key,
            label: ds.label || src.label || key,
            group: src.group || '',
            reports: reportsByKey[key] || [],
            pages: src.pages || [],
            sourceStatus: src.status || '',
            checkedAt: ds.checkedAt || null,
            rows: ds.rows == null ? null : ds.rows,
            asOn: ds.asOn || null,
            maxAgeDays: ds.maxAgeDays == null ? null : ds.maxAgeDays,
            error: ds.error || '',
            held: heldKeys.has(key),
            worst: list[0] ? list[0].severity : 'info',
            counts,
            findings: list.map((f) => ({
                id: f.id, check: f.check, column: f.column || '', severity: f.severity, count: f.count, total: f.total,
                examples: (f.examples || []).slice(0, 3), message: f.message, fix: f.fix, firstSeen: f.firstSeen, lastSeen: f.lastSeen
            }))
        });
    }
    body.datasets.sort((a, b) => (SEV_RANK[b.worst] - SEV_RANK[a.worst]) || (b.counts.critical - a.counts.critical) || (b.counts.warning - a.counts.warning) || a.label.localeCompare(b.label));
    body.held = (q.held || []).map((h) => ({ dataset: h.dataset, label: ((q.datasets || {})[h.dataset] || {}).label || h.dataset, since: h.since, lastTry: h.lastTry,
        attempts: h.attempts, reason: h.reason, rows: h.rows, prevRows: h.prevRows, lost: h.lost || [] }));
    const s = q.summary || {};
    body.summary = {
        critical: s.critical || 0, warning: s.warning || 0, info: s.info || 0, datasets: s.datasets || 0,
        held: body.held.length, checked: s.checked || 0, lastRun: q.lastRun ? q.lastRun.finishedAt : q.generatedAt || null
    };
    // Report filter: every menu report with at least one finding.
    const seen = new Map();
    body.datasets.forEach((d) => d.reports.forEach((r) => { if (!seen.has(r.page)) seen.set(r.page, { label: r.label, page: r.page, group: r.group, datasets: 0 }); seen.get(r.page).datasets++; }));
    body.reports = [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
    return body;
}

function create(options) {
    const opts = options || {};
    const env = opts.env || process.env;
    const mirror = opts.mirror || null;
    const sources = opts.sources || null; // lib/sources_info.js instance (its cached payload)
    const log = opts.log || console;
    let cache = { file: '', mtime: 0, size: 0, data: null };

    function file() {
        if (env.MZO_QUALITY_FILE) return path.resolve(env.MZO_QUALITY_FILE);
        if (mirror && mirror.dir) return path.join(mirror.dir, 'quality.json');
        return '';
    }

    function readQuality() {
        const f = file();
        if (!f) return null;
        let st;
        try { st = fs.statSync(f); } catch (_) { return null; }
        if (cache.file === f && cache.mtime === st.mtimeMs && cache.size === st.size) return cache.data;
        try {
            const data = JSON.parse(fs.readFileSync(f, 'utf8'));
            cache = { file: f, mtime: st.mtimeMs, size: st.size, data };
            return data;
        } catch (err) {
            log.warn('[DataQuality] could not read', f + ':', err.message);
            return null;
        }
    }

    async function handler(req, res) {
        if (!req.user) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
        if (!isAdmin(req.user)) return res.status(403).json({ status: 'error', message: 'Forbidden: Admin access required.' });
        try {
            let src = null;
            if (sources && typeof sources.cached === 'function') {
                try { src = await sources.cached(false); } catch (err) { log.warn('[DataQuality] sources unavailable:', err.message); }
            }
            const body = aggregate(readQuality(), src);
            res.setHeader('Cache-Control', 'private, no-store');
            return res.json(body);
        } catch (err) {
            log.error('[DataQuality] failed:', err.message);
            return res.status(500).json({ status: 'error', message: 'Data quality unavailable.' });
        }
    }

    return { handler, readQuality, file };
}

module.exports = { create, aggregate, isAdmin };
