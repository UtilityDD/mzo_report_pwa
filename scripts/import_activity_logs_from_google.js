/**
 * One-time import: Google Apps Script activity logs → mzo_insight.activity_logs
 *
 * Prerequisites:
 *   1. Run scripts/create_mzo_insight_activity_logs.sql in Supabase SQL Editor
 *   2. mzo_insight exposed (authenticator pgrst.db_schemas includes mzo_insight)
 *
 * Usage:
 *   npm run migrate:activity-logs
 *   FORCE=1 npm run migrate:activity-logs   # wipe table then re-import
 */

const fs = require('fs');
const path = require('path');

const LOGS_APPS_SCRIPT_URL =
  process.env.LOGS_APPS_SCRIPT_URL ||
  'https://script.google.com/macros/s/AKfycby3lVmwORT3j9J2IKjjYebMVzOknRXjo85VmqIQOlBRGGmEi5eFYGMg90HJpFxlz0mM/exec';

const SCHEMA = 'mzo_insight';
const TABLE = 'activity_logs';

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
    url = url || 'https://unsmtschmcvftfqwabaq.supabase.co';
    key =
      key ||
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVuc210c2NobWN2ZnRmcXdhYmFxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTM1NzA1MTYsImV4cCI6MjA2OTE0NjUxNn0.X3_q0FyEjam4ct03sjiqINz0_Hfu0AlWgRcymA3us9o';
  }
  return { url, key };
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

function normalizeLog(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ts = raw.timestamp || raw.Timestamp || raw.time || '';
  let iso = ts;
  if (ts) {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) iso = d.toISOString();
  } else {
    iso = new Date().toISOString();
  }
  return {
    timestamp: iso,
    username: String(raw.username || raw.Username || '').trim(),
    name: String(raw.name || raw.Name || '').trim(),
    type: String(raw.type || raw.Type || '').trim(),
    details: String(raw.details || raw.Details || '').trim()
  };
}

async function main() {
  const { url, key } = loadCredentials();
  console.log('[activity_logs] Fetching Google Apps Script logs…');

  const scriptUrl = new URL(LOGS_APPS_SCRIPT_URL);
  scriptUrl.searchParams.set('action', 'get_logs');
  const res = await fetch(scriptUrl.toString());
  if (!res.ok) {
    throw new Error(`Apps Script HTTP ${res.status}`);
  }
  const payload = await res.json();
  const rawList = Array.isArray(payload) ? payload : payload.data || payload.logs || [];
  const rows = rawList.map(normalizeLog).filter(Boolean);
  console.log(`[activity_logs] Parsed ${rows.length} log rows from Google`);
  console.log(`[activity_logs] Target: ${SCHEMA}.${TABLE} @ ${new URL(url).host}`);

  try {
    await rest(url, key, `${TABLE}?select=id&limit=1`);
  } catch (err) {
    if (/HTTP 404/.test(err.message)) {
      throw new Error(
        `Table ${SCHEMA}.${TABLE} not visible (HTTP 404). Run create_mzo_insight_activity_logs.sql then NOTIFY pgrst, 'reload schema';\n${err.message}`
      );
    }
    throw err;
  }

  if (process.env.FORCE === '1') {
    console.log('[activity_logs] FORCE=1 — deleting existing rows…');
    await rest(url, key, `${TABLE}?id=gte.0`, { method: 'DELETE', prefer: 'return=minimal' });
  }

  const existing = (await rest(url, key, `${TABLE}?select=id`)) || [];
  if (existing.length > 0 && process.env.FORCE !== '1') {
    console.log(
      `[activity_logs] Table already has ${existing.length} rows. Skipping import (use FORCE=1 to wipe & re-import).`
    );
    return;
  }

  const chunkSize = 100;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    if (!chunk.length) continue;
    await rest(url, key, TABLE, { method: 'POST', body: chunk, prefer: 'return=minimal' });
    inserted += chunk.length;
    console.log(`[activity_logs] Inserted ${inserted}…`);
  }

  const finalCount = (await rest(url, key, `${TABLE}?select=id`)) || [];
  console.log(`[activity_logs] Done. inserted=${inserted}, table_count=${finalCount.length}`);
  console.log('[activity_logs] Safe to delete the Google Sheet / Apps Script after verifying Admin → Logs.');
}

main().catch((err) => {
  console.error('[activity_logs] FAILED:', err.message);
  process.exit(1);
});
