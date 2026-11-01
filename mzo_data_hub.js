// mzo_data_hub.js — one IndexedDB cache for every report dataset (window.mzoDataHub).
// Each dataset keeps a version in localStorage (mzo_hub_ver_<key>); opening a page only downloads the
// body when the remote version differs. Options per dataset:
//   lazySync     multi-MB sheet: never re-downloaded just to find its version (needs a versionUrl or a forced refresh)
//   originHeavy  body comes from meta.csvUrl (Google / Supabase Storage), not through Vercel
//   versionUrl   small JSON with { version, csvUrl } (field names via versionField / csvUrlField)

const DB_NAME = 'MZODashboardData';
const DB_VERSION = 1;
const STORE_NAME = 'datasets';

const DATASETS = [
    { key: 'CACHE_SAFETY_v2', label: 'Safety Inspection', url: 'https://docs.google.com/spreadsheets/d/1A2fjKboWKnw10iaOs1wcXDrdg9jhhDGfzF9OagPjA5s/gviz/tq?tqx=out:csv', type: 'csv', lazySync: true },
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
    { key: 'CACHE_CMO', label: 'CMO Grievances', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vS7GVh5HflVhouhVfFOEN2RuA1kCBedmD4Q0CJP02K61DAtWuo3P8XIS8CO7ocZQuJ20uCJBa9qsgZ6/pub?gid=1066071765&single=true&output=csv', type: 'csv' },
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
    { key: 'CACHE_DISCONNECTION', label: 'Disconnection Tracker', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSkl9m38XuD5aewajE7Fc0hucP9DWz1UwEqJZeu5wELWZivSEEXWrhl7RiHFSezGeGiGdDB53s1bWit/pub?gid=0&single=true&output=csv', type: 'csv', originHeavy: true, versionUrl: '/api/disconnection/meta', csvUrlField: 'csvUrl', versionField: 'version', lazySync: true },
    { key: 'CACHE_DD_VISIT', label: 'DD Visit Consumers', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSCKEl95dh4kyG-QPJbFJ5x7U7yo7h5bJGuMewsMr2hjMAlCj7UWxqvL_a-2hdyQd-laI8BAX3hU5_T/pub?gid=0&single=true&output=csv', type: 'csv', lazySync: true }
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

class DataHub {
    constructor() {
        this.db = null;
        this.initPromise = this._initDB();
        this.syncStatus = {}; // Tracks: 'idle', 'syncing', 'done', 'error'
        this.syncPromises = {}; // Tracks active fetch promises for individual datasets
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
                let cachedRows = 0;
                if (typeof peeked === 'string') {
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
                this._writeStoredVersion(key, nextVer);

                // NSC / Withheld: refuse to cache a truncated CSV (stale sheet / partial response)
                const rowCheck = ROW_CHECKS.find((c) => dataset.key.startsWith(c.prefix));
                if (rowCheck && typeof data === 'string') {
                    const rowCount = Math.max(0, data.split(/\r?\n/).filter((l) => l.trim().length).length - 1);
                    const expected = Number(
                        rowCheck.headers.map((h) => response.headers.get(h)).find(Boolean) ||
                        (metaJson && metaJson.meta && metaJson.meta[rowCheck.metaField]) ||
                        0
                    );
                    if (expected > 0 && rowCount < expected * 0.95) {
                        throw new Error(`${rowCheck.label} incomplete: got ${rowCount} rows, server has ${expected}`);
                    }
                }
                await this.set(dataset.key, data);
                await this._invalidateCompanions(dataset.key);
                this._writeFetchedDay(key);
                this.syncStatus[key] = 'done';
                return 'updated';
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
}

const mzoDataHub = new DataHub();
window.mzoDataHub = mzoDataHub;

window.MZO_DATASETS = DATASETS;
