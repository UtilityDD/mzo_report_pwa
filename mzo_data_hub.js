// mzo_data_hub.js
// Handles centralized data fetching and caching using IndexedDB

const DB_NAME = 'MZODashboardData';
const DB_VERSION = 1;
const STORE_NAME = 'datasets';

// Major datasets to cache
const DATASETS = [
    { key: 'CACHE_SAFETY', label: 'Safety Inspection', url: 'data/safety_inspection.json', type: 'json' },
    { key: 'CACHE_DOCKET', label: 'Docket Calls', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTT56PULgjKw_-wu8lmMWNE6SC1KBDyAKxeHaMloZJWUQ9HQsJoqosYF33DrQK3NX9Bvfn0mjfx-dkP/pub?gid=1059428699&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_NSC', label: 'NSC Data', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRsUU2viBvYhSgR0RFwmZ1H8LkYCats9roQVCKvQeoU7dzg6ryR6IWZex9FT9tksp_DEM23ZgQ28Iyo/pub?output=csv', type: 'csv' },
    { key: 'CACHE_LOAD_EXT', label: 'Load Extension', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQP_B-Zl5XhnYkmJiDXKB7B8ksrRRezuLrRqTzEPz4lEw_yDcpGOTnmm0oI8dW9apwuHg9yGqaAqjDS/pub?gid=0&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_COLLECTION', label: 'Collection Report', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ2S20QZ57pQpdawzKFHAIqD_OpCNmbmMbYlttluLVA0JZpVK405pS0-2ZIqm-X9jAA8ZB1XwF2serr/pub?gid=1977250749&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_LOSS', label: 'Loss Report', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSYyqn0urGdbqXarhELRbSCeRvgUCSHID_1Z4E_kptBTR5u69R0HHX0Jk23n6KseriNct2q9XwXu04E/pub?output=csv', type: 'csv' },
    { key: 'CACHE_LOSS_TARGET', label: 'Loss Targets', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSYyqn0urGdbqXarhELRbSCeRvgUCSHID_1Z4E_kptBTR5u69R0HHX0Jk23n6KseriNct2q9XwXu04E/pub?gid=2042465667&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_WITHHELD', label: 'Withheld NSC', url: 'data/withheld.json', type: 'json' },
    { key: 'CACHE_WEEKLY', label: 'Weekly Report', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSMuO-ddereEG6J2s2Bmqp-HXo85ky4S4R5Yt-0HdoNHHa5r8xOEK4MJ1Syhyqzjpm2lTI4sT85nR4N/pub?gid=0&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_PENDING_MC', label: 'Pending Master Card', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQmOUW4jxUtEGWhPHaoNBsvpBcGzhHJZRUx_9mxFBp91sfg4yD8WIqIK_xv0vlFs2yP-Ljz09JW1U2c/pub?gid=0&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_CMO', label: 'CMO Grievances', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vS7GVh5HflVhouhVfFOEN2RuA1kCBedmD4Q0CJP02K61DAtWuo3P8XIS8CO7ocZQuJ20uCJBa9qsgZ6/pub?gid=1066071765&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_STOCK', label: 'Stock Data', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSE7jMusI5YFc4fcuHMyWpbqGp1fIcWBNRYh6yieCY8yUyjOgC1ZRWB7flXE0DAVEbHUfG-KlzWCZyf/pub?gid=202809558&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_CAPEX', label: 'CAPEX Details', url: 'data/capexall.json', type: 'json' },
    { key: 'CACHE_VENDORS', label: 'Vendor Map', url: 'data/bndp_vendor.json', type: 'json' },
    { key: 'CACHE_COSTCENTER', label: 'Cost Center Map', url: 'data/costcenter.json', type: 'json' },
    { key: 'CACHE_REM', label: 'REM Data', url: 'data/rem.json', type: 'json' },
    { key: 'CACHE_DEFECTIVE', label: 'Defective Meter', url: 'consumer/defective_meter.csv', type: 'csv' },
    { key: 'CACHE_REM_DEFAULTERS', label: 'REM Ind/Com Defaulters', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQOynlOrqc0iXUKYDgqh-tTjIgDA5WidJDcDhYM7MhfKIZzZ7iduFD2LN4fYRXmVvcLCz1X-OJfcmRx/pub?gid=0&single=true&output=tsv', type: 'csv' },
    { key: 'CACHE_REM_AGRI', label: 'REM Agri Defaulters', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRFk-wa_x-dsthFXNsWa9wRxWOQrMD-yEiucvA2FtJIbwnTiGqVs3OT_eXxqyAOBqvGSDRiG-Hr0hK1/pub?gid=0&single=true&output=tsv', type: 'csv' },
    { key: 'CACHE_REM_DOM', label: 'REM Dom Defaulters', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRFk-wa_x-dsthFXNsWa9wRxWOQrMD-yEiucvA2FtJIbwnTiGqVs3OT_eXxqyAOBqvGSDRiG-Hr0hK1/pub?gid=1106133732&single=true&output=tsv', type: 'csv' },
    { key: 'CACHE_SOLAR', label: 'Solar Data', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vR5Vnb9TxymVIcBZsUBWZ-21Frkn77O4IyNus3Zo42qPm09N6MlJ3E0Vh3tHywcMAiy2y0uRm5XfIdk/pub?gid=0&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_METER_ERP', label: 'Meter ERP Data', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSmzya-jypjfu9nN5QWuRJ6sbIgrqQ7Wa1eAx6Wfoepft2UpNwBC4a_rd4uJ6VpLhNu7FnjDBa8mJxW/pub?gid=1335293243&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_METER_MASTER', label: 'Meter Master Data', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSmzya-jypjfu9nN5QWuRJ6sbIgrqQ7Wa1eAx6Wfoepft2UpNwBC4a_rd4uJ6VpLhNu7FnjDBa8mJxW/pub?gid=1053803476&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_METER_CRM', label: 'Meter CRM Data', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSmzya-jypjfu9nN5QWuRJ6sbIgrqQ7Wa1eAx6Wfoepft2UpNwBC4a_rd4uJ6VpLhNu7FnjDBa8mJxW/pub?gid=1638328510&single=true&output=csv', type: 'csv' },
    { key: 'CACHE_METER_ISU', label: 'Meter ISU Data', url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSmzya-jypjfu9nN5QWuRJ6sbIgrqQ7Wa1eAx6Wfoepft2UpNwBC4a_rd4uJ6VpLhNu7FnjDBa8mJxW/pub?gid=329630218&single=true&output=csv', type: 'csv' }
];

class DataHub {
    constructor() {
        this.db = null;
        this.initPromise = this._initDB();
        this.syncStatus = {}; // Tracks: 'idle', 'syncing', 'done', 'error'
        this.syncPromises = {}; // Tracks active fetch promises for individual datasets
    }

    _initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = (event) => {
                console.error("IndexedDB error:", event.target.error);
                reject(event.target.error);
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
        });
    }

    // Save data to cache
    async set(key, data) {
        await this.initPromise;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.put(data, key);

            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    }

    // Get data from cache
    async get(key) {
        await this.initPromise;
        
        // If this specific key is currently syncing, wait for it to complete
        // before returning the data. This provides a seamless "wait" experience.
        if (this.syncStatus[key] === 'syncing' && this.syncPromises[key]) {
            await this.syncPromises[key];
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(key);

            request.onsuccess = () => resolve(request.result);
            request.onerror = (e) => reject(e.target.error);
        });
    }

    // Clear all cached data
    async clear() {
        await this.initPromise;
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
        const today = new Date().toDateString();
        const lastSyncDate = localStorage.getItem('mzo_last_sync_date');
        return lastSyncDate !== today;
    }

    markSyncComplete() {
        const today = new Date().toDateString();
        localStorage.setItem('mzo_last_sync_date', today);
        localStorage.setItem('mzoDataSynced', 'true'); // Keep old flag for compatibility if needed
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

    async retryDataset(key) {
        const dataset = DATASETS.find(d => d.key === key);
        if (!dataset) return false;

        this.syncStatus[key] = 'syncing';
        this.syncPromises[key] = (async () => {
            try {
                const response = await fetch(dataset.url);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                
                let data;
                if (dataset.type === 'json') data = await response.json();
                else data = await response.text();

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
    const total = DATASETS.length;
    const BATCH_SIZE = 6; // Balance speed and rate limits

    try {
        // Initialize sync status for all
        DATASETS.forEach(d => {
            if (mzoDataHub.syncStatus[d.key] !== 'done') {
                mzoDataHub.syncStatus[d.key] = 'pending';
            }
        });

        // Use a simple queue for parallel execution with limited concurrency
        const queue = [...DATASETS];
        const workers = [];

        const updateProgress = (label) => {
            if (progressCallback) {
                progressCallback(completed, total, label);
            }
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

                updateProgress(`Updating ${dataset.label}...`);
                const success = await mzoDataHub.retryDataset(dataset.key);
                if (success) completed++;
                
                updateProgress(success ? `Loaded ${dataset.label}` : `Failed ${dataset.label}`);
            }
        };

        // Start initial workers
        for (let i = 0; i < Math.min(BATCH_SIZE, queue.length); i++) {
            workers.push(executeWorker());
        }

        await Promise.all(workers);

        const allDone = Object.values(mzoDataHub.syncStatus).every(s => s === 'done');
        
        if (progressCallback) {
            progressCallback(completed, total, allDone ? "Sync Complete!" : "Sync finished with some errors.");
        }

        if (allDone) {
            localStorage.setItem('mzoDataSynced', 'true');
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
    return localStorage.getItem('mzoDataSynced') !== 'true';
}
