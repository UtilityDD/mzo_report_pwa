/// <reference path="../local/pb_data/types.d.ts" />
// When the source itself last changed (HTTP Last-Modified, or a report date the source exposes),
// as opposed to when the mirror checked it. Copied to manifest.json as sourceModifiedAt.
migrate((app) => {
    const collection = app.findCollectionByNameOrId('sys_datasets');
    collection.fields.add(new DateField({ name: 'source_modified_at' }));
    app.save(collection);
}, (app) => {
    const collection = app.findCollectionByNameOrId('sys_datasets');
    collection.fields.removeByName('source_modified_at');
    app.save(collection);
});
