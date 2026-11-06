/// <reference path="../local/pb_data/types.d.ts" />
// Data editor audit trail (docs/data-editor.md).
//   app_edit_batches  one row per commit (paste, import, edits, undo, mode switch). Its id comes from
//                     the client's idempotency key, and it is written in the same transaction as the
//                     rows, so a retried commit is answered from here instead of applied twice.
//   app_edit_log      one row per record changed: op create | update | delete, the record before and
//                     after, who and when. Undo and the rollback of a failed multi-part commit replay it.
// Only the app server (a superuser) reads or writes them.
migrate((app) => {
    const batches = new Collection({
        type: 'base',
        name: 'app_edit_batches',
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
            { name: 'dataset_key', type: 'text', required: true, max: 64, presentable: true },
            { name: 'kind', type: 'text', max: 32 },
            { name: 'status', type: 'text', max: 20 },
            { name: 'user_email', type: 'text', max: 320 },
            { name: 'summary', type: 'text', max: 2000 },
            { name: 'counts', type: 'json', maxSize: 10000 },
            { name: 'result', type: 'json', maxSize: 2000000 },
            { name: 'undo_of', type: 'text', max: 32 },
            { name: 'undone_by', type: 'text', max: 32 },
            { name: 'parts', type: 'number', onlyInt: true },
            { name: 'client', type: 'json', maxSize: 10000 },
            { name: 'error', type: 'text', max: 5000 },
            { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
            { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true }
        ],
        indexes: [
            'CREATE INDEX `idx_app_edit_batches_ds` ON `app_edit_batches` (`dataset_key`, `created`)',
            'CREATE INDEX `idx_app_edit_batches_status` ON `app_edit_batches` (`status`)'
        ]
    });
    app.save(batches);

    const log = new Collection({
        type: 'base',
        name: 'app_edit_log',
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
            { name: 'batch_id', type: 'text', required: true, max: 32 },
            { name: 'dataset_key', type: 'text', required: true, max: 64 },
            { name: 'record_id', type: 'text', max: 32 },
            { name: 'op', type: 'text', max: 10 },
            { name: 'seq', type: 'number', onlyInt: true },
            { name: 'row_no', type: 'number', onlyInt: true },
            { name: 'before', type: 'json', maxSize: 5000000 },
            { name: 'after', type: 'json', maxSize: 5000000 },
            { name: 'user_email', type: 'text', max: 320 },
            { name: 'at', type: 'date' },
            { name: 'client', type: 'json', maxSize: 10000 },
            { name: 'created', type: 'autodate', onCreate: true, onUpdate: false }
        ],
        indexes: [
            'CREATE INDEX `idx_app_edit_log_batch` ON `app_edit_log` (`batch_id`, `seq`)',
            'CREATE INDEX `idx_app_edit_log_ds` ON `app_edit_log` (`dataset_key`, `at`)',
            'CREATE INDEX `idx_app_edit_log_record` ON `app_edit_log` (`dataset_key`, `record_id`)'
        ]
    });
    app.save(log);
}, (app) => {
    for (const name of ['app_edit_log', 'app_edit_batches']) {
        try { app.delete(app.findCollectionByNameOrId(name)); } catch (_) { /* gone */ }
    }
});
