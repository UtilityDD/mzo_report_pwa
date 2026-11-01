/// <reference path="../local/pb_data/types.d.ts" />
// dim_offices: the canonical MZO offices (zone, 3 regions, 7 divisions, 41 CCCs) with their codes and
// every alias found in the data. The rows come from lib/offices.js: vm/sync writes them at the start
// of a run whenever that list changes, so this migration holds only the structure.
// Readable by signed-in portal users; only superusers (the sync) write.
migrate((app) => {
    const PORTAL = '@request.auth.collectionName = "portal_users_auth"';
    const collection = new Collection({
        type: 'base',
        name: 'dim_offices',
        listRule: PORTAL,
        viewRule: PORTAL,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
            { name: 'code', type: 'text', required: true, max: 20, presentable: true },
            { name: 'level', type: 'text', max: 20 },
            { name: 'name', type: 'text', max: 100 },
            { name: 'region', type: 'text', max: 100 },
            { name: 'division', type: 'text', max: 100 },
            { name: 'ccc', type: 'text', max: 100 },
            { name: 'parent_code', type: 'text', max: 20 },
            { name: 'prefix', type: 'text', max: 20 },
            { name: 'district', type: 'text', max: 100 },
            { name: 'lgd_code', type: 'text', max: 10 },
            { name: 'plants', type: 'json', maxSize: 10000 },
            { name: 'aliases', type: 'json', maxSize: 100000 },
            { name: 'sort', type: 'number', onlyInt: true },
            { name: 'version', type: 'text', max: 40 },
            { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
            { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true }
        ],
        indexes: [
            'CREATE UNIQUE INDEX `idx_dim_offices_code` ON `dim_offices` (`code`)',
            'CREATE INDEX `idx_dim_offices_level` ON `dim_offices` (`level`)'
        ]
    });
    app.save(collection);
}, (app) => {
    app.delete(app.findCollectionByNameOrId('dim_offices'));
});
