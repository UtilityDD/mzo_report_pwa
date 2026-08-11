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
    let clientListCache = { at: 0, rows: null };
    const CLIENT_LIST_TTL_MS = 45 * 1000;

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

    function isCancelledRow(r) {
        return String(r && (r.Status || r.status) || '')
            .trim()
            .toLowerCase() === 'cancelled';
    }

    function activeRowsOnly(rows) {
        return (rows || []).filter((r) => !isCancelledRow(r));
    }

    function formatCancelStampDate(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (!isFinite(d.getTime())) return String(iso).slice(0, 10);
        return d.toLocaleDateString('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric'
        });
    }

    function canCancelAllotment() {
        if (window.MzoAllotmentAccess && typeof window.MzoAllotmentAccess.canCancelAllotment === 'function') {
            return !!window.MzoAllotmentAccess.canCancelAllotment();
        }
        return false;
    }

    function getPortalDisplayName() {
        if (window.MzoAllotmentAccess && typeof window.MzoAllotmentAccess.getPortalProfile === 'function') {
            const p = window.MzoAllotmentAccess.getPortalProfile() || {};
            return String(p.Name || p.name || p.Username || p.username || '').trim();
        }
        return '';
    }

    function hideCancelConfirmModal() {
        const modal = document.getElementById('allot-cancel-confirm-modal');
        if (!modal) return;
        modal.classList.remove('active');
        modal.setAttribute('hidden', '');
        modal.hidden = true;
        modal.style.removeProperty('display');
        modal.style.removeProperty('z-index');
        modal.style.removeProperty('position');
        modal.style.removeProperty('inset');
        modal.style.removeProperty('background');
    }

    /** Clean in-app confirm (not window.confirm). Resolves true if user confirms cancel. */
    function openCancelConfirmModal(allotmentNo, cancelledBy) {
        return new Promise((resolve) => {
            const modal = document.getElementById('allot-cancel-confirm-modal');
            const noEl = document.getElementById('allot-cancel-confirm-no');
            const byEl = document.getElementById('allot-cancel-confirm-by');
            const keepBtn = document.getElementById('allot-cancel-confirm-keep');
            const yesBtn = document.getElementById('allot-cancel-confirm-yes');
            if (!modal || !keepBtn || !yesBtn) {
                console.error('[allotment] Cancel confirm modal missing from DOM');
                resolve(false);
                return;
            }

            if (noEl) noEl.textContent = String(allotmentNo || '');
            if (byEl) {
                byEl.textContent = cancelledBy
                    ? `This will be recorded as cancelled by ${cancelledBy}.`
                    : 'This will be recorded against your login.';
            }

            let settled = false;
            const finish = (ok) => {
                if (settled) return;
                settled = true;
                keepBtn.removeEventListener('click', onKeep);
                yesBtn.removeEventListener('click', onYes);
                modal.removeEventListener('click', onBackdrop);
                document.removeEventListener('keydown', onKey);
                hideCancelConfirmModal();
                resolve(ok);
            };
            const onKeep = (e) => {
                e.preventDefault();
                e.stopPropagation();
                finish(false);
            };
            const onYes = (e) => {
                e.preventDefault();
                e.stopPropagation();
                finish(true);
            };
            const onBackdrop = (e) => {
                if (e.target === modal) finish(false);
            };
            const onKey = (e) => {
                if (e.key === 'Escape') finish(false);
            };

            keepBtn.addEventListener('click', onKeep);
            yesBtn.addEventListener('click', onYes);
            modal.addEventListener('click', onBackdrop);
            document.addEventListener('keydown', onKey);

            // Always mount on body above the View Allotments overlay
            document.body.appendChild(modal);
            modal.removeAttribute('hidden');
            modal.hidden = false;
            modal.classList.add('active');
            modal.style.setProperty('display', 'flex', 'important');
            modal.style.setProperty('position', 'fixed', 'important');
            modal.style.setProperty('inset', '0', 'important');
            modal.style.setProperty('z-index', '2147483646', 'important');
            modal.style.setProperty('background', 'rgba(15,23,42,0.65)', 'important');
            modal.style.setProperty('align-items', 'center', 'important');
            modal.style.setProperty('justify-content', 'center', 'important');
            try {
                yesBtn.focus();
            } catch (_) {}
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
                    date: String(r.Date || '').slice(0, 10) || String(r.CreatedAt || '').slice(0, 10),
                    remarks: r.Remarks || '',
                    createdBy: r.CreatedBy || '',
                    cancelled: false,
                    cancelledBy: '',
                    cancelledAt: '',
                    cancelReason: '',
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
            if (!o.date) {
                o.date = String(r.Date || '').slice(0, 10) || String(r.CreatedAt || '').slice(0, 10);
            }
            if (isCancelledRow(r)) {
                o.cancelled = true;
                if (r.CancelledBy) o.cancelledBy = r.CancelledBy;
                if (r.CancelledAt) o.cancelledAt = r.CancelledAt;
                if (r.CancelReason) o.cancelReason = r.CancelReason;
            }
        });
        return [...map.values()].sort((a, b) => {
            if (a.date !== b.date) return String(b.date).localeCompare(String(a.date));
            return String(b.allotmentNo).localeCompare(String(a.allotmentNo));
        });
    }

    /** Item rows keyed by material within a group (date / division / material). */
    function summarizeItemsInGroup(rows) {
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
                    orders: new Set(),
                    divisions: new Set()
                });
            }
            const row = map.get(code);
            row.qty += Number(r.AllottedQty) || 0;
            row.lines += 1;
            row.orders.add(String(r.AllotmentNo || ''));
            if (r.Division) row.divisions.add(r.Division);
            if (!row.description && r.MaterialDescription) row.description = r.MaterialDescription;
            if (!row.unit && r.Unit) row.unit = r.Unit;
        });
        return [...map.values()]
            .map((r) => ({
                ...r,
                orderCount: r.orders.size,
                divisionCount: r.divisions.size
            }))
            .sort((a, b) => a.code.localeCompare(b.code) || b.qty - a.qty);
    }

    /**
     * Grouped item-wise summaries for Material / Division / Date tabs.
     * groupBy: 'material' | 'division' | 'date'
     */
    function buildItemWiseGroups(rows, groupBy) {
        const buckets = new Map();
        (rows || []).forEach((r) => {
            let key;
            if (groupBy === 'division') {
                key = String(r.Division || '—');
            } else if (groupBy === 'date') {
                key = String(r.Date || '').slice(0, 10) || '—';
            } else {
                key = String(r.MaterialCode || '—');
            }
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(r);
        });

        const groups = [...buckets.entries()].map(([key, groupRows]) => {
            const items = summarizeItemsInGroup(groupRows);
            const qty = items.reduce((s, it) => s + (Number(it.qty) || 0), 0);
            const lines = items.reduce((s, it) => s + (Number(it.lines) || 0), 0);
            const orders = new Set();
            groupRows.forEach((r) => {
                if (r.AllotmentNo) orders.add(String(r.AllotmentNo));
            });
            let title = key;
            let subtitle = '';
            let unit = '';
            if (groupBy === 'material') {
                const first = items[0] || {};
                title = key;
                subtitle = first.description || '';
                unit = first.unit || '';
            } else if (groupBy === 'division') {
                title = shortName(key);
            }
            return {
                key,
                title,
                subtitle,
                unit,
                items,
                qty,
                lines,
                orderCount: orders.size
            };
        });

        if (groupBy === 'date') {
            groups.sort((a, b) => String(b.key).localeCompare(String(a.key)));
        } else if (groupBy === 'division') {
            groups.sort((a, b) => a.title.localeCompare(b.title));
        } else {
            groups.sort((a, b) => a.key.localeCompare(b.key));
        }
        return groups;
    }

    function formatSummaryQty(code, qty) {
        if (window.MzoStockPoleCount && typeof MzoStockPoleCount.formatStockWithNo === 'function') {
            return MzoStockPoleCount.formatStockWithNo(code, qty, { maximumFractionDigits: 3 });
        }
        return formatQty(qty);
    }

    function formatLoadClock(ts) {
        const d = ts instanceof Date ? ts : new Date(ts);
        if (!isFinite(d.getTime())) return '—';
        return d.toLocaleString(undefined, {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        });
    }

    function setRefreshBusy(busy) {
        const btn = document.getElementById('allot-view-refresh-btn');
        if (!btn) return;
        btn.disabled = !!busy;
        btn.setAttribute('aria-busy', busy ? 'true' : 'false');
        btn.textContent = busy ? 'Refreshing…' : 'Refresh now';
    }

    function updateLoadTag(opts) {
        const el = document.getElementById('allot-view-load-tag');
        if (!el) return;
        const at = opts && opts.at != null ? opts.at : clientListCache.at;
        const count = opts && opts.count != null ? opts.count : allRows.length;
        const cached = !!(opts && opts.cached);
        const loading = !!(opts && opts.loading);
        if (loading) {
            el.innerHTML = '<strong>Loading…</strong> <span class="allot-view-load-muted">Fetching allotment lines</span>';
            return;
        }
        if (!at) {
            el.textContent = 'Not loaded yet';
            return;
        }
        const srcLabel = cached ? ' · cached' : '';
        el.innerHTML =
            `<strong>${count}</strong> line${count === 1 ? '' : 's'} · ` +
            `Updated <strong>${escapeHtml(formatLoadClock(at))}</strong>` +
            `<span class="allot-view-load-muted">${escapeHtml(srcLabel)}</span>`;
    }

    function letterPadHtml() {
        return `<header class="letter-pad">
            <div class="letter-pad-row">
                <img class="letter-pad-logo" src="/icons/logo.png" alt="WBSEDCL" width="72" height="90" />
                <div class="letter-pad-text">
                    <div class="letter-pad-org">West Bengal State Electricity Distribution Company Limited</div>
                    <div class="letter-pad-sub">(A Govt. of W.B. Enterprise)</div>
                    <div class="letter-pad-office">Zonal Office, Malda</div>
                    <div class="letter-pad-addr">Administrative Building, 2nd Floor, Rabindra Avenue, Malda, WB-732101</div>
                    <div class="letter-pad-contact">Ph: 03522-255035, e-mail: zm.malda@wbsedcl.in</div>
                </div>
            </div>
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

        const stamp = order.cancelled
            ? `<div class="letter-cancel-stamp" aria-hidden="true">
                <div class="letter-cancel-stamp-inner">
                    <div class="letter-cancel-stamp-title">CANCELLED</div>
                    <div class="letter-cancel-stamp-by">by ${escapeHtml(order.cancelledBy || '—')}</div>
                    ${
                        order.cancelledAt
                            ? `<div class="letter-cancel-stamp-date">${escapeHtml(
                                  formatCancelStampDate(order.cancelledAt)
                              )}</div>`
                            : ''
                    }
                </div>
            </div>`
            : '';

        return `<div class="letter-sheet${order.cancelled ? ' is-cancelled' : ''}">
            ${stamp}
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
            ${
                order.cancelled
                    ? `<p class="letter-cancelled-note">This allotment was cancelled${
                          order.cancelledBy ? ` by ${escapeHtml(order.cancelledBy)}` : ''
                      }${
                          order.cancelledAt
                              ? ` on ${escapeHtml(formatCancelStampDate(order.cancelledAt))}`
                              : ''
                      }.</p>`
                    : ''
            }
        </div>`;
    }

    function updateCancelButton(order) {
        const btn = document.getElementById('allot-view-cancel-btn');
        if (!btn) return;
        const show = !!(order && !order.cancelled && canCancelAllotment());
        if (show) {
            btn.removeAttribute('hidden');
            btn.hidden = false;
            btn.disabled = false;
            btn.style.removeProperty('display');
        } else {
            btn.setAttribute('hidden', '');
            btn.hidden = true;
            btn.disabled = true;
        }
        btn.title = show
            ? 'Cancel this allotment permanently (cannot be reverted)'
            : order && order.cancelled
              ? 'Already cancelled — cannot be reverted'
              : 'Cancel requires Stock Allot Cancel authorisation';
    }

    function renderOrders() {
        const host = document.getElementById('allot-view-orders');
        if (!host) return;
        const orders = groupOrders(filteredRows);
        if (!orders.length) {
            host.innerHTML = '<p class="allot-view-empty">No allotment orders match the filters.</p>';
            document.getElementById('allot-view-detail').hidden = true;
            updateCancelButton(null);
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
                        const rowClass = [
                            selectedNo === o.allotmentNo ? 'is-selected' : '',
                            o.cancelled ? 'is-cancelled' : ''
                        ]
                            .filter(Boolean)
                            .join(' ');
                        const noCell = o.cancelled
                            ? `<strong>${escapeHtml(o.allotmentNo)}</strong> <span class="allot-cancelled-badge">Cancelled</span>`
                            : `<strong>${escapeHtml(o.allotmentNo)}</strong>`;
                        const actions = `<button type="button" class="allot-btn-secondary allot-view-open" data-no="${escapeHtml(
                            o.allotmentNo
                        )}">View</button>${
                            !o.cancelled && canCancelAllotment()
                                ? ` <button type="button" class="allot-btn-danger allot-view-cancel-row" data-no="${escapeHtml(
                                      o.allotmentNo
                                  )}">Cancel</button>`
                                : ''
                        }`;
                        return `<tr data-no="${escapeHtml(o.allotmentNo)}" class="${rowClass}">
                            <td>${noCell}</td>
                            <td>${escapeHtml(o.date)}</td>
                            <td>${escapeHtml(from)}</td>
                            <td>${escapeHtml(to)}</td>
                            <td>${o.lines.length}</td>
                            <td>${formatQty(o.qtyTotal)}</td>
                            <td class="allot-view-actions">${actions}</td>
                        </tr>`;
                    })
                    .join('')}
            </tbody>
        </table>`;

        host.querySelectorAll('.allot-view-open').forEach((btn) => {
            btn.addEventListener('click', () => openOrder(btn.getAttribute('data-no')));
        });
        host.querySelectorAll('.allot-view-cancel-row').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const no = btn.getAttribute('data-no');
                if (!no) return;
                openOrder(no);
                await cancelSelectedAllotment(e);
            });
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
        updateCancelButton(order);
        renderOrders();
        detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function itemRowsHtml(items, opts) {
        const showDivisions = !!(opts && opts.showDivisions);
        return items
            .map((it) => {
                const qtyLabel = formatSummaryQty(it.code, it.qty);
                return `<tr>
                    <td><strong>${escapeHtml(it.code)}</strong></td>
                    <td>${escapeHtml(it.description || '')}</td>
                    <td>${escapeHtml(it.unit || '')}</td>
                    <td class="allot-view-num">${escapeHtml(qtyLabel)}</td>
                    <td class="allot-view-num">${it.orderCount}</td>
                    ${
                        showDivisions
                            ? `<td class="allot-view-num">${it.divisionCount || 0}</td>`
                            : ''
                    }
                </tr>`;
            })
            .join('');
    }

    function itemTableHtml(items, opts) {
        const showDivisions = !!(opts && opts.showDivisions);
        return `<table class="allot-view-table allot-view-item-table">
            <thead>
                <tr>
                    <th>Material</th>
                    <th>Description</th>
                    <th>Unit</th>
                    <th>Qty</th>
                    <th>Orders</th>
                    ${showDivisions ? '<th>Divisions</th>' : ''}
                </tr>
            </thead>
            <tbody>${itemRowsHtml(items, opts)}</tbody>
        </table>`;
    }

    /**
     * Item-wise summary tables for Material / Division / Date tabs.
     * Orders tab is unchanged. Qty is never mixed across materials in a total row.
     */
    function renderItemWiseSummary(host, rows, groupBy) {
        if (!host) return;
        const active = activeRowsOnly(rows || []);
        if (!active.length) {
            host.innerHTML = '<p class="allot-view-empty">No data.</p>';
            return;
        }

        if (groupBy === 'material') {
            const items = summarizeItemsInGroup(active);
            host.innerHTML = `<div class="allot-view-sum-block">
                <div class="allot-view-sum-head">
                    <div class="allot-view-sum-title">Item-wise total</div>
                    <div class="allot-view-sum-meta">${items.length} item${items.length === 1 ? '' : 's'}</div>
                </div>
                ${itemTableHtml(items, { showDivisions: true })}
            </div>`;
            return;
        }

        const groups = buildItemWiseGroups(active, groupBy);
        if (!groups.length) {
            host.innerHTML = '<p class="allot-view-empty">No data.</p>';
            return;
        }

        host.innerHTML = groups
            .map((g) => {
                const title =
                    groupBy === 'date'
                        ? escapeHtml(g.key)
                        : escapeHtml(g.title || g.key);
                const metaParts = [
                    `${g.orderCount} order${g.orderCount === 1 ? '' : 's'}`,
                    `${g.items.length} item${g.items.length === 1 ? '' : 's'}`
                ];
                return `<div class="allot-view-sum-block">
                    <div class="allot-view-sum-head">
                        <div class="allot-view-sum-title">${title}</div>
                        <div class="allot-view-sum-meta">${metaParts.join(' · ')}</div>
                    </div>
                    ${itemTableHtml(g.items, { showDivisions: false })}
                </div>`;
            })
            .join('');
    }

    function renderMaterialSummary() {
        renderItemWiseSummary(
            document.getElementById('allot-view-material-sum'),
            filteredRows,
            'material'
        );
    }

    function renderDivisionSummary() {
        renderItemWiseSummary(
            document.getElementById('allot-view-division-sum'),
            filteredRows,
            'division'
        );
    }

    function renderDateSummary() {
        renderItemWiseSummary(
            document.getElementById('allot-view-date-sum'),
            filteredRows,
            'date'
        );
    }

    function updateKpis() {
        const active = activeRowsOnly(filteredRows);
        const orders = groupOrders(active);
        const cancelledOrders = groupOrders(filteredRows).filter((o) => o.cancelled).length;
        const elOrders = document.getElementById('allot-view-kpi-orders');
        const elLines = document.getElementById('allot-view-kpi-lines');
        const elItems = document.getElementById('allot-view-kpi-items');
        if (elOrders) {
            elOrders.textContent = String(orders.length);
            elOrders.title =
                cancelledOrders > 0
                    ? `${orders.length} active · ${cancelledOrders} cancelled (excluded from KPI)`
                    : '';
        }
        if (elLines) elLines.textContent = String(active.length);
        if (elItems) {
            const items = new Set(
                active.map((r) => String(r.MaterialCode || '').trim()).filter(Boolean)
            );
            elItems.textContent = String(items.size);
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

    async function loadRows(opts) {
        const force = !!(opts && opts.force) || !!window.__allotViewNeedsRefresh;
        const now = Date.now();
        if (
            !force &&
            clientListCache.rows &&
            now - clientListCache.at < CLIENT_LIST_TTL_MS
        ) {
            allRows = clientListCache.rows;
            fillDivisionFilter(allRows);
            selectedNo = '';
            document.getElementById('allot-view-detail').hidden = true;
            renderAll();
            updateLoadTag({ at: clientListCache.at, count: allRows.length, cached: true, source: clientListCache.source });
            showStatus('');
            return;
        }

        showStatus('');
        setRefreshBusy(true);
        updateLoadTag({ loading: true });
        try {
            const res = await fetch('/api/stock/allotment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ action: 'listAllotments', force })
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
            clientListCache = { at: Date.now(), rows: allRows, source: data.source || '' };
            window.__allotViewNeedsRefresh = false;
            fillDivisionFilter(allRows);
            selectedNo = '';
            document.getElementById('allot-view-detail').hidden = true;
            renderAll();
            updateLoadTag({
                at: clientListCache.at,
                count: allRows.length,
                cached: false,
                source: clientListCache.source
            });
            if (!allRows.length) {
                showStatus('No allotments saved yet.', 'info');
            } else {
                showStatus('');
            }
        } catch (err) {
            console.error(err);
            allRows = [];
            filteredRows = [];
            renderAll();
            updateLoadTag({ at: 0 });
            const tip = /Invalid action|listAllotments/i.test(err.message || '')
                ? ' Redeploy Apps Script with the latest allotment_code.gs (New version).'
                : /404|API not found/i.test(err.message || '')
                  ? ' Restart/redeploy the Node server so /api/stock/allotment is available.'
                  : '';
            showStatus((err.message || 'Failed to load allotments.') + tip, 'error');
        } finally {
            setRefreshBusy(false);
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
        letter.style.width = '640px';
        try {
            const imgs = Array.from(letter.querySelectorAll('img'));
            await Promise.all(
                imgs.map(
                    (img) =>
                        img.complete
                            ? Promise.resolve()
                            : new Promise((resolve) => {
                                  img.onload = () => resolve();
                                  img.onerror = () => resolve();
                              })
                )
            );
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            const canvas = await window.html2canvas(letter, {
                scale: 2.5,
                backgroundColor: '#ffffff',
                useCORS: true,
                allowTaint: true,
                logging: false
            });
            const imgData = canvas.toDataURL('image/png');
            const doc = new jspdf.jsPDF({ unit: 'pt', format: 'a4' });
            const pageW = doc.internal.pageSize.getWidth();
            const pageH = doc.internal.pageSize.getHeight();
            const margin = 28;
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
            const suffix = letter.querySelector('.letter-sheet.is-cancelled') ? '_CANCELLED' : '';
            doc.save(`Allotment_${String(selectedNo).replace(/[^\w-]+/g, '_')}${suffix}.pdf`);
            showStatus(`PDF downloaded for ${selectedNo}.`, 'ok');
        } catch (err) {
            console.error(err);
            showStatus(err.message || 'PDF failed.', 'error');
        } finally {
            letter.classList.remove('allot-letter-capture');
            letter.style.width = prevW;
        }
    }

    async function cancelSelectedAllotment(ev) {
        if (ev) {
            ev.preventDefault();
            ev.stopPropagation();
        }
        if (!selectedNo) return;

        if (window.MzoAllotmentAccess && typeof window.MzoAllotmentAccess.refreshPortalProfile === 'function') {
            try {
                await window.MzoAllotmentAccess.refreshPortalProfile();
            } catch (_) {}
        }

        if (!canCancelAllotment()) {
            showStatus(
                'You are not authorised to cancel allotments. Ask an admin to enable Stock Allot Cancel.',
                'error'
            );
            updateCancelButton(
                groupOrders(filteredRows).find((o) => o.allotmentNo === selectedNo) || null
            );
            return;
        }

        const orders = groupOrders(filteredRows);
        const order = orders.find((o) => o.allotmentNo === selectedNo);
        if (!order || order.cancelled) return;

        const who = getPortalDisplayName() || 'you';
        const confirmed = await openCancelConfirmModal(selectedNo, who);
        if (!confirmed) return;

        const btn = document.getElementById('allot-view-cancel-btn');
        if (btn) btn.disabled = true;
        showStatus('Cancelling allotment…', 'info');
        try {
            const res = await fetch('/api/stock/allotment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({
                    action: 'cancelAllotment',
                    allotmentNo: selectedNo,
                    cancelledBy: who
                })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.error || data.status === 'error') {
                throw new Error(data.error || data.message || `Cancel failed (${res.status})`);
            }
            clientListCache = { at: 0, rows: null };
            window.__allotViewNeedsRefresh = true;
            const cancelledNo = selectedNo;
            await loadRows({ force: true });
            if (cancelledNo) openOrder(cancelledNo);
            showStatus(
                data.alreadyCancelled
                    ? `${cancelledNo} was already cancelled (cannot be reverted).`
                    : `Cancelled ${cancelledNo}. This cannot be reverted.`,
                'ok'
            );
        } catch (err) {
            console.error(err);
            showStatus(err.message || 'Cancel failed.', 'error');
            updateCancelButton(order);
        }
    }

    async function openPanel() {
        const overlay = document.getElementById('allot-view-overlay');
        if (!overlay) return;
        document.body.appendChild(overlay);
        if (window.MzoAllotPanelDrag) window.MzoAllotPanelDrag.reset(overlay);
        overlay.classList.add('active');
        overlay.setAttribute('aria-hidden', 'false');
        overlay.style.setProperty('display', 'flex', 'important');
        overlay.style.setProperty('position', 'fixed', 'important');
        overlay.style.setProperty('inset', '0', 'important');
        overlay.style.setProperty('z-index', '2147483000', 'important');
        overlay.style.setProperty('background', 'rgba(15,23,42,0.55)', 'important');
        if (window.MzoAllotPanelDrag) window.MzoAllotPanelDrag.enable(overlay);
        if (window.MzoAllotmentAccess && typeof window.MzoAllotmentAccess.refreshPortalProfile === 'function') {
            try {
                await window.MzoAllotmentAccess.refreshPortalProfile();
            } catch (_) {}
        }
        loadRows({ force: !!window.__allotViewNeedsRefresh });
    }

    function closePanel() {
        const overlay = document.getElementById('allot-view-overlay');
        if (overlay) {
            overlay.classList.remove('active');
            overlay.setAttribute('aria-hidden', 'true');
            overlay.style.removeProperty('display');
            overlay.style.removeProperty('position');
            overlay.style.removeProperty('inset');
            overlay.style.removeProperty('z-index');
            overlay.style.removeProperty('background');
        }
    }

    function bind() {
        if (bound) return;
        bound = true;
        if (window.MzoAllotmentAccess) window.MzoAllotmentAccess.applyAllotmentVisibility();

        document.getElementById('allot-view-btn')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openPanel();
        });
        document.getElementById('allot-view-close-btn')?.addEventListener('click', closePanel);
        document.getElementById('allot-view-done-btn')?.addEventListener('click', closePanel);
        document.getElementById('allot-view-refresh-btn')?.addEventListener('click', () => loadRows({ force: true }));
        document.getElementById('allot-view-pdf-btn')?.addEventListener('click', downloadDetailPdf);
        document.getElementById('allot-view-cancel-btn')?.addEventListener('click', cancelSelectedAllotment);
        // No backdrop-dismiss on view either while debugging create panel conflict

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
