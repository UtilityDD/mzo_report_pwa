'use strict';
// Sync one source: version check → spool (download + hash + column stats) → skip if unchanged →
// infer types → create/alter ds_<key> → diff-upsert rows → registry row + run log.
// Every failure stays inside this source: the caller moves on to the next one.

const { collectionName } = require('./normalise');
const { spool, removeFile } = require('./spool');
const { buildColumns, fieldList } = require('./schema');
const { ensureCollection } = require('./collections');
const { writeRows } = require('./upsert');
const officeEnrich = require('./office_enrich'); // dq-offices: canonical _region/_division/_ccc_code/_ccc
const { makeSourceFetch } = require('./http');
const { parsePbDate } = require('./schedule');
const { removeSnapshot } = require('./snapshot');
const { stableStringify, pbDate, fmtMs, log, errMessage, SkipError } = require('./util');
const fs = require('fs');
const path = require('path');

// SYNC_DEBUG=1 logs each phase with its time and memory.
const DEBUG = process.env.SYNC_DEBUG === '1';
function phase(key, what, t0) {
    if (!DEBUG) return;
    const m = process.memoryUsage();
    log(`[${key}] ${what} at ${fmtMs(Date.now() - t0)}: rss ${Math.round(m.rss / 1048576)} MB, heap ${Math.round(m.heapUsed / 1048576)} MB`);
}

// Bump when type inference or row hashing changes: every source is then re-read in full once.
const LOGIC_VERSION = 'mzo-sync/1';
const DEFAULT_TIMEOUT_MS = { frequent: 4 * 60000, hourly: 10 * 60000, daily: 30 * 60000 };
const DEFAULT_MAX_SKIP_HOURS = 24;

function registryMeta(src) {
    return {
        label: src.label || src.key,
        group: src.group || '',
        pages: Array.isArray(src.pages) ? src.pages : [],
        source_type: src.sourceType || 'other',
        source_ref: src.sourceRef || null,
        source_url: src.sourceUrl || '',
        collection: collectionName(src.key),
        primary_key: src.primaryKey && src.primaryKey.length ? src.primaryKey : null,
        schedule: src.schedule || 'hourly',
        notes: src.notes || ''
    };
}

/** Does this source get a raw snapshot? Only sources with raw(), never sensitive ones. */
function wantsSnapshot(src, snapshotDir) {
    return !!(snapshotDir && !src.sensitive && typeof src.raw === 'function');
}

/**
 * @param {object} src source adapter
 * @param {{pb, registry, tmpDir, batchSize, dryRun, force, snapshotDir, fullCheck, reason, onSnapshot}} env
 *   fullCheck: ignore the cheap version check (always download; unchanged content still skips the writes)
 * @returns {Promise<object>} summary { key, status, rows, columns, inserted, updated, deleted, ms, message, types }
 */
