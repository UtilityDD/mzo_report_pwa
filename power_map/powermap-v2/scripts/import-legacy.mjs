/**
 * Safe legacy → PowerMap V2 import
 *
 * Source (read-only): Google Sheet CSV (same truth as old Power Map)
 * Local write:        src/data/legacyNetwork.json  (--seed, default with dry-run)
 * Cloud write:        powermap.* via API            (--apply; needs Exposed schemas)
 * SQL write:          supabase/seed/006_legacy_import.sql (--sql)
 *
 * Usage:
 *   npm run import:legacy              # dry-run + write local seed
 *   npm run import:legacy:apply        # also try Supabase powermap writes
 *   node scripts/import-legacy.mjs --sql
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const WRITE_SQL = process.argv.includes('--sql');
const SKIP_SEED = process.argv.includes('--no-seed');

const SHEET_CSV_URL =
  process.env.POWERMAP_LEGACY_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/1nBLLL3zc3OjuJ6umq3uQVmjXCPhlVATYhQX1BlfqS2w/export?format=csv&gid=0';

/** Stable UUIDs for seeded voltage levels (match 004 migration order by code). */
const VOLTAGE_IDS = {
  '400': 'a1000000-0000-4000-8000-000000000400',
  '220': 'a1000000-0000-4000-8000-000000000220',
  '132': 'a1000000-0000-4000-8000-000000000132',
  '33': 'a1000000-0000-4000-8000-000000000033',
};

const ZONE_ID = 'b1000000-0000-4000-8000-000000000001';

function loadEnv() {
  try {
    const raw = readFileSync(resolve(root, '.env'), 'utf8');
    const env = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) env[m[1].trim()] = m[2].trim();
    }
    return env;
  } catch {
    return {};
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || (c === '\r' && next === '\n')) {
      if (c === '\r') i++;
      row.push(field);
      if (row.some((v) => String(v).trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    if (row.some((v) => String(v).trim() !== '')) rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => String(h).trim());
  return rows.slice(1).map((cols) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = cols[i] ?? '';
    });
    return obj;
  });
}

