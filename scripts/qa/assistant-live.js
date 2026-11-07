#!/usr/bin/env node
/* Ask: tool-call accuracy and latency of the configured model, with SYNTHETIC tool results only.
 *
 *   node scripts/qa/assistant-live.js [--env <path/to/.env>] [--only 1,4,7]
 *
 * Uses the same provider layer as the server (lib/assistant/), so the env settings are the same
 * (ASSISTANT_PROVIDER, GOEDEL_API_KEY / GODEL_API_KEY, ANTHROPIC_API_KEY, ASSISTANT_MODEL, ...);
 * --env reads them from a file (values are never printed). For each typical question it checks the
 * first tool call (tool, report, view, office, group_by), then answers every tool call with made-up
 * offices and numbers (no report data leaves the machine, which matters on a free Gödel key: its
 * prompts are retained) and checks that every number in the final answer came from those results.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { createAssistant } = require(path.join(ROOT, 'lib', 'assistant', 'index.js'));
const CATALOG = require(path.join(ROOT, 'lib', 'assistant_catalog.js'));

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; }
function readEnvFile(file) {
    const out = {};
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
        if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
    return out;
}

// [question, expectation]. office: { level: name } that must appear on the first matching call.
const CASES = [
    ['What needs attention today?', { tool: 'get_briefing' }],
    ['Which division has the most NSC pending over 30 days?', { tool: 'query_report', report: 'nsc', view: 'over_30_days', group_by: 'division' }],
    ['How many new connections are pending in Fulbari CCC?', { tool: 'query_report', report: 'nsc', office: { ccc: 'Fulbari' } }],
    ['Pole cases in Raiganj region, by division', { tool: 'query_report', report: 'nsc', view: 'pole_cases', office: { region: 'Uttar Dinajpur' }, group_by: 'division' }],
    ['How many NSC are pending in Uttar Dinajpur?', { tool: 'query_report', report: 'nsc', office: { region: 'Uttar Dinajpur' } }],
    ['Load extensions waiting over a year, by division', { tool: 'query_report', report: 'load_extension', view: 'over_1_year', group_by: 'division' }],
    ['Show Uttar Dinajpur load extensions waiting over a year', { tool: 'open_report', report: 'load_extension', view: 'over_1_year', office: { region: 'Uttar Dinajpur' } }],
    ['Solar applications by region', { tool: 'query_report', report: 'solar', group_by: 'region' }],
    ['PM Surya Ghar solar applications by division', { tool: 'query_report', report: 'solar', view: 'pm_surya_ghar', group_by: 'division' }],
    ['Solar meter issues in Malda division', { tool: 'query_report', report: 'solar', view: 'meter_issue', office: { division: 'Malda' } }],
    ['How is AT&C loss this year compared with last March?', { tool: 'query_report', report: 'loss' }],
    ['AT&C loss in Malda region by division', { tool: 'query_report', report: 'loss', office: { region: 'Malda' }, group_by: 'division' }],
    ['AT&C loss by region in March 2026', { tool: 'query_report', report: 'loss', month: '2026-03', group_by: 'region' }],
    ['Open NSC over 30 days for Gazole', { tool: 'open_report', report: 'nsc', view: 'over_30_days', office: { division: 'Gazole' } }],
    ['What does AT&C loss mean?', { tool: null }]
];

// Made-up results: offices Alpha / Beta / Gamma, numbers that cannot be real.
// Totals add up (zone 2,700 = 1,500 + 900 + 300; one office 270 = 150 + 90 + 30) so sums stay traceable.
const SYN_NUMBERS = ['2700', '1500', '900', '300', '270', '150', '90', '30', '17', '9', '8', '4', '21.4', '18.2', '25.7', '3.1'];
function synthetic(use) {
    const i = use.input || {};
    if (use.name === 'get_briefing') return { generated: 'synthetic test', items: [{ priority: 'critical', item: 'Test item A', value: '17', top_divisions: ['Alpha 9', 'Beta 8'] }, { priority: 'watch', item: 'Test item B', value: '4', top_divisions: [] }] };
    if (use.name === 'open_report') return { shown_to_user: true, report: 'Test report', link: '/test.html?synthetic=1' };
    if (use.name === 'query_report') {
        const office = i.ccc || i.division || i.region || 'Test Zone';
        if (i.report === 'loss') {
            const out = { report: 'Losses (synthetic test data)', office, month: i.month ? i.month : 'Sep 2026', totals: { atc_loss_pct: 21.4, td_loss_pct: 18.2 } };
            if (i.group_by && i.group_by !== 'none') out.by_office = [{ office: 'Alpha', atc_loss_pct: 25.7 }, { office: 'Beta', atc_loss_pct: 21.4 }, { office: 'Gamma', atc_loss_pct: 3.1 }];
            return out;
        }
        const f = i.ccc || i.division || i.region ? 0.1 : 1;
        const out = { report: String(i.report) + ' (synthetic test data)', office, view: i.view || 'all', totals: { count: 2700 * f } };
        if (i.group_by && i.group_by !== 'none') out.by_office = [{ office: 'Alpha', count: 1500 * f }, { office: 'Beta', count: 900 * f }, { office: 'Gamma', count: 300 * f }];
        return out;
    }
    return 'Unknown tool';
}

// as assistant.html clean(): "Malda division" is read as "Malda"
function norm(s) { return String(s || '').replace(/\s+(region|division|div\.?|ccc)$/i, '').trim().toLowerCase(); }
function check(exp, uses) {
    if (exp.tool === null) return uses.length ? ['called ' + uses.map((u) => u.name).join(', ') + ' (expected no tool)'] : [];
    const cands = uses.filter((u) => u.name === exp.tool && (!exp.report || u.input.report === exp.report));
    if (!cands.length) return [`expected ${exp.tool}${exp.report ? ' ' + exp.report : ''}, got ${uses.map((u) => u.name + ' ' + JSON.stringify(u.input)).join('; ') || 'no tool'}`];
    const best = cands.map((u) => {
        const bad = [];
        if (exp.view && u.input.view !== exp.view) bad.push(`view ${u.input.view || '-'} (expected ${exp.view})`);
        if (exp.group_by && u.input.group_by !== exp.group_by) bad.push(`group_by ${u.input.group_by || '-'} (expected ${exp.group_by})`);
        if (exp.month && u.input.month !== exp.month) bad.push(`month ${u.input.month || '-'} (expected ${exp.month})`);
        for (const [lvl, name] of Object.entries(exp.office || {})) if (norm(u.input[lvl]) !== norm(name)) bad.push(`${lvl} ${u.input[lvl] || '-'} (expected ${name})`);
        return bad;
    }).sort((a, b) => a.length - b.length)[0];
    return best;
}
function untraced(text) {
    const nums = (String(text).replace(/(\d),(?=\d)/g, '$1').match(/\d+(?:\.\d+)?/g) || []);
    return nums.filter((n) => !SYN_NUMBERS.includes(n) && !/^(19|20)\d\d$/.test(n) && !(Number(n) <= 31 && !n.includes('.')));
}

(async () => {
    const env = Object.assign({}, process.env, arg('env') ? readEnvFile(arg('env')) : {});
    const lines = [];
    const asst = createAssistant({ env, catalog: CATALOG, log: (m) => lines.push(m) });
    if (!asst.configured) { console.error('No assistant key configured.'); process.exit(2); }
    const key = String(env.GOEDEL_API_KEY || env.GODEL_API_KEY || '');
    console.log(`provider ${asst.provider}, model ${asst.model}${asst.provider === 'goedel' ? ', key tier ' + (key.startsWith('sk-gm-paid-') ? 'paid' : 'free (prompts retained: synthetic data only)') : ''}`);
    const only = arg('only') ? arg('only').split(',').map(Number) : null;
    const userNote = 'Today is 7 November 2026. The signed-in user is Test User (administrator). Office scope: whole zone.';
    let right = 0, total = 0, hallucinated = 0;
    const lat = [];
    for (let qi = 0; qi < CASES.length; qi++) {
        if (only && !only.includes(qi + 1)) continue;
        const [q, exp] = CASES[qi];
        total++;
        const messages = [{ role: 'user', content: q }];
        let first = null, final = '', rounds = 0, err = null, opened = false;
        const t0 = Date.now();
        const callMs = [];
        try {
            for (;;) {
                const c0 = Date.now();
                const r = await asst.complete({ userNote, messages });
                callMs.push(Date.now() - c0);
                messages.push({ role: 'assistant', content: r.content });
                const uses = r.content.filter((b) => b.type === 'tool_use');
                if (!first) first = uses;
                if (uses.some((u) => u.name === 'open_report')) opened = true;
                final += r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
                if (r.stop_reason !== 'tool_use' || !uses.length || ++rounds > 4) break;
                messages.push({ role: 'user', content: uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(synthetic(u)) })) });
            }
        } catch (e) { err = e; }
        const ms = Date.now() - t0;
        lat.push(...callMs);
        const problems = err ? ['error ' + err.kind + ': ' + err.message] : check(exp, first || []);
        const extra = err ? [] : untraced(final);
        if (!err && !opened && /\bthe button\b/i.test(final)) problems.push('mentions a button without calling open_report');
        if (!problems.length) right++;
        if (extra.length) hallucinated++;
        console.log(`\nQ${qi + 1} ${problems.length ? 'WRONG' : 'right'} ${ms} ms (${callMs.join(' + ')} ms) — ${q}`);
        console.log('   first call: ' + ((first || []).map((u) => u.name + ' ' + JSON.stringify(u.input)).join('; ') || 'no tool'));
        if (problems.length) console.log('   problems: ' + problems.join('; '));
        if (extra.length) console.log('   numbers not from a tool result: ' + extra.join(', '));
        console.log('   answer: ' + final.replace(/\s+/g, ' ').slice(0, 600));
    }
    lat.sort((a, b) => a - b);
    const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
    console.log(`\nTool choice right: ${right}/${total}. Answers with numbers not from a tool result: ${hallucinated}/${total}.`);
    console.log(`Per-call latency over ${lat.length} calls: median ${pct(0.5)} ms, p90 ${pct(0.9)} ms, max ${lat[lat.length - 1]} ms.`);
    const policies = [...new Set(lines.map((l) => (/data-policy=(\S+)/.exec(l) || [])[1]).filter(Boolean))];
    if (policies.length) console.log('X-Data-Policy: ' + policies.join(', '));
    const usage = lines.map((l) => /in=(\d+) out=(\d+)(?: cached=(\d+))?(?: reasoning=(\d+))?/.exec(l)).filter(Boolean);
    if (usage.length) {
        const sum = (i) => usage.reduce((s, m) => s + Number(m[i] || 0), 0);
        console.log(`Tokens: input ${sum(1)} (cached ${sum(3)}), output ${sum(2)} (reasoning ${sum(4)}), over ${usage.length} calls.`);
    }
    const errs = lines.filter((l) => /failed|retrying|malformed/.test(l));
    if (errs.length) console.log('Provider notes:\n  ' + errs.join('\n  '));
})().catch((e) => { console.error(e && e.message); process.exit(1); });
