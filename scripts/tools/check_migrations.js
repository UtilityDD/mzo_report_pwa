#!/usr/bin/env node
// Migration guard: only hand-written PocketBase migrations in vm/pocketbase/pb_migrations
// (CI runs this through check_syntax.js):
//   node scripts/tools/check_migrations.js [dir]
// A PocketBase started with --automigrate=true (its default) writes a migration file for every
// collection change made through its API or dashboard, named <timestamp>_created_<collection>.js,
// _updated_ or _deleted_. The sync and the tests create ds_* collections that way, so such files must
// never be committed: on the VM a stray "created ds_x" fails because ds_x already exists, and PocketBase
// does not start. Hand-written migrations here look like
//   1794100002_app_edit_log.js
//   /// <reference path="../local/pb_data/types.d.ts" />
//   // What it does and why (a comment on the second line)
// and the guard fails on anything else: a generated name, the generated header
// (`../pb_data/types.d.ts`), no description comment, or two files with the same timestamp.
'use strict';

const fs = require('fs');
const path = require('path');

const REL = 'vm/pocketbase/pb_migrations';
const HEADER = '/// <reference path="../local/pb_data/types.d.ts" />';
const NAME = /^(\d{10})_[a-z0-9_]+\.js$/;
const GENERATED = /^\d+_(created|updated|deleted)_/;

/** Problems in root's migrations folder, as messages ([] when clean or when there is no such folder). */
function checkMigrations(root) {
    const dir = path.join(root, REL);
    let files;
    try { files = fs.readdirSync(dir).filter((f) => !f.startsWith('.')); } catch (_) { return []; }
    const problems = [];
    const stamps = new Map();
    for (const f of files.sort()) {
        const where = `${REL}/${f}`;
        if (GENERATED.test(f)) {
            problems.push(`${where}: written by PocketBase's automigrate (start PocketBase with --automigrate=false and a copy of the migrations); delete it`);
            continue;
        }
        const m = NAME.exec(f);
        if (!m) {
            problems.push(`${where}: not a migration name (<10-digit timestamp>_<snake_case>.js)`);
            continue;
        }
        if (stamps.has(m[1])) problems.push(`${where}: same timestamp as ${stamps.get(m[1])}`);
        stamps.set(m[1], f);
        const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/, 2);
        if (lines[0] !== HEADER) {
            problems.push(`${where}: first line is not ${HEADER}` + (/\.\.\/pb_data\/types\.d\.ts/.test(lines[0]) ? ' (this header is the one PocketBase generates)' : ''));
        } else if (!/^\s*\/\//.test(lines[1] || '')) {
            problems.push(`${where}: the second line should be a comment saying what the migration does`);
        }
    }
    return problems;
}

module.exports = { checkMigrations };

if (require.main === module) {
    const root = fs.realpathSync(path.resolve(process.argv[2] || process.cwd()));
    const problems = checkMigrations(root);
    if (problems.length) {
        console.error(`${problems.length} problem(s) in ${REL}:\n`);
        problems.forEach((p) => console.error(p));
        process.exit(1);
    }
    console.log(`ok ${REL}`);
}
