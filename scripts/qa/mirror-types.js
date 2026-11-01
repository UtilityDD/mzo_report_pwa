#!/usr/bin/env node
/* The PocketBase mirror and the pages' uniform rows must name and type every column alike.
 * For every dataset this compares three column lists (name, type, date order, _raw companions,
 * office fields):
 *   uniform  lib/uniform.js build() on the snapshot bytes, given the source's hints (header,
 *            dateOrder, columnTypes + text for primary keys: vm/sync/lib/schema.js typeOverrides)
 *   sync     the sync's own column builder on the same bytes (spool → buildColumns, plus the
 *            office fields): the code the next sync runs
 *   mirror   what PocketBase holds now: the ds_ collection's fields and sys_datasets.columns
 * Datasets without a snapshot (sensitive ones, Supabase tables no page reads) are read from the
 * source with --live (GET only, kept in memory, never written); the mirror may then be a few
 * minutes older than the bytes compared, which the report says.
 * With a schema/<key>.json, the types it pins are compared with the mirror's too (pages' view).
 * --values also compares every cell PocketBase holds with lib/uniform.js's value for the same
 * bytes (a number or bool listed in _nulls is null; dates as instants: date-only = UTC midnight,
 * a wall-clock time = India time, or UTC for a zone-less ISO timestamp), plus missing and extra rows.
 *
 *   node scripts/qa/mirror-types.js --snap <snapshotDir> --env <pb env file> [--live] [--values] [--only a,b] [--json out.json]
 *
 * --env: PB_URL, PB_SUPERUSER_EMAIL, PB_SUPERUSER_PASSWORD (read only: GET requests). Without
 * --env only uniform vs sync is checked. Exit 1 when uniform and the mirror differ.
 * Column names are printed, never values.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const REPO = path.resolve(__dirname, '..', '..');
const SYNC = path.join(REPO, 'vm', 'sync');
const U = require(path.join(REPO, 'lib', 'uniform.js'));
const { spool, removeFile } = require(path.join(SYNC, 'lib', 'spool'));
const { buildColumns, fieldList, typeOverrides } = require(path.join(SYNC, 'lib', 'schema'));
const officeEnrich = require(path.join(SYNC, 'lib', 'office_enrich'));
const { makeSourceFetch } = require(path.join(SYNC, 'lib', 'http'));
const { PocketBase } = require(path.join(SYNC, 'lib', 'pb'));
const { SYSTEM_DEFS, STAGE } = require(path.join(SYNC, 'lib', 'collections'));
const { stableStringify } = require(path.join(SYNC, 'lib', 'util'));
const IST_MS = 330 * 60000;

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; }
const flag = (n) => process.argv.includes('--' + n);

function readEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

async function loadSources() {
  const dir = path.join(SYNC, 'sources');
  const ctx = { fetch: makeSourceFetch(), log: () => {}, env: process.env, limits: { maxRowsPerBatch: 500 } };
  const all = new Map();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
    try {
      const mod = require(path.join(dir, f));
      for (const s of await (typeof mod === 'function' ? mod : mod.sources)(ctx)) if (s && s.key) all.set(s.key, s);
    } catch (e) { console.log(`[mirror-types] sources/${f}: ${e.message}`); }
  }
  return all;
}

const SYSTEM = new Set(SYSTEM_DEFS.map((f) => f.name).concat('id'));
const fmtOf = (file, ct, src) => (/\.json$/.test(file || '') || /json/.test(ct || '') ? 'json' : /\.tsv$/.test(file || '') || /tab-separated/.test(ct || '') || src.rawExt === 'tsv' ? 'tsv' : 'csv');

/** The uniform view: [{ name, type, source_name, date_order?, raw_of? }] including office fields. */
function uniformColumns(input, src, format) {
  const res = U.build(input, { key: src.key, format, header: src.header !== false, dateOrder: src.dateOrder || null, columnTypes: typeOverrides(src) });
  return res.columns.map((c) => strip(c));
}
function strip(c) {
  const o = { name: c.name, type: c.type, source_name: c.source_name || '' };
  if (c.date_order) o.date_order = c.date_order;
  if (c.raw_of) o.raw_of = c.raw_of;
  return o;
}

