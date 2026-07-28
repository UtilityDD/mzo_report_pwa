/**
 * Material Allotment / Diversion — simple professional row table
 * Each row: From | To | Material (inline search) | Source stock | Dest stock | Qty | Unit
 */
(function (window) {
    'use strict';

    const ZONE = {
        name: 'Malda (D) Zone',
        short: 'Zone',
        isZone: true,
        match: ['malda (d) zone', 'zone', 'malda & zone'],
        plantPrefer: '7201'
    };

    const DIVISIONS = [
        { name: 'Malda (D) Division', short: 'Malda', isZone: false, match: ['malda (d) division', 'malda'], plantPrefer: '6611' },
        { name: 'Chanchal (D) Division', short: 'Chanchal', isZone: false, match: ['chanchal (d) division', 'chanchal'], plantPrefer: '6612' },
        { name: 'Gazole (D) Division', short: 'Gazole', isZone: false, match: ['gazole (d) division', 'gazole'], plantPrefer: '6613' },
        { name: 'Raiganj (D) Division', short: 'Raiganj', isZone: false, match: ['raiganj (d) division', 'raiganj'], plantPrefer: '6621' },
        { name: 'Islampur (D) Division', short: 'Islampur', isZone: false, match: ['islampur (d) division', 'islampur'], plantPrefer: '6622' },
        { name: 'Balurghat (D) Division', short: 'Balurghat', isZone: false, match: ['balurghat (d) division', 'balurghat'], plantPrefer: '6631' },
        { name: 'Buniadpur (D) Division', short: 'Buniadpur', isZone: false, match: ['buniadpur (d) division', 'buniadpur'], plantPrefer: '6632' }
    ];

    const ALL_STORES = [ZONE, ...DIVISIONS];

    const ALLOT_ALLOWED_USERS = ['zm', 'aritra', 'dm1'];

    function getPortalProfile() {
        try {
            return JSON.parse(localStorage.getItem('mzo_user_profile') || '{}') || {};
        } catch (e) {
            return {};
        }
    }

    function canUseAllotment() {
        // Local testing: always allow on localhost
        const host = String(location.hostname || '').toLowerCase();
        if (host === 'localhost' || host === '127.0.0.1') return true;

        const profile = getPortalProfile();
        const user = String(profile.Username || profile.username || '')
            .trim()
            .toLowerCase();
        const name = String(profile.Name || profile.name || '')
            .trim()
            .toLowerCase();
        if (!user && !name) return false;
        if (ALLOT_ALLOWED_USERS.includes(user)) return true;
        return ALLOT_ALLOWED_USERS.some((u) => name === u || name.startsWith(u + ' ') || name.includes(' ' + u + ' '));
    }

    function applyAllotmentVisibility() {
        const group = document.getElementById('allot-btn-group');
        const allowed = canUseAllotment();
        if (group) {
            group.hidden = !allowed;
            group.style.display = allowed ? 'flex' : 'none';
        }
        if (!allowed) {
            const allotOverlay = document.getElementById('allotment-overlay');
            const viewOverlay = document.getElementById('allot-view-overlay');
            if (allotOverlay) {
                allotOverlay.classList.remove('active');
                allotOverlay.style.display = 'none';
            }
            if (viewOverlay) {
                viewOverlay.classList.remove('active');
                viewOverlay.style.display = 'none';
            }
        }
        return allowed;
    }

    window.MzoAllotmentAccess = {
        allowedUsers: ALLOT_ALLOWED_USERS,
        canUseAllotment,
        applyAllotmentVisibility,
        getPortalProfile
    };

    function updateFlowControls() {
        const previewBtn = document.getElementById('allot-preview-btn');
        const pdfBtn = document.getElementById('allot-pdf-btn');
        const confirmBtn = document.getElementById('allot-confirm-btn');
        const addRowBtn = document.getElementById('allot-add-row-btn');
        const remarks = document.getElementById('allot-global-remarks');
        const panel = document.querySelector('#allotment-overlay .allot-panel');
        const locked = isSaved || isUploading;

        if (previewBtn) previewBtn.disabled = locked;
        if (addRowBtn) {
            addRowBtn.disabled = locked;
            addRowBtn.hidden = isSaved;
        }
        if (remarks) remarks.disabled = locked;
        panel?.classList.toggle('allot-locked', isSaved);

        if (pdfBtn) {
            pdfBtn.hidden = !isSaved;
            pdfBtn.disabled = isUploading || !isSaved;
            pdfBtn.title = isSaved
                ? 'Download PDF with final allotment number'
                : 'Available after Confirm & Upload';
        }

        if (confirmBtn) {
            if (isSaved) {
                confirmBtn.disabled = true;
                confirmBtn.textContent = 'Saved';
                confirmBtn.title = 'Allotment number already issued — close and open again for a new allotment';
            } else if (isUploading) {
                confirmBtn.disabled = true;
                confirmBtn.textContent = 'Uploading…';
                confirmBtn.title = '';
            } else {
                confirmBtn.disabled = false;
                confirmBtn.textContent = 'Confirm & Upload';
                confirmBtn.title = 'Issues the next allotment number and saves to the sheet';
            }
        }

        if (locked) {
            document
                .querySelectorAll('#allot-lines-table select, #allot-lines-table input, #allot-lines-table button')
                .forEach((el) => {
                    el.disabled = true;
                });
        } else {
            document.querySelectorAll('#allot-lines-body tr[data-id]').forEach((tr) => {
                const id = tr.getAttribute('data-id');
                const line = lines.find((l) => l.id === id);
                const qty = tr.querySelector('input[data-field="qty"]');
                if (qty) qty.disabled = !(line && line.code);
            });
        }
    }

    function getSharedResults() {
        if (!sharedResultsEl) {
            sharedResultsEl = document.createElement('div');
            sharedResultsEl.className = 'allot-row-search-results';
            sharedResultsEl.hidden = true;
            document.body.appendChild(sharedResultsEl);
        }
        return sharedResultsEl;
    }

    function parseNum(v) {
        if (typeof window.parseStockNumber === 'function') return window.parseStockNumber(v);
        if (typeof v === 'number') return v;
        return parseFloat(String(v || '').replace(/,/g, '')) || 0;
    }

    function getData() {
        return Array.isArray(window.allData) ? window.allData : [];
    }

    function norm(s) {
        return String(s || '').toLowerCase().trim();
    }

    function findStore(name) {
        return ALL_STORES.find((s) => s.name === name) || null;
    }

    function matchesStore(storeName, store) {
        if (!store) return false;
        const n = norm(storeName);
        if (store.isZone) return store.match.some((m) => n === m || n.includes('zone'));
        if (n.includes('zone')) return false;
        return store.match.some((m) => n === m || n.includes(m.replace(' (d) division', '')));
    }

    function stockAt(materialCode, store) {
        if (!store || !materialCode) return { stock: 0, unit: '' };
        const code = String(materialCode).trim();
        let total = 0;
        let unit = '';
        getData().forEach((item) => {
            if (String(item.Material || '').trim() !== code) return;
            if (!matchesStore(item.StoreName, store)) return;
            total += parseNum(item.Unrestricted);
            if (!unit) unit = item['Base Unit of Measure'] || '';
        });
        return { stock: total, unit };
    }

    function plantCodeFor(store) {
        if (!store) return '';
        if (store.plantPrefer) return store.plantPrefer;
        const map = window.PLANT_MAP || {};
        for (const [code, name] of Object.entries(map)) {
            if (matchesStore(name, store) && String(code).startsWith('6')) return code;
        }
        for (const [code, name] of Object.entries(map)) {
            if (matchesStore(name, store)) return code;
        }
        return '';
    }

    function uniqueMaterials() {
        const map = new Map();
        getData().forEach((item) => {
            const code = String(item.Material || '').trim();
            if (!code || map.has(code)) return;
            map.set(code, {
                code,
                description: item['Material Description'] || '',
                unit: item['Base Unit of Measure'] || ''
            });
        });
        return Array.from(map.values());
    }

    function showAlertModal(message) {
        const modal = document.getElementById('allot-alert-modal');
        const msg = document.getElementById('allot-alert-message');
        if (msg) msg.textContent = message;
        if (modal) {
            modal.hidden = false;
            modal.classList.add('active');
            modal.style.display = 'flex';
            modal.style.zIndex = '2147483001';
            if (modal.parentElement !== document.body) document.body.appendChild(modal);
        }
    }

    function hideAlertModal() {
        const modal = document.getElementById('allot-alert-modal');
        if (modal) {
            modal.classList.remove('active');
            modal.hidden = true;
            modal.style.display = 'none';
        }
    }

    function showStatus(msg, type) {
        const el = document.getElementById('allot-status');
        if (!el) return;
        if (!msg) {
            el.hidden = true;
            el.textContent = '';
            return;
        }
        el.hidden = false;
        el.className = 'allot-status ' + (type || 'info');
        el.textContent = msg;
    }

    function escapeHtml(t) {
        const d = document.createElement('div');
        d.textContent = t == null ? '' : String(t);
        return d.innerHTML;
    }

    function escapeAttr(t) {
        return String(t == null ? '' : t).replace(/"/g, '&quot;');
    }

    function formatQty(n) {
        if (n == null || isNaN(n)) return '0';
        return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 3 });
    }

    function formatDateDisplay(d) {
        const dt = d || new Date();
        const pad = (x) => String(x).padStart(2, '0');
        return `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}/${dt.getFullYear()}`;
    }

    function makeId() {
        return 'R' + Date.now() + Math.random().toString(36).slice(2, 6);
    }

    function storeOptionsHtml(selected, excludeName) {
        return ALL_STORES.filter((s) => !excludeName || s.name !== excludeName)
            .map(
                (s) =>
                    `<option value="${escapeAttr(s.name)}"${s.name === selected ? ' selected' : ''}>${escapeHtml(
                        s.short
                    )}</option>`
            )
            .join('');
    }

    function newBlankRow() {
        return {
            id: makeId(),
            fromName: ZONE.name,
            toName: DIVISIONS[0].name,
            code: '',
            description: '',
            unit: '',
            qty: '',
            searchText: ''
        };
    }

    function refreshRowStocks(line) {
        const from = findStore(line.fromName);
        const to = findStore(line.toName);
        const src = stockAt(line.code, from);
        const dst = stockAt(line.code, to);
        if (line.code && src.unit && !line.unit) line.unit = src.unit;
        return { src, dst };
    }

    function sourceUsedElsewhere(code, fromName, exceptId) {
        return lines
            .filter((l) => l.id !== exceptId && l.code === code && l.fromName === fromName)
            .reduce((sum, l) => sum + (Number(l.qty) > 0 ? Number(l.qty) : 0), 0);
    }

    function shortName(name) {
        const s = findStore(name);
        return s ? s.short : String(name || '');
    }

    function updateStockHeaders() {
        const thFrom = document.getElementById('allot-th-from-stock');
        const thTo = document.getElementById('allot-th-to-stock');
        if (!thFrom || !thTo) return;
        const fromNames = [...new Set(lines.map((l) => l.fromName).filter(Boolean))];
        const toNames = [...new Set(lines.map((l) => l.toName).filter(Boolean))];
        thFrom.textContent = fromNames.length === 1 ? shortName(fromNames[0]) : 'From stock';
        thTo.textContent = toNames.length === 1 ? shortName(toNames[0]) : 'To stock';
    }

    function renderLines() {
        closeAllRowSearches();
        const tbody = document.getElementById('allot-lines-body');
        if (!tbody) return;

        if (!lines.length) lines.push(newBlankRow());
        updateStockHeaders();

        tbody.innerHTML = lines
            .map((line) => {
                const { src, dst } = refreshRowStocks(line);
                const used = sourceUsedElsewhere(line.code, line.fromName, line.id);
                const remaining = src.stock - used;
                const over = line.code && Number(line.qty) > remaining + 1e-9;
                const matLabel = line.code
                    ? `<div class="allot-mat-selected"><span class="code">${escapeHtml(line.code)}</span> — ${escapeHtml(
                          line.description
                      )}</div>`
                    : '';
                const fromLabel = shortName(line.fromName);
                const toLabel = shortName(line.toName);

                return `<tr data-id="${line.id}">
                    <td>
                        <select data-field="from">${storeOptionsHtml(line.fromName)}</select>
                    </td>
                    <td>
                        <select data-field="to">${storeOptionsHtml(line.toName, line.fromName)}</select>
                    </td>
                    <td>
                        <div class="allot-mat-cell-wrap">
                            <input type="text" class="allot-mat-search" data-field="search"
                                placeholder="Search code / name…"
                                value="${escapeAttr(line.searchText || (line.code ? line.code + ' ' + line.description : ''))}"
                                autocomplete="off">
                            ${matLabel}
                        </div>
                    </td>
                    <td>
                        <span class="allot-stock-store">${escapeHtml(fromLabel)}</span>
                        <span class="allot-stock-val" data-role="src">${line.code ? formatQty(src.stock) : '—'}</span>
                    </td>
                    <td>
                        <span class="allot-stock-store">${escapeHtml(toLabel)}</span>
                        <span class="allot-stock-val" data-role="dst">${line.code ? formatQty(dst.stock) : '—'}</span>
                    </td>
                    <td>
                        <input type="number" min="0" step="any" data-field="qty"
                            class="allot-qty-input${over ? ' over-zone' : ''}"
                            value="${line.qty || ''}" ${line.code ? '' : 'disabled'}>
                    </td>
                    <td><span class="allot-stock-val" data-role="unit">${escapeHtml(line.unit || '')}</span></td>
                    <td><button type="button" class="allot-remove-btn" title="Remove row">&times;</button></td>
                </tr>`;
            })
            .join('');

        bindRowEvents(tbody);
        updateFlowControls();
    }

    function bindRowEvents(tbody) {
        tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
            const id = tr.getAttribute('data-id');
            const line = lines.find((l) => l.id === id);
            if (!line) return;

            tr.querySelector('.allot-remove-btn')?.addEventListener('click', () => {
                if (isSaved || isUploading) return;
                lines = lines.filter((l) => l.id !== id);
                if (!lines.length) lines.push(newBlankRow());
                renderLines();
            });

            tr.querySelector('select[data-field="from"]')?.addEventListener('change', (e) => {
                if (isSaved || isUploading) return;
                const nextFrom = e.target.value;
                if (line.code) {
                    const src = stockAt(line.code, findStore(nextFrom));
                    if (!(src.stock > 0)) {
                        showAlertModal(`No stock at ${shortName(nextFrom)} for ${line.code}.`);
                        e.target.value = line.fromName;
                        return;
                    }
                }
                line.fromName = nextFrom;
                if (line.toName === line.fromName) {
                    const alt = DIVISIONS.find((d) => d.name !== line.fromName);
                    if (alt) line.toName = alt.name;
                }
                document.getElementById('allot-preview-section').hidden = true;
                renderLines();
            });

            tr.querySelector('select[data-field="to"]')?.addEventListener('change', (e) => {
                line.toName = e.target.value;
                document.getElementById('allot-preview-section').hidden = true;
                renderLines();
            });

            const qtyInp = tr.querySelector('input[data-field="qty"]');
            qtyInp?.addEventListener('input', () => {
                line.qty = qtyInp.value === '' ? '' : Number(qtyInp.value);
                const from = findStore(line.fromName);
                const src = stockAt(line.code, from);
                const used = sourceUsedElsewhere(line.code, line.fromName, line.id);
                qtyInp.classList.toggle('over-zone', Number(line.qty) > src.stock - used + 1e-9);
                document.getElementById('allot-preview-section').hidden = true;
            });

            const searchInp = tr.querySelector('input[data-field="search"]');
            searchInp?.addEventListener('input', () => {
                line.searchText = searchInp.value;
                clearTimeout(searchTimers[id]);
                searchTimers[id] = setTimeout(() => runRowSearch(line, searchInp), 160);
            });
            searchInp?.addEventListener('focus', () => {
                if ((searchInp.value || '').trim().length >= 2) runRowSearch(line, searchInp);
            });
        });
    }

    function positionSearchResults(searchInp, resultsBox) {
        if (!searchInp || !resultsBox || resultsBox.hidden) return;
        const rect = searchInp.getBoundingClientRect();
        const width = Math.max(rect.width, 280);
        const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
        const spaceBelow = window.innerHeight - rect.bottom - 12;
        const maxH = Math.min(220, Math.max(120, spaceBelow));
        resultsBox.style.left = `${left}px`;
        resultsBox.style.width = `${width}px`;
        if (spaceBelow < 140 && rect.top > 160) {
            resultsBox.style.top = 'auto';
            resultsBox.style.bottom = `${window.innerHeight - rect.top + 4}px`;
            resultsBox.style.maxHeight = `${Math.min(220, rect.top - 16)}px`;
        } else {
            resultsBox.style.bottom = 'auto';
            resultsBox.style.top = `${rect.bottom + 4}px`;
            resultsBox.style.maxHeight = `${maxH}px`;
        }
    }

    function closeAllRowSearches() {
        const box = sharedResultsEl || document.querySelector('.allot-row-search-results');
        if (box) {
            box.hidden = true;
            box.innerHTML = '';
        }
        document.querySelectorAll('.allot-mat-cell-wrap.is-open').forEach((el) => {
            el.classList.remove('is-open');
        });
        activeSearch = null;
    }

    function runRowSearch(line, searchInp) {
        const wrap = searchInp.closest('.allot-mat-cell-wrap');
        const resultsBox = getSharedResults();
        const q = norm(searchInp.value);
        if (q.length < 2) {
            closeAllRowSearches();
            return;
        }
        const hits = uniqueMaterials()
            .filter((m) => norm(m.code).includes(q) || norm(m.description).includes(q))
            .slice(0, 20);

        document.querySelectorAll('.allot-mat-cell-wrap.is-open').forEach((el) => {
            if (el !== wrap) el.classList.remove('is-open');
        });
        wrap?.classList.add('is-open');
        activeSearch = { line, searchInp, resultsBox, wrap };

        if (!hits.length) {
            resultsBox.hidden = false;
            resultsBox.innerHTML = '<div class="allot-search-item"><span>No match</span></div>';
            positionSearchResults(searchInp, resultsBox);
            return;
        }

        resultsBox.hidden = false;
        resultsBox.innerHTML = hits
            .map(
                (m) =>
                    `<button type="button" class="allot-search-item" data-code="${escapeAttr(m.code)}">
                        <strong>${escapeHtml(m.code)}</strong>
                        <span>${escapeHtml(m.description)}</span>
                    </button>`
            )
            .join('');
        positionSearchResults(searchInp, resultsBox);

        resultsBox.querySelectorAll('.allot-search-item[data-code]').forEach((btn) => {
            btn.addEventListener('mousedown', (e) => e.preventDefault());
            btn.addEventListener('click', () => {
                const mat = uniqueMaterials().find((m) => m.code === btn.getAttribute('data-code'));
                if (!mat) return;
                const from = findStore(line.fromName);
                const src = stockAt(mat.code, from);
                if (!(src.stock > 0)) {
                    closeAllRowSearches();
                    showAlertModal(`No stock at ${shortName(line.fromName)} for ${mat.code}.`);
                    return;
                }
                line.code = mat.code;
                line.description = mat.description;
                line.unit = mat.unit || src.unit || '';
                line.searchText = mat.code + ' ' + mat.description;
                line.qty = line.qty || '';
                closeAllRowSearches();
                document.getElementById('allot-preview-section').hidden = true;
                renderLines();
            });
        });
    }

    function validateDraft() {
        const usable = lines.filter((l) => l.code);
        if (!usable.length) return 'Add at least one material row.';
        for (const line of usable) {
            if (!line.fromName || !line.toName) return 'Select From and To on every row.';
            if (line.fromName === line.toName) return `From and To cannot be the same (${line.code}).`;
            const src = stockAt(line.code, findStore(line.fromName));
            if (!(src.stock > 0)) {
                return `No stock at ${shortName(line.fromName)} for ${line.code}.`;
            }
            if (!(Number(line.qty) > 0)) return `Enter qty for ${line.code}.`;
            const used = sourceUsedElsewhere(line.code, line.fromName, line.id);
            if (Number(line.qty) + used > src.stock + 1e-9) {
                return `${line.code}: qty exceeds available stock at ${shortName(line.fromName)} (${formatQty(src.stock)}).`;
            }
        }
        return null;
    }

    function movementLabel(fromName) {
        const s = findStore(fromName);
        return s && s.isZone ? 'Allotment' : 'Diversion';
    }

    function activeLines() {
        return lines.filter((l) => l.code && Number(l.qty) > 0);
    }

    function buildLetterHtml(number) {
        const rows = activeLines();
        const remarks = (document.getElementById('allot-global-remarks')?.value || '').trim();
        const dateStr = formatDateDisplay();

        // Group by From → To for clean letter sections
        const groups = {};
        rows.forEach((l) => {
            const key = l.fromName + '||' + l.toName;
            if (!groups[key]) groups[key] = { from: l.fromName, to: l.toName, lines: [] };
            groups[key].lines.push(l);
        });

        const toNames = [...new Set(rows.map((r) => r.toName))];
        const toBlock = toNames
            .map((n) => `The Divisional Manager,<br>${escapeHtml(n)}`)
            .join('<br><br>');

        const tables = Object.values(groups)
            .map((g) => {
                const kind = movementLabel(g.from);
                const body = g.lines
                    .map((line) => {
                        const dest = stockAt(line.code, findStore(line.toName));
                        return `<tr>
                            <td>${escapeHtml(line.code)}</td>
                            <td>${escapeHtml(line.description)}</td>
                            <td>${formatQty(dest.stock)}</td>
                            <td>${formatQty(Number(line.qty))}</td>
                            <td>${escapeHtml(line.unit || '')}</td>
                        </tr>`;
                    })
                    .join('');
                return `<p class="letter-move"><strong>${kind}:</strong> ${escapeHtml(g.from)} → ${escapeHtml(
                    g.to
                )}</p>
                <table class="letter-table">
                    <thead>
                        <tr>
                            <th>Material Code</th>
                            <th>Description</th>
                            <th>Present Stock (To)</th>
                            <th>Qty</th>
                            <th>Unit</th>
                        </tr>
                    </thead>
                    <tbody>${body}</tbody>
                </table>`;
            })
            .join('');

        return `
            <div class="letter-sheet">
            <header class="letter-pad">
                <div class="letter-pad-org">West Bengal State Electricity Distribution Company Limited</div>
                <div class="letter-pad-sub">(A Govt. of W.B. Enterprise)</div>
                <div class="letter-pad-office">Zonal Office, Malda</div>
                <div class="letter-pad-addr">Administrative Building, 2nd Floor, Rabindra Avenue, Malda, WB-732101</div>
                <div class="letter-pad-contact">Ph: 03522-255035, e-mail: zm.malda@wbsedcl.in</div>
            </header>
            <div class="letter-meta">
                <div><strong>Allotment No:</strong> ${escapeHtml(number)}</div>
                <div><strong>Date:</strong> ${escapeHtml(dateStr)}</div>
            </div>
            <p><strong>To</strong><br>${toBlock}</p>
            <p><strong>Sub:</strong> Allotment / diversion of materials.</p>
            <p>The following materials are hereby allotted / diverted as detailed below.</p>
            ${remarks ? `<p>For the following purpose: <em>${escapeHtml(remarks)}</em></p>` : ''}
            ${tables}
            <p>${
                remarks
                    ? 'This is issued for the purpose stated above. '
                    : ''
            }Kindly arrange to take delivery / update records accordingly and ensure timely utilization of the allotted materials.</p>
            <div class="sign-block">
                <div>Zonal Manager</div>
                <div>Malda Zone</div>
            </div>
            </div>
        `;
    }

    function showPreview() {
        const err = validateDraft();
        if (err) {
            if (/^No stock at /i.test(err)) showAlertModal(err);
            else showStatus(err, 'error');
            return false;
        }
        showStatus('');
        const section = document.getElementById('allot-preview-section');
        const box = document.getElementById('allot-letter-preview');
        section.hidden = false;
        box.innerHTML = buildLetterHtml(allotmentNo);
        return true;
    }

    async function downloadPdf() {
        if (!isSaved || allotmentNo === 'DRAFT') {
            showStatus('Confirm & Upload first — PDF uses the final allotment number.', 'error');
            return;
        }
        if (!showPreview()) return;

        const jspdf = window.jspdf;
        if (!jspdf || !jspdf.jsPDF) {
            showStatus('PDF library not loaded.', 'error');
            return;
        }
        if (typeof window.html2canvas !== 'function') {
            showStatus('PDF capture library not loaded.', 'error');
            return;
        }

        const el = document.getElementById('allot-letter-preview');
        if (!el) {
            showStatus('Letter preview not found.', 'error');
            return;
        }

        showStatus('Preparing PDF…', 'info');
        const prev = {
            width: el.style.width,
            maxWidth: el.style.maxWidth,
            minHeight: el.style.minHeight,
            boxShadow: el.style.boxShadow
        };
        el.classList.add('allot-letter-capture');
        el.style.width = '720px';
        el.style.maxWidth = '720px';
        el.style.boxShadow = 'none';

        try {
            // Allow layout to settle at capture width
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            const canvas = await window.html2canvas(el, {
                scale: 2,
                backgroundColor: '#ffffff',
                useCORS: true,
                logging: false,
                scrollX: 0,
                scrollY: 0
            });

            const imgData = canvas.toDataURL('image/png');
            const doc = new jspdf.jsPDF({ unit: 'pt', format: 'a4' });
            const pageW = doc.internal.pageSize.getWidth();
            const pageH = doc.internal.pageSize.getHeight();
            const margin = 36;
            const contentW = pageW - margin * 2;
            const imgH = (canvas.height * contentW) / canvas.width;
            const pageContentH = pageH - margin * 2;

            let heightLeft = imgH;
            let offsetY = margin;

            doc.addImage(imgData, 'PNG', margin, offsetY, contentW, imgH);
            heightLeft -= pageContentH;

            while (heightLeft > 1) {
                offsetY = margin - (imgH - heightLeft);
                doc.addPage();
                doc.addImage(imgData, 'PNG', margin, offsetY, contentW, imgH);
                heightLeft -= pageContentH;
            }

            doc.save(`Allotment_${String(allotmentNo).replace(/[^\w-]+/g, '_')}.pdf`);
            showStatus(`Saved as ${allotmentNo}. PDF downloaded.`, 'ok');
        } catch (err) {
            console.error(err);
            showStatus(err.message || 'PDF generation failed.', 'error');
        } finally {
            el.classList.remove('allot-letter-capture');
            el.style.width = prev.width;
            el.style.maxWidth = prev.maxWidth;
            el.style.minHeight = prev.minHeight;
            el.style.boxShadow = prev.boxShadow;
        }
    }

    function buildPayload() {
        const globalRemarks = (document.getElementById('allot-global-remarks')?.value || '').trim();
        let createdBy = 'portal';
        try {
            const profile = JSON.parse(localStorage.getItem('mzo_user_profile') || '{}');
            createdBy = profile.Name || profile.Username || profile.username || createdBy;
        } catch (e) {}

        const rows = activeLines().map((line) => {
            const from = findStore(line.fromName);
            const to = findStore(line.toName);
            const src = stockAt(line.code, from);
            const dst = stockAt(line.code, to);
            return {
                FromStore: line.fromName,
                FromPlantCode: plantCodeFor(from),
                Division: line.toName,
                PlantCode: plantCodeFor(to),
                MaterialCode: line.code,
                MaterialDescription: line.description,
                Unit: line.unit || '',
                PresentStockDiv: dst.stock,
                SourceStockAtAllot: src.stock,
                ZoneStockAtAllot: src.stock,
                AllottedQty: Number(line.qty),
                Remarks: globalRemarks,
                MovementType: movementLabel(line.fromName)
            };
        });

        return { action: 'createAllotment', createdBy, rows };
    }

    async function confirmUpload() {
        if (window.MzoAllotmentAccess && !window.MzoAllotmentAccess.canUseAllotment()) {
            showStatus('Allotment is restricted to authorised users only.', 'error');
            return;
        }
        if (isSaved || isUploading) return;
        if (!showPreview()) return;
        if (localStorage.getItem('mzo_authenticated') !== 'true') {
            showStatus('Please log in to the portal before uploading.', 'error');
            return;
        }
        if (!window.confirm('Upload this allotment to the stock sheet? This will issue the next allotment number.')) return;

        isUploading = true;
        updateFlowControls();
        showStatus('Uploading…', 'info');

        try {
            const res = await fetch('/api/stock/allotment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify(buildPayload())
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.error || data.status === 'error') {
                throw new Error(data.error || data.message || `Upload failed (${res.status})`);
            }
            allotmentNo = data.allotmentNo || data.AllotmentNo || allotmentNo;
            isSaved = true;
            isUploading = false;
            updateFlowControls();
            showPreview();
            showStatus(`Saved as ${allotmentNo}. PDF is ready — Confirm is locked to protect the sequence.`, 'ok');
            await downloadPdf();
        } catch (err) {
            console.error(err);
            isUploading = false;
            updateFlowControls();
            showStatus(err.message || 'Upload failed.', 'error');
        }
    }

    function openPanel(ev) {
        if (ev && typeof ev.preventDefault === 'function') {
            ev.preventDefault();
            ev.stopPropagation();
        }
        if (window.MzoAllotmentAccess && !window.MzoAllotmentAccess.canUseAllotment()) {
            showAlertModal('Allotment is restricted to authorised users only.');
            return false;
        }

        const overlay = document.getElementById('allotment-overlay');
        if (!overlay) {
            console.error('[allotment] #allotment-overlay not found in DOM');
            showAlertModal('Allotment panel markup is missing. Hard-refresh the page (Ctrl+F5).');
            return false;
        }

        if (isSaved) {
            lines = [newBlankRow()];
            allotmentNo = 'DRAFT';
            isSaved = false;
            const remarks = document.getElementById('allot-global-remarks');
            if (remarks) {
                remarks.value = '';
                remarks.disabled = false;
            }
        }
        isUploading = false;
        allotmentNo = 'DRAFT';
        if (!lines.length) lines = [newBlankRow()];

        // Mount on body and force visible — do not close on backdrop click
        document.body.appendChild(overlay);
        document.body.classList.add('allot-modal-open');
        overlay.classList.add('active');
        overlay.removeAttribute('hidden');
        overlay.setAttribute('aria-hidden', 'false');
        overlay.style.cssText =
            'display:flex!important;position:fixed!important;inset:0!important;z-index:2147483000!important;background:rgba(15,23,42,.55);';

        try {
            renderLines();
        } catch (err) {
            console.error('[allotment] renderLines failed:', err);
        }

        const previewSection = document.getElementById('allot-preview-section');
        if (previewSection) previewSection.hidden = true;

        if (getData().length) {
            showStatus('');
        } else {
            showStatus('Stock data is still loading — wait a moment before searching materials.', 'info');
        }
        updateFlowControls();
        return true;
    }

    function closePanel() {
        closeAllRowSearches();
        const overlay = document.getElementById('allotment-overlay');
        if (overlay) {
            overlay.classList.remove('active');
            overlay.setAttribute('aria-hidden', 'true');
            overlay.style.display = 'none';
            overlay.style.cssText = 'display:none';
        }
        document.body.classList.remove('allot-modal-open');
        if (isSaved) resetForm();
    }

    function resetForm() {
        lines = [newBlankRow()];
        allotmentNo = 'DRAFT';
        isSaved = false;
        isUploading = false;
        const remarks = document.getElementById('allot-global-remarks');
        if (remarks) {
            remarks.value = '';
            remarks.disabled = false;
        }
        renderLines();
        document.getElementById('allot-preview-section').hidden = true;
        showStatus('');
        updateFlowControls();
    }

    function bind() {
        if (bound) return;
        bound = true;
        if (window.MzoAllotmentAccess) window.MzoAllotmentAccess.applyAllotmentVisibility();

        document.getElementById('allot-material-btn')?.addEventListener('click', openPanel);
        document.getElementById('allot-close-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            closePanel();
        });
        document.getElementById('allot-cancel-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            closePanel();
        });
        document.getElementById('allot-preview-btn')?.addEventListener('click', () => {
            if (isSaved || isUploading) return;
            showPreview();
        });
        document.getElementById('allot-pdf-btn')?.addEventListener('click', downloadPdf);
        document.getElementById('allot-confirm-btn')?.addEventListener('click', confirmUpload);
        document.getElementById('allot-add-row-btn')?.addEventListener('click', () => {
            if (isSaved || isUploading) return;
            lines.push(newBlankRow());
            renderLines();
        });
        document.getElementById('allot-alert-ok')?.addEventListener('click', hideAlertModal);
        document.getElementById('allot-alert-modal')?.addEventListener('click', (e) => {
            if (e.target.id === 'allot-alert-modal') hideAlertModal();
        });
        // Backdrop click does NOT close create panel (was dismissing instantly on left-side button)

        document.addEventListener('click', (e) => {
            if (e.target.closest('.allot-mat-cell-wrap') || e.target.closest('.allot-row-search-results')) return;
            closeAllRowSearches();
        });

        const repositionOpenSearch = () => {
            if (!activeSearch || activeSearch.resultsBox.hidden) return;
            positionSearchResults(activeSearch.searchInp, activeSearch.resultsBox);
        };
        document.querySelector('.allot-panel-body')?.addEventListener('scroll', repositionOpenSearch, { passive: true });
        window.addEventListener('resize', repositionOpenSearch);
        window.addEventListener('scroll', repositionOpenSearch, true);
    }

    function init() {
        bind();
        if (window.MzoAllotmentAccess) window.MzoAllotmentAccess.applyAllotmentVisibility();
        if (!lines.length) lines = [newBlankRow()];
        updateFlowControls();
    }

    window.MzoStockAllotment = { init, resetForm, openPanel, closePanel };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})(window);