async function syncSource(src, env) {
    const { pb, registry, tmpDir, batchSize, dryRun, force, snapshotDir, fullCheck, reason, onSnapshot } = env;
    const key = src.key;
    const collection = collectionName(key);
    const started = new Date();
    const t0 = Date.now();
    const ds = registry ? registry.get(key) : null;
    const meta = registryMeta(src);
    const summary = { key, status: 'error', rows: 0, columns: 0, inserted: 0, updated: 0, deleted: 0, ms: 0, message: '' };
    const timeoutMs = src.timeoutMs || DEFAULT_TIMEOUT_MS[meta.schedule] || DEFAULT_TIMEOUT_MS.hourly;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`source timed out after ${fmtMs(timeoutMs)}`)), timeoutMs);
    const ctx = {
        fetch: makeSourceFetch({ signal: ac.signal }),
        log: (m) => log(`[${key}]`, m),
        env: process.env,
        limits: { maxRowsPerBatch: batchSize },
        signal: ac.signal
    };
    let sp = null;
    let version = null;
    let snapFields = {};
    const reg = {}; // registry fields to write
    const wantSnap = wantsSnapshot(src, snapshotDir);

    const finish = async (status, message, extra) => {
        summary.status = status;
        summary.message = reason ? `[${reason}] ${message}` : message;
        message = summary.message;
        summary.ms = Date.now() - t0;
        if (dryRun || !registry) return summary;
        const now = new Date();
        Object.assign(reg, meta, {
            last_status: status,
            last_checked_at: pbDate(now),
            last_duration_ms: summary.ms,
            last_error: status === 'error' || status === 'skipped' ? message : ''
        }, extra || {});
        try {
            await registry.save(key, reg);
        } catch (err) {
            log(`[${key}] could not write sys_datasets: ${errMessage(err)}`);
        }
        try {
            await registry.logRun({
                dataset: key,
                started_at: started,
                finished_at: now,
                status,
                rows_total: summary.rows,
                rows_inserted: summary.inserted,
                rows_updated: summary.updated,
                rows_deleted: summary.deleted,
                duration_ms: summary.ms,
                message
            });
        } catch (err) {
            log(`[${key}] could not write sys_sync_runs: ${errMessage(err)}`);
        }
        return summary;
    };

    try {
        // A sensitive source must never leave a snapshot behind (e.g. one marked sensitive later).
        if (src.sensitive && snapshotDir && ds && ds.snapshot_file && !dryRun) {
            removeSnapshot(snapshotDir, ds.snapshot_file);
            snapFields = { snapshot_file: '', snapshot_sha1: '', snapshot_bytes: 0, snapshot_at: '' };
            if (onSnapshot) onSnapshot(key);
        }
        if (src.skip) throw new SkipError(String(src.skip));

        if (typeof src.version === 'function') {
            try {
                const v = await src.version(ctx);
                version = v === null || v === undefined || v === '' ? null : String(v);
            } catch (err) {
                if (err instanceof SkipError) throw err;
                ctx.log(`version check failed, reading the full source: ${errMessage(err)}`);
            }
        }

        const collExists = !dryRun && !!(await pb.getCollection(collection));
        const healthy = !!(ds && collExists && (ds.last_status === 'ok' || ds.last_status === 'unchanged'));
        const fetchedAt = ds ? parsePbDate(ds.last_fetched_at) : NaN;
        const maxSkipMs = (src.maxSkipHours || DEFAULT_MAX_SKIP_HOURS) * 3600000;
        const fetchedRecently = Number.isFinite(fetchedAt) && Date.now() - fetchedAt < maxSkipMs;
        const snapshotReady = !wantSnap || !!(ds && ds.snapshot_sha1 && ds.snapshot_file &&
            fs.existsSync(path.join(snapshotDir, ds.snapshot_file)));
        if (!force && !fullCheck && healthy && snapshotReady && version && ds.last_version === version && fetchedRecently) {
            summary.rows = ds.row_count || 0;
            summary.columns = ds.column_count || 0;
            return await finish('unchanged', `version unchanged (${version.slice(0, 40)})`, snapFields);
        }

        const salt = LOGIC_VERSION + stableStringify({
            offices: officeEnrich.VERSION, // a new office list rewrites the office fields
            pk: src.primaryKey || null,
            types: src.columnTypes || null,
            order: src.dateOrder || null
        });
        sp = await spool(src, ctx, { tmpDir, salt, snapshotDir: wantSnap && !dryRun ? snapshotDir : null });
        phase(key, `spooled ${sp.rows} rows`, t0);
        const fetchedNow = pbDate(new Date());
        const lastVersion = version || 'sha1:' + sp.hash;
        summary.rows = sp.rows;
        const modified = sp.modifiedAt ? new Date(sp.modifiedAt) : null;
        if (modified && Number.isFinite(modified.getTime())) snapFields.source_modified_at = pbDate(modified);

        const { columns, registryColumns, warnings } = buildColumns(sp.columns, src);
        summary.columns = registryColumns.length;
        summary.types = registryColumns.map((c) => `${c.name}:${c.type}${c.date_order === 'mdy' ? '(m/d)' : ''}`);

        if (dryRun) {
            return await finish('ok', `dry run: ${sp.rows} rows, ${registryColumns.length} columns` +
                (warnings.length ? '; ' + warnings.join('; ') : ''));
        }
        if (sp.rows === 0 && ds && ds.row_count > 0 && !src.allowEmpty) {
            throw new Error(`source returned no rows (had ${ds.row_count}); kept the previous copy`);
        }
        if (!registryColumns.length && sp.rows > 0) throw new Error('source has rows but no columns');

        // The snapshot goes live before the database work: the app's copy does not wait on it.
        if (sp.snapshot) {
            try {
                const snap = await sp.snapshot.publish(ds && ds.snapshot_sha1);
                Object.assign(snapFields, { snapshot_file: snap.file, snapshot_sha1: snap.sha1, snapshot_bytes: snap.bytes });
                if (snap.changed) {
                    snapFields.snapshot_at = fetchedNow;
                    summary.snapshotChanged = true;
                }
            } catch (err) {
                warnings.push('snapshot not written: ' + errMessage(err));
            }
            sp.snapshot = null;
            phase(key, 'snapshot ' + (summary.snapshotChanged ? 'written' : 'unchanged'), t0);
        }

        if (!force && healthy && ds.content_hash === sp.hash) {
            summary.columns = ds.column_count || 0;
            const note = summary.snapshotChanged ? '; snapshot written' : '';
            const result = await finish('unchanged', `content unchanged (${sp.rows} rows)${note}`, Object.assign({
                last_version: lastVersion,
                content_hash: sp.hash,
                last_fetched_at: fetchedNow
            }, snapFields));
            if (summary.snapshotChanged && onSnapshot) onSnapshot(key);
            return result;
        }

        const oe = officeEnrich.prepare(src, columns);
        const ens = await ensureCollection(pb, collection, fieldList(columns).concat(oe ? oe.fields : []));
        const w = await writeRows({
            pb,
            collection,
            columns,
            primaryKey: src.primaryKey,
            spoolFile: sp.file,
            batchSize,
            syncedAt: started,
            signal: ac.signal,
            warnings,
            log: ctx.log,
            enrich: oe ? oe.enrich : null
        });
        if (oe) summary.officeIssues = oe.issues(); // read by the quality hook (vm/quality)
        phase(key, 'rows written', t0);
        Object.assign(summary, { inserted: w.inserted, updated: w.updated, deleted: w.deleted });
        summary.writeMs = w.writeMs;
        summary.loadMs = w.loadMs;
        summary.batches = w.batches;
        const tableRows = w.existingBefore + w.inserted - w.deleted;
        const parts = [`${w.total} rows: +${w.inserted} ~${w.updated} -${w.deleted} (unchanged ${w.unchanged})`];
        if (ens.created) parts.push('collection created');
        else if (ens.altered) parts.push('collection altered');
        if (w.failed) parts.push(`${w.failed} rows failed: ${w.failures.join(' | ')}`);
        if (summary.snapshotChanged) parts.push('snapshot written');
        if (warnings.length) parts.push(warnings.join('; '));
        const status = w.failed ? 'error' : 'ok';
        const result = await finish(status, parts.join('; '), Object.assign({
            row_count: tableRows,
            column_count: registryColumns.length,
            columns: registryColumns,
            last_version: lastVersion,
            // A partial write must be re-checked next time, so only remember the hash on success.
            content_hash: w.failed ? '' : sp.hash,
            last_fetched_at: fetchedNow,
            last_synced_at: pbDate(new Date())
        }, snapFields));
        if (summary.snapshotChanged && onSnapshot) onSnapshot(key);
        return result;
    } catch (err) {
        if (err instanceof SkipError) return await finish('skipped', err.message, snapFields);
        const msg = ac.signal.aborted && ac.signal.reason ? errMessage(ac.signal.reason) : errMessage(err);
        const result = await finish('error', msg, snapFields);
        if (summary.snapshotChanged && onSnapshot) onSnapshot(key);
        return result;
    } finally {
        clearTimeout(timer);
        if (sp) {
            removeFile(sp.file);
            if (sp.snapshot) await sp.snapshot.abort();
        }
    }
}

module.exports = { syncSource, registryMeta, wantsSnapshot, LOGIC_VERSION };
