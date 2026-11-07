#!/usr/bin/env node
'use strict';
// Test of lib/csv.js and the stock publish parse (lib/stock_pipeline.js), no network.
//
//   node vm/dev/test-csv.js
//
// Cells come back exactly as written (no date or number conversion), quoted fields keep commas, quotes
// and line breaks, a BOM is dropped, blank records are skipped, headers get SheetJS's keys, and the
// cleaned stock CSV survives publishedFromCsv → toCsv unchanged.

const path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, '..', '..');
const { parseRows, parseObjects } = require(path.join(ROOT, 'lib', 'csv.js'));
const stock = require(path.join(ROOT, 'lib', 'stock_pipeline.js'));

let passed = 0;
function eq(a, b, label) { assert.deepStrictEqual(a, b, label); passed++; console.log('  ok  ' + label); }

eq(parseRows('a,b\n1,2'), [['a', 'b'], ['1', '2']], 'plain records');
eq(parseRows('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']], 'CRLF, trailing newline');
eq(parseRows('﻿a\n1'), [['a'], ['1']], 'BOM dropped');
eq(parseRows('"x, y","say ""hi""","l1\nl2"'), [['x, y', 'say "hi"', 'l1\nl2']], 'quoted comma, quote, newline');
eq(parseRows('a,,c\n,,'), [['a', '', 'c'], ['', '', '']], 'empty cells');
eq(parseRows('a\tb', { delimiter: '\t' }), [['a', 'b']], 'tab delimiter');
eq(parseRows(''), [], 'empty text');
eq(parseRows('"unterminated'), [['unterminated']], 'unterminated quote keeps the text');
eq(parseObjects('Date,Code,N\n11/7/2026,000123,1e3\n\n2026-11-07,0012,1,234'),
    [{ Date: '11/7/2026', Code: '000123', N: '1e3' }, { Date: '2026-11-07', Code: '0012', N: '1' }],
    'objects: no conversion, blank record skipped, extra cells ignored');
eq(parseObjects('a,a,,\n1,2,3,4'), [{ a: '1', a_1: '2', __EMPTY: '3', __EMPTY_1: '4' }], 'repeated and empty headers');
eq(parseObjects('a,b\n1'), [{ a: '1', b: '' }], 'missing cells are empty');

const cleaned = [
    stock.OUTPUT_COLUMNS.join(','),
    '5101,"Malda, Store",ZMAT,000000001234,"Cable ""XLPE"" 3C",G1,0001,Main,M,"1,234.50",0,0,MALDA,CENTRAL,11/7/2026',
    '5102,X,ZMAT,1000000123456789,Desc,G2,0002,Sub,EA,12.30,1e3,-5,RAIGANJ,LOCAL,11/17/2026'
].join('\n');
const rows = stock.publishedFromCsv(cleaned);
eq(rows.length, 2, 'stock: two rows');
eq(rows[0].Date, '11/7/2026', 'stock: the Date keeps its 4-digit year (SheetJS gave 11/7/26)');
eq(rows[0].Material, '000000001234', 'stock: material code keeps leading zeros');
eq(stock.toCsv(rows), cleaned, 'stock: publishedFromCsv → toCsv round trip is unchanged');
eq(stock.publishedFromCsv('  '), [], 'stock: empty CSV');

console.log(`csv test: ${passed} checks passed`);
