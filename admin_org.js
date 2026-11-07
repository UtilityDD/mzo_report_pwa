/* Admin → Organisation: WBSEDCL's office hierarchy as an interactive chart (admin_users.html, ?tab=org).
 * Director (Distribution) → chief engineers → zones → regions → divisions → CCCs (the chief engineer level is
 * optional in the data). Data: GET /api/admin/org (lib/org_hierarchy.js,
 * data/org/wbsedcl_hierarchy.json). Plain JS, HTML cards and one SVG layer for the connectors.
 *
 *   MzoOrg.mount(el)   draw into el (once); later calls only re-fit the view
 *
 * Wide screens: a top-down chart (click a card to expand or collapse it and show its details; CCCs
 * stack under their division), pan by dragging or scrolling, zoom, search with path highlight, and a
 * detail panel. Phones (≤ 760 px): an indented collapsible list with the detail panel below it.
 * Styles: admin_org.css (theme tokens from mzo_theme.css, so light, dark and ppt all work).
 */
(function () {
  'use strict';

  var LEVELS = {
    root: { label: 'Head office', one: 'office', many: 'offices', tone: 'lv0' },
    chief_engineer: { label: 'Chief Engineer', one: 'chief engineer', many: 'chief engineers', tone: 'lv5' },
    zone: { label: 'Zone', one: 'zone', many: 'zones', tone: 'lv1' },
    region: { label: 'Region', one: 'region', many: 'regions', tone: 'lv2' },
    division: { label: 'Division', one: 'division', many: 'divisions', tone: 'lv3' },
    ccc: { label: 'CCC', one: 'CCC', many: 'CCCs', tone: 'lv4' }
  };
  var COUNT_LEVELS = ['zone', 'region', 'division', 'ccc']; // shown in counts (chief engineers are counted but not listed)
  var ORDER = ['chief_engineer', 'zone', 'region', 'division', 'ccc'];
  var CONF = {
    confirmed: { label: 'Confirmed', text: 'Stated outright by a cited source (a WBSEDCL page, or the app\u2019s office master for Malda Zone).' },
    partial: { label: 'Partial', text: 'Found in a source, but some details (name, code or children) are incomplete.' },
    inferred: { label: 'Inferred', text: 'Not stated outright: worked out from codes, addresses or neighbouring offices.' }
  };
  // Chart geometry (px at 100 % zoom).
  var CW = 216, CH = 116, HG = 20, VG = 56, PAD = 28, RW = 300; // RW: the top card, whose title is longer
  var SW = 188, SH = 50, SG = 8, SX = 26, ST = 18; // stacked leaves: width, height, gap, indent, top gap
  var PHONE = '(max-width: 760px)';

  var S = null; // state of the one mounted chart

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function levelOf(raw, depth, parent) {
    var l = String(raw || '').toLowerCase();
    if (depth === 0) return 'root';
    if (LEVELS[l] && l !== 'root') return l;
    var i = parent && parent.level !== 'root' ? ORDER.indexOf(parent.level) + 1 : 1;
    return ORDER[i] || l;
  }
  function lvInfo(n) {
    if (n.level === 'root') {
      var name = String(n.raw.level || '').replace(/_/g, ' ').trim();
      return { label: name ? name.replace(/\b\w/g, function (c) { return c.toUpperCase(); }) : LEVELS.root.label, tone: 'lv0' };
    }
    return LEVELS[n.level] || { label: n.level, tone: 'lv4' };
  }
  function plural(k, lv) { var L = LEVELS[lv]; return k + ' ' + (k === 1 ? L.one : L.many); }
  function countText(n) {
    return COUNT_LEVELS.filter(function (lv) { return n.counts[lv]; }).map(function (lv) { return plural(n.counts[lv], lv); }).join(' · ');
  }
  function svgIcon(id) { return '<svg class="org-i" aria-hidden="true" viewBox="0 0 16 16">' + ICONS[id] + '</svg>'; }
  var ICONS = {
    search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>',
    plus: '<path d="M8 3.5v9M3.5 8h9"/>',
    minus: '<path d="M3.5 8h9"/>',
    expand: '<path d="M3 6l5 5 5-5"/>',
    collapse: '<path d="M3 10l5-5 5 5"/>',
    fit: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>',
    chev: '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
    info: '<circle cx="8" cy="8" r="5.8"/><path d="M8 7.3v3.6M8 5.1v.1"/>',
    link: '<path d="M6.5 9.5l3-3M7 4.5l1-1a2.6 2.6 0 0 1 3.6 3.6l-1 1M9 11.5l-1 1a2.6 2.6 0 0 1-3.6-3.6l1-1"/>'
  };

  /* ---------- data ---------- */

  function prepare(body) {
    var nodes = [], byId = {};
    function walk(raw, parent, depth, id) {
      var n = {
        id: id, raw: raw, parent: parent, depth: depth,
        level: levelOf(raw.level, depth, parent),
        name: String(raw.name || '(unnamed)'),
        code: raw.code == null ? '' : String(raw.code),
        aliases: (Array.isArray(raw.aliases) ? raw.aliases : []).map(String).filter(Boolean),
        confidence: CONF[raw.confidence] ? raw.confidence : (raw.confidence ? 'partial' : 'confirmed'),
        live: !!raw.live, inApp: raw.inApp || null,
        synthetic: !!raw.synthetic,
        kids: [], counts: { chief_engineer: 0, zone: 0, region: 0, division: 0, ccc: 0 }
      };
      n.search = [n.name, n.code].concat(n.aliases).map(norm).filter(Boolean);
      nodes.push(n);
      byId[id] = n;
      var children = (Array.isArray(raw.children) ? raw.children : []).slice();
      // CCCs known to be in a region whose current division is not public: one stand-in division holds them.
      if (Array.isArray(raw.unplacedCccs) && raw.unplacedCccs.length) {
        children.push({ level: 'division', name: 'Division not published', synthetic: true, confidence: 'partial',
          note: 'These CCCs belong to ' + n.name + ', but no current source says which of its divisions holds each one' +
            (raw.unplacedCccs[0] && raw.unplacedCccs[0].candidateDivisions ? ' (candidates: ' + raw.unplacedCccs[0].candidateDivisions.join(', ') + ').' : '.'),
          children: raw.unplacedCccs });
      }
      children.forEach(function (c, i) {
        if (c && typeof c === 'object') n.kids.push(walk(c, n, depth + 1, id + '.' + i));
      });
      n.kids.forEach(function (k) {
        if (n.counts[k.level] != null && !k.synthetic) n.counts[k.level]++;
        ORDER.forEach(function (lv) { n.counts[lv] += k.counts[lv]; });
      });
      return n;
    }
    var root = walk(body.root || { name: 'WBSEDCL' }, null, 0, 'n');
    nodes.forEach(function (n) {
      var z = n; while (z && z.level !== 'zone') z = z.parent;
      n.zone = z || null;
      n.inLive = !!(z && z.live);
    });
    return { root: root, nodes: nodes, byId: byId };
  }

  function pathOf(n) { var p = []; for (var x = n; x; x = x.parent) p.unshift(x); return p; }
  function isOpen(n) { return n.kids.length > 0 && S.open.has(n.id); }
  function stacked(n) { return n.kids.length > 0 && n.kids.every(function (k) { return k.kids.length === 0; }); }

  /* ---------- skeleton ---------- */

  function skeleton(el) {
    el.innerHTML =
      '<div class="org">' +
        '<div class="org-head">' +
          '<div class="org-title"><h2>Organisation</h2><p class="org-sub" id="orgSub">Loading the office hierarchy…</p></div>' +
          '<div class="org-tools">' +
            '<div class="org-search" role="combobox" aria-haspopup="listbox" aria-owns="orgHits" aria-expanded="false">' +
              svgIcon('search') +
              '<input class="ui-input" id="orgQ" type="search" placeholder="Find an office or code" aria-label="Find an office by name or code" autocomplete="off" aria-controls="orgHits" />' +
              '<ul class="org-hits" id="orgHits" role="listbox" hidden></ul>' +
            '</div>' +
            '<button type="button" class="ui-btn sm" id="orgExpandZone" title="Expand every office in the selected zone">' + svgIcon('expand') + '<span>Expand zone</span></button>' +
            '<button type="button" class="ui-btn sm" id="orgCollapse" title="Collapse to the zones">' + svgIcon('collapse') + '<span>Collapse all</span></button>' +
            '<div class="org-zoom" role="group" aria-label="Zoom">' +
              '<button type="button" class="ui-btn sm icon" id="orgZoomOut" aria-label="Zoom out">' + svgIcon('minus') + '</button>' +
              '<button type="button" class="ui-btn sm org-zoom-v" id="orgZoomReset" title="Actual size">100%</button>' +
              '<button type="button" class="ui-btn sm icon" id="orgZoomIn" aria-label="Zoom in">' + svgIcon('plus') + '</button>' +
              '<button type="button" class="ui-btn sm icon" id="orgFit" aria-label="Fit to width" title="Fit to width">' + svgIcon('fit') + '</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="org-stats" id="orgStats"></div>' +
        '<div class="org-body">' +
          '<section class="org-chart-panel">' +
            '<div class="org-canvas" id="orgCanvas" tabindex="-1"><div class="ui-empty">Loading…</div></div>' +
            '<div class="org-list" id="orgList" role="tree" aria-label="Office hierarchy" hidden></div>' +
          '</section>' +
          '<aside class="org-detail" id="orgDetail" aria-live="polite"></aside>' +
        '</div>' +
        '<footer class="org-foot">' +
          '<div class="org-legend" id="orgLegend"></div>' +
          '<p class="org-note" id="orgNote"></p>' +
        '</footer>' +
      '</div>';
  }

  /* ---------- stats, legend, note ---------- */

  function renderStats() {
    var r = S.tree.root, live = S.body.live || {};
    var official = S.body.officialCounts || {};
    var html = COUNT_LEVELS.map(function (lv) {
      var of = Number(official[lv + 's'] || official[lv]);
      var note = of && of !== r.counts[lv] ? '<small>of ' + of.toLocaleString('en-IN') + ' published</small>' : (of ? '<small>all published</small>' : '');
      return '<div class="org-stat"><span class="org-stat-k"><i class="org-sw ' + LEVELS[lv].tone + '"></i>' + esc(LEVELS[lv].many.charAt(0).toUpperCase() + LEVELS[lv].many.slice(1)) + '</span><b>' + r.counts[lv].toLocaleString('en-IN') + '</b>' + note + '</div>';
    }).join('');
    if (live.zone) {
      var m = live.matched || {}, a = live.app || {};
      html += '<button type="button" class="org-stat org-stat-live" data-find="' + esc(live.zone) + '" title="Show the zone this app covers">' +
        '<span class="org-stat-k"><i class="org-live-dot"></i>Live in app</span><b>' + esc(live.zone) + '</b>' +
        '<small>' + (m.cccs || 0) + ' of ' + (a.cccs || 0) + ' app CCCs matched' + (live.missing && live.missing.length ? ' · ' + live.missing.length + ' missing' : '') + '</small></button>';
    }
    document.getElementById('orgStats').innerHTML = html;
  }

  function sourceLink(s, i) {
    if (s == null) return '';
    if (typeof s === 'string') s = /^https?:/i.test(s) ? { url: s } : { title: s };
    var title = s.title || s.name || s.publisher || s.url || ('Source ' + (i + 1));
    var url = /^https?:\/\//i.test(String(s.url || '')) ? s.url : '';
    return url
      ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(title) + '</a>'
      : '<span>' + esc(title) + '</span>';
  }

  function renderFoot() {
    var hasCe = S.tree.nodes.some(function (n) { return n.level === 'chief_engineer'; });
    var lv = ['root'].concat(hasCe ? ['chief_engineer'] : [], ['zone', 'region', 'division', 'ccc']).map(function (k) {
      return '<span><i class="org-sw ' + LEVELS[k].tone + '"></i>' + esc(k === 'root' ? lvInfo(S.tree.root).label : LEVELS[k].label) + '</span>';
    }).join('');
    document.getElementById('orgLegend').innerHTML =
      '<span class="org-legend-h">Legend</span>' + lv +
      '<span><span class="org-badge live">Live in app</span></span>' +
      '<span><span class="org-conf partial">Partial</span></span>' +
      '<span><span class="org-conf inferred">Inferred</span> dashed card</span>' +
      '<span><i class="org-path-sw"></i>Search path</span>' +
      '<span><i class="org-path-sw dashed"></i>Inferred link</span>';
    var b = S.body, srcs = (b.sources || []).map(sourceLink).filter(Boolean);
    var asOf = b.asOf ? String(b.asOf).replace(/\d{4}-\d{2}-\d{2}/g, fmtDate) : 'an unknown date';
    document.getElementById('orgNote').innerHTML =
      (b.seed
        ? 'Seed data as of ' + esc(asOf) + ' from the app’s own office master (Malda Zone only); the WBSEDCL-wide dataset replaces it.'
        : 'Data as of ' + esc(asOf) + ' from public WBSEDCL sources. Office names and codes only.') +
      (srcs.length ? ' <span class="org-srcs">Sources: ' + srcs.join('<span class="org-sep"> · </span>') + '</span>' : '');
    var sub = document.getElementById('orgSub');
    sub.textContent = 'WBSEDCL office hierarchy, from the ' + S.tree.root.name.replace(/,?\s*WBSEDCL$/i, '') + ' to the CCCs. Click an office to open or close it.';
  }

  function fmtDate(s) {
    var t = Date.parse(s);
    if (!isFinite(t)) return String(s);
    return new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /* ---------- chart layout ---------- */

  function cw(n) { return n._stack ? SW : (n.depth === 0 ? RW : CW); }

  function measure(n) {
    if (!isOpen(n) || stacked(n)) { n._w = cw(n); return n._w; }
    var w = 0;
    n.kids.forEach(function (k, i) { k._stack = false; w += measure(k) + (i ? HG : 0); });
    n._w = Math.max(cw(n), w);
    return n._w;
  }

  function place(n, left, top, out) {
    n._y = top;
    out.push(n);
    if (!isOpen(n)) { n._x = left + (n._w - cw(n)) / 2; return; }
    if (stacked(n)) {
      n._x = left + (n._w - cw(n)) / 2;
      n.kids.forEach(function (k, i) {
        k._x = n._x + SX; k._y = top + CH + ST + i * (SH + SG); k._stack = true;
        out.push(k);
      });
      return;
    }
    var total = 0;
    n.kids.forEach(function (k, i) { total += k._w + (i ? HG : 0); });
    var x = left + (n._w - total) / 2;
    n.kids.forEach(function (k) { place(k, x, top + CH + VG, out); x += k._w + HG; });
    var a = n.kids[0], b = n.kids[n.kids.length - 1];
    n._x = (a._x + cw(a) / 2 + b._x + cw(b) / 2) / 2 - cw(n) / 2;
  }

  function elbow(x1, y1, x2, y2, midY) {
    var r = Math.min(8, Math.abs(x2 - x1) / 2, (y2 - y1) / 2);
    if (Math.abs(x2 - x1) < 1) return 'M' + x1 + ' ' + y1 + 'V' + y2;
    var dir = x2 > x1 ? 1 : -1;
    return 'M' + x1 + ' ' + y1 + 'V' + (midY - r) + 'Q' + x1 + ' ' + midY + ' ' + (x1 + dir * r) + ' ' + midY +
      'H' + (x2 - dir * r) + 'Q' + x2 + ' ' + midY + ' ' + x2 + ' ' + (midY + r) + 'V' + y2;
  }

  function cardHtml(n) {
    var info = lvInfo(n), cls = ['org-card', info.tone];
    if (n._stack) cls.push('stack');
    if (n.confidence !== 'confirmed') cls.push('c-' + n.confidence);
    if (n.live) cls.push('live');
    if (S.path.has(n.id)) cls.push('on-path');
    if (S.hit === n.id) cls.push('hit');
    if (S.sel === n.id) cls.push('sel');
    var w = cw(n), h = n._stack ? SH : CH;
    if (!n._stack && !n.code) cls.push('no-code');
    var conf = n.confidence !== 'confirmed' ? '<span class="org-conf ' + n.confidence + '" title="' + esc(CONF[n.confidence].text) + '">' + CONF[n.confidence].label + '</span>' : '';
    var notInApp = n.inLive && !n.inApp && n.level !== 'zone' ? '<span class="org-tag" title="The app’s office master has no such office">Not in app</span>' : '';
    var open = isOpen(n);
    var attrs = ' data-id="' + n.id + '" role="treeitem" tabindex="0" aria-level="' + (n.depth + 1) + '" aria-selected="' + (S.sel === n.id) + '"' +
      (n.kids.length ? ' aria-expanded="' + open + '"' : '') +
      ' style="left:' + n._x + 'px;top:' + n._y + 'px;width:' + w + 'px;height:' + h + 'px"';
    if (n._stack) {
      return '<div class="' + cls.join(' ') + '"' + attrs + '>' +
        '<div class="org-c-row"><span class="org-c-name" title="' + esc(n.name) + '">' + esc(n.name) + '</span>' + conf + '</div>' +
        '<div class="org-c-meta"><span class="org-c-lv">' + esc(info.label) + '</span>' + (n.code ? '<span class="org-c-code">' + esc(n.code) + '</span>' : '') + notInApp + '</div>' +
        '</div>';
    }
    var counts = countText(n);
    return '<div class="' + cls.join(' ') + '"' + attrs + '>' +
      '<div class="org-c-row"><span class="org-c-lv">' + esc(info.label) + '</span>' + (n.live ? '<span class="org-badge live">Live in app</span>' : '') + conf + '</div>' +
      '<div class="org-c-name" title="' + esc(n.name) + '">' + esc(n.name) + '</div>' +
      (n.code || notInApp ? '<div class="org-c-code">' + esc(n.code) + notInApp + '</div>' : '') +
      '<div class="org-c-counts">' + (counts ? esc(counts) : (n.level === 'ccc' ? 'Customer care centre' : 'No offices listed below')) + '</div>' +
      (n.kids.length ? '<span class="org-toggle" aria-hidden="true">' + (open ? '−' : '+' + n.kids.length) + '</span>' : '') +
      '</div>';
  }

  function renderChart() {
    var canvas = document.getElementById('orgCanvas');
    var root = S.tree.root, out = [];
    measure(root);
    place(root, PAD, PAD, out);
    var W = 0, H = 0, links = [];
    out.forEach(function (n) {
      W = Math.max(W, n._x + cw(n));
      H = Math.max(H, n._y + (n._stack ? SH : CH));
    });
    W += PAD; H += PAD + 14;
    out.forEach(function (n) {
      if (!isOpen(n)) return;
      var dashed = n.raw.zoneConfidence === 'inferred' || n.raw.linkConfidence === 'inferred';
      var on = function (k) { return (S.path.has(k.id) ? ' on' : '') + (dashed || k.raw.linkConfidence === 'inferred' ? ' inferred' : ''); };
      if (stacked(n)) {
        var rx = n._x + 14, last = n.kids[n.kids.length - 1];
        var pathKid = n.kids.filter(function (k) { return S.path.has(k.id); })[0];
        links.push('<path class="org-link" d="M' + rx + ' ' + (n._y + CH) + 'V' + (last._y + SH / 2 - 6) + '"/>');
        if (pathKid) links.push('<path class="org-link on" d="M' + rx + ' ' + (n._y + CH) + 'V' + (pathKid._y + SH / 2 - 6) + '"/>');
        n.kids.forEach(function (k) {
          var cy = k._y + SH / 2;
          links.push('<path class="org-link' + on(k) + '" d="M' + rx + ' ' + (cy - 6) + 'Q' + rx + ' ' + cy + ' ' + (rx + 6) + ' ' + cy + 'H' + k._x + '"/>');
        });
        return;
      }
      var px = n._x + cw(n) / 2, y1 = n._y + CH, mid = y1 + VG / 2;
      // Grey links first, the highlighted path on top.
      n.kids.slice().sort(function (a, b) { return S.path.has(a.id) - S.path.has(b.id); }).forEach(function (k) {
        links.push('<path class="org-link' + on(k) + '" d="' + elbow(px, y1, k._x + cw(k) / 2, k._y, mid) + '"/>');
      });
    });
    var z = S.zoom;
    canvas.innerHTML =
      '<div class="org-stage" style="width:' + Math.ceil(W * z) + 'px;height:' + Math.ceil(H * z) + 'px">' +
        '<div class="org-world" style="width:' + W + 'px;height:' + H + 'px;transform:scale(' + z + ')">' +
          '<svg class="org-links" width="' + W + '" height="' + H + '" aria-hidden="true">' + links.join('') + '</svg>' +
          out.map(cardHtml).join('') +
        '</div>' +
      '</div>';
    S.size = { w: W, h: H };
    document.getElementById('orgZoomReset').textContent = Math.round(z * 100) + '%';
  }

  /* ---------- phone list ---------- */

  function renderList() {
    var host = document.getElementById('orgList');
    var rows = [];
    (function row(n) {
      var info = lvInfo(n), open = isOpen(n);
      var cls = ['org-row', info.tone];
      if (S.path.has(n.id)) cls.push('on-path');
      if (S.hit === n.id) cls.push('hit');
      if (S.sel === n.id) cls.push('sel');
      if (n.confidence !== 'confirmed') cls.push('c-' + n.confidence);
      var counts = countText(n);
      rows.push('<div class="' + cls.join(' ') + '" data-id="' + n.id + '" role="treeitem" tabindex="0" aria-level="' + (n.depth + 1) + '" aria-selected="' + (S.sel === n.id) + '"' + (n.kids.length ? ' aria-expanded="' + open + '"' : '') + ' style="--d:' + n.depth + '">' +
        '<span class="org-row-chev' + (n.kids.length ? '' : ' none') + (open ? ' open' : '') + '">' + (n.kids.length ? svgIcon('chev') : '') + '</span>' +
        '<span class="org-row-main">' +
          '<span class="org-row-top"><span class="org-row-name">' + esc(n.name) + '</span>' +
            (n.live ? '<span class="org-badge live">Live in app</span>' : '') +
            (n.confidence !== 'confirmed' ? '<span class="org-conf ' + n.confidence + '">' + CONF[n.confidence].label + '</span>' : '') + '</span>' +
          '<span class="org-row-meta"><span class="org-c-lv">' + esc(info.label) + '</span>' + (n.code ? ' · <span class="org-c-code">' + esc(n.code) + '</span>' : '') + (counts ? ' · ' + esc(counts) : '') + '</span>' +
        '</span>' +
        '<button type="button" class="org-row-info" data-info="' + n.id + '" aria-label="Details of ' + esc(n.name) + '">' + svgIcon('info') + '</button>' +
        '</div>');
      if (open) n.kids.forEach(row);
    })(S.tree.root);
    host.innerHTML = rows.join('');
  }

  /* ---------- detail panel ---------- */

  function renderDetail() {
    var host = document.getElementById('orgDetail');
    var n = S.tree.byId[S.sel] || S.tree.root;
    var info = lvInfo(n), raw = n.raw;
    var path = pathOf(n);
    var dl = [];
    function row(k, v) { if (v) dl.push('<dt>' + esc(k) + '</dt><dd>' + v + '</dd>'); }
    row('Level', esc(info.label));
    row('Code', n.code ? '<span class="org-mono">' + esc(n.code) + '</span>' : '<span class="org-muted">Not published</span>');
    row('Also called', n.aliases.length ? n.aliases.map(function (a) { return '<span class="org-chip">' + esc(a) + '</span>'; }).join('') : '');
    row('Parent path', path.length > 1 ? path.slice(0, -1).map(function (p) {
      return '<button type="button" class="org-crumb" data-go="' + p.id + '">' + esc(p.name) + '</button>';
    }).join('<span class="org-crumb-sep">›</span>') : '<span class="org-muted">Top of the hierarchy</span>');
    var counts = countText(n);
    row('Contains', counts ? esc(counts) : '<span class="org-muted">No offices below</span>');
    [['head', 'Headed by'], ['hq', 'Headquarters'], ['town', 'Office at'], ['district', n.level === 'zone' ? 'Districts' : 'District']].forEach(function (f) {
      if (typeof raw[f[0]] === 'string' && raw[f[0]]) row(f[1], esc(raw[f[0]]));
    });
    row('Confidence', '<span class="org-conf ' + n.confidence + ' solid">' + CONF[n.confidence].label + '</span><span class="org-dd-note">' + esc(CONF[n.confidence].text) + '</span>');
    if (n.inLive || n.live) {
      row('In this app', n.inApp
        ? '<span class="org-ok">Yes</span><span class="org-dd-note">Matches ' + esc(n.inApp.name) + (n.inApp.code ? ' (' + esc(n.inApp.code) + ')' : '') + ' in the app’s office master.</span>'
        : '<span class="org-warn">No</span><span class="org-dd-note">The app’s office master has no office matching this one.</span>');
    }
    if (raw.zoneConfidence && CONF[raw.zoneConfidence]) {
      row('Zones under it', '<span class="org-conf ' + raw.zoneConfidence + ' solid">' + CONF[raw.zoneConfidence].label + '</span><span class="org-dd-note">' +
        (raw.zoneConfidence === 'inferred' ? 'No public source says which zones report to which chief engineer; this split follows geography.' : esc(CONF[raw.zoneConfidence].text)) + '</span>');
    }
    if (raw.formerDivision) row('Former division', esc(raw.formerDivision));
    var note = raw.note || raw.notes;
    if (typeof note === 'string' && note) row('Note', esc(note));
    var srcs = nodeSources(raw).map(sourceLink).filter(Boolean);
    row('Sources', srcs.length ? '<span class="org-src-list">' + srcs.join('') + '</span>' : '<span class="org-muted">The dataset’s sources (below the chart)</span>');

    var kids = '';
    if (n.kids.length) {
      var lv = n.kids[0].level, L = LEVELS[lv];
      kids = '<div class="org-d-kids"><h4>' + esc(L ? L.many.charAt(0).toUpperCase() + L.many.slice(1) : 'Offices') + ' <small>' + n.kids.length + '</small></h4>' +
        '<div class="org-d-kid-list">' + n.kids.map(function (k) {
          return '<button type="button" class="org-kid' + (k.confidence !== 'confirmed' ? ' c-' + k.confidence : '') + '" data-go="' + k.id + '">' + esc(k.name) + (k.kids.length ? '<small>' + k.kids.length + '</small>' : '') + '</button>';
        }).join('') + '</div></div>';
    }
    var missing = '';
    if (n.live && S.body.live && S.body.live.missing && S.body.live.missing.length) {
      missing = '<div class="org-d-missing"><h4>In the app, not in this dataset <small>' + S.body.live.missing.length + '</small></h4><p>' +
        S.body.live.missing.map(function (m) { return esc(m.name) + ' <span class="org-muted">(' + esc(LEVELS[m.level] ? LEVELS[m.level].label : m.level) + ' ' + esc(m.code) + ')</span>'; }).join(', ') + '</p></div>';
    }
    host.innerHTML =
      '<div class="org-d-head ' + info.tone + '">' +
        '<div class="org-d-badges"><span class="org-c-lv">' + esc(info.label) + '</span>' +
          (n.live ? '<span class="org-badge live">Live in app</span>' : '') +
          (n.confidence !== 'confirmed' ? '<span class="org-conf ' + n.confidence + '">' + CONF[n.confidence].label + '</span>' : '') + '</div>' +
        '<h3>' + esc(n.name) + '</h3>' +
        (n.zone && n.level !== 'zone' ? '<p class="org-muted">' + esc(n.zone.name) + '</p>' : '') +
      '</div>' +
      '<dl class="org-dl">' + dl.join('') + '</dl>' +
      (n.kids.length ? '<div class="org-d-act"><button type="button" class="ui-btn sm" data-act="' + (isOpen(n) ? 'close' : 'open') + '" data-id="' + n.id + '">' + (isOpen(n) ? 'Collapse' : 'Expand') + '</button>' +
        (n.level === 'zone' ? '<button type="button" class="ui-btn sm" data-act="all" data-id="' + n.id + '">Expand all in zone</button>' : '') + '</div>' : '') +
      kids + missing;
  }

  function nodeSources(raw) {
    var list = [].concat(Array.isArray(raw.sources) ? raw.sources : [], Array.isArray(raw.source) ? raw.source : (raw.source != null ? [raw.source] : []));
    return list.map(function (s) {
      if (typeof s === 'number') return (S.body.sources || [])[s];
      if (typeof s === 'string' && /^\d+$/.test(s)) return (S.body.sources || [])[Number(s)];
      if (typeof s === 'string') {
        var byId = (S.body.sources || []).filter(function (x) { return x && typeof x === 'object' && (x.id === s || x.key === s); })[0];
        return byId || s;
      }
      return s;
    }).filter(Boolean);
  }

  /* ---------- render + interaction ---------- */

  function render(keep) {
    var phone = S.mq.matches;
    document.getElementById('orgCanvas').hidden = phone;
    document.getElementById('orgList').hidden = !phone;
    document.querySelector('#orgTab .org-zoom').hidden = phone;
    var canvas = document.getElementById('orgCanvas');
    var before = null;
    if (!phone && keep) {
      var el = canvas.querySelector('.org-card[data-id="' + keep + '"]');
      if (el) before = el.getBoundingClientRect();
    }
    if (phone) renderList(); else renderChart();
    renderDetail();
    var zoneOf = (S.tree.byId[S.sel] || {}).zone;
    var zb = document.getElementById('orgExpandZone');
    zb.disabled = !zoneOf;
    zb.title = zoneOf ? 'Expand every office in ' + zoneOf.name : 'Select a zone or an office in one first';
    if (before) {
      // Keep the clicked card where it was on screen, so opening or closing does not throw the view around.
      var after = canvas.querySelector('.org-card[data-id="' + keep + '"]');
      if (after) {
        var r = after.getBoundingClientRect();
        canvas.scrollLeft += r.left - before.left;
        canvas.scrollTop += r.top - before.top;
      }
    }
  }

  function select(id, toggle) {
    var n = S.tree.byId[id];
    if (!n) return;
    S.sel = id;
    if (toggle && n.kids.length) {
      if (S.open.has(id)) closeBelow(n); else S.open.add(id);
    }
    render(id);
  }

  function closeBelow(n) {
    S.open.delete(n.id);
    n.kids.forEach(closeBelow);
  }

  function expandAll(n) {
    S.open.add(n.id);
    n.kids.forEach(expandAll);
  }

  function reveal(id, opts) {
    var n = S.tree.byId[id];
    if (!n) return;
    var p = pathOf(n);
    p.slice(0, -1).forEach(function (x) { S.open.add(x.id); });
    S.path = new Set(p.map(function (x) { return x.id; }));
    S.hit = id;
    S.sel = id;
    render();
    centreOn(id, opts && opts.smooth);
  }

  function centreOn(id, smooth) {
    if (S.mq.matches) {
      var row = document.querySelector('#orgList .org-row[data-id="' + id + '"]');
      if (row) row.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
      return;
    }
    var canvas = document.getElementById('orgCanvas');
    var n = S.tree.byId[id];
    if (!n || n._x == null) return;
    var z = S.zoom, w = cw(n), h = n._stack ? SH : CH;
    var left = (n._x + w / 2) * z - canvas.clientWidth / 2;
    var top = (n._y + h / 2) * z - canvas.clientHeight / 2;
    canvas.scrollTo({ left: Math.max(0, left), top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
  }

  function setZoom(z, anchorCentre) {
    var canvas = document.getElementById('orgCanvas');
    z = Math.max(0.4, Math.min(1.6, Math.round(z * 100) / 100));
    var cx = (canvas.scrollLeft + canvas.clientWidth / 2) / S.zoom;
    var cy = (canvas.scrollTop + canvas.clientHeight / 2) / S.zoom;
    S.zoom = z;
    render();
    if (anchorCentre !== false) {
      canvas.scrollLeft = cx * z - canvas.clientWidth / 2;
      canvas.scrollTop = cy * z - canvas.clientHeight / 2;
    }
  }

  // Fit the chart's width (min: a floor below which cards stop being readable; the first view uses 0.7).
  function fit(min) {
    var canvas = document.getElementById('orgCanvas');
    if (!S.size || !canvas.clientWidth) return;
    var z = Math.max(min || 0.4, Math.min(1, (canvas.clientWidth - 4) / S.size.w));
    setZoom(z, false);
    var canvasW = canvas.clientWidth;
    canvas.scrollLeft = Math.max(0, (S.size.w * S.zoom - canvasW) / 2);
    canvas.scrollTop = 0;
  }

  /* search */

  function searchHits(q) {
    var k = norm(q);
    if (!k) return [];
    var hits = [];
    S.tree.nodes.forEach(function (n) {
      var best = 9;
      n.search.forEach(function (s, i) {
        var score = s === k ? 0 : s.indexOf(k) === 0 ? 1 : (' ' + s).indexOf(' ' + k) >= 0 ? 2 : s.indexOf(k) >= 0 ? 3 : 9;
        if (i > 1 && score < 9) score += 0.5; // an alias ranks after the name and the code
        best = Math.min(best, score);
      });
      if (best < 9) hits.push({ n: n, score: best + n.depth * 0.01 });
    });
    hits.sort(function (a, b) { return a.score - b.score || a.n.name.localeCompare(b.n.name); });
    return hits.slice(0, 8).map(function (h) { return h.n; });
  }

  function showHits(list) {
    var ul = document.getElementById('orgHits');
    var box = ul.parentNode;
    S.hits = list;
    S.hitIx = list.length ? 0 : -1;
    if (!document.getElementById('orgQ').value.trim()) { ul.hidden = true; box.setAttribute('aria-expanded', 'false'); return; }
    ul.innerHTML = list.length ? list.map(function (n, i) {
      var p = pathOf(n).slice(1, -1).map(function (x) { return x.name; }).join(' › ');
      return '<li role="option" id="orgHit' + i + '" data-id="' + n.id + '" aria-selected="' + (i === 0) + '">' +
        '<span class="org-hit-top"><i class="org-sw ' + lvInfo(n).tone + '"></i><b>' + esc(n.name) + '</b><span class="org-c-lv">' + esc(lvInfo(n).label) + '</span>' + (n.code ? '<span class="org-c-code">' + esc(n.code) + '</span>' : '') + '</span>' +
        (p ? '<span class="org-hit-path">' + esc(p) + '</span>' : '') + '</li>';
    }).join('') : '<li class="org-hit-none">No office matches</li>';
    ul.hidden = false;
    box.setAttribute('aria-expanded', 'true');
  }

  function pickHit(n) {
    var ul = document.getElementById('orgHits');
    ul.hidden = true;
    ul.parentNode.setAttribute('aria-expanded', 'false');
    if (!n) return;
    document.getElementById('orgQ').value = n.name;
    reveal(n.id, { smooth: true });
  }

  function moveHit(d) {
    if (!S.hits.length) return;
    S.hitIx = (S.hitIx + d + S.hits.length) % S.hits.length;
    document.querySelectorAll('#orgHits li[role="option"]').forEach(function (li, i) { li.setAttribute('aria-selected', String(i === S.hitIx)); if (i === S.hitIx) li.scrollIntoView({ block: 'nearest' }); });
  }

  function wire() {
    var canvas = document.getElementById('orgCanvas');
    var q = document.getElementById('orgQ');
    var t = null;
    q.addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () {
        if (!q.value.trim()) { S.path = new Set(); S.hit = null; render(); }
        showHits(searchHits(q.value));
      }, 120);
    });
    q.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveHit(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveHit(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); clearTimeout(t); if (!S.hits.length) S.hits = searchHits(q.value), S.hitIx = 0; pickHit(S.hits[S.hitIx] || null); }
      else if (e.key === 'Escape') { document.getElementById('orgHits').hidden = true; }
    });
    document.getElementById('orgHits').addEventListener('mousedown', function (e) {
      var li = e.target.closest('li[data-id]');
      if (!li) return;
      e.preventDefault();
      pickHit(S.tree.byId[li.getAttribute('data-id')]);
    });
    q.addEventListener('blur', function () { setTimeout(function () { document.getElementById('orgHits').hidden = true; }, 150); });

    function activate(e) {
      var go = e.target.closest('[data-go]');
      if (go) { reveal(go.getAttribute('data-go'), { smooth: true }); return true; }
      var act = e.target.closest('[data-act]');
      if (act) {
        var n = S.tree.byId[act.getAttribute('data-id')];
        var a = act.getAttribute('data-act');
        if (a === 'open') S.open.add(n.id);
        else if (a === 'close') closeBelow(n);
        else if (a === 'all') expandAll(n);
        render(n.id);
        return true;
      }
      var find = e.target.closest('[data-find]');
      if (find) {
        var z = S.tree.nodes.filter(function (x) { return x.live; })[0];
        if (z) { S.open.add(z.id); reveal(z.id, { smooth: true }); }
        return true;
      }
      return false;
    }
    document.getElementById('orgDetail').addEventListener('click', activate);
    document.getElementById('orgStats').addEventListener('click', activate);

    canvas.addEventListener('click', function (e) {
      if (S.dragged) return;
      var card = e.target.closest('.org-card');
      if (card) select(card.getAttribute('data-id'), true);
    });
    document.getElementById('orgList').addEventListener('click', function (e) {
      var info = e.target.closest('[data-info]');
      if (info) {
        S.sel = info.getAttribute('data-info');
        render();
        document.getElementById('orgDetail').scrollIntoView({ block: 'start', behavior: 'smooth' });
        return;
      }
      var row = e.target.closest('.org-row');
      if (row) select(row.getAttribute('data-id'), true);
    });
    function keys(e) {
      var item = e.target.closest('[role="treeitem"]');
      if (!item) return;
      var n = S.tree.byId[item.getAttribute('data-id')];
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(n.id, true); focusItem(n.id); }
      else if (e.key === 'ArrowRight' && n.kids.length && !S.open.has(n.id)) { e.preventDefault(); select(n.id, true); focusItem(n.id); }
      else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (S.open.has(n.id)) { select(n.id, true); focusItem(n.id); }
        else if (n.parent) { S.sel = n.parent.id; render(); focusItem(n.parent.id); }
      }
    }
    canvas.addEventListener('keydown', keys);
    document.getElementById('orgList').addEventListener('keydown', keys);

    // Drag the background to pan (mouse and pen; touch scrolls natively).
    var drag = null;
    canvas.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch' || e.button !== 0 || e.target.closest('.org-card')) return;
      drag = { x: e.clientX, y: e.clientY, l: canvas.scrollLeft, t: canvas.scrollTop, moved: false };
      S.dragged = false;
    });
    window.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      drag.moved = true;
      canvas.classList.add('panning');
      canvas.scrollLeft = drag.l - dx;
      canvas.scrollTop = drag.t - dy;
    });
    window.addEventListener('pointerup', function () {
      if (!drag) return;
      S.dragged = drag.moved;
      drag = null;
      canvas.classList.remove('panning');
      setTimeout(function () { S.dragged = false; }, 0);
    });
    canvas.addEventListener('wheel', function (e) {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setZoom(S.zoom * (e.deltaY < 0 ? 1.1 : 0.9));
    }, { passive: false });

    document.getElementById('orgZoomIn').addEventListener('click', function () { setZoom(S.zoom + 0.1); });
    document.getElementById('orgZoomOut').addEventListener('click', function () { setZoom(S.zoom - 0.1); });
    document.getElementById('orgZoomReset').addEventListener('click', function () { setZoom(1); });
    document.getElementById('orgFit').addEventListener('click', function () { fit(); });
    document.getElementById('orgCollapse').addEventListener('click', function () {
      S.open = new Set([S.tree.root.id]);
      S.tree.root.kids.forEach(function (k) { if (k.level === 'chief_engineer') S.open.add(k.id); });
      S.path = new Set(); S.hit = null;
      var sel = S.tree.byId[S.sel];
      if (sel && sel.zone && sel !== sel.zone) S.sel = sel.zone.id;
      render();
      fit(0.7);
    });
    document.getElementById('orgExpandZone').addEventListener('click', function () {
      var n = S.tree.byId[S.sel];
      if (!n || !n.zone) return;
      expandAll(n.zone);
      S.sel = n.zone.id;
      render();
      centreOn(n.zone.id, true);
    });
    var onMq = function () { render(); if (S.sel) centreOn(S.sel); };
    if (S.mq.addEventListener) S.mq.addEventListener('change', onMq); else S.mq.addListener(onMq);
  }

  function focusItem(id) {
    var el = document.querySelector('#orgTab [role="treeitem"][data-id="' + id + '"]');
    if (el) el.focus({ preventScroll: true });
  }

  async function load() {
    var res = await fetch('/api/admin/org', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok || body.status !== 'success') throw new Error(body.message || ('HTTP ' + res.status));
    return body;
  }

  async function mount(el) {
    if (S && S.el === el) { if (S.tree && !S.mq.matches && S.fitPending) { S.fitPending = false; fit(0.7); } return; }
    skeleton(el);
    S = { el: el, mq: window.matchMedia(PHONE), open: new Set(), path: new Set(), hit: null, sel: null, zoom: 1, hits: [], hitIx: -1, dragged: false };
    var body;
    try {
      body = await load();
    } catch (e) {
      document.getElementById('orgCanvas').innerHTML = '<div class="ui-empty">Could not load the office hierarchy: ' + esc(e.message) + '</div>';
      document.getElementById('orgSub').textContent = 'Office hierarchy unavailable.';
      return;
    }
    S.body = body;
    if (body.confidenceKey && typeof body.confidenceKey === 'object') {
      Object.keys(CONF).forEach(function (k) {
        var t = body.confidenceKey[k];
        if (typeof t === 'string' && t) CONF[k].text = t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.');
      });
    }
    S.tree = prepare(body);
    var root = S.tree.root;
    S.open.add(root.id);
    root.kids.forEach(function (k) { if (k.level === 'chief_engineer') S.open.add(k.id); }); // first view: down to the zones
    var live = S.tree.nodes.filter(function (n) { return n.live; })[0];
    var zones = S.tree.nodes.filter(function (n) { return n.level === 'zone'; });
    if (live && zones.length <= 3) S.open.add(live.id);
    S.sel = root.id;
    renderStats();
    renderFoot();
    wire();
    render();
    if (el.offsetParent) fit(0.7); else S.fitPending = true;
  }

  window.MzoOrg = { mount: mount, _prepare: prepare };
})();
