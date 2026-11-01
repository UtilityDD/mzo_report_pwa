/**
 * Shared plumbing for the sync jobs in this folder: read a published Google Sheet CSV,
 * upload it (and a meta.json) to the Supabase Storage 'reports' bucket.
 *
 * The jobs run from the command line (npm run sync:*) and from server.js (the in-app
 * Sync buttons). Storage credentials: INSIGHT_SUPABASE_URL + INSIGHT_SUPABASE_KEY (or
 * SUPABASE_SERVICE_ROLE_KEY); locally data/supabase_config.json (insightUrl / insightKey) wins.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const BUCKET = process.env.REPORTS_STORAGE_BUCKET || 'reports';

const storage = (() => {
    let url = process.env.INSIGHT_SUPABASE_URL || '';
    let key = process.env.INSIGHT_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'supabase_config.json'), 'utf8'));
        if (cfg.insightUrl) url = cfg.insightUrl;
        if (cfg.insightKey) key = cfg.insightKey;
    } catch (_) { /* no local config */ }
    return { url: String(url).replace(/\/$/, ''), key };
})();

/** Division by the first four digits of a CCC code. */
const DIV_BY_CODE = {
    6611: 'Malda',
    6612: 'Chanchal',
    6613: 'Gazole',
    6621: 'Raiganj',
    6622: 'Islampur',
    6631: 'Balurghat',
    6632: 'Buniadpur'
};

/** One CSV line → fields (quoted fields, "" escapes). Fields are not trimmed. */
function parseCsvLine(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
            if (inQuotes && line[i + 1] === '"') {
                cur += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (c === ',' && !inQuotes) {
            out.push(cur);
            cur = '';
        } else {
            cur += c;
        }
    }
    out.push(cur);
    return out;
}

async function fetchCsv(url, label) {
    const t0 = Date.now();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${label} fetch HTTP ${res.status}`);
    const text = await res.text();
    console.log(`[${label}] Downloaded in ${Date.now() - t0}ms (${(text.length / 1024).toFixed(1)} KB)`);
    return text;
}

function storageConfigured() {
    return !!(storage.url && storage.key);
}

/** Upsert one object in the reports bucket; returns its public URL. Throws on an HTTP error. */
async function upload(objectPath, body, contentType) {
    const res = await fetch(`${storage.url}/storage/v1/object/${BUCKET}/${objectPath}`, {
        method: 'POST',
        headers: {
            apikey: storage.key,
            Authorization: 'Bearer ' + storage.key,
            'Content-Type': contentType,
            'x-upsert': 'true'
        },
        body
    });
    if (!res.ok) {
        throw new Error(`Upload ${objectPath} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
    return `${storage.url}/storage/v1/object/public/${BUCKET}/${objectPath}`;
}

/**
 * Upload <folder>/meta.json next to the snapshot (best effort) and keep a local copy in
 * data/<localFile> for scripts/tools/compute_briefing_cccs.js.
 */
async function publishMeta(folder, localFile, meta, label) {
    const json = JSON.stringify(meta, null, 2);
    // The local copy is optional: the server's filesystem on Vercel is read-only.
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(path.join(DATA_DIR, localFile), json, 'utf8');
    } catch (e) {
        console.warn(`[${label}] Local meta not saved: ${e.message}`);
    }
    if (!storageConfigured()) return;
    try {
        await upload(`${folder}/meta.json`, json, 'application/json');
        console.log(`[${label}] Uploaded ${folder}/meta.json`);
    } catch (e) {
        console.warn(`[${label}] meta.json upload error: ${e.message}`);
    }
}

/** CLI entry: run the job when the file is executed directly. */
function cli(mod, run, label) {
    if (require.main !== mod) return;
    run().catch((err) => {
        console.error(`[${label}] Error:`, err);
        process.exit(1);
    });
}

module.exports = { DIV_BY_CODE, parseCsvLine, fetchCsv, storageConfigured, upload, publishMeta, cli };
