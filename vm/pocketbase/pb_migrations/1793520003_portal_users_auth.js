/// <reference path="../local/pb_data/types.d.ts" />
// portal_users_auth: sign-in for the admin portal (separate from the app's own portal_users data).
// Email + password only, no self sign-up (createRule null): provisioning creates the accounts.
// A signed-in user can read only their own account record.
migrate((app) => {
    const collection = new Collection({
        type: 'auth',
        name: 'portal_users_auth',
        listRule: 'id = @request.auth.id',
        viewRule: 'id = @request.auth.id',
        createRule: null,
        updateRule: null,
        deleteRule: null,
        authRule: '',
        manageRule: null,
        passwordAuth: { enabled: true, identityFields: ['email'] },
        oauth2: { enabled: false },
        otp: { enabled: false },
        mfa: { enabled: false },
        authAlert: { enabled: false },
        fields: [
            { name: 'name', type: 'text', max: 200 },
            { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
            { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true }
        ]
    });
    collection.authToken.duration = 86400;
    app.save(collection);
}, (app) => {
    app.delete(app.findCollectionByNameOrId('portal_users_auth'));
});
