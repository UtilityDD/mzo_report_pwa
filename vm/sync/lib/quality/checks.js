'use strict';
// The checks of vm/sync/quality.js, one small function each (docs/data-quality.md, "Admin → Data quality").
//
// A check is make(ctx) → { row(r), finish() → finding[] }. engine.js feeds every data row once:
//   r.n      row number in the copied file (row 1 is the header), or the record number of a JSON source
//   r.cells  trimmed cell strings by source column index
//   r.typed  per ctx.cols entry: the number (number columns) or 'YYYY-MM-DD…' (date and date-like columns), else null
//   r.office { blank, level, office, problems, cells } from lib/offices.js, or null without office columns
// ctx: { key, cols, rules (rules.js datasetRules), schema, now, prev (baseline of the last good copy), personal,
//        layout, hasOffices, officeRoles, generic, json, rows, hash53 }; a check may leave ctx.asOn / ctx.filled / ctx.nonZero.
//
// A finding: { check, column, severity: critical|warning|info, count, total, examples (≤ 3 strings), message, fix, ... }.
// Examples are row numbers, or office codes and names in datasets without personal columns; never other cell values.

const { ZONE_BBOX } = require('./rules');

const DAY = 86400000;
// How a spreadsheet writes a rounded big number: 6.00E+09, 6E+09 (a sign after the E: DTR codes like 4E229 are real codes).
const E_NOTATION = /^-?\d+(?:\.\d+)?[eE][+-]\d+$/;
// Degrees and decimal minutes (the Power Map sheets): N25°01.234'
const DM = /^([NSEW])?\s*(\d{1,3})\s*°\s*(\d{1,2}(?:\.\d+)?)\s*'?\s*([NSEW])?$/i;
const YYYYMMDD = /^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/;
const DATE_SHAPE = /^(\d{1,5})[-./](\d{1,2})[-./](\d{1,5})(?:[ T,].*)?$/;
const AS_ON_AUTO = /^(as_on|asondate|report_date|report_as_on|update_date|upadte_date|update_on|updated_on|reporting_date|today|report_month|data_date|last_updated)$/;

const fmt = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0) + '%';

function finding(ctx, check, column, severity, count, total, examples, message, fix, extra) {
    return Object.assign({ check, column: column || '', severity, count, total, examples: (examples || []).slice(0, ctx.generic.examples), message, fix }, extra || {});
}
function rowRef(ctx, n) { return (ctx.json ? 'record ' : 'row ') + n; }
function addEx(list, ctx, v) {
    if (list.length < ctx.generic.examples && list.indexOf(v) < 0) list.push(v);
}
function colLabel(c) { return c.source_name && c.source_name !== c.name ? `${c.source_name} (${c.name})` : c.name; }

// ---- rows and header against the last good copy ----------------------------------------------------

function rowsAndHeader(ctx) {
    return {
        row() {},
        finish() {
            const out = [];
            const prev = ctx.prev;
            if (!prev) return out;
            const n = ctx.rows;
            if (n === 0 && prev.rows > 0 && !ctx.rules.allowEmpty) {
                out.push(finding(ctx, 'rows.empty', '', 'critical', 0, prev.rows, [],
                    `The new copy has no rows; the last good copy had ${fmt(prev.rows)}.`,
                    'Check that the sheet or file was not cleared or unpublished; re-upload it. The sync keeps serving the previous copy (see Sources).'));
            } else if (prev.rows > 0 && n < prev.rows * (1 - ctx.generic.rowDropCritical)) {
                out.push(finding(ctx, 'rows.drop', '', 'critical', prev.rows - n, prev.rows, [],
                    `The new copy has ${fmt(n)} rows; the last good copy had ${fmt(prev.rows)} (${pct(prev.rows - n, prev.rows)} fewer).`,
                    'Check whether an upload was cut short or rows were deleted by mistake; re-upload the full report. If the drop is real, it clears after the next copy.',
                    { previous: prev.rows }));
            }
            if (ctx.layout || !Array.isArray(prev.columns) || !prev.columns.length) return out;
            const now = new Set(ctx.cols.map((c) => c.name));
            const before = new Set(prev.columns);
            const removed = prev.columns.filter((c) => !now.has(c));
            const added = ctx.cols.map((c) => c.name).filter((c) => !before.has(c));
            if (removed.length) {
                const used = removed.filter((c) => ctx.schema && ctx.schema.fields && ctx.schema.fields[c]);
                out.push(finding(ctx, 'header.removed', removed.slice(0, 5).join(', '), used.length ? 'critical' : 'warning', removed.length, prev.columns.length, removed.slice(0, 3),
                    `${removed.length} column${removed.length > 1 ? 's are' : ' is'} no longer in the sheet: ${removed.slice(0, 5).join(', ')}${removed.length > 5 ? ' …' : ''}.` +
                    (used.length ? ` Pages read ${used.join(', ')}, so they now show blanks.` : ''),
                    'Restore the header (spelling matters), or add the new spelling as an alias in schema/<key>.json if the rename is intended.'));
            }
            if (added.length) {
                out.push(finding(ctx, 'header.added', added.slice(0, 5).join(', '), 'info', added.length, ctx.cols.length, added.slice(0, 3),
                    `${added.length} new column${added.length > 1 ? 's' : ''}: ${added.slice(0, 5).join(', ')}${added.length > 5 ? ' …' : ''}.`,
                    'Nothing to do if the column was added on purpose.'));
            }
            return out;
        }
    };
}

