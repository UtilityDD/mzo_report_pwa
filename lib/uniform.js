/* lib/uniform.js: one dataset's source bytes → uniform rows. Shared by the browser (window.MzoUniform,
 * also inside a Web Worker) and Node (require), so the VM sync and the pages compute byte-identical
 * output from the same input.
 *
 *   build(input, opts) → { key, version, logic, schema, columns, rows, issues, stats }
 *     input  CSV/TSV text, a JSON array of objects (Supabase rows), or an array of string arrays
 *     opts   { key, version, format: 'csv'|'tsv'|'json', schema, offices, header, dateOrder, columnTypes }
 *   stringify(result)  the canonical JSON text of a result (what /api/data/rows/:key serves)
 *   objects(result)    rows as plain objects keyed by column name
 *   parseText(text, delimiter, quote)   CSV/TSV → string[][] (same cells as UI.csv)
 *   fieldNames(headers) · baseName(header) · parseNumber(s) · parseDate(s) · schemaHash(schema)
 *
 * Output rules (docs/uniform-data.md):
 *   names    source headers → snake_case ASCII, exactly as the PocketBase mirror names them
 *            (lowercase; non-alphanumerics → "_"; "c_" before a digit; id → id_2; dedupe _2, _3)
 *   text     trimmed string, '' when empty
 *   number   a JS number, null when empty (Indian and Western grouping commas allowed)
 *   date     'YYYY-MM-DD'; with a time 'YYYY-MM-DDTHH:MM:SS' (the sheet's wall clock, no zone);
 *            a value that carried a zone → UTC 'YYYY-MM-DDTHH:MM:SS.sssZ'; null when empty
 *   bool     true / false / null (Y/N, Yes/No, true/false)
 *   json     the value (Supabase json columns)
 *   A typed column keeps values that do not parse in a "<name>_raw" text column; the typed value is
 *   null there. '(null)', 'NA', '#N/A', '-' … count as empty in typed columns and stay as text in
 *   text columns. Identifier columns (…_no, …_id, …_code, phone, mobile …) stay text.
 *   offices  _region, _division, _ccc_code, _ccc from lib/offices.js ('' when unknown)
 *
 * Type inference uses the mirror's thresholds (vm/sync/lib/infer.js): number or date when ≥ 98 %
 * of the non-empty values parse; dd/mm vs mm/dd chosen by which reading parses more values.
 * A dataset's schema file (schema/<key>.json) pins the names and types pages rely on.
 *
 * No dependencies and no Node-only APIs; nothing here depends on the time zone or the locale.
 */
