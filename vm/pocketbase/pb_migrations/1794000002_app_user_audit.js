/// <reference path="../local/pb_data/types.d.ts" />
// app_user_audit: every change to an app_users account, by whom, field by field. Kept apart from
// app_activity because it is never pruned and is read per user (the account's change history).
// changes is a list of { field, from, to }. Written only by server.js (superuser). See docs/users.md.
migrate((app) => {
    const collection = new Collection({
        type: 'base',
        name: 'app_user_audit',
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
            { name: 'user_email', type: 'text', required: true, max: 254 },
            { name: 'username', type: 'text', max: 60 },
            { name: 'actor_email', type: 'text', max: 254 },
            { name: 'actor_name', type: 'text', max: 200 },
            { name: 'action', type: 'select', required: true, maxSelect: 1,
                values: ['register', 'seed', 'create', 'approve', 'reject', 'update', 'disable', 'enable', 'delete', 'link_google'] },
            { name: 'changes', type: 'json', maxSize: 50000 },
            { name: 'reason', type: 'text', max: 500 },
            { name: 'ip', type: 'text', max: 64 },
            { name: 'created', type: 'autodate', onCreate: true, onUpdate: false }
        ],
        indexes: [
            'CREATE INDEX `idx_app_user_audit_email_created` ON `app_user_audit` (`user_email`, `created`)',
            'CREATE INDEX `idx_app_user_audit_created` ON `app_user_audit` (`created`)'
        ]
    });
    app.save(collection);
}, (app) => {
    app.delete(app.findCollectionByNameOrId('app_user_audit'));
});
