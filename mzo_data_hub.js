// mzo_data_hub.js
// Handles centralized data fetching and caching using IndexedDB

const DB_NAME = 'MZODashboardData';
const DB_VERSION = 1;
const STORE_NAME = 'datasets';

// Major datasets to cache
const DATASETS = [
    { key: 'CACHE_SAFETY', label: 'Safety Inspection', url: 'data/safety_inspection.json', type: 'json' },
    { key: 'CACHE_DOCKET', label: 'Docket Calls', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTT56PULgjKw_-wu8lmMWNE6SC1KBDyAKxeHaMloZJWUQ9HQsJoqosYF33DrQK3NX9Bvfn0mjfx-dkP/pub?gid=1059428699&single=true&output=csv', type: 'csv' },
    // originHeavy: skip homepage sync unless meta.csvUrl points at Google (sheet mirror)
    { key: 'CACHE_NSC_v5', label: 'NSC Data', url: '/api/nsc/dataset', type: 'csv', originHeavy: true, versionUrl: '/api/nsc/meta', csvUrlField: 'csvUrl' },
    { key: 'CACHE_LOAD_EXT', label: 'Load Extension', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQP_B-Zl5XhnYkmJiDXKB7B8ksrRRezuLrRqTzEPz4lEw_yDcpGOTnmm0oI8dW9apwuHg9yGqaAqjDS/pub?gid=0&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_COLLECTION', label: 'Collection Report', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ2S20QZ57pQpdawzKFHAIqD_OpCNmbmMbYlttluLVA0JZpVK405pS0-2ZIqm-X9jAA8ZB1XwF2serr/pub?gid=1977250749&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_LOSS', label: 'Loss Report', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSYyqn0urGdbqXarhELRbSCeRvgUCSHID_1Z4E_kptBTR5u69R0HHX0Jk23n6KseriNct2q9XwXu04E/pub?output=csv', type: 'csv' },
    { key: 'CACHE_LOSS_TARGET', label: 'Loss Targets', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSYyqn0urGdbqXarhELRbSCeRvgUCSHID_1Z4E_kptBTR5u69R0HHX0Jk23n6KseriNct2q9XwXu04E/pub?gid=2042465667&single=true&output=csv', type: 'csv' },
    // Prefers uploaded dataset via /api/withheld/dataset (Supabase); fallback sheet/JSON on server
    { key: 'CACHE_WITHHELD_v3', label: 'Withheld NSC', url: '/api/withheld/dataset', type: 'csv', originHeavy: true, versionUrl: '/api/nsc/meta', csvUrlField: 'withheldCsvUrl' },
    { key: 'CACHE_WEEKLY', label: 'Weekly Report', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSMuO-ddereEG6J2s2Bmqp-HXo85ky4S4R5Yt-0HdoNHHa5r8xOEK4MJ1Syhyqzjpm2lTI4sT85nR4N/pub?gid=0&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_PENDING_MC', label: 'Pending Master Card', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQmOUW4jxUtEGWhPHaoNBsvpBcGzhHJZRUx_9mxFBp91sfg4yD8WIqIK_xv0vlFs2yP-Ljz09JW1U2c/pub?gid=0&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_CMO', label: 'CMO Grievances', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vS7GVh5HflVhouhVfFOEN2RuA1kCBedmD4Q0CJP02K61DAtWuo3P8XIS8CO7ocZQuJ20uCJBa9qsgZ6/pub?gid=1066071765&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_STOCK', label: 'Stock Data', url: '/api/stock/dataset', type: 'csv', originHeavy: true, versionUrl: '/api/stock/meta', csvUrlField: 'csvUrl' },
    { key: 'CACHE_POWER_MAP', label: 'Power Map', url: '/api/power-map/data', type: 'csv', originHeavy: true },
    { key: 'CACHE_STOCK_METADATA', label: 'Stock Metadata', url: 'https://docs.google.com/spreadsheets/d/1wDvPuAxNfdO9QzUaIUubg2JnkFM5ZleFNXQdi8s5uh0/export?format=csv&gid=696716331', type: 'csv' },
    { key: 'CACHE_CAPEX', label: 'CAPEX Details', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQI2neSVbvMR4fF910Q0AWUcq02leP-sob8q4f9goT46hgLutCpxCjSL6y6X3s2vYBJRNN7WrFCjE0R/pub?gid=439685010&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_VENDORS', label: 'Vendor Map', url: 'data/bndp_vendor.json', type: 'json' },
    { key: 'CACHE_COSTCENTER', label: 'Cost Center Map', url: 'data/costcenter.json', type: 'json' },
    { key: 'CACHE_REM_v2', label: 'REM Data', url: 'https://docs.google.com/spreadsheets/d/18y_nHZngDDO13nlluN9qba7AfgDe5dKGGHnXRYUU-b8/gviz/tq?tqx=out:csv', type: 'csv' },
    { key: 'CACHE_DEFECTIVE', label: 'Defective Meter', url: 'consumer/defective_meter.csv', type: 'csv' },
    { key: 'CACHE_REM_DEFAULTERS', label: 'REM Ind/Com Defaulters', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQOynlOrqc0iXUKYDgqh-tTjIgDA5WidJDcDhYM7MhfKIZzZ7iduFD2LN4fYRXmVvcLCz1X-OJfcmRx/pub?gid=0&single=true&output=tsv', type: 'csv' },
    { key: 'CACHE_REM_AGRI', label: 'REM Agri Defaulters', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRFk-wa_x-dsthFXNsWa9wRxWOQrMD-yEiucvA2FtJIbwnTiGqVs3OT_eXxqyAOBqvGSDRiG-Hr0hK1/pub?gid=0&single=true&output=tsv', type: 'csv' },
    { key: 'CACHE_REM_DOM', label: 'REM Dom Defaulters', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRFk-wa_x-dsthFXNsWa9wRxWOQrMD-yEiucvA2FtJIbwnTiGqVs3OT_eXxqyAOBqvGSDRiG-Hr0hK1/pub?gid=1106133732&single=true&output=tsv', type: 'csv' },
    { key: 'CACHE_SOLAR', label: 'Solar Data', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vR5Vnb9TxymVIcBZsUBWZ-21Frkn77O4IyNus3Zo42qPm09N6MlJ3E0Vh3tHywcMAiy2y0uRm5XfIdk/pub?gid=0&single=true&output=csv', type: 'csv' },
    // lazySync: multi‑MB sheets — skip daily homepage sync; fetch on page open via waitForDataset/get
    { key: 'CACHE_METER_ERP', label: 'Meter ERP Data', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSmzya-jypjfu9nN5QWuRJ6sbIgrqQ7Wa1eAx6Wfoepft2UpNwBC4a_rd4uJ6VpLhNu7FnjDBa8mJxW/pub?gid=1335293243&single=true&output=csv', type: 'csv', lazySync: true },
    { key: 'CACHE_METER_MASTER', label: 'Meter Master Data', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSmzya-jypjfu9nN5QWuRJ6sbIgrqQ7Wa1eAx6Wfoepft2UpNwBC4a_rd4uJ6VpLhNu7FnjDBa8mJxW/pub?gid=1053803476&single=true&output=csv', type: 'csv', lazySync: true },
    { key: 'CACHE_METER_CRM', label: 'Meter CRM Data', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSmzya-jypjfu9nN5QWuRJ6sbIgrqQ7Wa1eAx6Wfoepft2UpNwBC4a_rd4uJ6VpLhNu7FnjDBa8mJxW/pub?gid=1638328510&single=true&output=csv', type: 'csv', lazySync: true },
    { key: 'CACHE_METER_ISU', label: 'Meter ISU Data', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSmzya-jypjfu9nN5QWuRJ6sbIgrqQ7Wa1eAx6Wfoepft2UpNwBC4a_rd4uJ6VpLhNu7FnjDBa8mJxW/pub?gid=329630218&single=true&output=csv', type: 'csv', lazySync: true },
    { key: 'CACHE_DISCONNECTION', label: 'Disconnection Tracker', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSkl9m38XuD5aewajE7Fc0hucP9DWz1UwEqJZeu5wELWZivSEEXWrhl7RiHFSezGeGiGdDB53s1bWit/pub?gid=0&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_PMSGY_0', label: 'PMSGY Data 0', url: 'https://docs.google.com/spreadsheets/d/1u44ctXxvX4GI3Pm7ZPAoaH7rGn9RkxEWkyK5AyMlxGo/export?format=csv&gid=0', type: 'csv', lazySync: true },
    { key: 'CACHE_PMSGY_1', label: 'PMSGY Data 1', url: 'https://docs.google.com/spreadsheets/d/1u44ctXxvX4GI3Pm7ZPAoaH7rGn9RkxEWkyK5AyMlxGo/export?format=csv&gid=1665942193', type: 'csv', lazySync: true },
    { key: 'CACHE_PMSGY_2', label: 'PMSGY Data 2', url: 'https://docs.google.com/spreadsheets/d/1u44ctXxvX4GI3Pm7ZPAoaH7rGn9RkxEWkyK5AyMlxGo/export?format=csv&gid=1873088391', type: 'csv', lazySync: true }
];

const FETCH_TIMEOUT_MS = 90000;

class DataHub {
    constructor() {
        this.db = null;
        this.initPromise = this._initDB();
        this.syncStatus = {}; // Tracks: 'idle', 'syncing', 'done', 'error'
        this.syncPromises = {}; // Tracks active fetch promises for individual datasets
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
        if (this.useMemoryFallback) {
            this.memoryCache[key] = data;
            return;
        }
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.put(data, key);

            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
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

    // IndexedDB read that must not wait on the in-flight retry (avoids deadlock)
    async _peek(key) {
        await this.initPromise;
        if (this.useMemoryFallback) {
            return this.memoryCache[key];
        }
        if (!this.db) return undefined;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = (e) => reject(e.target.error);
        });
    }

    async _getDatasetMeta(dataset) {
        if (!dataset || !dataset.versionUrl) return null;
        const res = await fetch(dataset.versionUrl, { credentials: 'same-origin' });
        if (!res.ok) return null;
        return res.json();
    }

    async _resolveRemoteVersion(dataset) {
        const data = await this._getDatasetMeta(dataset);
        return String((data && data.version) || '').trim();
    }

    async seedDataset(key, data, version) {
        await this.set(key, data);
        if (version) this._writeStoredVersion(key, String(version));
        this.syncStatus[key] = 'done';
        return true;
    }

    // Get data from cache
    async get(key) {
        await this.initPromise;
        if (this.useMemoryFallback) {
            return this.memoryCache[key];
        }
        
        // If this specific key is currently syncing, wait for it to complete
        // before returning the data. This provides a seamless "wait" experience.
        if (this.syncStatus[key] === 'syncing' && this.syncPromises[key]) {
            await this.syncPromises[key];
        }

        return this._peek(key);
    }

    // Remove one dataset from IndexedDB / memory cache
    async delete(key) {
        await this.initPromise;
        this.syncStatus[key] = 'idle';
        delete this.syncPromises[key];
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

    // Clear all cached data
    async clear() {
        await this.initPromise;
        if (this.useMemoryFallback) {
            this.memoryCache = {};
            return;
        }
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.clear();

            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    }

    // Checks if a dataset is currently cached
    async isCached(key) {
        const data = await this.get(key);
        return data !== undefined && data !== null;
    }

    // Daily Sync Logic
    isFirstSyncOfDay() {
        try {
            const today = new Date().toDateString();
            const lastSyncDate = localStorage.getItem('mzo_last_sync_date');
            return lastSyncDate !== today;
        } catch (e) {
            return true;
        }
    }

    markSyncComplete() {
        try {
            const today = new Date().toDateString();
            localStorage.setItem('mzo_last_sync_date', today);
            localStorage.setItem('mzoDataSynced', 'true'); // Keep old flag for compatibility if needed
        } catch (e) {}
    }

    // --- Modern Hybrid Sync Extensions ---

    getSyncStatus(key) {
        return this.syncStatus[key] || 'idle';
    }

    async waitForDataset(key) {
        // If already done, return immediately
        if (this.syncStatus[key] === 'done') return true;
        
        // If currently syncing, wait for the existing promise
        if (this.syncPromises[key]) {
            return this.syncPromises[key];
        }

        // Otherwise, if it's idle or error, try to fetch it now (individual retry logic)
        return this.retryDataset(key);
    }

    async retryDataset(key, opts) {
        const force = !!(opts && opts.force);
        const dataset = DATASETS.find(d => d.key === key);
        if (!dataset) return false;

        this.syncStatus[key] = 'syncing';
        this.syncPromises[key] = (async () => {
            try {
                let remoteVer = '';
                let fetchUrl = dataset.url;
                let metaJson = null;
                if (dataset.versionUrl) {
                    try {
                        metaJson = await this._getDatasetMeta(dataset);
                    } catch (e) {}
                    remoteVer = String((metaJson && metaJson.version) || '').trim();
                    const field = dataset.csvUrlField || 'csvUrl';
                    if (metaJson && metaJson[field]) fetchUrl = String(metaJson[field]);
                    if (!force) {
                        const peeked = await this._peek(key);
                        const localVer = this._readStoredVersion(key);
                        const hasBody = peeked != null && peeked !== '';
                        if (hasBody && remoteVer && localVer && localVer === remoteVer) {
                            this.syncStatus[key] = 'done';
                            return true;
                        }
                    }
                }

                const useConditional = !force && !/docs\.google\.com/i.test(fetchUrl);
                let allowConditional = useConditional;
                let response = null;
                for (let attempt = 0; attempt < 2; attempt++) {
                    const headers = {};
                    const localVer = this._readStoredVersion(key);
                    if (allowConditional && localVer) {
                        headers['If-None-Match'] = `"${String(localVer).replace(/"/g, '')}"`;
                    }
                    const timeoutMs = dataset.lazySync ? 180000 : FETCH_TIMEOUT_MS;
                    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
                    const timer = ctrl
                        ? setTimeout(() => ctrl.abort(), timeoutMs)
                        : null;
                    try {
                        response = await fetch(fetchUrl, {
                            credentials: /\/api\//.test(fetchUrl) ? 'same-origin' : 'omit',
                            headers,
                            signal: ctrl ? ctrl.signal : undefined
                        });
                    } finally {
                        if (timer) clearTimeout(timer);
                    }
                    if (response.status !== 304) break;
                    const peeked = await this._peek(key);
                    if (peeked != null && peeked !== '') {
                        if (remoteVer) this._writeStoredVersion(key, remoteVer);
                        this.syncStatus[key] = 'done';
                        return true;
                    }
                    allowConditional = false;
                }
                if (!response || !response.ok) {
                    throw new Error(`HTTP ${response ? response.status : 0}`);
                }

                let data;
                if (dataset.type === 'json') data = await response.json();
                else data = await response.text();
                const etag = String(response.headers.get('ETag') || '')
                    .replace(/^W\//i, '')
                    .replace(/"/g, '')
                    .trim();
                if (remoteVer) this._writeStoredVersion(key, remoteVer);
                else if (etag) this._writeStoredVersion(key, etag);

                // NSC / Withheld: refuse to cache a truncated CSV (stale sheet / partial response)
                if (dataset.key.startsWith('CACHE_NSC') && typeof data === 'string') {
                    const lines = data.split(/\r?\n/).filter((l) => l.trim().length);
                    const rowCount = Math.max(0, lines.length - 1);
                    const expected = Number(
                        response.headers.get('X-NSC-Published-Rows') ||
                        response.headers.get('X-NSC-Row-Count') ||
                        (metaJson && metaJson.meta && metaJson.meta.publishedRows) ||
                        0
                    );
                    console.log(
                        `[DataHub] ${dataset.key} rows=${rowCount}` +
                        (expected ? ` expected=${expected}` : '') +
                        ` source=${response.headers.get('X-NSC-Source') || '?'}`
                    );
                    if (expected > 0 && rowCount < expected * 0.95) {
                        throw new Error(
                            `NSC incomplete: got ${rowCount} rows, server has ${expected}`
                        );
                    }
                }
                if (dataset.key.startsWith('CACHE_WITHHELD') && typeof data === 'string') {
                    const lines = data.split(/\r?\n/).filter((l) => l.trim().length);
                    const rowCount = Math.max(0, lines.length - 1);
                    const expected = Number(
                        response.headers.get('X-Withheld-Rows') ||
                        response.headers.get('X-Withheld-Row-Count') ||
                        (metaJson && metaJson.meta && metaJson.meta.withheldRows) ||
                        0
                    );
                    console.log(
                        `[DataHub] ${dataset.key} rows=${rowCount}` +
                        (expected ? ` expected=${expected}` : '') +
                        ` source=${response.headers.get('X-Withheld-Source') || '?'}`
                    );
                    if (expected > 0 && rowCount < expected * 0.95) {
                        throw new Error(
                            `Withheld incomplete: got ${rowCount} rows, server has ${expected}`
                        );
                    }
                }

                await this.set(dataset.key, data);
                this.syncStatus[key] = 'done';
                return true;
            } catch (err) {
                console.error(`Retry failed for ${key}:`, err);
                this.syncStatus[key] = 'error';
                return false;
            } finally {
                delete this.syncPromises[key];
            }
        })();

        return this.syncPromises[key];
    }
}

const mzoDataHub = new DataHub();
window.mzoDataHub = mzoDataHub;

// Main function to sync all datasets
// Main function to sync all datasets in parallel batches
async function syncAllData(progressCallback) {
    let completed = 0;
    const syncDatasets = [];
    for (const d of DATASETS) {
        if (d.lazySync) continue; // multi‑MB dumps: on-demand only
        if (!d.originHeavy) {
            syncDatasets.push(d);
            continue;
        }
        try {
            const meta = await mzoDataHub._getDatasetMeta(d);
            const field = d.csvUrlField || 'csvUrl';
            if (meta && meta[field]) syncDatasets.push(d);
        } catch (e) {}
    }
    const total = syncDatasets.length;
    const BATCH_SIZE = 6; // Balance speed and rate limits
    const inFlight = new Set();

    try {
        // Initialize sync status for homepage datasets only (skip Vercel-origin dumps)
        syncDatasets.forEach(d => {
            if (mzoDataHub.syncStatus[d.key] !== 'done') {
                mzoDataHub.syncStatus[d.key] = 'pending';
            }
        });

        // Use a simple queue for parallel execution with limited concurrency
        const queue = [...syncDatasets];
        const workers = [];

        const updateProgress = (label) => {
            if (!progressCallback) return;
            const active = [...inFlight].slice(0, 3).join(', ');
            const detail = active && !/Complete|finished/i.test(label)
                ? `${label} · also: ${active}`
                : label;
            progressCallback(completed, total, detail);
        };

        const executeWorker = async () => {
            while (queue.length > 0) {
                const dataset = queue.shift();
                if (!dataset) break;

                // Skip if already done today (unless force refresh is added later)
                if (mzoDataHub.syncStatus[dataset.key] === 'done') {
                    completed++;
                    continue;
                }

                inFlight.add(dataset.label);
                updateProgress(`Updating ${dataset.label}...`);
                let success = false;
                try {
                    success = await mzoDataHub.retryDataset(dataset.key);
                    if (success) completed++;
                } finally {
                    inFlight.delete(dataset.label);
                }
                
                updateProgress(success ? `Loaded ${dataset.label}` : `Failed ${dataset.label}`);
            }
        };

        // Start initial workers
        for (let i = 0; i < Math.min(BATCH_SIZE, queue.length); i++) {
            workers.push(executeWorker());
        }

        await Promise.all(workers);

        const allDone = syncDatasets.every((d) => mzoDataHub.syncStatus[d.key] === 'done');
        
        if (progressCallback) {
            progressCallback(completed, total, allDone ? "Sync Complete!" : "Sync finished with some errors.");
        }

        if (allDone) {
            try {
                localStorage.setItem('mzoDataSynced', 'true');
            } catch (e) {}
        }
        
        return allDone;

    } catch (error) {
        console.error("Error during data sync:", error);
        if (progressCallback) {
            progressCallback(completed, total, "Sync encountered a critical error.");
        }
        return false;
    }
}

// Function checking if sync is needed
function isSyncNeeded() {
    try {
        return localStorage.getItem('mzoDataSynced') !== 'true';
    } catch (e) {
        return true;
    }
}