// ---- duplicate keys and copied rows ---------------------------------------------------------------

function duplicates(ctx) {
    const keyCols = (ctx.rules.keys || []).map((k) => ctx.cols.find((c) => c.name === k)).filter(Boolean);
    const keySeen = keyCols.map(() => new Set());
    const keyDup = keyCols.map(() => ({ n: 0, ex: [] }));
    const rowSeen = new Set();
    const rowDup = { n: 0, ex: [] };
    const idx = ctx.cols.map((c) => c.index);
    return {
        row(r) {
            for (let k = 0; k < keyCols.length; k++) {
                const v = r.cells[keyCols[k].index] || '';
                if (!v) continue;
                const h = ctx.hash53(v);
                if (keySeen[k].has(h)) { keyDup[k].n++; addEx(keyDup[k].ex, ctx, rowRef(ctx, r.n)); } else keySeen[k].add(h);
            }
            let s = '';
            for (let i = 0; i < idx.length; i++) s += (r.cells[idx[i]] || '') + '\u0001';
            const h = ctx.hash53(s);
            if (rowSeen.has(h)) { rowDup.n++; addEx(rowDup.ex, ctx, rowRef(ctx, r.n)); } else rowSeen.add(h);
        },
        finish() {
            const out = [];
            keyCols.forEach((c, k) => {
                if (!keyDup[k].n) return;
                out.push(finding(ctx, 'key.duplicate', c.name, ctx.rules.keySeverity || 'warning', keyDup[k].n, ctx.rows, keyDup[k].ex,
                    `${fmt(keyDup[k].n)} rows repeat a ${colLabel(c)} that an earlier row already has, so counts by ${c.name} can double up.`,
                    `Make each ${c.source_name || c.name} unique in the sheet (or delete the repeated rows).`));
            });
            if (rowDup.n) {
                out.push(finding(ctx, 'row.duplicate', '', 'warning', rowDup.n, ctx.rows, rowDup.ex,
                    `${fmt(rowDup.n)} rows are exact copies of an earlier row (every cell the same).`,
                    'Delete the pasted copies in the sheet; pages that count rows count them twice.'));
            }
            keySeen.length = 0;
            rowSeen.clear();
            return out;
        }
    };
}

// ---- offices against the office master (lib/offices.js) -------------------------------------------

