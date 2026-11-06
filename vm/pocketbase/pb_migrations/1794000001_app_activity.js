/// <reference path="../local/pb_data/types.d.ts" />
// app_activity: what signed-in users do in the app on the VM (sign-ins, page visits, admin actions,
// uploads), for Admin -> Activity and Visitors. Written only by server.js (superuser), so every API rule
// is null. The user's email, username and name are snapshots, so a row still reads correctly after the
// user is renamed or deleted. Rows older than MZO_ACTIVITY_RETENTION_DAYS (default 180) are pruned by
// lib/users_store.js. See docs/users.md.
migrate((app) => {
    const collection = new Collection({
        type: 'base',
        name: 'app_activity',
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
            { name: 'user_email', type: 'text', max: 254 },
            { name: 'username', type: 'text', max: 100 },
            { name: 'user_name', type: 'text', max: 200 },
            { name: 'action', type: 'text', required: true, max: 50 },
            { name: 'page', type: 'text', max: 300 },
            { name: 'details', type: 'json', maxSize: 20000 },
            { name: 'ip', type: 'text', max: 64 },
            { name: 'user_agent', type: 'text', max: 400 },
            { name: 'created', type: 'autodate', onCreate: true, onUpdate: false }
        ],
        indexes: [
            'CREATE INDEX `idx_app_activity_created` ON `app_activity` (`created`)',
            'CREATE INDEX `idx_app_activity_email_created` ON `app_activity` (`user_email`, `created`)',
            'CREATE INDEX `idx_app_activity_username_created` ON `app_activity` (`username`, `created`)',
            'CREATE INDEX `idx_app_activity_action_created` ON `app_activity` (`action`, `created`)'
        ]
    });
    app.save(collection);
}, (app) => {
    app.delete(app.findCollectionByNameOrId('app_activity'));
});