function dmsToDecimal(dms) {
  if (dms === null || dms === undefined || dms === '') return NaN;
  if (typeof dms === 'number') return dms;
  const str = String(dms).trim();
  if (!str) return NaN;
  if (/^[+-]?\d+(\.\d+)?$/.test(str)) return parseFloat(str);
  const parts = str.match(/[NSWE]?\d+[^\d\w.']+\d+\.\d+'/gi);
  if (!parts) return NaN;
  let degrees = parseFloat(parts[0].match(/\d+/)[0]);
  let minutes = parseFloat(parts[0].match(/\d+\.\d+/g)[0]);
  let decimal = degrees + minutes / 60;
  if (/[SW]/i.test(str)) decimal *= -1;
  return decimal;
}

function splitColon(value) {
  if (value == null || String(value).trim() === '') return [];
  return String(value)
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeName(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function mapVoltage(raw) {
  const s = String(raw || '').toUpperCase().replace(/\s+/g, '');
  if (s.includes('400')) return '400';
  if (s.includes('220')) return '220';
  if (s.includes('132')) return '132';
  if (s.includes('66')) return '33';
  if (s.includes('33') || s.includes('11')) return '33';
  return '33';
}

function parseLoading(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const n = parseFloat(String(raw).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Force selected corridors to double circuit even when the sheet lists
 * the target only once on each end (not Target:Target).
 * Ckt 2 picks up alternate RL / PeakLoad from the far-end row when present.
 */
function applyPlannedDoubleCircuits(pairBest, substations, nameIndex) {
  const planned = [
    { a: 'Gangarampur GSS', b: 'Buniadpur', voltageCode: '33' },
  ];

  for (const plan of planned) {
    const idA = nameIndex.get(normalizeName(plan.a));
    const idB = nameIndex.get(normalizeName(plan.b));
    if (!idA || !idB) {
      console.warn(`Planned D/C skipped (SS missing): ${plan.a} ↔ ${plan.b}`);
      continue;
    }
    const ssA = substations.find((s) => s.id === idA);
    const ssB = substations.find((s) => s.id === idB);
    if (!ssA || !ssB) continue;

    const voltageCode = plan.voltageCode;
    const lo = idA < idB ? idA : idB;
    const hi = idA < idB ? idB : idA;
    const pairKey = `${lo}|${hi}|${voltageCode}`;
    const existing = pairBest.get(pairKey) ?? [];
    if (existing.length >= 2) {
      // Already D/C from sheet — ensure labels/config
      existing.forEach((line, i) => {
        line.circuitCount = i + 1;
        line.circuitConfig = 'double';
        const base = `${ssA.name} – ${ssB.name} (${voltageCode} kV)`;
        const fromName = substations.find((s) => s.id === line.fromId)?.name ?? ssA.name;
        const toName = substations.find((s) => s.id === line.toId)?.name ?? ssB.name;
        const base2 = `${fromName} – ${toName} (${voltageCode} kV)`;
        if (!/·\s*Ckt\s*\d+/i.test(line.name)) {
          line.name = `${base2} · Ckt ${i + 1}${line.conductor ? ` · ${line.conductor}` : ''}`;
        }
      });
      pairBest.set(pairKey, existing);
      console.log(`Planned D/C already present: ${plan.a} ↔ ${plan.b} (${existing.length} ckts)`);
      continue;
    }

    const ckt1 = existing[0];
    if (!ckt1) {
      console.warn(`Planned D/C skipped (no base line): ${plan.a} ↔ ${plan.b}`);
      continue;
    }

    // Alternate attrs from the opposite SS row (Buniadpur lists Gangarampur once)
    const far = substations.find((s) => s.id === (ckt1.fromId === idA ? idB : idA));
    const near = substations.find((s) => s.id === ckt1.fromId);
    let altLength = null;
    let altLoad = null;
    let altConductor = '';
    if (far && near) {
      const targets = splitColon(far.raw['Connected to']);
      const rls = splitColon(far.raw.RL);
      const loads = splitColon(far.raw.PeakLoad);
      const conductors = splitColon(far.raw.ConductorSize);
      const idx = targets.findIndex((t) => normalizeName(t) === normalizeName(near.name));
      if (idx >= 0) {
        const rl = rls[idx] ? parseFloat(rls[idx]) : NaN;
        if (Number.isFinite(rl) && rl > 0) altLength = Math.round(rl * 1000) / 1000;
        altLoad = parseLoading(loads[idx]);
        altConductor = conductors[idx] || '';
      }
    }

    const fromSs = substations.find((s) => s.id === ckt1.fromId);
    const toSs = substations.find((s) => s.id === ckt1.toId);
    const baseName = `${fromSs.name} – ${toSs.name} (${voltageCode} kV)`;

    ckt1.circuitCount = 1;
    ckt1.circuitConfig = 'double';
    ckt1.name = `${baseName} · Ckt 1${ckt1.conductor ? ` · ${ckt1.conductor}` : ''}`;

    const ckt2Conductor = altConductor || ckt1.conductor || 'DOG';
    const ckt2 = {
      ...ckt1,
      id: randomUUID(),
      circuitCount: 2,
      circuitConfig: 'double',
      conductor: ckt2Conductor,
      lengthKm: ckt1.lengthKm, // same corridor; keep primary surveyed length
      loadingPct: altLoad ?? ckt1.loadingPct,
      name: `${baseName} · Ckt 2${ckt2Conductor ? ` · ${ckt2Conductor}` : ''}`,
      remarks: altLength && altLength !== ckt1.lengthKm
        ? `Far-end RL ${altLength} km (sheet)`
        : '',
    };

    pairBest.set(pairKey, [ckt1, ckt2]);
    console.log(
      `Planned D/C applied: ${plan.a} ↔ ${plan.b} · Ckt1 ${ckt1.lengthKm}km/${ckt1.conductor}/${ckt1.loadingPct ?? '—'} · Ckt2 ${ckt2.lengthKm}km/${ckt2.conductor}/${ckt2.loadingPct ?? '—'}`,
    );
  }
}

function parseMva(raw) {
  if (raw == null || String(raw).trim() === '') return [{ ratingMva: 10, quantity: 1 }];
  const text = String(raw).trim();
  const units = [];
  const re = /(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)/gi;
  let m;
  while ((m = re.exec(text))) {
    units.push({ quantity: Number(m[1]), ratingMva: Number(m[2]) });
  }
  if (units.length) return units;
  const n = parseFloat(text.replace(/[^\d.]/g, ''));
  if (Number.isFinite(n) && n > 0) return [{ ratingMva: n, quantity: 1 }];
  return [{ ratingMva: 10, quantity: 1 }];
}

function inferStatus(row) {
  const style = String(row.LineStyle || '').toLowerCase();
  const colour = String(row.Colour || row.Comment || '').toLowerCase();
  const remarks = String(row.Remarks || row['Para-3'] || '').toLowerCase();
  if (style.includes('dash') || colour.includes('blue') || remarks.includes('proposed')) {
    return 'proposed';
  }
  return 'existing';
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function lineStatusFromStyle(style) {
  return String(style || '').toLowerCase().includes('dash') ? 'proposed' : 'existing';
}

function sqlStr(v) {
  if (v == null) return 'null';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function sqlNum(v) {
  if (v == null || !Number.isFinite(v)) return 'null';
  return String(v);
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'SAFE (seed local)'}${WRITE_SQL ? ' + SQL' : ''}`);
  console.log('Source: Google Sheet CSV (read-only)');
  console.log(`URL: ${SHEET_CSV_URL}\n`);

  const res = await fetch(SHEET_CSV_URL);
  if (!res.ok) {
    console.error(`Failed to fetch sheet CSV: HTTP ${res.status}`);
    process.exit(1);
  }
  const legacy = parseCsv(await res.text());

  const voltageId = { ...VOLTAGE_IDS };
  const warnings = [];
  const substations = [];
  const nameIndex = new Map();
  const now = new Date().toISOString();

  for (const row of legacy) {
    const name = String(row.Substation || '').trim();
    if (!name) continue;
    const lat = dmsToDecimal(row.LATITUDE);
    const lng = dmsToDecimal(row.LONGITUDE);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      warnings.push(`Skip SS (bad coords): ${name}`);
      continue;
    }
    const voltageCode = mapVoltage(row['Para-2'] || row.Voltage || row.Remarks);
    const id = randomUUID();
    const keyN = normalizeName(name);
    if (nameIndex.has(keyN)) {
      warnings.push(`Duplicate name (keeping first): ${name}`);
      continue;
    }
    nameIndex.set(keyN, id);

    const div = String(row.Division || '').trim();
    substations.push({
      id,
      name,
      lat,
      lng,
      voltageCode,
      voltageLevelId: voltageId[voltageCode],
      divisionName: div || null,
      regionName: String(row.Region || '').trim() || null,
      status: inferStatus(row),
      loadingPct: parseLoading(row['Para-1']),
      remarks: String(row['Para-3'] || row.Remarks || '').trim(),
      transformers: parseMva(row.MVA),
      raw: row,
    });
  }

  const divisionNames = [
    ...new Set(substations.map((s) => s.divisionName).filter(Boolean)),
  ].sort();
  const orgUnits = [
    {
      id: ZONE_ID,
      parentId: null,
      type: 'zone',
      name: 'Malda Zone',
      code: 'MZO',
    },
    ...divisionNames.map((div, i) => ({
      id: `b1000000-0000-4000-8000-${String(i + 2).padStart(12, '0')}`,
      parentId: ZONE_ID,
      type: 'division',
      name: div,
      code: div.slice(0, 8).toUpperCase().replace(/\s+/g, ''),
    })),
  ];
  const orgByName = new Map(orgUnits.map((o) => [normalizeName(o.name), o.id]));

  for (const ss of substations) {
    ss.orgUnitId = ss.divisionName
      ? orgByName.get(normalizeName(ss.divisionName)) || null
      : ZONE_ID;
  }

  // Undirected pair → best circuit list (keep double/multi slots with distinct attrs).
  // Sheet encodes D/C as repeated Connected-to targets with parallel Conductor/RL/PeakLoad.
  const pairBest = new Map();
  let skippedLinks = 0;

  for (const ss of substations) {
    const targets = splitColon(ss.raw['Connected to']);
    const rls = splitColon(ss.raw.RL);
    const styles = splitColon(ss.raw.LineStyle);
    const conductors = splitColon(ss.raw.ConductorSize);
    const loads = splitColon(ss.raw.PeakLoad);

    /** @type {Map<string, number[]>} */
    const indicesByTo = new Map();
    targets.forEach((targetName, idx) => {
      const toId = nameIndex.get(normalizeName(targetName));
      if (!toId) {
        warnings.push(`Broken link: ${ss.name} → ${targetName}`);
        skippedLinks++;
        return;
      }
      if (toId === ss.id) return;
      const list = indicesByTo.get(toId) ?? [];
      list.push(idx);
      indicesByTo.set(toId, list);
    });

    for (const [toId, indices] of indicesByTo) {
      const toSs = substations.find((s) => s.id === toId);
      if (!toSs) continue;

      const voltageCode =
        ss.voltageCode === toSs.voltageCode
          ? ss.voltageCode
          : [ss.voltageCode, toSs.voltageCode].sort((x, y) => Number(x) - Number(y))[0];

      const a = ss.id < toId ? ss.id : toId;
      const b = ss.id < toId ? toId : ss.id;
      const pairKey = `${a}|${b}|${voltageCode}`;

      const candidates = indices.map((idx, circuitIdx) => {
        const rl = rls[idx] ? parseFloat(rls[idx]) : null;
        const lengthKm =
          Number.isFinite(rl) && rl > 0
            ? rl
            : haversineKm(ss.lat, ss.lng, toSs.lat, toSs.lng);
        const circuitCount = circuitIdx + 1;
        const multi = indices.length >= 2;
        const conductor = conductors[idx] || '';
        const baseName = `${ss.name} – ${toSs.name} (${voltageCode} kV)`;
        const name = multi
          ? `${baseName} · Ckt ${circuitCount}${conductor ? ` · ${conductor}` : ''}`
          : baseName;
        return {
          id: randomUUID(),
          name,
          fromId: ss.id,
          toId,
          voltageCode,
          voltageLevelId: voltageId[voltageCode],
          status: lineStatusFromStyle(styles[idx] || ss.raw.LineStyle),
          lengthKm: Math.round(lengthKm * 1000) / 1000,
          conductor,
          loadingPct: parseLoading(loads[idx]),
          circuitCount,
          circuitConfig: multi ? 'double' : 'single',
        };
      });

      const existing = pairBest.get(pairKey);
      // Prefer the side that lists more circuits (D/C / multi); else keep first.
      if (!existing || candidates.length > existing.length) {
        pairBest.set(pairKey, candidates);
      }
    }
  }

  // Planned double circuits not fully encoded as Target:Target on the sheet
  applyPlannedDoubleCircuits(pairBest, substations, nameIndex);

  const lines = [...pairBest.values()].flat();
  const doubleCircuitPairs = [...pairBest.values()].filter((c) => c.length >= 2).length;

  console.log('── Summary ─────────────────────────');
  console.log(`Sheet rows read:      ${legacy.length}`);
  console.log(`Substations to load:  ${substations.length}`);
  console.log(`Lines to load:        ${lines.length}`);
  console.log(`Double-circuit pairs: ${doubleCircuitPairs}`);
  console.log(`Divisions:            ${divisionNames.length}`);
  console.log(`Broken links skipped: ${skippedLinks}`);
  console.log(`Warnings:             ${warnings.length}`);
  if (warnings.length) {
    console.log('\n── Warnings (first 30) ─────────────');
    warnings.slice(0, 30).forEach((w) => console.log(' •', w));
    if (warnings.length > 30) console.log(` … +${warnings.length - 30} more`);
  }

  // App-shaped seed (IndexedDB / client)
  const seed = {
    importedAt: now,
    seedRevision: 3,
    source: SHEET_CSV_URL,
    orgUnits,
    substations: substations.map((ss) => ({
      id: ss.id,
      name: ss.name,
      status: ss.status,
      voltageCode: ss.voltageCode,
      lat: ss.lat,
      lng: ss.lng,
      orgUnitId: ss.orgUnitId,
      transformers: ss.transformers.map((t, i) => ({
        id: randomUUID(),
        ratingMva: t.ratingMva,
        quantity: t.quantity,
        sequence: i + 1,
      })),
      loadingPct: ss.loadingPct,
      commissionYear: null,
      proposalRef: '',
      remarks: ss.remarks || '',
      owner: '',
      version: 1,
      createdAt: now,
      updatedAt: now,
    })),
    lines: lines.map((line) => ({
      id: line.id,
      name: line.name,
      status: line.status,
      voltageCode: line.voltageCode,
      fromId: line.fromId,
      toId: line.toId,
      circuitCount: line.circuitCount ?? 1,
      circuitConfig: line.circuitConfig ?? 'single',
      conductor: line.conductor || '',
      lengthKm: line.lengthKm,
      loadingPct: line.loadingPct,
      commissionYear: null,
      proposalRef: '',
      remarks: '',
      owner: '',
      version: 1,
    })),
    tapNodes: [],
    tapLaterals: [],
  };

  if (!SKIP_SEED) {
    const dataDir = resolve(root, 'src/data');
    mkdirSync(dataDir, { recursive: true });
    const seedPath = resolve(dataDir, 'legacyNetwork.json');
    writeFileSync(seedPath, JSON.stringify(seed));
    console.log(`\nWrote local seed: ${seedPath}`);
    console.log('App will load this into IndexedDB on next empty/local boot.');
  }

  if (WRITE_SQL) {
    const sqlDir = resolve(root, 'supabase/seed');
    mkdirSync(sqlDir, { recursive: true });
    const parts = [];
    parts.push('-- Legacy Power Map import into powermap schema');
    parts.push('-- Generated by scripts/import-legacy.mjs --sql');
    parts.push('-- Run in Supabase SQL Editor after 004_powermap_schema.sql');
    parts.push('-- Safe to re-run: soft-deletes prior SS/lines, reuses existing org_units by name.');
    parts.push('begin;');
    parts.push('');
    parts.push('-- Soft-delete prior network assets');
    parts.push("update powermap.assets set is_deleted = true where is_deleted = false and asset_kind in ('substation','line','tap_node','tap_lateral');");
    parts.push('');
    parts.push('-- Voltage lookup by code (004 may use different uuids)');
    parts.push('create temporary table _vl (code text primary key, id uuid not null);');
    parts.push("insert into _vl (code, id) select code, id from powermap.voltage_levels;");
    parts.push('');
    parts.push('-- Map seed org ids → live org_units (by name / code). Do NOT re-insert MZO etc.');
    parts.push('create temporary table _org (seed_id uuid primary key, live_id uuid not null);');

    const nameAliases = {
      Gazol: ['Gazol', 'Gazole'],
      'Malda Zone': ['Malda Zone'],
    };

    for (const o of orgUnits) {
      const aliases = nameAliases[o.name] || [o.name];
      const nameIn = aliases.map((n) => sqlStr(n.toLowerCase())).join(', ');
      parts.push(
        `insert into _org (seed_id, live_id) select ${sqlStr(o.id)}, id from powermap.org_units where lower(name) in (${nameIn}) or code = ${sqlStr(o.code)} order by case when lower(name) = lower(${sqlStr(o.name)}) then 0 when code = ${sqlStr(o.code)} then 1 else 2 end limit 1;`,
      );
    }

    // Insert only divisions/zone that are truly missing (no name/code match)
    parts.push('');
    parts.push('-- Insert org units only when no live match exists');
    for (const o of orgUnits) {
      const parentExpr = o.parentId
        ? `coalesce((select live_id from _org where seed_id = ${sqlStr(o.parentId)}), (select id from powermap.org_units where code = 'MZO' limit 1))`
        : 'null';
      parts.push(
        `insert into powermap.org_units (id, parent_id, type, name, code) select ${sqlStr(o.id)}, ${parentExpr}, ${sqlStr(o.type)}, ${sqlStr(o.name)}, ${sqlStr(o.code)} where not exists (select 1 from _org where seed_id = ${sqlStr(o.id)}) and not exists (select 1 from powermap.org_units where code = ${sqlStr(o.code)}) on conflict (code) do nothing;`,
      );
      parts.push(
        `insert into _org (seed_id, live_id) select ${sqlStr(o.id)}, id from powermap.org_units where code = ${sqlStr(o.code)} or id = ${sqlStr(o.id)} on conflict (seed_id) do nothing;`,
      );
    }

    parts.push('');
    parts.push('-- Fallback: any still-unmapped seed org → Malda Zone');
    parts.push(
      `insert into _org (seed_id, live_id) select v.seed_id, z.id from (values ${orgUnits.map((o) => `(${sqlStr(o.id)}::uuid)`).join(', ')}) as v(seed_id) cross join lateral (select id from powermap.org_units where code = 'MZO' limit 1) z where not exists (select 1 from _org o where o.seed_id = v.seed_id) on conflict do nothing;`,
    );
    parts.push('');

    for (const ss of substations) {
      const orgExpr = ss.orgUnitId
        ? `(select live_id from _org where seed_id = ${sqlStr(ss.orgUnitId)})`
        : 'null';
      parts.push(
        `delete from powermap.transformers where substation_asset_id = ${sqlStr(ss.id)};`,
      );
      parts.push(
        `insert into powermap.assets (id, asset_kind, name, status, org_unit_id, remarks, loading_pct, is_deleted) values (${sqlStr(ss.id)}, 'substation', ${sqlStr(ss.name)}, ${sqlStr(ss.status)}, ${orgExpr}, ${sqlStr(ss.remarks || null)}, ${sqlNum(ss.loadingPct)}, false) on conflict (id) do update set name = excluded.name, status = excluded.status, org_unit_id = excluded.org_unit_id, remarks = excluded.remarks, loading_pct = excluded.loading_pct, is_deleted = false;`,
      );
      parts.push(
        `insert into powermap.substations (asset_id, voltage_level_id, lat, lng) values (${sqlStr(ss.id)}, (select id from _vl where code = ${sqlStr(ss.voltageCode)}), ${sqlNum(ss.lat)}, ${sqlNum(ss.lng)}) on conflict (asset_id) do update set voltage_level_id = excluded.voltage_level_id, lat = excluded.lat, lng = excluded.lng;`,
      );
      ss.transformers.forEach((t, i) => {
        parts.push(
          `insert into powermap.transformers (id, substation_asset_id, rating_mva, quantity, sequence) values (${sqlStr(randomUUID())}, ${sqlStr(ss.id)}, ${sqlNum(t.ratingMva)}, ${sqlNum(t.quantity)}, ${i + 1});`,
        );
      });
    }
    parts.push('');

    for (const line of lines) {
      parts.push(
        `insert into powermap.assets (id, asset_kind, name, status, loading_pct, is_deleted) values (${sqlStr(line.id)}, 'line', ${sqlStr(line.name)}, ${sqlStr(line.status)}, ${sqlNum(line.loadingPct)}, false) on conflict (id) do update set name = excluded.name, status = excluded.status, loading_pct = excluded.loading_pct, is_deleted = false;`,
      );
      parts.push(
        `insert into powermap.lines (asset_id, voltage_level_id, from_asset_id, to_asset_id, circuit_count, circuit_config, conductor, length_km) values (${sqlStr(line.id)}, (select id from _vl where code = ${sqlStr(line.voltageCode)}), ${sqlStr(line.fromId)}, ${sqlStr(line.toId)}, ${sqlNum(line.circuitCount ?? 1)}, ${sqlStr(line.circuitConfig ?? 'single')}, ${sqlStr(line.conductor || null)}, ${sqlNum(line.lengthKm)}) on conflict (asset_id) do update set voltage_level_id = excluded.voltage_level_id, from_asset_id = excluded.from_asset_id, to_asset_id = excluded.to_asset_id, circuit_count = excluded.circuit_count, circuit_config = excluded.circuit_config, conductor = excluded.conductor, length_km = excluded.length_km;`,
      );
    }

    parts.push('commit;');
    const sqlPath = resolve(sqlDir, '006_legacy_import.sql');
    writeFileSync(sqlPath, parts.join('\n'));
    console.log(`Wrote SQL seed: ${sqlPath}`);
  }

  if (!APPLY) {
    console.log('\nSafe path complete (local seed).');
    console.log('Cloud API apply skipped — expose schema "powermap" in Supabase first, then:');
    console.log('  npm run import:legacy:apply');
    console.log('Or run the generated SQL in the SQL Editor:');
    console.log('  node scripts/import-legacy.mjs --sql');
    return;
  }

  // ── APPLY via API (requires Exposed schemas = powermap) ──
  const env = loadEnv();
  const url = env.VITE_SUPABASE_URL;
  const key = env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env');
    process.exit(1);
  }
  const pm = createClient(url, key, { db: { schema: 'powermap' } });

  console.log('\nApplying to powermap via API…');
  const { data: voltages, error: vErr } = await pm.from('voltage_levels').select('id, code');
  if (vErr) {
    console.error('powermap not reachable via API:', vErr.message);
    console.error('Fix: Supabase → Settings → API → Exposed schemas → add "powermap"');
    console.error('Meanwhile local seed is ready; or use --sql and run in SQL Editor.');
    process.exit(1);
  }
  const liveVoltageId = Object.fromEntries((voltages || []).map((v) => [v.code, v.id]));

  const { error: softErr } = await pm
    .from('assets')
    .update({ is_deleted: true })
    .eq('is_deleted', false);
  if (softErr) console.warn('soft-delete:', softErr.message);

  for (const o of orgUnits) {
    const { error } = await pm.from('org_units').upsert({
      id: o.id,
      parent_id: o.parentId,
      type: o.type,
      name: o.name,
      code: o.code,
    });
    if (error) warnings.push(`org ${o.name}: ${error.message}`);
  }

  let ssOk = 0;
  for (const ss of substations) {
    const { error: aErr } = await pm.from('assets').insert({
      id: ss.id,
      asset_kind: 'substation',
      name: ss.name,
      status: ss.status,
      org_unit_id: ss.orgUnitId,
      remarks: ss.remarks || null,
      loading_pct: ss.loadingPct,
    });
    if (aErr) {
      warnings.push(`asset ${ss.name}: ${aErr.message}`);
      continue;
    }
    const { error: sErr } = await pm.from('substations').insert({
      asset_id: ss.id,
      voltage_level_id: liveVoltageId[ss.voltageCode],
      lat: ss.lat,
      lng: ss.lng,
    });
    if (sErr) {
      warnings.push(`substation ${ss.name}: ${sErr.message}`);
      continue;
    }
    const xfmrRows = ss.transformers.map((t, i) => ({
      id: randomUUID(),
      substation_asset_id: ss.id,
      rating_mva: t.ratingMva,
      quantity: t.quantity,
      sequence: i + 1,
    }));
    await pm.from('transformers').insert(xfmrRows);
    ssOk++;
  }

  let lineOk = 0;
  for (const line of lines) {
    const { error: aErr } = await pm.from('assets').insert({
      id: line.id,
      asset_kind: 'line',
      name: line.name,
      status: line.status,
      loading_pct: line.loadingPct,
    });
    if (aErr) {
      warnings.push(`line asset: ${aErr.message}`);
      continue;
    }
    const { error: lErr } = await pm.from('lines').insert({
      asset_id: line.id,
      voltage_level_id: liveVoltageId[line.voltageCode],
      from_asset_id: line.fromId,
      to_asset_id: line.toId,
      circuit_count: line.circuitCount ?? 1,
      circuit_config: line.circuitConfig ?? 'single',
      conductor: line.conductor || null,
      length_km: line.lengthKm,
    });
    if (lErr) {
      warnings.push(`line: ${lErr.message}`);
      continue;
    }
    lineOk++;
  }

  console.log('\n── Applied ──────────────────────────');
  console.log(`Substations inserted: ${ssOk}`);
  console.log(`Lines inserted:       ${lineOk}`);
  console.log(`Warnings total:       ${warnings.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
