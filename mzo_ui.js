/* mzo_ui.js — helpers for pages built on the MZO UI kit (<html class="ui">).
 * No dependencies. Uses window.mzoDataHub and window.MzoScope when present.
 *
 *   Format   UI.n / inr / pct / esc / blank / date / fmtDate / days / age / title
 *   Data     UI.csv(text) → row objects · UI.load(key, render) · UI.refresh(btn, key, onText) · UI.office(code, name) · UI.regionName(s)
 *   Filters  UI.fill(select, values, allLabel) / mark / uniq / offices(rows) / lockScope · UI.facet · UI.sidePanel · UI.drill
 *   Views    UI.table(el, cfg) · UI.bar(v, max, label, tone) · UI.hist(el, rows, { onClick, active, tone }) · UI.line(el, cfg)
 *   Colour   UI.color(tone): 1–6 → categorical --mzo-c1…c6 · 'ok' | 'warn' | 'bad' → status marks · 'accent' · 'muted'
 *   Misc     UI.exportCsv(name, columns, rows) · UI.toast · UI.debounce · UI.copy · UI.drawer · UI.trapFocus(box) · UI.icon
 */
(function (w) {
  'use strict';

  /* ---------- formatting ---------- */
  var nf = new Intl.NumberFormat('en-IN');
  function n(x) { var v = Number(x); return isFinite(v) ? nf.format(v) : '—'; }
  function inr(x) {
    var v = Number(x) || 0, a = Math.abs(v);
    if (a >= 1e7) return '₹' + (v / 1e7).toFixed(a >= 1e9 ? 0 : 2) + ' Cr';
    if (a >= 1e5) return '₹' + (v / 1e5).toFixed(2) + ' L';
    if (a >= 1e3) return '₹' + (v / 1e3).toFixed(1) + 'K';
    return '₹' + nf.format(Math.round(v));
  }
  function pct(a, b, digits) { if (!b) return '—'; if (!a) return '0%'; var p = (a / b) * 100; return (p > 0 && p < 0.1 ? '<0.1' : p.toFixed(digits == null ? (p < 10 ? 1 : 0) : digits)) + '%'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function blank(v) { var s = String(v == null ? '' : v).trim(); return !s || /^\(?null\)?$/i.test(s) || s === '-' || /^n\/?a$/i.test(s); }

  // dd-mm-yyyy[ hh:mm], dd.mm.yyyy, dd/mm/yyyy, yyyy-mm-dd[ hh:mm:ss]
  function date(s, order) {
    if (s instanceof Date) return s;
    s = String(s == null ? '' : s).trim();
    if (blank(s)) return null;
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
    m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/);
    if (m) { var y = +m[3]; if (y < 100) y += 2000; var dd = order === 'mdy' ? +m[2] : +m[1], mm = order === 'mdy' ? +m[1] : +m[2]; return new Date(y, mm - 1, dd, +(m[4] || 0), +(m[5] || 0)); }
    var d = new Date(s);
    return isNaN(d) ? null : d;
  }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(d) { d = date(d); return d ? d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear() : '—'; }
  function days(d) { d = date(d); return d ? Math.max(0, Math.floor((Date.now() - d.getTime()) / 864e5)) : null; }
  function age(daysN) {
    if (daysN == null) return '—';
    if (daysN < 31) return daysN + 'd';
    if (daysN < 365) return Math.floor(daysN / 30.4) + 'mo';
    var y = Math.floor(daysN / 365), mo = Math.floor((daysN - y * 365) / 30.4);
    return y + 'y' + (mo ? ' ' + mo + 'mo' : '');
  }
  function title(s) {
    return String(s || '').toLowerCase().replace(/\b([a-z])/g, function (c) { return c.toUpperCase(); })
      .replace(/\b(Ii|Iii|Iv|Vi|Vii|Viii|Ix|Xi|Xii)\b/g, function (r) { return r.toUpperCase(); });
  }

  /* ---------- CSV (RFC 4180) ---------- */
  function csv(text) {
    if (Array.isArray(text)) return text;
    text = String(text || '');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    var rows = [], row = [], f = '', q = false, i = 0, c, len = text.length;
    for (; i < len; i++) {
      c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(f); f = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    if (!rows.length) return [];
    // A repeated header keeps both columns: the first keeps the name, later ones get _2, _3 (weekly has two
    // "Division" columns, the solar sheet three "APPL_NO").
    var seen = {}, head = rows[0].map(function (h) { h = h.trim(); var k = seen[h] = (seen[h] || 0) + 1; return k > 1 ? h + '_' + k : h; }), out = new Array(rows.length - 1);
    for (var r = 1; r < rows.length; r++) {
      var o = {}, cells = rows[r];
      for (var k = 0; k < head.length; k++) o[head[k]] = cells[k] != null ? cells[k] : '';
      out[r - 1] = o;
    }
    return out;
  }

  /* ---------- offices ---------- */
  // Region names: lib/offices.js canonRegion (Malda, Uttar Dinajpur, Dakshin Dinajpur; old names such as
  // Raiganj / Balurghat region are accepted), else MzoScope's fallback list.
  var officeCache = {};
  function office(code, name) {
    var raw = String(code == null ? '' : code).trim();
    var ck = raw + '|' + (name || '');
    if (officeCache[ck]) return officeCache[ck];
    var O = w.MzoOffices, S = w.MzoScope, o = null;
    if (O) {
      // lib/offices.js: every code form (6611101, C366111010, padded, known typos, division and region
      // offices) and every CCC spelling. A CCC name fills in when the code is missing or names only a division.
      var c = raw ? O.parseCode(raw) : null;
      if (!c || c.level !== 'ccc') {
        var nm = name ? O.parseCccName(name, c && c.division) : null;
        if (nm && nm.level === 'ccc' && (!c || !c.division || c.division === nm.division)) c = nm;
        else if ((!c || !c.region) && nm && nm.region) c = nm;
      }
      if (c && c.region) o = { region: c.region, division: c.division || '', ccc: c.ccc || '' };
    }
    var key = raw.replace(/\D/g, '');
    if (key.length > 7) key = key.slice(-7);
    if (!o && S) {
      o = (key && S.parentOfCcc(key)) || (name && S.parentOfCcc(String(name).replace(/\s*CCC.*$/i, '').trim())) || null;
      if (!o && key.length >= 4) {
        var div = S.divisionNameOf && S.divisionNameOf(key.slice(0, 4));
        if (div) {
          var reg = '';
          Object.keys(S.HIERARCHY || {}).forEach(function (r) { if (S.HIERARCHY[r].divisions && S.HIERARCHY[r].divisions[div]) reg = r; });
          o = { region: reg, division: div, ccc: '' };
        }
      }
      if (!o && key.length >= 3) {
        var r3 = '';
        Object.keys(S.HIERARCHY || {}).forEach(function (r) { if (S.HIERARCHY[r].prefix === key.slice(0, 3)) r3 = r; });
        if (r3) o = { region: r3, division: '', ccc: '' };
      }
    }
    o = o ? { region: o.region || '', division: o.division || '', ccc: o.ccc || '' } : { region: '', division: '', ccc: '' };
    return (officeCache[ck] = o);
  }
  function regionName(s) {
    if (s == null || !String(s).trim()) return title(s);
    var O = w.MzoOffices, S = w.MzoScope;
    var r = O && O.canonRegion ? O.canonRegion(s) : '';
    if (!r && O && !O.canonRegion) { var p = O.parseRegion(s); r = p && p.level === 'region' ? p.region : ''; }
    if (!O && S && S.regionNameOf) r = S.regionNameOf(s);
    return r || title(s);
  }

  /* ---------- data hub ---------- */
  // Paint from IndexedDB at once; re-render if the hub downloads a newer body.
  function load(key, render, opts) {
    var hub = w.mzoDataHub;
    if (!hub) { render(null, { error: true }); return Promise.resolve(); }
    var first;
    return Promise.resolve(hub._peek(key)).catch(function () { return null; }).then(function (c) {
      first = c;
      if (c) render(c, { cached: true });
      return Promise.resolve(hub.waitForDataset(key, opts)).catch(function () {});
    }).then(function () { return hub._peek(key); }).then(function (fresh) {
      if (fresh && fresh !== first) render(fresh, { cached: false });
      else if (!first) render(fresh || null, { error: !fresh });
    }).catch(function () { if (!first) render(null, { error: true }); });
  }
  // Refresh button: force a version check for `key`, then hand the stored body to onText.
  function refresh(btn, key, onText) {
    if (typeof btn === 'string') btn = document.getElementById(btn);
    if (!btn) return;
    ptrAdd(btn);
    btn.addEventListener('click', function () {
      var hub = w.mzoDataHub;
      if (!hub) return;
      btn.classList.add('spin');
      Promise.resolve(hub.waitForDataset(key, { forceCheck: true })).catch(function () {})
        .then(function () { return hub._peek(key); })
        .then(function (text) { if (text) onText(text); })
        .catch(function () {})
        .then(function () { btn.classList.remove('spin'); });
    });
  }

  /* ---------- selects / scope ---------- */
  function fill(sel, values, allLabel) {
    if (typeof sel === 'string') sel = document.getElementById(sel);
    if (!sel || sel.disabled) return;
    var cur = sel.value;
    var h = '<option value="">' + esc(allLabel) + '</option>';
    values.forEach(function (v) { var val = typeof v === 'object' ? v.value : v, lab = typeof v === 'object' ? v.label : v; h += '<option value="' + esc(val) + '">' + esc(lab) + '</option>'; });
    sel.innerHTML = h;
    if (cur && values.some(function (v) { return (typeof v === 'object' ? v.value : v) === cur; })) sel.value = cur;
    mark(sel);
  }
  function mark(sel) { if (sel) sel.classList.toggle('on', !!sel.value && !sel.disabled); }
  // Sorted distinct non-empty values of rows[k].
  function uniq(rows, k) { var s = {}; rows.forEach(function (r) { if (r[k]) s[r[k]] = 1; }); return Object.keys(s).sort(); }
  // Office selects #regionFilter → #divisionFilter → #cccFilter from rows (_region / _divn / _supp);
  // each list is narrowed by the choice above it.
  function offices(rows, regionLabel) {
    var val = function (id) { var el = document.getElementById(id); return el ? el.value : ''; };
    var reg = val('regionFilter'), div = val('divisionFilter');
    fill('regionFilter', uniq(rows, '_region'), regionLabel || 'All regions');
    var r1 = reg ? rows.filter(function (r) { return r._region === reg; }) : rows;
    fill('divisionFilter', uniq(r1, '_divn'), 'All divisions');
    fill('cccFilter', uniq(div ? r1.filter(function (r) { return r._divn === div; }) : r1, '_supp'), 'All CCCs');
  }
  // Login scope: pin and disable office selects (#regionFilter, #divisionFilter, #cccFilter).
  function lockScope() {
    var S = w.MzoScope;
    if (!S || S.isUnscoped()) return null;
    var sc = S.getScope() || {};
    var pin = function (id, val) {
      var el = document.getElementById(id);
      if (!el || !val) return;
      if (![].some.call(el.options, function (o) { return o.value === val; })) el.insertAdjacentHTML('beforeend', '<option value="' + esc(val) + '">' + esc(val) + '</option>');
      el.value = val; el.disabled = true; el.classList.remove('on');
    };
    var one = function (set) { return set && set.size === 1 ? Array.from(set)[0] : ''; };
    pin('regionFilter', sc.region || one(sc.regions));
    pin('divisionFilter', sc.division || one(sc.divisions));
    pin('cccFilter', sc.ccc || (sc.level === 'ccc' ? one(sc.cccs) : ''));
    return sc;
  }

  /* ---------- table ---------- */
  // cfg: { columns: [{ key, label, num, fmt(v,row) → html, sortVal(row), cls, hideSm, width, csv(row) }],
  //        rows, sort: { key, dir }, limit, resetPage, onRow(row), selected(row), foot, empty, count }
  // Sort and paging live on the element (el.__ui); set el.__ui = null when the column set changes.
  function table(el, cfg, _appendFrom) {
    if (typeof el === 'string') el = document.getElementById(el);
    var cols = cfg.columns;
    var colSig = cols.map(function (c) { return c.key; }).join('|');
    var lim = cfg.limit || 0;
    var st = el.__ui;
    if (!st || st.colSig !== colSig) {
      st = el.__ui = { colSig: colSig, sort: cfg.sort || null, limit: lim, shown: lim, rowsRef: null, sortedKey: '', sorted: null };
    } else if (!_appendFrom) {
      // Not on the incremental append: resetPage would put st.shown back to the first page, so "Show more"
      // and the scroll loader added nothing and the observer fired again forever.
      if (st.limit !== lim) { st.limit = lim; st.shown = lim; }
      else if (cfg.resetPage) st.shown = st.limit;
      if (st.sort && !cols.some(function (x) { return x.key === st.sort.key; })) st.sort = cfg.sort || null;
    }
    var sortKey = st.sort ? st.sort.key + ':' + st.sort.dir : '';
    var rows;
    // The sorted copy is reused only by the incremental append (same rows, same sort). A full render always
    // re-sorts, because a page may change its rows array in place between renders.
    if (_appendFrom && st.rowsRef === cfg.rows && st.sortedKey === sortKey && st.sorted && st.sorted.length === cfg.rows.length) {
      rows = st.sorted;
    } else {
      rows = cfg.rows.slice();
      if (st.sort) {
        var c = cols.filter(function (x) { return x.key === st.sort.key; })[0];
        if (c) {
          var dir = st.sort.dir === 'asc' ? 1 : -1;
          var val = c.sortVal || function (r) { return r[c.key]; };
          // Fast numeric path only when every value is a number or blank. Some num columns hold
          // formatted strings ("9.5%", "1,234"); Number() of those is NaN, so they keep the generic compare.
          var allNum = c.num && rows.every(function (r) { var v = val(r); return v == null || v === '' || typeof v === 'number'; });
          if (allNum) {
            rows.sort(function (a, b) { return ((Number(val(a)) || 0) - (Number(val(b)) || 0)) * dir; });
          } else {
            rows.sort(function (a, b) {
              var x = val(a), y = val(b);
              if (typeof x === 'number' || typeof y === 'number') return ((x || 0) - (y || 0)) * dir;
              return String(x || '').localeCompare(String(y || ''), 'en', { numeric: true }) * dir;
            });
          }
        }
      }
      st.rowsRef = cfg.rows;
      st.sortedKey = sortKey;
      st.sorted = rows;
    }
    var total = rows.length, view = st.shown ? rows.slice(0, st.shown) : rows;
    var cards = cfg.cards !== false;
    function rowHtml(r, i) {
      var rh = '<tr' + (cfg.onRow ? ' class="click' + (cfg.selected && cfg.selected(r) ? ' sel' : '') + '" data-i="' + i + '" tabindex="0"' : '') + '>';
      cols.forEach(function (c) {
        var v = r[c.key];
        rh += '<td class="' + (c.num ? 'num ' : '') + (c.cls || '') + (c.hideSm ? ' hide-sm' : '') + '"' + (cards ? ' data-l="' + esc(c.label) + '"' : '') + '>' + (c.fmt ? c.fmt(v, r) : esc(v == null || v === '' ? '—' : v)) + '</td>';
      });
      if (cfg.onRow) rh += '<td class="chev"><svg class="ui-i"><use href="#ui-chev"/></svg></td>';
      return rh + '</tr>';
    }
    function footBarHtml() {
      if (st.shown && total > st.shown) return '<div class="ui-panel-f" data-more-wrap><span>Showing ' + n(st.shown) + ' of ' + n(total) + '</span><button type="button" class="ui-btn sm" data-more>Show more</button></div>';
      if (cfg.count !== false && total > 12) return '<div class="ui-panel-f"><span>' + n(total) + ' rows</span></div>';
      return '';
    }
    st.view = view;
    // Fast incremental append when scrolling or clicking "Show more": only render the new slice.
    if (_appendFrom && _appendFrom > 0 && el.querySelector('tbody')) {
      var tb = el.querySelector('tbody');
      var addHtml = '';
      for (var ai = _appendFrom; ai < view.length; ai++) addHtml += rowHtml(view[ai], ai);
      tb.insertAdjacentHTML('beforeend', addHtml);
      var oldFoot = el.querySelector('.ui-panel-f');
      var newFoot = footBarHtml();
      var oldSpan = oldFoot && oldFoot.hasAttribute('data-more-wrap') && oldFoot.querySelector('span');
      if (oldSpan && newFoot && newFoot.indexOf('data-more-wrap') >= 0) {
        // Keep the same footer (and its "Show more" button) so a tap that lands mid-load still counts.
        oldSpan.textContent = 'Showing ' + n(st.shown) + ' of ' + n(total);
      } else if (oldFoot) {
        if (newFoot) oldFoot.outerHTML = newFoot; else oldFoot.remove();
      } else if (newFoot) {
        el.insertAdjacentHTML('beforeend', newFoot);
      }
      armLazy();
      return;
    }
    if (st.io) { st.io.disconnect(); st.io = null; }
    var h = '';
    if (cards) {
      var cur = st.sort && cols.some(function (x) { return x.key === st.sort.key; }) ? st.sort : null;
      h += '<div class="ui-sortbar"><label class="ui-chip on"><span class="ui-sr">Sort by</span><select data-sortby aria-label="Sort by">' +
        (cur ? '' : '<option value="">Sort: default</option>') +
        cols.map(function (c) { return '<option value="' + esc(c.key) + '"' + (cur && cur.key === c.key ? ' selected' : '') + '>Sort: ' + esc(c.label) + '</option>'; }).join('') +
        '</select></label>' +
        (cur ? '<button type="button" class="ui-chip" data-sortdir aria-label="' + (cur.dir === 'asc' ? 'Ascending, tap for descending' : 'Descending, tap for ascending') + '">' + (cur.dir === 'asc' ? '↑ Low first' : '↓ High first') + '</button>' : '') +
        '<span class="ui-sortbar-n">' + n(total) + (total === 1 ? ' row' : ' rows') + '</span></div>';
    }
    h += '<div class="ui-table-wrap"><table class="ui-table' + (cards ? ' ui-cardable' : '') + '"><thead><tr>';
    cols.forEach(function (c) {
      var s = st.sort && st.sort.key === c.key ? (st.sort.dir === 'asc' ? 'ascending' : 'descending') : '';
      h += '<th data-sort="' + c.key + '" tabindex="0" class="' + (c.num ? 'num ' : '') + (c.hideSm ? 'hide-sm' : '') + '"' + (s ? ' aria-sort="' + s + '"' : '') + (c.width ? ' style="width:' + c.width + '"' : '') + '>' + esc(c.label) + '</th>';
    });
    if (cfg.onRow) h += '<th class="chev" aria-hidden="true"></th>';
    h += '</tr></thead><tbody>';
    if (!view.length) h += '<tr><td colspan="' + (cols.length + (cfg.onRow ? 1 : 0)) + '"><div class="ui-empty">' + esc(cfg.empty || 'Nothing to show.') + '</div></td></tr>';
    for (var vi = 0; vi < view.length; vi++) h += rowHtml(view[vi], vi);
    h += '</tbody>';
    if (cfg.foot && view.length) {
      h += '<tfoot><tr>';
      cols.forEach(function (c, i) { var v = cfg.foot[c.key]; h += '<td class="' + (c.num ? 'num ' : '') + (c.hideSm ? 'hide-sm' : '') + '"' + (cards && i ? ' data-l="' + esc(c.label) + '"' : '') + '>' + (i === 0 && v == null ? 'Total' : v == null ? '' : (c.fmt ? c.fmt(v, cfg.foot) : esc(v))) + '</td>'; });
      if (cfg.onRow) h += '<td></td>';
      h += '</tr></tfoot>';
    }
    h += '</table></div>' + footBarHtml();
    el.innerHTML = h;
    function showMore() {
      if (!st.shown || st.shown >= total) return;
      var prev = st.shown;
      st.shown = Math.min(total, st.shown + st.limit);
      table(el, cfg, prev);
    }
    function armLazy() {
      if (st.io) { st.io.disconnect(); st.io = null; }
      if (!w.IntersectionObserver || !st.shown || total <= st.shown) return;
      var target = el.querySelector('[data-more-wrap]');
      if (!target) return;
      st.io = new IntersectionObserver(function (entries) {
        if (entries.some(function (en) { return en.isIntersecting; })) showMore();
      }, { rootMargin: '280px 0px' });
      st.io.observe(target);
    }
    armLazy();
    el.onchange = function (e) {
      var s = e.target.closest && e.target.closest('select[data-sortby]');
      if (!s) return;
      var col = cols.filter(function (x) { return x.key === s.value; })[0];
      st.sort = col ? { key: col.key, dir: col.num ? 'desc' : 'asc' } : null;
      if (st.limit) st.shown = st.limit;
      table(el, cfg);
    };
    el.onclick = function (e) {
      if (e.target.closest('[data-sortdir]') && st.sort) { st.sort = { key: st.sort.key, dir: st.sort.dir === 'asc' ? 'desc' : 'asc' }; if (st.limit) st.shown = st.limit; table(el, cfg); return; }
      var th = e.target.closest('th[data-sort]');
      if (th) {
        var k = th.getAttribute('data-sort'), col = cols.filter(function (x) { return x.key === k; })[0];
        st.sort = st.sort && st.sort.key === k ? { key: k, dir: st.sort.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: col && col.num ? 'desc' : 'asc' };
        if (st.limit) st.shown = st.limit;
        table(el, cfg); return;
      }
      if (e.target.closest('[data-more]')) { showMore(); return; }
      var tr = e.target.closest('tr[data-i]');
      if (tr && cfg.onRow && st.view) cfg.onRow(st.view[+tr.getAttribute('data-i')], e);
    };
    // Keyboard: Enter or Space on a focused header sorts it, on a focused row opens it.
    el.onkeydown = function (e) {
      if ((e.key !== 'Enter' && e.key !== ' ') || !e.target.matches('th[data-sort], tr[data-i]')) return;
      e.preventDefault();
      var key = e.target.getAttribute('data-sort');
      el.onclick({ target: e.target, metaKey: e.metaKey, ctrlKey: e.ctrlKey });
      if (key) { var th = el.querySelector('th[data-sort="' + key + '"]'); if (th) th.focus(); }
    };
  }

  /* ---------- colour ----------
   * One palette for every chart (tokens in mzo_theme.css). Categorical slots carry identity and are
   * never cycled: past six a series goes muted. Status colours carry state and always sit beside a label. */
  var SLOTS = 6;
  function color(t) {
    if (t == null || t === '') return '';
    if (typeof t === 'number' || /^\d+$/.test(t)) { t = +t; return t >= 1 && t <= SLOTS ? 'var(--mzo-c' + t + ')' : 'var(--mzo-chart-muted)'; }
    if (t === 'ok' || t === 'warn' || t === 'bad') return 'var(--mzo-' + t + '-mark)';
    if (t === 'accent' || t === 'muted') return t === 'accent' ? 'var(--mzo-accent)' : 'var(--mzo-chart-muted)';
    return String(t).replace(/[^#\w(),.%\s-]/g, '');
  }

  // Share / progress bar for a table cell. tone: see color() (default: slot 1).
  function bar(v, max, label, tone) {
    var w2 = max > 0 ? Math.max(v > 0 ? 2 : 0, Math.round((v / max) * 100)) : 0;
    return '<div class="ui-bar"' + (tone ? ' style="--bar:' + color(tone) + '"' : '') + '><i><b style="width:' + w2 + '%"></b></i>' + (label != null ? '<span>' + esc(label) + '</span>' : '') + '</div>';
  }

  // rows: [{ label, value, key, tone }] · opts.tone colours every bar (default: slot 1)
  function hist(el, rows, opts) {
    if (typeof el === 'string') el = document.getElementById(el);
    opts = opts || {};
    var max = Math.max.apply(null, rows.map(function (r) { return r.value; }).concat([0]));
    el.className = 'ui-hist';
    if (opts.tone) el.style.setProperty('--bar', color(opts.tone)); else el.style.removeProperty('--bar');
    el.innerHTML = rows.map(function (r, i) {
      var on = opts.active != null && opts.active === r.key;
      return '<div class="row' + (opts.onClick ? ' click' : '') + (on ? ' on' : '') + '" data-i="' + i + '"><span title="' + esc(r.label) + '">' + esc(r.label) + '</span><i><b style="width:' + (max ? Math.max(r.value ? 1.5 : 0, (r.value / max) * 100) : 0) + '%' + (r.tone ? ';--bar:' + color(r.tone) : '') + '"></b></i><span>' + n(r.value) + '</span></div>';
    }).join('');
    el.onclick = opts.onClick ? function (e) { var row = e.target.closest('.row'); if (row) opts.onClick(rows[+row.getAttribute('data-i')]); } : null;
  }

  /* ---------- filter side panel ----------
   * UI.facet(el, opts, value, onChange): toggle options with counts.
   *   opts: [{ value, label, count, dot }] — clicking the chosen option again clears it (onChange('')).
   *   dot: 'ok' | 'warn' | 'bad' | 'accent' | 'c1'…'c6' draws a small status / identity dot before the label.
   * UI.sidePanel({ side, toggle, label, count, clear, onClear }): wires the panel header,
   *   the narrow-screen toggle, and returns setActive(n) to show "n on". */
  function facet(el, opts, value, onChange) {
    if (typeof el === 'string') el = document.getElementById(el);
    if (!el) return;
    el.classList.add('ui-opts');
    el.setAttribute('role', 'radiogroup');
    var cur = value == null ? '' : String(value);
    el.innerHTML = opts.map(function (o) {
      var on = cur !== '' && cur === String(o.value);
      return '<button type="button" class="ui-opt' + (o.count || on ? '' : ' zero') + '" role="radio" aria-checked="' + on + '" data-v="' + esc(o.value) + '"><i></i>' + (o.dot ? '<span class="ui-dot ' + esc(o.dot) + '"></span>' : '') + '<span title="' + esc(o.label) + '">' + esc(o.label) + '</span>' + (o.count != null ? '<small>' + n(o.count) + '</small>' : '') + '</button>';
    }).join('');
    el.onclick = function (e) {
      var b = e.target.closest('.ui-opt'); if (!b) return;
      var v = b.getAttribute('data-v');
      onChange(cur === v ? '' : v);
    };
  }
  function sidePanel(cfg) {
    var $id = function (x) { return typeof x === 'string' ? document.getElementById(x) : x; };
    var side = $id(cfg.side), toggle = $id(cfg.toggle), label = $id(cfg.label), count = $id(cfg.count), clear = $id(cfg.clear);
    if (!side) return function () {};
    var layout = side.closest ? side.closest('.ui-layout') : side.parentElement;

    // Phones: the panel is a bottom sheet (scrim, drag handle, "Show results", Android Back closes it).
    // Wider screens keep the inline panel; the extra parts are hidden there by CSS.
    side.classList.add('ui-sheet');
    if (!side.querySelector(':scope > .ui-sheet-grab')) {
      side.insertAdjacentHTML('afterbegin', '<div class="ui-sheet-grab" aria-hidden="true"><i></i></div>');
      side.insertAdjacentHTML('beforeend', '<div class="ui-sheet-foot"><button type="button" class="ui-btn primary" data-sheet-done>Show results</button></div>');
    }

    // Desktop: ensure a close button exists in the panel header (.ui-side-h)
    var sideH = side.querySelector(':scope > .ui-side-h');
    if (sideH && !sideH.querySelector('.ui-side-close, [data-side-close], #sideCloseBtn')) {
      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'ui-btn icon ghost sm ui-side-close';
      closeBtn.setAttribute('data-side-close', '');
      closeBtn.setAttribute('aria-label', 'Hide filters');
      closeBtn.title = 'Hide filter panel';
      closeBtn.innerHTML = '<svg class="ui-i"><use href="#ui-x"/></svg>';
      sideH.appendChild(closeBtn);
    }

    // Filter panel remains hidden by default on desktop
    if (!phone() && layout) {
      layout.classList.add('side-collapsed');
      side.classList.remove('open');
    }

    function isShown() {
      if (phone()) return side.classList.contains('open');
      return layout ? !layout.classList.contains('side-collapsed') : side.classList.contains('open');
    }

    function setOpen(open) {
      var asSheet = phone();
      if (asSheet) {
        if (open === side.classList.contains('open')) return;
        side.classList.toggle('open', open);
        if (toggle) {
          toggle.setAttribute('aria-expanded', String(open));
          toggle.classList.toggle('is-active', open);
        }
        sheetOn(open ? side : null, function () { setOpen(false); });
        if (open) { side.scrollTop = 0; backOpen(function () { setOpen(false); }); }
        else { backDone(); if (toggle && side.contains(document.activeElement)) try { toggle.focus({ preventScroll: true }); } catch (e) {} }
      } else {
        // Desktop / widescreen: in-flow toggleable panel
        if (layout) {
          layout.classList.toggle('side-collapsed', !open);
        }
        side.classList.toggle('open', open);
        if (toggle) {
          toggle.setAttribute('aria-expanded', String(open));
          toggle.classList.toggle('is-active', open);
        }
      }
    }

    if (toggle) {
      var initOpen = isShown();
      toggle.setAttribute('aria-expanded', String(initOpen));
      toggle.classList.toggle('is-active', initOpen);
      toggle.addEventListener('click', function (e) {
        e.stopPropagation();
        setOpen(!isShown());
      });
    }

    side.addEventListener('click', function (e) {
      if (e.target.closest('[data-sheet-done]')) setOpen(false);
      if (e.target.closest('.ui-side-close, [data-side-close], #sideCloseBtn')) {
        e.stopPropagation();
        setOpen(false);
      }
    });

    dragToClose(side, side.querySelectorAll(':scope > .ui-sheet-grab, :scope > .ui-side-h'), function () { return phone() && side.classList.contains('open'); }, function () { setOpen(false); });
    if (clear && cfg.onClear) clear.addEventListener('click', cfg.onClear);

    // Keyboard shortcut 'F' on desktop toggles filters unless typing
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'f' || e.key === 'F') && !phone() && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
        var t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        e.preventDefault();
        setOpen(!isShown());
      }
    });
    // Tabbed groups: <div class="ui-seg ui-side-tabs" data-tabs> <button data-pane="id">…
    [].forEach.call(side.querySelectorAll('[data-tabs]'), function (tabs) {
      tabs.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-pane]'); if (!b) return;
        [].forEach.call(tabs.querySelectorAll('button[data-pane]'), function (x) { var on = x === b; x.setAttribute('aria-pressed', String(on)); x.setAttribute('aria-selected', String(on)); var pane = document.getElementById(x.getAttribute('data-pane')); if (pane) pane.hidden = !on; });
      });
    });
    return function setActive(nOn, tabsState) {
      if (label) label.textContent = nOn ? nOn + ' on' : '';
      if (count) count.textContent = nOn ? ' · ' + nOn : '';
      if (clear) clear.disabled = !nOn;
      if (tabsState) Object.keys(tabsState).forEach(function (pane) { var b = side.querySelector('button[data-pane="' + pane + '"]'); if (b) b.classList.toggle('has', !!tabsState[pane]); });
    };
  }

  /* ---------- detailed report: one table that walks Region → Division → CCC (→ …) → list ----------
   * UI.drill({ el, levels, lists, root, onChange }) → api
   *   el      host for the level tabs and the office trail (inside the table's panel)
   *   levels  group levels [{ k, label, field }]; default region/_region, division/_divn, ccc/_supp
   *   lists   row-level tabs after the groups [{ k, label }]; default [{ k: 'list', label: 'Applications' }]
   * The office path is the progressive filter: rows match through api.match(r). A login scope pins the
   * levels it covers (shown in the trail, not clickable) and the report starts one level below. */
  var OFFICE_LEVELS = [{ k: 'region', label: 'Region', field: '_region' }, { k: 'division', label: 'Division', field: '_divn' }, { k: 'ccc', label: 'CCC', field: '_supp' }];
  function drill(cfg) {
    var host = typeof cfg.el === 'string' ? document.getElementById(cfg.el) : cfg.el;
    var levels = cfg.levels || OFFICE_LEVELS, lists = cfg.lists || [{ k: 'list', label: 'Applications' }];
    var steps = levels.concat(lists), path = {}, pins = {}, start = 0, counts = {};
    var S = w.MzoScope;
    if (S && !S.isUnscoped()) {
      var sc = S.getScope() || {}, one = function (set) { return set && set.size === 1 ? Array.from(set)[0] : ''; };
      var pin = { region: sc.region || one(sc.regions), division: sc.division || one(sc.divisions), ccc: sc.ccc || (sc.level === 'ccc' ? one(sc.cccs) : '') };
      levels.forEach(function (l, i) { if (pin[l.k]) { pins[l.k] = pin[l.k]; start = i + 1; } });
    }
    start = Math.min(start, steps.length - 1);
    var level = steps[start].k;
    function idx(k) { for (var i = 0; i < steps.length; i++) if (steps[i].k === k) return i; return -1; }
    function changed() { if (cfg.onChange) cfg.onChange(); }
    function valueOf(r, l) { return r[l.field] || 'Unmapped'; }
    var api = {
      level: function () { return level; },
      isList: function () { return idx(level) >= levels.length; },
      label: function () { return steps[idx(level)].label; },
      // Group key of a row at the current level, and the parent shown under it when the path does not already say it.
      key: function (r) { return valueOf(r, steps[idx(level)]); },
      parent: function (r) { var i = idx(level) - 1; return i >= 0 && i < levels.length && !path[levels[i].k] && !pins[levels[i].k] ? (r[levels[i].field] || '') : ''; },
      where: function () { var last = ''; levels.forEach(function (l) { if (path[l.k]) last = path[l.k]; else if (!last && pins[l.k]) last = pins[l.k]; }); return last; },
      match: function (r) {
        for (var i = 0; i < levels.length; i++) { var p = path[levels[i].k]; if (p && valueOf(r, levels[i]) !== p) return false; }
        return true;
      },
      // A row at a group level opens the next level for that group; `row` fills the parents the path skipped.
      open: function (name, row) {
        var i = idx(level); if (i >= levels.length) return;
        for (var j = start; j < i; j++) if (row && !path[levels[j].k]) path[levels[j].k] = valueOf(row, levels[j]);
        path[level] = name; level = steps[i + 1].k; changed();
      },
      // A tab: a group tab lists that level inside the path above it; a list tab keeps the whole path.
      go: function (k, quiet) {
        var i = idx(k); if (i < start) return;
        for (var j = i; j < levels.length; j++) delete path[levels[j].k];
        level = k; if (!quiet) changed();
      },
      // A trail crumb: keep the path through `k` ('' = the top) and list the level below it.
      up: function (k) {
        var i = k ? idx(k) : start - 1;
        for (var j = i + 1; j < levels.length; j++) delete path[levels[j].k];
        level = steps[Math.max(i + 1, start)].k; changed();
      },
      // Deep links: ?region= ?division= ?ccc= (any case; "X Division" works). Picks names that exist in `rows`.
      fromParams: function (params, rows) {
        var deepest = -1;
        levels.forEach(function (l, i) {
          if (i < start) return;
          var want = String(params.get(l.k) || '').trim().toLowerCase().replace(/\s+(division|region)$/, '');
          if (!want) return;
          if (l.k === 'region') want = regionName(want).toLowerCase();
          for (var x = 0; x < rows.length; x++) {
            var v = rows[x][l.field];
            if (v && String(v).toLowerCase() === want && api.match(rows[x])) {
              for (var j = start; j < i; j++) if (!path[levels[j].k]) path[levels[j].k] = valueOf(rows[x], levels[j]);
              path[l.k] = v; deepest = i; break;
            }
          }
        });
        if (deepest >= 0) level = steps[deepest + 1].k;
        return deepest >= 0;
      },
      // counts: { listKey: n } shown on the list tabs; hint: text on the right of the trail.
      paint: function (c, hint) {
        counts = c || counts;
        var cur = idx(level), tabs = steps.map(function (s, i) {
          if (i < start) return '';
          var nn = counts[s.k];
          return '<button type="button" class="ui-drill-tab" role="tab" data-k="' + s.k + '" aria-selected="' + (i === cur) + '">' + esc(s.label) + (nn != null ? '<small>' + n(nn) + '</small>' : '') + '</button>';
        }).join('');
        var crumbs = [], root = !Object.keys(pins).length;
        if (root) crumbs.push({ label: cfg.root || 'All offices', up: '', next: start });
        levels.forEach(function (l, i) {
          if (pins[l.k]) crumbs.push({ label: pins[l.k], kind: l.label, up: i === start - 1 ? '' : null, next: i === start - 1 ? start : -1 });
          else if (path[l.k]) crumbs.push({ label: path[l.k], kind: l.label, up: l.k, next: i + 1 });
        });
        var trail = crumbs.map(function (c, i) {
          var here = i === crumbs.length - 1 && c.next === cur, tip = c.kind ? ' title="' + esc(c.kind + ': ' + c.label) + '"' : '';
          var html = c.up === null || here
            ? '<span class="c' + (here ? '' : ' lock') + '"' + tip + (here ? ' aria-current="location"' : '') + '>' + esc(c.label) + '</span>'
            : '<button type="button" data-up="' + esc(c.up) + '"' + tip + '>' + esc(c.label) + '</button>';
          return (i ? '<span class="sep" aria-hidden="true">/</span>' : '') + html;
        }).join('');
        host.innerHTML = '<div class="ui-drill-tabs" role="tablist" aria-label="Level">' + tabs + '</div>' +
          '<div class="ui-trail"><nav aria-label="Office">' + trail + '</nav>' +
          '<small>' + esc(hint != null ? hint : api.isList() ? '' : 'Click a row to open it') + '</small></div>';
      }
    };
    host.addEventListener('click', function (e) {
      var t = e.target.closest('[data-k]'); if (t && host.contains(t)) { api.go(t.getAttribute('data-k')); return; }
      var u = e.target.closest('[data-up]'); if (u && host.contains(u)) api.up(u.getAttribute('data-up'));
    });
    return api;
  }

  /* ---------- line chart (inline SVG, no library) ----------
   * series: [{ label, values: [number|null], strong: bool, color }]  labels: x labels
   * fmt(v) formats tooltip/axis values.
   * Colour follows the series, not its rank: se.color (slot 1–6, 'ok' | 'warn' | 'bad', or a CSS colour) wins;
   * otherwise the strong series takes slot 1 and the others take 2, 3… counted back from the end (so the
   * current year is always slot 1 and last year slot 2). With more than six series, or cfg.emphasis, only
   * the strong series is coloured and the rest are muted grey. */
  function lineColors(series, emphasis) {
    var strong = series.some(function (se) { return se.strong; }), next = strong ? 2 : 1, out = new Array(series.length);
    for (var k = 0; k < series.length; k++) {
      var i = strong ? series.length - 1 - k : k, se = series[i];
      if (se.color != null) out[i] = color(se.color);
      else if (se.strong) out[i] = color(1);
      else out[i] = emphasis ? '' : color(next++);
    }
    return out;
  }
  function line(el, cfg) {
    if (typeof el === 'string') el = document.getElementById(el);
    // Draw at the element's real pixel width so text stays 11px; redraw on resize.
    el.__lineCfg = cfg;
    if (!el.__lineRO && w.ResizeObserver) {
      var lastW = 0;
      el.__lineRO = new ResizeObserver(function () { var cw = el.clientWidth; if (cw && Math.abs(cw - lastW) > 8) { lastW = cw; line(el, el.__lineCfg); } });
      el.__lineRO.observe(el);
    }
    var W = Math.max(300, el.clientWidth || 640), H = cfg.height || 240, P = { t: 12, r: 12, b: 26, l: 44 };
    var labels = cfg.labels, series = cfg.series, fmt = cfg.fmt || n;
    var vals = [];
    series.forEach(function (s) { s.values.forEach(function (v) { if (v != null && isFinite(v)) vals.push(v); }); });
    if (!vals.length) { el.innerHTML = '<div class="ui-empty">No data for this selection.</div>'; return; }
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (cfg.zero !== false && lo > 0 && lo / (hi || 1) < 0.35) lo = 0;
    var span = hi - lo || Math.abs(hi) || 1, step = Math.pow(10, Math.floor(Math.log10(span / 4)));
    [1, 2, 2.5, 5, 10].some(function (m) { if (span / (step * m) <= 5) { step *= m; return true; } return false; });
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step; if (hi === lo) hi = lo + step;
    // Left gutter fits the widest axis label (≈6.4px per character at 11px).
    var widest = 0;
    for (var gg = lo; gg <= hi + step / 2; gg += step) widest = Math.max(widest, String(cfg.axis ? cfg.axis(gg) : fmt(gg)).length);
    P.l = Math.max(36, Math.ceil(widest * 6.4) + 14);
    var emphasis = !!cfg.emphasis || series.length > SLOTS, cols = lineColors(series, emphasis);
    var x = function (i) { return P.l + (labels.length < 2 ? 0 : i * (W - P.l - P.r) / (labels.length - 1)); };
    var y = function (v) { return P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b); };
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" class="ui-chart" role="img" aria-label="' + esc(cfg.title || 'Trend') + '">';
    for (var g = lo; g <= hi + step / 2; g += step) {
      s += '<line x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + y(g) + '" y2="' + y(g) + '" class="gl"/><text x="' + (P.l - 8) + '" y="' + (y(g) + 4) + '" text-anchor="end">' + esc(cfg.axis ? cfg.axis(g) : fmt(g)) + '</text>';
    }
    // Thin crowded x labels: keep roughly one per 56px, counted back from the last so it is always shown
    // and the spacing stays even (counting from the first could leave the last two labels overlapping).
    var every = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor((W - P.l - P.r) / 56))));
    labels.forEach(function (l, i) { if ((labels.length - 1 - i) % every === 0) s += '<text x="' + x(i) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(l) + '</text>'; });
    series.forEach(function (se, si) {
      var d = '', pen = false;
      se.values.forEach(function (v, i) { if (v == null || !isFinite(v)) { pen = false; return; } d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); pen = true; });
      var c = cols[si], op = se.strong || c ? 1 : Math.max(0.28, 0.75 - (series.length - 1 - si) * 0.18);
      s += '<path d="' + d + '" class="ln' + (se.strong ? ' strong' : '') + '" style="opacity:' + op + (c ? ';stroke:' + c : '') + '"/>';
      if (se.strong) se.values.forEach(function (v, i) { if (v != null && isFinite(v)) s += '<circle cx="' + x(i) + '" cy="' + y(v) + '" r="2.6" class="pt"' + (c ? ' style="stroke:' + c + '"' : '') + '/>'; });
    });
    s += '<line class="guide" visibility="hidden" y1="' + P.t + '" y2="' + (H - P.b) + '" x1="0" x2="0"/>';
    labels.forEach(function (_, i) { var half = (W - P.l - P.r) / Math.max(1, labels.length - 1) / 2; s += '<rect class="hit" data-i="' + i + '" x="' + (x(i) - half) + '" y="0" width="' + half * 2 + '" height="' + H + '"/>'; });
    s += '</svg>';
    var key = function (si) { var c = cols[si], op = series[si].strong || c ? 1 : Math.max(0.28, 0.75 - (series.length - 1 - si) * 0.18); return 'opacity:' + op + (c ? ';background:' + c : ''); };
    var legend = '<div class="ui-legend">' + series.map(function (se, si) { return '<span><i style="' + key(si) + '" class="' + (se.strong ? 'strong' : '') + '"></i>' + esc(se.label) + '</span>'; }).join('') + '</div>';
    el.innerHTML = '<div class="ui-chart-wrap">' + s + '<div class="ui-tip" hidden></div></div>' + legend;
    var svg = el.querySelector('svg'), tip = el.querySelector('.ui-tip'), guide = el.querySelector('.guide');
    svg.addEventListener('pointermove', function (e) {
      var r = e.target.closest && e.target.closest('rect.hit');
      if (!r) return;
      var i = +r.getAttribute('data-i');
      guide.setAttribute('x1', x(i)); guide.setAttribute('x2', x(i)); guide.setAttribute('visibility', 'visible');
      tip.innerHTML = '<b>' + esc(cfg.tipLabels ? cfg.tipLabels[i] : labels[i]) + '</b>' + series.map(function (se, si) { var v = se.values[i]; return '<div><span>' + (series.length > 1 ? '<i style="' + key(si) + '"></i>' : '') + esc(se.label) + '</span><span>' + (v == null ? '—' : esc(fmt(v))) + '</span></div>'; }).reverse().join('');
      tip.hidden = false;
      var box = svg.getBoundingClientRect(), px = (x(i) / W) * box.width;
      tip.style.left = Math.min(box.width - tip.offsetWidth - 4, Math.max(4, px + 12)) + 'px';
    });
    svg.addEventListener('pointerleave', function () { tip.hidden = true; guide.setAttribute('visibility', 'hidden'); });
  }

  /* ---------- misc ---------- */
  function exportCsv(name, cols, rows) {
    var q = function (v) { v = v == null ? '' : String(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var out = [cols.map(function (c) { return q(c.label); }).join(',')];
    rows.forEach(function (r) { out.push(cols.map(function (c) { return q(c.csv ? c.csv(r) : r[c.key]); }).join(',')); });
    var blob = new Blob(['﻿' + out.join('\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  var toastT;
  function toast(msg) {
    var t = document.getElementById('ui-toast');
    if (!t) { t = document.createElement('div'); t.id = 'ui-toast'; t.className = 'ui-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  function debounce(fn, ms) { var t; return function () { var a = arguments, s = this; clearTimeout(t); t = setTimeout(function () { fn.apply(s, a); }, ms || 150); }; }
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e) {} ta.remove();
    return Promise.resolve();
  }
  // Keyboard focus stays inside a dialog: returns a keydown handler that wraps Tab / Shift+Tab within `box`.
  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function trapFocus(box) {
    return function (e) {
      if (e.key !== 'Tab') return;
      var els = [].filter.call(box.querySelectorAll(FOCUSABLE), function (x) { return x.getClientRects().length; });
      if (!els.length) { e.preventDefault(); return; }
      var first = els[0], last = els[els.length - 1], cur = document.activeElement, inside = box.contains(cur);
      if (e.shiftKey ? (cur === first || !inside) : (cur === last || !inside)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
    };
  }

  // pairs: [[label, value]] (blank values are skipped); extraHtml goes under the list, actionsHtml in the header.
  // Opening moves focus to Close and keeps it in the drawer; closing returns it to what had it before.
  function drawer(titleText, sub, pairs, extraHtml, actionsHtml) {
    var d = document.getElementById('ui-drawer');
    if (!d) {
      d = document.createElement('div'); d.id = 'ui-drawer'; d.className = 'ui-drawer'; d.hidden = true;
      d.innerHTML = '<section role="dialog" aria-modal="true" aria-labelledby="ui-drawer-t"><header><div><h3 id="ui-drawer-t"></h3><p></p></div><button type="button" class="ui-btn icon ghost" data-x aria-label="Close">' + icon('x') + '</button></header><dl class="ui-dl"></dl></section>';
      document.body.appendChild(d);
      var shut = function () {
        if (d.hidden) return;
        d.hidden = true;
        document.documentElement.classList.remove('ui-sheet-on');
        backDone();
        var back = d.__back; d.__back = null;
        if (back && back.focus && document.contains(back)) try { back.focus(); } catch (e) {}
      };
      d.__shut = shut;
      d.addEventListener('click', function (e) { if (e.target === d || e.target.closest('[data-x]')) shut(); });
      d.addEventListener('keydown', trapFocus(d.querySelector('section')));
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') shut(); });
      dragToClose(d.querySelector('section'), [d.querySelector('header')], function () { return phone() && !d.hidden; }, shut);
    }
    if (d.hidden) d.__back = document.activeElement;
    var act = d.querySelector('.ui-drawer-act');
    if (!act) { act = document.createElement('div'); act.className = 'ui-drawer-act'; d.querySelector('header').insertBefore(act, d.querySelector('[data-x]')); }
    act.innerHTML = actionsHtml || '';
    d.querySelector('h3').textContent = titleText;
    d.querySelector('p').textContent = sub || '';
    var dl = d.querySelector('dl'), extra = d.querySelector('.ui-drawer-x');
    if (!extra) { extra = document.createElement('div'); extra.className = 'ui-drawer-x'; dl.parentNode.appendChild(extra); }
    var shown = (pairs || []).filter(function (p) { return !blank(p[1]); });
    dl.innerHTML = shown.map(function (p) { return '<dt>' + esc(p[0]) + '</dt><dd>' + esc(p[1]) + '</dd>'; }).join('');
    extra.innerHTML = extraHtml || '';
    // Phones with a share sheet: one Share button hands the details to WhatsApp, mail, etc.
    var share = d.querySelector('.ui-drawer-share');
    if (!share && navigator.share && touch()) {
      share = document.createElement('button'); share.type = 'button'; share.className = 'ui-btn icon ghost ui-drawer-share';
      share.setAttribute('aria-label', 'Share'); share.title = 'Share'; share.innerHTML = icon('share');
      d.querySelector('header').insertBefore(share, d.querySelector('[data-x]'));
    }
    if (share) share.onclick = function () {
      var text = titleText + (sub ? '\n' + sub : '') + '\n\n' + shown.map(function (p) { return p[0] + ': ' + p[1]; }).join('\n');
      try { navigator.share({ title: titleText, text: text }).catch(function () {}); } catch (e) {}
    };
    var wasHidden = d.hidden;
    d.hidden = false;
    if (wasHidden && phone()) { document.documentElement.classList.add('ui-sheet-on'); backOpen(function () { d.__shut(); }); }
    if (wasHidden) try { d.querySelector('[data-x]').focus({ preventScroll: true }); } catch (e) {}
    return d;
  }

  /* ---------- phones: Android-style behaviour (sheets, Back, ripple, pull to refresh) ----------
   * Everything here is inert on desktop: phone() is the kit's 760px breakpoint, touch() a coarse pointer. */
  var phoneMq = w.matchMedia ? w.matchMedia('(max-width: 760px)') : null;
  var touchMq = w.matchMedia ? w.matchMedia('(hover: none) and (pointer: coarse)') : null;
  function phone() { return !!(phoneMq && phoneMq.matches); }
  function touch() { return !!(touchMq && touchMq.matches); }
  function haptic(ms) { try { if (navigator.vibrate) navigator.vibrate(ms || 8); } catch (e) {} }

  // Android Back: an open sheet owns one history entry, so Back closes the sheet instead of leaving the
  // report. Closing it any other way pops that entry again. The page's own replaceState URL (filters in
  // the query string) is kept across the pop.
  var backEntry = null, backSkip = 0, backKeep = '';
  function backOpen(close) {
    if (backEntry) { backEntry.close = close; return; }
    backEntry = { close: close, keep: location.href };
    try { history.pushState({ uiBack: 1 }, '', location.href); } catch (e) { backEntry = null; }
  }
  function backDone() {
    if (!backEntry) return;
    backKeep = location.href; backEntry = null; backSkip++;
    try { history.back(); } catch (e) { backSkip--; }
  }
  if (w.addEventListener) w.addEventListener('popstate', function (e) {
    var keep = '';
    if (backSkip) { backSkip--; keep = backKeep; backKeep = ''; }
    else if (backEntry) { var b = backEntry; backEntry = null; keep = b.keep; b.close(); }
    else return;
    e.stopImmediatePropagation();
    if (keep && keep !== location.href) try { history.replaceState(history.state, '', keep); } catch (er) {}
  });
  ['click', 'change', 'input'].forEach(function (t) {
    document.addEventListener(t, function () { if (backEntry) setTimeout(function () { if (backEntry) backEntry.keep = location.href; }, 0); }, true);
  });

  // One scrim behind whichever sheet is open; tapping it closes that sheet.
  var scrimEl = null, scrimClose = null;
  function sheetOn(el, close) {
    if (!scrimEl) {
      scrimEl = document.createElement('div'); scrimEl.className = 'ui-scrim';
      scrimEl.addEventListener('click', function () { if (scrimClose) scrimClose(); });
      document.body.appendChild(scrimEl);
    }
    scrimClose = el ? close : null;
    scrimEl.classList.toggle('on', !!el);
    document.documentElement.classList.toggle('ui-sheet-on', !!el);
  }
  // Rotating or widening past the phone breakpoint with a sheet open: wide screens have no sheet, so drop the
  // scrim, the scroll lock and the Back entry (otherwise the page stays unscrollable behind an invisible lock).
  function sheetsOff() {
    if (phone()) return;
    if (scrimEl) scrimEl.classList.remove('on');
    scrimClose = null;
    document.documentElement.classList.remove('ui-sheet-on');
    if (backEntry) backDone();
  }
  if (phoneMq) { if (phoneMq.addEventListener) phoneMq.addEventListener('change', sheetsOff); else if (phoneMq.addListener) phoneMq.addListener(sheetsOff); }

  // Drag a sheet down by its handle or header; past 90px (or a quick flick) it closes.
  function dragToClose(box, handles, can, close) {
    var y0 = null, dy = 0, t0 = 0;
    [].forEach.call(handles, function (hd) {
      if (!hd) return;
      hd.addEventListener('touchstart', function (e) {
        if (!can() || e.touches.length > 1 || e.target.closest('button, input, select, a')) return;
        y0 = e.touches[0].clientY; dy = 0; t0 = Date.now();
        box.style.transition = 'none';
      }, { passive: true });
      hd.addEventListener('touchmove', function (e) {
        if (y0 == null) return;
        dy = Math.max(0, e.touches[0].clientY - y0);
        box.style.transform = dy ? 'translateY(' + dy + 'px)' : '';
      }, { passive: true });
      var end = function () {
        if (y0 == null) return;
        y0 = null; box.style.transition = ''; box.style.transform = '';
        if (dy > 90 || (dy > 30 && Date.now() - t0 < 220)) close();
      };
      hd.addEventListener('touchend', end);
      hd.addEventListener('touchcancel', end);
    });
  }

  // Touch ripple (Material state layer) on kit and Bootstrap/custom controls.
  var RIPPLE = '.ui-btn, .ui-stat, .ui-opt, .ui-drill-tab, .ui-chip, .ui-seg button, .ui-tab, .ui-cardable tr.click, .btn, .nav-link, .tab-link, .allot-btn, .alert-btn, .bf-row, .as-sug';
  document.addEventListener('pointerdown', function (e) {
    if (e.pointerType !== 'touch' || !e.target.closest) return;
    var t = e.target.closest(RIPPLE);
    if (!t || t.disabled || (t.tagName === 'TR' && !w.matchMedia('(max-width: 600px)').matches)) return;
    if (w.getComputedStyle(t).position === 'static') t.style.position = 'relative';
    var r = t.getBoundingClientRect(), s = Math.max(r.width, r.height) * 2.2;
    var box = document.createElement('span'), dot = document.createElement('span');
    box.className = 'ui-rpl'; box.setAttribute('aria-hidden', 'true');
    dot.style.cssText = 'width:' + s + 'px;height:' + s + 'px;left:' + (e.clientX - r.left - s / 2) + 'px;top:' + (e.clientY - r.top - s / 2) + 'px';
    box.appendChild(dot); t.appendChild(box);
    setTimeout(function () { box.remove(); }, 650);
  }, { passive: true });

  // Pull to refresh: on touch screens, pulling down from the top of the page presses the page's
  // UI.refresh button (only pages that registered one).
  var ptrBtns = [], ptrEl = null;
  function ptrAdd(btn) {
    if (ptrBtns.indexOf(btn) < 0) ptrBtns.push(btn);
    if (ptrBtns.length === 1 && touch()) ptrInit();
  }
  function ptrScrolled(node) {
    if ((w.scrollY || document.documentElement.scrollTop) > 0) return true;
    for (var n2 = node; n2 && n2 !== document.body && n2.nodeType === 1; n2 = n2.parentNode) if (n2.scrollTop > 0) return true;
    return false;
  }
  function ptrInit() {
    document.documentElement.style.overscrollBehaviorY = 'none';
    var y0 = null, x0 = 0, pull = 0, armed = false, busy = false;
    function el() {
      if (!ptrEl) { ptrEl = document.createElement('div'); ptrEl.className = 'ui-ptr'; ptrEl.setAttribute('aria-hidden', 'true'); ptrEl.innerHTML = icon('refresh'); document.body.appendChild(ptrEl); }
      return ptrEl;
    }
    function paint(p) { var x = el(); x.style.transform = 'translate(-50%,' + (p - 48) + 'px) rotate(' + (p * 4) + 'deg)'; x.style.opacity = Math.min(1, p / 40); x.classList.toggle('armed', p >= 64); }
    function reset() { var x = el(); x.classList.remove('run', 'armed'); x.style.transition = 'transform .2s, opacity .2s'; x.style.transform = 'translate(-50%,-48px)'; x.style.opacity = '0'; setTimeout(function () { x.style.transition = ''; }, 220); }
    document.addEventListener('touchstart', function (e) {
      if (busy || e.touches.length > 1 || document.documentElement.classList.contains('ui-sheet-on') || ptrScrolled(e.target)) { y0 = null; return; }
      y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; pull = 0; armed = false;
    }, { passive: true });
    document.addEventListener('touchmove', function (e) {
      if (y0 == null) return;
      var dy = e.touches[0].clientY - y0, dx = Math.abs(e.touches[0].clientX - x0);
      if (dy <= 0 || (pull === 0 && dx > dy)) { if (pull) reset(); y0 = null; pull = 0; return; }
      pull = Math.min(110, dy * 0.5);
      paint(pull);
      if (pull >= 64 && !armed) { armed = true; haptic(10); } else if (pull < 64) armed = false;
    }, { passive: true });
    var end = function () {
      if (y0 == null) return;
      y0 = null;
      var btn = ptrBtns.filter(function (b) { return document.contains(b) && !b.disabled; })[0];
      if (!armed || !btn) { if (pull) reset(); pull = 0; return; }
      busy = true; pull = 0;
      var x = el(); x.classList.add('run'); x.style.transform = 'translate(-50%,16px)'; x.style.opacity = '1';
      btn.click();
      var started = Date.now();
      (function wait() {
        if ((btn.classList.contains('spin') && Date.now() - started < 20000) || Date.now() - started < 600) { setTimeout(wait, 150); return; }
        busy = false; reset();
      })();
    };
    document.addEventListener('touchend', end);
    document.addEventListener('touchcancel', end);
  }

  /* ---------- icons (one sprite per page, injected once) ---------- */
  var ICONS = {
    refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1L20.5 8.5"/><path d="M20.5 3.5v5h-5"/>',
    download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
    upload: '<path d="M12 20V9"/><path d="m7 14 5-5 5 5"/><path d="M5 4h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    chev: '<path d="m9 6 6 6-6 6"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>',
    sync: '<path d="M4 12a8 8 0 0 1 13.7-5.6L20 9"/><path d="M20 4v5h-5"/><path d="M20 12a8 8 0 0 1-13.7 5.6L4 15"/><path d="M4 20v-5h5"/>',
    arrow: '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>',
    filter: '<path d="M4 5h16l-6 7.5V19l-4-2v-4.5z"/>',
    reload: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    share: '<circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="m8.2 10.8 7.6-4.1M8.2 13.2l7.6 4.1"/>'
  };
  function icon(name) { return '<svg class="ui-i" aria-hidden="true"><use href="#ui-' + name + '"/></svg>'; }
  function sprite() {
    if (document.getElementById('ui-sprite')) return;
    var s = '<svg id="ui-sprite" width="0" height="0" style="position:absolute" aria-hidden="true">';
    Object.keys(ICONS).forEach(function (k) { s += '<symbol id="ui-' + k + '" viewBox="0 0 24 24">' + ICONS[k] + '</symbol>'; });
    document.body.insertAdjacentHTML('afterbegin', s + '</svg>');
  }
  if (document.body) sprite(); else document.addEventListener('DOMContentLoaded', sprite);

  // Login gate when a page is opened on its own (inside app.html the shell checks the session).
  (function gate() {
    var inShell = false;
    try { inShell = w.self !== w.top && !!w.top.__MZO_SHELL__; } catch (e) {}
    if (inShell || w.__mzoAuthScript || document.querySelector('script[src*="auth.js"]')) return;
    w.__mzoAuthScript = true;
    var sc = document.createElement('script'); sc.src = '/auth.js'; sc.defer = true;
    (document.head || document.documentElement).appendChild(sc);
  })();

  w.UI = {
    n: n, inr: inr, pct: pct, esc: esc, blank: blank, date: date, fmtDate: fmtDate, days: days, age: age, title: title,
    csv: csv, office: office, regionName: regionName, load: load, refresh: refresh,
    fill: fill, mark: mark, uniq: uniq, offices: offices, lockScope: lockScope,
    table: table, bar: bar, hist: hist, line: line, color: color, facet: facet, sidePanel: sidePanel, drill: drill,
    exportCsv: exportCsv, toast: toast, debounce: debounce, copy: copy, drawer: drawer, trapFocus: trapFocus, icon: icon
  };
})(window);
