/**
 * Post-login briefing: pending docket calls older than 24 hours,
 * filtered by global office preferences (mzoPresetsHub).
 */
(function (window) {
    'use strict';

    const SESSION_KEY = 'mzo_show_docket_briefing';
    const SNOOZE_KEY = 'mzo_docket_briefing_snooze_until';
    const SNOOZE_MS = 6 * 60 * 60 * 1000; // 6 hours

    // Priority technical calls only (matches operational focus after login)
    const PRIORITY_PROB_TYPES = [
        'Conductor snap',
        'Dis. transformer problem',
        'Breakage or uprooting of pole',
        'No power'
    ];

    const PRIORITY_LABELS = {
        'Conductor snap': 'Conductor snap',
        'Dis. transformer problem': 'Dist. transformer problem',
        'Breakage or uprooting of pole': 'Breakage / uprooting of pole',
        'No power': 'No power'
    };

    const REGION_DATA = {
        'MALDA REGION': {
            code: '6610000',
            divisions: {
                'MALDA DIVISION': {
                    code: '6611000',
                    cccs: {
                        'MANIKCHAK CCC': '6611101',
                        'GOLAPGANJ CCC': '6611102',
                        'BAISHNABNAGAR CCC': '6611103',
                        'KALIACHAK CCC': '6611104',
                        'MOTHABARI CCC': '6611105',
                        'SUJAPUR CCC': '6611106',
                        'RATHBARI CCC': '6611107',
                        'FULBARI CCC': '6611108',
                        'MOKDUMPUR CCC': '6611109'
                    }
                },
                'CHANCHAL DIVISION': {
                    code: '6612000',
                    cccs: {
                        'BHALUKA CCC': '6612101',
                        'SAMSI CCC': '6612102',
                        'PARANPUR CCC': '6612103',
                        'CHANCHAL CCC': '6612104',
                        'MALATIPUR CCC': '6612105',
                        'HARISHCHANDRAPUR CCC': '6612106',
                        'KUSHIDA CCC': '6612107'
                    }
                },
                'GAZOLE DIVISION': {
                    code: '6613000',
                    cccs: {
                        'GAZOL CCC': '6613101',
                        'AIHO. CCC': '6613102',
                        'PANDUA CCC': '6613103',
                        'BAMONGOLA CCC': '6613104',
                        'OLD MALDA CCC': '6613105'
                    }
                }
            }
        },
        'UTTAR DINAJPUR REGION': {
            code: '6620000',
            divisions: {
                'RAIGANJ DIVISION': {
                    code: '6621000',
                    cccs: {
                        'ITAHAR CCC': '6621101',
                        'HEMTABAD CCC': '6621102',
                        'KALIYAGANJ CCC': '6621103',
                        'RAIGANJ CCC': '6621104',
                        'BIRNAGAR CCC': '6621105',
                        'KARANDIGHI CCC': '6621106'
                    }
                },
                'ISLAMPUR DIVISION': {
                    code: '6622000',
                    cccs: {
                        'ISLAMPUR CCC': '6622101',
                        'CHOPRA CCC': '6622102',
                        'DALKHOLA CCC': '6622103',
                        'GOALPOKHER CCC': '6622104',
                        'KANKI CCC': '6622105'
                    }
                }
            }
        },
        'DAKSHIN DINAJPUR REGION': {
            code: '6630000',
            divisions: {
                'BALURGHAT DIVISION': {
                    code: '6631000',
                    cccs: {
                        'BALURGHAT CCC': '6631101',
                        'TAPAN CCC': '6631102',
                        'KUMARGANJ CCC': '6631103',
                        'HILI CCC': '6631104',
                        'PATIRAM CCC': '6631105'
                    }
                },
                'BUNIADPUR DIVISION': {
                    code: '6632000',
                    cccs: {
                        'BUNIADPUR CCC': '6632101',
                        'KUSMANDI CCC': '6632102',
                        'HARIRAMPUR CCC': '6632103',
                        'GANGARAMPUR CCC': '6632104'
                    }
                }
            }
        }
    };

    function parseDateString(dateString) {
        if (!dateString) return new Date(NaN);
        const parts = dateString.trim().split(' ');
        const datePart = parts[0] || '';
        const timePart = parts[1] || '00:00:00';
        const [day, month, year] = datePart.split('/').map(Number);
        const [hours, minutes, seconds] = timePart.split(/[.:]/).map(Number);
        return new Date(year, (month || 1) - 1, day || 1, hours || 0, minutes || 0, seconds || 0);
    }

    function normalizeKey(value) {
        return String(value || '')
            .toLowerCase()
            .replace(/region|division|div|ccc/g, '')
            .replace(/[^a-z0-9]/g, '');
    }

    function fuzzyMatch(saved, candidate) {
        if (!saved || !candidate || saved === 'all' || candidate === 'all') return false;
        const s = normalizeKey(saved);
        const o = normalizeKey(candidate);
        if (!s || !o) return false;
        if (s.includes('uttar') || s.includes('udinajpur')) {
            return o.includes('uttar') || o.includes('udinajpur');
        }
        if (s.includes('dakshin') || s.includes('ddinajpur')) {
            return o.includes('dakshin') || o.includes('ddinajpur');
        }
        return s.includes(o) || o.includes(s);
    }

    function resolveRegionKey(regionName) {
        if (!regionName || regionName === 'all') return null;
        for (const key of Object.keys(REGION_DATA)) {
            if (fuzzyMatch(regionName, key)) return key;
        }
        return null;
    }

    function resolveDivisionKey(regionKey, divisionName) {
        if (!regionKey || !divisionName || divisionName === 'all') return null;
        const divisions = REGION_DATA[regionKey].divisions;
        for (const key of Object.keys(divisions)) {
            if (fuzzyMatch(divisionName, key)) return key;
        }
        return null;
    }

    function findCccCode(cccValue) {
        if (!cccValue || cccValue === 'all') return null;
        if (/^\d+$/.test(String(cccValue))) return String(cccValue);
        for (const region of Object.values(REGION_DATA)) {
            for (const division of Object.values(region.divisions)) {
                for (const [name, code] of Object.entries(division.cccs)) {
                    if (fuzzyMatch(cccValue, name) || String(code) === String(cccValue)) {
                        return code;
                    }
                }
            }
        }
        return null;
    }

    function normalizeRow(row) {
        const out = {};
        Object.keys(row || {}).forEach((key) => {
            const cleanKey = String(key).replace(/^\uFEFF/, '').trim();
            const val = row[key];
            out[cleanKey] = typeof val === 'string' ? val.trim() : val;
        });
        return out;
    }

    function filterPriority(data) {
        return data.filter((d) => PRIORITY_PROB_TYPES.includes(String(d.prob_type || '').trim()));
    }

    function filterByJurisdiction(data, pref) {
        if (!pref) return data;
        let filtered = data;

        const regionKey = resolveRegionKey(pref.region);
        const divisionKey = resolveDivisionKey(regionKey, pref.division);
        const cccCode = findCccCode(pref.ccc);

        if (regionKey) {
            const regionCodePrefix = REGION_DATA[regionKey].code.substring(0, 3);
            filtered = filtered.filter((d) => d.Divn_code && String(d.Divn_code).startsWith(regionCodePrefix));
        }

        if (divisionKey && regionKey) {
            const divisionCodeCsv = REGION_DATA[regionKey].divisions[divisionKey].code.substring(0, 4);
            filtered = filtered.filter((d) => String(d.Divn_code) === divisionCodeCsv);
        }

        if (cccCode) {
            filtered = filtered.filter((d) => String(d.ccc_code).trim() === String(cccCode));
        }

        return filtered;
    }

    function filterOlderThan24(data) {
        const now = new Date();
        return data.filter((d) => {
            const parsedDate = parseDateString(d.doc_crn_dt);
            if (isNaN(parsedDate.getTime())) return false;
            const diffHours = (now - parsedDate) / (1000 * 60 * 60);
            return diffHours >= 24;
        });
    }

    function hasOfficePrefs(pref) {
        return !!(
            pref &&
            ((pref.region && pref.region !== 'all') ||
                (pref.division && pref.division !== 'all') ||
                (pref.ccc && pref.ccc !== 'all'))
        );
    }

    function getJurisdictionLabel(pref) {
        if (!hasOfficePrefs(pref)) return 'All Offices (MZO)';
        const parts = [];
        if (pref.ccc && pref.ccc !== 'all') {
            parts.push(findCccName(pref.ccc) || pref.ccc);
        } else if (pref.division && pref.division !== 'all') {
            parts.push(pref.division);
        } else if (pref.region && pref.region !== 'all') {
            parts.push(pref.region);
        }
        return parts.join(' · ') || 'All Offices (MZO)';
    }

    function findCccName(cccValue) {
        const code = findCccCode(cccValue);
        if (!code) return null;
        for (const region of Object.values(REGION_DATA)) {
            for (const division of Object.values(region.divisions)) {
                for (const [name, cccCode] of Object.entries(division.cccs)) {
                    if (cccCode === code) return name;
                }
            }
        }
        return null;
    }

    function buildCccList() {
        const list = [];
        Object.entries(REGION_DATA).forEach(([region, regObj]) => {
            Object.entries(regObj.divisions).forEach(([division, divObj]) => {
                Object.entries(divObj.cccs).forEach(([name, code]) => {
                    list.push({ code, name, region, division });
                });
            });
        });
        return list;
    }

    function buildSummary(data) {
        const uniqueConIds = new Set(data.map((d) => d.con_id).filter(Boolean));
        const probCounts = {};
        let oldestHours = 0;

        data.forEach((d) => {
            if (d.prob_type) {
                probCounts[d.prob_type] = (probCounts[d.prob_type] || 0) + 1;
            }
            const dt = parseDateString(d.doc_crn_dt);
            if (!isNaN(dt.getTime())) {
                const hours = (new Date() - dt) / (1000 * 60 * 60);
                if (hours > oldestHours) oldestHours = hours;
            }
        });

        // Always show all 4 priority types (zero if none pending)
        const topTypes = PRIORITY_PROB_TYPES.map((type) => [type, probCounts[type] || 0]);

        return {
            total: data.length,
            uniqueConIds: uniqueConIds.size,
            topTypes,
            oldestHours
        };
    }

    function formatHours(hours) {
        if (!hours) return '—';
        if (hours < 48) return `${Math.round(hours)} hours`;
        const days = Math.floor(hours / 24);
        const rem = Math.round(hours % 24);
        return rem ? `${days}d ${rem}h` : `${days} days`;
    }

    function escapeHtml(text) {
        const el = document.createElement('div');
        el.textContent = text;
        return el.innerHTML;
    }

    function closeModal() {
        document.getElementById('mzoDocketBriefingModal')?.remove();
    }

    function isSnoozed() {
        try {
            const until = Number(localStorage.getItem(SNOOZE_KEY) || 0);
            if (!until) return false;
            if (Date.now() < until) return true;
            localStorage.removeItem(SNOOZE_KEY);
            return false;
        } catch (e) {
            return false;
        }
    }

    function snoozeFor6Hours() {
        try {
            localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
        } catch (e) {}
        closeModal();
    }

    function openOfficePrefs(onSaved) {
        closeModal();
        if (!window.mzoPresetsHub) return;
        window.mzoPresetsHub.showSetupModal(
            { showCCC: true, cccList: buildCccList() },
            () => {
                if (typeof onSaved === 'function') onSaved();
            }
        );
    }

    function openDocketDashboard() {
        closeModal();
        if (typeof window.openPage === 'function') {
            window.openPage('docket.html', 'Docket Calls', 'CACHE_DOCKET');
            return;
        }
        window.location.href = '/docket.html';
    }

    function showModal(summary, pref, needsPrefs) {
        closeModal();

        const jurisdiction = getJurisdictionLabel(pref);
        const countColor = summary.total > 0 ? '#dc2626' : '#059669';

        const prefsBanner = needsPrefs
            ? `<div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:10px;padding:12px 14px;margin-bottom:16px;font-size:12px;color:#92400e;line-height:1.45;">
                <i class="fas fa-map-marker-alt"></i> Showing <strong>all offices</strong>. Set your office preferences to focus on your jurisdiction.
               </div>`
            : '';

        const topHtml = PRIORITY_PROB_TYPES.map((type) => {
            const count = (summary.topTypes.find(([t]) => t === type) || [type, 0])[1];
            const countColor = count > 0 ? '#dc2626' : '#94a3b8';
            return `
                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:9px 0;border-bottom:1px solid #e2e8f0;font-size:13px;">
                    <span style="color:#334155;flex:1;line-height:1.35;">${escapeHtml(PRIORITY_LABELS[type] || type)}</span>
                    <strong style="color:${countColor};white-space:nowrap;">${count}</strong>
                </div>`;
        }).join('');

        const html = `
        <div id="mzoDocketBriefingModal" style="position:fixed;inset:0;background:rgba(15,23,42,0.72);z-index:100060;display:flex;align-items:center;justify-content:center;padding:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
            <div style="background:#ffffff;width:100%;max-width:480px;border-radius:18px;box-shadow:0 20px 50px rgba(0,0,0,0.35);overflow:hidden;max-height:92vh;display:flex;flex-direction:column;">
                <div style="background:linear-gradient(135deg,#b91c1c,#dc2626);color:#fff;padding:16px 20px;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;gap:12px;">
                    <h2 style="margin:0;font-size:17px;font-weight:700;line-height:1.3;">Priority Docket Calls (24H+)</h2>
                    <button type="button" id="mzoBriefingCloseBtn" style="background:rgba(255,255,255,0.15);border:none;color:#fff;width:32px;height:32px;border-radius:8px;font-size:20px;cursor:pointer;line-height:1;flex-shrink:0;">&times;</button>
                </div>
                <div style="padding:20px;overflow-y:auto;flex:1;">
                    <div style="font-size:12px;color:#64748b;margin:0 0 14px 0;display:flex;align-items:center;gap:6px;">
                        <i class="fas fa-building"></i> ${escapeHtml(jurisdiction)}
                    </div>
                    ${prefsBanner}
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:18px;">
                        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:14px;text-align:center;">
                            <div style="font-size:11px;font-weight:600;color:#991b1b;text-transform:uppercase;letter-spacing:0.04em;">Total 24H+</div>
                            <div style="font-size:32px;font-weight:800;color:${countColor};line-height:1.1;margin-top:4px;">${summary.total}</div>
                        </div>
                        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px;text-align:center;">
                            <div style="font-size:11px;font-weight:600;color:#475569;text-transform:uppercase;letter-spacing:0.04em;">Unique Con IDs</div>
                            <div style="font-size:32px;font-weight:800;color:#0f172a;line-height:1.1;margin-top:4px;">${summary.uniqueConIds}</div>
                        </div>
                    </div>
                    ${
                        summary.oldestHours > 0
                            ? `<div style="font-size:12px;color:#64748b;margin:-6px 0 14px 0;"><i class="fas fa-clock"></i> Oldest pending: <strong style="color:#334155;">${formatHours(summary.oldestHours)}</strong></div>`
                            : ''
                    }
                    <div style="font-size:12px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Priority types</div>
                    <div>${topHtml}</div>
                </div>
                <div style="background:#f8fafc;padding:14px 20px;border-top:1px solid #e2e8f0;display:flex;flex-direction:column;gap:10px;flex-shrink:0;">
                    <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;">
                        <button type="button" id="mzoBriefingPrefsBtn" style="background:#fff;border:1px solid #cbd5e1;color:#334155;padding:8px 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;">
                            <i class="fas fa-cog"></i> Office Preferences
                        </button>
                        <button type="button" id="mzoBriefingDocketBtn" style="background:#1d4ed8;border:none;color:#fff;padding:8px 16px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;">
                            <i class="fas fa-phone-volume"></i> Open Docket Dashboard
                        </button>
                        <button type="button" id="mzoBriefingDismissBtn" style="background:transparent;border:none;color:#64748b;padding:8px 12px;border-radius:8px;font-size:12px;font-weight:500;cursor:pointer;">Dismiss</button>
                    </div>
                    <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#475569;cursor:pointer;user-select:none;">
                        <input type="checkbox" id="mzoBriefingSnoozeChk" style="width:15px;height:15px;cursor:pointer;">
                        Do not show again for 6 hours
                    </label>
                </div>
            </div>
        </div>`;

        document.body.insertAdjacentHTML('beforeend', html);

        function dismissWithOptionalSnooze() {
            const snoozeChk = document.getElementById('mzoBriefingSnoozeChk');
            if (snoozeChk && snoozeChk.checked) {
                snoozeFor6Hours();
            } else {
                closeModal();
            }
        }

        document.getElementById('mzoBriefingCloseBtn')?.addEventListener('click', dismissWithOptionalSnooze);
        document.getElementById('mzoBriefingDismissBtn')?.addEventListener('click', dismissWithOptionalSnooze);
        document.getElementById('mzoBriefingDocketBtn')?.addEventListener('click', () => {
            const snoozeChk = document.getElementById('mzoBriefingSnoozeChk');
            if (snoozeChk && snoozeChk.checked) snoozeFor6Hours();
            openDocketDashboard();
        });
        document.getElementById('mzoBriefingPrefsBtn')?.addEventListener('click', () => {
            openOfficePrefs(async () => {
                await tryShow({ force: true });
            });
        });

        document.getElementById('mzoDocketBriefingModal')?.addEventListener('click', (e) => {
            if (e.target.id === 'mzoDocketBriefingModal') dismissWithOptionalSnooze();
        });
    }

    const DOCKET_CSV_URL =
        'https://docs.google.com/spreadsheets/d/e/2PACX-1vTT56PULgjKw_-wu8lmMWNE6SC1KBDyAKxeHaMloZJWUQ9HQsJoqosYF33DrQK3NX9Bvfn0mjfx-dkP/pub?gid=1059428699&single=true&output=csv';

    let _scheduleRunning = false;

    function parseCsvText(csv) {
        if (!csv) return null;
        if (typeof Papa !== 'undefined') {
            return new Promise((resolve) => {
                Papa.parse(csv, {
                    header: true,
                    skipEmptyLines: true,
                    complete: (results) =>
                        resolve(
                            (results.data || [])
                                .map(normalizeRow)
                                .filter((row) => row && row.doc_crn_dt && row.prob_type)
                        ),
                    error: () => resolve(null)
                });
            });
        }
        // Minimal fallback if Papa is unavailable
        try {
            const lines = String(csv).trim().split(/\r?\n/);
            if (lines.length < 2) return [];
            const headers = lines[0].split(',').map((h) => h.replace(/^\uFEFF/, '').trim());
            return lines
                .slice(1)
                .map((line) => {
                    const values = line.split(',');
                    const row = {};
                    headers.forEach((h, i) => {
                        row[h] = (values[i] || '').trim();
                    });
                    return row;
                })
                .filter((row) => row && row.doc_crn_dt && row.prob_type);
        } catch (e) {
            return null;
        }
    }

    async function loadDocketRows() {
        let csv = null;
        try {
            if (window.mzoDataHub && typeof window.mzoDataHub.get === 'function') {
                csv = await window.mzoDataHub.get('CACHE_DOCKET');
            }
        } catch (e) {
            console.warn('Docket briefing: cache read failed', e);
        }

        if (!csv) {
            try {
                const response = await fetch(DOCKET_CSV_URL, { cache: 'no-store' });
                if (response.ok) csv = await response.text();
            } catch (e) {
                console.warn('Docket briefing: network fetch failed', e);
            }
        }

        if (!csv) return null;
        return parseCsvText(csv);
    }

    function showLoadingModal() {
        if (document.getElementById('mzoDocketBriefingModal')) return;
        const html = `
        <div id="mzoDocketBriefingModal" style="position:fixed;inset:0;background:rgba(15,23,42,0.72);z-index:100060;display:flex;align-items:center;justify-content:center;padding:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
            <div style="background:#ffffff;width:100%;max-width:420px;border-radius:18px;box-shadow:0 20px 50px rgba(0,0,0,0.35);padding:28px 24px;text-align:center;">
                <div style="width:36px;height:36px;border:3px solid #fecaca;border-top-color:#dc2626;border-radius:50%;margin:0 auto 14px;animation:mzoBriefSpin 0.8s linear infinite;"></div>
                <div style="font-size:15px;font-weight:700;color:#0f172a;">Loading pending docket calls…</div>
                <div style="font-size:12px;color:#64748b;margin-top:6px;">Checking dockets older than 24 hours</div>
            </div>
            <style>@keyframes mzoBriefSpin{to{transform:rotate(360deg)}}</style>
        </div>`;
        document.body.insertAdjacentHTML('beforeend', html);
    }

    async function tryShow(opts) {
        opts = opts || {};
        // Always show after login unless snoozed (force bypasses snooze, e.g. after prefs save)
        if (!opts.force) {
            if (sessionStorage.getItem(SESSION_KEY) !== '1') return false;
            if (isSnoozed()) {
                sessionStorage.removeItem(SESSION_KEY);
                closeModal();
                return false;
            }
        }

        if (!opts.force) showLoadingModal();

        const pref = window.mzoPresetsHub ? window.mzoPresetsHub.getGlobalJurisdiction() : null;
        const rows = await loadDocketRows();
        if (!rows) return false;

        const scoped = filterByJurisdiction(rows, pref);
        const priority = filterPriority(scoped);
        const pending24 = filterOlderThan24(priority);
        const summary = buildSummary(pending24);

        if (!opts.force) {
            sessionStorage.removeItem(SESSION_KEY);
        }

        showModal(summary, pref, !hasOfficePrefs(pref));
        return true;
    }

    function schedule() {
        if (sessionStorage.getItem(SESSION_KEY) !== '1') return;
        if (isSnoozed()) {
            sessionStorage.removeItem(SESSION_KEY);
            return;
        }
        if (_scheduleRunning) return;
        _scheduleRunning = true;

        let attempts = 0;
        const maxAttempts = 20;

        const run = async () => {
            try {
                const shown = await tryShow();
                if (shown || sessionStorage.getItem(SESSION_KEY) !== '1') {
                    _scheduleRunning = false;
                    return;
                }
                if (isSnoozed()) {
                    sessionStorage.removeItem(SESSION_KEY);
                    closeModal();
                    _scheduleRunning = false;
                    return;
                }
                if (attempts < maxAttempts) {
                    attempts += 1;
                    setTimeout(run, 1200);
                } else {
                    // Still show a modal with zero/error state so login always gets feedback
                    sessionStorage.removeItem(SESSION_KEY);
                    _scheduleRunning = false;
                    showModal(
                        { total: 0, uniqueConIds: 0, topTypes: [], oldestHours: 0 },
                        window.mzoPresetsHub ? window.mzoPresetsHub.getGlobalJurisdiction() : null,
                        true
                    );
                    const content = document.querySelector('#mzoDocketBriefingModal [style*="overflow-y"]');
                    if (content) {
                        content.insertAdjacentHTML(
                            'afterbegin',
                            `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:12px 14px;margin-bottom:16px;font-size:12px;color:#991b1b;line-height:1.45;">
                                Could not load docket data yet. Open Docket Dashboard or tap Sync and try again.
                             </div>`
                        );
                    }
                }
            } catch (err) {
                console.error('Docket briefing schedule error', err);
                _scheduleRunning = false;
            }
        };

        setTimeout(run, 400);
    }

    window.mzoDocketBriefing = {
        SESSION_KEY,
        SNOOZE_KEY,
        schedule,
        tryShow
    };
})(window);
