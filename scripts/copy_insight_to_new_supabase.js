/**
 * Copy mzo_insight rows from the live (old) project to the new project.
 * Does NOT change production traffic. Safe to re-run (wipes destination
 * insight tables listed below, then inserts).
 *
 * Requires data/supabase_config.json:
 * {
 *   "supabaseUrl": "https://unsmtschmcvftfqwabaq.supabase.co",
 *   "supabaseKey": "<old anon or service>",
 *   "insightUrl": "https://gmasnqebdogtavoudbke.supabase.co",
 *   "insightKey": "<new service_role>"
 * }
 *
 * Usage: node scripts/copy_insight_to_new_supabase.js
 * Optional: SKIP_STOCK_CSV=1 to skip Google/local snapshot.csv upload
 */
const fs = require('fs');
const path = require('path');

const SCHEMA = 'mzo_insight';
const PAGE = 1000;
const STOCK_SHEET_CSV =
  process.env.STOCK_SHEET_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/1wDvPuAxNfdO9QzUaIUubg2JnkFM5ZleFNXQdi8s5uh0/gviz/tq?tqx=out:csv&sheet=Sheet1';

function loadCfg() {
  const cfgPath = path.join(__dirname, '..', 'data', 'supabase_config.json');
  if (!fs.existsSync(cfgPath)) {
    throw new Error('Missing data/supabase_config.json (gitignored).');
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const src = {
    url: cfg.supabaseUrl || cfg.url,
    key: cfg.supabaseKey || cfg.key
  };
  const dest = {
    url: cfg.insightUrl || process.env.INSIGHT_SUPABASE_URL,
    key: cfg.insightKey || cfg.insightServiceKey || process.env.INSIGHT_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  };
  if (!src.url || !src.key) throw new Error('Old project supabaseUrl/supabaseKey missing.');
  if (!dest.url || !dest.key) throw new Error('New project insightUrl/insightKey missing.');
  if (src.url.replace(/\/$/, '') === dest.url.replace(/\/$/, '')) {
    throw new Error('Source and destination URLs are the same — aborting.');
  }
  return { src, dest };
}

async function rest(cfg, apiPath, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = {
    apikey: cfg.key,
    Authorization: `Bearer ${cfg.key}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Accept-Profile': options.schema || SCHEMA,
    Prefer: options.prefer || (method === 'GET' ? 'count=exact' : 'return=minimal')
  };
  if (method !== 'GET' && method !== 'HEAD') {
    headers['Content-Profile'] = options.schema || SCHEMA;
  }
  const res = await fetch(`${cfg.url}/rest/v1/${apiPath}`, {
    method,
    headers,
    body: options.body != null ? JSON.stringify(options.body) : undefined
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${apiPath} HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  if (!text) return [];
  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}

async function fetchAll(cfg, table) {
  const rows = [];
  let from = 0;
  while (true) {
    const batch = await rest(cfg, `${table}?select=*&order=id.asc&limit=${PAGE}&offset=${from}`);
    if (!Array.isArray(batch) || !batch.length) break;
    rows.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
    if (from > 500000) break;
  }
  return rows;
}

async function fetchAllNoId(cfg, table) {
  const rows = [];
  let from = 0;
  while (true) {
    const batch = await rest(cfg, `${table}?select=*&limit=${PAGE}&offset=${from}`);
    if (!Array.isArray(batch) || !batch.length) break;
    rows.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

function stripId(row) {
  const out = { ...row };
  delete out.id;
  return out;
}

async function replaceTable(dest, table, rows, { keepId } = {}) {
  await rest(dest, `${table}?id=gte.0`, { method: 'DELETE', prefer: 'return=minimal' }).catch(async (e) => {
    if (table === 'stock_allot_seq') {
      await rest(dest, `${table}?year=gte.0`, { method: 'DELETE', prefer: 'return=minimal' });
      return;
    }
    throw e;
  });
  if (!rows.length) {
    console.log(`  ${table}: 0 rows`);
    return;
  }
  const payload = keepId ? rows : rows.map(stripId);
  for (let i = 0; i < payload.length; i += 200) {
    const chunk = payload.slice(i, i + 200);
    await rest(dest, table, { method: 'POST', body: chunk, prefer: 'return=minimal' });
  }
  console.log(`  ${table}: ${payload.length} rows`);
}

async function ensureBucket(dest) {
  const res = await fetch(`${dest.url}/storage/v1/bucket`, {
    method: 'POST',
    headers: {
      apikey: dest.key,
      Authorization: `Bearer ${dest.key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      id: 'stock',
      name: 'stock',
      public: true,
      file_size_limit: 52428800
    })
  });
  const text = await res.text();
  if (res.ok || res.status === 409 || /already exists|duplicate/i.test(text)) {
    console.log('  storage bucket stock: ready');
    return;
  }
  console.warn('  storage bucket create:', res.status, text.slice(0, 300));
}