function offices(ctx) {
    if (!ctx.hasOffices) return null;
    const blank = { n: 0, ex: [] };
    const unknown = new Map(); // column role → { n, ex }
    const mismatch = { n: 0, ex: [] };
    const roleCol = (role) => ((ctx.officeRoles[role] || [])[0] || {}).name || role;
    return {
        row(r) {
            const o = r.office;
            if (!o) return;
            if (o.blank) { blank.n++; addEx(blank.ex, ctx, rowRef(ctx, r.n)); return; }
            for (const p of o.problems) {
                if (/^office\.unknown_/.test(p.check)) {
                    const role = p.check.slice(15);
                    const k = role === 'code' ? 'codes' : role + 's';
                    let u = unknown.get(k);
                    if (!u) unknown.set(k, (u = { n: 0, ex: [] }));
                    u.n++;
                    addEx(u.ex, ctx, ctx.personal ? rowRef(ctx, r.n) : String(p.value).slice(0, 40));
                } else if (p.check === 'office.code_name_mismatch') {
                    mismatch.n++;
                    addEx(mismatch.ex, ctx, ctx.personal ? rowRef(ctx, r.n) : String(p.value).slice(0, 40));
                }
            }
        },
        finish() {
            const out = [];
            if (blank.n) {
                const share = blank.n / Math.max(1, ctx.rows);
                out.push(finding(ctx, 'office.blank', '', share > ctx.generic.officeBlankWarnShare ? 'warning' : 'info', blank.n, ctx.rows, blank.ex,
                    `${fmt(blank.n)} rows (${pct(blank.n, ctx.rows)}) have no office at all: every region, division, CCC and code cell is blank, so office-scoped users never see them.`,
                    'Fill the CCC (or its code) in those rows.'));
            }
            for (const [k, u] of unknown) {
                out.push(finding(ctx, 'office.unknown', roleCol(k), 'warning', u.n, ctx.rows, u.ex,
                    `${fmt(u.n)} rows name an office that is not in the office list (lib/offices.js) in ${roleCol(k)}, so they fall outside every office's scope.`,
                    'Correct the spelling or code in the sheet; if it is a real spelling, add it as an alias in lib/offices.js.'));
            }
            if (mismatch.n) {
                out.push(finding(ctx, 'office.mismatch', roleCol('codes'), 'warning', mismatch.n, ctx.rows, mismatch.ex,
                    `${fmt(mismatch.n)} rows have a CCC code and a CCC name that point to different CCCs.`,
                    'Fix whichever of the two is wrong in the sheet.'));
            }
            return out;
        }
    };
}

// ---- numbers: scientific notation, text, dates in amounts, negatives --------------------------------

