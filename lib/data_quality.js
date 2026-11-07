'use strict';
// Admin → Data quality (server only, never loaded in the browser): GET /api/admin/data-quality (admin only).
//
// Reads quality.json, which vm/sync/quality.js writes next to the snapshots after each sync run
// (docs/data-quality.md, "Admin → Data quality"), and joins it with the Sources tab's report list
// (lib/sources_info.js) so each dataset names the menu reports that read it. Read-only; no network
// except what the Sources payload itself reads (PocketBase GETs, cached 60 s).
//
// Answer: { status, generatedAt, available, reason, summary, lastRun, datasets: [ { key, label, reports, pages,
//   checkedAt, rows, asOn, held, worst, counts, findings: [...] } ], held: [...], audit }.
// Without a quality.json (Vercel, a local checkout without snapshots) available is false and the lists are empty.
//
// audit: the curated findings of the 6 Nov 2026 data audit (lib/quality/audit_findings.json, kept by hand;
// docs/data-quality.md, "Audit findings"), each with the live state of its matching automatic check from
// quality.json (still detected, count now, first / last seen). Also on its own: GET /api/admin/data-quality/audit.

const fs = require('fs');
const path = require('path');

const SEV_RANK = { critical: 3, warning: 2, info: 1 };
const AUDIT_FILE = path.join(__dirname, 'quality', 'audit_findings.json');
const AUDIT_STATUS = ['open', 'mitigated', 'monitoring', 'fixed'];
const AUDIT_SEV = ['critical', 'high', 'medium', 'low'];
const AUDIT_OWNER = ['source sheet', 'app', 'sync'];

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

const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x).trim()).filter(Boolean);

/**
 * The live state of one audit finding's automatic check in quality.json.
 * state: 'detected' (a matching finding now), 'clear' (its datasets were checked and nothing matched),
 * 'not_checked' (none of its datasets has been checked yet), 'unavailable' (no quality.json on this server).
 */
function liveState(item, q) {
    const checks = asList(item.auto_check);
    if (!checks.length) return null;
    const datasets = asList(item.auto_datasets).length ? asList(item.auto_datasets) : asList(item.datasets);
    const columns = asList(item.auto_columns);
    const byDs = item.auto_count === 'datasets';
    const live = { checks, datasets, columns, state: 'unavailable', count: null, unit: item.auto_unit || (byDs ? 'dataset|datasets' : 'row|rows'),
        countBy: byDs ? 'datasets' : 'sum', matches: [], firstSeen: null, lastSeen: null, checkedAt: null, resolvedAt: null };
    if (!q) return live;
    const ds = q.datasets || {};
    const wantDs = new Set(datasets);
    const match = (dataset, check, column) => (!datasets.length || wantDs.has(dataset)) && checks.includes(check) &&
        (!columns.length || columns.includes(column || ''));
    for (const f of q.findings || []) {
        if (!match(f.dataset, f.check, f.column)) continue;
        live.matches.push({ dataset: f.dataset, label: (ds[f.dataset] || {}).label || f.dataset, check: f.check, column: f.column || '',
            severity: f.severity, count: f.count, total: f.total, firstSeen: f.firstSeen || null, lastSeen: f.lastSeen || null });
    }
    const maxIso = (list) => list.filter(Boolean).sort().pop() || null;
    const minIso = (list) => list.filter(Boolean).sort().shift() || null;
    const checked = (datasets.length ? datasets : Object.keys(ds)).map((k) => (ds[k] || {}).checkedAt).filter(Boolean);
    live.checkedAt = maxIso(checked);
    if (live.matches.length) {
        live.state = 'detected';
        live.count = byDs ? new Set(live.matches.map((m) => m.dataset)).size
            : Math.round(live.matches.reduce((a, m) => a + (Number(m.count) || 0), 0) * 100) / 100;
        live.firstSeen = minIso(live.matches.map((m) => m.firstSeen));
        live.lastSeen = maxIso(live.matches.map((m) => m.lastSeen));
        live.matches.sort((a, b) => ((SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0)) || (b.count - a.count));
        return live;
    }
    live.count = 0;
    live.state = checked.length ? 'clear' : 'not_checked';
    // Ids of resolved findings are "<dataset>|<check>|<column>" (vm/sync/lib/quality/store.js).
    const gone = Object.entries(q.resolved || {}).filter(([id]) => { const [d, c, col] = id.split('|'); return match(d, c, col); });
    if (gone.length) {
        live.resolvedAt = maxIso(gone.map(([, r]) => r.resolvedAt));
        live.firstSeen = minIso(gone.map(([, r]) => r.firstSeen));
    }
    return live;
}

