/// <reference path="../local/pb_data/types.d.ts" />
// A fresh PocketBase install comes with a "users" auth collection that allows public sign-up.
// The mirror has no use for it (the portal signs in through portal_users_auth), and no
// collection may have a public rule, so remove it while it is still empty.
migrate((app) => {
    let users = null;
    try {
        users = app.findCollectionByNameOrId('users');
    } catch (_) {
        return;
    }
    if (app.countRecords('users') > 0) {
        users.createRule = null;
        app.save(users);
        return;
    }
    app.delete(users);
}, (app) => {
    // Nothing to restore: the default collection is not needed.
});