function numbers(ctx) {
    const nonNeg = new Set(ctx.rules.nonNegative || []);
    const cols = ctx.cols.filter((c) => (c.type === 'number' || c.roles.id || c.roles.amount) && !(c.type === 'number' && c.dateOrder));
    const st = cols.map(() => ({ sci: 0, sciEx: [], text: 0, dateCand: [], neg: 0, negEx: [], sample: [], seen: 0 }));
    // Text in number columns is one finding per dataset: one bad row (a legend row, a shifted row) often hits many columns.
    const textRows = new Set();
    const textEx = [];
    let textCells = 0;
    return {
        row(r) {
            for (let k = 0; k < cols.length; k++) {
                const c = cols[k];
                const s = r.cells[c.index] || '';
                if (!s) continue;
                const a = st[k];
                if (E_NOTATION.test(s) && (c.roles.id || c.roles.amount || c.type === 'number') && !/^-?0(\.0+)?e/i.test(s)) {
                    a.sci++; addEx(a.sciEx, ctx, rowRef(ctx, r.n));
                    continue;
                }
                if (c.type !== 'number') continue;
                const v = r.typed[c.i];
                if (v === null) {
                    if (!/^(\(null\)|null|#n\/a|n\/a|na|nil|none|-+|\.)$/i.test(s)) {
                        a.text++; textCells++;
                        if (textRows.size < 100000) textRows.add(r.n);
                        addEx(textEx, ctx, rowRef(ctx, r.n));
                    }
                    continue;
                }
                if (c.roles.amount && YYYYMMDD.test(s) && a.dateCand.length < 50) a.dateCand.push([r.n, v]);
                // a reservoir of values for the column's typical size
                a.seen++;
                if (a.sample.length < 2000) a.sample.push(Math.abs(v));
                else { const j = Math.floor(Math.random() * a.seen); if (j < 2000) a.sample[j] = Math.abs(v); }
                if (v < 0 && (c.roles.count || c.roles.amount || nonNeg.has(c.name))) { a.neg++; addEx(a.negEx, ctx, rowRef(ctx, r.n)); }
            }
        },
        finish() {
            const out = [];
            cols.forEach((c, k) => {
                const a = st[k];
                if (a.sci) {
                    out.push(finding(ctx, 'number.scientific', c.name, 'warning', a.sci, ctx.rows, a.sciEx,
                        `${fmt(a.sci)} cells in ${colLabel(c)} are in scientific notation (like 6.00E+09): the spreadsheet rounded them, so the ${c.roles.id ? 'IDs' : 'values'} are lost.`,
                        `Format ${c.source_name || c.name} as plain text (IDs) or as a number with no exponent before exporting, then re-export the sheet.`));
                }
                if (a.dateCand.length && a.sample.length) {
                    const sorted = a.sample.slice().sort((x, y) => x - y);
                    const median = sorted[Math.floor(sorted.length / 2)] || 0;
                    const hits = a.dateCand.filter(([, v]) => v > 50 * Math.max(median, 1));
                    if (hits.length) {
                        out.push(finding(ctx, 'value.date_in_number', c.name, 'warning', hits.length, ctx.rows, hits.map(([n]) => rowRef(ctx, n)),
                            `${fmt(hits.length)} cells in the amount column ${colLabel(c)} hold a date written as yyyymmdd (like 20261103), far above the column's typical value: the row's columns have probably shifted, and the amount is counted as a huge number.`,
                            'Fix the row in the sheet (usually a tab or line break inside a text cell before this column).'));
                    }
                }
                if (a.neg) {
                    const strict = nonNeg.has(c.name) || c.roles.count;
                    out.push(finding(ctx, 'number.negative', c.name, strict ? 'warning' : 'info', a.neg, ctx.rows, a.negEx,
                        `${fmt(a.neg)} values in ${colLabel(c)} are below zero` + (strict ? ', which this column cannot be.' : ' (credits or reversals?).'),
                        strict ? 'Correct the sign in the sheet.' : 'Check whether these are real credits; label them or correct the sign.'));
                }
            });
            const textN = new Map(cols.map((c, k) => [c, st[k].text]));
            const textCols = cols.filter((c) => textN.get(c)).sort((x, y) => textN.get(y) - textN.get(x));
            if (textCols.length) {
                const names = textCols.map((c) => c.name);
                out.push(finding(ctx, 'number.text', names.slice(0, 4).join(', ') + (names.length > 4 ? ' …' : ''), textCols.some((c) => c.roles.amount) ? 'warning' : 'info',
                    textRows.size, ctx.rows, textEx,
                    `${fmt(textCells)} cells in ${fmt(textRows.size)} rows hold text or a formula error in a number column (${names.length} column${names.length > 1 ? 's' : ''}: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ' …' : ''}), so they count as blank.` +
                    (textRows.size <= 3 && names.length > 3 ? ' A single row across many columns is usually a legend row or a row whose cells have shifted.' : ''),
                    'Enter plain numbers (no words, units or #DIV/0!), and delete legend or total rows inside the data.', { columns: names }));
            }
            return out;
        }
    };
}

// ---- dates: impossible, future, too old, placeholders ------------------------------------------------

function yearOf(d) { return Number(String(d).slice(0, 4)); }
function impossibleRaw(s) {
    const m = DATE_SHAPE.exec(s);
    if (!m) return false;
    const y = m[1].length >= 3 ? m[1] : m[3];
    const n = Number(y);
    return y.length !== 4 || n < 1900 || n > 2100;
}

function dates(ctx) {
    const g = ctx.generic;
    const cols = ctx.cols.filter((c) => c.dateOrder);
    const futureLimit = new Date(ctx.now + g.futureMarginDays * DAY).toISOString().slice(0, 10);
    const placeholder = new Set(g.placeholderYears);
    const st = cols.map(() => ({ imp: 0, impEx: [], impYears: new Set(), fut: 0, futEx: [], old: 0, oldEx: [], ph: 0, phEx: [] }));
    return {
        row(r) {
            for (let k = 0; k < cols.length; k++) {
                const c = cols[k];
                const s = r.cells[c.index] || '';
                if (!s) continue;
                const a = st[k];
                const v = r.typed[c.i];
                if (v === null) {
                    if (impossibleRaw(s)) {
                        a.imp++; addEx(a.impEx, ctx, rowRef(ctx, r.n));
                        if (a.impYears.size < 5) { const m = DATE_SHAPE.exec(s); a.impYears.add(m[1].length >= 3 ? m[1] : m[3]); }
                    }
                    continue;
                }
                const y = yearOf(v);
                if (placeholder.has(y)) { a.ph++; addEx(a.phEx, ctx, rowRef(ctx, r.n)); } else if (y < g.minYear) { a.old++; addEx(a.oldEx, ctx, rowRef(ctx, r.n)); } else if (!c.roles.futureOk && v.slice(0, 10) > futureLimit) { a.fut++; addEx(a.futEx, ctx, rowRef(ctx, r.n)); }
            }
        },
        finish() {
            const out = [];
            cols.forEach((c, k) => {
                const a = st[k];
                if (a.imp) out.push(finding(ctx, 'date.impossible', c.name, 'warning', a.imp, ctx.rows, a.impEx,
                    `${fmt(a.imp)} dates in ${colLabel(c)} have an impossible year (${[...a.impYears].join(', ')}), so they are read as blank.`,
                    'Correct the typing in the sheet (four-digit year between 1950 and today).'));
                if (a.fut) out.push(finding(ctx, 'date.future', c.name, 'warning', a.fut, ctx.rows, a.futEx,
                    `${fmt(a.fut)} dates in ${colLabel(c)} are more than ${g.futureMarginDays} days in the future.`,
                    'Correct the date (often a wrong year or day and month swapped).'));
                if (a.old) out.push(finding(ctx, 'date.too_old', c.name, 'warning', a.old, ctx.rows, a.oldEx,
                    `${fmt(a.old)} dates in ${colLabel(c)} are before ${g.minYear}.`,
                    'Correct the year in the sheet.'));
                if (a.ph) out.push(finding(ctx, 'date.placeholder', c.name, 'info', a.ph, ctx.rows, a.phEx,
                    `${fmt(a.ph)} dates in ${colLabel(c)} are 1900–1912 placeholders (an empty date in the source system), so ages and "since" figures from them are meaningless.`,
                    'Leave the cell empty when the date is unknown; pages should treat years before 1950 as unknown.'));
            });
            return out;
        }
    };
}

// ---- columns that became all zero or blank -------------------------------------------------------

function fill(ctx) {
    const filled = new Uint8Array(ctx.cols.length);
    const nonZero = new Uint8Array(ctx.cols.length);
    const ruled = new Set((ctx.rules.rules || []).filter((x) => x.type === 'notAllZero').map((x) => x.column));
    return {
        row(r) {
            for (let k = 0; k < ctx.cols.length; k++) {
                const c = ctx.cols[k];
                const s = r.cells[c.index] || '';
                if (!s || /^(\(null\)|null|#n\/a|n\/a|na|nil|none|-+|\.)$/i.test(s)) continue;
                filled[k] = 1;
                if (c.type === 'number') { const v = r.typed[k]; if (v !== null && v !== 0) nonZero[k] = 1; }
            }
        },
        finish() {
            ctx.filled = ctx.cols.filter((c, k) => filled[k]).map((c) => c.name);
            ctx.nonZero = ctx.cols.filter((c, k) => nonZero[k]).map((c) => c.name);
            const out = [];
            const prev = ctx.prev;
            if (!prev || ctx.layout || !ctx.rows) return out;
            const pf = new Set(prev.filled || []);
            const pz = new Set(prev.nonZero || []);
            ctx.cols.forEach((c, k) => {
                if (ruled.has(c.name)) return;
                const used = !!(ctx.schema && ctx.schema.fields && ctx.schema.fields[c.name]);
                if (pf.has(c.name) && !filled[k]) {
                    out.push(finding(ctx, 'column.went_blank', c.name, used ? 'critical' : 'warning', ctx.rows, ctx.rows, [],
                        `${colLabel(c)} is blank in every row; the last good copy had values.` + (used ? ' Pages read this column.' : ''),
                        'Check the export or the formula that fills this column, then re-upload.'));
                } else if (c.type === 'number' && pz.has(c.name) && filled[k] && !nonZero[k]) {
                    out.push(finding(ctx, 'column.went_zero', c.name, used ? 'critical' : 'warning', ctx.rows, ctx.rows, [],
                        `${colLabel(c)} is 0 in every row; the last good copy had other values.` + (used ? ' Pages read this column, so they show zeros.' : ''),
                        'Check the export or the formula that fills this column, then re-upload.'));
                }
            });
            return out;
        }
    };
}

// ---- the "as on" date (staleness is judged on every run by quality.js, from this date) ------------

function asOn(ctx) {
    const want = ctx.rules.asOn || [];
    let col = null;
    for (const w of want) { col = ctx.cols.find((c) => c.name === w && c.dateOrder); if (col) break; }
    if (!col && !want.length) col = ctx.cols.find((c) => AS_ON_AUTO.test(c.name) && c.dateOrder) || null;
    if (!col) return null;
    const limit = new Date(ctx.now + 2 * DAY).toISOString().slice(0, 10);
    let max = null;
    return {
        row(r) {
            const v = r.typed[col.i];
            if (v && v.slice(0, 10) <= limit && yearOf(v) >= ctx.generic.minYear && (!max || v > max)) max = v;
        },
        finish() {
            if (max) ctx.asOn = { column: col.name, date: max.slice(0, 10) };
            return [];
        }
    };
}

// ---- specific rules (rules.js RULES) -------------------------------------------------------------

const RULE_TYPES = {
    // The column must have at least one value other than 0 / blank.
    notAllZero(ctx, rule) {
        const c = ctx.cols.find((x) => x.name === rule.column);
        if (!c) return null;
        let nonZero = 0;
        const ex = [];
        return {
            row(r) { const v = c.type === 'number' ? r.typed[c.i] : Number(r.cells[c.index]); if (v && Number.isFinite(v)) { nonZero++; addEx(ex, ctx, rowRef(ctx, r.n)); } },
            finish() {
                // "Every row" allows a stray row or two (a shifted row can put any number in the column).
                if (!ctx.rows || nonZero > Math.max(2, ctx.rows * (rule.tolerance || 0.001))) return [];
                const note = nonZero ? ` (${fmt(nonZero)} stray row${nonZero > 1 ? 's' : ''} aside: ${ex.join(', ')})` : '';
                return [finding(ctx, rule.id, c.name, rule.severity, ctx.rows - nonZero, ctx.rows, ex, rule.message + note, rule.fix)];
            }
        };
    },

    // Rows must resolve to an office of this level (lib/offices.js); the others are counted and summed.
    officeLevel(ctx, rule) {
        if (!ctx.hasOffices) return null;
        const sumCol = rule.sum ? ctx.cols.find((x) => x.name === rule.sum) : null;
        let n = 0; let sum = 0; let all = 0;
        const ex = [];
        return {
            row(r) {
                const v = sumCol ? r.typed[sumCol.i] || 0 : 0;
                all += v;
                const lvl = r.office && r.office.level;
                if (!lvl || lvl === rule.expect || lvl === 'outside') return;
                n++; sum += v;
                const code = ((r.office.cells && r.office.cells.codes) || [])[0] || r.office.office.region || '';
                addEx(ex, ctx, ctx.personal ? rowRef(ctx, r.n) : String(code).slice(0, 20));
            },
            finish() {
                if (!n) return [];
                const money = (x) => rule.sumUnit === 'lakh' ? '₹' + fmt(Math.round(x) / 100) + ' Cr' : fmt(x);
                const part = sumCol ? ` (${money(sum)} of ${money(all)}, ${pct(sum, all)})` : '';
                return [finding(ctx, rule.id, sumCol ? sumCol.name : '', rule.severity, n, ctx.rows, ex,
                    `${fmt(n)} rows${part}: ${rule.message}`, rule.fix, sumCol ? { sum, sumTotal: all } : null)];
            }
        };
    },

    // Parent-level rows (e.g. region) must add up to their child rows (e.g. CCC) in the latest group.
    rollup(ctx, rule) {
        if (!ctx.hasOffices) return null;
        const col = ctx.cols.find((x) => x.name === rule.column);
        const gcols = rule.groupBy.map((g) => ctx.cols.find((x) => x.name === g));
        if (!col || gcols.some((g) => !g)) return null;
        const groups = new Map(); // group → { parent: Map(region → sum), child: Map(region → sum) }
        return {
            row(r) {
                const lvl = r.office && r.office.level;
                if (lvl !== rule.parent && lvl !== rule.child) return;
                const v = r.typed[col.i];
                if (v === null) return;
                const gk = gcols.map((g) => { const t = r.typed[g.i]; return t === null ? r.cells[g.index] : t; });
                const k = gk.map((x) => (typeof x === 'number' ? String(x).padStart(4, '0') : x)).join('|');
                let g = groups.get(k);
                if (!g) groups.set(k, (g = { label: gk.join('-'), parent: new Map(), child: new Map() }));
                const region = r.office.office.region || '';
                const m = lvl === rule.parent ? g.parent : g.child;
                m.set(region, (m.get(region) || 0) + v);
            },
            finish() {
                if (!groups.size) return [];
                const latest = [...groups.keys()].sort().pop();
                const g = groups.get(latest);
                const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
                const p = sum(g.parent); const c = sum(g.child);
                if (!p || Math.abs(p - c) / p <= rule.tolerance) return [];
                const ex = [...g.parent.keys()].map((reg) => [reg, (g.parent.get(reg) || 0) - (g.child.get(reg) || 0)])
                    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 3).map(([reg, d]) => `${reg} ${d >= 0 ? '+' : ''}${fmt(Math.round(d * 100) / 100)} ${rule.unit}`);
                return [finding(ctx, rule.id, col.name, rule.severity, Math.round((p - c) * 100) / 100, Math.round(p * 100) / 100, ex,
                    `In ${g.label}, the ${rule.parent} rows hold ${fmt(Math.round(p * 100) / 100)} ${rule.unit} of ${col.name} but their ${rule.child} rows add up to ${fmt(Math.round(c * 100) / 100)} ${rule.unit} (${fmt(Math.round((p - c) * 100) / 100)} ${rule.unit}, ${pct(p - c, p)}). ${rule.message}`,
                    rule.fix, { group: g.label })];
            }
        };
    },

    // Latitude / longitude columns inside the zone.
    geo(ctx, rule) {
        const lats = ctx.cols.filter((c) => c.roles.lat);
        const lngs = ctx.cols.filter((c) => c.roles.lng);
        if (!lats.length && !lngs.length) return null;
        let n = 0; let filled = 0;
        const ex = [];
        const num = (c, r) => {
            const t = c.type === 'number' ? r.typed[c.i] : null;
            if (t !== null && t !== undefined) return t;
            const s = r.cells[c.index] || '';
            if (s === '') return null;
            const dm = DM.exec(s);
            if (dm) { const v = Number(dm[2]) + Number(dm[3]) / 60; return /[SW]/i.test((dm[1] || '') + (dm[4] || '')) ? -v : v; }
            const v = Number(s.replace(/,/g, ''));
            return Number.isFinite(v) ? v : NaN;
        };
        return {
            row(r) {
                let bad = false; let any = false;
                for (const c of lats) { const v = num(c, r); if (v === null || v === 0) continue; any = true; if (!(v >= ZONE_BBOX.latMin && v <= ZONE_BBOX.latMax)) bad = true; }
                for (const c of lngs) { const v = num(c, r); if (v === null || v === 0) continue; any = true; if (!(v >= ZONE_BBOX.lngMin && v <= ZONE_BBOX.lngMax)) bad = true; }
                if (any) filled++;
                if (bad) { n++; addEx(ex, ctx, rowRef(ctx, r.n)); }
            },
            finish() {
                if (!n) return [];
                return [finding(ctx, rule.id, lats.concat(lngs).map((c) => c.name).join(', '), rule.severity, n, filled, ex,
                    `${fmt(n)} of ${fmt(filled)} rows with coordinates: ${rule.message}`, rule.fix)];
            }
        };
    }
};

/** The checks for one dataset, in the order their findings are listed. */
function create(ctx) {
    const list = ctx.layout
        ? [rowsAndHeader(ctx), asOn(ctx)]
        : [rowsAndHeader(ctx), duplicates(ctx), offices(ctx), numbers(ctx), dates(ctx), fill(ctx), asOn(ctx)];
    if (!ctx.layout) {
        for (const rule of ctx.rules.rules || []) {
            const make = RULE_TYPES[rule.type];
            if (make) list.push(make(ctx, rule));
        }
    }
    return list.filter(Boolean);
}

module.exports = { create, RULE_TYPES, impossibleRaw, E_NOTATION, YYYYMMDD };
