'use strict';
// Dataset score, 0–100. Each open issue takes off a base amount for its severity plus a part
// that grows with the share of rows it touches:
//
//   error  10 + 20·share      warn  3 + 7·share      info  0.5 + 0.5·share
//
// share = min(1, count / rows) for row-level findings (the same check in several columns: worst one in
// full, the rest at a quarter); issues that concern the whole dataset
// (headers, freshness, cross-source totals) count as share 1. The score never goes below 0.
// One dataset with a single blocking error therefore scores ≤ 90, a stale report ≤ 70 (error) or
// ≤ 90 (warn), and ten small warnings ≈ 70.

const WEIGHTS = { error: [10, 20], warn: [3, 7], info: [0.5, 0.5] };
const WHOLE = /^(header\.|freshness\.|cross\.(count|total|report_date|snapshot))/;

function penalty(issue, rows) {
    const w = WEIGHTS[issue.severity] || WEIGHTS.info;
    let share = 1;
    if (!WHOLE.test(issue.check) && rows > 0) share = Math.min(1, (Number(issue.count) || 0) / rows);
    return w[0] + w[1] * share;
}

/**
 * One root cause often shows up in many columns (an export that writes dates two ways). Per check
 * id the worst issue counts in full and the others at a quarter, so a dataset is not driven to 0
 * by one habit of the source system.
 */
function score(issues, rows) {
    const byCheck = new Map();
    for (const i of issues) {
        if (i.status && i.status !== 'open') continue;
        const list = byCheck.get(i.check) || [];
        list.push(penalty(i, rows));
        byCheck.set(i.check, list);
    }
    let p = 0;
    for (const list of byCheck.values()) {
        list.sort((a, b) => b - a);
        p += list[0] + 0.25 * list.slice(1).reduce((s, x) => s + x, 0);
    }
    return Math.max(0, Math.round(100 - p));
}

module.exports = { score, penalty, WEIGHTS };
