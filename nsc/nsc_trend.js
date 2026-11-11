/**
 * Office pendency / withheld trend from VM daily snapshots (Zone → Region → Division → CCC).
 * Usage: NscTrend.mount({ root, side: 'working'|'withheld', title? })
 * Admins get a Manage days strip to remove bad snapshot dates from the chart.
 */
(function (w) {
  'use strict';

  function shortDate(iso) {
    var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return iso || '—';
    var mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return parseInt(m[3], 10) + ' ' + mon[parseInt(m[2], 10) - 1];
  }

  /** Snapshot offices often have blank region; resolve from CCC so Zone → Region drill matches. */
  function mapOffice(o) {
    var code = String(o.ccc || '').replace(/\D/g, '').slice(-7);
    var region = String(o.region || '').trim();
    var division = String(o.division || '').trim();
    var supp = String(o.supp || '').trim();
    var MO = w.MzoOffices;
    if (MO && typeof MO.resolve === 'function' && (code || supp || division || region)) {
      var got = MO.resolve({
        codes: code ? [code] : [],
        cccs: supp ? [supp] : [],
        divisions: division ? [division] : [],
        regions: region ? [region] : []
      });
      var office = got && got.office;
      if (office && office.region && office.level !== 'outside' && office.level !== 'unknown') {
        region = office.region || region;
        division = office.division || division;
        supp = office.ccc || supp;
        if (office.ccc_code) code = office.ccc_code;
      }
    }
    if (!region && division) {
      var divToReg = {
        Malda: 'Malda', Chanchal: 'Malda', Gazole: 'Malda',
        Raiganj: 'Uttar Dinajpur', Islampur: 'Uttar Dinajpur',
        Balurghat: 'Dakshin Dinajpur', Buniadpur: 'Dakshin Dinajpur'
      };
      region = divToReg[division] || '';
    }
    return {
      CCC_CODE: code,
      _region: region || 'Unmapped',
      _divn: division || 'Unmapped',
      _supp: supp || code || 'Unmapped',
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
    var canDelete = false;
    var deleting = false;
    var visKey = 'mzo_nsc_trend_vis_' + side;
    var seriesVis = { total: true, avg: true, over30: false };
    try {
      var saved = JSON.parse(localStorage.getItem(visKey) || '{}');
      if (saved && typeof saved === 'object') {
        if (typeof saved.total === 'boolean') seriesVis.total = saved.total;
        if (typeof saved.avg === 'boolean') seriesVis.avg = saved.avg;
        if (typeof saved.over30 === 'boolean') seriesVis.over30 = saved.over30;
      }
    } catch (_) { /* keep defaults */ }
    if (!seriesVis.total && !seriesVis.avg && !(showOver30 && seriesVis.over30)) seriesVis.total = true;

    var uid = 'nt' + String(Math.random()).slice(2, 8);
    function id(s) { return uid + '-' + s; }
    function el(s) { return document.getElementById(id(s)); }
    var statN = showOver30 ? 4 : 3;

    root.innerHTML =
      '<section class="ui-panel">' +
        '<div class="report-head">' +
          '<div class="rh-top">' +
            '<div class="rh-title-wrap">' +
              '<h2 class="rh-title"><span>' + UI.esc(title) + '</span></h2>' +
              '<span class="rh-badge" id="' + id('badge') + '">…</span>' +
            '</div>' +
          '</div>' +
          '<p class="ui-muted" id="' + id('meta') + '" style="margin:0 0 8px;font-size:13px;color:var(--mzo-muted)">From VM upload snapshots (office totals, no consumer detail). Click a legend item to show or hide a line.</p>' +
        '</div>' +
        '<div id="' + id('manage') + '" hidden style="margin:0 0 12px;padding:10px 12px;border:1px solid var(--mzo-border);border-radius:8px;background:var(--mzo-panel-2,transparent)"></div>' +
        '<div id="' + id('drill') + '"></div>' +
        '<section class="ui-stats" style="--n:' + statN + ';margin:12px 0" aria-label="Trend summary">' +
          '<div class="ui-stat"><div class="k">Current</div><div class="v" id="' + id('latest') + '">—</div><div class="s" id="' + id('latestSub') + '">&nbsp;</div></div>' +
          '<div class="ui-stat"><div class="k">Average</div><div class="v" id="' + id('avg') + '">—</div><div class="s" id="' + id('avgSub') + '">&nbsp;</div></div>' +
          '<div class="ui-stat"><div class="k">vs average</div><div class="v" id="' + id('vsAvg') + '">—</div><div class="s" id="' + id('vsAvgSub') + '">&nbsp;</div></div>' +
          (showOver30
            ? '<div class="ui-stat"><div class="k">&gt; 30 days</div><div class="v" id="' + id('over30') + '">—</div><div class="s" id="' + id('over30Sub') + '">&nbsp;</div></div>'
            : '') +
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

    function zeroDivHint(day) {
      var counts = {};
      var expected = ['Malda', 'Chanchal', 'Gazole', 'Raiganj', 'Islampur', 'Balurghat', 'Buniadpur'];
      expected.forEach(function (d) { counts[d] = 0; });
      (day.offices || []).forEach(function (o) {
        var d = String(o.division || '').trim();
        if (d && Object.prototype.hasOwnProperty.call(counts, d)) counts[d] += Number(o.total) || 0;
      });
      return expected.filter(function (d) { return !counts[d]; });
    }

    function paintManage(series) {
      var box = el('manage');
      if (!box) return;
      if (!canDelete || !ready || !days.length) {
        box.hidden = true;
        box.innerHTML = '';
        return;
      }
      box.hidden = false;
      var rows = (series || seriesFor()).slice().reverse();
      box.innerHTML =
        '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;margin-bottom:8px">' +
          '<div style="font-size:13px"><strong>Manage snapshot days</strong> · Admin only — remove bad days (e.g. a division at zero) from this trend. Live Working/Withheld lists are not changed.</div>' +
          '<button type="button" class="ui-btn sm primary" id="' + id('delBtn') + '" disabled>Delete selected</button>' +
        '</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:8px 14px;max-height:140px;overflow:auto;font-size:13px" id="' + id('dayList') + '">' +
          rows.map(function (s) {
            var zeros = zeroDivHint(days.find(function (d) { return d.reportDate === s.reportDate; }) || s);
            var hint = zeros.length
              ? ' <span style="color:var(--mzo-bad,#c62828)">(0: ' + UI.esc(zeros.join(', ')) + ')</span>'
              : '';
            return '<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer">' +
              '<input type="checkbox" data-date="' + UI.esc(s.reportDate) + '">' +
              '<span>' + UI.esc(shortDate(s.reportDate)) + ' · ' + UI.n(s.total) + hint + '</span></label>';
          }).join('') +
        '</div>' +
        '<p class="ui-muted" id="' + id('delMsg') + '" style="margin:8px 0 0;font-size:12px;min-height:1.2em"></p>';

      var list = el('dayList');
      var btn = el('delBtn');
      function syncBtn() {
        var n = 0;
        if (list) list.querySelectorAll('input[type="checkbox"]').forEach(function (cb) { if (cb.checked) n += 1; });
        if (btn) {
          btn.disabled = deleting || n < 1;
          btn.textContent = n ? ('Delete ' + n + ' day' + (n === 1 ? '' : 's')) : 'Delete selected';
        }
      }
      if (list) {
        list.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
          cb.addEventListener('change', syncBtn);
        });
      }
      if (btn) {
        btn.onclick = function () {
          var picked = [];
          if (list) {
            list.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
              if (cb.checked) picked.push(cb.getAttribute('data-date'));
            });
          }
          if (!picked.length || deleting) return;
          var label = picked.map(shortDate).join(', ');
          if (!w.confirm('Remove these snapshot day(s) from the trend?\n\n' + label + '\n\nThis cannot be undone (re-upload the file to restore).')) return;
          deleting = true;
          syncBtn();
          var msg = el('delMsg');
          if (msg) msg.textContent = 'Deleting…';
          fetch('/api/nsc/snapshots/delete', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dates: picked })
          })
            .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, status: r.status, data: data }; }); })
            .then(function (res) {
              deleting = false;
              if (!res.ok || (res.data && res.data.status !== 'success')) {
                if (msg) msg.textContent = (res.data && res.data.message) || 'Delete failed.';
                syncBtn();
                return;
              }
              if (msg) msg.textContent = res.data.message || 'Deleted.';
              load();
            })
            .catch(function (e) {
              deleting = false;
              if (msg) msg.textContent = (e && e.message) || 'Delete failed.';
              syncBtn();
            });
        };
      }
      syncBtn();
    }

    function render() {
      if (!ready) {
        el('badge').textContent = err ? 'Unavailable' : 'Loading…';
        el('table').innerHTML = '<div class="ui-empty">' + UI.esc(err || 'Loading snapshots…') + '</div>';
        el('chart').innerHTML = '';
        paintManage([]);
        return;
      }
      if (!days.length) {
        el('badge').textContent = 'No snapshots';
        el('meta').textContent = 'Trend needs VM uploads. After the first Replace on DISHA, daily office totals appear here.';
        el('table').innerHTML = '<div class="ui-empty">No snapshots yet.</div>';
        el('chart').innerHTML = '';
        paintManage([]);
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
      var sum = 0;
      totals.forEach(function (v) { sum += v; });
      var avg = series.length ? sum / series.length : 0;
      var avgRounded = Math.round(avg);
      var vsAvg = last.total - avg;
      var vsPct = avg ? (vsAvg / avg) * 100 : 0;
      var avgLine = totals.map(function () { return avgRounded; });

      el('badge').textContent = series.length + ' day' + (series.length === 1 ? '' : 's');
      el('meta').textContent = series.length + ' snapshot day' + (series.length === 1 ? '' : 's') +
        ' · ' + where + ' · Current vs period average (legend toggles lines)';

      el('latest').textContent = UI.n(last.total);
      el('latestSub').textContent = last.reportDate ? 'As on ' + shortDate(last.reportDate) : '';
      el('avg').textContent = UI.n(avgRounded);
      el('avgSub').textContent = series.length + ' day' + (series.length === 1 ? '' : 's') + ' mean';
      el('vsAvg').textContent = (vsAvg > 0 ? '+' : '') + UI.n(Math.round(vsAvg));
      el('vsAvgSub').textContent = avg
        ? ((vsPct > 0 ? '+' : '') + (Math.round(vsPct * 10) / 10) + '% of average')
        : 'Need snapshot days';
      el('vsAvg').style.color = !series.length ? ''
        : (vsAvg < 0 ? 'var(--mzo-ok, #1a7f37)' : vsAvg > 0 ? 'var(--mzo-bad, #c62828)' : '');
      if (showOver30) {
        el('over30').textContent = UI.n(last.over30);
        el('over30Sub').textContent = last.total ? UI.pct(last.over30, last.total) + ' of current' : '0%';
      }

      var mainLabel = side === 'withheld' ? 'Withheld' : 'Pending';
      var chartSeries = [
        { id: 'total', label: mainLabel, values: totals, strong: true, color: 1, hidden: !seriesVis.total },
        { id: 'avg', label: 'Average', values: avgLine, color: 'muted', dash: true, hidden: !seriesVis.avg }
      ];
      if (showOver30) {
        chartSeries.push({ id: 'over30', label: '> 30 days', values: over30s, color: 'bad', hidden: !seriesVis.over30 });
      }
      UI.line(el('chart'), {
        title: title,
        labels: labels,
        tipLabels: tipLabels,
        series: chartSeries,
        height: 220,
        fmt: UI.n,
        onToggle: function (list) {
          list.forEach(function (se) {
            if (se.id === 'total') seriesVis.total = !se.hidden;
            if (se.id === 'avg') seriesVis.avg = !se.hidden;
            if (se.id === 'over30') seriesVis.over30 = !se.hidden;
          });
          try { localStorage.setItem(visKey, JSON.stringify(seriesVis)); } catch (_) { /* */ }
        }
      });

      paintManage(series);

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
          canDelete = !!(data && data.canDelete);
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
          canDelete = false;
          render();
        });
    }

    load();
    return { reload: load, render: render, drill: dr };
  }

  w.NscTrend = { mount: mount };
})(window);
