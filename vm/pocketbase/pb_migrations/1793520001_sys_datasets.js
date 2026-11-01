/// <reference path="../local/pb_data/types.d.ts" />
// sys_datasets: one row per mirrored source (the registry written by vm/sync).
// Readable by signed-in portal users; only superusers (the sync) write.
migrate((app) => {
    const PORTAL = '@request.auth.collectionName = "portal_users_auth"';
    const collection = new Collection({
        type: 'base',
        name: 'sys_datasets',
        listRule: PORTAL,
        viewRule: PORTAL,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
            { name: 'key', type: 'text', required: true, max: 64, presentable: true },
            { name: 'label', type: 'text', max: 200 },
            { name: 'group', type: 'text', max: 100 },
            { name: 'pages', type: 'json', maxSize: 100000 },
            { name: 'source_type', type: 'text', max: 40 },
            { name: 'source_ref', type: 'json', maxSize: 100000 },
            { name: 'source_url', type: 'text', max: 2000 },
            { name: 'collection', type: 'text', max: 64 },
            { name: 'row_count', type: 'number', onlyInt: true },
            { name: 'column_count', type: 'number', onlyInt: true },
            { name: 'columns', type: 'json', maxSize: 2000000 },
            { name: 'primary_key', type: 'json', maxSize: 10000 },
            { name: 'schedule', type: 'text', max: 20 },
            { name: 'last_version', type: 'text', max: 1000 },
            { name: 'content_hash', type: 'text', max: 100 },
            { name: 'last_synced_at', type: 'date' },
            { name: 'last_checked_at', type: 'date' },
            { name: 'last_fetched_at', type: 'date' },
            { name: 'last_status', type: 'text', max: 20 },
            { name: 'last_error', type: 'text', max: 20000 },
            { name: 'last_duration_ms', type: 'number', onlyInt: true },
            { name: 'notes', type: 'text', max: 5000 },
            { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
            { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true }
        ],
        indexes: [
            'CREATE UNIQUE INDEX `idx_sys_datasets_key` ON `sys_datasets` (`key`)'
        ]
    });
    app.save(collection);
}, (app) => {
    app.delete(app.findCollectionByNameOrId('sys_datasets'));
});
