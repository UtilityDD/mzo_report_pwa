/**
 * Migrate current Google Sheet stock dump → mzo_insight.stock_snapshot
 * Usage: node scripts/migrate_stock_sheet_to_supabase.js
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { lookupStockCategory } = require('../lib/stock_material_category');
const { dashboardRowToDb, toCsv, OUTPUT_COLUMNS } = require('../lib/stock_pipeline');

const SHEET_URL =
  process.env.STOCK_SHEET_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vSE7jMusI5YFc4fcuHMyWpbqGp1fIcWBNRYh6yieCY8yUyjOgC1ZRWB7flXE0DAVEbHUfG-KlzWCZyf/pub?gid=202809558&single=true&output=csv';

let SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
let SUPABASE_KEY =
  process.env.SUPABASE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY;

const FALLBACK_URL = 'https://unsmtschmcvftfqwabaq.supabase.co';
const FALLBACK_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVuc210c2NobWN2ZnRmcXdhYmFxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTM1NzA1MTYsImV4cCI6MjA2OTE0NjUxNn0.X3_q0FyEjam4ct03sjiqINz0_Hfu0AlWgRcymA3us9o';

const cfgPath = path.join(__dirname, '..', 'data', 'supabase_config.json');
if (fs.existsSync(cfgPath)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg.supabaseUrl) SUPABASE_URL = cfg.supabaseUrl;
    if (cfg.supabaseKey) SUPABASE_KEY = cfg.supabaseKey;
  } catch (_) {}
}
SUPABASE_URL = SUPABASE_URL || FALLBACK_URL;
SUPABASE_KEY = SUPABASE_KEY || FALLBACK_KEY;

const SCHEMA = 'mzo_insight';
const BATCH = 400;

async function querySupabase(apiPath, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${apiPath}`;
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Accept-Profile': options.schema || SCHEMA,
    'Content-Profile': options.schema || SCHEMA
  };
  if (options.prefer) headers.Prefer = options.prefer;
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body != null ? JSON.stringify(options.body) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}

function cellStr(v) {
  if (v == null || v === '') return '';
  return String(v).trim();
}

function rowsFromCsv(text) {
  const wb = XLSX.read(text, { type: 'string' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
}

function normalizePublished(rawRows) {
  const published = [];
  let skipped = 0;
  let withCategory = 0;
  let reportDate = '';
  for (const raw of rawRows) {
    const material = cellStr(raw.Material || raw.material);
    const group = cellStr(raw['Material Group'] || raw.material_group);
    if (!material || !group) {
      skipped++;
      continue;
    }
    const category = lookupStockCategory(material) || '';
    if (category) withCategory++;
    const date = cellStr(raw.Date || raw.date);
    if (date && !reportDate) reportDate = date;
    published.push({
      Plant: cellStr(raw.Plant),
      'Name 1': cellStr(raw['Name 1']),
      'Material Type': cellStr(raw['Material Type']),
      Material: material,
      'Material Description': cellStr(raw['Material Description']),
      'Material Group': group,
      'Storage Location': cellStr(raw['Storage Location']),
      'Descr. of Storage Loc.': cellStr(raw['Descr. of Storage Loc.']),
      'Base Unit of Measure': cellStr(raw['Base Unit of Measure']),
      Unrestricted: cellStr(raw.Unrestricted).replace(/,/g, ''),
      'Stock in Transit': cellStr(raw['Stock in Transit']).replace(/,/g, ''),
      'Transit and Transfer': cellStr(raw['Transit and Transfer']).replace(/,/g, ''),
      Store: cellStr(raw.Store),
      Category: category,
      Date: date
    });
  }
  return { published, skipped, withCategory, reportDate };
}

function sqlStr(v) {
  return `'${String(v == null ? '' : v).replace(/'/g, "''")}'`;
}

function writeImportSql(published, meta) {
  const { DB_KEYS } = require('../lib/stock_pipeline');
  const valueLines = published.map((r) => {
    const db = dashboardRowToDb(r, 0);
    return `(uid, ${DB_KEYS.map((k) => sqlStr(db[k])).join(', ')})`;
  });

  const sql = [
    '-- =========================================================',
    '-- Import Google Sheet stock dump into mzo_insight.stock_snapshot',
    `-- Generated: ${new Date().toISOString()}`,
    `-- Rows: ${published.length}`,
    '-- Run in Supabase SQL Editor if API migration is not used',
    '-- =========================================================',
    '',
    'DO $$',
    'DECLARE',
    '  uid bigint;',
    'BEGIN',
    '  UPDATE mzo_insight.stock_upload_meta SET is_active = false WHERE is_active = true;',
    '',
    '  INSERT INTO mzo_insight.stock_upload_meta (',
    '    uploaded_by, original_name, sheet_name, published_rows, report_date, stats, is_active',
    '  ) VALUES (',
    `    ${sqlStr(meta.uploadedBy)},`,
    `    ${sqlStr(meta.originalName)},`,
    `    ${sqlStr(meta.sheetName)},`,
    `    ${published.length},`,
    `    ${sqlStr(meta.reportDate)},`,
    `    ${sqlStr(JSON.stringify(meta.stats))}::jsonb,`,
    '    true',
    '  ) RETURNING id INTO uid;',
    '',
    '  DELETE FROM mzo_insight.stock_snapshot;',
    '',
    '  INSERT INTO mzo_insight.stock_snapshot (',
    '    upload_id, plant, name_1, material_type, material, material_description,',
    '    material_group, storage_location, descr_of_storage_loc, base_unit_of_measure,',
    '    unrestricted, stock_in_transit, transit_and_transfer, store, category, date',
    '  ) VALUES',
    valueLines.join(',\n') + ';',
    'END $$;',
    '',
    "NOTIFY pgrst, 'reload schema';",
    '',
    'SELECT id, uploaded_by, published_rows, report_date, is_active',
    'FROM mzo_insight.stock_upload_meta',
    'ORDER BY id DESC',
    'LIMIT 3;',
    ''
  ].join('\n');

  const out = path.join(__dirname, 'import_stock_snapshot.sql');
  fs.writeFileSync(out, sql, 'utf8');
  return out;
}

(async () => {
  console.log('Fetching Sheet CSV…');
  const res = await fetch(SHEET_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Sheet HTTP ${res.status}`);
  const text = await res.text();
  const rawRows = rowsFromCsv(text);
  const { published, skipped, withCategory, reportDate } = normalizePublished(rawRows);
  if (!published.length) throw new Error('No valid stock rows found.');

  const reportLabel = reportDate || new Date().toLocaleDateString('en-GB');
  const stats = {
    rawRows: rawRows.length,
    publishedRows: published.length,
    skippedRows: skipped,
    rowsWithCategory: withCategory,
    today: reportLabel,
    migratedFrom: 'google_sheet'
  };
  const meta = {
    uploadedBy: 'sheet-migration',
    originalName: 'google_sheet_stock.csv',
    sheetName: 'Sheet1',
    reportDate: reportLabel,
    stats
  };

  const sqlPath = writeImportSql(published, meta);
  console.log(`Wrote SQL: ${sqlPath} (${published.length} rows)`);

  console.log('Publishing to Supabase via REST…');
  try {
    await querySupabase('stock_upload_meta?is_active=eq.true', {
      method: 'PATCH',
      body: { is_active: false },
      prefer: 'return=minimal'
    });
  } catch (e) {
    console.warn('Deactivate previous meta:', e.message);
  }

  const insertedMeta = await querySupabase('stock_upload_meta', {
    method: 'POST',
    body: {
      uploaded_by: meta.uploadedBy,
      original_name: meta.originalName,
      sheet_name: meta.sheetName,
      published_rows: published.length,
      report_date: meta.reportDate,
      stats,
      is_active: true
    },
    prefer: 'return=representation'
  });
  const metaRow = Array.isArray(insertedMeta) ? insertedMeta[0] : insertedMeta;
  if (!metaRow || metaRow.id == null) throw new Error('No stock_upload_meta id returned.');
  const uploadId = metaRow.id;
  console.log('upload_id', uploadId);

  try {
    await querySupabase('stock_snapshot?id=gte.0', {
      method: 'DELETE',
      prefer: 'return=minimal'
    });
  } catch (e) {
    console.warn('Clear snapshot:', e.message);
  }

  for (let i = 0; i < published.length; i += BATCH) {
    const chunk = published.slice(i, i + BATCH).map((r) => dashboardRowToDb(r, uploadId));
    await querySupabase('stock_snapshot', {
      method: 'POST',
      body: chunk,
      prefer: 'return=minimal'
    });
    console.log(`Inserted ${Math.min(i + BATCH, published.length)} / ${published.length}`);
  }

  // local backup when data/ exists
  try {
    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'stock.csv'), toCsv(published), 'utf8');
    fs.writeFileSync(
      path.join(dataDir, 'stock_meta.json'),
      JSON.stringify({ ...meta, uploadedAt: new Date().toISOString(), source: 'supabase', supabaseUploadId: uploadId }, null, 2),
      'utf8'
    );
    console.log('Wrote local data/stock.csv backup');
  } catch (e) {
    console.warn('Local backup skipped:', e.message);
  }

  console.log('Done.', {
    published: published.length,
    withCategory,
    skipped,
    reportDate: reportLabel,
    uploadId
  });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
