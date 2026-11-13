#!/usr/bin/env node
// Every offline test suite, one after the other (`npm test`; CI runs it on each push):
//   node scripts/tools/run_tests.js [--pb] [--only <name>[,<name>]]
//   --pb    also the suites that start a throwaway PocketBase (vm/dev/lib/local-pb.js: temp --dir, a copy
//           of the migrations, --automigrate=false). Needs the binary at vm/pocketbase/local/pocketbase or
//           PB_BIN (the version in vm/pocketbase/VERSION).
// No network and no production data: fixtures, local mocks and temp folders only. Needs `npm ci` at the
// root and in vm/sync. Prints each suite's result and time, and the tail of the output of a failed one.
'use strict';

const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const node = process.execPath;

const OFFLINE = [
    ['syntax, data files, migrations', node, ['scripts/tools/check_syntax.js']],
    ['VM shell scripts parse', 'bash', ['-c', 'for f in vm/deploy/*.sh vm/dev/*.sh scripts/qa/*.sh scripts/tools/*.sh; do bash -n "$f" || exit 1; done']],
    ['uniform and rating unit tests', node, ['--test', 'scripts/qa/uniform.test.js', 'scripts/qa/rating.test.js']],
    ['rating metrics', node, ['scripts/qa/rating-metrics-test.js']],
    ['mirror server', node, ['vm/dev/test-mirror-server.js']],
    ['server robustness', node, ['vm/dev/test-server-robustness.js']],
    ['CSV reader', node, ['vm/dev/test-csv.js']],
    ['user store queue', node, ['vm/dev/test-users-queue.js']],
    ['briefing cache', node, ['vm/dev/test-briefing-cache.js']],
    ['VM-only admins', node, ['vm/dev/test-local-admin.js']],
    ['Safety upload and token', node, ['vm/dev/test-safety-upload.js']],
    ['CMO grievance upload', node, ['vm/dev/test-cmo-upload.js']],
    ['NSC / Withheld upload pipeline', node, ['vm/dev/test-nsc-upload.js']],
    ['DISHA Collect', node, ['vm/dev/test-collect.js']],
    ['Admin sources', node, ['vm/dev/test-sources-info.js']],
    ['data quality', node, ['vm/dev/test-quality.js']],
    ['organisation API', node, ['vm/dev/test-org-api.js']],
    ['Power Map proxy', node, ['vm/dev/test-powermap-proxy.js']],
    ['Ask providers', node, ['vm/dev/test-assistant-provider.js']],
    ['Ask usage', node, ['vm/dev/test-assistant-usage.js']],
    ['sync lock', node, ['vm/dev/test-sync-lock.js']],
    ['office DB2 helper', node, ['vm/dev/test-office-helper.js']],
    ['deploy and rollback', 'bash', ['vm/dev/test-deploy.sh']]
];
const POCKETBASE = [
    ['user store (PocketBase)', node, ['vm/dev/test-users-store.js']],
    ['sync types (PocketBase)', node, ['vm/dev/test-sync-types.js']],
    ['data editor (PocketBase)', node, ['vm/dev/test-editor.js']],
    ['DISHA Collect (PocketBase)', node, ['vm/dev/test-collect.js', '--pb']]
];

function run(cmd, args) {
    return new Promise((resolve) => {
        const p = spawn(cmd, args, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        const keep = (d) => { out = (out + d).slice(-20000); };
        p.stdout.on('data', keep);
        p.stderr.on('data', keep);
        p.on('error', (err) => resolve({ code: 1, out: String(err) }));
        p.on('close', (code) => resolve({ code, out }));
    });
}

async function main() {
    const argv = process.argv.slice(2);
    const i = argv.indexOf('--only');
    const only = i >= 0 ? String(argv[i + 1] || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
    let suites = OFFLINE.concat(argv.includes('--pb') ? POCKETBASE : []);
    if (only.length) suites = suites.filter(([name]) => only.some((o) => name.toLowerCase().includes(o)));
    const t0 = Date.now();
    const failed = [];
    for (const [name, cmd, args] of suites) {
        const t = Date.now();
        const r = await run(cmd, args);
        const secs = ((Date.now() - t) / 1000).toFixed(1);
        if (r.code === 0) {
            console.log(`ok    ${name.padEnd(32)} ${secs.padStart(5)} s`);
        } else {
            failed.push(name);
            console.log(`FAIL  ${name.padEnd(32)} ${secs.padStart(5)} s   (${[cmd === node ? 'node' : cmd, ...args].join(' ')})`);
            console.log(r.out.trim().split('\n').slice(-25).map((l) => '      ' + l).join('\n'));
        }
    }
    console.log(`\n${suites.length - failed.length} of ${suites.length} suites passed in ${((Date.now() - t0) / 1000).toFixed(0)} s` +
        (argv.includes('--pb') ? '' : ' (PocketBase suites: npm test -- --pb)'));
    process.exitCode = failed.length ? 1 : 0;
}

main();
