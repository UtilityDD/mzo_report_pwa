const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const url =
  'https://docs.google.com/spreadsheets/d/1wDvPuAxNfdO9QzUaIUubg2JnkFM5ZleFNXQdi8s5uh0/export?format=csv&gid=696716331';

function normalizeCategory(v) {
  const cat = String(v || '').trim().toUpperCase();
  if (/central/i.test(cat) || cat === 'C') return 'CENTRAL';
  if (/local/i.test(cat) || cat === 'L') return 'LOCAL';
  if (cat === 'CENTRAL' || cat === 'LOCAL') return cat;
  return '';
}

(async () => {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = await res.text();
  const wb = XLSX.read(text, { type: 'string' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });

  const map = {};
  let central = 0;
  let local = 0;
  let other = 0;
  for (const row of rows) {
    const code = String(row['Mat Code'] || row['Material'] || row['Material Code'] || '').trim();
    if (!code) continue;
    const cat = normalizeCategory(row['Category'] || row['Cat'] || '');
    if (!cat) {
      other++;
      continue;
    }
    map[code] = cat;
    if (cat === 'CENTRAL') central++;
    else local++;
  }

  const json = JSON.stringify(map, null, 2);

  const libPath = path.join(__dirname, '..', 'lib', 'stock_material_category.js');
  fs.writeFileSync(
    libPath,
    [
      '/**',
      ' * Fixed Material code → Category (LOCAL / CENTRAL).',
      ' * Sourced from stock metadata; edit this file when categories change.',
      ' * Regenerate: node scripts/generate_stock_material_category.js',
      ' */',
      "'use strict';",
      '',
      'const STOCK_MATERIAL_CATEGORY = ' + json + ';',
      '',
      'function lookupStockCategory(materialCode) {',
      "  const code = String(materialCode || '').trim();",
      "  if (!code) return '';",
      '  if (STOCK_MATERIAL_CATEGORY[code]) return STOCK_MATERIAL_CATEGORY[code];',
      "  const stripped = code.replace(/^0+/, '');",
      '  if (stripped && STOCK_MATERIAL_CATEGORY[stripped]) return STOCK_MATERIAL_CATEGORY[stripped];',
      "  return '';",
      '}',
      '',
      'module.exports = { STOCK_MATERIAL_CATEGORY, lookupStockCategory };',
      ''
    ].join('\n'),
    'utf8'
  );

  const browserPath = path.join(__dirname, '..', 'stock', 'stock_material_category.js');
  fs.writeFileSync(
    browserPath,
    [
      '/**',
      ' * Fixed Material code → Category (LOCAL / CENTRAL).',
      ' * Keep in sync with lib/stock_material_category.js',
      ' * Regenerate: node scripts/generate_stock_material_category.js',
      ' */',
      '(function (global) {',
      "  'use strict';",
      '  const STOCK_MATERIAL_CATEGORY = ' + json + ';',
      '  function lookupStockCategory(materialCode) {',
      "    const code = String(materialCode || '').trim();",
      "    if (!code) return '';",
      '    if (STOCK_MATERIAL_CATEGORY[code]) return STOCK_MATERIAL_CATEGORY[code];',
      "    const stripped = code.replace(/^0+/, '');",
      '    if (stripped && STOCK_MATERIAL_CATEGORY[stripped]) return STOCK_MATERIAL_CATEGORY[stripped];',
      "    return '';",
      '  }',
      '  global.STOCK_MATERIAL_CATEGORY = STOCK_MATERIAL_CATEGORY;',
      '  global.lookupStockCategory = lookupStockCategory;',
      '})(typeof window !== "undefined" ? window : globalThis);',
      ''
    ].join('\n'),
    'utf8'
  );

  console.log('codes', Object.keys(map).length, 'central', central, 'local', local, 'other_skipped', other);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
