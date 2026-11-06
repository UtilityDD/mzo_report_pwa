/// <reference path="../local/pb_data/types.d.ts" />
// Data editor (docs/data-editor.md): who is the source of truth for each dataset.
//   mode           '' or 'mirror': Google / Supabase is the source and the sync copies it (default).
//                  'native': the VM is the source. The sync skips the dataset and the editor writes it.
//   native_since   when the dataset became native; native_by: who switched it (lowercase email).
//   native_format  how the editor writes the dataset's snapshot from its rows: delimiter, quoting,
//                  line ending, header cells and the source column of every field (lib/editor/format.js).
migrate((app) => {
    const collection = app.findCollectionByNameOrId('sys_datasets');
    collection.fields.add(new TextField({ name: 'mode', max: 16 }));
    collection.fields.add(new DateField({ name: 'native_since' }));
    collection.fields.add(new TextField({ name: 'native_by', max: 320 }));
    collection.fields.add(new JSONField({ name: 'native_format', maxSize: 2000000 }));
    app.save(collection);
}, (app) => {
    const collection = app.findCollectionByNameOrId('sys_datasets');
    for (const name of ['mode', 'native_since', 'native_by', 'native_format']) collection.fields.removeByName(name);
    app.save(collection);
});
