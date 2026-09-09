/**
 * Publish rows to a Google Apps Script web app (x-www-form-urlencoded, no CORS preflight).
 * Used by NSC / Stock / Defective Meter so bulk bytes go to Google Sheets, not Vercel.
 */
(function (root) {
  var CHUNK_ROWS = 200;
  var MAX_ATTEMPTS = 8;
  var FETCH_MS = 60000;

  function parsePublishJson(text) {
    var raw = String(text == null ? '' : text).trim();
    if (!raw) throw new Error('Empty publish response.');
    try {
      return JSON.parse(raw);
    } catch (e) {}
    if (/ppConfig/i.test(raw)) {
      throw new Error('Apps Script is still the old HTML reply. Paste defective_meter_publish.gs → Deploy → New version (same /exec URL).');
    }
    throw new Error('Sheet publish returned non-JSON. Check Apps Script deployment.');
  }

  function isRetryable(err) {
    var msg = String((err && err.message) || err || '');
    var name = String((err && err.name) || '');
    return /fail(ed)? to fetch|network|load|abort|timeout/i.test(msg + ' ' + name);
  }

  function postScript(scriptUrl, payload) {
    var body = 'data=' + encodeURIComponent(JSON.stringify(payload || {}));
    var attempt = 0;
    function once() {
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, FETCH_MS) : null;
      return fetch(scriptUrl, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body,
        signal: ctrl ? ctrl.signal : undefined
      }).then(function (res) {
        return res.text().then(function (text) {
          var data = parsePublishJson(text);
          if (!res.ok || (data.status && data.status !== 'success' && data.status !== 'ok')) {
            throw new Error(data.message || data.error || ('Sheet publish failed (' + res.status + ')'));
          }
          return data;
        });
      }).catch(function (err) {
        attempt += 1;
        if (attempt < MAX_ATTEMPTS && isRetryable(err)) {
          var wait = Math.min(8000, 600 * Math.pow(2, attempt - 1));
          return new Promise(function (resolve) { setTimeout(resolve, wait); }).then(once);
        }
        throw err;
      }).then(function (data) {
        if (timer) clearTimeout(timer);
        return data;
      }, function (err) {
        if (timer) clearTimeout(timer);
        throw err;
      });
    }
    return once();
  }

  function rowsToValues(headers, rows) {
    return rows.map(function (row) {
      return headers.map(function (h) {
        var v = row[h];
        return v == null ? '' : String(v);
      });
    });
  }

  async function publishTab(scriptUrl, tab, headers, rows, onProgress, sheetName) {
    rows = Array.isArray(rows) ? rows : [];
    headers = Array.isArray(headers) ? headers : [];
    var extra = sheetName ? { sheetName: sheetName } : {};
    await postScript(scriptUrl, Object.assign({ action: 'begin', tab: tab, headers: headers }, extra));
    var seq = 0;
    for (var i = 0; i < rows.length; i += CHUNK_ROWS) {
      var slice = rows.slice(i, i + CHUNK_ROWS);
      var data = await postScript(scriptUrl, Object.assign({
        action: 'chunk',
        tab: tab,
        chunkSeq: seq,
        rows: rowsToValues(headers, slice)
      }, extra));
      seq += 1;
      if (typeof onProgress === 'function') {
        var n = data && data.skipped ? slice.length : (Number(data && data.inserted) || slice.length);
        onProgress(n);
      }
    }
    return postScript(scriptUrl, Object.assign({ action: 'complete', tab: tab }, extra));
  }

  root.MzoSheetMirror = {
    CHUNK_ROWS: CHUNK_ROWS,
    postScript: postScript,
    publishTab: publishTab
  };
})(typeof window !== 'undefined' ? window : this);
