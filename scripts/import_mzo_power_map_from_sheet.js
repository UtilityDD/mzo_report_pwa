/**
 * Import Power Map Google Sheet → Supabase `mzo_power_substations`
 *
 * 1. Run scripts/create_mzo_power_map_tables.sql in Supabase SQL Editor
 * 2. node scripts/import_mzo_power_map_from_sheet.js
 */

const fs = require('fs');
const path = require('path');

const POWER_MAP_SHEET_CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vT8hYE6YBbfVQDJhgB3cIWqrrGrjMQAQ22mcmCJTOa995gCH-xBAfsAPpBvNYS1KlYIFMRHM59iGB7K/pub?output=csv';

const POWER_MAP_TABLE = 'mzo_power_substations';

const COLUMNS = [
  'Region', 'Division', 'Substation', 'MVA', 'LATITUDE', 'LONGITUDE',
  'Connected to', 'Colour', 'RL', 'LineStyle', 'Para-1', 'Para-2', 'Para-3',
  'Comment', 'Symbol', 'SymbolSize', 'LegendText', 'LegendSymbol',
  'LegendColour', 'Remarks', 'ConductorSize', 'PeakLoad'
];

function loadConfig() {
  let url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  let key = process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
  const cfgPath = path.join(__dirname, '..', 'data', 'supabase_config.json');
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    url = cfg.supabaseUrl || cfg.url || url;
    key = cfg.supabaseKey || cfg.key || cfg.anonKey || key;
  }
  if (!url || !key) {
    throw new Error('Missing Supabase credentials (data/supabase_config.json or env).');
  }
  return { url: url.replace(/\/$/, ''), key };
}

function parseCSVLine(line) {
  const result = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
      continue;
    }
    if (c === ',' && !inQ) {
      result.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  result.push(cur);
  return result;
}

function parseCSV(text) {
  const lines = String(text).replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] != null ? String(values[idx]).trim() : '';
    });
    if (row.Substation) rows.push(row);
  }
  return rows;
}

function toPayload(row) {
  const payload = {};
  COLUMNS.forEach(col => {
    payload[col] = row[col] != null ? String(row[col]) : '';
  });
  return payload;
}

async function supabase(cfg, apiPath, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = {
    apikey: cfg.key,
    Authorization: `Bearer ${cfg.key}`,
    'Content-Type': 'application/json'
  };
  if (options.prefer) headers.Prefer = options.prefer;
  else if (method !== 'GET' && method !== 'HEAD') headers.Prefer = 'return=minimal';

  const res = await fetch(`${cfg.url}/rest/v1/${apiPath}`, {
    method,
    headers,
    body: options.body != null ? JSON.stringify(options.body) : undefined
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Supabase HTTP ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return text; }
}

async function main() {
  console.log('[import] Loading Supabase config…');
  const cfg = loadConfig();
  console.log('[import] Host:', new URL(cfg.url).host);
  console.log('[import] Target table:', POWER_MAP_TABLE);

  console.log('[import] Checking table…');
  try {
    await supabase(cfg, `${POWER_MAP_TABLE}?select=id&limit=1`);
  } catch (err) {
    if (String(err.body || err.message).includes('42P01') || err.status === 404) {
      console.error(`\n[import] Table public.${POWER_MAP_TABLE} does not exist.`);
      console.error('Run this SQL in Supabase → SQL Editor first:');
      console.error('  scripts/create_mzo_power_map_tables.sql\n');
      console.error('Then re-run: node scripts/import_mzo_power_map_from_sheet.js');
      process.exit(2);
    }
    throw err;
  }

  console.log('[import] Fetching Google Sheet CSV…');
  const csvRes = await fetch(POWER_MAP_SHEET_CSV_URL);
  if (!csvRes.ok) throw new Error(`Sheet HTTP ${csvRes.status}`);
  const rows = parseCSV(await csvRes.text());
  console.log(`[import] Parsed ${rows.length} substation row(s)`);
  if (!rows.length) {
    console.error('[import] No rows — aborting.');
    process.exit(1);
  }

  console.log('[import] Clearing existing rows…');
  await supabase(cfg, `${POWER_MAP_TABLE}?id=gte.0`, { method: 'DELETE', prefer: 'return=minimal' });

  const payloads = rows.map(toPayload);
  const chunkSize = 50;
  let inserted = 0;
  for (let i = 0; i < payloads.length; i += chunkSize) {
    const chunk = payloads.slice(i, i + chunkSize);
    await supabase(cfg, POWER_MAP_TABLE, {
      method: 'POST',
      body: chunk,
      prefer: 'return=minimal'
    });
    inserted += chunk.length;
    console.log(`[import] Inserted ${inserted}/${payloads.length}`);
  }

  const check = await supabase(cfg, `${POWER_MAP_TABLE}?select=Substation&limit=5000`);
  const count = Array.isArray(check) ? check.length : 0;
  console.log(`[import] Done. ${POWER_MAP_TABLE} count: ${count}`);
  if (count !== rows.length) {
    console.warn(`[import] Warning: sheet had ${rows.length} rows but table has ${count}`);
  }
}

main().catch(err => {
  console.error('[import] Failed:', err.message);
  process.exit(1);
});
