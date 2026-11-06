/* editor/clipboard.js: what Google Sheets and Excel put on the clipboard → rows of cells.
 * Browser (window.EdClip) and Node (require) alike; no dependencies. Tests: vm/dev/test-editor.js.
 *
 *   parseTsv(text)            text/plain from Sheets / Excel: tab-separated. A cell holding a tab, a
 *                             line break or a quote is wrapped in quotes with "" for a quote. A quote
 *                             that does not open a properly closed cell is an ordinary character.
 *                             CRLF, LF and CR all end a row; the line ending after the last row (and
 *                             any blank lines after it) make no rows.
 *   parseDelimited(text, d)   a CSV (d = ',') or TSV file the same way (a BOM is dropped).
 *   parseHtml(html)           text/html from Sheets / Excel (the fallback when there is no plain text):
 *                             the first <table>, <br> as a line break, colspan as empty cells, entities decoded.
 *   fromClipboard(dt)         a DataTransfer → { rows, source: 'text' | 'html' | '' }
 *   headerMatch(row, columns) does this first row name the dataset's columns? → { isHeader, map, unknown }
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EdClip = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function parseDelimited(text, delimiter) {
    var s = String(text == null ? '' : text);
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    var d = delimiter || '\t';
    var rows = [];
    var row = [];
    var i = 0;
    var n = s.length;
    var cell = '';
    var atStart = true;
    while (i < n) {
      var c = s[i];
      if (atStart && c === '"') {
        // A quoted cell, if it closes properly (closing quote, then a delimiter, a line end or the end).
        var j = i + 1;
        var buf = '';
        var closed = -1;
        while (j < n) {
          var k = s.indexOf('"', j);
          if (k < 0) break;
          if (s[k + 1] === '"') { buf += s.slice(j, k + 1); j = k + 2; continue; }
          var after = s[k + 1];
          if (after === undefined || after === d || after === '\n' || after === '\r') { buf += s.slice(j, k); closed = k + 1; }
          break;
        }
        if (closed >= 0) {
          cell = buf;
          i = closed;
          atStart = false;
          continue;
        }
        // Not a quoted cell after all: the quote is part of the text.
      }
      if (c === d) { row.push(cell); cell = ''; atStart = true; i++; continue; }
      if (c === '\r' || c === '\n') {
        row.push(cell); rows.push(row); row = []; cell = ''; atStart = true;
        i += (c === '\r' && s[i + 1] === '\n') ? 2 : 1;
        continue;
      }
      cell += c;
      atStart = false;
      i++;
    }
    if (cell !== '' || row.length || !atStart) { row.push(cell); rows.push(row); }
    // The line ending after the last row, and blank lines after it, are not rows.
    while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
    return rows;
  }

  function parseTsv(text) { return parseDelimited(text, '\t'); }

  var ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  function decode(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (m, e) {
      if (e[0] === '#') {
        var code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
      }
      var v = ENT[e.toLowerCase()];
      return v === undefined ? m : v;
    });
  }

  /** Cell markup → text: <br> and block ends are line breaks, other tags dropped, entities decoded. */
  function cellText(html) {
    var t = String(html)
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li)\s*>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/\r\n?/g, '\n');
    t = decode(t).replace(/ /g, ' ');
    // Markup whitespace (indentation between tags) is not cell text; keep line breaks inside cells.
    return t.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/^\n+|\n+$/g, '');
  }

  function parseHtml(html) {
    var s = String(html == null ? '' : html);
    var tm = /<table[\s\S]*?<\/table\s*>/i.exec(s);
    if (!tm) return [];
    var table = tm[0];
    var rows = [];
    var trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi;
    var tr;
    while ((tr = trRe.exec(table))) {
      var cells = [];
      var tdRe = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
      var td;
      while ((td = tdRe.exec(tr[1]))) {
        cells.push(cellText(td[3]));
        var span = /colspan\s*=\s*["']?(\d+)/i.exec(td[2]);
        for (var k = 1; span && k < Math.min(50, Number(span[1])); k++) cells.push('');
      }
      rows.push(cells);
    }
    while (rows.length && rows[rows.length - 1].every(function (c) { return c === ''; })) rows.pop();
    return rows;
  }

  function fromClipboard(dt) {
    if (!dt) return { rows: [], source: '' };
    var text = '';
    var html = '';
    try { text = dt.getData('text/plain') || ''; } catch (e) { text = ''; }
    try { html = dt.getData('text/html') || ''; } catch (e) { html = ''; }
    if (text !== '') return { rows: parseTsv(text), source: 'text' };
    if (html) return { rows: parseHtml(html), source: 'html' };
    return { rows: [], source: '' };
  }

  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ''); }

  /**
   * Does `row` name the columns? columns: [{ name, label }]. A cell matches a column by its label
   * (the sheet header) or its field name, ignoring case, spaces and punctuation.
   * → { isHeader, map: [column index or -1 per cell], unknown: [cells that name no column] }
   */
  function headerMatch(row, columns) {
    var byKey = {};
    columns.forEach(function (c, i) {
      [c.label, c.name].forEach(function (x) { var k = norm(x); if (k && byKey[k] === undefined) byKey[k] = i; });
    });
    var map = [];
    var unknown = [];
    var hits = 0;
    var filled = 0;
    var used = {};
    (row || []).forEach(function (cell) {
      var k = norm(cell);
      if (!k) { map.push(-1); return; }
      filled++;
      var i = byKey[k];
      if (i !== undefined && !used[i]) { used[i] = 1; map.push(i); hits++; }
      else { map.push(-1); unknown.push(String(cell)); }
    });
    return { isHeader: filled > 0 && hits >= Math.max(1, Math.ceil(filled * 0.5)), map: map, unknown: unknown };
  }

  return { parseTsv: parseTsv, parseDelimited: parseDelimited, parseHtml: parseHtml, fromClipboard: fromClipboard, headerMatch: headerMatch, norm: norm };
});
