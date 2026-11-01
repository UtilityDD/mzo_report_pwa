'use strict';
// When is a source due? frequent = every 5 min, hourly = every hour, daily = once per India
// calendar day after 02:00 IST (big dumps sync at night). A source whose last attempt failed is
// retried after at most an hour. The systemd timer ticks every 5 min; a little slack (a fifth of
// the interval, at most 3 min) keeps a late tick from skipping a whole interval.

const MIN = 60000;
const INTERVAL_MS = { frequent: 5 * MIN, hourly: 60 * MIN, daily: 24 * 60 * MIN };
const slackFor = (interval) => Math.min(3 * MIN, interval / 5);
const IST_MS = 330 * MIN;
const DAILY_HOUR_IST = 2;

function parsePbDate(s) {
    if (!s) return NaN;
    return Date.parse(String(s).replace(' ', 'T'));
}

/** @returns {{due: boolean, reason: string}} */
function isDue(ds, schedule, now = Date.now()) {
    const interval = INTERVAL_MS[schedule] || INTERVAL_MS.hourly;
    if (!ds || !ds.last_checked_at) return { due: true, reason: 'never checked' };
    const last = parsePbDate(ds.last_checked_at);
    if (!Number.isFinite(last)) return { due: true, reason: 'no valid last check' };
    const elapsed = now - last;
    const retry = Math.min(interval, 60 * MIN);
    if (ds.last_status === 'error' && elapsed >= retry - slackFor(retry)) {
        return { due: true, reason: 'retry after error' };
    }
    if (schedule === 'daily') {
        const dayNow = Math.floor((now + IST_MS) / (24 * 60 * MIN));
        const dayLast = Math.floor((last + IST_MS) / (24 * 60 * MIN));
        const hourNow = ((now + IST_MS) % (24 * 60 * MIN)) / (60 * MIN);
        if (dayNow > dayLast && hourNow >= DAILY_HOUR_IST) return { due: true, reason: 'daily run' };
        if (elapsed >= 26 * 60 * MIN) return { due: true, reason: 'over 26 h since last check' };
        return { due: false, reason: 'checked today' };
    }
    if (elapsed >= interval - slackFor(interval)) return { due: true, reason: `${schedule} interval passed` };
    return { due: false, reason: `checked ${Math.round(elapsed / MIN)} min ago` };
}

module.exports = { INTERVAL_MS, isDue, parsePbDate };
