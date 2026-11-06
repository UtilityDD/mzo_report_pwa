/// <reference path="../local/pb_data/types.d.ts" />
// Data editor: what each signed-in app user may do with each dataset (docs/data-editor.md).
// One row per (user_email, dataset_key); dataset_key '*' applies to every dataset. Admins need no
// row. scope_only: the user may only touch rows whose office (_region / _division / _ccc_code) is
// inside the office scope of their login. Only the app server (a superuser) reads or writes it.
migrate((app) => {
    const collection = new Collection({
        type: 'base',
        name: 'app_dataset_permissions',
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
            { name: 'user_email', type: 'text', required: true, max: 320, presentable: true },
            { name: 'dataset_key', type: 'text', required: true, max: 64 },
            { name: 'can_view', type: 'bool' },
            { name: 'can_add', type: 'bool' },
            { name: 'can_edit', type: 'bool' },
            { name: 'can_delete', type: 'bool' },
            { name: 'scope_only', type: 'bool' },
            { name: 'granted_by', type: 'text', max: 320 },
            { name: 'notes', type: 'text', max: 2000 },
            { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
            { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true }
        ],
        indexes: [
            'CREATE UNIQUE INDEX `idx_app_dataset_permissions_user_ds` ON `app_dataset_permissions` (`user_email`, `dataset_key`)',
            'CREATE INDEX `idx_app_dataset_permissions_ds` ON `app_dataset_permissions` (`dataset_key`)'
        ]
    });
    app.save(collection);
}, (app) => {
    app.delete(app.findCollectionByNameOrId('app_dataset_permissions'));
});
