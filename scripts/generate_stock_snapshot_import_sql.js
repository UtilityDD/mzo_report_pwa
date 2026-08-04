/**
 * Fetch current Google Sheet stock CSV and write Supabase import SQL.
 * Usage: node scripts/generate_stock_snapshot_import_sql.js
 */
const fs = require('fs');
const path = require('path');
const { lookupStockCategory } = require('../lib/stock_material_category');

const STOCK_SHEET_URL =
  process.env.STOCK_SHEET_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vSE7jMusI5YFc4fcuHMyWpbqGp1fIcWBNRYh6yieCY8yUyjOgC1ZRWB7flXE0DAVEbHUfG-KlzWCZyf/pub?gid=202809558&single=true&output=csv';

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!raw || raw.startsWith('<')) throw new Error('Did not receive CSV.');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '');
  const headers = parseCsvLine(lines[0]).map((h) => String(h || '').trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = cols[idx] != null ? String(cols[idx]).trim() : '';
    });
    if (!obj.Material || !obj['Material Group']) continue;
    rows.push(obj);
  }
  return rows;
}

function sqlStr(v) {
  return `'${String(v == null ? '' : v).replace(/'/g, "''")}'`;
}

function toDMYLabel(dateRaw) {
  const s = String(dateRaw || '').trim();
  if (!s) return '';
  // M/D/YYYY or MM/DD/YYYY
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    return `${mdy[2].padStart(2, '0')}/${mdy[1].padStart(2, '0')}/${mdy[3]}`;
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  return s;
}

(async () => {
  const res = await fetch(STOCK_SHEET_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Stock CSV HTTP ${res.status}`);
  const text = await res.text();
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('No stock rows found.');

  let withCat = 0;
  const reportDateRaw = rows.map((r) => r.Date).find((d) => d) || '';
  const reportDate = toDMYLabel(reportDateRaw) || new Date().toLocaleDateString('en-GB');

  const valueLines = rows.map((r) => {
    const material = r.Material || '';
    const category = lookupStockCategory(material) || '';
    if (category) withCat += 1;
    return `    (uid, ${[
      sqlStr(r.Plant || ''),
      sqlStr(r['Name 1'] || ''),
      sqlStr(r['Material Type'] || ''),
      sqlStr(material),
      sqlStr(r['Material Description'] || ''),
      sqlStr(r['Material Group'] || ''),
      sqlStr(r['Storage Location'] || ''),
      sqlStr(r['Descr. of Storage Loc.'] || ''),
      sqlStr(r['Base Unit of Measure'] || ''),
      sqlStr(String(r.Unrestricted || '').replace(/,/g, '')),
      sqlStr(String(r['Stock in Transit'] || '').replace(/,/g, '')),
      sqlStr(String(r['Transit and Transfer'] || '').replace(/,/g, '')),
      sqlStr(r.Store || ''),
      sqlStr(category),
      sqlStr(r.Date || reportDateRaw || '')
    ].join(', ')})`;
  });

  const statsJson = JSON.stringify({
    rawRows: rows.length,
    publishedRows: rows.length,
    skippedRows: 0,
    rowsWithCategory: withCat,
    today: reportDate,
    migratedFrom: 'google_sheet'
  }).replace(/'/g, "''");

  const sql = [
    '-- =========================================================',
    '-- Import current Stock Sheet dump into Supabase',
    `-- Generated: ${new Date().toISOString()}`,
    `-- Rows: ${rows.length}  |  with category: ${withCat}  |  report date: ${reportDate}`,
    '-- Run in Supabase SQL Editor (schema mzo_insight)',
    '-- Creates one active upload meta + snapshot rows',
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
    `    'sheet-migration',`,
    `    'google_sheet_stock.csv',`,
    `    'Sheet1',`,
    `    ${rows.length},`,
    `    ${sqlStr(reportDate)},`,
    `    '${statsJson}'::jsonb,`,
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
    '',
    'END $$;',
    '',
    "NOTIFY pgrst, 'reload schema';",
    '',
    'SELECT id, uploaded_by, published_rows, report_date, is_active, uploaded_at',
    'FROM mzo_insight.stock_upload_meta',
    'ORDER BY id DESC',
    'LIMIT 5;',
    '',
    'SELECT count(*) AS snapshot_rows FROM mzo_insight.stock_snapshot;',
    ''
  ].join('\n');

  const outPath = path.join(__dirname, 'import_stock_snapshot.sql');
  fs.writeFileSync(outPath, sql, 'utf8');
  console.log(`Wrote ${outPath}`);
  console.log(`Rows: ${rows.length}, withCategory: ${withCat}, reportDate: ${reportDate}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
