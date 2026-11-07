'use strict';
// Ask provider: Anthropic Messages API (Claude Haiku), the behaviour Ask had before the provider
// layer: effort low, 16000 max tokens, the shared prompt cached, SDK retries 2, 60 s timeout.
// The conversation is already in Messages format, so it is passed through unchanged.

const { AssistantError } = require('./errors.js');

const DEFAULT_MODEL = 'claude-haiku-5-5';

function create(opts) {
    const SDK = opts.sdk || require('@anthropic-ai/sdk');
    const Anthropic = SDK.default || SDK;
    const model = opts.model || DEFAULT_MODEL;
    const client = opts.client || new Anthropic({ apiKey: opts.apiKey, maxRetries: 2, timeout: 60 * 1000 });

    function toError(err) {
        const status = err && err.status;
        if (Anthropic.RateLimitError && err instanceof Anthropic.RateLimitError) return new AssistantError('busy', err.message, { status });
        if ((Anthropic.AuthenticationError && err instanceof Anthropic.AuthenticationError) || (Anthropic.PermissionDeniedError && err instanceof Anthropic.PermissionDeniedError)) {
            return new AssistantError('auth', err.message, { status });
        }
        if (Anthropic.BadRequestError && err instanceof Anthropic.BadRequestError) return new AssistantError('bad_request', err.message, { status });
        if (Anthropic.APIError && err instanceof Anthropic.APIError) return new AssistantError('upstream', `${status || ''} ${err.message}`.trim(), { status });
        return new AssistantError('error', (err && err.message) || 'error');
    }

    async function complete({ system, tools, messages, maxTokens, signal }) {
        const sys = Array.isArray(system) ? system : [system];
        // The shared prompt is cached; volatile, per-user details go after the cached block.
        const blocks = sys.filter(Boolean).map((text, i) => (i === 0 ? { type: 'text', text, cache_control: { type: 'ephemeral' } } : { type: 'text', text }));
        let response;
        try {
            response = await client.messages.create({
                model,
                max_tokens: maxTokens || 16000,
                output_config: { effort: 'low' },
                system: blocks,
                tools,
                messages
            }, signal ? { signal } : undefined);
        } catch (err) {
            throw toError(err);
        }
        const u = response.usage || {};
        return {
            content: response.content,
            stop_reason: response.stop_reason,
            usage: { input: u.input_tokens, output: u.output_tokens, cache_read: u.cache_read_input_tokens },
            provider: 'anthropic',
            model: response.model || model,
            dataPolicy: ''
        };
    }

    return { name: 'anthropic', model, complete };
}

module.exports = { create, DEFAULT_MODEL };
