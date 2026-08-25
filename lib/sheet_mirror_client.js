/**
 * Publish rows to a Google Apps Script web app (x-www-form-urlencoded, no CORS preflight).
 * Used by NSC / Stock upload so bulk bytes go to Google Sheets, not Vercel.
 */
(function (root) {
  var CHUNK_ROWS = 400;

  function postScript(scriptUrl, payload) {
    return fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(JSON.stringify(payload))
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch (e) {
          throw new Error('Sheet publish returned non-JSON. Check Apps Script deployment.');
        }
        if (!res.ok || (data.status && data.status !== 'success' && data.status !== 'ok')) {
          throw new Error(data.message || data.error || ('Sheet publish failed (' + res.status + ')'));
        }
        return data;
      });
    });
  }

  function rowsToValues(headers, rows) {
    return rows.map(function (row) {
      return headers.map(function (h) {
        var v = row[h];
        return v == null ? '' : String(v);
      });
    });
  }

  /**
   * Replace one tab: begin (clear+headers) → chunks → complete.
   * onProgress(n) is called with rows in each successful chunk.
   * sheetName (optional) is the real Google Sheet tab, e.g. nsc_working / Sheet1.
   */
  async function publishTab(scriptUrl, tab, headers, rows, onProgress, sheetName) {
    rows = Array.isArray(rows) ? rows : [];
    headers = Array.isArray(headers) ? headers : [];
    var extra = sheetName ? { sheetName: sheetName } : {};
    await postScript(scriptUrl, Object.assign({ action: 'begin', tab: tab, headers: headers }, extra));
    for (var i = 0; i < rows.length; i += CHUNK_ROWS) {
      var slice = rows.slice(i, i + CHUNK_ROWS);
      var data = await postScript(scriptUrl, Object.assign({
        action: 'chunk',
        tab: tab,
        rows: rowsToValues(headers, slice)
      }, extra));
      if (typeof onProgress === 'function') {
        onProgress(Number(data.inserted) || slice.length);
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
