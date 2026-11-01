/// <reference path="../local/pb_data/types.d.ts" />
// Snapshot store: where each dataset's raw source copy lives (see docs/data-mirror.md).
migrate((app) => {
    const collection = app.findCollectionByNameOrId('sys_datasets');
    collection.fields.add(new TextField({ name: 'snapshot_file', max: 200 }));
    collection.fields.add(new TextField({ name: 'snapshot_sha1', max: 64 }));
    collection.fields.add(new NumberField({ name: 'snapshot_bytes', onlyInt: true }));
    collection.fields.add(new DateField({ name: 'snapshot_at' }));
    app.save(collection);
}, (app) => {
    const collection = app.findCollectionByNameOrId('sys_datasets');
    for (const name of ['snapshot_file', 'snapshot_sha1', 'snapshot_bytes', 'snapshot_at']) {
        collection.fields.removeByName(name);
    }
    app.save(collection);
});
