'use strict';
/**
 * lib/nsc_routes.js — Pending NSC / Withheld upload on the VM (CMO-style preview → confirm → commit).
 * Docs: docs/nsc-upload.md. Server only (PRIVATE_PATH).
 *
 * Browser parses the SAP .xlsb (nsc/nsc_client_pipeline.js), then POSTs slim CSVs for preview/commit.
 * The VM stores slim working/withheld CSVs, viz JSON, daily summary snapshots (no raw file, 2 undo versions).
 *
 *   GET  /api/nsc/upload/meta
 *   POST /api/nsc/upload/preview   JSON: { reportDate, workingCsv, withheldCsv, originalName, fileSha256? }
 *   POST /api/nsc/upload/commit    { token, confirmWarnings: [] }
 *   POST /api/nsc/upload/undo      admin
 *   GET  /api/nsc/snapshots           ?detail=1 totals; ?offices=1&side=working|withheld office series
 *   GET  /api/nsc/viz
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const NP = require('./nsc_pipeline');

const WORKING_FILE = 'nsc_working.csv';
const WITHHELD_FILE = 'nsc_withheld.csv';
const META = 'nsc_meta.json';
const VIZ_WORKING = 'nsc_viz_working.json';
const VIZ_WITHHELD = 'nsc_viz_withheld.json';
const VERSIONS = 'nsc_versions';
const SNAPSHOTS = 'nsc_snapshots';
const AUDIT = 'nsc_upload_audit.jsonl';
const KEEP_VERSIONS = 2;
const TOKEN_MS = 15 * 60 * 1000;
const MAX_TOKENS = 6;
const FLAG = 'nsc-upload-autho';

const sha = (alg, data) => crypto.createHash(alg).update(data).digest('hex');
const nameOf = (u) => String((u && (u.Username || u.username)) || '').trim();
const displayOf = (u) => String((u && (u.Name || u.name)) || nameOf(u) || 'Admin').trim().slice(0, 120);

function create(deps) {
  const d = deps || {};
  const dataDir = d.dataDir;
  const log = d.log || console;
  const enabled = d.enabled !== false;
  const file = (n) => path.join(dataDir, n);
  const versionsDir = () => path.join(dataDir, VERSIONS);
  const snapshotsDir = () => path.join(dataDir, SNAPSHOTS);

  function writeAtomic(target, data) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, data, { mode: 0o600 });
      fs.renameSync(tmp, target);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_) { /* */ }
      throw err;
    }
  }
  function readJson(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
  }
  function existsNonEmpty(p) {
    try { return fs.statSync(p).size > 0; } catch (_) { return false; }
  }
  function countCsvRows(p) {
    if (!existsNonEmpty(p)) return 0;
    const text = fs.readFileSync(p, 'utf8');
    const n = text.split(/\r?\n/).filter((l) => l.trim()).length;
    return Math.max(0, n - 1);
  }
  function currentMeta() {
    const meta = readJson(file(META)) || {};
    const workingRows = meta.workingRows != null ? meta.workingRows : countCsvRows(file(WORKING_FILE));
    const withheldRows = meta.withheldRows != null ? meta.withheldRows : countCsvRows(file(WITHHELD_FILE));
    return {
      workingRows,
      withheldRows,
      reportDate: meta.reportDate || '',
      version: meta.version || '',
      source: existsNonEmpty(file(WORKING_FILE)) || existsNonEmpty(file(WITHHELD_FILE)) ? 'upload' : 'none',
      meta
    };
  }
  function listVersions() {
    let names = [];
    try { names = fs.readdirSync(versionsDir()); } catch (_) { return []; }
    return names.filter((n) => /^\d{8}T\d{9}Z(-\d+)?\.json$/.test(n)).sort().reverse()
      .map((n) => path.join(versionsDir(), n));
  }
  function stamp() {
    const base = new Date().toISOString().replace(/[-:.]/g, '');
    let s = base;
    for (let i = 1; fs.existsSync(path.join(versionsDir(), s + '.json')); i++) s = `${base}-${i}`;
    return s;
  }
  function archiveCurrent(cur) {
    if (!cur || cur.source !== 'upload') return;
    const s = stamp();
    const pack = {
      meta: cur.meta || {},
      working: existsNonEmpty(file(WORKING_FILE)) ? fs.readFileSync(file(WORKING_FILE), 'utf8') : '',
      withheld: existsNonEmpty(file(WITHHELD_FILE)) ? fs.readFileSync(file(WITHHELD_FILE), 'utf8') : '',
      vizWorking: readJson(file(VIZ_WORKING)),
      vizWithheld: readJson(file(VIZ_WITHHELD))
    };
    writeAtomic(path.join(versionsDir(), s + '.json'), JSON.stringify(pack));
    for (const v of listVersions().slice(KEEP_VERSIONS)) {
      try { fs.unlinkSync(v); } catch (_) { /* */ }
    }
  }
  function audit(entry) {
    const line = JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry)) + '\n';
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(file(AUDIT), line, { mode: 0o600 });
  }
  function writeSnapshot(reportKey, vizWorking, vizWithheld, metaLite) {
    if (!reportKey) return;
    fs.mkdirSync(snapshotsDir(), { recursive: true });
    const snap = {
      reportDate: reportKey,
      at: new Date().toISOString(),
      working: vizWorking,
      withheld: vizWithheld,
      meta: metaLite || {}
    };
    writeAtomic(path.join(snapshotsDir(), reportKey + '.json'), JSON.stringify(snap));
    const indexPath = path.join(snapshotsDir(), 'index.json');
    let idx = readJson(indexPath) || { dates: [] };
    if (!Array.isArray(idx.dates)) idx.dates = [];
    if (idx.dates.indexOf(reportKey) === -1) idx.dates.push(reportKey);
    idx.dates.sort();
    // Keep ~2 years of daily keys
    if (idx.dates.length > 800) idx.dates = idx.dates.slice(-800);
    writeAtomic(indexPath, JSON.stringify(idx, null, 1));
  }

  async function access(req, force) {
    if (!req.user) return { user: null, admin: false, upload: false };
    const user = (await d.resolveFreshUser(req, !!force)) || req.user;
    const admin = d.isPortalAdmin(user) && (await d.stillAdmin(req));
    const flag = d.flagYes(user[FLAG] != null ? user[FLAG] : user.nsc_upload_autho);
    const legacy = String(nameOf(user)).toLowerCase() === 'dm1';
    return { user, admin, upload: admin || flag || legacy };
  }

  const tokens = new Map();
  function pruneTokens() {
    const now = Date.now();
    for (const [t, v] of tokens) if (v.exp <= now) tokens.delete(t);
    while (tokens.size > MAX_TOKENS) tokens.delete(tokens.keys().next().value);
  }
  let busy = '';
  function lock(what) {
    if (busy) return false;
    busy = what;
    return true;
  }
  const unlock = () => { busy = ''; };
  const BUSY_MSG = 'Another NSC upload is being processed. Please try again in a minute.';

  function lastOf(meta) {
    if (!meta) return null;
    return {
      at: meta.at || null,
      by: meta.byName || meta.by || '',
      username: meta.by || '',
      workingRows: meta.workingRows || 0,
      withheldRows: meta.withheldRows || 0,
      reportDate: meta.reportDate || '',
      action: meta.action || 'upload'
    };
  }

  function mount(app) {
    const json401 = (res) => res.status(401).json({ status: 'error', message: 'Unauthorized. Please sign in to DISHA.' });
    const off = (res) => res.status(404).json({ status: 'error', message: 'NSC uploads are made on the DISHA server, not here.' });

    app.get('/api/nsc/upload/meta', async (req, res) => {
      if (!req.user) return json401(res);
      res.setHeader('Cache-Control', 'private, no-store');
      const a = await access(req, false);
      const cur = enabled ? currentMeta() : { source: 'none' };
      const versions = enabled ? listVersions().length : 0;
      return res.json({
        status: 'success',
        enabled,
        canUpload: enabled && a.upload,
        canUndo: enabled && a.admin && versions > 0,
        isAdmin: a.admin,
        source: cur.source,
        last: cur.source === 'upload' ? lastOf(cur.meta) : null,
        versions,
        limits: {
          maxBytes: NP.LIMITS.maxBytes,
          maxWorkingRows: NP.LIMITS.maxWorkingRows,
          maxWithheldRows: NP.LIMITS.maxWithheldRows
        }
      });
    });

    app.post('/api/nsc/upload/preview', async (req, res) => {
      if (!req.user) return json401(res);
      if (!enabled) return off(res);
      if (!lock('preview')) return res.status(429).json({ status: 'error', message: BUSY_MSG });
      try {
        const a = await access(req, true);
        if (!a.upload) {
          return res.status(403).json({ status: 'error', message: 'You are not allowed to upload Pending NSC. Ask an admin.' });
        }
        const body = req.body || {};
        const reportDateRaw = String(body.reportDate || '').trim();
        const reportDate = NP.parseManualReportDate(reportDateRaw);
        if (!reportDate) {
          return res.status(400).json({
            status: 'blocked',
            blocks: [{ code: 'report_date', message: 'Choose a report date (YYYY-MM-DD).' }]
          });
        }
        const workingCsv = typeof body.workingCsv === 'string' ? body.workingCsv : '';
        const withheldCsv = typeof body.withheldCsv === 'string' ? body.withheldCsv : '';
        if (!workingCsv.trim() && !withheldCsv.trim()) {
          return res.status(400).json({
            status: 'blocked',
            blocks: [{ code: 'no_data', message: 'No processed Working or Withheld CSV was received. Process the Excel in the browser first.' }]
          });
        }
        // Prefer client-processed rows (already transformed). Re-slim to enforce columns.
        let published = workingCsv.trim() ? NP.readCsvRows(workingCsv).map(NP.canonicalizeRow) : [];
        let withheld = withheldCsv.trim() ? NP.readCsvRows(withheldCsv).map(NP.canonicalizeRow) : [];
        // If client sent full columns, re-run transform when SCN_STATUS present and delays missing
        const needsTransform = published.some((r) => r.SCN_STATUS && (r.DelayInSC === undefined || r.DelayInSC === ''));
        if (needsTransform || (published.length && !published[0].PoleNonPole && published[0].SCN_STATUS)) {
          const merged = published.concat(withheld);
          const tr = NP.transformRows(merged, reportDate);
          published = tr.published;
          withheld = tr.withheld;
        } else {
          // Ensure TODAY / report date stamp
          const todayStr = NP.formatDateDMY(reportDate);
          published.forEach((r) => { r.TODAY = todayStr; });
          withheld.forEach((r) => { r.TODAY = todayStr; });
        }

        const slimPub = NP.slimWorking(published);
        const slimWh = NP.slimWithheld(withheld);
        const stats = {
          rawRows: published.length + withheld.length,
          publishedRows: slimPub.length,
          withheldRows: slimWh.length,
          statusCounts: {},
          regionCounts: {},
          today: NP.formatDateDMY(reportDate),
          skippedDup: 0,
          skippedBlank: 0,
          unmappedDiv: slimPub.filter((r) => !r.DIVN_NAME).length
        };
        slimPub.forEach((r) => {
          const s = r.SCN_STATUS || '(blank)';
          stats.statusCounts[s] = (stats.statusCounts[s] || 0) + 1;
          const reg = r.REGION || '(blank)';
          stats.regionCounts[reg] = (stats.regionCounts[reg] || 0) + 1;
        });
        slimWh.forEach((r) => {
          stats.statusCounts['Withheld'] = (stats.statusCounts['Withheld'] || 0) + 1;
        });

        const payload = {
          published: slimPub,
          withheld: slimWh,
          stats,
          reportDateUsed: NP.formatDateDMY(reportDate),
          originalName: String(body.originalName || '').slice(0, 240),
          // Sample row for required-column check (prefer raw-looking first published/withheld).
          sourceRow: slimPub[0] || slimWh[0] || null
        };
        const cur = currentMeta();
        const rv = NP.review(payload, {
          workingRows: cur.workingRows,
          withheldRows: cur.withheldRows,
          reportDate: cur.reportDate
        });
        if (rv.blocks.length) return res.status(422).json({ status: 'blocked', blocks: rv.blocks });

        const workingOut = slimPub.length ? NP.toCsv(slimPub, NP.SLIM_WORKING_COLUMNS) : '';
        const withheldOut = slimWh.length ? NP.toCsv(slimWh, NP.WITHHELD_COLUMNS) : '';
        const vizWorking = NP.buildViz(slimPub, 'working');
        const vizWithheld = NP.buildViz(slimWh.map((r) => Object.assign({}, r, {
          DelayInSC: '', DelaySerial: '', PoleNonPole: 'Non Pole Case'
        })), 'withheld');
        // Withheld viz: count only; no delay/pole from slim withheld columns
        vizWithheld.total = slimWh.length;
        vizWithheld.over30 = 0;
        vizWithheld.pole = 0;
        vizWithheld.poleOver30 = 0;
        const byClass = {};
        const offices = {};
        slimWh.forEach((r) => {
          const cls = String(r.CONN_CLASS || '').trim().toUpperCase() || '?';
          byClass[cls] = (byClass[cls] || 0) + 1;
          const code = String(r.CCC_CODE || '').replace(/\D/g, '').slice(-7) || 'unknown';
          if (!offices[code]) {
            offices[code] = {
              ccc: code, region: r.REGION || '', division: r.DIVN_NAME || '', supp: r.SUPP_OFF || '',
              total: 0, over30: 0, pole: 0, poleOver30: 0, byClass: {}
            };
          }
          offices[code].total += 1;
          offices[code].byClass[cls] = (offices[code].byClass[cls] || 0) + 1;
        });
        vizWithheld.byClass = byClass;
        vizWithheld.offices = Object.keys(offices).sort().map((k) => offices[k]);

        pruneTokens();
        const token = crypto.randomBytes(24).toString('base64url');
        const exp = Date.now() + TOKEN_MS;
        const baseVersion = cur.version || '';
        tokens.set(token, {
          by: nameOf(a.user).toLowerCase(),
          exp,
          workingCsv: workingOut,
          withheldCsv: withheldOut,
          replaceWorking: !!workingOut,
          replaceWithheld: !!withheldOut,
          vizWorking,
          vizWithheld,
          reportDate: payload.reportDateUsed,
          reportDateKey: NP.reportDateKey(payload.reportDateUsed),
          workingRows: slimPub.length,
          withheldRows: slimWh.length,
          warnings: rv.warnings.map((w) => w.code),
          fileSha256: String(body.fileSha256 || '').slice(0, 128),
          originalName: payload.originalName,
          baseVersion
        });
        pruneTokens();
        return res.json({
          status: 'ok',
          token,
          expiresAt: new Date(exp).toISOString(),
          summary: rv.summary,
          warnings: rv.warnings,
          notes: rv.notes,
          current: { workingRows: cur.workingRows, withheldRows: cur.withheldRows, reportDate: cur.reportDate }
        });
      } catch (e) {
        log.error('[NSC upload] preview failed:', e && e.message);
        if (!res.headersSent) return res.status(500).json({ status: 'error', message: 'The file could not be checked. Please try again.' });
      } finally {
        unlock();
      }
    });

    app.post('/api/nsc/upload/commit', async (req, res) => {
      if (!req.user) return json401(res);
      if (!enabled) return off(res);
      const body = req.body || {};
      const a = await access(req, true);
      if (!a.upload) return res.status(403).json({ status: 'error', message: 'You are not allowed to upload Pending NSC. Ask an admin.' });
      pruneTokens();
      const token = typeof body.token === 'string' ? body.token : '';
      const held = token && tokens.get(token);
      if (!held) return res.status(410).json({ status: 'error', message: 'This preview has expired or was already used. Choose the file again.' });
      if (held.by !== nameOf(a.user).toLowerCase()) {
        return res.status(403).json({ status: 'error', message: 'This preview was made by another user.' });
      }
      const given = new Set(Array.isArray(body.confirmWarnings) ? body.confirmWarnings.map(String) : []);
      const missing = held.warnings.filter((c) => !given.has(c));
      if (missing.length) {
        return res.status(409).json({ status: 'confirm', message: 'Tick every warning to confirm you have checked it.', missing });
      }
      if (!lock('commit')) return res.status(429).json({ status: 'error', message: BUSY_MSG });
      try {
        const cur = currentMeta();
        if ((cur.version || '') !== held.baseVersion) {
          tokens.delete(token);
          return res.status(409).json({
            status: 'error',
            message: 'The NSC lists changed after this preview. Choose the file again.'
          });
        }
        tokens.delete(token);
        archiveCurrent(cur);

        if (held.replaceWorking) writeAtomic(file(WORKING_FILE), held.workingCsv);
        if (held.replaceWithheld) writeAtomic(file(WITHHELD_FILE), held.withheldCsv);

        const workingRows = held.replaceWorking ? held.workingRows : cur.workingRows;
        const withheldRows = held.replaceWithheld ? held.withheldRows : cur.withheldRows;
        if (held.replaceWorking) writeAtomic(file(VIZ_WORKING), JSON.stringify(held.vizWorking));
        if (held.replaceWithheld) writeAtomic(file(VIZ_WITHHELD), JSON.stringify(held.vizWithheld));

        const versionSeed = (held.workingCsv || '') + '\n' + (held.withheldCsv || '') + '\n' + held.reportDate;
        const meta = {
          version: sha('sha1', versionSeed),
          at: new Date().toISOString(),
          by: nameOf(a.user),
          byName: displayOf(a.user),
          action: 'upload',
          reportDate: held.reportDate,
          reportDateKey: held.reportDateKey,
          workingRows,
          withheldRows,
          replaceWorking: held.replaceWorking,
          replaceWithheld: held.replaceWithheld,
          fileSha256: held.fileSha256,
          originalName: held.originalName,
          warningsAccepted: held.warnings
        };
        writeAtomic(file(META), JSON.stringify(meta, null, 1));

        const vizW = held.replaceWorking ? held.vizWorking : (readJson(file(VIZ_WORKING)) || null);
        const vizH = held.replaceWithheld ? held.vizWithheld : (readJson(file(VIZ_WITHHELD)) || null);
        writeSnapshot(held.reportDateKey, vizW, vizH, {
          workingRows, withheldRows, by: meta.by
        });

        audit({
          action: 'upload', by: meta.by, byName: meta.byName,
          workingRows, withheldRows, reportDate: meta.reportDate,
          fileSha256: meta.fileSha256, warningsAccepted: meta.warningsAccepted,
          replaceWorking: meta.replaceWorking, replaceWithheld: meta.replaceWithheld
        });
        log.log(`[NSC upload] ${meta.by} saved ${workingRows} working / ${withheldRows} withheld (${meta.reportDate})`);

        if (typeof d.refreshMirror === 'function') {
          d.refreshMirror(['nsc_pending', 'withheld'], `nsc upload by ${meta.by}`, { now: true });
        }
        Promise.resolve(d.logActivity({
          username: meta.by, name: meta.byName, type: 'report_sync',
          details: `Uploaded Pending NSC: ${workingRows} working, ${withheldRows} withheld (${meta.reportDate})`
        })).catch(() => {});

        return res.json({
          status: 'success',
          message: `Saved ${workingRows.toLocaleString('en-IN')} working and ${withheldRows.toLocaleString('en-IN')} withheld (${meta.reportDate}).`,
          last: lastOf(meta),
          version: meta.version
        });
      } catch (e) {
        log.error('[NSC upload] commit failed:', e && e.message);
        return res.status(500).json({ status: 'error', message: 'The lists could not be saved. Nothing was changed; please try again.' });
      } finally {
        unlock();
      }
    });

    app.post('/api/nsc/upload/undo', async (req, res) => {
      if (!req.user) return json401(res);
      if (!enabled) return off(res);
      const a = await access(req, true);
      if (!a.admin) return res.status(403).json({ status: 'error', message: 'Only an admin can undo an NSC upload.' });
      if (!lock('undo')) return res.status(429).json({ status: 'error', message: BUSY_MSG });
      try {
        const v = listVersions()[0];
        if (!v) return res.status(409).json({ status: 'error', message: 'There is no earlier version to go back to.' });
        const pack = readJson(v);
        if (!pack) return res.status(500).json({ status: 'error', message: 'The earlier version could not be read.' });
        if (pack.working) writeAtomic(file(WORKING_FILE), pack.working);
        if (pack.withheld) writeAtomic(file(WITHHELD_FILE), pack.withheld);
        if (pack.vizWorking) writeAtomic(file(VIZ_WORKING), JSON.stringify(pack.vizWorking));
        if (pack.vizWithheld) writeAtomic(file(VIZ_WITHHELD), JSON.stringify(pack.vizWithheld));
        const was = pack.meta || {};
        const meta = {
          version: sha('sha1', (pack.working || '') + '\n' + (pack.withheld || '')),
          at: new Date().toISOString(),
          by: nameOf(a.user),
          byName: displayOf(a.user),
          action: 'undo',
          reportDate: was.reportDate || '',
          reportDateKey: was.reportDateKey || NP.reportDateKey(was.reportDate || ''),
          workingRows: was.workingRows != null ? was.workingRows : countCsvRows(file(WORKING_FILE)),
          withheldRows: was.withheldRows != null ? was.withheldRows : countCsvRows(file(WITHHELD_FILE)),
          restored: { at: was.at || null, by: was.byName || was.by || '', action: was.action || 'upload' }
        };
        writeAtomic(file(META), JSON.stringify(meta, null, 1));
        try { fs.unlinkSync(v); } catch (_) { /* */ }
        audit({ action: 'undo', by: meta.by, byName: meta.byName, workingRows: meta.workingRows, withheldRows: meta.withheldRows, restored: meta.restored });
        log.log(`[NSC upload] ${meta.by} undid the last upload`);
        if (typeof d.refreshMirror === 'function') {
          d.refreshMirror(['nsc_pending', 'withheld'], `nsc undo by ${meta.by}`, { now: true });
        }
        return res.json({ status: 'success', message: 'Restored the earlier NSC lists.', last: lastOf(meta), versions: listVersions().length });
      } catch (e) {
        log.error('[NSC upload] undo failed:', e && e.message);
        return res.status(500).json({ status: 'error', message: 'The earlier list could not be restored.' });
      } finally {
        unlock();
      }
    });

    app.get('/api/nsc/snapshots', async (req, res) => {
      if (!req.user) return json401(res);
      res.setHeader('Cache-Control', 'private, max-age=30');
      const idx = readJson(path.join(snapshotsDir(), 'index.json')) || { dates: [] };
      const dates = Array.isArray(idx.dates) ? idx.dates : [];
      const from = String(req.query.from || '');
      const to = String(req.query.to || '');
      let list = dates;
      if (from) list = list.filter((d) => d >= from);
      if (to) list = list.filter((d) => d <= to);
      const wantDetail = String(req.query.detail || '') === '1';
      const wantOffices = String(req.query.offices || '') === '1';
      if (!wantDetail && !wantOffices) return res.json({ status: 'success', dates: list });
      const side = String(req.query.side || '').toLowerCase(); // working | withheld | '' (both totals)
      const leanOffices = (viz) => {
        if (!viz || !Array.isArray(viz.offices)) return [];
        return viz.offices.map((o) => ({
          ccc: o.ccc || '',
          region: o.region || '',
          division: o.division || '',
          supp: o.supp || '',
          total: o.total || 0,
          over30: o.over30 || 0
        }));
      };
      const items = list.slice(-90).map((d) => {
        const snap = readJson(path.join(snapshotsDir(), d + '.json'));
        if (!snap) return { reportDate: d };
        const row = {
          reportDate: d,
          workingTotal: snap.working && snap.working.total,
          workingOver30: snap.working && snap.working.over30,
          withheldTotal: snap.withheld && snap.withheld.total
        };
        if (wantOffices) {
          if (side !== 'withheld') row.workingOffices = leanOffices(snap.working);
          if (side !== 'working') row.withheldOffices = leanOffices(snap.withheld);
        }
        return row;
      });
      return res.json({ status: 'success', dates: list, items });
    });

    app.get('/api/nsc/viz', async (req, res) => {
      if (!req.user) return json401(res);
      res.setHeader('Cache-Control', 'private, max-age=30');
      return res.json({
        status: 'success',
        working: readJson(file(VIZ_WORKING)),
        withheld: readJson(file(VIZ_WITHHELD)),
        meta: lastOf(readJson(file(META)))
      });
    });
  }

  return {
    mount,
    currentMeta,
    WORKING_FILE,
    WITHHELD_FILE,
    META,
    filePaths: {
      working: () => file(WORKING_FILE),
      withheld: () => file(WITHHELD_FILE),
      meta: () => file(META)
    }
  };
}

module.exports = { create, WORKING_FILE, WITHHELD_FILE, META, VERSIONS, SNAPSHOTS, KEEP_VERSIONS };
