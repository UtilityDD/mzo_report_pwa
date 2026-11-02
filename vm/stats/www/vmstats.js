/* VM stats page: live numbers, history charts, services, storage and processes.
 * Reads the JSON that vm/stats/sampler.py writes (now.json every 5 s; hour/day/week history).
 * Used by the public stats site (vm/stats/www/index.html) and the data portal's Server page.
 *
 *   VmStats.mount(host, { data: 'data/', title: 'MZO server' }) -> { dispose }
 *
 * Needs the app kit: /kit/mzo_theme.css and /kit/mzo_ui.js (window.UI: esc, n, line, bar).
 * Times are shown in the browser's time zone.
 */
(function (w) {
  'use strict';
  var UI = w.UI;
  var esc = UI.esc, n = UI.n;
  var POLL = 5000;
  var RANGES = {
    hour: { file: 'hour.json', label: '1 hour', window: 3600, bucket: 10 },
    day: { file: 'day.json', label: '24 hours', window: 86400, bucket: 240 },
    week: { file: 'week.json', label: '7 days', window: 7 * 86400, bucket: 1800 }
  };
  // Colour follows the entity: each service keeps its slot on both service charts.
  var SERVICE_SERIES = [['app', 'App', 1], ['pb', 'PocketBase', 2], ['caddy', 'Caddy', 3], ['sync', 'Data sync', 4]];
  var CHARTS = [
    { id: 'cpu', title: 'CPU', unit: 'pct', series: [['cpu', 'Busy', 1], ['iow', 'Waiting for disk', 2], ['st', 'Taken by the cloud host (steal)', 3]] },
    { id: 'mem', title: 'Memory', unit: 'mb', series: [['mu', 'In use', 1], ['sw', 'Swap in use', 2]] },
    { id: 'smem', title: 'Memory by service', unit: 'mb', series: SERVICE_SERIES.map(function (s) { return ['m_' + s[0], s[1], s[2]]; }) },
    { id: 'scpu', title: 'CPU by service', unit: 'pct', series: SERVICE_SERIES.map(function (s) { return ['c_' + s[0], s[1], s[2]]; }) },
    { id: 'net', title: 'Network', unit: 'rate', series: [['rx', 'In (download)', 1], ['tx', 'Out (upload)', 2]] },
    { id: 'disk', title: 'Disk activity', unit: 'rate', series: [['dr', 'Read', 1], ['dw', 'Write', 2]] }
  ];

  /* ---------- formatting ---------- */
  function num(v, d) { return v == null || !isFinite(v) ? '—' : Number(v).toFixed(d); }
  function pct(v) { return v == null ? '—' : (v < 10 ? num(v, 1) : num(v, 0)) + '%'; }
  function mb(v) {
    if (v == null) return '—';
    if (Math.abs(v) >= 1024) return num(v / 1024, v >= 10240 ? 0 : 1) + ' GB';
    return n(Math.round(v)) + ' MB';
  }
  function bytes(v) {
    if (v == null) return '—';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (Math.abs(v) >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? Math.round(v) : num(v, v < 10 ? 1 : 0)) + ' ' + u[i];
  }
  function rate(kb) {
    if (kb == null) return '—';
    if (kb >= 1024) return num(kb / 1024, kb >= 10240 ? 0 : 1) + ' MB/s';
    return num(kb, kb < 10 ? 1 : 0) + ' KB/s';
  }
  var FMT = { pct: pct, mb: mb, rate: rate };
  var AXIS = {
    pct: function (v) { return Math.round(v * 10) / 10 + '%'; },
    mb: function (v) { return v >= 1024 ? Math.round(v / 102.4) / 10 + ' GB' : Math.round(v) + ' MB'; },
    rate: function (v) { return v >= 1024 ? Math.round(v / 102.4) / 10 + ' MB/s' : Math.round(v * 10) / 10 + ' KB/s'; }
  };
  function two(x) { return (x < 10 ? '0' : '') + x; }
  function clock(t) { var d = new Date(t * 1000); return two(d.getHours()) + ':' + two(d.getMinutes()); }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function dayLabel(t) { var d = new Date(t * 1000); return d.getDate() + ' ' + MON[d.getMonth()]; }
  function stamp(t) { var d = new Date(t * 1000); return DAY[d.getDay()] + ' ' + d.getDate() + ' ' + MON[d.getMonth()] + ', ' + clock(t); }
  function dur(s) {
    s = Math.max(0, Math.round(s));
    if (s < 60) return s + ' s';
    if (s < 3600) return Math.floor(s / 60) + ' min';
    if (s < 86400) return Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min';
    return Math.floor(s / 86400) + ' d ' + Math.floor((s % 86400) / 3600) + ' h';
  }
  function ago(t, now) { return t ? dur(now - t) + ' ago' : '—'; }

  /* ---------- history -> chart rows ---------- */
  // A fixed time grid over the whole range, ending at the newest point. Empty buckets stay null,
  // so the lines break where the sampler was not running.
  function grid(hist, range, end) {
    var R = RANGES[range], b = R.bucket, last = Math.floor(end / b) * b, first = last - R.window + b;
    var count = Math.round((last - first) / b) + 1, sums = {}, cnt = {}, t = (hist && hist.t) || [];
    var keys = [];
    CHARTS.forEach(function (c) { c.series.forEach(function (s) { keys.push(s[0]); }); });
    keys.forEach(function (k) { sums[k] = new Array(count).fill(0); cnt[k] = new Array(count).fill(0); });
    for (var i = 0; i < t.length; i++) {
      // History points are stamped at the start of their minute / quarter: centre them in the grid.
      var at = t[i] + (range === 'hour' ? 0 : (hist.step || 0) / 2), j = Math.floor((at - first) / b);
      if (j < 0 || j >= count) continue;
      keys.forEach(function (k) { var v = hist[k] && hist[k][i]; if (v != null && isFinite(v)) { sums[k][j] += v; cnt[k][j]++; } });
    }
    var out = { times: [], cols: {} };
    for (var g = 0; g < count; g++) out.times.push(first + g * b);
    keys.forEach(function (k) { out.cols[k] = sums[k].map(function (s, g) { return cnt[k][g] ? s / cnt[k][g] : null; }); });
    return out;
  }

  /* ---------- health ---------- */
  function health(d, now) {
    var out = [];
    var stale = now - d.t;
    if (stale > 30) out.push(['bad', 'Stats stopped updating ' + dur(stale) + ' ago']);
    (d.services || []).forEach(function (s) {
      var oneshot = s.key === 'sync' || s.key === 'deploy';
      if (s.state === 'failed') out.push(['bad', s.label + (oneshot ? ': last run failed' : ' has failed')]);
      else if (!oneshot && s.state !== 'active' && s.key !== 'stats') out.push(['bad', s.label + ' is not running']);
    });
    var m = d.mem || {};
    if (m.avail != null && m.avail < 60) out.push(['bad', 'Memory nearly full: ' + mb(m.avail) + ' free']);
    else if (m.avail != null && m.avail < 120) out.push(['warn', 'Memory low: ' + mb(m.avail) + ' free']);
    if (d.swapIO && d.swapIO['in'] > 50) out.push(['warn', 'Swapping (' + n(Math.round(d.swapIO['in'])) + ' pages/s)']);
    (d.fs || []).forEach(function (f) {
      var p = f.total ? (f.used / f.total) * 100 : 0;
      if (p > 95) out.push(['bad', 'Disk ' + f.mount + ' is ' + Math.round(p) + '% full']);
      else if (p > 85) out.push(['warn', 'Disk ' + f.mount + ' is ' + Math.round(p) + '% full']);
    });
    if (d.cpu && d.cpu.steal > 20) out.push(['warn', 'The cloud host is taking ' + pct(d.cpu.steal) + ' of the CPU']);
    if (d.oomKills > 0) out.push(['warn', d.oomKills + (d.oomKills === 1 ? ' process was' : ' processes were') + ' stopped for lack of memory since boot']);
    if (d.syncAt && now - d.syncAt > 1800) out.push(['warn', 'Data sync last finished ' + ago(d.syncAt, now)]);
    if (d.deploy && d.deploy.status && d.deploy.status !== 'ok' && d.deploy.status !== 'deploying') out.push(['warn', 'Last deploy: ' + d.deploy.status]);
    return out;
  }

  /* ---------- the page ---------- */
  function mount(host, opts) {
    opts = opts || {};
    var base = opts.data || 'data/';
    var range = 'hour', now = null, hist = {}, timer = null, histTimer = null, dead = false, failures = 0;

    host.classList.add('vs');
    host.innerHTML =
      '<div class="ui-head vs-head"><div><h1>' + esc(opts.title || 'Server') + '</h1><p class="vs-meta" data-r="meta">Loading…</p></div>' +
      '<div class="ui-actions"><span class="vs-live" data-r="live"><i class="ui-dot"></i><span>Connecting…</span></span>' +
      '<div class="ui-seg" role="group" aria-label="Time range" data-r="range">' +
      Object.keys(RANGES).map(function (k) { return '<button type="button" data-v="' + k + '" aria-pressed="' + (k === range) + '">' + RANGES[k].label + '</button>'; }).join('') +
      '</div></div></div>' +
      '<div class="vs-health" data-r="health" role="status"></div>' +
      '<div class="ui-stats vs-stats" data-r="stats" style="--n:6">' + new Array(7).join('<div class="ui-stat"><div class="k">&nbsp;</div><div class="v"><span class="ui-skel"></span></div><div class="s">&nbsp;</div></div>') + '</div>' +
      '<div class="vs-charts">' + CHARTS.map(function (c) {
        return '<section class="ui-panel vs-chart"><div class="ui-panel-h"><h2>' + esc(c.title) + ' <small data-r="sub-' + c.id + '"></small></h2></div><div class="vs-plot"><div data-r="chart-' + c.id + '"><div class="ui-skel vs-skel"></div></div><div class="ui-empty vs-empty" data-r="empty-' + c.id + '" hidden></div></div></section>';
      }).join('') + '</div>' +
      '<div class="vs-two">' +
      '<section class="ui-panel"><div class="ui-panel-h"><h2>Services</h2></div><div class="ui-table-wrap" data-r="services"></div></section>' +
      '<section class="ui-panel"><div class="ui-panel-h"><h2>Storage <small data-r="sub-storage"></small></h2></div><div class="vs-storage" data-r="storage"></div></section>' +
      '</div>' +
      '<section class="ui-panel vs-procs"><div class="ui-panel-h"><h2>Processes <small data-r="sub-procs"></small></h2></div><div class="ui-table-wrap" data-r="procs"></div></section>' +
      '<p class="vs-foot" data-r="foot"></p>';

    function $(r) { return host.querySelector('[data-r="' + r + '"]'); }

    function setLive(state, text) {
      var el = $('live');
      el.className = 'vs-live ' + state;
      el.innerHTML = '<i class="ui-dot ' + (state === 'on' ? 'ok' : state === 'off' ? 'bad' : '') + '"></i><span>' + esc(text) + '</span>';
    }

    function get(file) {
      return fetch(base + file, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      });
    }

    /* charts */
    function drawCharts() {
      if (!now) return;
      var h = hist[range];
      var g = grid(h, range, now.t);
      var labels = g.times.map(range === 'week' ? dayLabel : clock);
      var tips = g.times.map(range === 'hour' ? function (t) { return clock(t) + ':' + two(new Date(t * 1000).getSeconds()); } : stamp);
      CHARTS.forEach(function (c) {
        var el = $('chart-' + c.id), empty = $('empty-' + c.id);
        var series = c.series.map(function (s) { return { label: s[1], values: g.cols[s[0]], color: s[2] }; });
        var points = 0;
        series.forEach(function (s) { s.values.forEach(function (v) { if (v != null) points++; }); });
        // A hidden chart has no width, so the kit's resize redraw leaves it alone.
        if (points < 2 * series.length) {
          empty.textContent = 'Collecting data. The ' + RANGES[range].label + ' chart fills in as the sampler runs' +
            (range === 'hour' ? '.' : range === 'day' ? ' (one point a minute).' : ' (one point every 15 minutes).');
          empty.hidden = false; el.hidden = true;
          return;
        }
        empty.hidden = true; el.hidden = false;
        if (!el.__vsMO && w.MutationObserver) {
          // The kit redraws on resize: hide repeated dates again after every draw.
          el.__vsMO = new MutationObserver(function () { if (range === 'week') dedupeAxis(el); });
          el.__vsMO.observe(el, { childList: true });
        }
        UI.line(el, { title: c.title, labels: labels, tipLabels: tips, series: series, fmt: FMT[c.unit], axis: AXIS[c.unit], height: 190 });
      });
    }

    // 7 days: the kit spaces x labels evenly, so one date can show twice; keep the first of each.
    function dedupeAxis(el) {
      var prev = null;
      Array.prototype.forEach.call(el.querySelectorAll('svg text[text-anchor="middle"]'), function (t) {
        if (t.textContent === prev) t.setAttribute('visibility', 'hidden'); else prev = t.textContent;
      });
    }

    function loadRange(r) {
      return get(RANGES[r].file).then(function (d) { hist[r] = d; }).catch(function () { hist[r] = hist[r] || null; });
    }

    // The hour chart grows from now.json between hour.json writes.
    function appendPoint(p) {
      var h = hist.hour;
      if (!h || !p || !h.t) return;
      var lastT = h.t.length ? h.t[h.t.length - 1] : 0;
      if (p.t <= lastT) return;
      (h.cols || Object.keys(p)).forEach(function (k) { (h[k] = h[k] || []).push(p[k] == null ? null : p[k]); });
      var cut = p.t - 3600, drop = 0;
      while (drop < h.t.length && h.t[drop] <= cut) drop++;
      if (drop) (h.cols || Object.keys(p)).forEach(function (k) { if (h[k]) h[k].splice(0, drop); });
    }

    /* numbers */
    function stat(k, v, s, tone) {
      return '<div class="ui-stat"><div class="k">' + (tone ? '<i class="ui-dot ' + tone + '"></i>' : '') + esc(k) + '</div><div class="v">' + esc(v) + '</div><div class="s">' + esc(s || '') + '</div></div>';
    }

    function drawNumbers(d, t) {
      var c = d.cpu || {}, m = d.mem || {}, root = (d.fs || [])[0];
      var host_ = d.host || {};
      $('meta').textContent = [host_.os, (c.cores || host_.cores) + ' vCPU', mb(m.total) + ' RAM', host_.cpuModel].filter(Boolean).join(' · ');
      var memTone = m.avail < 60 ? 'bad' : m.avail < 120 ? 'warn' : '';
      var diskP = root && root.total ? (root.used / root.total) * 100 : null;
      $('stats').innerHTML =
        stat('CPU', pct(c.pct), 'Load ' + (c.load ? num(c.load[0], 2) : '—') + ' · ' + (c.cores || '?') + ' vCPU') +
        stat('Memory in use', mb(m.used), 'of ' + mb(m.total) + ' · ' + mb(m.avail) + ' free', memTone) +
        stat('Swap in use', mb(m.swapUsed), 'of ' + mb(m.swapTotal), d.swapIO && d.swapIO['in'] > 50 ? 'warn' : '') +
        stat('Disk' + (root ? ' ' + root.mount : ''), diskP == null ? '—' : Math.round(diskP) + '%', root ? bytes(root.used) + ' of ' + bytes(root.total) : '', diskP > 95 ? 'bad' : diskP > 85 ? 'warn' : '') +
        stat('Network', rate((d.net || {}).rx + (d.net || {}).tx), 'In ' + rate((d.net || {}).rx) + ' · out ' + rate((d.net || {}).tx)) +
        stat('Up for', dur(d.uptime || 0), host_.bootTime ? 'Since ' + stamp(host_.bootTime) : '');
      var p = d.point || {};
      $('sub-cpu').textContent = pct(p.cpu) + ' now';
      $('sub-mem').textContent = mb(p.mu) + ' of ' + mb(m.total);
      $('sub-smem').textContent = 'without file cache';
      $('sub-scpu').textContent = '% of the whole machine';
      $('sub-net').textContent = 'in ' + rate(p.rx) + ' · out ' + rate(p.tx);
      $('sub-disk').textContent = 'read ' + rate(p.dr) + ' · write ' + rate(p.dw);

      var issues = health(d, t);
      $('health').innerHTML = issues.length
        ? issues.map(function (i) { return '<span class="ui-badge ' + i[0] + '"><i class="ui-dot ' + i[0] + '"></i>' + esc(i[1]) + '</span>'; }).join('')
        : '<span class="ui-badge ok"><i class="ui-dot ok"></i>All services running · memory, disk and CPU normal</span>';
    }

    function serviceState(s, t) {
      var oneshot = s.key === 'sync' || s.key === 'deploy';
      if (oneshot) {
        if (s.state === 'active' || s.state === 'activating') return ['ok', 'Running now', s.lastStart ? 'started ' + ago(s.lastStart, t) : ''];
        if (s.state === 'failed' || (s.result && s.result !== 'success')) return ['bad', 'Last run failed', s.lastExit ? ago(s.lastExit, t) : ''];
        var took = s.lastStart && s.lastExit && s.lastExit >= s.lastStart ? ' · took ' + dur(s.lastExit - s.lastStart) : '';
        var next = '';
        if (s.key === 'sync') { var nx = (Math.floor(t / 300) + 1) * 300; next = ' · next in ' + dur(nx - t); }
        if (s.key === 'deploy') next = ' · checks every minute';
        return ['ok', 'Waiting', (s.lastStart ? 'last run ' + ago(s.lastStart, t) + took : 'not run yet') + next];
      }
      if (s.state === 'active') return ['ok', 'Running', s.since ? 'since ' + stamp(s.since) + ' (' + dur(t - s.since) + ')' : ''];
      if (s.state === 'activating' || s.state === 'reloading') return ['warn', 'Starting', ''];
      if (s.state === 'failed') return ['bad', 'Failed', s.lastExit ? ago(s.lastExit, t) : ''];
      return ['bad', 'Stopped', s.lastExit ? ago(s.lastExit, t) : ''];
    }

    function drawServices(d, t) {
      var rows = (d.services || []).map(function (s) {
        var st = serviceState(s, t);
        return '<tr><td><b>' + esc(s.label) + '</b><div class="vs-unit">' + esc(s.unit) + '</div></td>' +
          '<td><span class="ui-badge ' + st[0] + '"><i class="ui-dot ' + st[0] + '"></i>' + esc(st[1]) + '</span><div class="vs-unit">' + esc(st[2]) + '</div></td>' +
          '<td class="num" title="' + (s.cache != null ? esc('Plus ' + mb(s.cache) + ' of file cache') : '') + '">' + (s.mem != null ? esc(mb(s.mem)) : '—') + '</td>' +
          '<td class="num">' + (s.cpu != null ? esc(pct(s.cpu)) : '—') + '</td>' +
          '<td class="num">' + (s.restarts != null ? n(s.restarts) : '—') + '</td></tr>';
      }).join('');
      $('services').innerHTML = '<table class="ui-table vs-table"><thead><tr><th>Service</th><th>Status</th><th class="num">Memory</th><th class="num">CPU</th><th class="num">Restarts</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }

    function drawStorage(d, t) {
      var fs = d.fs || [], dirs = d.dirs || [], m = d.mem || {};
      var html = '<div class="vs-sec">Disks</div>' + fs.map(function (f) {
        var p = f.total ? (f.used / f.total) * 100 : 0, tone = p > 95 ? 'bad' : p > 85 ? 'warn' : null;
        return '<div class="vs-row"><span class="vs-name">' + esc(f.mount) + ' <small>' + esc(f.type) + '</small></span>' + UI.bar(f.used, f.total, null, tone) +
          '<span class="vs-val">' + esc(bytes(f.used) + ' of ' + bytes(f.total)) + '</span></div>';
      }).join('');
      if (m.swapTotal) {
        html += '<div class="vs-row"><span class="vs-name">Swap <small>' + (d.swapFiles || []).length + ' files</small></span>' + UI.bar(m.swapUsed, m.swapTotal, null, 2) +
          '<span class="vs-val">' + esc(mb(m.swapUsed) + ' of ' + mb(m.swapTotal)) + '</span></div>';
      }
      if (dirs.length) {
        var max = Math.max.apply(null, dirs.map(function (x) { return x.bytes; }).concat([1]));
        html += '<div class="vs-sec">What uses the disk</div>' + dirs.slice().sort(function (a, b) { return b.bytes - a.bytes; }).map(function (x) {
          return '<div class="vs-row"><span class="vs-name">' + esc(x.label) + '</span>' + UI.bar(x.bytes, max, null, 6) + '<span class="vs-val">' + esc(bytes(x.bytes)) + '</span></div>';
        }).join('');
      }
      $('storage').innerHTML = html;
      $('sub-storage').textContent = d.dirsAt ? 'folder sizes checked ' + ago(d.dirsAt, t) : '';
    }

    function drawProcs(d) {
      var p = d.procs || {}, top = p.top || [];
      $('sub-procs').textContent = 'the ' + top.length + ' using the most memory, of ' + n(p.count || 0);
      $('procs').innerHTML = '<table class="ui-table vs-table"><thead><tr><th>Process</th><th class="num">Memory</th><th class="num">CPU</th></tr></thead><tbody>' +
        top.map(function (x) { return '<tr><td>' + esc(x.name) + '</td><td class="num">' + esc(mb(x.mem)) + '</td><td class="num">' + (x.cpu != null ? esc(pct(x.cpu)) : '—') + '</td></tr>'; }).join('') +
        '</tbody></table>';
    }

    function drawFoot(d, t) {
      var parts = [];
      if (d.deploy && d.deploy.version) parts.push('Version ' + d.deploy.version + ' (' + d.deploy.commit + ')' + (d.deploy.at ? ', deployed ' + stamp(Date.parse(d.deploy.at) / 1000) : ''));
      if (d.syncAt) parts.push('Data last synced ' + ago(d.syncAt, t));
      parts.push('Updates every 5 seconds · times in your time zone');
      $('foot').textContent = parts.join(' · ');
    }

    function draw() {
      if (!now) return;
      var t = Math.max(now.t, Math.floor(Date.now() / 1000));
      drawNumbers(now, t);
      drawServices(now, t);
      drawStorage(now, t);
      drawProcs(now);
      drawFoot(now, t);
    }

    function poll() {
      if (dead || document.hidden) return;
      get('now.json').then(function (d) {
        if (dead) return;
        failures = 0;
        var fresh = !now || d.t !== now.t;
        now = d;
        if (fresh) appendPoint(d.point);
        var lag = Math.floor(Date.now() / 1000) - d.t;
        setLive(lag > 30 ? 'off' : 'on', lag > 30 ? 'Not updating (last ' + dur(lag) + ' ago)' : 'Live · updated ' + clock(d.t) + ':' + two(new Date(d.t * 1000).getSeconds()));
        draw();
        if (fresh && range === 'hour') drawCharts();
      }).catch(function () {
        if (dead) return;
        failures++;
        setLive('off', failures > 1 ? 'Cannot reach the server · retrying' : 'Retrying…');
      });
    }

    function refreshHistory() {
      if (dead || document.hidden || range === 'hour') return;
      loadRange(range).then(drawCharts);
    }

    $('range').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-v]');
      if (!b || b.getAttribute('data-v') === range) return;
      range = b.getAttribute('data-v');
      Array.prototype.forEach.call($('range').querySelectorAll('button'), function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      loadRange(range).then(drawCharts);
    });

    function onVisible() {
      if (document.hidden) return;
      loadRange(range).then(function () { poll(); drawCharts(); });
    }
    document.addEventListener('visibilitychange', onVisible);

    Promise.all([get('now.json').then(function (d) { now = d; }).catch(function () {}), loadRange('hour')]).then(function () {
      if (dead) return;
      if (!now) { setLive('off', 'No stats yet · retrying'); $('meta').textContent = 'The stats sampler has not written anything yet.'; }
      else { setLive('on', 'Live · updated ' + clock(now.t)); draw(); drawCharts(); }
      timer = setInterval(poll, POLL);
      histTimer = setInterval(refreshHistory, 60000);
    });

    return {
      dispose: function () {
        dead = true;
        clearInterval(timer); clearInterval(histTimer);
        CHARTS.forEach(function (c) { var el = $('chart-' + c.id); if (el && el.__vsMO) el.__vsMO.disconnect(); if (el && el.__lineRO) el.__lineRO.disconnect(); });
        document.removeEventListener('visibilitychange', onVisible);
      }
    };
  }

  w.VmStats = { mount: mount };
})(window);
