'use strict';
// sys_datasets (one row per source, id derived from the key) and sys_sync_runs (one row per attempt).

const { recordId, pbDate, log } = require('./util');

const DATASETS = 'sys_datasets';
const RUNS = 'sys_sync_runs';
const RUN_RETENTION_DAYS = 30;

class Registry {
    constructor(pb) {
        this.pb = pb;
        this.byKey = new Map();
    }

    static idFor(key) {
        return recordId('sys_datasets:' + key);
    }

    async load() {
        this.byKey.clear();
        for await (const page of this.pb.pages(DATASETS, { fields: '*' })) {
            for (const r of page) this.byKey.set(r.key, r);
        }
        return this.byKey;
    }

    get(key) {
        return this.byKey.get(key) || null;
    }

    async save(key, fields) {
        const body = Object.assign({ key }, fields);
        const rec = await this.pb.upsertRecord(DATASETS, Registry.idFor(key), body);
        this.byKey.set(key, rec);
        return rec;
    }

    async logRun(run) {
        const body = Object.assign({}, run, {
            started_at: pbDate(run.started_at),
            finished_at: pbDate(run.finished_at),
            message: String(run.message || '').slice(0, 20000)
        });
        return this.pb.createRecord(RUNS, body);
    }

    /** Delete run rows older than the retention window (a few batches per run at most). */
    async prune(maxRows = 2000) {
        const cutoff = pbDate(new Date(Date.now() - RUN_RETENTION_DAYS * 86400000));
        let removed = 0;
        while (removed < maxRows) {
            const res = await this.pb.listRecords(RUNS, { perPage: 500, skipTotal: 1, fields: 'id', filter: `started_at < "${cutoff}"` });
            const ids = (res.items || []).map((r) => r.id);
            if (!ids.length) break;
            await this.pb.batch(ids.map((id) => ({ method: 'DELETE', url: `/api/collections/${RUNS}/records/${id}` })));
            removed += ids.length;
        }
        if (removed) log(`pruned ${removed} sync run rows older than ${RUN_RETENTION_DAYS} days`);
        return removed;
    }
}

module.exports = { Registry, DATASETS, RUNS };
