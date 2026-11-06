'use strict';
// What the data editor needs from its host: the PocketBase superuser client, the snapshot folder,
// the sync's lock folder and source definitions. Everything is read from the environment the app
// already has on the VM (/etc/mzo/pocketbase.env through the systemd unit, MZO_SNAPSHOT_DIR,
// SYNC_TMP_DIR). Without PB_URL and the superuser login the editor is off (Vercel, local default).

const fs = require('fs');
const path = require('path');

const SYNC_DIR = path.join(__dirname, '..', '..', 'vm', 'sync');
const SYNC = path.join(SYNC_DIR, 'lib');

function create(envIn) {
    const env = envIn || process.env;
    const url = String(env.PB_URL || '').trim();
    const email = String(env.PB_SUPERUSER_EMAIL || '').trim();
    const password = String(env.PB_SUPERUSER_PASSWORD || '');
    const enabled = !!(url && email && password) && fs.existsSync(path.join(SYNC, 'pb.js'));
    let pb = null;
    let authed = null;

    async function client() {
        if (!enabled) throw Object.assign(new Error('The data editor runs on the VM only (no PocketBase here).'), { status: 503 });
        if (!pb) {
            const { PocketBase } = require(path.join(SYNC, 'pb'));
            pb = new PocketBase({ url, email, password });
        }
        if (!authed) authed = pb.auth().catch((err) => { authed = null; throw err; });
        await authed;
        return pb;
    }

    const snapshotDir = (() => {
        try {
            return require(path.join(SYNC, 'snapshot')).snapshotDir(env);
        } catch (_) {
            return null;
        }
    })();
    const tmpDir = env.SYNC_TMP_DIR || env.CACHE_DIRECTORY || path.join(SYNC_DIR, '.tmp');

    // Source definitions (vm/sync/sources/*.js), loaded once and only when needed: google.js and
    // files.js first; supabase.js (which also probes Supabase's API root) only for keys not found there.
    let sourceCache = null;
    async function sources(wantKey) {
        if (sourceCache && (!wantKey || sourceCache.has(wantKey) || sourceCache.full)) return sourceCache;
        const { makeSourceFetch } = require(path.join(SYNC, 'http'));
        const ctx = { fetch: makeSourceFetch(), log: () => {}, env, limits: { maxRowsPerBatch: 500 } };
        const map = sourceCache || new Map();
        const files = ['google.js', 'files.js', 'supabase.js'];
        for (const file of files) {
            if (map.files && map.files.has(file)) continue;
            if (file === 'supabase.js' && wantKey && map.has(wantKey)) break;
            try {
                const mod = require(path.join(SYNC_DIR, 'sources', file));
                const fn = typeof mod === 'function' ? mod : mod.sources;
                const list = await fn(ctx);
                for (const s of list || []) if (s && s.key && !map.has(s.key)) map.set(s.key, s);
            } catch (_) { /* a broken source file never stops the editor */ }
            (map.files || (map.files = new Set())).add(file);
            if (wantKey && map.has(wantKey)) break;
        }
        map.full = files.every((f) => map.files && map.files.has(f));
        sourceCache = map;
        return map;
    }

    async function source(key) {
        const map = await sources(key);
        return map.get(key) || null;
    }

    return { enabled, client, snapshotDir, tmpDir, source, env, SYNC, SYNC_DIR };
}

module.exports = { create, SYNC, SYNC_DIR };
