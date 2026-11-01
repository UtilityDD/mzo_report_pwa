/// <reference path="../local/pb_data/types.d.ts" />
// sys_sync_runs: one row per dataset sync attempt (vm/sync prunes rows older than 30 days).
migrate((app) => {
    const PORTAL = '@request.auth.collectionName = "portal_users_auth"';
    const collection = new Collection({
        type: 'base',
        name: 'sys_sync_runs',
        listRule: PORTAL,
        viewRule: PORTAL,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
            { name: 'dataset', type: 'text', required: true, max: 64, presentable: true },
            { name: 'started_at', type: 'date' },
            { name: 'finished_at', type: 'date' },
            { name: 'status', type: 'text', max: 20 },
            { name: 'rows_total', type: 'number', onlyInt: true },
            { name: 'rows_inserted', type: 'number', onlyInt: true },
            { name: 'rows_updated', type: 'number', onlyInt: true },
            { name: 'rows_deleted', type: 'number', onlyInt: true },
            { name: 'duration_ms', type: 'number', onlyInt: true },
            { name: 'message', type: 'text', max: 20000 },
            { name: 'created', type: 'autodate', onCreate: true, onUpdate: false }
        ],
        indexes: [
            'CREATE INDEX `idx_sys_sync_runs_dataset` ON `sys_sync_runs` (`dataset`, `started_at`)',
            'CREATE INDEX `idx_sys_sync_runs_started` ON `sys_sync_runs` (`started_at`)'
        ]
    });
    app.save(collection);
}, (app) => {
    app.delete(app.findCollectionByNameOrId('sys_sync_runs'));
});
