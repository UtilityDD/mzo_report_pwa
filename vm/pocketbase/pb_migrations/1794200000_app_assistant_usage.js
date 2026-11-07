/// <reference path="../local/pb_data/types.d.ts" />
// app_assistant_usage: one row per Ask model call (a question takes 2-4 calls: the browser runs the
// tool loop), for Admin -> Ask usage. Metadata only: who asked, provider, model, tokens, latency,
// status, tool calls and the provider's X-Data-Policy header; never the question, the answer or the
// tool results. Written only by server.js (superuser, lib/assistant/usage.js), so every API rule is
// null. See docs/assistant.md and docs/users.md.
//   input_tokens includes cached_input_tokens; output_tokens includes reasoning_tokens.
//   turn: 0 for the call that starts a question, 1, 2… for the calls after its tool results.
//   status: ok, an HTTP status (401, 402, 429, 502…) or timeout | network | queue | upstream | error.
migrate((app) => {
    const collection = new Collection({
        type: 'base',
        name: 'app_assistant_usage',
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
            { name: 'user_email', type: 'text', max: 254 },
            { name: 'user_name', type: 'text', max: 200 },
            { name: 'provider', type: 'text', max: 40 },
            { name: 'model', type: 'text', max: 120 },
            { name: 'turn', type: 'number', onlyInt: true, min: 0 },
            { name: 'input_tokens', type: 'number', onlyInt: true, min: 0 },
            { name: 'cached_input_tokens', type: 'number', onlyInt: true, min: 0 },
            { name: 'output_tokens', type: 'number', onlyInt: true, min: 0 },
            { name: 'reasoning_tokens', type: 'number', onlyInt: true, min: 0 },
            { name: 'latency_ms', type: 'number', onlyInt: true, min: 0 },
            { name: 'status', type: 'text', required: true, max: 20 },
            { name: 'tool_calls_count', type: 'number', onlyInt: true, min: 0 },
            { name: 'retries', type: 'number', onlyInt: true, min: 0 },
            { name: 'data_policy', type: 'text', max: 40 },
            { name: 'created', type: 'autodate', onCreate: true, onUpdate: false }
        ],
        indexes: [
            'CREATE INDEX `idx_app_assistant_usage_created` ON `app_assistant_usage` (`created`)',
            'CREATE INDEX `idx_app_assistant_usage_email_created` ON `app_assistant_usage` (`user_email`, `created`)'
        ]
    });
    app.save(collection);
}, (app) => {
    app.delete(app.findCollectionByNameOrId('app_assistant_usage'));
});
