/* OSD Sync to VM. Same path as Admin → Data Sync → Revenue OSD.
   The office helper (npm run office:db2) reads DB2. This page uploads with the signed-in session. */
(function () {
  var HELPER = 'http://127.0.0.1:3921';

  function el(id) { return document.getElementById(id); }

  function ensureDialog() {
    if (el('osdSyncDlg')) return;
    var style = document.createElement('style');
    style.textContent = '.osd-sync{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(15,23,42,.45)}'
      + '.osd-sync[hidden]{display:none}'
      + '.osd-sync section{width:min(440px,100%);background:var(--mzo-surface);color:var(--mzo-text);border:1px solid var(--mzo-border);border-radius:14px;box-shadow:0 16px 50px rgba(0,0,0,.2)}'
      + '.osd-sync header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px 0}'
      + '.osd-sync h3{margin:0;font-size:16px}'
      + '.osd-sync .b{margin:8px 16px 0;font-size:13.5px;line-height:1.45}'
      + '.osd-sync .n{margin:8px 16px 0;font-size:12.5px;color:var(--mzo-muted)}'
      + '.osd-sync .st{margin:12px 16px 0;font-size:13px}'
      + '.osd-sync .bar{height:6px;margin-top:8px;border-radius:99px;background:var(--mzo-surface-2);overflow:hidden}'
      + '.osd-sync .bar b{display:block;height:100%;width:0;background:var(--mzo-c1)}'
      + '.osd-sync footer{display:flex;justify-content:flex-end;gap:8px;padding:14px 16px 16px}'
      + '.osd-sync.ok h3{color:var(--mzo-c2)} .osd-sync.bad h3{color:var(--mzo-c5)}';
    document.head.appendChild(style);
    var box = document.createElement('div');
    box.className = 'osd-sync';
    box.id = 'osdSyncDlg';
    box.hidden = true;
    box.innerHTML = '<section role="dialog" aria-modal="true" aria-labelledby="osdSyncTitle">'
      + '<header><h3 id="osdSyncTitle"></h3><button type="button" class="ui-btn icon ghost" id="osdSyncX" aria-label="Close"><svg class="ui-i"><use href="#ui-x"/></svg></button></header>'
      + '<p class="b" id="osdSyncBody"></p><p class="n" id="osdSyncNote"></p>'
      + '<div class="st" id="osdSyncStatus" hidden><span id="osdSyncStep"></span><div class="bar" aria-hidden="true"><b id="osdSyncBar"></b></div></div>'
      + '<footer><button type="button" class="ui-btn" id="osdSyncCancel">Cancel</button><button type="button" class="ui-btn primary" id="osdSyncOk">Sync now</button></footer>'
      + '</section>';
    document.body.appendChild(box);
  }

  function readStream(res, onStep) {
    if (!res.ok || !res.body || !res.body.getReader) {
      return res.text().then(function (t) {
        var d; try { d = JSON.parse(t); } catch (e) { throw new Error('The office helper did not answer.'); }
        if (d.status !== 'success' && d.status !== 'ok') throw new Error(d.message || 'DB2 extract failed.');
        return d;
      });
    }
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var buf = '';
    var result = null;
    function take(line) {
      if (!line || !line.trim()) return;
      var ev = JSON.parse(line);
      if (ev.type === 'progress') { if (onStep) onStep(ev); return; }
      if (ev.type === 'result' || ev.status) result = ev;
    }
    function pump() {
      return reader.read().then(function (step) {
        if (step.value) buf += dec.decode(step.value, { stream: !step.done });
        var lines = buf.split('\n');
        buf = lines.pop();
        lines.forEach(take);
        if (!step.done) return pump();
        if (buf.trim()) take(buf);
        if (!result || (result.status !== 'success' && result.status !== 'ok')) {
          throw new Error((result && result.message) || 'DB2 extract failed.');
        }
        return result;
      });
    }
    return pump();
  }

  function paint(text, pct) {
    el('osdSyncStatus').hidden = false;
    el('osdSyncStep').textContent = text;
    el('osdSyncBar').style.width = pct + '%';
  }

  function mount(opts) {
    var button = opts && opts.button;
    if (!button) return;
    ensureDialog();
    var busy = false;
    var pending = null;
    function close(ok) {
      if (busy) return;
      el('osdSyncDlg').hidden = true;
      var done = pending;
      pending = null;
      if (done) done(!!ok);
    }
    el('osdSyncOk').addEventListener('click', function () { close(true); });
    el('osdSyncCancel').addEventListener('click', function () { close(false); });
    el('osdSyncX').addEventListener('click', function () { close(false); });
    el('osdSyncDlg').addEventListener('click', function (e) { if (e.target === el('osdSyncDlg')) close(false); });

    function ask() {
      return new Promise(function (resolve) {
        pending = resolve;
        var box = el('osdSyncDlg');
        box.classList.remove('ok', 'bad');
        el('osdSyncTitle').textContent = 'Sync OSD to the live page';
        el('osdSyncBody').textContent = 'Refresh the summary from IBM DB2 and publish it, with the selected-consumer list, to the live page.';
        el('osdSyncNote').hidden = false;
        el('osdSyncNote').textContent = 'Leave npm run office:db2 running on this PC. The live server cannot reach DB2.';
        el('osdSyncStatus').hidden = true;
        el('osdSyncCancel').hidden = false;
        el('osdSyncOk').hidden = false;
        el('osdSyncX').hidden = false;
        box.hidden = false;
        el('osdSyncOk').focus();
      });
    }

    function finish(tone, message) {
      busy = false;
      var box = el('osdSyncDlg');
      box.classList.toggle('ok', tone === 'ok');
      box.classList.toggle('bad', tone === 'bad');
      el('osdSyncTitle').textContent = tone === 'ok' ? 'OSD is on the live page' : 'OSD sync failed';
      el('osdSyncBody').textContent = message;
      el('osdSyncNote').hidden = true;
      el('osdSyncCancel').hidden = true;
      el('osdSyncOk').hidden = false;
      el('osdSyncOk').textContent = 'Close';
      el('osdSyncX').hidden = false;
      pending = function () { el('osdSyncOk').textContent = 'Sync now'; };
    }

    button.addEventListener('click', function () {
      ask().then(function (yes) {
        if (!yes) return;
        busy = true;
        el('osdSyncDlg').hidden = false;
        el('osdSyncCancel').hidden = true;
        el('osdSyncOk').hidden = true;
        el('osdSyncX').hidden = true;
        el('osdSyncNote').hidden = true;
        el('osdSyncBody').textContent = 'Collecting from IBM DB2 on this PC.';
        paint('Starting…', 8);
        fetch(HELPER + '/health', { headers: { Accept: 'application/json' } })
          .then(function (r) { if (!r.ok) throw new Error('The office helper is not running.'); return r.json(); })
          .then(function (health) {
            if (!health.dbvis) throw new Error('DbVisualizer CLI was not found on this PC.');
            return fetch(HELPER + '/run', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
              body: JSON.stringify({ job: 'osd' })
            });
          })
          .then(function (res) {
            return readStream(res, function (ev) {
              var n = ev.total || 1;
              var step = ev.state === 'done' ? ev.index : Math.max(0, (ev.index || 1) - 1);
              paint((ev.name || 'Working') + ' · ' + (ev.index || 1) + ' of ' + n, Math.round(8 + (step / n) * 64));
            });
          })
          .then(function (extracted) {
            var uploads = extracted.uploads || [];
            var chain = Promise.resolve();
            uploads.forEach(function (part, i) {
              chain = chain.then(function () {
                paint('Uploading to the live page…', 80 + Math.round((i / Math.max(uploads.length, 1)) * 12));
                var fd = new FormData();
                (part.files || []).forEach(function (file) {
                  fd.append(file.field, new Blob([file.text], { type: file.type || 'text/plain' }), file.name);
                });
                return fetch(part.url, { method: 'POST', credentials: 'same-origin', body: fd }).then(function (up) {
                  return up.json().catch(function () { return {}; }).then(function (data) {
                    if (!up.ok || data.status !== 'success') throw new Error(data.message || 'The live page rejected the upload.');
                  });
                });
              });
            });
            return chain.then(function () { return extracted; });
          })
          .then(function (extracted) {
            if (!extracted.selectedFetch) return extracted;
            paint('Uploading the selected list…', 94);
            return fetch(extracted.selectedFetch).then(function (listRes) {
              if (!listRes.ok) throw new Error('The selected-consumer list could not be read from this PC.');
              return listRes.blob();
            }).then(function (blob) {
              var fd = new FormData();
              fd.append('selected', blob, 'osd_selected.csv');
              return fetch('/api/osd/upload', { method: 'POST', credentials: 'same-origin', body: fd });
            }).then(function (up) {
              return up.json().catch(function () { return {}; }).then(function (data) {
                if (!up.ok || data.status !== 'success') throw new Error(data.message || 'The selected list was not accepted.');
                return extracted;
              });
            });
          })
          .then(function (extracted) {
            paint('Published', 100);
            finish('ok', (extracted && extracted.message) || 'OSD is updated on the live page.');
            if (opts.onDone) opts.onDone();
          })
          .catch(function (err) {
            var msg = err && err.name === 'TypeError'
              ? 'This PC could not reach the office helper at ' + HELPER + '. In the MZO Reports folder, leave this running: npm run office:db2 — then click Sync to VM again.'
              : (err && err.message) || 'OSD sync failed.';
            finish('bad', msg);
          });
      });
    });

    fetch('/api/osd/meta', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (meta) { button.hidden = !(meta && (meta.canSync || meta.canCrmSync)); })
      .catch(function () {});
  }

  window.OsdSync = { mount: mount };
})();
