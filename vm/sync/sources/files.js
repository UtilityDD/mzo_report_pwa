'use strict';
// Data files in the repo that the app reads: data/costcenter.json (served to the browser) and
// data/structure.csv (estimate structures, server-only). The version is the sha1 of the file, so an
// unchanged file costs one small read.
// Structures edited on the VM (Admin > Structure) are kept in the server's data folder, outside the
// releases, as <MZO_FILES_DIR>/structure.csv; once that copy exists it is the one read here (the app
// reads it first too), so a deploy no longer brings back the repo's copy.

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

// Files the app writes in its data folder (MZO_FILES_DIR on the VM, the git-ignored data/ elsewhere):
// the edited structures and the uploaded Safety Inspection and CMO grievance reports. Other repo files
// are always the repo's.
const DATA_FOLDER_FILES = new Set(['structure.csv', 'safety_inspection.csv', 'cmo_grievances.csv']);
// The published sheet cmo_grievances was copied from until uploads moved to the VM: old cached pages may still fetch it.
const CMO_LEGACY_SHEET = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vS7GVh5HflVhouhVfFOEN2RuA1kCBedmD4Q0CJP02K61DAtWuo3P8XIS8CO7ocZQuJ20uCJBa9qsgZ6/pub?gid=1066071765&single=true&output=csv';

/** The file to read: the server data folder's copy of an editable or uploaded file when there is one, else the repo's. */
function resolve(file) {
    const basename = path.basename(file);
    if (DATA_FOLDER_FILES.has(basename)) {
        const dir = process.env.MZO_FILES_DIR || path.join(REPO, 'data');
        const own = path.join(dir, basename);
        if (fs.existsSync(own)) return own;
    }
    return path.join(REPO, file);
}

function fileVersion(file) {
    return async () => 'sha1:' + sha1(fs.readFileSync(resolve(file)));
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
            notes: 'Repo file (server-only); edits made in Admin on the VM are kept in the server data folder (MZO_FILES_DIR/structure.csv) and win over the repo copy.',
            dataHubKeys: [],
            urls: [],
            sensitive: false,
            version: fileVersion('data/structure.csv'),
            async raw() {
                return { contentType: 'text/csv', stream: fs.createReadStream(resolve('data/structure.csv')) };
            },
            async *rows(ctx) {
                const input = ctx && ctx.input ? ctx.input : fs.createReadStream(resolve('data/structure.csv'));
                const parser = input.pipe(parse({ bom: true, relax_column_count: true }));
                for await (const record of parser) yield record;
            }
        },
        {
            key: 'safety_inspection',
            label: 'Safety app inspections',
            group: 'Important',
            pages: ['safety_inspection.html'],
            sourceType: 'csv_file',
            sourceRef: { file: 'safety_inspection.csv', cacheKey: 'CACHE_SAFETY_v2' },
            sourceUrl: '/api/safety/dataset',
            schedule: 'daily',
            primaryKey: ['Inspection ID', 'Site ID'],
            notes: 'Stored directly on VM; synced via admin upload or Chrome bookmarklet.',
            // Until the first upload there is no file: skip (the last snapshot, if any, stays).
            skip: fs.existsSync(resolve('safety_inspection.csv')) ? undefined : 'no Safety report uploaded yet (POST /api/safety/upload)',
            dataHubKeys: ['CACHE_SAFETY_v2'],
            urls: ['/api/safety/dataset'],
            sensitive: false,
            version: fileVersion('safety_inspection.csv'),
            async raw() {
                return { contentType: 'text/csv; charset=utf-8', stream: fs.createReadStream(resolve('safety_inspection.csv')) };
            },
            async *rows(ctx) {
                const input = ctx && ctx.input ? ctx.input : fs.createReadStream(resolve('safety_inspection.csv'));
                const parser = input.pipe(parse({ bom: true, relax_column_count: true, columns: true }));
                for await (const record of parser) yield record;
            }
        },
        {
            key: 'cmo_grievances',
            label: 'CMO grievances',
            group: 'Important',
            pages: ['cmo.html', 'sheet_links.html'],
            sourceType: 'csv_file',
            sourceRef: { file: 'cmo_grievances.csv', cacheKey: 'CACHE_CMO' },
            sourceUrl: '/cmo.html',
            schedule: 'hourly', // the upload refreshes it at once (write-through); this is only a safety net
            primaryKey: null,   // no grievance ID: rows are keyed by content
            holdBack: false,    // a much shorter list was confirmed by the uploader (lib/cmo_upload.js warns at 30% fewer rows)
            notes: 'Uploaded on the VM from the CMO portal export (cmo.html > Upload; docs/cmo-upload.md). Until the first upload the last copy of the old Google sheet stays served.',
            // Until the first upload there is no file: skip, so the snapshot copied from the Google sheet stays served.
            skip: fs.existsSync(resolve('cmo_grievances.csv')) ? undefined : 'no CMO export uploaded yet (cmo.html > Upload); the last Google copy stays served',
            dataHubKeys: ['CACHE_CMO'],
            urls: ['/api/cmo/dataset', CMO_LEGACY_SHEET],
            sensitive: false,
            version: fileVersion('cmo_grievances.csv'),
            async raw() {
                return { contentType: 'text/csv; charset=utf-8', stream: fs.createReadStream(resolve('cmo_grievances.csv')) };
            },
            async *rows(ctx) {
                const input = ctx && ctx.input ? ctx.input : fs.createReadStream(resolve('cmo_grievances.csv'));
                const parser = input.pipe(parse({ bom: true, relax_column_count: true }));
                for await (const record of parser) yield record;
            }
        }
    ];
}

module.exports = { sources, resolve };