(function (root, factory) {
  'use strict';
  var api = factory(function () {
    if (root && root.MzoOffices) return root.MzoOffices;
    if (typeof module === 'object' && module.exports && typeof require === 'function') {
      try { return require('./offices.js'); } catch (e) { return null; }
    }
    return null;
  });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MzoUniform = api;
})(typeof self !== 'undefined' ? self : this, function (defaultOffices) {
  'use strict';

  // Bump on any change that alters output for the same input: cached and precomputed rows are
  // keyed by it, so every device and the VM recompute once.
  var VERSION = 'uniform/1';
  var THRESHOLD = 0.98;
  var MAX_FIELD_NAME = 60;
  var MEMO_LIMIT = 4096; // distinct values remembered per column

  /* ------------------------------------------------------------------ names */

  // Same reserved set as the mirror (vm/sync/lib/normalise.js): PocketBase record and auth names.
  var SYSTEM_FIELDS = ['_row_key', '_row_no', '_synced_at', '_hash'];
  var RESERVED = ['id', 'created', 'updated', 'collectionid', 'collectionname', 'expand', 'fields',
    'password', 'tokenkey', 'email', 'emailvisibility', 'verified'].concat(SYSTEM_FIELDS);
  var OFFICE_FIELDS = ['_region', '_division', '_ccc_code', '_ccc'];

  function columnLetter(index) {
    var n = index + 1, s = '';
    while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(97 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  function cleanHeader(raw) {
    return String(raw == null ? '' : raw).replace(/^﻿/, '').replace(/\s+/g, ' ').trim();
  }

  function baseName(sourceName, index) {
    var s = String(sourceName || '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!s) s = 'col_' + columnLetter(index || 0);
    if (/^[0-9]/.test(s)) s = 'c_' + s;
    if (s.length > MAX_FIELD_NAME) s = s.slice(0, MAX_FIELD_NAME).replace(/_+$/g, '');
    return s;
  }

  function uniqueName(name, taken) {
    var out = name, n = 2;
    while (taken.has(out)) {
      var suffix = '_' + n++;
      out = name.slice(0, MAX_FIELD_NAME - suffix.length) + suffix;
    }
    taken.add(out);
    return out;
  }

  /** Unique field names for a header row (indexes: spreadsheet column of each, for empty headers). */
  function fieldNames(sourceNames, indexes) {
    var taken = new Set(RESERVED);
    return sourceNames.map(function (name, i) { return uniqueName(baseName(name, indexes ? indexes[i] : i), taken); });
  }

  // Identifier-like names stay text even when every value is digits: leading zeros, joins and
  // search keep working (no_of_poles is a count, so only a trailing token counts).
  var ID_NAME = /(^|_)(no|nos|id|empid|code|number|num|phone|mobile|mob|contact|pin|pincode|mru|won|account|acc_no|ifsc)(_\d+)?$/;
  // Counts and amounts stay numbers even when the name ends like an id (count_of_doc_no, subsidy_amount_..._account).
  var NOT_ID_NAME = /(^|_)(count|amount|amt|total|sum|qty)(_|$)/;
  function isIdName(base) { return ID_NAME.test(base) && !/^(c_)?\d/.test(base) && !NOT_ID_NAME.test(base); }

  /* ------------------------------------------------------------------ CSV / TSV */

  /**
   * CSV (quote = true) or TSV (quote = false) text → rows of cells, the same cells UI.csv reads:
   * a quote anywhere outside quotes opens a quoted run, "" inside one is a quote, CR, LF and CRLF
   * end a row, and a row that is a single empty cell is skipped. Cells are not trimmed here.
   * onRow(cells) gets each row (the array is reused: copy what you keep).
   */
  function eachRow(text, delimiter, quote, onRow) {
    text = String(text == null ? '' : text);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    var d = delimiter || ',', dc = d === '\t' ? '\\t' : '\\' + d;
    var re = new RegExp('[' + dc + '\\r\\n' + (quote === false ? '' : '"') + ']', 'g');
    var row = [], f = '', i = 0, n = text.length, m, c, j;
    while (i < n) {
      re.lastIndex = i;
      m = re.exec(text);
      if (!m) { f += text.slice(i); i = n; break; }
      j = m.index;
      if (j > i) f += text.slice(i, j);
      c = text.charCodeAt(j);
      if (c === 34) {
        // quoted run: up to the closing quote; "" is a literal quote
        i = j + 1;
        for (;;) {
          var k = text.indexOf('"', i);
          if (k < 0) { f += text.slice(i); i = n; break; }
          if (text.charCodeAt(k + 1) === 34) { f += text.slice(i, k + 1); i = k + 2; continue; }
          f += text.slice(i, k); i = k + 1; break;
        }
      } else if (c === 10 || c === 13) {
        row.push(f); f = '';
        if (row.length > 1 || row[0] !== '') onRow(row);
        row.length = 0;
        i = (c === 13 && text.charCodeAt(j + 1) === 10) ? j + 2 : j + 1;
      } else {
        row.push(f); f = ''; i = j + 1;
      }
    }
    if (f !== '' || row.length) { row.push(f); onRow(row); }
  }

  /** eachRow → string[][] */
  function parseText(text, delimiter, quote) {
    var rows = [];
    eachRow(text, delimiter, quote, function (r) { rows.push(r.slice()); });
    return rows;
  }

  /* ------------------------------------------------------------------ values */

  // Plain, Western-grouped (1,234,567) or Indian-grouped (12,34,567) numbers (vm/sync/lib/infer.js).
  var NUM_RE = /^-?(?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})+,\d{3}|\d+)?(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
  // Placeholders for "no value": empty in typed columns, kept as text in text columns.
  var NULL_RE = /^(\(null\)|null|#n\/a|n\/a|na|nil|none|-+|\.)$/i;

  function parseNumber(s) {
    if (!s || !NUM_RE.test(s) || !/\d/.test(s)) return null;
    var mantissa = s.replace(/^-/, '').split(/[eE]/)[0];
    var intPart = mantissa.split('.')[0].replace(/,/g, '');
    if (intPart.length > 1 && intPart[0] === '0') return null;
    if (mantissa.replace(/[^0-9]/g, '').replace(/^0+/, '').length > 15) return null;
    var v = Number(s.replace(/,/g, ''));
    return isFinite(v) ? v : null;
  }

  var MONTHS = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
    jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };
  var ISO_RE = /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|z|[+-]\d{2}:?\d{2})?)?$/;
  var DMY_RE = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp])\.?[Mm]\.?)?)?$/;
  var DMONY_RE = /^(\d{1,2})[-\s/]([A-Za-z]{3,9})\.?[-\s/,]+(\d{4}|\d{2})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp])\.?[Mm]\.?)?)?$/;
  var MONDY_RE = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp])\.?[Mm]\.?)?)?$/;

  function daysInMonth(y, m) { return [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]; }
  function validDate(y, m, d) { return y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m); }
  function hour24(h, ampm) {
    if (!ampm) return h;
    var pm = /p/i.test(ampm);
    if (h < 1 || h > 12) return NaN;
    if (h === 12) return pm ? 12 : 0;
    return pm ? h + 12 : h;
  }
  function pad(n, w) { var s = String(n); while (s.length < (w || 2)) s = '0' + s; return s; }

  /** Calendar parts → output string, or null when invalid. time = [hh, mi, ss, frac] or null. */
  function dateString(y, m, d, time, tz) {
    if (!validDate(y, m, d)) return null;
    var day = pad(y, 4) + '-' + pad(m) + '-' + pad(d);
    if (!time) return day;
    var hh = time[0], mi = time[1], ss = time[2], frac = time[3];
    if (!(hh >= 0 && hh <= 23 && mi >= 0 && mi <= 59 && ss >= 0 && ss <= 59)) return null;
    var ms = frac ? String(frac + '00').slice(0, 3) : '';
    if (tz) {
      var off = 0;
      if (tz !== 'Z' && tz !== 'z') {
        var t = /^([+-])(\d{2}):?(\d{2})$/.exec(tz);
        if (!t) return null;
        off = (Number(t[2]) * 60 + Number(t[3])) * 60000 * (t[1] === '+' ? 1 : -1);
      }
      return new Date(Date.UTC(y, m - 1, d, hh, mi, ss, ms ? Number(ms) : 0) - off).toISOString();
    }
    return day + 'T' + pad(hh) + ':' + pad(mi) + ':' + pad(ss) + (ms ? '.' + ms : '');
  }

  function timeParts(h, mi, s, ampm, frac) {
    if (h === undefined) return null;
    return [hour24(Number(h), ampm), Number(mi), Number(s || 0), frac];
  }

  /**
   * A trimmed string → null, or { dmy, mdy, time }: the output string under day-first and
   * month-first readings (equal for unambiguous formats; null where that reading is invalid).
   * Accepts the formats of vm/sync/lib/infer.js with the same validity rules.
   */
  function parseDate(s) {
    if (!s || s.length < 6 || s.length > 40) return null;
    var m = ISO_RE.exec(s), out;
    if (m) {
      out = dateString(+m[1], +m[3], +m[4], timeParts(m[5], m[6], m[7], null, m[8]), m[9]);
      return out === null ? null : { dmy: out, mdy: out, time: m[5] !== undefined };
    }
    m = DMY_RE.exec(s);
    if (m) {
      var a = +m[1], b = +m[3], y = +m[4], t = timeParts(m[5], m[6], m[7], m[8]);
      var dmy = dateString(y, b, a, t), mdy = m[2] === '/' ? dateString(y, a, b, t) : null; // only slashes are month-first anywhere
      if (dmy === null && mdy === null) return null;
      return { dmy: dmy, mdy: mdy, time: !!t };
    }
    m = DMONY_RE.exec(s);
    if (m) {
      var mon = MONTHS[m[2].toLowerCase()];
      if (!mon) return null;
      var yy = +m[3];
      if (m[3].length === 2) yy += 2000;
      out = dateString(yy, mon, +m[1], timeParts(m[4], m[5], m[6], m[7]));
      return out === null ? null : { dmy: out, mdy: out, time: m[4] !== undefined };
    }
    m = MONDY_RE.exec(s);
    if (m) {
      var mon2 = MONTHS[m[1].toLowerCase()];
      if (!mon2) return null;
      out = dateString(+m[3], mon2, +m[2], timeParts(m[4], m[5], m[6], m[7]));
      return out === null ? null : { dmy: out, mdy: out, time: m[4] !== undefined };
    }
    return null;
  }

  var BOOL_TRUE = { y: 1, yes: 1, 'true': 1 };
  var BOOL_FALSE = { n: 1, no: 1, 'false': 1 };

  /* ------------------------------------------------------------------ columns */

  /** Counters over one column (memoised per distinct value). */
  function stats(values) {
    var st = { nonEmpty: 0, nulls: 0, num: 0, dmy: 0, mdy: 0, time: 0, bool: 0, json: 0 };
    var memo = new Map();
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (v === '' || v === null || v === undefined) continue;
      if (typeof v === 'number') { st.nonEmpty++; st.num++; continue; }
      if (typeof v === 'boolean') { st.nonEmpty++; st.bool++; continue; }
      if (typeof v === 'object') { st.nonEmpty++; st.json++; continue; }
      var c = memo.get(v);
      if (c === undefined) {
        c = classify(v);
        if (memo.size < MEMO_LIMIT) memo.set(v, c);
      }
      if (c === 'null') { st.nulls++; continue; }
      st.nonEmpty++;
      if (c === 'num') st.num++;
      else if (c === 'bool') st.bool++;
      else if (c) {
        if (c.dmy !== null) st.dmy++;
        if (c.mdy !== null) st.mdy++;
        if (c.time) st.time++;
      }
    }
    return st;
  }

  function classify(s) {
    if (NULL_RE.test(s)) return 'null';
    if (parseNumber(s) !== null) return 'num';
    var d = parseDate(s);
    if (d) return d;
    var low = s.toLowerCase();
    if (BOOL_TRUE[low] || BOOL_FALSE[low]) return 'bool';
    return '';
  }

  /** Column type: pinned (schema) → override → inference. prefer = 'dmy' | 'mdy'. */
  function chooseType(st, pinned, prefer, idName) {
    var n = st.nonEmpty;
    if (pinned) {
      if (pinned === 'date') return { type: 'date', order: prefer === 'mdy' || (!prefer && st.mdy > st.dmy) ? 'mdy' : 'dmy' };
      return { type: pinned };
    }
    if (n === 0) return { type: 'text' };
    if (st.json === n) return { type: 'json' };
    if (st.json > 0) return { type: 'text' };
    if (idName) return { type: 'text' };
    if (st.bool === n) return { type: 'bool' };
    var need = THRESHOLD * n;
    if (st.num >= need) return { type: 'number' };
    var best = Math.max(st.dmy, st.mdy);
    if (best >= need) {
      var order;
      if (st.dmy === st.mdy) order = prefer === 'mdy' ? 'mdy' : 'dmy';
      else order = st.dmy > st.mdy ? 'dmy' : 'mdy';
      return { type: 'date', order: order };
    }
    return { type: 'text' };
  }

  /** Convert one column: → { values, raw (array or null), bad } */
  function convertColumn(values, type, order) {
    var out = new Array(values.length), raw = null, bad = 0, memo = new Map();
    function keep(i, s) { if (!raw) { raw = new Array(values.length); for (var k = 0; k < values.length; k++) raw[k] = ''; } raw[i] = s; bad++; }
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (type === 'text') {
        out[i] = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
        continue;
      }
      if (type === 'json') {
        if (v === '' || v === null || v === undefined) { out[i] = null; continue; }
        if (typeof v === 'string' && /^[[{]/.test(v)) { try { out[i] = JSON.parse(v); continue; } catch (e) {} }
        out[i] = v;
        continue;
      }
      if (v === '' || v === null || v === undefined) { out[i] = null; continue; }
      if (type === 'number' && typeof v === 'number') { out[i] = isFinite(v) ? v : null; if (!isFinite(v)) keep(i, String(v)); continue; }
      if (type === 'bool' && typeof v === 'boolean') { out[i] = v; continue; }
      var s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
      var r = memo.get(s);
      if (r === undefined) {
        if (NULL_RE.test(s)) r = null;
        else if (type === 'number') r = parseNumber(s);
        else if (type === 'date') { var d = parseDate(s); r = d ? (order === 'mdy' ? d.mdy : d.dmy) : null; }
        else if (type === 'bool') { var low = s.toLowerCase(); r = BOOL_TRUE[low] ? true : BOOL_FALSE[low] ? false : null; }
        if (r === null && !NULL_RE.test(s)) r = undefined; // does not parse
        if (memo.size < MEMO_LIMIT) memo.set(s, r === undefined ? '\u0000bad' : r);
      } else if (r === '\u0000bad') r = undefined;
      if (r === undefined) { out[i] = null; keep(i, s); } else out[i] = r;
    }
    return { values: out, raw: raw, bad: bad };
  }

  /* ------------------------------------------------------------------ schema */

  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    var keys = Object.keys(v).filter(function (k) { return v[k] !== undefined; }).sort();
    return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + stableStringify(v[k]); }).join(',') + '}';
  }

  /** FNV-1a 32-bit over UTF-16 code units, as 8 hex digits: identical in every engine. */
  function hash32(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  /** The schema's identity: the parts that change output (not label, notes or source). */
  function schemaHash(schema) {
    if (!schema) return '';
    var s = {};
    ['fields', 'keep', 'header', 'header_row', 'skip_rows', 'date_order', 'offices', 'format'].forEach(function (k) { if (schema[k] !== undefined) s[k] = schema[k]; });
    return hash32(stableStringify(s));
  }

  /* ------------------------------------------------------------------ offices */

  var officeState = { mod: null, costCentres: 0 };
  /** Use this office module (lib/offices.js) and optionally load old SAP cost centres (data/costcenter.json). */
  function useOffices(mod, costCentres) {
    officeState.mod = mod || null;
    officeState.costCentres = 0;
    if (mod && costCentres && typeof mod.addCostCentres === 'function') officeState.costCentres = mod.addCostCentres(costCentres) || 0;
    return officeState.costCentres;
  }
  function officesModule(opts) {
    if (opts && opts.offices !== undefined) return opts.offices;
    if (!officeState.mod) officeState.mod = defaultOffices();
    return officeState.mod;
  }
  function officesTag(mod) {
    if (!mod) return 'none';
    return (mod.VERSION || 'offices') + (typeof mod.fingerprint === 'function' ? ':' + mod.fingerprint() : '+cc' + officeState.costCentres);
  }

  /* ------------------------------------------------------------------ build */

  function cleanValue(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number') return isFinite(v) ? v : String(v);
    return v;
  }

  /**
   * Feed every source row to a collector that keeps one array per column (no row arrays):
   * values trimmed, all-blank rows dropped, the header row (and skip_rows after it) taken out.
   * → { head: string[], values: any[][] (per column), n, sourceRows }
   */
  function collect(input, opts, header, headerRow, skipRows) {
    var head = [], values = [], n = 0, seen = 0, at = -1;
    var skip = skipRows && skipRows.length ? new Set(skipRows) : null;
    var buf = [];
    function onRow(cells) {
      at++;
      if (header && at < headerRow) return;
      if (header && at === headerRow) { head = cells.slice(); return; }
      if (skip && skip.has(seen++)) return;
      if (!skip) seen++;
      var last = -1, len = cells.length;
      for (var c = 0; c < len; c++) { var v = cleanValue(cells[c]); buf[c] = v; if (v !== '') last = c; }
      if (last < 0) return;
      while (values.length <= last) { var col = new Array(n); for (var z = 0; z < n; z++) col[z] = ''; values.push(col); }
      for (var k = 0; k < values.length; k++) values[k].push(k <= last ? buf[k] : '');
      n++;
    }
    if (Array.isArray(input)) {
      if (input.length && !Array.isArray(input[0]) && typeof input[0] === 'object') {
        // JSON array of objects: columns in first-seen key order, the keys are the header
        var keys = [], pos = new Map(), row = [];
        input.forEach(function (o) {
          if (!o || typeof o !== 'object') return;
          for (var key in o) if (Object.prototype.hasOwnProperty.call(o, key) && !pos.has(key)) { pos.set(key, keys.length); keys.push(key); }
        });
        header = true; headerRow = 0;
        onRow(keys);
        input.forEach(function (o) {
          if (!o || typeof o !== 'object') return;
          row.length = keys.length;
          for (var i = 0; i < keys.length; i++) row[i] = Object.prototype.hasOwnProperty.call(o, keys[i]) ? o[keys[i]] : '';
          onRow(row);
        });
      } else input.forEach(function (r) { onRow(r || []); });
    } else {
      var fmt = (opts && opts.format) || 'csv';
      if (fmt === 'json') return collect(JSON.parse(String(input)), opts, header, headerRow, skipRows);
      eachRow(input, fmt === 'tsv' ? '\t' : ',', fmt !== 'tsv', onRow);
    }
    return { head: head, values: values, n: n, sourceRows: seen };
  }

  /**
   * @param input  text | object[] | string[][]
   * @param opts   key, version (opaque, echoed), format, schema (schema/<key>.json), offices (module or
   *               null to skip), header (false: no header row, columns col_a…), dateOrder ('dmy'|'mdy'),
   *               columnTypes ({ <source header or field name>: type } overrides, as on a sync source)
   */
  function build(input, opts) {
    opts = opts || {};
    var schema = opts.schema || null;
    var fields = (schema && schema.fields) || {};
    var keep = (schema && schema.keep) || 'all';
    var header = schema && schema.header === false ? false : opts.header !== false;
    var headerRow = (schema && schema.header_row) || 0;
    var prefer = (schema && schema.date_order) || opts.dateOrder || null;
    var overrides = opts.columnTypes || {};
    var issues = [];

    var got = collect(input, opts, header, headerRow, schema && schema.skip_rows);
    var nRows = got.n, width = Math.max(got.head.length, got.values.length);

    // columns: source names, field names, values; padding (no header, no values) dropped
    var cols = [];
    for (var ci = 0; ci < width; ci++) {
      var sname = header ? cleanHeader(got.head[ci]) : '';
      var colVals = got.values[ci];
      if (!colVals) { if (sname === '' && header) continue; colVals = new Array(nRows); for (var z = 0; z < nRows; z++) colVals[z] = ''; }
      else if (sname === '' && header) { var any = false; for (var ri = 0; ri < nRows && !any; ri++) if (colVals[ri] !== '') any = true; if (!any) continue; }
      cols.push({ source_name: sname, index: ci, values: colVals });
    }
    var names = fieldNames(cols.map(function (c) { return c.source_name; }), cols.map(function (c) { return c.index; }));
    cols.forEach(function (c, i) { c.name = names[i]; c.base = baseName(c.source_name, c.index); });

    // schema: aliases for renamed headers, then missing pinned fields
    var byName = new Map();
    cols.forEach(function (c) { byName.set(c.name, c); });
    var pinnedNames = Object.keys(fields);
    pinnedNames.forEach(function (f) {
      if (byName.has(f)) return;
      var al = (fields[f] && fields[f].aliases) || [];
      for (var a = 0; a < al.length; a++) {
        var want = baseName(al[a], 0), hit = null;
        cols.forEach(function (c) { if (!hit && (c.name === want || c.base === want || c.source_name === al[a]) && !fields[c.name]) hit = c; });
        if (hit) {
          byName.delete(hit.name);
          issues.push({ check: 'header.alias', column: f, count: 1, sample: [hit.source_name] });
          hit.name = f; byName.set(f, hit);
          return;
        }
      }
    });

    // offices: resolved from the source cells before columns are pruned
    var offices = officesModule(opts), officeVals = null;
    if (offices && (schema ? schema.offices !== false : true)) officeVals = resolveOffices(offices, opts.key, schema, cols, nRows, issues);

    var out = [];
    cols.forEach(function (c) { if (keep !== 'pinned' || fields[c.name]) out.push(c); });
    pinnedNames.forEach(function (f) {
      if (byName.has(f)) return;
      issues.push({ check: 'header.missing', column: f, count: nRows, sample: [] });
      var blank = new Array(nRows); for (var i = 0; i < nRows; i++) blank[i] = '';
      out.push({ source_name: '', index: -1, values: blank, name: f, base: f, missing: true });
    });

    // types and values
    var taken = new Set(RESERVED.concat(out.map(function (c) { return c.name; })).concat(OFFICE_FIELDS));
    var columns = [], data = [];
    out.forEach(function (c) {
      var pin = fields[c.name] && fields[c.name].type;
      var ov = overrides[c.source_name] || overrides[c.name] || null;
      var order = (fields[c.name] && fields[c.name].order) || prefer;
      var st = (pin && pin !== 'date') || ov === 'text' ? null : stats(c.values);
      var t = st ? chooseType(st, pin || ov, order, isIdName(c.base)) : { type: pin || ov };
      var conv = convertColumn(c.values, t.type, t.order);
      var meta = { name: c.name, type: t.type, source_name: c.source_name };
      if (t.order) meta.date_order = t.order;
      if (t.type === 'date' && st && st.time) meta.has_time = true;
      if (pin) meta.pinned = true;
      columns.push(meta); data.push(conv.values);
      if (conv.bad) {
        var rn = uniqueName(c.name + '_raw', taken);
        columns.push({ name: rn, type: 'text', source_name: c.source_name, raw_of: c.name });
        data.push(conv.raw);
        issues.push({ check: 'type.unparsed', column: c.name, count: conv.bad, sample: firstValues(conv.raw, 3) });
      }
    });
    if (officeVals) OFFICE_FIELDS.forEach(function (f, k) { columns.push({ name: f, type: 'text', source_name: '' }); data.push(officeVals[k]); });

    issues.sort(function (a, b) { return b.count - a.count || (a.check < b.check ? -1 : a.check > b.check ? 1 : 0) || (a.column < b.column ? -1 : a.column > b.column ? 1 : 0); });
    return result({
      key: opts.key || (schema && schema.key) || '',
      version: opts.version == null ? '' : String(opts.version),
      logic: VERSION + '+' + officesTag(offices),
      schema: schemaHash(schema),
      columns: columns,
      issues: issues,
      stats: { rows: nRows, source_rows: got.sourceRows, source_columns: width }
    }, data, nRows);
  }

  // A result keeps its values per column (res.data); res.rows (row arrays) is built on first use.
  function result(res, data, n) {
    var rows = null;
    Object.defineProperty(res, 'data', { value: data, enumerable: false });
    Object.defineProperty(res, 'rows', {
      enumerable: true,
      get: function () {
        if (!rows) { rows = new Array(n); for (var r = 0; r < n; r++) { var row = new Array(data.length); for (var c = 0; c < data.length; c++) row[c] = data[c][r]; rows[r] = row; } }
        return rows;
      }
    });
    return res;
  }

  /** A parsed rows document ({ columns, rows }) → the same shape build() returns. */
  function fromJSON(doc) {
    var cols = doc.columns || [], rows = doc.rows || [], data = cols.map(function () { return new Array(rows.length); });
    for (var r = 0; r < rows.length; r++) for (var c = 0; c < cols.length; c++) data[c][r] = rows[r][c];
    return result({ key: doc.key, version: doc.version, logic: doc.logic, schema: doc.schema, columns: cols, issues: doc.issues || [], stats: doc.stats || { rows: rows.length } }, data, rows.length);
  }

  function firstValues(arr, n) {
    var out = [];
    for (var i = 0; i < arr.length && out.length < n; i++) if (arr[i] !== '' && out.indexOf(arr[i]) < 0) out.push(arr[i]);
    return out;
  }

  // Office columns: the schema's roles ({ codes: [field], cccs, divisions, regions }) or lib/offices.js's
  // header rules for this dataset. → [region[], division[], ccc_code[], ccc[]] or null.
  function resolveOffices(mod, key, schema, cols, nRows, issues) {
    var roles = null;
    if (schema && schema.offices && typeof schema.offices === 'object') {
      roles = {};
      ['codes', 'cccs', 'divisions', 'regions'].forEach(function (role) {
        roles[role] = (schema.offices[role] || []).map(function (f) {
          for (var i = 0; i < cols.length; i++) if (cols[i].name === f || cols[i].base === f) return cols[i];
          return null;
        }).filter(Boolean);
      });
    } else if (typeof mod.officeColumns === 'function') {
      roles = mod.officeColumns(key || '', cols.map(function (c) { return { source_name: c.source_name, name: c.name, index: c.index, col: c }; }));
      if (roles) Object.keys(roles).forEach(function (role) { roles[role] = roles[role].map(function (x) { return x.col; }); });
    }
    if (!roles || !['codes', 'cccs', 'divisions', 'regions'].some(function (r) { return roles[r] && roles[r].length; })) return null;
    var reg = new Array(nRows), div = new Array(nRows), code = new Array(nRows), ccc = new Array(nRows);
    var memo = new Map(), agg = new Map(), counts = { ccc: 0, division: 0, region: 0, other: 0 };
    var roleNames = ['codes', 'cccs', 'divisions', 'regions'];
    for (var i = 0; i < nRows; i++) {
      var cells = {}, sig = '';
      for (var k = 0; k < roleNames.length; k++) {
        var list = roles[roleNames[k]] || [], vals = [];
        for (var j = 0; j < list.length; j++) { var v = list[j].values[i]; vals.push(v === null || v === undefined ? '' : String(v)); }
        cells[roleNames[k]] = vals; sig += vals.join('\u0001') + '\u0002';
      }
      var res = memo.get(sig);
      if (!res) { res = mod.resolve(cells); if (memo.size < 20000) memo.set(sig, res); }
      var o = res.office || {};
      reg[i] = o.region || ''; div[i] = o.division || ''; code[i] = o.ccc_code || ''; ccc[i] = o.ccc || '';
      counts[o.ccc ? 'ccc' : o.division ? 'division' : o.region ? 'region' : 'other']++;
      (res.problems || []).forEach(function (p) {
        var ak = p.check + '|' + p.role, a = agg.get(ak);
        if (!a) agg.set(ak, (a = { check: p.check, column: p.role || '', count: 0, sample: [] }));
        a.count++;
        if (a.sample.length < 5 && a.sample.indexOf(p.value) < 0) a.sample.push(p.value);
      });
    }
    agg.forEach(function (a) { issues.push(a); });
    issues.push({ check: 'office.coverage', column: '', count: nRows, sample: [counts.ccc, counts.division, counts.region, counts.other] });
    return [reg, div, code, ccc];
  }

  /* ------------------------------------------------------------------ output */

  /**
   * Canonical JSON (fixed key order); the bytes the VM serves and the cache stores.
   * With onChunk(text) the text is handed over in pieces (a few thousand rows each) instead.
   */
  function stringify(res, onChunk) {
    var parts = ['{"key":', JSON.stringify(res.key), ',"version":', JSON.stringify(res.version), ',"logic":', JSON.stringify(res.logic),
      ',"schema":', JSON.stringify(res.schema), ',"columns":', JSON.stringify(res.columns.map(function (c) {
        var o = { name: c.name, type: c.type, source_name: c.source_name };
        ['date_order', 'has_time', 'pinned', 'raw_of'].forEach(function (k) { if (c[k] !== undefined) o[k] = c[k]; });
        return o;
      })), ',"issues":', JSON.stringify(res.issues.map(function (i) { return { check: i.check, column: i.column, count: i.count, sample: i.sample }; })),
      ',"stats":', JSON.stringify({ rows: res.stats.rows, source_rows: res.stats.source_rows, source_columns: res.stats.source_columns }), ',"rows":['];
    var data = res.data, n = res.stats.rows, nc = data.length, row = new Array(nc);
    for (var i = 0; i < n; i++) {
      for (var c = 0; c < nc; c++) row[c] = data[c][i];
      parts.push((i ? ',' : '') + JSON.stringify(row));
      if (onChunk && parts.length >= 4096) { onChunk(parts.join('')); parts.length = 0; }
    }
    parts.push(']}');
    if (onChunk) { onChunk(parts.join('')); return undefined; }
    return parts.join('');
  }

  /** Rows as objects keyed by column name (one shape per dataset, so the engine shares it). */
  function objects(res) {
    var names = res.columns.map(function (c) { return c.name; }), out;
    if (res.data) {
      var data = res.data, n = res.stats.rows;
      out = new Array(n);
      for (var i = 0; i < n; i++) { var o = {}; for (var k = 0; k < names.length; k++) o[names[k]] = data[k][i]; out[i] = o; }
      return out;
    }
    var rows = res.rows;
    out = new Array(rows.length);
    for (var j = 0; j < rows.length; j++) { var r = rows[j], p = {}; for (var q = 0; q < names.length; q++) p[names[q]] = r[q]; out[j] = p; }
    return out;
  }

  return {
    VERSION: VERSION,
    THRESHOLD: THRESHOLD,
    RESERVED: RESERVED,
    OFFICE_FIELDS: OFFICE_FIELDS,
    build: build,
    stringify: stringify,
    objects: objects,
    fromJSON: fromJSON,
    eachRow: eachRow,
    parseText: parseText,
    cleanHeader: cleanHeader,
    baseName: baseName,
    fieldNames: fieldNames,
    isIdName: isIdName,
    parseNumber: parseNumber,
    parseDate: parseDate,
    stats: stats,
    chooseType: chooseType,
    schemaHash: schemaHash,
    stableStringify: stableStringify,
    hash32: hash32,
    useOffices: useOffices,
    officesTag: function () { return officesTag(officesModule()); }
  };
});
