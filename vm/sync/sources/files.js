'use strict';
// Data files in the repo that the app reads: data/costcenter.json (served to the browser) and
// data/structure.csv (estimate structures, server-only). They change only with a deploy, so the
// version is the sha1 of the file and an unchanged file costs one small read.

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const { sha1 } = require('../lib/util');

const REPO = path.resolve(__dirname, '..', '..', '..');
const GITHUB = 'https://github.com/smartlinemanapp/mzo-reports/blob/develop/';

async function streamText(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    return Buffer.concat(chunks).toString('utf8'); // small repo file
}

function fileVersion(file) {
    return async () => 'sha1:' + sha1(fs.readFileSync(path.join(REPO, file)));
}

async function sources() {
    return [
        {
            key: 'costcenter',
            label: 'Cost center map',
            group: 'Vendor advances',
            pages: ['capex_all.html', 'advance_onm.html', 'admin_users.html'],
            sourceType: 'json_file',
            sourceRef: { file: 'data/costcenter.json', cacheKey: 'CACHE_COSTCENTER' },
            sourceUrl: GITHUB + 'data/costcenter.json',
            schedule: 'daily',
            primaryKey: ['Cost Cen_Code'],
            notes: 'Repo file; changes only with a deploy.',
            dataHubKeys: ['CACHE_COSTCENTER'],
            urls: ['/data/costcenter.json'],
            sensitive: false,
            version: fileVersion('data/costcenter.json'),
            async raw() {
                return { contentType: 'application/json', stream: fs.createReadStream(path.join(REPO, 'data/costcenter.json')) };
            },
            async *rows(ctx) {
                const text = ctx && ctx.input ? await streamText(ctx.input) : fs.readFileSync(path.join(REPO, 'data/costcenter.json'), 'utf8');
                const data = JSON.parse(text);
                const list = Array.isArray(data) ? data : Object.entries(data).map(([k, v]) => Object.assign({ key: k }, v));
                for (const row of list) yield row;
            }
        },
        {
            key: 'structure',
            label: 'Estimate structures',
            group: 'Administration',
            pages: ['admin.html'],
            sourceType: 'other', // a CSV file in the repo
            sourceRef: { file: 'data/structure.csv' },
            sourceUrl: GITHUB + 'data/structure.csv',
            schedule: 'daily',
            primaryKey: ['id'],
            notes: 'Repo file (server-only); admin.html edits it locally, production changes only with a deploy.',
            dataHubKeys: [],
            urls: [],
            sensitive: false,
            version: fileVersion('data/structure.csv'),
            async raw() {
                return { contentType: 'text/csv', stream: fs.createReadStream(path.join(REPO, 'data/structure.csv')) };
            },
            async *rows(ctx) {
                const input = ctx && ctx.input ? ctx.input : fs.createReadStream(path.join(REPO, 'data/structure.csv'));
                const parser = input.pipe(parse({ bom: true, relax_column_count: true }));
                for await (const record of parser) yield record;
            }
        }
    ];
}

module.exports = { sources };
