#!/usr/bin/env node
/* Cold-load timing over several parity runs per mode (medians, so one slow Google export does not decide).
 *
 *   node scripts/qa/timing.js --a original-merged,original-merged-2 --b mirror-local,mirror-local-2 [--name timing-summary] [--phase cold|warm]
 *
 * Writes <out>/<name>.md (default timing-<firstA>-<firstB>.md).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
function defaultOut() {
  let d = REPO;
  for (let i = 0; i < 4; i++) { d = path.dirname(d); if (fs.existsSync(path.join(d, 'agent-progress'))) return path.join(d, 'agent-progress', 'parity'); }
  return path.join(REPO, 'qa-out');
}
const args = {};
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args[process.argv[i].slice(2)] = process.argv[++i];
if (!args.a || !args.b) { console.error('usage: node scripts/qa/timing.js --a <labels> --b <labels> [--name file] [--phase cold|warm]'); process.exit(2); }
const root = args.out || process.env.QA_OUT || defaultOut();
const A = args.a.split(','), B = args.b.split(','), phase = args.phase || 'cold';
const KEY = ['home', 'nsc', 'loss', 'stock', 'meter_utilization', 'defective_meter', 'disconnection', 'performance_index'];

function t(label, key) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(root, label, key + '.json'), 'utf8'));
    const l = r.desktop && r.desktop[phase];
    if (!l || !l.timing || l.timing.incomplete) return null;
    return l.timing.finalDataMs;
  } catch (_) { return null; }
}
const med = (a) => { a = a.filter((x) => x != null).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2); };
const f = (x) => (x == null ? '–' : x >= 10000 ? (x / 1000).toFixed(1) + ' s' : x + ' ms');
const rg = (a) => { a = a.filter((x) => x != null); return a.length ? f(Math.min(...a)) + ' – ' + f(Math.max(...a)) : '–'; };
const started = (l) => { try { return JSON.parse(fs.readFileSync(path.join(root, l, '_run.json'), 'utf8')).startedAt.slice(11, 16) + ' UTC'; } catch (_) { return '?'; } };

let keys = [];
try { keys = JSON.parse(fs.readFileSync(path.join(root, B[0], '_run.json'), 'utf8')).pages.map((p) => p.key); } catch (_) {}
const rows = keys.map((k) => { const a = A.map((l) => t(l, k)), b = B.map((l) => t(l, k)); return { k, a, b, ma: med(a), mb: med(b) }; });
const L = [`# ${phase === 'cold' ? 'Cold' : 'Warm'}-load timing: ${A.join(' + ')} vs ${B.join(' + ')}`, ''];
L.push(`Time from navigation to the final numbers on screen, desktop 1280, ${phase === 'cold' ? 'fresh browser profile' : 'second visit in the same profile'}. Medians over the runs; range is min – max. Runs: ${A.concat(B).map((l) => l + ' (' + started(l) + ')').join(', ')}.`, '');
const table = (list) => {
  L.push(`| Page | A median | A range | B median | B range | Speed-up |`, '|---|---|---|---|---|---|');
  list.forEach((r) => L.push(`| ${r.k} | ${f(r.ma)} | ${rg(r.a)} | ${f(r.mb)} | ${rg(r.b)} | ${r.ma && r.mb ? (r.ma / r.mb).toFixed(1) + '×' : '–'} |`));
};
L.push('## Key pages', '');
table(KEY.map((k) => rows.find((r) => r.k === k)).filter(Boolean));
L.push('', '## All pages', '');
table(rows);
const both = rows.filter((r) => r.ma != null && r.mb != null);
L.push('', `Median over ${both.length} pages: A ${f(med(both.map((r) => r.ma)))}, B ${f(med(both.map((r) => r.mb)))}. Pages faster in B by 2× or more: ${both.filter((r) => r.ma / r.mb >= 2).length}; slower in B by 1.5× or more: ${both.filter((r) => r.mb / r.ma >= 1.5).map((r) => r.k).join(', ') || 'none'}.`);
const out = path.join(root, (args.name || `timing-${A[0]}-${B[0]}`) + '.md');
fs.writeFileSync(out, L.join('\n') + '\n');
console.log('[timing] ' + L[L.length - 1] + ' → ' + out);
