/**
 * View / search saved allotment orders + material / division / date summaries
 */
(function (window) {
    'use strict';

    let bound = false;
    let allRows = [];
    let filteredRows = [];
    let activeTab = 'orders';
    let selectedNo = '';

    function escapeHtml(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function formatQty(n) {
        const x = Number(n);
        if (!isFinite(x)) return String(n ?? '');
        return Number.isInteger(x) ? String(x) : String(Math.round(x * 1000) / 1000);
    }

    function shortName(name) {
        const s = String(name || '');
        if (/zone/i.test(s)) return 'Zone';
        return s.replace(/\s*\(D\)\s*Division/i, '').replace(/\s*Division$/i, '').trim() || s;
    }

    function showStatus(msg, kind) {
        const el = document.getElementById('allot-view-status');
        if (!el) return;
        if (!msg) {
            el.hidden = true;
            el.textContent = '';
            el.className = 'allot-status';
            return;
        }
        el.hidden = false;
        el.textContent = msg;
        el.className = 'allot-status' + (kind ? ' ' + kind : '');
    }

    function getFilters() {
        return {
            q: (document.getElementById('allot-view-q')?.value || '').trim(),
            dateFrom: document.getElementById('allot-view-from')?.value || '',
            dateTo: document.getElementById('allot-view-to')?.value || '',
            division: document.getElementById('allot-view-division')?.value || '',
            material: (document.getElementById('allot-view-material')?.value || '').trim()
        };
    }

    function applyLocalFilters(rows) {
        const f = getFilters();
        const q = f.q.toLowerCase();
        const mat = f.material.toLowerCase();
        const div = f.division.toLowerCase();
        return rows.filter((r) => {
            const date = String(r.Date || '').slice(0, 10);
            if (f.dateFrom && date && date < f.dateFrom) return false;
            if (f.dateTo && date && date > f.dateTo) return false;
            if (div && !String(r.Division || '').toLowerCase().includes(div)) return false;
            if (mat) {
                const blob = (String(r.MaterialCode || '') + ' ' + String(r.MaterialDescription || '')).toLowerCase();
                if (!blob.includes(mat)) return false;
            }
            if (q) {
                const blob = [
                    r.AllotmentNo,
                    r.MaterialCode,
                    r.MaterialDescription,
                    r.Division,
                    r.FromStore,
                    r.Remarks,
                    r.CreatedBy,
                    r.Date,
                    r.MovementType
                ]
                    .join(' ')
                    .toLowerCase();
                if (!blob.includes(q)) return false;
            }
            return true;
        });
    }

    function groupOrders(rows) {
        const map = new Map();
        rows.forEach((r) => {
            const no = String(r.AllotmentNo || '');
            if (!no) return;
            if (!map.has(no)) {
                map.set(no, {
                    allotmentNo: no,
                    date: String(r.Date || '').slice(0, 10),
                    remarks: r.Remarks || '',
                    createdBy: r.CreatedBy || '',
                    lines: [],
                    qtyTotal: 0,
                    toSet: new Set(),
                    fromSet: new Set()
                });
            }
            const o = map.get(no);
            o.lines.push(r);
            o.qtyTotal += Number(r.AllottedQty) || 0;
            if (r.Division) o.toSet.add(r.Division);
            if (r.FromStore) o.fromSet.add(r.FromStore);
            if (!o.remarks && r.Remarks) o.remarks = r.Remarks;
            if (!o.createdBy && r.CreatedBy) o.createdBy = r.CreatedBy;
            if (!o.date && r.Date) o.date = String(r.Date).slice(0, 10);
        });
        return [...map.values()].sort((a, b) => {
            if (a.date !== b.date) return String(b.date).localeCompare(String(a.date));
            return String(b.allotmentNo).localeCompare(String(a.allotmentNo));
        });
    }

    function summaryMaterial(rows) {
        const map = new Map();
        rows.forEach((r) => {
            const code = String(r.MaterialCode || '—');
            if (!map.has(code)) {
                map.set(code, {
                    code,
                    description: r.MaterialDescription || '',
                    unit: r.Unit || '',
                    qty: 0,
                    lines: 0,
                    orders: new Set()
                });
            }
            const m = map.get(code);
            m.qty += Number(r.AllottedQty) || 0;
            m.lines += 1;
            m.orders.add(String(r.AllotmentNo || ''));
            if (!m.description && r.MaterialDescription) m.description = r.MaterialDescription;
            if (!m.unit && r.Unit) m.unit = r.Unit;
        });
        return [...map.values()]
            .map((m) => ({ ...m, orderCount: m.orders.size }))
            .sort((a, b) => b.qty - a.qty || a.code.localeCompare(b.code));
    }

    function summaryDivision(rows) {
        const map = new Map();
        rows.forEach((r) => {
            const div = String(r.Division || '—');
            if (!map.has(div)) {
                map.set(div, {
                    division: div,
                    qty: 0,
                    lines: 0,
                    orders: new Set(),
                    materials: new Set()
                });
            }
            const d = map.get(div);
            d.qty += Number(r.AllottedQty) || 0;
            d.lines += 1;
            d.orders.add(String(r.AllotmentNo || ''));
            if (r.MaterialCode) d.materials.add(String(r.MaterialCode));
        });
        return [...map.values()]
            .map((d) => ({
                ...d,
                orderCount: d.orders.size,
                materialCount: d.materials.size
            }))
            .sort((a, b) => b.qty - a.qty || a.division.localeCompare(b.division));
    }

    function summaryDate(rows) {
        const map = new Map();
        rows.forEach((r) => {
            const date = String(r.Date || '').slice(0, 10) || '—';
            if (!map.has(date)) {
                map.set(date, {
                    date,
                    qty: 0,
                    lines: 0,
                    orders: new Set()
                });
            }
            const d = map.get(date);
            d.qty += Number(r.AllottedQty) || 0;
            d.lines += 1;
            d.orders.add(String(r.AllotmentNo || ''));
        });
        return [...map.values()]
            .map((d) => ({ ...d, orderCount: d.orders.size }))
            .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    }

    function letterPadHtml() {
        return `<header class="letter-pad">
            <div class="letter-pad-org">West Bengal State Electricity Distribution Company Limited</div>
            <div class="letter-pad-sub">(A Govt. of W.B. Enterprise)</div>
            <div class="letter-pad-office">Zonal Office, Malda</div>
            <div class="letter-pad-addr">Administrative Building, 2nd Floor, Rabindra Avenue, Malda, WB-732101</div>
            <div class="letter-pad-contact">Ph: 03522-255035, e-mail: zm.malda@wbsedcl.in</div>
        </header>`;
    }

    function buildOrderLetterHtml(order) {
        const groups = {};
        order.lines.forEach((l) => {
            const key = String(l.FromStore || '') + '||' + String(l.Division || '');
            if (!groups[key]) groups[key] = { from: l.FromStore, to: l.Division, lines: [] };
            groups[key].lines.push(l);
        });
        const toNames = [...new Set(order.lines.map((r) => r.Division).filter(Boolean))];
        const toBlock = toNames.map((n) => `The Divisional Manager,<br>${escapeHtml(n)}`).join('<br><br>');
        const remarks = String(order.remarks || '').trim();
        const tables = Object.values(groups)
            .map((g) => {
                const kind = /zone/i.test(String(g.from || '')) ? 'Allotment' : 'Diversion';
                const body = g.lines
                    .map(
                        (line) => `<tr>
                        <td>${escapeHtml(line.MaterialCode)}</td>
                        <td>${escapeHtml(line.MaterialDescription)}</td>
                        <td>${formatQty(line.PresentStockDiv)}</td>
                        <td>${formatQty(line.AllottedQty)}</td>
                        <td>${escapeHtml(line.Unit || '')}</td>
                    </tr>`
                    )
                    .join('');
                return `<p class="letter-move"><strong>${kind}:</strong> ${escapeHtml(g.from)} → ${escapeHtml(g.to)}</p>
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

        return `<div class="letter-sheet">
            ${letterPadHtml()}
            <div class="letter-meta">
                <div><strong>Allotment No:</strong> ${escapeHtml(order.allotmentNo)}</div>
                <div><strong>Date:</strong> ${escapeHtml(order.date)}</div>
            </div>
            <p><strong>To</strong><br>${toBlock || '—'}</p>
            <p><strong>Sub:</strong> Allotment / diversion of materials.</p>
            <p>The following materials are hereby allotted / diverted as detailed below.</p>
            ${remarks ? `<p>For the following purpose: <em>${escapeHtml(remarks)}</em></p>` : ''}
            ${tables}
            <p>${
                remarks ? 'This is issued for the purpose stated above. ' : ''
            }Kindly arrange to take delivery / update records accordingly and ensure timely utilization of the allotted materials.</p>
            <div class="sign-block">
                <div>Zonal Manager</div>
                <div>Malda Zone</div>
            </div>
            ${order.createdBy ? `<p class="letter-created">Created by: ${escapeHtml(order.createdBy)}</p>` : ''}
        </div>`;
    }

    function renderOrders() {
        const host = document.getElementById('allot-view-orders');
        if (!host) return;
        const orders = groupOrders(filteredRows);
        if (!orders.length) {
            host.innerHTML = '<p class="allot-view-empty">No allotment orders match the filters.</p>';
            document.getElementById('allot-view-detail').hidden = true;
            return;
        }
        host.innerHTML = `<table class="allot-view-table">
            <thead>
                <tr>
                    <th>Allotment No</th>
                    <th>Date</th>
                    <th>From</th>
                    <th>To</th>
                    <th>Lines</th>
                    <th>Qty</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>
                ${orders
                    .map((o) => {
                        const from = [...o.fromSet].map(shortName).join(', ');
                        const to = [...o.toSet].map(shortName).join(', ');
                        return `<tr data-no="${escapeHtml(o.allotmentNo)}" class="${
                            selectedNo === o.allotmentNo ? 'is-selected' : ''
                        }">
                            <td><strong>${escapeHtml(o.allotmentNo)}</strong></td>
                            <td>${escapeHtml(o.date)}</td>
                            <td>${escapeHtml(from)}</td>
                            <td>${escapeHtml(to)}</td>
                            <td>${o.lines.length}</td>
                            <td>${formatQty(o.qtyTotal)}</td>
                            <td><button type="button" class="allot-btn-secondary allot-view-open" data-no="${escapeHtml(
                                o.allotmentNo
                            )}">View</button></td>
                        </tr>`;
                    })
                    .join('')}
            </tbody>
        </table>`;

        host.querySelectorAll('.allot-view-open').forEach((btn) => {
            btn.addEventListener('click', () => openOrder(btn.getAttribute('data-no')));
        });
    }

    function openOrder(no) {
        selectedNo = no;
        const orders = groupOrders(filteredRows);
        const order = orders.find((o) => o.allotmentNo === no);
        const detail = document.getElementById('allot-view-detail');
        const letter = document.getElementById('allot-view-letter');
        if (!order || !detail || !letter) return;
        detail.hidden = false;
        letter.innerHTML = buildOrderLetterHtml(order);
        document.getElementById('allot-view-detail-title').textContent = no;
        renderOrders();
        detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function renderMaterialSummary() {
        const host = document.getElementById('allot-view-material-sum');
        if (!host) return;
        const rows = summaryMaterial(filteredRows);
        if (!rows.length) {
            host.innerHTML = '<p class="allot-view-empty">No data.</p>';
            return;
        }
        host.innerHTML = `<table class="allot-view-table">
            <thead>
                <tr>
                    <th>Material Code</th>
                    <th>Description</th>
                    <th>Unit</th>
                    <th>Total Qty</th>
                    <th>Lines</th>
                    <th>Orders</th>
                </tr>
            </thead>
            <tbody>
                ${rows
                    .map(
                        (r) => `<tr>
                    <td><strong>${escapeHtml(r.code)}</strong></td>
                    <td>${escapeHtml(r.description)}</td>
                    <td>${escapeHtml(r.unit)}</td>
                    <td>${formatQty(r.qty)}</td>
                    <td>${r.lines}</td>
                    <td>${r.orderCount}</td>
                </tr>`
                    )
                    .join('')}
            </tbody>
        </table>`;
    }

    function renderDivisionSummary() {
        const host = document.getElementById('allot-view-division-sum');
        if (!host) return;
        const rows = summaryDivision(filteredRows);
        if (!rows.length) {
            host.innerHTML = '<p class="allot-view-empty">No data.</p>';
            return;
        }
        host.innerHTML = `<table class="allot-view-table">
            <thead>
                <tr>
                    <th>Division (To)</th>
                    <th>Total Qty</th>
                    <th>Materials</th>
                    <th>Lines</th>
                    <th>Orders</th>
                </tr>
            </thead>
            <tbody>
                ${rows
                    .map(
                        (r) => `<tr>
                    <td><strong>${escapeHtml(r.division)}</strong></td>
                    <td>${formatQty(r.qty)}</td>
                    <td>${r.materialCount}</td>
                    <td>${r.lines}</td>
                    <td>${r.orderCount}</td>
                </tr>`
                    )
                    .join('')}
            </tbody>
        </table>`;
    }

    function renderDateSummary() {
        const host = document.getElementById('allot-view-date-sum');
        if (!host) return;
        const rows = summaryDate(filteredRows);
        if (!rows.length) {
            host.innerHTML = '<p class="allot-view-empty">No data.</p>';
            return;
        }
        host.innerHTML = `<table class="allot-view-table">
            <thead>
                <tr>
                    <th>Date</th>
                    <th>Orders</th>
                    <th>Lines</th>
                    <th>Total Qty</th>
                </tr>
            </thead>
            <tbody>
                ${rows
                    .map(
                        (r) => `<tr>
                    <td><strong>${escapeHtml(r.date)}</strong></td>
                    <td>${r.orderCount}</td>
                    <td>${r.lines}</td>
                    <td>${formatQty(r.qty)}</td>
                </tr>`
                    )
                    .join('')}
            </tbody>
        </table>`;
    }

    function updateKpis() {
        const orders = groupOrders(filteredRows);
        const elOrders = document.getElementById('allot-view-kpi-orders');
        const elLines = document.getElementById('allot-view-kpi-lines');
        const elQty = document.getElementById('allot-view-kpi-qty');
        if (elOrders) elOrders.textContent = String(orders.length);
        if (elLines) elLines.textContent = String(filteredRows.length);
        if (elQty) {
            const qty = filteredRows.reduce((s, r) => s + (Number(r.AllottedQty) || 0), 0);
            elQty.textContent = formatQty(qty);
        }
    }

    function renderAll() {
        filteredRows = applyLocalFilters(allRows);
        updateKpis();
        renderOrders();
        renderMaterialSummary();
        renderDivisionSummary();
        renderDateSummary();
        setTab(activeTab);
    }

    function setTab(tab) {
        activeTab = tab;
        document.querySelectorAll('.allot-view-tab').forEach((btn) => {
            btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
        });
        document.querySelectorAll('.allot-view-pane').forEach((pane) => {
            pane.hidden = pane.getAttribute('data-pane') !== tab;
        });
    }

    function fillDivisionFilter(rows) {
        const sel = document.getElementById('allot-view-division');
        if (!sel) return;
        const current = sel.value;
        const divs = [...new Set(rows.map((r) => r.Division).filter(Boolean))].sort();
        sel.innerHTML =
            '<option value="">All divisions</option>' +
            divs.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(shortName(d))}</option>`).join('');
        if (current && divs.includes(current)) sel.value = current;
    }

    async function loadRows() {
        showStatus('Loading allotments…', 'info');
        try {
            const res = await fetch('/api/stock/allotment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ action: 'listAllotments' })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.error || data.status === 'error') {
                const msg =
                    data.error ||
                    data.message ||
                    (res.status === 401
                        ? 'Please log in to the portal, then open View Allotments again.'
                        : res.status === 404
                          ? 'API not found (404). Restart/redeploy the Node server with the latest server.js.'
                          : `Load failed (${res.status})`);
                throw new Error(msg);
            }
            allRows = Array.isArray(data.rows) ? data.rows : [];
            fillDivisionFilter(allRows);
            selectedNo = '';
            document.getElementById('allot-view-detail').hidden = true;
            renderAll();
            showStatus(
                allRows.length ? `Loaded ${allRows.length} line(s) from the allotment ledger.` : 'No allotments saved yet.',
                allRows.length ? 'ok' : 'info'
            );
        } catch (err) {
            console.error(err);
            allRows = [];
            filteredRows = [];
            renderAll();
            const tip = /Invalid action|listAllotments/i.test(err.message || '')
                ? ' Redeploy Apps Script with the latest allotment_code.gs (New version).'
                : /404|API not found/i.test(err.message || '')
                  ? ' Restart/redeploy the Node server so /api/stock/allotment is available.'
                  : ' If this persists, redeploy Apps Script with the latest allotment_code.gs.';
            showStatus((err.message || 'Failed to load allotments.') + tip, 'error');
        }
    }

    async function downloadDetailPdf() {
        const letter = document.getElementById('allot-view-letter');
        if (!letter || !selectedNo) return;
        const jspdf = window.jspdf;
        if (!jspdf || !jspdf.jsPDF || typeof window.html2canvas !== 'function') {
            showStatus('PDF libraries not loaded.', 'error');
            return;
        }
        showStatus('Preparing PDF…', 'info');
        letter.classList.add('allot-letter-capture');
        const prevW = letter.style.width;
        letter.style.width = '720px';
        try {
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            const canvas = await window.html2canvas(letter, {
                scale: 2,
                backgroundColor: '#ffffff',
                useCORS: true,
                logging: false
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
            doc.save(`Allotment_${String(selectedNo).replace(/[^\w-]+/g, '_')}.pdf`);
            showStatus(`PDF downloaded for ${selectedNo}.`, 'ok');
        } catch (err) {
            console.error(err);
            showStatus(err.message || 'PDF failed.', 'error');
        } finally {
            letter.classList.remove('allot-letter-capture');
            letter.style.width = prevW;
        }
    }

    function openPanel() {
        if (window.MzoAllotmentAccess && !window.MzoAllotmentAccess.canUseAllotment()) {
            alert('Allotment viewing is restricted to authorised users only.');
            return;
        }
        document.getElementById('allot-view-overlay')?.classList.add('active');
        document.getElementById('allot-view-overlay')?.setAttribute('aria-hidden', 'false');
        loadRows();
    }

    function closePanel() {
        document.getElementById('allot-view-overlay')?.classList.remove('active');
        document.getElementById('allot-view-overlay')?.setAttribute('aria-hidden', 'true');
    }

    function bind() {
        if (bound) return;
        bound = true;
        if (window.MzoAllotmentAccess) window.MzoAllotmentAccess.applyAllotmentVisibility();

        document.getElementById('allot-view-btn')?.addEventListener('click', openPanel);
        document.getElementById('allot-view-close-btn')?.addEventListener('click', closePanel);
        document.getElementById('allot-view-done-btn')?.addEventListener('click', closePanel);
        document.getElementById('allot-view-refresh-btn')?.addEventListener('click', loadRows);
        document.getElementById('allot-view-pdf-btn')?.addEventListener('click', downloadDetailPdf);

        document.getElementById('allot-view-overlay')?.addEventListener('click', (e) => {
            if (e.target.id === 'allot-view-overlay') closePanel();
        });

        ['allot-view-q', 'allot-view-material', 'allot-view-from', 'allot-view-to', 'allot-view-division'].forEach(
            (id) => {
                document.getElementById(id)?.addEventListener('input', renderAll);
                document.getElementById(id)?.addEventListener('change', renderAll);
            }
        );

        document.getElementById('allot-view-clear-btn')?.addEventListener('click', () => {
            const q = document.getElementById('allot-view-q');
            const m = document.getElementById('allot-view-material');
            const f = document.getElementById('allot-view-from');
            const t = document.getElementById('allot-view-to');
            const d = document.getElementById('allot-view-division');
            if (q) q.value = '';
            if (m) m.value = '';
            if (f) f.value = '';
            if (t) t.value = '';
            if (d) d.value = '';
            selectedNo = '';
            document.getElementById('allot-view-detail').hidden = true;
            renderAll();
        });

        document.querySelectorAll('.allot-view-tab').forEach((btn) => {
            btn.addEventListener('click', () => setTab(btn.getAttribute('data-tab')));
        });
    }

    function init() {
        bind();
        if (window.MzoAllotmentAccess) window.MzoAllotmentAccess.applyAllotmentVisibility();
    }

    window.MzoAllotmentView = { init, openPanel, closePanel, refresh: loadRows };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})(window);
