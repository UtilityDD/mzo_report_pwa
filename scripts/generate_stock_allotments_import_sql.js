/**
 * Fetch legacy allotments CSV and write a Supabase SQL import file.
 * Usage: node scripts/generate_stock_allotments_import_sql.js
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_URL =
  process.env.STOCK_ALLOTMENTS_CSV_URL ||
  (process.env.STOCK_ALLOTMENT_SCRIPT_URL
    ? `${process.env.STOCK_ALLOTMENT_SCRIPT_URL}${process.env.STOCK_ALLOTMENT_SCRIPT_URL.includes('?') ? '&' : '?'}format=csv`
    : 'https://script.google.com/macros/s/AKfycbxHxa_srh1nfhDTEf1eiXeRj-u2wr7qWiki1m5QIJ7FtWsaVRBVI7kDk37jeSE7ETOz/exec?format=csv');

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
  if (!raw || raw.startsWith('<')) throw new Error('Did not receive CSV (got HTML/empty).');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '');
  const headers = parseCsvLine(lines[0]).map((h) => String(h || '').trim());
  if (!headers.includes('AllotmentNo')) throw new Error('CSV missing AllotmentNo header.');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = cols[idx] != null ? cols[idx] : '';
    });
    if (!obj.AllotmentNo) continue;
    rows.push(obj);
  }
  return rows;
}

function sqlStr(v) {
  return `'${String(v == null ? '' : v).replace(/'/g, "''")}'`;
}

function sqlNum(v) {
  if (v === '' || v == null) return 'NULL';
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isNaN(n) ? 'NULL' : String(n);
}

function sqlTs(v) {
  const s = String(v || '').trim();
  if (!s || Number.isNaN(Date.parse(s))) return 'now()';
  return sqlStr(new Date(s).toISOString());
}

function parseSeq(allotmentNo) {
  const m = String(allotmentNo || '').match(/MZO\/ALT\/(\d{4})\/(\d+)/i);
  if (!m) return null;
  return { year: parseInt(m[1], 10), seq: parseInt(m[2], 10) };
}

(async () => {
  const res = await fetch(DEFAULT_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`CSV HTTP ${res.status}`);
  const text = await res.text();
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('No allotment rows in CSV.');

  const maxByYear = {};
  const values = rows.map((r) => {
    const no = String(r.AllotmentNo || '').trim();
    const parsed = parseSeq(no);
    if (parsed) maxByYear[parsed.year] = Math.max(maxByYear[parsed.year] || 0, parsed.seq);
    return `(${[
      sqlStr(no),
      sqlStr(String(r.Date || '').slice(0, 10)),
      sqlStr(r.MovementType || ''),
      sqlStr(r.FromStore || ''),
      sqlStr(r.FromPlantCode || ''),
      sqlStr(r.Division || ''),
      sqlStr(r.PlantCode || ''),
      sqlStr(r.MaterialCode || ''),
      sqlStr(r.MaterialDescription || ''),
      sqlStr(r.Unit || ''),
      sqlNum(r.PresentStockDiv),
      sqlNum(r.SourceStockAtAllot),
      sqlNum(r.ZoneStockAtAllot),
      sqlNum(r.AllottedQty),
      sqlStr(r.Remarks || ''),
      sqlStr(r.CreatedBy || 'sheet-migration'),
      sqlTs(r.CreatedAt)
    ].join(', ')})`;
  });

  const seqUpserts = Object.entries(maxByYear)
    .map(([year, maxSeq]) => {
      const next = Number(maxSeq) + 1;
      return [
        `-- Advance sequence for ${year} past max imported seq ${maxSeq}`,
        `INSERT INTO mzo_insight.stock_allot_seq (year, next_seq)`,
        `VALUES (${year}, ${next})`,
        `ON CONFLICT (year) DO UPDATE`,
        `SET next_seq = GREATEST(mzo_insight.stock_allot_seq.next_seq, EXCLUDED.next_seq);`
      ].join('\n');
    })
    .join('\n\n');

  const sql = [
    '-- =========================================================',
    '-- Import legacy Stock Allotments into Supabase',
    `-- Generated: ${new Date().toISOString()}`,
    `-- Rows: ${rows.length}`,
    '-- Run in Supabase SQL Editor (schema mzo_insight)',
    '-- Idempotent on allotment_no: deletes matching numbers then re-inserts',
    '-- =========================================================',
    '',
    'BEGIN;',
    '',
    '-- Remove any previously imported rows for these allotment numbers',
    'DELETE FROM mzo_insight.stock_allotments',
    'WHERE allotment_no IN (',
    [...new Set(rows.map((r) => sqlStr(String(r.AllotmentNo || '').trim())))].join(',\n  '),
    ');',
    '',
    'INSERT INTO mzo_insight.stock_allotments (',
    '  allotment_no, date, movement_type, from_store, from_plant_code,',
    '  division, plant_code, material_code, material_description, unit,',
    '  present_stock_div, source_stock_at_allot, zone_stock_at_allot, allotted_qty,',
    '  remarks, created_by, created_at',
    ')',
    'VALUES',
    values.join(',\n') + ';',
    '',
    seqUpserts,
    '',
    'COMMIT;',
    '',
    'NOTIFY pgrst, \'reload schema\';',
    '',
    'SELECT allotment_no, count(*) AS lines, min(date) AS date',
    'FROM mzo_insight.stock_allotments',
    'GROUP BY allotment_no',
    'ORDER BY allotment_no;',
    ''
  ].join('\n');

  const outPath = path.join(__dirname, 'import_stock_allotments.sql');
  fs.writeFileSync(outPath, sql, 'utf8');
  console.log(`Wrote ${outPath}`);
  console.log(`Rows: ${rows.length}; years: ${JSON.stringify(maxByYear)}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