async function uploadSnapshotCsv(dest) {
  if (String(process.env.SKIP_STOCK_CSV || '') === '1') {
    console.log('  snapshot.csv: skipped');
    return;
  }
  let csv = '';
  const localCsv = path.join(__dirname, '..', 'data', 'stock.csv');
  if (fs.existsSync(localCsv)) {
    csv = fs.readFileSync(localCsv, 'utf8');
    console.log('  snapshot.csv: from data/stock.csv');
  } else {
    const res = await fetch(STOCK_SHEET_CSV);
    if (!res.ok) throw new Error(`Stock CSV fetch HTTP ${res.status}`);
    csv = await res.text();
    console.log('  snapshot.csv: from Google Sheet');
  }
  if (!csv || csv.trim().length < 20) {
    console.warn('  snapshot.csv: empty, not uploaded');
    return;
  }
  const put = await fetch(`${dest.url}/storage/v1/object/stock/snapshot.csv`, {
    method: 'POST',
    headers: {
      apikey: dest.key,
      Authorization: `Bearer ${dest.key}`,
      'Content-Type': 'text/csv',
      'x-upsert': 'true'
    },
    body: csv
  });
  const text = await put.text();
  if (!put.ok) throw new Error(`snapshot.csv upload HTTP ${put.status}: ${text.slice(0, 400)}`);
  console.log(`  snapshot.csv: ${csv.length} bytes`);
}

async function main() {
  const { src, dest } = loadCfg();
  console.log('Source', src.url);
  console.log('Dest  ', dest.url);
  await rest(src, 'portal_users?select=username&limit=1');
  try {
    await rest(dest, 'portal_users?select=username&limit=1');
  } catch (e) {
    throw new Error(
      'New project is not ready. Run scripts/create_insight_project_gmasnqeb.sql in the SQL Editor and expose schema mzo_insight. ' +
        e.message
    );
  }

  const users = await fetchAll(src, 'portal_users');
  if (!users.length) throw new Error('No portal_users on source — aborting.');
  await replaceTable(dest, 'portal_users', users);

  for (const table of ['activity_logs', 'important_unbilled_months', 'stock_allotments']) {
    try {
      const rows = await fetchAll(src, table);
      await replaceTable(dest, table, rows);
    } catch (e) {
      console.warn(`  ${table}: ${e.message}`);
    }
  }
  try {
    const seq = await fetchAllNoId(src, 'stock_allot_seq');
    await replaceTable(dest, 'stock_allot_seq', seq, { keepId: true });
  } catch (e) {
    console.warn('  stock_allot_seq:', e.message);
  }
  try {
    const meta = await fetchAll(src, 'stock_upload_meta');
    await replaceTable(dest, 'stock_upload_meta', meta);
  } catch (e) {
    console.warn('  stock_upload_meta:', e.message);
  }

  await ensureBucket(dest);
  await uploadSnapshotCsv(dest);
  console.log('Copy finished. Production still uses the old project until env is flipped.');
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
