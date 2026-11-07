'use strict';
// A throwaway PocketBase for the vm/dev tests: a temporary --dir, a temporary COPY of
// vm/pocketbase/pb_migrations and --automigrate=false, so nothing a test creates, alters or deletes
// can ever write a migration file into the repo (PocketBase's default is --automigrate=true).
//
//   const pbLocal = require('./lib/local-pb');
//   const pb = await pbLocal.start();        // { url, email, password, envFile, dir, stop() }
//   ...
//   await pb.stop();                          // also fails if PocketBase wrote a migration file
//
// The binary: PB_BIN, else vm/pocketbase/local/pocketbase (git-ignored; the version in vm/pocketbase/VERSION).

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const MIGRATIONS = path.join(ROOT, 'vm', 'pocketbase', 'pb_migrations');
const VERSION = (() => { try { return fs.readFileSync(path.join(ROOT, 'vm', 'pocketbase', 'VERSION'), 'utf8').trim(); } catch (_) { return '?'; } })();

function binary() {
    return process.env.PB_BIN || path.join(ROOT, 'vm', 'pocketbase', 'local', 'pocketbase');
}

function available() {
    return fs.existsSync(binary());
}

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

/** Refuse anything but a PocketBase on this machine (the tests create and delete collections). */
function assertLocal(url) {
    let host = '';
    try { host = new URL(url).hostname; } catch (_) { /* invalid */ }
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) throw new Error(`refusing PB_URL ${url || '(none)'}: only a local PocketBase`);
}

/** Start one. → { url, email, password, envFile, dir, migrationsDir, stop() } */
async function start({ port } = {}) {
    const bin = binary();
    if (!fs.existsSync(bin)) throw new Error(`No PocketBase binary at ${bin}: copy v${VERSION} there (git-ignored) or set PB_BIN`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mzo-test-pb-'));
    const mig = path.join(dir, 'pb_migrations');
    fs.mkdirSync(mig);
    const copied = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.js'));
    for (const f of copied) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(mig, f));
    const flags = [`--dir=${path.join(dir, 'pb_data')}`, `--migrationsDir=${mig}`, '--automigrate=false'];
    const email = 'test-superuser@example.com';
    const password = crypto.randomBytes(16).toString('hex');
    const up = spawnSync(bin, ['superuser', 'upsert', email, password, ...flags], { encoding: 'utf8' });
    if (up.status !== 0) throw new Error('PocketBase superuser upsert failed: ' + up.stderr + up.stdout);
    port = port || await freePort();
    const url = `http://127.0.0.1:${port}`;
    const proc = spawn(bin, ['serve', `--http=127.0.0.1:${port}`, ...flags], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    let up2 = false;
    for (let i = 0; i < 150 && !up2; i++) {
        try { up2 = (await fetch(url + '/api/health')).ok; } catch (_) { /* not yet */ }
        if (!up2) {
            if (proc.exitCode !== null) break;
            await new Promise((r) => setTimeout(r, 100));
        }
    }
    if (!up2) {
        proc.kill();
        fs.rmSync(dir, { recursive: true, force: true });
        throw new Error(`PocketBase did not start on ${url}:\n${out}`);
    }
    const envFile = path.join(dir, 'pb.env');
    fs.writeFileSync(envFile, `PB_URL=${url}\nPB_SUPERUSER_EMAIL=${email}\nPB_SUPERUSER_PASSWORD=${password}\n`, { mode: 0o600 });
    return {
        url, email, password, envFile, dir, migrationsDir: mig,
        /** Stop it and remove its folder. Throws if PocketBase wrote any migration file meanwhile. */
        async stop() {
            if (proc.exitCode === null) {
                const gone = new Promise((r) => proc.once('exit', r));
                proc.kill();
                await gone;
            }
            const extra = fs.readdirSync(mig).filter((f) => !copied.includes(f));
            fs.rmSync(dir, { recursive: true, force: true });
            if (extra.length) throw new Error(`PocketBase wrote migration files (automigrate must be off): ${extra.join(', ')}`);
        }
    };
}

module.exports = { start, available, assertLocal, binary, MIGRATIONS };
