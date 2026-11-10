/**
 * Office pendency / withheld trend from VM daily snapshots (Zone → Region → Division → CCC).
 * Usage: NscTrend.mount({ root, side: 'working'|'withheld', title? })
 */
(function (w) {
  'use strict';

  function shortDate(iso) {
    var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return iso || '—';
    var mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return parseInt(m[3], 10) + ' ' + mon[parseInt(m[2], 10) - 1];
  }

  function mapOffice(o) {
    return {
      CCC_CODE: String(o.ccc || '').replace(/\D/g, '').slice(-7),
      _region: o.region || 'Unmapped',
      _divn: o.division || 'Unmapped',
      _supp: o.supp || o.ccc || 'Unmapped',
      total: o.total || 0,
      over30: o.over30 || 0
    };
  }

  function scopeOffices(list) {
    if (!list || !list.length) return [];
    if (w.MzoScope && typeof w.MzoScope.filterRows === 'function') return w.MzoScope.filterRows(list);
    return list;
  }

  function deltaHtml(cur, prev) {
    if (prev == null || !isFinite(prev) || cur == null) return '—';
    var d = cur - prev;
    if (!d) return '<span class="ui-delta">0</span>';
    return '<span class="ui-delta ' + (d < 0 ? 'ok' : 'bad') + '">' + (d > 0 ? '+' : '') + UI.n(d) + '</span>';
  }

  function mount(cfg) {
    var root = typeof cfg.root === 'string' ? document.getElementById(cfg.root) : cfg.root;
    if (!root) return null;
    var side = cfg.side === 'withheld' ? 'withheld' : 'working';
    var title = cfg.title || (side === 'withheld' ? 'Withheld trend' : 'Pending NSC trend');
    var showOver30 = side === 'working';
    var days = [];
    var ready = false;
    var err = '';
    var uid = 'nt' + String(Math.random()).slice(2, 8);
    function id(s) { return uid + '-' + s; }
    function el(s) { return document.getElementById(id(s)); }

    root.innerHTML =
      '<section class="ui-panel">' +
        '<div class="report-head">' +
          '<div class="rh-top">' +
            '<div class="rh-title-wrap">' +
              '<h2 class="rh-title"><span>' + UI.esc(title) + '</span></h2>' +
              '<span class="rh-badge" id="' + id('badge') + '">…</span>' +
            '</div>' +
          '</div>' +
          '<p class="ui-muted" id="' + id('meta') + '" style="margin:0 0 8px;font-size:13px;color:var(--mzo-muted)">From VM upload snapshots (office totals, no consumer detail).</p>' +
        '</div>' +
        '<div id="' + id('drill') + '"></div>' +
        '<section class="ui-stats" style="--n:' + (showOver30 ? '3' : '2') + ';margin:12px 0" aria-label="Trend summary">' +
          '<div class="ui-stat"><div class="k">Latest</div><div class="v" id="' + id('latest') + '">—</div><div class="s" id="' + id('latestSub') + '">&nbsp;</div></div>' +
          (showOver30
            ? '<div class="ui-stat"><div class="k">&gt; 30 days</div><div class="v" id="' + id('over30') + '">—</div><div class="s" id="' + id('over30Sub') + '">&nbsp;</div></div>'
            : '') +
          '<div class="ui-stat"><div class="k">Change vs prior</div><div class="v" id="' + id('delta') + '">—</div><div class="s" id="' + id('deltaSub') + '">&nbsp;</div></div>' +
        '</section>' +
        '<div id="' + id('chart') + '" style="margin:8px 0 14px"></div>' +
        '<div id="' + id('table') + '"><div class="ui-empty">Loading snapshots…</div></div>' +
      '</section>';

    var dr = UI.drill({
      el: id('drill'),
      root: 'Malda Zone',
      lists: [{ k: 'trend', label: 'Trend' }],
      onChange: render
    });

    function seriesFor() {
      return days.map(function (day) {
        var offices = scopeOffices((day.offices || []).map(mapOffice).filter(function (r) { return dr.match(r); }));
        var total = 0, over30 = 0;
        offices.forEach(function (o) { total += o.total; over30 += o.over30; });
        return { reportDate: day.reportDate, total: total, over30: over30, offices: offices };
      });
    }

    function render() {
      if (!ready) {
        el('badge').textContent = err ? 'Unavailable' : 'Loading…';
        el('table').innerHTML = '<div class="ui-empty">' + UI.esc(err || 'Loading snapshots…') + '</div>';
        el('chart').innerHTML = '';
        return;
      }
      if (!days.length) {
        el('badge').textContent = 'No snapshots';
        el('meta').textContent = 'Trend needs VM uploads. After the first Replace on DISHA, daily office totals appear here.';
        el('table').innerHTML = '<div class="ui-empty">No snapshots yet.</div>';
        el('chart').innerHTML = '';
        dr.paint({ trend: 0 }, '');
        return;
      }

      var series = seriesFor();
      var labels = series.map(function (s) { return shortDate(s.reportDate); });
      var tipLabels = series.map(function (s) { return s.reportDate; });
      var totals = series.map(function (s) { return s.total; });
      var over30s = series.map(function (s) { return s.over30; });
      var last = series[series.length - 1] || { total: 0, over30: 0, reportDate: '', offices: [] };
      var prev = series.length > 1 ? series[series.length - 2] : null;
      var where = dr.where() || 'Malda Zone';

      el('badge').textContent = series.length + ' day' + (series.length === 1 ? '' : 's');
      el('meta').textContent = series.length + ' snapshot day' + (series.length === 1 ? '' : 's') +
        ' · ' + where + (showOver30 ? ' (total and >30d)' : ' (withheld total)');

      el('latest').textContent = UI.n(last.total);
      el('latestSub').textContent = last.reportDate ? 'As on ' + shortDate(last.reportDate) : '';
      if (showOver30) {
        el('over30').textContent = UI.n(last.over30);
        el('over30Sub').textContent = last.total ? UI.pct(last.over30, last.total) + ' of total' : '0%';
      }
      var dlt = prev ? (last.total - prev.total) : null;
      el('delta').textContent = prev == null ? '—' : ((dlt > 0 ? '+' : '') + UI.n(dlt));
      el('deltaSub').textContent = prev ? 'vs ' + shortDate(prev.reportDate) : 'Need two snapshot days';
      el('delta').style.color = dlt == null ? '' : (dlt < 0 ? 'var(--mzo-ok, #1a7f37)' : dlt > 0 ? 'var(--mzo-bad, #c62828)' : '');

      var chartSeries = [{ label: side === 'withheld' ? 'Withheld' : 'Pending', values: totals, strong: true, color: 1 }];
      if (showOver30) chartSeries.push({ label: '> 30 days', values: over30s, color: 'bad' });
      UI.line(el('chart'), {
        title: title,
        labels: labels,
        tipLabels: tipLabels,
        series: chartSeries,
        height: 220,
        fmt: UI.n
      });

      if (dr.isList()) {
        UI.table(el('table'), {
          rows: series.slice().reverse(),
          sort: { key: 'reportDate', dir: 'desc' },
          count: false,
          empty: 'No snapshot days for this office.',
          columns: [
            { key: 'reportDate', label: 'As on', fmt: function (v) { return UI.esc(shortDate(v)); } },
            { key: 'total', label: side === 'withheld' ? 'Withheld' : 'Pending', num: true, fmt: UI.n },
            showOver30 ? { key: 'over30', label: '> 30d', num: true, fmt: UI.n } : null,
            {
              key: 'chg', label: 'Change', num: true,
              sortVal: function (r) {
                var idx = series.findIndex(function (s) { return s.reportDate === r.reportDate; });
                if (idx <= 0) return null;
                return r.total - series[idx - 1].total;
              },
              fmt: function (_, r) {
                var idx = series.findIndex(function (s) { return s.reportDate === r.reportDate; });
                if (idx <= 0) return '—';
                return deltaHtml(r.total, series[idx - 1].total);
              }
            }
          ].filter(Boolean)
        });
        dr.paint({ trend: last.total }, 'Daily totals for this office');
        return;
      }

      var groups = {};
      (last.offices || []).forEach(function (o) {
        var k = dr.key(o);
        var g = groups[k] || (groups[k] = { name: k, parent: dr.parent(o), row: o, total: 0, over30: 0, prev: 0 });
        g.total += o.total;
        g.over30 += o.over30;
      });
      if (prev) {
        (prev.offices || []).forEach(function (o) {
          if (!dr.match(o)) return;
          var k = dr.key(o);
          if (!groups[k]) groups[k] = { name: k, parent: dr.parent(o), row: o, total: 0, over30: 0, prev: 0 };
          groups[k].prev += o.total;
        });
      }
      var list = Object.keys(groups).map(function (k) { return groups[k]; });
      var max = Math.max.apply(null, list.map(function (g) { return g.total; }).concat([0]));
      UI.table(el('table'), {
        rows: list,
        sort: { key: 'total', dir: 'desc' },
        count: false,
        empty: 'No offices in scope for these snapshots.',
        columns: [
          {
            key: 'name', label: dr.label(),
            fmt: function (v, g) {
              return '<span class="ui-strong">' + UI.esc(v) + '</span>' + (g.parent ? '<span class="sub">' + UI.esc(g.parent) + '</span>' : '');
            }
          },
          { key: 'total', label: side === 'withheld' ? 'Withheld' : 'Pending', num: true, fmt: UI.n },
          showOver30 ? { key: 'over30', label: '> 30d', num: true, fmt: UI.n, hideSm: true } : null,
          {
            key: 'chg', label: 'Change', num: true,
            sortVal: function (g) { return g.total - g.prev; },
            fmt: function (_, g) { return prev ? deltaHtml(g.total, g.prev) : '—'; }
          },
          {
            key: 'share', label: 'Share', hideSm: true, width: '22%',
            sortVal: function (g) { return g.total; },
            fmt: function (_, g) { return UI.bar(g.total, max, UI.pct(g.total, last.total || 1)); }
          }
        ].filter(Boolean),
        onRow: function (g) { dr.open(g.name, g.row); }
      });
      dr.paint({ trend: last.total }, 'Click a row to open it · chart is the selection total');
    }

    function load() {
      ready = false;
      err = '';
      render();
      return fetch('/api/nsc/snapshots?offices=1&side=' + encodeURIComponent(side), { credentials: 'same-origin' })
        .then(function (r) {
          if (r.status === 401) throw new Error('Sign in to see the trend.');
          if (!r.ok) throw new Error('Could not load snapshots.');
          return r.json();
        })
        .then(function (data) {
          var key = side === 'withheld' ? 'withheldOffices' : 'workingOffices';
          days = (data && data.items || []).map(function (it) {
            return { reportDate: it.reportDate, offices: it[key] || [] };
          }).filter(function (d) { return d.reportDate; });
          ready = true;
          render();
        })
        .catch(function (e) {
          err = (e && e.message) || 'Could not load snapshots.';
          ready = false;
          days = [];
          render();
        });
    }

    load();
    return { reload: load, render: render, drill: dr };
  }

  w.NscTrend = { mount: mount };
})(window);
