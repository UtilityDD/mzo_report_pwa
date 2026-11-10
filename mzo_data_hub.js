// mzo_data_hub.js — one IndexedDB cache for every report dataset (window.mzoDataHub).
// Each dataset keeps a version in localStorage (mzo_hub_ver_<key>); opening a page only downloads the
// body when the remote version differs. Options per dataset:
//   lazySync     multi-MB sheet: never re-downloaded just to find its version (needs a versionUrl or a forced refresh)
//   originHeavy  body comes from meta.csvUrl (Google / Supabase Storage), not through Vercel
//   versionUrl   small JSON with { version, csvUrl } (field names via versionField / csvUrlField)
// Mirror mode (VM): when /api/data/manifest lists a dataset under dataHubKeys, its version comes from
// the manifest and its body from /api/data/file/<key>; otherwise (or on any failure) the logic above.

const DB_NAME = 'MZODashboardData';
const DB_VERSION = 1;
const STORE_NAME = 'datasets';

const DATASETS = [
    { key: 'CACHE_SAFETY_v2', label: 'Safety Inspection', url: '/api/safety/dataset', type: 'csv', originHeavy: true, versionUrl: '/api/safety/meta', csvUrlField: 'csvUrl', versionField: 'version', lazySync: true },
    { key: 'CACHE_DOCKET', label: 'Docket Calls', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTT56PULgjKw_-wu8lmMWNE6SC1KBDyAKxeHaMloZJWUQ9HQsJoqosYF33DrQK3NX9Bvfn0mjfx-dkP/pub?gid=1059428699&single=true&output=csv', type: 'csv' },
    // originHeavy: skip homepage sync unless meta.csvUrl points at Google or Supabase Storage
    { key: 'CACHE_NSC_v5', label: 'NSC Data', url: '/api/nsc/dataset', type: 'csv', originHeavy: true, versionUrl: '/api/nsc/meta', csvUrlField: 'csvUrl' },
    { key: 'CACHE_LOAD_EXT', label: 'Load Extension', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQP_B-Zl5XhnYkmJiDXKB7B8ksrRRezuLrRqTzEPz4lEw_yDcpGOTnmm0oI8dW9apwuHg9yGqaAqjDS/pub?gid=0&single=true&output=csv', type: 'csv', originHeavy: true, versionUrl: '/api/load-extension/meta', csvUrlField: 'csvUrl', versionField: 'version', lazySync: true },
    { key: 'CACHE_COLLECTION', label: 'Collection Report', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ2S20QZ57pQpdawzKFHAIqD_OpCNmbmMbYlttluLVA0JZpVK405pS0-2ZIqm-X9jAA8ZB1XwF2serr/pub?gid=1977250749&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_LOSS', label: 'Loss Report', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSYyqn0urGdbqXarhELRbSCeRvgUCSHID_1Z4E_kptBTR5u69R0HHX0Jk23n6KseriNct2q9XwXu04E/pub?output=csv', type: 'csv' },
    { key: 'CACHE_LOSS_TARGET', label: 'Loss Targets', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSYyqn0urGdbqXarhELRbSCeRvgUCSHID_1Z4E_kptBTR5u69R0HHX0Jk23n6KseriNct2q9XwXu04E/pub?gid=2042465667&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_FEEDER_OUTAGE', label: 'Feeder Outage', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTsRzMOPBm3foslF8BadPmN24KrV2kGZCAsX7GWrmIDm0uppSLmov0n51ZkKLMz2vJMIFpqYGJETm7R/pub?gid=0&single=true&output=csv', type: 'csv' },
    // Prefers uploaded dataset via /api/withheld/dataset (Supabase); fallback sheet/JSON on server
    { key: 'CACHE_WITHHELD_v4', label: 'Withheld NSC', url: '/api/withheld/dataset', type: 'csv', originHeavy: true, versionUrl: '/api/nsc/meta', csvUrlField: 'withheldCsvUrl', versionField: 'withheldVersion' },
    { key: 'CACHE_WEEKLY', label: 'Weekly Report', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSMuO-ddereEG6J2s2Bmqp-HXo85ky4S4R5Yt-0HdoNHHa5r8xOEK4MJ1Syhyqzjpm2lTI4sT85nR4N/pub?gid=0&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_PENDING_MC', label: 'Pending Master Card', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQmOUW4jxUtEGWhPHaoNBsvpBcGzhHJZRUx_9mxFBp91sfg4yD8WIqIK_xv0vlFs2yP-Ljz09JW1U2c/pub?gid=0&single=true&output=csv', type: 'csv', originHeavy: true, versionUrl: '/api/pending-mc/meta', csvUrlField: 'csvUrl', versionField: 'version', lazySync: true },
    // Uploaded on the VM (cmo.html > Upload): /api/cmo/dataset serves the upload, else the VM's last copy, else redirects to the old sheet.
    { key: 'CACHE_CMO', label: 'CMO Grievances', url: '/api/cmo/dataset', type: 'csv', uploadedOn: '/cmo.html' },
    { key: 'CACHE_STOCK', label: 'Stock Data', url: '/api/stock/dataset', type: 'csv', originHeavy: true, versionUrl: '/api/stock/meta', csvUrlField: 'csvUrl' },
    { key: 'CACHE_POWER_MAP', label: 'Power Map', url: '/api/power-map/data', type: 'csv', originHeavy: true, versionUrl: '/api/power-map/meta', csvUrlField: 'csvUrl' },
    { key: 'CACHE_STOCK_METADATA', label: 'Stock Metadata', url: 'https://docs.google.com/spreadsheets/d/1wDvPuAxNfdO9QzUaIUubg2JnkFM5ZleFNXQdi8s5uh0/export?format=csv&gid=696716331', type: 'csv' },
    { key: 'CACHE_CAPEX', label: 'CAPEX Details', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQI2neSVbvMR4fF910Q0AWUcq02leP-sob8q4f9goT46hgLutCpxCjSL6y6X3s2vYBJRNN7WrFCjE0R/pub?gid=439685010&single=true&output=csv', type: 'csv', lazySync: true },
    { key: 'CACHE_VENDORS', label: 'Vendor Map', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTZPn6CB_cHTFVb8S5vpvaBnczj63fYMTI0RVEdMzVcQ8O6XQi5iwTbMp2xa5vsL6zHGWxezWUSehrN/pub?gid=1818971964&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_COSTCENTER', label: 'Cost Center Map', url: '/data/costcenter.json', type: 'json' },
    { key: 'CACHE_REM_v2', label: 'REM Data', url: 'https://docs.google.com/spreadsheets/d/18y_nHZngDDO13nlluN9qba7AfgDe5dKGGHnXRYUU-b8/gviz/tq?tqx=out:csv', type: 'csv' },
    { key: 'CACHE_DEFECTIVE', label: 'Defective Meter', url: 'https://docs.google.com/spreadsheets/d/1dMLSX2bZBqZMPooh7_CrniCjqgy4MijaFW62GKJJldA/export?format=csv&gid=0', type: 'csv', originHeavy: true, versionUrl: '/api/defective/meta', csvUrlField: 'summaryCsvUrl', versionField: 'version', lazySync: true },
    { key: 'CACHE_DEFECTIVE_DETAILS', label: 'Defective Meter Details', url: 'https://docs.google.com/spreadsheets/d/1dMLSX2bZBqZMPooh7_CrniCjqgy4MijaFW62GKJJldA/export?format=csv&gid=1638574999', type: 'csv', originHeavy: true, versionUrl: '/api/defective/meta', csvUrlField: 'detailsCsvUrl', versionField: 'version', lazySync: true },
    { key: 'CACHE_REM_DEFAULTERS', label: 'REM Ind/Com Defaulters', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQOynlOrqc0iXUKYDgqh-tTjIgDA5WidJDcDhYM7MhfKIZzZ7iduFD2LN4fYRXmVvcLCz1X-OJfcmRx/pub?gid=0&single=true&output=tsv', type: 'csv' },
    { key: 'CACHE_REM_AGRI', label: 'REM Agri Defaulters', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRFk-wa_x-dsthFXNsWa9wRxWOQrMD-yEiucvA2FtJIbwnTiGqVs3OT_eXxqyAOBqvGSDRiG-Hr0hK1/pub?gid=0&single=true&output=tsv', type: 'csv' },
    { key: 'CACHE_REM_DOM', label: 'REM Dom Defaulters', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRFk-wa_x-dsthFXNsWa9wRxWOQrMD-yEiucvA2FtJIbwnTiGqVs3OT_eXxqyAOBqvGSDRiG-Hr0hK1/pub?gid=1106133732&single=true&output=tsv', type: 'csv' },
    { key: 'CACHE_THEFT_ASSESSMENT_v2', label: 'Theft Assessment', url: 'https://docs.google.com/spreadsheets/d/1RiP2NDE6BgtgEp3Fufpx1G8p9k3VR786TY60LpvMdZM/export?format=csv', type: 'csv', lazySync: true },
    { key: 'CACHE_SOLAR', label: 'Solar Data', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vR5Vnb9TxymVIcBZsUBWZ-21Frkn77O4IyNus3Zo42qPm09N6MlJ3E0Vh3tHywcMAiy2y0uRm5XfIdk/pub?gid=0&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_JJM', label: 'JJM Connections', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTZfBrOb6Y4kPoF_Lix-MhUxVFy5l7urYoAoI-h-w6EbcTFuZPqIhjWTQ26RYcvYenl51HdpCawEVc7/pub?gid=2138035305&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_WRIDD', label: 'WRIDD Schemes', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTt6H8YfaFRi1H3KzVHv97nbhlJQ-96cuFh4J0KyVjRSw1I78BYxUek9etiE9xs-7vHYn98uPMc6sFj/pub?gid=0&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_BHARATNET', label: 'Bharat Net Connections', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRCD7M4eBch9ixyQH3N0F0k7Yjlw1zw92JNh_76l2orfROh-PElMo62bXeW0EHI9v-Zg5_0olpiQxmT/pub?gid=0&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_ICDS_APLUS', label: 'ICDS Connections A+', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRoJd2-uQ5XxKjJ8LO1kDPpN76DepB_COmXyIg8qtO7fA7DBU0cydL27t87tj7upjxoC_F7JSBdPkvJ/pub?gid=1839469967&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_ICDS_A', label: 'ICDS Connections A', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRoJd2-uQ5XxKjJ8LO1kDPpN76DepB_COmXyIg8qtO7fA7DBU0cydL27t87tj7upjxoC_F7JSBdPkvJ/pub?gid=193110110&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_PMSGY_MALDA', label: 'PM Surya Ghar Malda', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRcFPRu1ywimetADU-XYIZ_x3McWUhR5ZbPUIIySO6_V8VJTyU9Vhw8DD-1RBEPFj0q2pUFMvutYV30/pub?gid=1969412059&single=true&output=csv', type: 'csv', lazySync: true },
    { key: 'CACHE_PMSGY_UD', label: 'PM Surya Ghar Uttar Dinajpur', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRcFPRu1ywimetADU-XYIZ_x3McWUhR5ZbPUIIySO6_V8VJTyU9Vhw8DD-1RBEPFj0q2pUFMvutYV30/pub?gid=711223367&single=true&output=csv', type: 'csv', lazySync: true },
    { key: 'CACHE_PMSGY_DD', label: 'PM Surya Ghar Dakshin Dinajpur', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRcFPRu1ywimetADU-XYIZ_x3McWUhR5ZbPUIIySO6_V8VJTyU9Vhw8DD-1RBEPFj0q2pUFMvutYV30/pub?gid=40136871&single=true&output=csv', type: 'csv', lazySync: true },
    { key: 'CACHE_METER_ERP', label: 'Meter ERP Data', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSmzya-jypjfu9nN5QWuRJ6sbIgrqQ7Wa1eAx6Wfoepft2UpNwBC4a_rd4uJ6VpLhNu7FnjDBa8mJxW/pub?gid=1335293243&single=true&output=csv', type: 'csv', lazySync: true },
    { key: 'CACHE_METER_MASTER', label: 'Meter Master Data', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSmzya-jypjfu9nN5QWuRJ6sbIgrqQ7Wa1eAx6Wfoepft2UpNwBC4a_rd4uJ6VpLhNu7FnjDBa8mJxW/pub?gid=1053803476&single=true&output=csv', type: 'csv', lazySync: true },
    { key: 'CACHE_METER_CRM', label: 'Meter CRM Data', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSmzya-jypjfu9nN5QWuRJ6sbIgrqQ7Wa1eAx6Wfoepft2UpNwBC4a_rd4uJ6VpLhNu7FnjDBa8mJxW/pub?gid=1638328510&single=true&output=csv', type: 'csv', lazySync: true },
    { key: 'CACHE_METER_ISU', label: 'Meter ISU Data', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSmzya-jypjfu9nN5QWuRJ6sbIgrqQ7Wa1eAx6Wfoepft2UpNwBC4a_rd4uJ6VpLhNu7FnjDBa8mJxW/pub?gid=329630218&single=true&output=csv', type: 'csv', lazySync: true },
    { key: 'CACHE_DISCONNECTION', label: 'Disconnection Tracker', url: '/api/disconnection/dataset', type: 'csv', originHeavy: true, versionUrl: '/api/disconnection/meta', csvUrlField: 'csvUrl', versionField: 'version', lazySync: true },
    { key: 'CACHE_OSD_SUMMARY', label: 'OSD Summary', url: '/api/osd/summary', type: 'json', versionUrl: '/api/osd/meta', versionField: 'version', lazySync: true }
    // CACHE_DD_VISIT removed: the DD visit sheet holds PAN numbers and is read with no-store by dd_visit.html (MzoRows.build); nothing caches it.
];

const FETCH_TIMEOUT_MS = 90000;

/** Parsed/index copies that must die when the raw dump is replaced. */
const PARSED_COMPANIONS = {
    CACHE_NSC_v5: ['CACHE_NSC_PARSED_v7', 'CACHE_NSC_PARSED_v5'],
    CACHE_WITHHELD_v4: ['CACHE_WITHHELD_PARSED_v4'],
    CACHE_PENDING_MC: ['CACHE_PENDING_MC_PARSED'],
    CACHE_METER_ERP: ['CACHE_METER_PARSED_v1'],
    CACHE_METER_MASTER: ['CACHE_METER_PARSED_v1'],
    CACHE_METER_CRM: ['CACHE_METER_PARSED_v1'],
    CACHE_METER_ISU: ['CACHE_METER_PARSED_v1']
};

// Server-published row counts: a body with fewer than 95% of these rows is not cached.
const ROW_CHECKS = [
    { prefix: 'CACHE_NSC', label: 'NSC', headers: ['X-NSC-Published-Rows', 'X-NSC-Row-Count'], metaField: 'publishedRows' },
    { prefix: 'CACHE_WITHHELD', label: 'Withheld', headers: ['X-Withheld-Rows', 'X-Withheld-Row-Count'], metaField: 'withheldRows' }
];
const PROBE_MAX_BYTES = 2048;

// Mirror mode (VM only): the server keeps a copy of every source and lists it in one manifest.
// One manifest request per page (shared by the shell's frames through sessionStorage for 20 s)
// replaces the per-dataset meta calls and Google probes. 204 or 404 means there is no mirror
// (Vercel): remembered for 30 min, and everything works as before. Any other failure falls back
// to the original source for that page or dataset.
const MIRROR = {
    manifestUrl: '/api/data/manifest',
    fileUrl: '/api/data/file/',
    shareKey: 'mzo_mirror_manifest',   // sessionStorage: { at, m }
    offKey: 'mzo_mirror_off',          // localStorage: time of the last 404
    holdPrefix: 'mzo_mirror_hold_',    // localStorage per dataset: { v, until }
    ttlMs: 20000,
    offMs: 30 * 60 * 1000,
    holdMs: 20 * 60 * 1000,
    timeoutMs: 5000
};

/** Same source URL however it is written: no #fragment, no single=true, no ?v= (Storage version), sorted query. */
function mirrorNormUrl(url) {
    try {
        const u = new URL(String(url || '').trim(), location.href);
        const pairs = [];
        u.searchParams.forEach((v, k) => { if (k !== 'v' && !(k === 'single' && v === 'true')) pairs.push([k, v]); });
        pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));
        const q = pairs.map((p) => encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1])).join('&');
        return u.origin.toLowerCase() + u.pathname + (q ? '?' + q : '');
    } catch (e) {
        return '';
    }
}

class DataHub {
    constructor() {
        this.db = null;
        this.initPromise = this._initDB();
        this.syncStatus = {}; // Tracks: 'idle', 'syncing', 'done', 'error'
        this.syncPromises = {}; // Tracks active fetch promises for individual datasets
        this._recent = {}; // key -> { v, ver }: last large body read, so a repeat _peek skips IndexedDB
        this._mirror = null; // { at, generatedAt, hub, urls, names }
        this._mirrorPending = null;
        this._mirrorFailAt = 0;
    }

    /* ---------- mirror manifest ---------- */

    _mirrorIsOff() {
        try {
            const t = Number(localStorage.getItem(MIRROR.offKey) || 0);
            if (t && Date.now() - t < MIRROR.offMs) return true;
            if (t) localStorage.removeItem(MIRROR.offKey);
        } catch (e) {}
        return false;
    }

    _mirrorBuild(m, at) {
        const hub = {};
        const urls = {};
        const names = {};
        const sets = (m && m.datasets) || {};
        Object.keys(sets).forEach((name) => {
            const e = sets[name];
            if (!e || e.sensitive || !e.version) return;
            names[name] = String(e.version);
            const hubUrl = e.dataHubUrl;
            (Array.isArray(e.dataHubKeys) ? e.dataHubKeys : []).forEach((h) => {
                if (hub[h]) return;
                const u = typeof hubUrl === 'string' ? hubUrl : (hubUrl && hubUrl[h]);
                hub[h] = { name, e, url: (typeof u === 'string' && u.charAt(0) === '/') ? u : MIRROR.fileUrl + encodeURIComponent(name) };
            });
            (Array.isArray(e.urls) ? e.urls : []).forEach((raw) => {
                const n = mirrorNormUrl(raw);
                if (n && !urls[n]) urls[n] = name;
            });
        });
        return { at, generatedAt: (m && m.generatedAt) || '', hub, urls, names };
    }

    _mirrorShared(maxAge) {
        try {
            const s = JSON.parse(sessionStorage.getItem(MIRROR.shareKey) || 'null');
            const age = s ? Date.now() - Number(s.at || 0) : Infinity;
            if (s && s.m && age >= 0 && age < maxAge) return this._mirrorBuild(s.m, Number(s.at));
        } catch (e) {}
        return null;
    }

    _mirrorFetch() {
        if (this._mirrorPending) return this._mirrorPending;
        this._mirrorPending = (async () => {
            try {
                const res = await this._fetchWithTimeout(MIRROR.manifestUrl, {
                    credentials: 'same-origin',
                    cache: 'no-cache',
                    headers: { Accept: 'application/json' }
                }, MIRROR.timeoutMs);
                // No mirror on this server: 204 (no console noise), or 404 where the route does not exist.
                const off = () => {
                    try { localStorage.setItem(MIRROR.offKey, String(Date.now())); sessionStorage.removeItem(MIRROR.shareKey); } catch (e) {}
                    this._mirror = null;
                    return null;
                };
                if (res.status === 204 || res.status === 404) return off();
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const m = await res.json();
                if (m && m.mode === 'off') return off();
                if (!m || typeof m.datasets !== 'object') throw new Error('not a manifest');
                const at = Date.now();
                try { sessionStorage.setItem(MIRROR.shareKey, JSON.stringify({ at, m })); } catch (e) {}
                this._mirror = this._mirrorBuild(m, at);
                return this._mirror;
            } catch (e) {
                this._mirrorFailAt = Date.now();
                return null;
            } finally {
                this._mirrorPending = null;
            }
        })();
        return this._mirrorPending;
    }

    /** The manifest index, or null when there is no mirror. fresh: a forced check wants a copy under 3 s old. */
    async mirrorManifest(fresh) {
        if (this._mirrorIsOff()) return null;
        const maxAge = fresh ? 3000 : MIRROR.ttlMs;
        const cur = this._mirror;
        if (cur && Date.now() - cur.at < maxAge) return cur;
        if (this._mirrorPending) return this._mirrorPending;
        const shared = this._mirrorShared(maxAge);
        if (shared) return (this._mirror = shared);
        // The shell starts the manifest request before its frames load: wait for it.
        try {
            const p = window.parent !== window && window.parent.__mzoManifestPending;
            if (p && typeof p.then === 'function') {
                await p;
                const again = this._mirrorShared(maxAge);
                if (again) return (this._mirror = again);
            }
        } catch (e) {}
        if (this._mirrorIsOff()) return null;
        if (!fresh && Date.now() - this._mirrorFailAt < MIRROR.ttlMs) return null;
        return this._mirrorFetch();
    }

    /** { name, e, url } for a DataHub key served by the mirror, else null. */
    async _mirrorFor(key, fresh) {
        const idx = await this.mirrorManifest(fresh);
        const hit = idx && idx.hub[key];
        if (!hit) return null;
        const dataset = DATASETS.find((d) => d.key === key);
        const ct = String(hit.e.contentType || '').toLowerCase();
        // A JSON copy cannot stand in for a CSV body (or the reverse) unless the server rebuilds it.
        if (dataset && ct && hit.url.indexOf(MIRROR.fileUrl) === 0) {
            if ((dataset.type === 'json') !== (ct.indexOf('json') !== -1)) return null;
        }
        return hit;
    }

    /** The original source URL of a mirrored dataset (for forced refreshes and fallbacks). */
    _mirrorOrigin(hit, dataset) {
        const urls = (hit && Array.isArray(hit.e.urls)) ? hit.e.urls : [];
        const abs = urls.filter((u) => /^https?:\/\//i.test(String(u)));
        if (dataset && /^https?:\/\//i.test(dataset.url)) {
            const want = mirrorNormUrl(dataset.url);
            const same = abs.find((u) => mirrorNormUrl(u) === want);
            if (same) return same;
        }
        return abs[0] || '';
    }

    // A forced refresh or a seeded upload is newer than the mirror's current copy: keep the
    // local body until the mirror moves past that version (or the hold expires).
    _mirrorHold(key, ver) {
        try { localStorage.setItem(MIRROR.holdPrefix + key, JSON.stringify({ v: ver, until: Date.now() + MIRROR.holdMs })); } catch (e) {}
    }

    _mirrorHeld(key, ver) {
        try {
            const raw = localStorage.getItem(MIRROR.holdPrefix + key);
            if (!raw) return false;
            const h = JSON.parse(raw);
            if (h && h.v === ver && Date.now() < h.until) return true;
            localStorage.removeItem(MIRROR.holdPrefix + key);
        } catch (e) {}
        return false;
    }

    /**
     * The page wrote these sheets itself (Apps Script), so the server cannot know: ask it to sync
     * them now. Mirror mode only (Vercel never sees the call); never rejects, never waits on the UI.
     */
    async mirrorRefresh(keys, reason) {
        try {
            if (!(await this.mirrorManifest(false))) return;
            await fetch('/api/data/refresh', {
                method: 'POST',
                credentials: 'same-origin',
                keepalive: true,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keys: [].concat(keys || []), reason: String(reason || '').slice(0, 200) })
            });
        } catch (e) {}
    }

    /** { mode: 'mirror' | 'origin', generatedAt } for this page (one manifest request at most). */
    async mirrorStatus() {
        const idx = await this.mirrorManifest(false);
        return idx ? { mode: 'mirror', generatedAt: idx.generatedAt } : { mode: 'origin', generatedAt: '' };
    }

    /** Mirror URL for an exact source URL, or the URL unchanged. */
    async mirrorUrl(url) {
        const n = mirrorNormUrl(url);
        if (!n || !/^https?:\/\//i.test(String(url || '').trim())) return url;
        const idx = await this.mirrorManifest(false);
        const name = idx && idx.urls[n];
        if (!name || this._mirrorHeld('url:' + name, idx.names[name])) return url;
        return MIRROR.fileUrl + encodeURIComponent(name);
    }

    /**
     * After a page writes a sheet itself (Apps Script), read that sheet from the source until the
     * mirror's copy changes (at most 2 h), so the page shows its own write at once.
     */
    async mirrorFresh(url) {
        const idx = await this.mirrorManifest(true);
        const name = idx && idx.urls[mirrorNormUrl(url)];
        if (!name) return;
        try {
            localStorage.setItem(MIRROR.holdPrefix + 'url:' + name, JSON.stringify({ v: idx.names[name], until: Date.now() + 2 * 3600 * 1000 }));
        } catch (e) {}
    }

    /** fetch() that reads the mirror copy of a source URL when there is one, else (or on failure) the source. */
    async mirrorFetch(url, init) {
        const mapped = await this.mirrorUrl(url);
        if (mapped !== url) {
            const opts = Object.assign({}, init || {});
            opts.credentials = 'same-origin';
            // The copy carries an ETag, so the browser cache can revalidate it instead of re-downloading.
            if (opts.cache === 'no-store' || opts.cache === 'reload') opts.cache = 'no-cache';
            try {
                const res = await fetch(mapped, opts);
                if (res.ok) return res;
                await this._cancelBody(res);
            } catch (e) {}
            console.warn('[DataHub] Mirror copy failed, reading the source:', url);
        }
        return fetch(url, init);
    }

    resetVersionChecks() {
        Object.keys(this.syncStatus).forEach((k) => {
            this.syncStatus[k] = 'idle';
        });
        this.syncPromises = {};
    }

    async _invalidateCompanions(key) {
        const extras = PARSED_COMPANIONS[key] || [];
        for (let i = 0; i < extras.length; i++) {
            try { await this.delete(extras[i]); } catch (e) {}
            this._writeStoredVersion(extras[i], '');
        }
    }

    _initDB() {
        return new Promise((resolve, reject) => {
            try {
                if (typeof indexedDB === 'undefined') {
                    console.warn("IndexedDB not supported. Falling back to memory storage.");
                    this.useMemoryFallback = true;
                    this.memoryCache = {};
                    resolve();
                    return;
                }
                const request = indexedDB.open(DB_NAME, DB_VERSION);

                request.onerror = (event) => {
                    console.warn("IndexedDB blocked (possibly incognito). Falling back to memory storage:", event.target.error);
                    this.useMemoryFallback = true;
                    this.memoryCache = {};
                    resolve();
                };

                request.onsuccess = (event) => {
                    this.db = event.target.result;
                    resolve(this.db);
                };

                request.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    if (!db.objectStoreNames.contains(STORE_NAME)) {
                        db.createObjectStore(STORE_NAME);
                    }
                };
            } catch (err) {
                console.warn("Error opening IndexedDB. Falling back to memory storage:", err.message);
                this.useMemoryFallback = true;
                this.memoryCache = {};
                resolve();
            }
        });
    }

    // Save data to cache
    async set(key, data) {
        await this.initPromise;
        delete this._recent[key];
        if (this.useMemoryFallback) {
            this.memoryCache[key] = data;
            return;
        }
        // Resolve once the write is committed, so a version written afterwards never points at an older body.
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.put(data, key);

            transaction.oncomplete = () => resolve();
            request.onerror = (e) => reject(e.target.error);
            transaction.onabort = () => reject(transaction.error || new Error('IndexedDB write aborted'));
        });
    }

    /** True when IndexedDB holds a body for key, without reading (and copying) the body. */
    async _hasStored(key) {
        await this.initPromise;
        if (this.useMemoryFallback) return this._hasBody(this.memoryCache[key]);
        if (!this.db) return false;
        return new Promise((resolve) => {
            try {
                const request = this.db.transaction([STORE_NAME], 'readonly').objectStore(STORE_NAME).count(key);
                request.onsuccess = () => resolve(request.result > 0);
                request.onerror = () => resolve(false);
            } catch (e) {
                resolve(false);
            }
        });
    }

    _versionStorageKey(key) {
        return 'mzo_hub_ver_' + key;
    }

    _readStoredVersion(key) {
        try {
            return localStorage.getItem(this._versionStorageKey(key)) || '';
        } catch (e) {
            return '';
        }
    }

    _writeStoredVersion(key, ver) {
        try {
            const storageKey = this._versionStorageKey(key);
            if (ver) localStorage.setItem(storageKey, String(ver));
            else localStorage.removeItem(storageKey);
        } catch (e) {}
    }

    _fetchedDayKey(key) {
        return 'mzo_hub_fetched_' + key;
    }

    _readFetchedDay(key) {
        try {
            return localStorage.getItem(this._fetchedDayKey(key)) || '';
        } catch (e) {
            return '';
        }
    }

    _writeFetchedDay(key) {
        try {
            localStorage.setItem(this._fetchedDayKey(key), new Date().toDateString());
        } catch (e) {}
    }

    _cleanEtag(raw) {
        return String(raw || '')
            .replace(/^W\//i, '')
            .replace(/"/g, '')
            .trim();
    }

    _usableVersion(ver) {
        const s = String(ver || '').trim();
        if (!s) return '';
        if (/^l:0+$/.test(s)) return '';
        if (/^f:n0\|/.test(s)) return '';
        return s;
    }

    _versionFromHeaders(res) {
        if (!res) return '';
        const etag = this._cleanEtag(res.headers.get('ETag'));
        if (etag) return 'e:' + etag;
        const lm = String(res.headers.get('Last-Modified') || '').trim();
        const rawLen = String(res.headers.get('Content-Length') || '').trim();
        const len = (rawLen && rawLen !== '0') ? rawLen : '';
        if (lm && len) return 'm:' + lm + '|' + len;
        if (lm) return 'm:' + lm;
        const range = String(res.headers.get('Content-Range') || '').trim();
        const rangeLen = /\/(\d+)\s*$/.exec(range);
        const rangeTotal = (rangeLen && rangeLen[1] !== '0') ? rangeLen[1] : '';
        if (lm && rangeTotal) return 'm:' + lm + '|' + rangeTotal;
        if (len) return 'l:' + len;
        if (rangeTotal) return 'l:' + rangeTotal;
        return '';
    }

    _fingerprint(data) {
        const s = typeof data === 'string' ? data : JSON.stringify(data == null ? '' : data);
        let h = 5381;
        const step = Math.max(1, Math.floor(s.length / 4096));
        for (let i = 0; i < s.length; i += step) {
            h = ((h << 5) + h) + s.charCodeAt(i);
        }
        let rows = 0;
        if (typeof data === 'string') {
            rows = Math.max(0, s.split(/\r?\n/).filter((l) => l.trim().length).length - 1);
        } else if (Array.isArray(data)) {
            rows = data.length;
        }
        return 'f:n' + s.length + '|r' + rows + '|h' + ((h >>> 0).toString(16));
    }

    _hasBody(peeked) {
        return peeked != null && peeked !== '';
    }

    _lengthFromVersion(ver) {
        const s = String(ver || '');
        let m = /^f:n(\d+)/.exec(s);
        if (m && m[1] !== '0') return m[1];
        m = /^l:(\d+)/.exec(s);
        if (m && m[1] !== '0') return m[1];
        m = /^m:[^|]*\|(\d+)/.exec(s);
        if (m && m[1] !== '0') return m[1];
        return '';
    }

    _versionsMatch(local, remote) {
        const a = this._usableVersion(local);
        const b = this._usableVersion(remote);
        if (!a || !b) return false;
        if (a === b) return true;
        const strip = (s) => String(s).replace(/^[evmf]:/, '');
        if (strip(a) === strip(b)) return true;
        const ll = this._lengthFromVersion(a);
        const rl = this._lengthFromVersion(b);
        return !!(ll && rl && ll === rl);
    }

    async _cancelBody(res) {
        try {
            if (res && res.body && typeof res.body.cancel === 'function') await res.body.cancel();
        } catch (e) {}
    }

    async _probeRemoteVersion(url) {
        if (!url) return '';
        const cred = /\/api\//.test(url) ? 'same-origin' : 'omit';
        try {
            const head = await this._fetchWithTimeout(
                url,
                { method: 'HEAD', credentials: cred, cache: 'no-store' },
                8000
            );
            if (head.ok) {
                const ver = this._usableVersion(this._versionFromHeaders(head));
                if (ver) return ver;
            }
        } catch (e) {}
        try {
            const res = await this._fetchWithTimeout(
                url,
                {
                    method: 'GET',
                    credentials: cred,
                    cache: 'no-store',
                    headers: { Range: 'bytes=0-511' }
                },
                8000
            );
            const headerVer = this._usableVersion(this._versionFromHeaders(res));
            const range = String(res.headers.get('Content-Range') || '').trim();
            const rangeLen = /\/(\d+)\s*$/.exec(range);
            const declared = Number(res.headers.get('Content-Length') || 0) || (rangeLen ? Number(rangeLen[1]) : 0);
            const partial = res.status === 206 || !!rangeLen;

            if (partial || (declared > PROBE_MAX_BYTES)) {
                await this._cancelBody(res);
                if (headerVer) return headerVer;
                if (rangeLen && rangeLen[1] !== '0') return 'l:' + rangeLen[1];
                if (declared > 0) return 'l:' + declared;
                return '';
            }

            if (declared > 0 && declared <= PROBE_MAX_BYTES && headerVer) {
                await this._cancelBody(res);
                return headerVer;
            }

            if (!res.body || typeof res.body.getReader !== 'function') {
                await this._cancelBody(res);
                return headerVer || (declared > 0 ? 'l:' + declared : '');
            }

            const reader = res.body.getReader();
            let size = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value ? value.byteLength || value.length || 0 : 0;
                if (size > PROBE_MAX_BYTES) {
                    try { await reader.cancel(); } catch (e) {}
                    return '';
                }
            }
            if (headerVer) return headerVer;
            if (size > 0) return 'l:' + size;
        } catch (e) {}
        return '';
    }

    // IndexedDB read that must not wait on the in-flight retry (avoids deadlock)
    // A large text body read in the last 15 s is handed out again while its stored version is
    // unchanged: UI.load reads a body, revalidates, then reads it again, and the second copy of a
    // multi-MB string is pure cost. Strings are immutable, so sharing one is safe.
    async _peek(key) {
        await this.initPromise;
        if (this.useMemoryFallback) {
            return this.memoryCache[key];
        }
        if (!this.db) return undefined;
        const hit = this._recent[key];
        const ver = this._readStoredVersion(key);
        if (hit) {
            if (ver && hit.ver === ver) return hit.v;
            delete this._recent[key];
        }
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(key);
            request.onsuccess = () => {
                const v = request.result;
                if (ver && typeof v === 'string' && v.length > 65536) {
                    const entry = { v, ver };
                    this._recent[key] = entry;
                    setTimeout(() => { if (this._recent[key] === entry) delete this._recent[key]; }, 15000);
                }
                resolve(v);
            };
            request.onerror = (e) => reject(e.target.error);
        });
    }

    async _fetchWithTimeout(url, options, timeoutMs) {
        const ms = timeoutMs || FETCH_TIMEOUT_MS;
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;
        try {
            return await fetch(url, Object.assign({}, options || {}, {
                signal: ctrl ? ctrl.signal : (options && options.signal)
            }));
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async _getDatasetMeta(dataset) {
        if (!dataset || !dataset.versionUrl) return null;
        const res = await this._fetchWithTimeout(
            dataset.versionUrl,
            { credentials: 'same-origin', cache: 'no-store' },
            12000
        );
        if (!res.ok) return null;
        return res.json();
    }

    async seedDataset(key, data, version) {
        await this.set(key, data);
        if (version) this._writeStoredVersion(key, String(version));
        this.syncStatus[key] = 'done';
        // An upload is newer than the mirror's copy until the mirror syncs it: keep this body.
        try {
            const hit = await this._mirrorFor(key, true);
            if (hit) this._mirrorHold(key, 'v:' + hit.e.version);
        } catch (e) {}
        return true;
    }

    // Get data from cache, revalidating via version when this tab has not already confirmed it
    async get(key) {
        await this.initPromise;
        if (this.syncPromises[key]) {
            await this.syncPromises[key];
            return this._peek(key);
        }
        if (this.syncStatus[key] !== 'done') {
            try { await this.retryDataset(key); } catch (_) {}
        }
        return this._peek(key);
    }

    // Remove one dataset from IndexedDB / memory cache
    async delete(key) {
        await this.initPromise;
        this.syncStatus[key] = 'idle';
        delete this.syncPromises[key];
        delete this._recent[key];
        if (this.useMemoryFallback) {
            delete this.memoryCache[key];
            return;
        }
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.delete(key);
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    }

    // Force re-download of one dataset (used when NSC/stock dumps are updated mid-day)
    async refresh(key) {
        this._writeStoredVersion(key, '');
        await this.delete(key);
        return this.retryDataset(key, { force: true });
    }

    async waitForDataset(key, opts) {
        const forceCheck = !!(opts && opts.forceCheck);
        if (!forceCheck && this.syncStatus[key] === 'done') return true;
        if (!forceCheck && this.syncPromises[key]) {
            return this.syncPromises[key];
        }
        return this.retryDataset(key, opts);
    }

    async retryDataset(key, opts) {
        const force = !!(opts && opts.force);
        const forceCheck = !!(opts && (opts.forceCheck || opts.force));
        const dataset = DATASETS.find(d => d.key === key);
        if (!dataset) return false;
        if (this.syncPromises[key]) {
            const prior = await this.syncPromises[key];
            if (!force && !forceCheck) {
                if (this.syncStatus[key] === 'done') return prior || 'unchanged';
                if (this.syncStatus[key] === 'error') return false;
            }
        }
        if (!force && !forceCheck && this.syncStatus[key] === 'done') return 'unchanged';

        this.syncStatus[key] = 'syncing';
        this.syncPromises[key] = (async () => {
            try {
                const hit = await this._mirrorFor(key, forceCheck);
                if (hit) {
                    const got = await this._syncFromMirror(dataset, key, hit, force);
                    if (got) {
                        this.syncStatus[key] = 'done';
                        return got;
                    }
                }
                try {
                    return await this._syncFromOrigin(dataset, key, force, forceCheck, hit ? this._mirrorOrigin(hit, dataset) : '');
                } catch (err) {
                    if (!(hit && force)) throw err;
                    // The source is unreachable: the mirror's copy beats an empty cache.
                    console.warn(`[DataHub] Source refresh failed for ${key}, using the mirror copy:`, err.message || err);
                    try { localStorage.removeItem(MIRROR.holdPrefix + key); } catch (e) {}
                    const got = await this._syncFromMirror(dataset, key, hit, false);
                    if (!got) throw err;
                    this.syncStatus[key] = 'done';
                    return got;
                }
            } catch (err) {
                console.warn(`[DataHub] Fetch optional dataset failed for ${key}:`, err.message || err);
                this.syncStatus[key] = 'error';
                return false;
            } finally {
                delete this.syncPromises[key];
            }
        })();

        return this.syncPromises[key];
    }

    /**
     * Mirror mode: the manifest version is the dataset version, so an unchanged dataset costs no
     * request and no IndexedDB read. Returns 'unchanged' | 'updated', or null to use the source.
     */
    async _syncFromMirror(dataset, key, hit, force) {
        const remoteVer = 'v:' + String(hit.e.version);
        if (force) {
            // Right after a write the mirror may still hold the previous copy: read the source,
            // and keep that body until the mirror has moved past this version.
            this._mirrorHold(key, remoteVer);
            return null;
        }
        const localVer = this._readStoredVersion(key);
        if ((localVer === remoteVer || this._mirrorHeld(key, remoteVer)) && await this._hasStored(key)) {
            return 'unchanged';
        }
        let res;
        try {
            // no-cache: the browser revalidates its own copy by ETag (a 304 costs no body).
            res = await this._fetchWithTimeout(hit.url, { credentials: 'same-origin', cache: 'no-cache' },
                dataset.lazySync ? 180000 : FETCH_TIMEOUT_MS);
        } catch (e) {
            console.warn(`[DataHub] Mirror copy unreachable for ${key}, reading the source:`, e.message || e);
            return null;
        }
        const ct = String(res.headers.get('Content-Type') || '').toLowerCase();
        if (!res.ok || ct.indexOf('text/html') !== -1) {
            await this._cancelBody(res);
            console.warn(`[DataHub] Mirror copy failed for ${key} (HTTP ${res.status}), reading the source`);
            return null;
        }
        let data;
        try {
            data = dataset.type === 'json' ? await res.json() : await res.text();
        } catch (e) {
            console.warn(`[DataHub] Mirror copy unreadable for ${key}, reading the source:`, e.message || e);
            return null;
        }
        const rowCheck = ROW_CHECKS.find((c) => dataset.key.startsWith(c.prefix));
        if (rowCheck && typeof data === 'string') {
            const expected = Number(rowCheck.headers.map((h) => res.headers.get(h)).find(Boolean) || 0);
            const rowCount = expected > 0 ? Math.max(0, data.split(/\r?\n/).filter((l) => l.trim().length).length - 1) : 0;
            if (expected > 0 && rowCount < expected * 0.95) {
                console.warn(`[DataHub] Mirror copy of ${rowCheck.label} incomplete (${rowCount} of ${expected} rows), reading the source`);
                return null;
            }
        }
        if (await this._hasStored(key)) {
            const peeked = await this._peek(key);
            if (this._hasBody(peeked) && this._fingerprint(peeked) === this._fingerprint(data)) {
                this._writeStoredVersion(key, remoteVer);
                return 'unchanged';
            }
        }
        await this.set(key, data);
        this._writeStoredVersion(key, remoteVer);
        try { localStorage.removeItem(MIRROR.holdPrefix + key); } catch (e) {}
        await this._invalidateCompanions(key);
        return 'updated';
    }

    /** Today's logic: version from /api/.../meta or a HEAD / Range probe, body from the source. */
    async _syncFromOrigin(dataset, key, force, forceCheck, originUrl) {
        let remoteVer = '';
        let fetchUrl = dataset.url;
        let metaJson = null;
        const peeked = await this._peek(key);
        const hasBody = this._hasBody(peeked);
        const localVer = this._usableVersion(this._readStoredVersion(key));

        if (dataset.versionUrl) {
            try {
                metaJson = await this._getDatasetMeta(dataset);
            } catch (e) {}
            remoteVer = String(
                (metaJson && dataset.versionField && metaJson[dataset.versionField]) ||
                (metaJson && metaJson.version) ||
                ''
            ).trim();
            if (remoteVer) remoteVer = this._usableVersion('v:' + remoteVer);
            const field = dataset.csvUrlField || 'csvUrl';
            if (metaJson && metaJson[field]) fetchUrl = String(metaJson[field]);
            // On the VM the meta may point at the mirror copy; a refresh or fallback wants the source.
            if (originUrl && fetchUrl.indexOf(MIRROR.fileUrl) === 0) fetchUrl = originUrl;
        } else if (!force && hasBody) {
            remoteVer = this._usableVersion(await this._probeRemoteVersion(fetchUrl));
        } else if (forceCheck && hasBody) {
            remoteVer = this._usableVersion(await this._probeRemoteVersion(fetchUrl));
        } else if (!hasBody) {
            remoteVer = this._usableVersion(await this._probeRemoteVersion(fetchUrl));
        }

        let expectedRows = 0;
        if (dataset.key.startsWith('CACHE_WITHHELD')) {
            expectedRows = Number(
                (metaJson && metaJson.meta && metaJson.meta.withheldRows) ||
                (metaJson && metaJson.withheldRows) ||
                0
            );
        }
        // Counting rows splits the whole body: only when there is a row count to compare with.
        let cachedRows = 0;
        if (expectedRows && typeof peeked === 'string') {
            cachedRows = Math.max(0, peeked.split(/\r?\n/).filter((l) => l.trim().length).length - 1);
        } else if (Array.isArray(peeked)) {
            cachedRows = peeked.length;
        }
        const rowLooksComplete = !expectedRows || cachedRows >= expectedRows * 0.95;

        if (!force && hasBody && remoteVer && localVer && this._versionsMatch(localVer, remoteVer) && rowLooksComplete) {
            if (localVer !== remoteVer) this._writeStoredVersion(key, remoteVer);
            this._writeFetchedDay(key);
            this.syncStatus[key] = 'done';
            return 'unchanged';
        }

        // Lazy dumps (Meter, CAPEX): never full-GET without a cheap version.
        // Clerk sheets (Loss, Collection, …): same-day skip on page open;
        // a forced refresh or a new day still downloads so paste-updates appear.
        if (!force && hasBody && !remoteVer) {
            if (dataset.lazySync) {
                this.syncStatus[key] = 'done';
                return 'unchanged';
            }
            if (!forceCheck && localVer && this._readFetchedDay(key) === new Date().toDateString()) {
                this.syncStatus[key] = 'done';
                return 'unchanged';
            }
        }

        let allowConditional = !force && !!localVer;
        let response = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            const headers = {};
            const stored = this._readStoredVersion(key);
            if (allowConditional && stored && !/docs\.google\.com|spreadsheets\.google\.com/i.test(fetchUrl)) {
                if (stored.indexOf('m:') === 0) {
                    const lm = stored.slice(2).split('|')[0];
                    if (lm) headers['If-Modified-Since'] = lm;
                } else if (stored.indexOf('f:') !== 0 && stored.indexOf('l:') !== 0) {
                    const tag = stored.replace(/^[ev]:/, '').replace(/"/g, '');
                    if (tag) headers['If-None-Match'] = '"' + tag + '"';
                }
            }
            response = await this._fetchWithTimeout(fetchUrl, {
                credentials: /\/api\//.test(fetchUrl) ? 'same-origin' : 'omit',
                cache: /docs\.google\.com|spreadsheets\.google\.com|googleusercontent\.com/i.test(fetchUrl) ? 'no-store' : 'default',
                headers
            }, dataset.lazySync ? 180000 : FETCH_TIMEOUT_MS);
            if (response.status !== 304) break;
            const cached = await this._peek(key);
            if (this._hasBody(cached)) {
                const keep = this._usableVersion(remoteVer)
                    || this._usableVersion(this._versionFromHeaders(response))
                    || this._usableVersion(stored);
                if (keep) this._writeStoredVersion(key, keep);
                this._writeFetchedDay(key);
                this.syncStatus[key] = 'done';
                return 'unchanged';
            }
            allowConditional = false;
        }
        if (!response || !response.ok) {
            throw new Error(`HTTP ${response ? response.status : 0}`);
        }

        let data;
        if (dataset.type === 'json') data = await response.json();
        else data = await response.text();
        const headerVer = this._usableVersion(this._versionFromHeaders(response));
        const nextVer = this._usableVersion(remoteVer) || headerVer || this._fingerprint(data);
        if (!force && hasBody && localVer && this._versionsMatch(localVer, nextVer)) {
            this._writeStoredVersion(key, nextVer);
            this._writeFetchedDay(key);
            this.syncStatus[key] = 'done';
            return 'unchanged';
        }
        if (!force && hasBody && this._fingerprint(peeked) === this._fingerprint(data)) {
            this._writeStoredVersion(key, nextVer);
            this._writeFetchedDay(key);
            this.syncStatus[key] = 'done';
            return 'unchanged';
        }

        // NSC / Withheld: refuse to cache a truncated CSV (stale sheet / partial response)
        const rowCheck = ROW_CHECKS.find((c) => dataset.key.startsWith(c.prefix));
        if (rowCheck && typeof data === 'string') {
            const expected = Number(
                rowCheck.headers.map((h) => response.headers.get(h)).find(Boolean) ||
                (metaJson && metaJson.meta && metaJson.meta[rowCheck.metaField]) ||
                0
            );
            const rowCount = expected > 0 ? Math.max(0, data.split(/\r?\n/).filter((l) => l.trim().length).length - 1) : 0;
            if (expected > 0 && rowCount < expected * 0.95) {
                throw new Error(`${rowCheck.label} incomplete: got ${rowCount} rows, server has ${expected}`);
            }
        }
        await this.set(dataset.key, data);
        // The version goes in after the body, so a refused or failed write is retried next time.
        this._writeStoredVersion(key, nextVer);
        await this._invalidateCompanions(dataset.key);
        this._writeFetchedDay(key);
        this.syncStatus[key] = 'done';
        return 'updated';
    }
}

const mzoDataHub = new DataHub();
window.mzoDataHub = mzoDataHub;

window.MZO_DATASETS = DATASETS;

// Pages that fetch a sheet themselves: mzoMirror(url) → the mirror URL (or url unchanged);
// mzoMirror.fetch(url, init) reads the mirror copy and falls back to the source on any failure;
// mzoMirror.fresh(url) after the page itself wrote that sheet (read the source until the copy changes);
// mzoMirror.refresh(keys, reason) asks the VM to sync those mirror keys now (fire and forget).
window.mzoMirror = function (url) { return mzoDataHub.mirrorUrl(url); };
window.mzoMirror.fetch = function (url, init) { return mzoDataHub.mirrorFetch(url, init); };
window.mzoMirror.fresh = function (url) { return mzoDataHub.mirrorFresh(url); };
window.mzoMirror.refresh = function (keys, reason) { return mzoDataHub.mirrorRefresh(keys, reason); };
window.mzoMirror.status = function () { return mzoDataHub.mirrorStatus(); };
