/**
 * Browser-side stock Excel → cleaned CSV (mirrors lib/stock_pipeline.js).
 * Category comes from hardcoded stock_material_category.js (lookupStockCategory).
 */
(function (global) {
  'use strict';

  const OUTPUT_COLUMNS = [
    'Plant', 'Name 1', 'Material Type', 'Material', 'Material Description', 'Material Group',
    'Storage Location', 'Descr. of Storage Loc.', 'Base Unit of Measure', 'Unrestricted',
    'Stock in Transit', 'Transit and Transfer', 'Store', 'Category', 'Date'
  ];

  const HEADER_ALIASES = {
    plant: 'Plant',
    'name 1': 'Name 1',
    'material type': 'Material Type',
    material: 'Material',
    'material description': 'Material Description',
    'material group': 'Material Group',
    'storage location': 'Storage Location',
    'descr. of storage loc.': 'Descr. of Storage Loc.',
    'descr of storage loc': 'Descr. of Storage Loc.',
    'base unit of measure': 'Base Unit of Measure',
    unrestricted: 'Unrestricted',
    'stock in transit': 'Stock in Transit',
    'transit and transfer': 'Transit and Transfer',
    store: 'Store',
    date: 'Date'
  };

  function cellStr(v) {
    if (v == null || v === '') return '';
    if (v instanceof Date && !isNaN(v.getTime())) {
      return `${v.getMonth() + 1}/${v.getDate()}/${v.getFullYear()}`;
    }
    const s = String(v).trim();
    if (!s || /^\(?null\)?$/i.test(s) || s.toLowerCase() === 'undefined') return '';
    return s;
  }

  function formatDateDMY(d) {
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${d.getFullYear()}`;
  }

  function formatDateMDY(d) {
    return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  }

  function parseManualReportDate(raw) {
    if (raw instanceof Date && !isNaN(raw.getTime())) return raw;
    const s = String(raw || '').trim();
    if (!s) return null;
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) {
      const d = new Date(parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10));
      return isNaN(d.getTime()) ? null : d;
    }
    const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (m) {
      let a = parseInt(m[1], 10);
      let b = parseInt(m[2], 10);
      let y = parseInt(m[3], 10);
      if (y < 100) y += 2000;
      const d = new Date(y, b - 1, a);
      return isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  function normalizeHeader(h) {
    return String(h || '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function mapRow(raw) {
    const mapped = {};
    Object.keys(raw || {}).forEach((k) => {
      const canon = HEADER_ALIASES[normalizeHeader(k)];
      if (canon) mapped[canon] = raw[k];
    });
    return mapped;
  }

  function pickDataSheetName(workbook) {
    const names = workbook.SheetNames || [];
    const sheet1 = names.find((n) => /^sheet\s*1$/i.test(String(n).trim()));
    if (sheet1) return sheet1;
    const prefer = names.find((n) => /stock|sap|dump/i.test(n));
    return prefer || names[0];
  }

  function toCsv(rows) {
    const header = OUTPUT_COLUMNS.join(',');
    const lines = rows.map((row) =>
      OUTPUT_COLUMNS.map((col) => {
        const val = String(row[col] == null ? '' : row[col]);
        if (/[",\n\r]/.test(val)) return `"${val.replace(/"/g, '""')}"`;
        return val;
      }).join(',')
    );
    return [header, ...lines].join('\n');
  }

  function processStockArrayBuffer(arrayBuffer, reportDateInput, fileName) {
    if (typeof XLSX === 'undefined') {
      throw new Error('SheetJS (XLSX) failed to load. Check network / CDN.');
    }
    const reportDate = parseManualReportDate(reportDateInput);
    if (!reportDate) throw new Error('Invalid report date. Use YYYY-MM-DD.');

    const workbook = XLSX.read(arrayBuffer, { type: 'array', cellDates: true, raw: false });
    const sheetName = pickDataSheetName(workbook);
    if (!sheetName) throw new Error('No worksheet found in workbook.');
    const sheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
    if (!rawRows.length) throw new Error('Sheet "' + sheetName + '" has no data rows.');

    const dateStr = formatDateMDY(reportDate);
    const published = [];
    let skippedNoGroup = 0;
    let withCategory = 0;
    const lookup =
      typeof global.lookupStockCategory === 'function' ? global.lookupStockCategory : function () { return ''; };

    for (const raw of rawRows) {
      const m = mapRow(raw);
      const group = cellStr(m['Material Group']);
      const material = cellStr(m.Material);
      if (!group || !material) {
        skippedNoGroup += 1;
        continue;
      }
      const category = lookup(material) || '';
      if (category) withCategory += 1;
      published.push({
        Plant: cellStr(m.Plant),
        'Name 1': cellStr(m['Name 1']),
        'Material Type': cellStr(m['Material Type']),
        Material: material,
        'Material Description': cellStr(m['Material Description']),
        'Material Group': group,
        'Storage Location': cellStr(m['Storage Location']),
        'Descr. of Storage Loc.': cellStr(m['Descr. of Storage Loc.']),
        'Base Unit of Measure': cellStr(m['Base Unit of Measure']),
        Unrestricted: cellStr(m.Unrestricted).replace(/,/g, ''),
        'Stock in Transit': cellStr(m['Stock in Transit']).replace(/,/g, ''),
        'Transit and Transfer': cellStr(m['Transit and Transfer']).replace(/,/g, ''),
        Store: cellStr(m.Store),
        Category: category,
        Date: dateStr
      });
    }

    if (!published.length) {
      throw new Error('No valid stock rows found (need Material + Material Group on Sheet1).');
    }

    return {
      sheetName,
      published,
      csv: toCsv(published),
      reportDateUsed: formatDateDMY(reportDate),
      originalName: fileName || '',
      stats: {
        rawRows: rawRows.length,
        publishedRows: published.length,
        skippedRows: skippedNoGroup,
        rowsWithCategory: withCategory,
        today: formatDateDMY(reportDate)
      }
    };
  }

  global.StockClientPipeline = {
    processStockArrayBuffer,
    parseManualReportDate,
    OUTPUT_COLUMNS,
    toCsv
  };
})(typeof window !== 'undefined' ? window : globalThis);