/** The sync view on the same bytes: spool through the adapter's own parser, then buildColumns. */
async function syncColumns(src, makeInput, tmpDir) {
  const replay = { key: src.key, rows: (ctx) => src.rows(Object.assign({}, ctx, { input: makeInput() })) };
  const sp = await spool(replay, { log: () => {} }, { tmpDir, salt: '' });
  try {
    const { columns, registryColumns } = buildColumns(sp.columns, src);
    const oe = officeEnrich.prepare(src, columns);
    const out = registryColumns.map(strip);
    if (oe) for (const f of oe.fields) out.push({ name: f.name, type: f.type, source_name: '' });
    return { columns: out, fields: fieldList(columns).concat(oe ? oe.fields : []), rows: sp.rows };
  } finally { removeFile(sp.file); }
}

/** Differences between two column lists, by name: [{ column, what, a, b }]. */
function diff(a, b, opts) {
  const o = opts || {};
  const out = [];
  const bm = new Map(b.map((c) => [c.name, c]));
  const am = new Map(a.map((c) => [c.name, c]));
  for (const c of a) {
    const d = bm.get(c.name);
    if (!d) { out.push({ column: c.name, what: 'missing', a: c.type, b: '' }); continue; }
    if (c.type !== d.type) out.push({ column: c.name, what: 'type', a: c.type, b: d.type });
    else if (!o.typesOnly && (c.date_order || '') !== (d.date_order || '')) out.push({ column: c.name, what: 'date_order', a: c.date_order || '', b: d.date_order || '' });
    if (!o.typesOnly && (c.raw_of || '') !== (d.raw_of || '')) out.push({ column: c.name, what: 'raw_of', a: c.raw_of || '', b: d.raw_of || '' });
  }
  for (const d of b) if (!am.has(d.name)) out.push({ column: d.name, what: 'extra', a: '', b: d.type });
  if (!out.length && !o.noOrder && a.map((c) => c.name).join() !== b.map((c) => c.name).join()) out.push({ column: '*', what: 'order', a: '', b: '' });
  return out;
}

/** A PocketBase value against lib/uniform.js's value for the same cell. */
function sameValue(type, want, got, listedNull) {
  if (type === 'number') return want === null ? listedNull && got === 0 : !listedNull && got === want;
  if (type === 'bool') return want === null ? listedNull && got === false : !listedNull && got === want;
  if (type === 'date') {
    if (want === null) return got === '';
    if (typeof got !== 'string' || !got) return false;
    if (want.length === 10) return got === want + ' 00:00:00.000Z';
    const ms = Date.parse(got.replace(' ', 'T'));
    if (want.endsWith('Z')) return ms === Date.parse(want);
    const wall = Date.parse(want + 'Z');
    return ms === wall - IST_MS || ms === wall;
  }
  if (type === 'json') return stableStringify(want === undefined ? null : want) === stableStringify(got === undefined ? null : got);
  return got === want;
}

/** Every record of the collection against the uniform rows of the same input (by _row_no). */
async function compareValues(pb, collection, input, src, format) {
  const res = U.build(input, { key: src.key, format, header: src.header !== false, dateOrder: src.dateOrder || null, columnTypes: typeOverrides(src) });
  const cols = res.columns, n = res.stats.rows;
  const out = { rows: n, records: 0, cells: 0, bad: 0, badColumns: {}, missingRows: 0, extraRecords: 0 };
  const seen = new Uint8Array(n);
  const fields = ['id', '_row_no', '_nulls'].concat(cols.map((c) => c.name)).join(',');
  for await (const page of pb.pages(collection, { fields, perPage: 1000 })) {
    for (const r of page) {
      out.records++;
      const k = r._row_no - 1;
      if (!(k >= 0 && k < n) || seen[k]) { out.extraRecords++; continue; }
      seen[k] = 1;
      const nulls = Array.isArray(r._nulls) && r._nulls.length ? new Set(r._nulls) : null;
      for (let ci = 0; ci < cols.length; ci++) {
        const c = cols[ci];
        out.cells++;
        if (!sameValue(c.type, res.data[ci][k], r[c.name], !!(nulls && nulls.has(c.name)))) {
          out.bad++;
          out.badColumns[c.name] = (out.badColumns[c.name] || 0) + 1; // names and counts only, never values
        }
      }
    }
  }
  for (let k = 0; k < n; k++) if (!seen[k]) out.missingRows++;
  return out;
}

