#!/usr/bin/env node
// Syntax check for the whole repo (CI runs this; run it locally before a commit):
//   node scripts/tools/check_syntax.js [dir]
// - `node --check` on every .js/.mjs/.cjs file outside node_modules
// - `node --check` on every inline <script> block in .html files (blocks with src= and
//   non-JS types such as application/json are skipped; type="module" is checked as ESM)
// - JSON.parse on every .json file
// - no dataset files tracked in git (scripts/tools/check_data_files.js)
// - only hand-written PocketBase migrations (scripts/tools/check_migrations.js)
// Files come from `git ls-files` (tracked plus untracked, not ignored) when the folder is a
// git checkout, else from a directory walk. Exit code 1 when anything fails.
'use strict';

const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.realpathSync(path.resolve(process.argv[2] || process.cwd()));
const SKIP_DIRS = new Set(['node_modules', '.git']);
const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'application/ecmascript',
    'text/ecmascript', 'module']);

function listFiles() {
    try {
        const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
            { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
        return [...new Set(out.split('\0').filter(Boolean))]
            .filter((f) => !f.split('/').some((part) => SKIP_DIRS.has(part)))
            .filter((f) => fs.existsSync(path.join(ROOT, f)));
    } catch (_) {
        const files = [];
        (function walk(dir) {
            for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
                if (SKIP_DIRS.has(e.name)) continue;
                const rel = dir ? `${dir}/${e.name}` : e.name;
                if (e.isDirectory()) walk(rel);
                else if (e.isFile()) files.push(rel);
            }
        })('');
        return files;
    }
}

// Inline script blocks, found the way a browser does: comments are skipped and a block
// ends at the first </script>.
function inlineScripts(html) {
    const blocks = [];
    const re = /<!--|<script\b([^>]*)>/gi;
    let m;
    while ((m = re.exec(html))) {
        if (m[0] === '<!--') {
            const end = html.indexOf('-->', re.lastIndex);
            if (end === -1) break;
            re.lastIndex = end + 3;
            continue;
        }
        const attrs = m[1] || '';
        const start = re.lastIndex;
        const close = html.slice(start).search(/<\/script\s*>/i);
        const end = close === -1 ? html.length : start + close;
        re.lastIndex = end;
        if (/\bsrc\s*=/i.test(attrs)) continue;
        const t = attrs.match(/\btype\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
        const type = t ? (t[2] ?? t[3] ?? t[4] ?? '').trim().toLowerCase() : '';
        if (!JS_TYPES.has(type)) continue;
        const code = html.slice(start, end);
        if (!code.trim()) continue;
        const line = html.slice(0, start).split('\n').length;
        blocks.push({ code, line, module: type === 'module' });
    }
    return blocks;
}

function nodeCheck(file) {
    return new Promise((resolve) => {
        execFile(process.execPath, ['--check', file], { maxBuffer: 4 * 1024 * 1024 }, (err, _out, stderr) => {
            resolve(err ? String(stderr || err.message) : null);
        });
    });
}

async function pool(items, limit, fn) {
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) await fn(items[i++]);
    });
    await Promise.all(workers);
}

async function main() {
    const files = listFiles();
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mzo-check-')));
    const jobs = [];
    const failures = [];
    let jsonCount = 0;
    let blockCount = 0;

    for (const f of files) {
        const abs = path.join(ROOT, f);
        if (/\.(c|m)?js$/i.test(f)) {
            jobs.push({ label: f, file: abs });
        } else if (/\.html?$/i.test(f)) {
            inlineScripts(fs.readFileSync(abs, 'utf8')).forEach((b, n) => {
                // Pad with blank lines so node's line numbers match the HTML file.
                const out = path.join(tmp, `${f.replace(/[^\w.-]+/g, '_')}.${n}${b.module ? '.mjs' : '.js'}`);
                fs.writeFileSync(out, '\n'.repeat(b.line - 1) + b.code);
                jobs.push({ label: `${f} (inline script at line ${b.line})`, file: out, html: f });
                blockCount++;
            });
        } else if (/\.json$/i.test(f)) {
            jsonCount++;
            try {
                JSON.parse(fs.readFileSync(abs, 'utf8').replace(/^﻿/, ''));
            } catch (e) {
                failures.push(`${f}: invalid JSON: ${e.message}`);
            }
        }
    }

    await pool(jobs, Math.max(2, os.cpus().length), async (job) => {
        const err = await nodeCheck(job.file);
        if (err) {
            const text = err.split(job.file).join(job.html || job.label);
            failures.push(`${job.label}:\n${text.trim().split('\n').slice(0, 6).join('\n')}`);
        }
    });
    fs.rmSync(tmp, { recursive: true, force: true });

    failures.push(...require('./check_data_files').checkTrackedData(ROOT));
    failures.push(...require('./check_migrations').checkMigrations(ROOT));

    const jsFiles = jobs.length - blockCount;
    console.log(`Checked ${jsFiles} JS files, ${blockCount} inline scripts, ${jsonCount} JSON files.`);
    if (failures.length) {
        console.error(`\n${failures.length} problem(s):\n`);
        failures.sort().forEach((f) => console.error(`${f}\n`));
        process.exit(1);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
