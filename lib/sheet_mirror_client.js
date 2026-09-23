/**
 * Publish rows to a Google Apps Script web app (x-www-form-urlencoded, no CORS preflight).
 * Used by NSC / Stock / Defective Meter so bulk bytes go to Google Sheets, not Vercel.
 *
 * Google sometimes answers doPost with a 302 to script.googleusercontent.com/macros/echo
 * that returns an HTML 404 (`ppConfig`) instead of JSON. Treat that as retryable.
 * Chunk POSTs retry automatically; a failed tab restarts from `begin` (clears the sheet).
 */
(function (root) {
  var CHUNK_ROWS = 200;
  var MAX_ATTEMPTS = 8;
  var TAB_TRIES = 3;
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
    return /fail(ed)? to fetch|network|load|abort|timeout|timed out|quota|rate limit|429|500|502|503|504|ppConfig|non-JSON|web page|echo|GET metadata|HTML reply|Service Spreadsheets/i.test(
      msg + ' ' + name
    );
  }

  function friendlyRetryMessage(err) {
    var msg = String((err && err.message) || err || '');
    if (/ppConfig|web page|echo|non-JSON|HTML reply/i.test(msg)) {
      return 'Google paused the sheet write for a moment.';
    }
    if (/GET metadata/i.test(msg)) {
      return 'Google answered the ping instead of the write.';
    }
    if (/timeout|timed out|abort/i.test(msg)) {
      return 'The sheet write timed out.';
    }
    if (/fail(ed)? to fetch|network|load/i.test(msg)) {
      return 'The network dropped while writing to the sheet.';
    }
    if (/quota|rate limit|429/i.test(msg)) {
      return 'Google is rate-limiting sheet writes.';
    }
    return msg || 'Temporary sheet error.';
  }

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function notifyRetry(onRetry, info) {
    if (typeof onRetry === 'function') {
      try {
        onRetry(info);
      } catch (_) {}
    }
  }

  function postScript(scriptUrl, payload, onRetry) {
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
            notifyRetry(onRetry, {
              kind: 'attempt',
              attempt: attempt,
              maxAttempts: MAX_ATTEMPTS,
              waitMs: wait,
              message: friendlyRetryMessage(err),
              detail: String((err && err.message) || err || ''),
              action: payload && payload.action,
              chunkSeq: payload && payload.chunkSeq,
              tab: payload && payload.tab
            });
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

  async function waitUntilPostWorks(scriptUrl, onRetry) {
    try {
      await postScript(scriptUrl, { action: 'ping' }, onRetry);
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

  async function publishTabOnce(scriptUrl, tab, headers, rows, onProgress, sheetName, onRetry, chunkRows) {
    rows = Array.isArray(rows) ? rows : [];
    headers = Array.isArray(headers) ? headers : [];
    var extra = sheetName ? { sheetName: sheetName } : {};
    var size = Number(chunkRows) > 0 ? Number(chunkRows) : CHUNK_ROWS;
    await waitUntilPostWorks(scriptUrl, onRetry);
    await postScript(
      scriptUrl,
      Object.assign({ action: 'begin', tab: tab, headers: headers }, extra),
      onRetry
    );
    var seq = 0;
    for (var i = 0; i < rows.length; i += size) {
      var slice = rows.slice(i, i + size);
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
        ),
        onRetry
      );
      seq += 1;
      if (typeof onProgress === 'function') {
        var n = data && data.skipped ? slice.length : Number(data && data.inserted) || slice.length;
        onProgress(n);
      }
    }
    return postScript(
      scriptUrl,
      Object.assign({ action: 'complete', tab: tab, expectedRows: rows.length }, extra),
      onRetry
    );
  }

  async function publishTab(scriptUrl, tab, headers, rows, onProgress, sheetName, onRetry, chunkRows) {
    var lastErr;
    var t;
    for (t = 1; t <= TAB_TRIES; t++) {
      try {
        return await publishTabOnce(
          scriptUrl,
          tab,
          headers,
          rows,
          onProgress,
          sheetName,
          function (info) {
            info.tabTry = t;
            info.tabTries = TAB_TRIES;
            notifyRetry(onRetry, info);
          },
          chunkRows
        );
      } catch (err) {
        lastErr = err;
        if (t >= TAB_TRIES || !isRetryable(err)) throw err;
        notifyRetry(onRetry, {
          kind: 'restart',
          tab: tab,
          attempt: t,
          maxAttempts: TAB_TRIES,
          waitMs: 4000,
          message: friendlyRetryMessage(err),
          detail: String((err && err.message) || err || ''),
          action: 'restart',
          tabTry: t + 1,
          tabTries: TAB_TRIES
        });
        await delay(4000);
      }
    }
    throw lastErr;
  }

  root.MzoSheetMirror = {
    CHUNK_ROWS: CHUNK_ROWS,
    MAX_ATTEMPTS: MAX_ATTEMPTS,
    TAB_TRIES: TAB_TRIES,
    postScript: postScript,
    publishTab: publishTab,
    waitUntilPostWorks: waitUntilPostWorks,
    isRetryable: isRetryable,
    friendlyRetryMessage: friendlyRetryMessage
  };
})(typeof window !== 'undefined' ? window : this);
