/**
 * One-time import: Google Sheet login users → mzo_insight.portal_users
 *
 * Prerequisites:
 *   1. Run scripts/create_mzo_insight_portal_users.sql in Supabase SQL Editor
 *   2. Ensure mzo_insight is in Project Settings → API → Exposed schemas
 *
 * Usage:
 *   npm run migrate:portal-users
 *   node scripts/import_portal_users_from_sheet.js
 *
 * Optional: FORCE=1 to wipe portal_users and re-import
 */

const fs = require('fs');
const path = require('path');

const LOGIN_SHEET_URL =
  process.env.LOGIN_SHEET_URL ||
  'https://docs.google.com/spreadsheets/d/1GtWgPMm-WeDNfebubp5ac76waeZGESA2bQ8JkEpHlZ4/export?format=csv&gid=0';

const SCHEMA = 'mzo_insight';
const TABLE = 'portal_users';

function loadCredentials() {
  let url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  let key =
    process.env.SUPABASE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    '';
  const cfgPath = path.join(__dirname, '..', 'data', 'supabase_config.json');
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    url = cfg.supabaseUrl || cfg.url || url;
    key = cfg.supabaseKey || cfg.key || key;
  }
  if (!url || !key) {
    // Same public anon fallback used by server.js / SI pages
    url = url || 'https://unsmtschmcvftfqwabaq.supabase.co';
    key =
      key ||
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVuc210c2NobWN2ZnRmcXdhYmFxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTM1NzA1MTYsImV4cCI6MjA2OTE0NjUxNn0.X3_q0FyEjam4ct03sjiqINz0_Hfu0AlWgRcymA3us9o';
  }
  return { url, key };
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function sheetRowToDb(headers, values) {
  const raw = {};
  for (let j = 0; j < headers.length; j++) {
    raw[headers[j]] = values[j] != null ? String(values[j]).trim() : '';
  }
  const username = (raw.Username || raw.username || '').trim();
  if (!username) return null;
  return {
    username,
    pin: String(raw.PIN != null ? raw.PIN : raw.pin || '').trim(),
    name: (raw.Name || raw.name || '').trim(),
    role: (raw.role || raw.Role || '').trim(),
    last_login: (raw.LastLogin || raw.last_login || '').trim(),
    dtr_autho: (raw['dtr-autho'] || raw.dtr_autho || '').trim(),
    ss_autho: (raw['ss-autho'] || raw.ss_autho || '').trim(),
    dd_autho: (raw['dd-autho'] || raw.dd_autho || '').trim(),
    nsc_autho: (raw['nsc-autho'] || raw.nsc_autho || '').trim(),
    nsc_upload_autho: (raw['nsc-upload-autho'] || raw.nsc_upload_autho || '').trim(),
    stock_upload_autho: (raw['stock-upload-autho'] || raw.stock_upload_autho || '').trim(),
    stock_allot_autho: (raw['stock-allot-autho'] || raw.stock_allot_autho || '').trim(),
    stock_cancel_autho: (raw['stock-cancel-autho'] || raw.stock_cancel_autho || '').trim(),
    si_autho: (raw['si-autho'] || raw.si_autho || '').trim(),
    si_divisions: (raw['si-divisions'] || raw.si_divisions || '').trim(),
    sheets_autho: (raw['sheets-autho'] || raw.sheets_autho || '').trim(),
    zone_code: (raw.zone_code || '').trim(),
    region_code: (raw.region_code || '').trim(),
    division_code: (raw.division_code || '').trim(),
    ccc_code: (raw.ccc_code || '').trim()
  };
}

async function rest(url, key, apiPath, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Accept-Profile': SCHEMA,
    'Content-Profile': SCHEMA
  };
  if (method !== 'GET' && method !== 'HEAD') {
    headers.Prefer = options.prefer || 'return=representation';
  }
  const res = await fetch(`${url}/rest/v1/${apiPath}`, {
    method,
    headers,
    body: options.body != null ? JSON.stringify(options.body) : undefined
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function main() {
  const { url, key } = loadCredentials();
  console.log('[portal_users] Fetching Google Sheet…');
  const csvText = await (await fetch(LOGIN_SHEET_URL)).text();
  const lines = csvText.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    throw new Error('Sheet has no data rows');
  }
  const headers = parseCSVLine(lines[0]).map((h) => h.trim());
  const rows = [];
  const seen = new Set();
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row = sheetRowToDb(headers, values);
    if (!row) continue;
    const keyName = row.username.toLowerCase();
    if (seen.has(keyName)) {
      console.warn(`[portal_users] Skip duplicate username: ${row.username}`);
      continue;
    }
    seen.add(keyName);
    rows.push(row);
  }
  console.log(`[portal_users] Parsed ${rows.length} users from sheet`);
  console.log(`[portal_users] Target: ${SCHEMA}.${TABLE} @ ${new URL(url).host}`);

  // Preflight — 404 usually means table missing or PostgREST schema cache stale
  try {
    await rest(url, key, `${TABLE}?select=username&limit=1`);
  } catch (err) {
    if (/HTTP 404/.test(err.message)) {
      throw new Error(
        `Table ${SCHEMA}.${TABLE} not visible to the API (HTTP 404).\n` +
          `  1) In SQL Editor run scripts/create_mzo_insight_portal_users.sql\n` +
          `  2) Then run:  NOTIFY pgrst, 'reload schema';\n` +
          `  3) Confirm Table Editor schema dropdown = mzo_insight and portal_users exists\n` +
          `Original: ${err.message}`
      );
    }
    throw err;
  }

  if (process.env.FORCE === '1') {
    console.log('[portal_users] FORCE=1 — deleting existing rows…');
    await rest(url, key, `${TABLE}?id=gte.0`, { method: 'DELETE', prefer: 'return=minimal' });
  }

  const existing = (await rest(url, key, `${TABLE}?select=username`)) || [];
  const existingSet = new Set(existing.map((r) => String(r.username).toLowerCase()));

  let inserted = 0;
  let skipped = 0;
  const chunkSize = 50;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize).filter((r) => {
      if (existingSet.has(r.username.toLowerCase())) {
        skipped++;
        return false;
      }
      return true;
    });
    if (!chunk.length) continue;
    await rest(url, key, TABLE, { method: 'POST', body: chunk, prefer: 'return=minimal' });
    inserted += chunk.length;
    console.log(`[portal_users] Inserted ${inserted}…`);
  }

  const finalCount = (await rest(url, key, `${TABLE}?select=id`)) || [];
  console.log(
    `[portal_users] Done. inserted=${inserted}, skipped_existing=${skipped}, table_count=${finalCount.length}`
  );
}

main().catch((err) => {
  console.error('[portal_users] FAILED:', err.message);
  process.exit(1);
});
