/// <reference path="../local/pb_data/types.d.ts" />
// app_users: the app's own user accounts on the VM (MZO_USER_STORE=pocketbase), one per Google email.
// A fresh start: nothing is copied from the Supabase portal_users table. server.js (lib/users_store.js)
// is the only client and signs in as a superuser, so every API rule is null. Design: docs/users.md.
//
// - email is the identity (always lowercase, unique ignoring case); google_sub pins the Google account
//   once it has signed in. username is the short handle the pages and the activity log show (Username).
// - role: admin | editor | viewer. status: pending | active | disabled | rejected.
// - Office scope: scope_level (zone | region | division | ccc) with the canonical names / code from
//   lib/offices.js. The app checks the combination; the schema only bounds each value.
// - modules: report keys from app.html's NAV the user may open; null means every report.
// - feature_flags: the per-feature grants the pages already read (upload, sync, stock, SI, sheets, ...),
//   keyed by their snake_case names; see lib/users_store.js FLAG_KEYS.
// - session_version: bumped to end every open session of the user (disable, role or scope change).
migrate((app) => {
    const collection = new Collection({
        type: 'base',
        name: 'app_users',
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
            // identity
            { name: 'email', type: 'text', required: true, max: 254, pattern: "^[a-z0-9._%+'-]+@[a-z0-9.-]+\\.[a-z]{2,}$", presentable: true },
            { name: 'username', type: 'text', required: true, max: 60, pattern: '^[a-z0-9_.-]+$' },
            { name: 'google_sub', type: 'text', max: 64, pattern: '^[0-9]*$' },
            { name: 'name', type: 'text', max: 200 },
            { name: 'photo_url', type: 'text', max: 1000 },
            { name: 'phone', type: 'text', max: 20 },
            { name: 'designation', type: 'text', max: 120 },
            { name: 'employee_id', type: 'text', max: 40 },
            // access
            { name: 'role', type: 'select', required: true, maxSelect: 1, values: ['admin', 'editor', 'viewer'] },
            { name: 'status', type: 'select', required: true, maxSelect: 1, values: ['pending', 'active', 'disabled', 'rejected'] },
            // office scope
            { name: 'scope_level', type: 'select', maxSelect: 1, values: ['zone', 'region', 'division', 'ccc'] },
            { name: 'region', type: 'text', max: 40 },
            { name: 'division', type: 'text', max: 40 },
            { name: 'ccc_code', type: 'text', max: 7, pattern: '^(66[0-9]{5})?$' },
            // what the user may open and do
            { name: 'modules', type: 'json', maxSize: 20000 },
            { name: 'feature_flags', type: 'json', maxSize: 20000 },
            // revocation
            { name: 'session_version', type: 'number', onlyInt: true, min: 0 },
            // tracking
            { name: 'requested_at', type: 'date' },
            { name: 'approved_by', type: 'text', max: 254 },
            { name: 'approved_at', type: 'date' },
            { name: 'disabled_reason', type: 'text', max: 500 },
            { name: 'last_login_at', type: 'date' },
            { name: 'last_seen_at', type: 'date' },
            { name: 'login_count', type: 'number', onlyInt: true, min: 0 },
            { name: 'notes', type: 'text', max: 2000 },
            { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
            { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true }
        ],
        indexes: [
            'CREATE UNIQUE INDEX `idx_app_users_email` ON `app_users` (`email` COLLATE NOCASE)',
            'CREATE UNIQUE INDEX `idx_app_users_username` ON `app_users` (`username` COLLATE NOCASE)',
            "CREATE UNIQUE INDEX `idx_app_users_google_sub` ON `app_users` (`google_sub`) WHERE `google_sub` != ''",
            'CREATE INDEX `idx_app_users_status_role` ON `app_users` (`status`, `role`)',
            'CREATE INDEX `idx_app_users_scope` ON `app_users` (`scope_level`, `region`, `division`, `ccc_code`)'
        ]
    });
    app.save(collection);
}, (app) => {
    app.delete(app.findCollectionByNameOrId('app_users'));
});
