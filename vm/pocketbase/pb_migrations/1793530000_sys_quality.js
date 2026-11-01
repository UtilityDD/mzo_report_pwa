/// <reference path="../local/pb_data/types.d.ts" />
// Data quality results written by vm/quality after each sync (see docs/data-quality.md).
//   sys_quality_issues: one row per (dataset, check, column); status open | resolved.
//   sys_quality_scores: one row per dataset, score 0–100.
// Readable by signed-in portal users; only superusers (the sync) write.
migrate((app) => {
    const PORTAL = '@request.auth.collectionName = "portal_users_auth"';
    const issues = new Collection({
        type: 'base',
        name: 'sys_quality_issues',
        listRule: PORTAL,
        viewRule: PORTAL,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
            { name: 'dataset', type: 'text', required: true, max: 64, presentable: true },
            { name: 'check', type: 'text', required: true, max: 64 },
            { name: 'severity', type: 'select', required: true, maxSelect: 1, values: ['info', 'warn', 'error'] },
            { name: 'column', type: 'text', max: 500 },
            { name: 'count', type: 'number', onlyInt: true },
            { name: 'sample', type: 'json', maxSize: 200000 },
            { name: 'first_seen', type: 'date' },
            { name: 'last_seen', type: 'date' },
            { name: 'status', type: 'select', required: true, maxSelect: 1, values: ['open', 'resolved'] },
            { name: 'source_fix', type: 'bool' },
            { name: 'hint', type: 'text', max: 2000 },
            { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
            { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true }
        ],
        indexes: [
            'CREATE INDEX `idx_sys_quality_issues_dataset` ON `sys_quality_issues` (`dataset`, `status`)',
            'CREATE INDEX `idx_sys_quality_issues_check` ON `sys_quality_issues` (`check`, `severity`)',
            'CREATE INDEX `idx_sys_quality_issues_last_seen` ON `sys_quality_issues` (`last_seen`)'
        ]
    });
    app.save(issues);

    const scores = new Collection({
        type: 'base',
        name: 'sys_quality_scores',
        listRule: PORTAL,
        viewRule: PORTAL,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
            { name: 'dataset', type: 'text', required: true, max: 64, presentable: true },
            { name: 'score', type: 'number', min: 0, max: 100, onlyInt: true },
            { name: 'issues_open', type: 'number', onlyInt: true },
            { name: 'checked_at', type: 'date' },
            { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
            { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true }
        ],
        indexes: [
            'CREATE UNIQUE INDEX `idx_sys_quality_scores_dataset` ON `sys_quality_scores` (`dataset`)'
        ]
    });
    app.save(scores);
}, (app) => {
    for (const name of ['sys_quality_scores', 'sys_quality_issues']) {
        try {
            app.delete(app.findCollectionByNameOrId(name));
        } catch (_) { /* already gone */ }
    }
});
