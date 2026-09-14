/**
 * Publish rows to a Google Apps Script web app (x-www-form-urlencoded, no CORS preflight).
 * Used by NSC / Stock / Defective Meter so bulk bytes go to Google Sheets, not Vercel.
 *
 * Google sometimes answers doPost with a 302 to script.googleusercontent.com/macros/echo
 * that returns an HTML 404 (`ppConfig`) instead of JSON. Treat that as retryable.
 */
(function (root) {
  var CHUNK_ROWS = 200;
  var MAX_ATTEMPTS = 8;
  var FETCH_MS = 90000;

  function parsePublishJson(text) {
    var raw = String(text == null ? '' : text).trim();
    if (!raw) throw new Error('Empty publish response.');
    if (raw.charAt(0) === '{' || raw.charAt(0) === '[') {
      try {
        return JSON.parse(raw);
      } catch (e) {}
    }
    if (/ppConfig/i.test(raw) || /<!DOCTYPE html/i.test(raw)) {
      throw new Error('Sheet publish returned a web page (Google echo 404).');
    }
    throw new Error('Sheet publish returned non-JSON. Check Apps Script deployment.');
  }

  function isGetProbe(data) {
    return !!(
      data &&
      data.status === 'ok' &&
      data.service &&
      data.action == null &&
      data.inserted == null
    );
  }

  function isRetryable(err) {
    var msg = String((err && err.message) || err || '');
    var name = String((err && err.name) || '');
    return /fail(ed)? to fetch|network|load|abort|timeout|ppConfig|non-JSON|web page|echo|GET metadata|HTML reply/i.test(
      msg + ' ' + name
    );
  }

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function postScript(scriptUrl, payload) {
    var body = 'data=' + encodeURIComponent(JSON.stringify(payload || {}));
    var attempt = 0;
    function once() {
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = ctrl
        ? setTimeout(function () {
            ctrl.abort();
          }, FETCH_MS)
        : null;
      return fetch(scriptUrl, {
        method: 'POST',
        credentials: 'omit',
        redirect: 'follow',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body,
        signal: ctrl ? ctrl.signal : undefined
      })
        .then(function (res) {
          return res.text().then(function (text) {
            var data = parsePublishJson(text);
            if (isGetProbe(data)) {
              throw new Error('Apps Script returned GET metadata instead of publish JSON.');
            }
            if (!res.ok || data.status === 'error' || String(data.status || '') !== 'success') {
              throw new Error(
                data.message || data.error || 'Sheet publish failed (' + res.status + ')'
              );
            }
            return data;
          });
        })
        .catch(function (err) {
          attempt += 1;
          if (attempt < MAX_ATTEMPTS && isRetryable(err)) {
            var wait = Math.min(8000, 600 * Math.pow(2, attempt - 1));
            return delay(wait).then(once);
          }
          throw err;
        })
        .then(
          function (data) {
            if (timer) clearTimeout(timer);
            return data;
          },
          function (err) {
            if (timer) clearTimeout(timer);
            throw err;
          }
        );
    }
    return once();
  }

  async function waitUntilPostWorks(scriptUrl) {
    try {
      await postScript(scriptUrl, { action: 'ping' });
    } catch (err) {
      var msg = String((err && err.message) || err || '');
      if (/Invalid action:\s*ping/i.test(msg)) return;
      throw err;
    }
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
    await waitUntilPostWorks(scriptUrl);
    await postScript(scriptUrl, Object.assign({ action: 'begin', tab: tab, headers: headers }, extra));
    var seq = 0;
    for (var i = 0; i < rows.length; i += CHUNK_ROWS) {
      var slice = rows.slice(i, i + CHUNK_ROWS);
      var data = await postScript(
        scriptUrl,
        Object.assign(
          {
            action: 'chunk',
            tab: tab,
            chunkSeq: seq,
            rows: rowsToValues(headers, slice)
          },
          extra
        )
      );
      seq += 1;
      if (typeof onProgress === 'function') {
        var n = data && data.skipped ? slice.length : Number(data && data.inserted) || slice.length;
        onProgress(n);
      }
    }
    return postScript(scriptUrl, Object.assign({ action: 'complete', tab: tab }, extra));
  }

  root.MzoSheetMirror = {
    CHUNK_ROWS: CHUNK_ROWS,
    postScript: postScript,
    publishTab: publishTab,
    waitUntilPostWorks: waitUntilPostWorks
  };
})(typeof window !== 'undefined' ? window : this);
