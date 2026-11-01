/// <reference path="../local/pb_data/types.d.ts" />
// MZO data mirror: PocketBase settings.
//
// These migrations create only the fixed collections: sys_datasets, sys_sync_runs and the
// portal_users_auth sign-in collection. The ds_<key> data collections are created and altered
// at runtime by vm/sync from the source registry, because their fields come from the source
// headers (Google Sheet columns, Supabase columns) and change whenever a sheet gains, loses or
// retypes a column. Writing a migration for every such change would mean a commit and a deploy
// each time a clerk edits a header. See docs/data-mirror.md.
//
// - Batch API on: the sync writes rows in batches of a few hundred per transaction.
// - Rate limits on with the PocketBase defaults; the sync on 127.0.0.1 is excluded.
// - The real client IP comes from Caddy's X-Forwarded-For (PocketBase listens on 127.0.0.1 only).
// - Logs kept 7 days to keep the disk small.
migrate((app) => {
    const settings = app.settings();
    settings.meta.appName = 'MZO data mirror';
    settings.meta.hideControls = true;
    settings.batch.enabled = true;
    settings.batch.maxRequests = 1000;
    settings.batch.timeout = 120;
    settings.logs.maxDays = 7;
    settings.trustedProxy.headers = ['X-Forwarded-For'];
    settings.trustedProxy.useLeftmostIP = false;
    settings.rateLimits.enabled = true;
    settings.rateLimits.excludedIPs = ['127.0.0.1', '::1'];
    settings.rateLimits.rules = [
        { label: '*:auth', audience: '', duration: 3, maxRequests: 2 },
        { label: '*:create', audience: '', duration: 5, maxRequests: 20 },
        { label: '/api/batch', audience: '', duration: 1, maxRequests: 3 },
        { label: '/api/', audience: '', duration: 10, maxRequests: 300 }
    ];
    app.save(settings);
}, (app) => {
    const settings = app.settings();
    settings.batch.enabled = false;
    settings.rateLimits.enabled = false;
    settings.trustedProxy.headers = [];
    app.save(settings);
});