async function readAll(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

async function main() {
  const snap = arg('snap') ? path.resolve(arg('snap')) : null;
  const only = arg('only') ? new Set(arg('only').split(',')) : null;
  const live = flag('live');
  const values = flag('values');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-types-'));
  let cc = [];
  try { cc = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'costcenter.json'), 'utf8')); } catch (_) { /* none */ }
  U.useOffices(require(path.join(REPO, 'lib', 'offices.js')), cc); // as vm/sync/rows.js and the browser do
  const sources = await loadSources();
  const manifest = snap && fs.existsSync(path.join(snap, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(snap, 'manifest.json'), 'utf8')).datasets || {} : {};

  let pb = null; const registry = new Map(); const colls = new Map();
  if (arg('env')) {
    const env = readEnv(arg('env'));
    pb = new PocketBase({ url: env.PB_URL, email: env.PB_SUPERUSER_EMAIL, password: env.PB_SUPERUSER_PASSWORD });
    await pb.auth();
    for await (const page of pb.pages('sys_datasets', { fields: '*' })) for (const r of page) registry.set(r.key, r);
    const res = await pb.req('GET', '/api/collections', { query: { perPage: 1000 } });
    for (const c of res.items || []) colls.set(c.name, c);
  }

  const keys = [...new Set([...sources.keys(), ...registry.keys()])].filter((k) => !only || only.has(k)).sort();
  const report = [];
  const totals = { datasets: 0, columns: 0, valueCells: 0, valueBad: 0, missingRows: 0, extraRecords: 0, mismatched: 0, codeDiff: 0, registryDiff: 0, pinDiff: 0, notCompared: [] };
  for (const key of keys) {
    const src = sources.get(key);
    const ds = registry.get(key) || null;
    const coll = colls.get('ds_' + key) || null;
    const r = { key, via: '', rows: 0, columns: 0, uniformVsMirror: [], uniformVsSync: [], registryVsFields: [], pins: [], note: '' };
    if (!src) { r.note = 'no source definition (removed source?)'; report.push(r); totals.notCompared.push(key + ' (no source)'); continue; }
    if (src.skip) { r.note = 'source skipped: ' + src.skip; report.push(r); totals.notCompared.push(key + ' (skipped)'); continue; }
    const entry = manifest[key];
    let bytes = null; let format = 'csv'; let objects = null;
    try {
      if (entry && entry.file && fs.existsSync(path.join(snap, entry.file))) {
        bytes = fs.readFileSync(path.join(snap, entry.file));
        format = fmtOf(entry.file, entry.contentType, src);
        r.via = 'snapshot';
        if (ds && ds.snapshot_sha1 && entry.version && ds.snapshot_sha1 !== entry.version) r.note = 'snapshot is not the one the mirror last read';
      } else if (live) {
        const ac = new AbortController();
        const ctx = { fetch: makeSourceFetch({ signal: ac.signal }), log: () => {}, env: process.env, limits: { maxRowsPerBatch: 500 }, signal: ac.signal };
        if (typeof src.raw === 'function') {
          const raw = await src.raw(ctx);
          let stream = raw.stream;
          if (stream && typeof stream.getReader === 'function') stream = Readable.fromWeb(stream);
          bytes = await readAll(stream);
          format = fmtOf('', raw.contentType, src);
        } else {
          objects = [];
          for await (const item of src.rows(ctx)) objects.push(item);
        }
        r.via = 'live';
      } else { r.note = 'no snapshot (use --live)'; report.push(r); totals.notCompared.push(key); continue; }
    } catch (e) { r.note = 'could not read: ' + e.message; report.push(r); totals.notCompared.push(key + ' (read failed)'); continue; }

    // uniform: the bytes (or the rows, for adapters without raw()) as lib/uniform.js reads them
    let uni;
    if (objects) {
      const arrays = objects.length && Array.isArray(objects[0]);
      uni = uniformColumns(arrays ? objects.filter((row, i) => i === 0 || row.length) : objects, src, 'json');
    } else uni = uniformColumns(bytes.toString('utf8'), src, format);
    r.columns = uni.length;

    // sync: the same input through the adapter's parser and the sync's column builder
    const makeInput = objects ? null : () => Readable.from([bytes]);
    const syncSrc = objects ? Object.assign({}, src, { rows: async function* () { yield* objects; } }) : src;
    const sy = await syncColumns(syncSrc, makeInput || (() => null), tmpDir);
    r.rows = sy.rows;
    r.uniformVsSync = diff(uni, sy.columns);

    // mirror: the collection's fields (and the registry's column list)
    if (pb) {
      if (!coll) r.note = (r.note ? r.note + '; ' : '') + 'no collection in PocketBase';
      else {
        const fields = coll.fields.filter((f) => !SYSTEM.has(f.name) && !f.name.startsWith(STAGE)).map((f) => ({ name: f.name, type: f.type }));
        const regCols = (ds && Array.isArray(ds.columns) ? ds.columns : []).map(strip);
        const regMap = new Map(regCols.map((c) => [c.name, c]));
        const mirror = fields.map((f) => Object.assign({}, regMap.get(f.name) || { source_name: '' }, f));
        r.uniformVsMirror = diff(uni, mirror);
        r.registryVsFields = diff(regCols, fields.filter((f) => !/^_(region|division|ccc_code|ccc)$/.test(f.name)), { typesOnly: true });
        if (coll.fields.some((f) => f.name.startsWith(STAGE))) r.note = (r.note ? r.note + '; ' : '') + 'staging fields present (a migration did not finish)';
        if (values) {
          r.values = await compareValues(pb, coll.name, objects ? objects : bytes.toString('utf8'), src, objects ? 'json' : format);
          totals.valueCells += r.values.cells; totals.valueBad += r.values.bad;
          totals.missingRows += r.values.missingRows; totals.extraRecords += r.values.extraRecords;
        }
        // pages' view: the types schema/<key>.json pins
        let schema = null;
        try { schema = JSON.parse(fs.readFileSync(path.join(REPO, 'schema', key + '.json'), 'utf8')); } catch (_) { /* none */ }
        if (schema && !objects) {
          const res = U.build(bytes.toString('utf8'), { key, format, schema });
          const data = mirror.filter((c) => !c.raw_of); // a _raw companion shares its column's source name
          const fm = new Map(data.map((c) => [c.source_name + '\u0000', c]).concat(mirror.map((c) => [c.name, c])));
          for (const c of res.columns) {
            if (!c.pinned || c.raw_of) continue;
            const m = (c.source_name && fm.get(c.source_name + '\u0000')) || fm.get(c.name);
            if (!m) r.pins.push({ column: c.name, what: 'not in mirror', a: c.type, b: '' });
            else if (m.type !== c.type) r.pins.push({ column: c.name, what: 'pinned type', a: c.type, b: m.type + ' (' + m.name + ')' });
          }
        }
      }
    }
    totals.datasets++;
    totals.columns += uni.length;
    const bad = new Set(r.uniformVsMirror.map((d) => d.column));
    totals.mismatched += bad.size;
    totals.codeDiff += new Set(r.uniformVsSync.map((d) => d.column)).size;
    totals.registryDiff += r.registryVsFields.length;
    totals.pinDiff += r.pins.length;
    report.push(r);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });

  for (const r of report) {
    const parts = [];
    if (r.uniformVsMirror.length) parts.push('mirror: ' + r.uniformVsMirror.map((d) => `${d.column} ${d.what} ${d.a}→${d.b}`).join(', '));
    if (r.uniformVsSync.length) parts.push('SYNC CODE: ' + r.uniformVsSync.map((d) => `${d.column} ${d.what} ${d.a}→${d.b}`).join(', '));
    if (r.registryVsFields.length) parts.push('registry: ' + r.registryVsFields.map((d) => `${d.column} ${d.what}`).join(', '));
    if (r.pins.length) parts.push('schema pins: ' + r.pins.map((d) => `${d.column} ${d.what} ${d.a}≠${d.b}`).join(', '));
    if (r.values && (r.values.bad || r.values.missingRows || r.values.extraRecords)) {
      parts.push(`values: ${r.values.bad} of ${r.values.cells} cells differ (${Object.entries(r.values.badColumns).map(([c, k]) => c + ' ×' + k).join(', ')}), ${r.values.missingRows} rows missing, ${r.values.extraRecords} extra records`);
    }
    const status = !r.via ? 'skip' : parts.length ? 'DIFF' : 'same';
    console.log(`${status.padEnd(4)} ${r.key.padEnd(34)} ${(r.via || '').padEnd(8)} ${String(r.columns).padStart(4)} cols ${String(r.rows).padStart(7)} rows  ${parts.join(' | ')}${r.note ? '  [' + r.note + ']' : ''}`);
  }
  console.log(`[mirror-types] ${totals.datasets} datasets, ${totals.columns} columns compared: ` +
    `${totals.mismatched} columns differ between uniform and the mirror, ${totals.codeDiff} between uniform and the sync code, ` +
    `${totals.registryDiff} registry/field differences, ${totals.pinDiff} schema-pin differences` +
    (values ? `; values: ${totals.valueBad} of ${totals.valueCells} cells differ, ${totals.missingRows} rows missing, ${totals.extraRecords} extra records` : '') +
    `; not compared: ${totals.notCompared.length ? totals.notCompared.join(', ') : 'none'}`);
  if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify({ totals, report }, null, 1));
  process.exit(pb && totals.mismatched ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
