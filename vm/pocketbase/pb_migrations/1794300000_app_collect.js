/// <reference path="../local/pb_data/types.d.ts" />
// DISHA Collect: admin/region/division officers request structured reports from subordinate
// offices. One shared draft per assignment/office; stamps on every save; late stamp while
// extended_due_at is open. Server-only (superuser); every API rule null. See docs/collect.md.
migrate((app) => {
    const templates = new Collection({
        type: 'base',
        name: 'app_collect_templates',
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
            { name: 'title', type: 'text', required: true, max: 200 },
            { name: 'description', type: 'text', max: 2000 },
            { name: 'schema', type: 'json' },
            { name: 'status', type: 'select', required: true, maxSelect: 1, values: ['draft', 'active', 'archived'] },
            { name: 'created_by_email', type: 'text', max: 254 },
            { name: 'created_by_name', type: 'text', max: 200 },
            { name: 'updated_by_email', type: 'text', max: 254 },
            { name: 'updated_by_name', type: 'text', max: 200 },
            { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
            { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true }
        ],
        indexes: [
            'CREATE INDEX `idx_app_collect_templates_status` ON `app_collect_templates` (`status`)'
        ]
    });
    app.save(templates);

    const requests = new Collection({
        type: 'base',
        name: 'app_collect_requests',
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
            { name: 'template_id', type: 'text', max: 40 },
            { name: 'title', type: 'text', required: true, max: 200 },
            { name: 'description', type: 'text', max: 2000 },
            { name: 'schema', type: 'json' },
            { name: 'due_at', type: 'date', required: true },
            { name: 'extended_due_at', type: 'date' },
            { name: 'status', type: 'select', required: true, maxSelect: 1, values: ['open', 'closed', 'cancelled'] },
            { name: 'offices', type: 'json' },
            { name: 'created_by_email', type: 'text', max: 254 },
            { name: 'created_by_name', type: 'text', max: 200 },
            { name: 'created_by_level', type: 'text', max: 20 },
            { name: 'created_by_region', type: 'text', max: 80 },
            { name: 'created_by_division', type: 'text', max: 80 },
            { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
            { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true }
        ],
        indexes: [
            'CREATE INDEX `idx_app_collect_requests_status` ON `app_collect_requests` (`status`)',
            'CREATE INDEX `idx_app_collect_requests_due` ON `app_collect_requests` (`due_at`)',
            'CREATE INDEX `idx_app_collect_requests_creator` ON `app_collect_requests` (`created_by_email`)'
        ]
    });
    app.save(requests);

    const assignments = new Collection({
        type: 'base',
        name: 'app_collect_assignments',
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
            { name: 'request_id', type: 'text', required: true, max: 40 },
            { name: 'office_level', type: 'select', required: true, maxSelect: 1, values: ['zone', 'region', 'division', 'ccc'] },
            { name: 'region', type: 'text', max: 80 },
            { name: 'division', type: 'text', max: 80 },
            { name: 'ccc_code', type: 'text', max: 16 },
            { name: 'ccc_name', type: 'text', max: 120 },
            { name: 'office_label', type: 'text', max: 200 },
            { name: 'assignee_user', type: 'text', max: 254 },
            { name: 'status', type: 'select', required: true, maxSelect: 1, values: ['pending', 'in_progress', 'submitted', 'returned', 'withdrawn'] },
            { name: 'due_at', type: 'date' },
            { name: 'extended_due_at', type: 'date' },
            { name: 'submitted_at', type: 'date' },
            { name: 'last_saved_at', type: 'date' },
            { name: 'last_saved_by_email', type: 'text', max: 254 },
            { name: 'last_saved_by_name', type: 'text', max: 200 },
            { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
            { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true }
        ],
        indexes: [
            'CREATE INDEX `idx_app_collect_asg_request` ON `app_collect_assignments` (`request_id`)',
            'CREATE INDEX `idx_app_collect_asg_status` ON `app_collect_assignments` (`status`)',
            'CREATE INDEX `idx_app_collect_asg_office` ON `app_collect_assignments` (`office_level`, `region`, `division`, `ccc_code`)'
        ]
    });
    app.save(assignments);

    const submissions = new Collection({
        type: 'base',
        name: 'app_collect_submissions',
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
            { name: 'assignment_id', type: 'text', required: true, max: 40 },
            { name: 'request_id', type: 'text', required: true, max: 40 },
            { name: 'payload', type: 'json' },
            { name: 'status', type: 'select', required: true, maxSelect: 1, values: ['draft', 'submitted'] },
            { name: 'revision', type: 'number', onlyInt: true, min: 0 },
            { name: 'stamp_email', type: 'text', max: 254 },
            { name: 'stamp_name', type: 'text', max: 200 },
            { name: 'stamp_username', type: 'text', max: 80 },
            { name: 'stamp_office_level', type: 'text', max: 20 },
            { name: 'stamp_region', type: 'text', max: 80 },
            { name: 'stamp_division', type: 'text', max: 80 },
            { name: 'stamp_ccc_code', type: 'text', max: 16 },
            { name: 'stamp_at', type: 'date' },
            { name: 'stamp_ip', type: 'text', max: 64 },
            { name: 'stamp_late', type: 'bool' },
            { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
            { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true }
        ],
        indexes: [
            'CREATE UNIQUE INDEX `idx_app_collect_sub_assignment` ON `app_collect_submissions` (`assignment_id`)',
            'CREATE INDEX `idx_app_collect_sub_request` ON `app_collect_submissions` (`request_id`)'
        ]
    });
    app.save(submissions);
}, (app) => {
    try { app.delete(app.findCollectionByNameOrId('app_collect_submissions')); } catch (_) {}
    try { app.delete(app.findCollectionByNameOrId('app_collect_assignments')); } catch (_) {}
    try { app.delete(app.findCollectionByNameOrId('app_collect_requests')); } catch (_) {}
    try { app.delete(app.findCollectionByNameOrId('app_collect_templates')); } catch (_) {}
});