/** The audit findings file -> the API's audit block, with live states from quality.json (pure; tests call it). */
function auditView(file, q) {
    const out = { available: !!file, reason: '', audit: '', audited: null, updated: null, summary: null, reports: [], findings: [] };
    if (!file) { out.reason = 'The audit findings file (lib/quality/audit_findings.json) is missing or unreadable.'; return out; }
    out.audit = file.audit || '';
    out.audited = file.audited || null;
    out.updated = file.updated || null;
    const summary = { total: 0, status: {}, severity: {}, owner: {}, detected: 0 };
    AUDIT_STATUS.forEach((st) => { summary.status[st] = 0; });
    AUDIT_SEV.forEach((v) => { summary.severity[v] = {}; AUDIT_STATUS.forEach((st) => { summary.severity[v][st] = 0; }); });
    AUDIT_OWNER.forEach((o) => { summary.owner[o] = 0; });
    const reports = new Map();
    for (const raw of file.findings || []) {
        if (!raw || !raw.id) continue;
        const status = AUDIT_STATUS.includes(raw.status) ? raw.status : 'open';
        const severity = AUDIT_SEV.includes(raw.severity) ? raw.severity : 'medium';
        const owner = AUDIT_OWNER.includes(raw.owner) ? raw.owner : 'app';
        const item = {
            id: String(raw.id), title: raw.title || String(raw.id),
            reports: (raw.reports || []).map((r) => ({ label: r.label || r.page || '', page: r.page || '' })),
            datasets: asList(raw.datasets), severity, found: raw.found || out.audited, summary: raw.summary || '', evidence: raw.evidence || '',
            impact: raw.impact || '', cause: raw.cause || '', owner, fix: raw.fix || '', status, statusNote: raw.status_note || '',
            fixedIn: raw.fixed_in || '', autoCheck: asList(raw.auto_check), live: liveState(raw, q)
        };
        out.findings.push(item);
        summary.total++;
        summary.status[status]++;
        summary.severity[severity][status]++;
        summary.owner[owner]++;
        if (item.live && item.live.state === 'detected') summary.detected++;
        item.reports.forEach((r) => {
            const k = r.page || r.label;
            if (!reports.has(k)) reports.set(k, { label: r.label, page: r.page, findings: 0 });
            reports.get(k).findings++;
        });
    }
    out.summary = summary;
    out.reports = [...reports.values()].sort((a, b) => a.label.localeCompare(b.label));
    return out;
}

function create(options) {
    const opts = options || {};
    const env = opts.env || process.env;
    const mirror = opts.mirror || null;
    const sources = opts.sources || null; // lib/sources_info.js instance (its cached payload)
    const log = opts.log || console;
    let cache = { file: '', mtime: 0, size: 0, data: null };
    let auditCache = { file: '', mtime: 0, size: 0, data: null };
    const auditFile = opts.auditFile || AUDIT_FILE;

    function readAudit() {
        let st;
        try { st = fs.statSync(auditFile); } catch (_) { return null; }
        if (auditCache.file === auditFile && auditCache.mtime === st.mtimeMs && auditCache.size === st.size) return auditCache.data;
        try {
            const data = JSON.parse(fs.readFileSync(auditFile, 'utf8'));
            auditCache = { file: auditFile, mtime: st.mtimeMs, size: st.size, data };
            return data;
        } catch (err) {
            log.warn('[DataQuality] could not read', auditFile + ':', err.message);
            return null;
        }
    }

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

    function gate(req, res) {
        if (!req.user) { res.status(401).json({ status: 'error', message: 'Unauthorized' }); return false; }
        if (!isAdmin(req.user)) { res.status(403).json({ status: 'error', message: 'Forbidden: Admin access required.' }); return false; }
        return true;
    }

    async function handler(req, res) {
        if (!gate(req, res)) return undefined;
        try {
            let src = null;
            if (sources && typeof sources.cached === 'function') {
                try { src = await sources.cached(false); } catch (err) { log.warn('[DataQuality] sources unavailable:', err.message); }
            }
            const q = readQuality();
            const body = aggregate(q, src);
            body.audit = auditView(readAudit(), q);
            res.setHeader('Cache-Control', 'private, no-store');
            return res.json(body);
        } catch (err) {
            log.error('[DataQuality] failed:', err.message);
            return res.status(500).json({ status: 'error', message: 'Data quality unavailable.' });
        }
    }

    // GET /api/admin/data-quality/audit: the audit block on its own.
    async function auditHandler(req, res) {
        if (!gate(req, res)) return undefined;
        try {
            const q = readQuality();
            const body = Object.assign({ status: 'success', generatedAt: new Date().toISOString(), qualityAvailable: !!q, qualityAt: q ? q.generatedAt || null : null },
                auditView(readAudit(), q));
            res.setHeader('Cache-Control', 'private, no-store');
            return res.json(body);
        } catch (err) {
            log.error('[DataQuality] audit failed:', err.message);
            return res.status(500).json({ status: 'error', message: 'Audit findings unavailable.' });
        }
    }

    return { handler, auditHandler, readQuality, readAudit, file };
}

module.exports = { create, aggregate, auditView, liveState, isAdmin, AUDIT_FILE };
