#!/usr/bin/env node
// Dataset guard: data dumps stay out of git (CI runs this through check_syntax.js):
//   node scripts/tools/check_data_files.js [dir]
// Uploaded and extracted datasets live in the server's data folder (MZO_FILES_DIR on the VM,
// the git-ignored data/ locally), never in the repo. Fails when a tracked file is
//   - under data/, other than the small lookups that ship with the code (KEEP below);
//   - a spreadsheet or table dump (.csv, .tsv, .xls, .xlsx, .xlsm, .ods, .parquet, .sqlite, .db) anywhere;
//   - a .json or .ndjson/.jsonl file over MAX_JSON bytes (an export, not config or a schema).
// Only tracked files count (git ls-files); ignored local copies are fine.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Small, non-personal lookups the app and the VM sync read from the release (vm/sync/sources/files.js):
// data/costcenter.json is SAP cost centre -> office names (served to the browser), data/structure.csv
// the estimate structures (server-only), data/org/wbsedcl_hierarchy.json WBSEDCL's office hierarchy (names and
// codes from public sources; served to admins by GET /api/admin/org).
const KEEP = new Set(['data/costcenter.json', 'data/structure.csv', 'data/org/wbsedcl_hierarchy.json']);
const TABLE = /\.(csv|tsv|xls|xlsx|xlsm|ods|parquet|sqlite3?|db)$/i;
const MAX_JSON = 2 * 1024 * 1024;

function trackedFiles(root) {
    const out = execFileSync('git', ['ls-files', '-z', '--cached'],
        { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\0').filter(Boolean);
}

/** Problems with tracked data files under root, as messages ([] when clean, or when root is not a git checkout). */
function checkTrackedData(root) {
    let files;
    try { files = trackedFiles(root); } catch (_) { return []; }
    const problems = [];
    for (const f of files) {
        if (KEEP.has(f)) continue;
        if (/^data\//i.test(f)) {
            problems.push(`${f}: tracked file under data/ (datasets belong in the server's data folder, not git)`);
        } else if (TABLE.test(f)) {
            problems.push(`${f}: tracked table or spreadsheet file (datasets belong in the server's data folder, not git)`);
        } else if (/\.(json|ndjson|jsonl)$/i.test(f)) {
            let size = 0;
            try { size = fs.statSync(path.join(root, f)).size; } catch (_) { /* deleted in the work tree */ }
            if (size > MAX_JSON) problems.push(`${f}: ${(size / 1048576).toFixed(1)} MB JSON file (a data export? keep it out of git)`);
        }
    }
    return problems;
}

module.exports = { checkTrackedData };

if (require.main === module) {
    const root = fs.realpathSync(path.resolve(process.argv[2] || process.cwd()));
    const problems = checkTrackedData(root);
    if (problems.length) {
        console.error(`${problems.length} dataset file(s) tracked in git:\n`);
        problems.forEach((p) => console.error(p));
        console.error('\nRemove them from the index (git rm --cached <file>) and keep them on the server.');
        process.exit(1);
    }
    console.log('No dataset files tracked in git.');
}
