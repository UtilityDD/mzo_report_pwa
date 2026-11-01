'use strict';
// Minimal PocketBase REST client on plain fetch (superuser only). Retries network errors and
// 5xx responses, re-authenticates once on 401, and exposes the batch API.

const { sleep } = require('./util');

class PbError extends Error {
    constructor(status, data, what) {
        super(`${what}: HTTP ${status} ${PbError.describe(data)}`);
        this.name = 'PbError';
        this.status = status;
        this.data = data;
    }

    static describe(data) {
        if (!data || typeof data !== 'object') return String(data || '').slice(0, 300);
        let msg = data.message || '';
        const fields = data.data && typeof data.data === 'object' ? data.data : null;
        if (fields && Object.keys(fields).length) msg += ' ' + JSON.stringify(fields).slice(0, 600);
        return msg.trim();
    }
}

class PocketBase {
    constructor({ url, email, password }) {
        if (!url) throw new Error('PB_URL is not set');
        this.url = String(url).replace(/\/+$/, '');
        this.email = email;
        this.password = password;
        this.token = '';
        this.batchEnabled = true;
    }

    async auth() {
        if (!this.email || !this.password) throw new Error('PB_SUPERUSER_EMAIL / PB_SUPERUSER_PASSWORD are not set');
        const res = await this.req('POST', '/api/collections/_superusers/auth-with-password', {
            body: { identity: this.email, password: this.password },
            auth: false
        });
        this.token = res.token;
        return res;
    }

    async req(method, path, { body, query, auth = true, timeoutMs = 120000, retries = 3 } = {}) {
        let url = this.url + path;
        if (query) {
            const qs = new URLSearchParams();
            for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) qs.set(k, String(v));
            const s = qs.toString();
            if (s) url += (url.includes('?') ? '&' : '?') + s;
        }
        let reauthed = false;
        for (let attempt = 0; ; attempt++) {
            const headers = { Accept: 'application/json' };
            if (body !== undefined) headers['Content-Type'] = 'application/json';
            if (auth && this.token) headers.Authorization = this.token;
            let res;
            try {
                res = await fetch(url, {
                    method,
                    headers,
                    body: body !== undefined ? JSON.stringify(body) : undefined,
                    signal: AbortSignal.timeout(timeoutMs)
                });
            } catch (err) {
                if (attempt < retries) {
                    await sleep(1000 * Math.pow(3, attempt));
                    continue;
                }
                throw new Error(`PocketBase ${method} ${path} failed: ${err.message}`);
            }
            const text = await res.text();
            let data = null;
            if (text) {
                try {
                    data = JSON.parse(text);
                } catch (_) {
                    data = text;
                }
            }
            if (res.ok) return data;
            if (res.status === 401 && auth && !reauthed && this.email) {
                reauthed = true;
                await this.auth();
                continue;
            }
            if (res.status >= 500 && attempt < retries) {
                await sleep(1000 * Math.pow(3, attempt));
                continue;
            }
            throw new PbError(res.status, data, `PocketBase ${method} ${path.split('?')[0]}`);
        }
    }

    async health() {
        return this.req('GET', '/api/health', { auth: false, retries: 1, timeoutMs: 10000 });
    }

    async getCollection(nameOrId) {
        try {
            return await this.req('GET', '/api/collections/' + encodeURIComponent(nameOrId));
        } catch (err) {
            if (err.status === 404) return null;
            throw err;
        }
    }

    createCollection(def) {
        return this.req('POST', '/api/collections', { body: def });
    }

    updateCollection(nameOrId, patch) {
        return this.req('PATCH', '/api/collections/' + encodeURIComponent(nameOrId), { body: patch });
    }

    listRecords(collection, query) {
        return this.req('GET', `/api/collections/${encodeURIComponent(collection)}/records`, { query });
    }

    getRecord(collection, id) {
        return this.req('GET', `/api/collections/${encodeURIComponent(collection)}/records/${encodeURIComponent(id)}`);
    }

    createRecord(collection, body) {
        return this.req('POST', `/api/collections/${encodeURIComponent(collection)}/records`, { body });
    }

    updateRecord(collection, id, body) {
        return this.req('PATCH', `/api/collections/${encodeURIComponent(collection)}/records/${encodeURIComponent(id)}`, { body });
    }

    deleteRecord(collection, id) {
        return this.req('DELETE', `/api/collections/${encodeURIComponent(collection)}/records/${encodeURIComponent(id)}`);
    }

    /** Update the record with this id, or create it with this id if it does not exist yet. */
    async upsertRecord(collection, id, body) {
        try {
            return await this.updateRecord(collection, id, body);
        } catch (err) {
            if (err.status !== 404) throw err;
            return this.createRecord(collection, Object.assign({ id }, body));
        }
    }

    /**
     * Every record of a collection, a page at a time, in id order (keyset paging: no OFFSET scans).
     * Yields arrays of records with only `fields`.
     */
    async *pages(collection, { fields = 'id', filter = '', perPage = 1000 } = {}) {
        let last = '';
        for (;;) {
            const parts = [];
            if (filter) parts.push('(' + filter + ')');
            if (last) parts.push(`id > "${last}"`);
            const res = await this.listRecords(collection, {
                page: 1,
                perPage,
                skipTotal: 1,
                sort: 'id',
                fields,
                filter: parts.join(' && ') || undefined
            });
            const items = (res && res.items) || [];
            if (!items.length) return;
            yield items;
            if (items.length < perPage) return;
            last = items[items.length - 1].id;
        }
    }

    /**
     * Run requests [{method, url, body}] in one transaction. Falls back to one request at a time
     * when the batch API is disabled in the PocketBase settings.
     */
    async batch(requests) {
        if (!requests.length) return [];
        if (this.batchEnabled) {
            try {
                return await this.req('POST', '/api/batch', { body: { requests }, timeoutMs: 300000 });
            } catch (err) {
                if (err.status !== 403) throw err;
                this.batchEnabled = false;
            }
        }
        const out = [];
        for (const r of requests) {
            const body = await this.req(r.method, r.url, { body: r.method === 'DELETE' ? undefined : r.body });
            out.push({ status: 200, body });
        }
        return out;
    }
}

module.exports = { PocketBase, PbError };
