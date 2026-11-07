'use strict';
// One error type for every Ask provider, and what the user is told for each kind.

class AssistantError extends Error {
    // kind: auth | credit | busy | bad_request | timeout | network | upstream | aborted
    constructor(kind, message, extra) {
        super(message);
        this.name = 'AssistantError';
        this.kind = kind;
        Object.assign(this, extra || {});
    }
}

const REPLIES = {
    auth: [503, 'not_configured', 'The assistant key is not valid. Ask the administrator to check it.'],
    credit: [503, 'no_credit', 'The assistant has run out of credit. Ask the administrator to top it up.'],
    busy: [429, 'busy', 'The assistant is busy. Try again in a moment.'],
    bad_request: [400, 'bad_request', 'That question could not be processed. Start a new conversation and try again.'],
    timeout: [504, 'timeout', 'The assistant took too long to answer. Try again.'],
    network: [502, 'upstream', 'The assistant could not answer right now. Try again.'],
    upstream: [502, 'upstream', 'The assistant could not answer right now. Try again.']
};

// → { status, code, message } for the HTTP reply
function replyFor(err) {
    const r = (err && REPLIES[err.kind]) || [500, 'error', 'The assistant could not answer right now. Try again.'];
    return { status: r[0], code: r[1], message: r[2] };
}

module.exports = { AssistantError, replyFor };
