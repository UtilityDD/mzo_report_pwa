#!/usr/bin/env node
/* Browser parity, timing and screenshots for the legacy pages of batch E (Bootstrap / Leaflet pages
 * that do not use the UI kit, so uniform-pages.js cannot read them).
 *
 *   node scripts/qa/legacy-pages.js parity --old <base>[,<base>] --new <base>[,<base>] --snap <dir> [--pages a,b]
 *        [--profiles admin,region,ccc] [--themes dark,light] [--phone] [--out <dir>]
 *   node scripts/qa/legacy-pages.js timing --old <base> --new <base> --snap <dir> [--pages a,b] [--runs 5] [--cpu 4]
 *   node scripts/qa/legacy-pages.js shots --new <base> --snap <dir> --out <dir> [--pages a,b] [--label x]
 *
 * parity: --old and --new are lists of the same length, compared pairwise (e.g. old original vs
 * new original, old mirror vs new mirror). Every page is opened as each profile and theme (and at
 * 390 px with --phone), it records what the page shows (stat numbers, tables and totals, modals,
 * reports, facet counts, the data rows the page keeps in memory) after every step of its walk, and
 * diffs old against new. Google and Supabase Storage requests are answered from the snapshot
 * folder, so both sides see the same bytes.
 * timing: first data paint, cold (empty storage) and warm (second load), median of --runs.
 *
 * Safety: every request that is not GET/HEAD/OPTIONS is aborted, Apps Script is never called, and
 * the geocoder and map overlays are not called. Session: the forged local test cookie.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; }
function flag(n) { return process.argv.includes('--' + n); }
function loadPlaywright() {
  for (const t of [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core', 'playwright']) { if (!t) continue; try { return require(t); } catch (_) {} }
  const npx = path.join(os.homedir(), '.npm', '_npx');
  for (const d of fs.existsSync(npx) ? fs.readdirSync(npx) : []) { const p = path.join(npx, d, 'node_modules', 'playwright-core'); if (fs.existsSync(path.join(p, 'package.json'))) return require(p); }
  throw new Error('playwright-core not found');
}

const PROFILES = {
  admin: { Username: 'local-preview', Name: 'Local Preview', role: 'admin', office_level: 'CE' },
  region: { Username: 'qa-raiganj', Name: 'QA Raiganj', role: 'user', office_level: 'Region', region_code: 'Raiganj' },
  ccc: { Username: 'qa-fulbari', Name: 'QA Fulbari', role: 'user', office_level: 'CCC', division_code: 'Malda', ccc_code: '6611108' }
};
function cookie(profile) {
  const secret = process.env.QA_JWT_SECRET || 'mzo-portal-super-secret-key-123456';
  const payload = Buffer.from(JSON.stringify({ profile, expiry: Date.now() + 6 * 3600e3 })).toString('base64');
  return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64');
}

// Snapshot routing (as uniform-pages.js): a data URL → the snapshot file with the same bytes.
function router(snap) {
  if (!snap) return null;
  const man = JSON.parse(fs.readFileSync(path.join(snap, 'manifest.json'), 'utf8')).datasets;
  const idOf = (u) => { const m = /\/spreadsheets\/d\/(e\/)?([\w-]{20,})/.exec(u); return m ? m[2] : ''; };
  const sheetOf = (u) => { try { const q = new URL(u).searchParams; return q.get('gid') || q.get('sheet') || ''; } catch (_) { return ''; } };
  const table = [];
  Object.keys(man).forEach((k) => (man[k].urls || []).forEach((u) => table.push({ key: k, id: idOf(u), sheet: sheetOf(u), file: man[k].file, type: man[k].contentType })));
  const storage = { 'stock/snapshot.csv': 'stock_snapshot' };
  return function (url) {
    if (/supabase\.co\/storage\/v1\/object\/public\//.test(url)) {
      const p = url.split('/object/public/')[1].split('?')[0];
      const k = storage[p];
      return k && man[k] ? { file: path.join(snap, man[k].file), type: 'text/csv; charset=utf-8' } : null;
    }
    if (!/docs\.google\.com|googleusercontent\.com/.test(url)) return null;
    const id = idOf(url), sheet = sheetOf(url);
    const hit = table.find((t) => t.id === id && t.sheet === sheet) || table.find((t) => t.id === id && !t.sheet) || null;
    return hit ? { file: path.join(snap, hit.file), type: hit.type || 'text/csv; charset=utf-8' } : null;
  };
}

/* ---------------- in-page helpers (serialised into the page) ---------------- */
// textContent, not innerText: a modal that is still fading in has no rendered text yet.
const TXT = "const txt = (el) => (el ? String(el.textContent || '').replace(/\\s+/g, ' ').trim() : '');";
function evalIn(page, body, a) { return page.evaluate(new Function('a', TXT + '\n' + body), a); }

/* ---------------- the pages ---------------- */
const PAGES = {
  accident: {
    url: 'accident/accident.html', nav: 'accident',
    // Known differences: rules that rewrite an old value into what the new page shows, with the reason.
    known: [
      { why: 'dates are shown as DD/MM/YYYY (the sheet writes 13/7/2018 for accidents and 03.06.2019 for inquiries)',
        fix: (s) => s.replace(/\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/g, (m, d, mo, y) => d.padStart(2, '0') + '/' + mo.padStart(2, '0') + '/' + y) },
      { why: 'average inquiry delay per region: every inquiry date is read now (the old code read the dotted DD.MM.YYYY inquiry dates as MM.DD and skipped those with a day above 12)',
        leaf: (o, n) => { const cut = (x) => String(x).replace(/Average delay in Inquiry submission by region: [^]*?(?=Most common cause|No data for outsourced)/, ''); return typeof o === 'string' && typeof n === 'string' && o !== n && cut(o) === cut(n); } }
    ],
    ready: "return document.getElementById('statsOverview') && document.getElementById('statsOverview').style.display === 'grid' && /\\d/.test(document.getElementById('dateRange') ? document.getElementById('dateRange').textContent : '1')",
    async walk(page, shot) {
      const view = `return { tab: txt(document.querySelector('.tab.active')), stats: ['totalAccidents', 'fatalAccidents', 'pendingInquiries'].map((id) => txt(document.getElementById(id))),
        range: txt(document.getElementById('dateRange')), timeline: [].map.call(document.querySelectorAll('#calendarGrid .acc-tl-cell'), (c) => txt(c) + (c.classList.contains('hot') ? '*' : '')) };`;
      const modal = `const open = (id) => document.getElementById(id).classList.contains('active');
        return { modal: open('modalOverlay') ? [txt(document.getElementById('modalTitle')), txt(document.getElementById('modalSubtitle')), [].map.call(document.querySelectorAll('#breakdownList .breakdown-item'), txt)] : null,
          list: open('victimListOverlay') ? [txt(document.getElementById('victimListTitle')), txt(document.getElementById('victimListSubtitle')), [].map.call(document.querySelectorAll('#victimListContent .search-result'), txt)] : null,
          victim: open('victimModalOverlay') ? txt(document.getElementById('victimDetailsContent')) : null };`;
      const esc = () => page.keyboard.press('Escape');
      await shot('load', view);
      await shot('rows', 'return processedData.map((r) => [r["Accident Id"], r._mappedRegion, r["Date of Accident"], r["Inquiry Submitted on"], r["Name of Division / RE Project"], r["Name of CCC/ Substation/ RE Project"]].join("|"));');
      for (const region of ['zone', 'Malda (D) Region', 'Uttar Dinajpur (D) Region', 'Dakshin Dinajpur (D) Region']) {
        await page.click(`.tab[data-region="${region}"]`);
        await shot('tab:' + region, view);
        for (const card of ['total', 'fatal', 'pending']) {
          await page.click(`.stat-card[data-type="${card}"]`);
          await shot(`${region}:${card}:division`, modal);
          await page.click('.modal-tab[data-modal-tab="unit"]');
          await shot(`${region}:${card}:unit`, modal);
          if (await page.locator('#breakdownList .breakdown-item').count()) {
            await page.locator('#breakdownList .breakdown-item').first().click();
            await shot(`${region}:${card}:unit:list`, modal);
            if (await page.locator('#victimListContent .search-result').count()) {
              await page.locator('#victimListContent .search-result').first().click();
              await shot(`${region}:${card}:unit:victim`, modal);
            }
          }
          await esc();
          await page.click('.stat-card[data-type="total"]');
          await page.click('.modal-tab[data-modal-tab="division"]');
          await esc();
        }
        for (const v of ['yearly', 'monthly']) {
          await page.selectOption('#timelineView', v);
          await shot(`${region}:timeline:${v}`, view);
          const cells = await page.locator('#calendarGrid .acc-tl-cell').count();
          for (let i = 0; i < cells; i += (v === 'yearly' ? 1 : 4)) {
            await page.locator('#calendarGrid .acc-tl-cell').nth(i).click();
            await shot(`${region}:timeline:${v}:${i}`, modal);
            await esc();
          }
        }
      }
      await page.evaluate(() => toggleAnalytics());
      const nAcc = await page.locator('.accordion-button').count();
      for (let i = 0; i < nAcc; i++) {
        await page.locator('.accordion-button').nth(i).click();
        await shot('analytics:' + i, "return [].map.call(document.querySelectorAll('.accordion-panel'), (p) => p.style.display === 'block' ? txt(p) : '').filter(Boolean);");
      }
      await page.evaluate(() => closeAnalytics());
      for (const q of ['ra', 'A00000', 'p.s', 'kaliachak']) {
        await page.fill('#universalSearch', q);
        await shot('search:' + q, "return [].map.call(document.querySelectorAll('#searchResults .search-result, #searchResults .empty-state'), txt);");
      }
      await page.fill('#universalSearch', 'ra');
      if (await page.locator('#searchResults .search-result').count()) {
        await page.locator('#searchResults .search-result').nth(2).click();
        await shot('search:victim', modal);
      }
    }
  }
};

// A short digest of a value in the page (FNV-1a of its JSON), for large in-memory row lists.
const DIGEST = "const digest = (v) => { const s = JSON.stringify(v); let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return s.length + ':' + h.toString(16); };";

PAGES.dtr = {
  url: 'dtr/index.html', nav: 'dtr',
  ready: "const t = document.querySelector('#regionTable tbody'); return t && t.rows.length && !/Loading/.test(t.textContent) && /\\d/.test(document.getElementById('overallDTRCount').textContent) && document.getElementById('overallDTRCount').textContent !== '0';",
  known: [],
  async walk(page, shot) {
    const view = `const card = [].find.call(document.querySelectorAll('#visualization-area > .card'), (c) => !c.classList.contains('d-none'));
      const t = card && card.querySelector('table');
      const rows = t ? [].map.call(t.tBodies[0].rows, (r) => [].map.call(r.cells, txt).join(' | ')) : [];
      return { overall: [txt(document.getElementById('overallDTRCount')), txt(document.getElementById('overallCapacitySum'))], head: card ? txt(card.querySelector('.card-header')) : '',
        crumbs: txt(document.getElementById('breadcrumb-navigation')), level: document.getElementById('directLevelSelect').value, n: rows.length, rows: rows.slice(0, 40), last: rows.slice(-3), foot: t && t.tFoot ? txt(t.tFoot) : '' };`;
    const clickRow = async (i) => { const r = page.locator('#visualization-area > .card:not(.d-none) table tbody tr.table-row-clickable'); if (await r.count() > i) { await r.nth(i).click(); return true; } return false; };
    await shot('load', view);
    await shot('rows', DIGEST + " return { n: dtrRawData.length, digest: digest(dtrRawData), totals: overallTotals };");
    // drill down the first row (and the second) to the DTR list, open the first DTR
    for (const pick of [0, 1]) {
      await page.click('#homeBtn');
      for (let level = 0; level < 6; level++) {
        if (!(await clickRow(level === 0 ? pick : 0))) break;
        await shot(`drill${pick}:${level}`, view);
      }
      const code = page.locator('#dtrListTable .dtr-code-clickable');
      if (await code.count()) {
        await code.first().click();
        await page.waitForTimeout(400);
        await shot(`drill${pick}:detail`, "return [txt(document.getElementById('modalDTRCode')), txt(document.getElementById('modalDTRDetailsBody'))];");
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
      }
      // breadcrumb back to the second level
      const crumbs = page.locator('#breadcrumb-navigation button[data-level]');
      if (await crumbs.count() > 1) { await crumbs.nth(1).click(); await shot(`drill${pick}:crumb`, view); }
    }
    // Capacity shortcut on every region, then the first capacity row
    await page.click('#homeBtn');
    const nReg = await page.locator('#regionTable .btn-direct-capacity').count();
    for (let i = 0; i < nReg; i++) {
      await page.click('#homeBtn');
      await page.locator('#regionTable .btn-direct-capacity').nth(i).click();
      await shot('capacity:' + i, view);
      if (await clickRow(0)) await shot('capacity:' + i + ':list', view);
    }
    // every level straight from the select, and a sort
    for (const lv of ['REGION', 'DIVN NAME', 'SUPP_OFF', 'SS_NAME', 'FDR_NAME', 'CAPA_KV']) {
      await page.selectOption('#directLevelSelect', lv);
      await shot('level:' + lv, view);
    }
    await page.selectOption('#directLevelSelect', 'SUPP_OFF');
    await page.click('#cccTable th[data-sort-key="dtr_count"]');
    await shot('sort:ccc:count', view);
    await page.click('#cccTable th[data-sort-key="dtr_count"]');
    await shot('sort:ccc:count:desc', view);
  }
};

// dtr/load.html authorizes from the signed-in profile's dtr-autho: the walk sets the state that leaves
// (authenticated, DTR prefixes) and calls the page's own read functions.
// Nothing is ever submitted (the Apps Script POST is blocked as well).
const DTRLOAD_AUTH = "window.isAuthenticated = true; window.userAuthorizedDTRPrefix = ['7G', 'A3', '6R']; document.getElementById('mainContentWrapper').style.display = 'block';";
PAGES.dtrload = {
  url: 'dtr/load.html', nav: 'dtr_load',
  ready: "return document.readyState === 'complete' && !!window.MzoRows === !!document.querySelector('script[src*=\"mzo_rows\"]');",
  timingReady: "const m = document.getElementById('allDataModal'); return m && m.style.display === 'flex' && document.querySelector('#allDataTable tbody tr td') && document.getElementById('kpi-total').textContent !== '0';",
  async timingStart(page) {
    await page.waitForFunction(() => document.readyState === 'complete');
    await page.evaluate(new Function(DTRLOAD_AUTH + ' showAllLoadData();'));
  },
  known: [
    { why: 'REMARKS (last column) is decoded as CSV now: on lines ending in CR LF the old splitter left a quoted cell undecoded and cut it at its first comma (a remark "Village, DTR load need to reduce" showed as a quote mark and Village)',
      leaf: (o, n) => { if (typeof o !== 'string' || typeof n !== 'string' || !/"/.test(o)) return false; const q = (x) => x.replace(/"/g, ''); return q(n).startsWith(q(o)); } }
  ],
  async walk(page, shot) {
    await page.waitForFunction(() => document.readyState === 'complete');
    await page.evaluate(new Function(DTRLOAD_AUTH));
    const table = `const t = window.allDataTableInstance;
      const rows = t ? t.rows({ search: 'applied', order: 'applied', page: 'all' }).data().toArray().map((r) => Object.keys(r).map((k) => k + '=' + r[k]).join('|')) : [];
      return { kpi: ['kpi-total', 'kpi-no-kiosk', 'kpi-no-la', 'kpi-no-flat'].map((id) => txt(document.getElementById(id))), info: txt(document.getElementById('allDataTable_info')),
        head: [].map.call(document.querySelectorAll('#allDataTable thead th'), txt), shown: [].map.call(document.querySelectorAll('#allDataTable tbody tr'), (r) => [].map.call(r.cells, txt).join(' | ')), n: rows.length, rows };`;
    await page.evaluate(() => showAllLoadData());
    await page.waitForFunction(() => document.getElementById('allDataModal').style.display === 'flex' || /Could not|No load/.test(document.getElementById('result').textContent), null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(300);
    await shot('all', table);
    for (const id of ['no-kiosk-tab', 'no-la-tab', 'no-flat-earthing-tab', 'all-tab']) {
      await page.click('#' + id);
      await page.waitForTimeout(300);
      await shot('tab:' + id, table);
    }
    await page.evaluate(() => { window.allDataTableInstance.search('7G0').draw(); });
    await page.waitForTimeout(200);
    await shot('search:7G0', table);
    await page.evaluate(() => { window.allDataTableInstance.search('').draw(); closeModal('allDataModal'); });
    // The form: pre-fill from the latest measurement of a DTR (or the master record when there is none),
    // then the confirmation check (record count, replace / add choice). The modal is closed, never confirmed.
    const form = `return { result: txt(document.getElementById('result')), form: ['DATE_OF_MEASUREMENT', 'NEW_LOC_NAME', 'NEW_FDR_NAME', 'NEW_CAPA_KV', 'LOAD_R', 'LOAD_Y', 'LOAD_B', 'LOAD_N', 'KIOSK', 'LA', 'NEUTRAL_FLAT_EARTHING', 'REMARKS'].map((id) => id + '=' + document.getElementById(id).value),
      confirm: document.getElementById('confirmationModal').style.display === 'flex' ? [txt(document.getElementById('confirmationModalMessage')), document.getElementById('confirmationActions').innerHTML.replace(/\\s+/g, ' ').trim(), txt(document.getElementById('confirmationData'))] : null };`;
    for (const code of ['7G008', '7G10Y', 'A301I', '6R00H', 'ZZ999']) {
      await page.evaluate((c) => { resetSearch(); document.getElementById('searchCode').value = c; window.currentCode = c; document.getElementById('formSection').style.display = 'block'; return populateFormWithLastUpdate(c, { LOC_NAME: 'MASTER LOC', FDR_NAME: 'MASTER FDR', CAPA_KV: '25kVA', LOAD_R: '1', LOAD_Y: '2', LOAD_B: '3', LOAD_N: '4', KIOSK: 'Ok', LA: 'Ok', NEUTRAL_FLAT_EARTHING: 'Yes', REMARKS: 'master' }); }, code);
      await shot('form:' + code, form);
      await page.evaluate(() => { const d = document.getElementById('DATE_OF_MEASUREMENT'); if (!d.value) d.value = '2025-08-20T10:00'; return showConfirmation(); });
      await page.waitForTimeout(200);
      await shot('confirm:' + code, form);
      await page.evaluate(() => closeModal('confirmationModal'));
    }
  }
};

PAGES.crossings = {
  url: 'power_map/nh_sh_crossings.html', nav: 'highway_crossings',
  ready: "const s = document.getElementById('filter-summary'); return s && /Total Loc: \\d/.test(s.textContent);",
  known: [
    { why: 'the marker popup shows Lat/Long as the sheet writes them (25.0105960 instead of 25.010596)',
      leaf: (o, n) => typeof o === 'string' && typeof n === 'string' && o.replace(/\d+\.\d+/g, (m) => String(parseFloat(m))) === n.replace(/\d+\.\d+/g, (m) => String(parseFloat(m))) }
  ],
  async walk(page, shot) {
    const view = `const counts = [].map.call(document.querySelectorAll('#filter-options .filter-category'), (c) => [].map.call(c.querySelectorAll('label'), (l) => txt(l) + (l.querySelector('input') && l.querySelector('input').checked ? '' : ' [off]') + (l.classList.contains('disabled') ? ' [disabled]' : '')).join(' ; '));
      return { summary: txt(document.getElementById('filter-summary')), markers: allMarkersLayerGroup.getLayers().length, counts, legend: [].map.call(document.querySelectorAll('#map-legend .legend-item'), (i) => txt(i) + ' ' + i.querySelector('.legend-symbol').style.backgroundColor) };`;
    const report = "return document.getElementById('report-modal').classList.contains('modal-visible') ? [txt(document.getElementById('report-modal-title')), [].map.call(document.querySelectorAll('#report-modal-body tr, #report-modal-body h3, #report-modal-body h4, #report-modal-body p, #report-modal-body li'), txt)] : null;";
    await shot('load', view);
    await shot('entries', DIGEST + " return { n: allData.length, digest: digest(allData.map((e) => FILTER_CATEGORIES.map((c) => categoryValue(e, c)).join('|') + '|' + (e.marker ? e.marker.getLatLng().lat + ',' + e.marker.getLatLng().lng + ',' + e.marker.options.fillColor : 'none'))) };");
    const cats = await page.evaluate(() => FILTER_CATEGORIES);
    for (const cat of cats) {
      const boxes = page.locator(`#filter-options input[data-category="${cat}"]`);
      const n = await boxes.count();
      for (let i = 0; i < Math.min(n, 3); i++) {
        await boxes.nth(i).uncheck();
        await shot(`off:${cat}:${i}`, view);
        await boxes.nth(i).check();
      }
      if (n) {
        await page.locator(`#filter-options input[data-category="${cat}"]`).first().locator('xpath=ancestor::div[contains(@class,"filter-item")]').locator('.report-icon').click();
        await shot(`report:${cat}`, report);
        await page.evaluate(() => document.getElementById('report-modal').classList.remove('modal-visible'));
      }
    }
    // a combined filter, then the overall report on it
    const b0 = page.locator('#filter-options input[data-category="Division"]');
    if (await b0.count() > 1) { await b0.nth(0).uncheck(); await b0.nth(1).uncheck(); }
    await shot('off:two divisions', view);
    await page.click('#overall-report-btn');
    await shot('report:overall:filtered', report);
    await page.evaluate(() => document.getElementById('report-modal').classList.remove('modal-visible'));
    if (await b0.count() > 1) { await b0.nth(0).check(); await b0.nth(1).check(); }
    await page.click('#overall-report-btn');
    await shot('report:overall', report);
    await page.evaluate(() => document.getElementById('report-modal').classList.remove('modal-visible'));
    for (const v of ['Status', 'NH/SH', 'Voltage Level']) {
      await page.check(`input[name="colorBy"][value="${v}"]`);
      await shot('colour:' + v, DIGEST + " return { legend: [].map.call(document.querySelectorAll('#map-legend .legend-item'), (i) => txt(i) + ' ' + i.querySelector('.legend-symbol').style.backgroundColor), colours: digest(allData.map((e) => e.marker ? e.marker.options.fillColor : '')) };");
    }
    for (const q of ['mal-rat', 'GAZ', '4850', 'zz-none']) {
      await page.fill('#search-box', q);
      await page.dispatchEvent('#search-box', 'input');
      await shot('search:' + q, "return [].map.call(document.querySelectorAll('#search-results li'), txt);");
    }
    // marker popups (the geocoder is blocked, so the popup says the place could not be retrieved)
    for (const i of [0, 1, 500, 2000]) {
      const ok = await page.evaluate((i) => { const e = allData[i]; if (!e || !e.marker) return false; e.marker.fire('click'); return true; }, i);
      if (!ok) continue;
      await page.waitForTimeout(400);
      await shot('popup:' + i, "const e = allData[" + i + "]; const p = e.marker.getPopup(); const d = document.createElement('div'); d.innerHTML = p ? p.getContent() : ''; return [txt(d), [].map.call(d.querySelectorAll('a'), (a) => a.getAttribute('href'))];");
      await page.evaluate(() => map.closePopup());
    }
  }
};

PAGES.stock = {
  url: 'stock/index.html', nav: 'stock',
  ready: "return document.querySelectorAll('#kpi-container .kpi-card').length > 0 && !document.querySelector('#data-table .loader-cell') && document.querySelector('#data-table tbody tr td');",
  known: [],
  async walk(page, shot) {
    const view = `const rows = [].map.call(document.querySelectorAll('#data-table tbody tr'), (r) => [].map.call(r.cells, txt).join(' | '));
      return { head: txt(document.getElementById('chart-header')), kpi: [].map.call(document.querySelectorAll('#kpi-container .kpi-card'), txt), tab: txt(document.querySelector('.tab-link.active')),
        selects: ['store-filter', 'material-group-filter', 'material-description-filter'].map((id) => { const el = document.getElementById(id); return id + '=' + el.value + '/' + [].map.call(el.options, (o) => o.value).join(','); }),
        n: rows.length, rows: rows.slice(0, 60), last: rows.slice(-5) };`;
    const modal = "const m = document.getElementById('breakdown-modal'); return m.style.display === 'block' || m.style.display === 'flex' ? [txt(document.getElementById('modal-title')), [].map.call(document.querySelectorAll('#modal-table-body tr'), (r) => [].map.call(r.cells, txt).join(' | '))] : null;";
    await shot('load', view);
    await shot('items', DIGEST + " return { n: window.allData.length, digest: digest(window.allData.map((i) => [i.Plant, i.StoreName, i.StoreType, i.Category, i.Material, i['Material Description'], i['Material Group'], i['Base Unit of Measure'], parseStockNumber(i.Unrestricted)])) };");
    const nKpi = await page.locator('#kpi-container .kpi-card').count();
    for (let i = 0; i < nKpi; i++) {
      await page.locator('#kpi-container .kpi-card').nth(i).click();
      await shot('kpi:' + i, modal);
      await page.evaluate(() => { document.getElementById('breakdown-modal').style.display = 'none'; });
    }
    await page.click('#low-stock-alert-btn');
    await shot('lowstock', "const m = document.getElementById('low-stock-modal'); return [m.style.display, txt(document.getElementById('low-stock-content'))];");
    await page.evaluate(() => { document.getElementById('low-stock-modal').style.display = 'none'; });
    for (const tab of ['new', 'old', 'total']) {
      await page.evaluate((t) => changeStoreTab(t), tab);
      await shot('tab:' + tab, view);
    }
    const stores = await page.evaluate(() => [].map.call(document.getElementById('store-filter').options, (o) => o.value).filter(Boolean));
    for (const st of stores.slice(0, 4).concat(stores.slice(-2))) {
      await page.selectOption('#store-filter', st);
      await shot('store:' + st, view);
    }
    await page.selectOption('#store-filter', stores[0] || '');
    const groups = await page.evaluate(() => [].map.call(document.getElementById('material-group-filter').options, (o) => o.value).filter(Boolean));
    if (groups.length) {
      await page.selectOption('#material-group-filter', groups[0]);
      await shot('group:' + groups[0], view);
      const descs = await page.evaluate(() => [].map.call(document.getElementById('material-description-filter').options, (o) => o.value).filter(Boolean));
      if (descs.length) { await page.selectOption('#material-description-filter', descs[0]); await shot('desc:' + descs[0], view); }
    }
    await page.selectOption('#store-filter', '');
    await page.evaluate(() => { const s = document.getElementById('store-filter'); s.dispatchEvent(new Event('change')); });
    await page.uncheck('#category-local-checkbox');
    await shot('central only', view);
    await page.check('#category-local-checkbox');
    await page.uncheck('#category-central-checkbox');
    await shot('local only', view);
    await page.check('#category-central-checkbox');
    for (const q of ['pole', 'dtr', '0110020711', 'cable 4c']) {
      await page.fill('#search-input', q);
      await shot('search:' + q, view);
    }
    await page.fill('#search-input', '');
    await page.click('#data-table th:nth-child(4)');
    await shot('sort:stock', view);
    await page.click('#data-table th:nth-child(4)');
    await shot('sort:stock:desc', view);
  }
};

PAGES.powermap = {
  url: 'power_map/map.html', nav: 'power_map',
  // Original mode reads the published sheet (the meta's csvUrl), which has stray spaces in three cells.
  known: [{ why: 'cells are trimmed: the published Power Map sheet has stray spaces in three cells (Balia , two coordinates) that the old page kept; nothing on screen changes',
    leaf: (o, n) => typeof o === 'string' && typeof n === 'string' && o.split('|').map((x) => x.replace(/=\s+/, '=').trim()).join('|') === n }],
  ready: "const s = document.getElementById('stat-ss-count'); return s && /[1-9]/.test(s.textContent) && document.querySelectorAll('#filter-options input[type=checkbox]').length > 0;",
  async walk(page, shot) {
    // the loading screen fades out (it covers the filters until then); markers and taps are plotted
    await page.waitForFunction(() => { const l = document.getElementById('loading-screen'); return !l || getComputedStyle(l).visibility === 'hidden'; }, null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(500);
    const view = `const count = (sel) => document.querySelectorAll(sel).length;
      return { stats: ['stat-ss-count', 'stat-solid-count', 'stat-dashed-count', 'stat-tap-count', 'stat-rl-total'].map((id) => txt(document.getElementById(id))),
        filters: [].map.call(document.querySelectorAll('#filter-options .filter-item'), (i) => txt(i) + (i.querySelector('input') && !i.querySelector('input').checked ? ' [off]' : '')),
        markers: allMarkers.length, onMap: allMarkers.filter((m) => map.hasLayer(m)).length, labels: allLineLabels.length, substations: Object.keys(substationMap).length };`;
    const report = "const m = document.getElementById('report-modal'); return getComputedStyle(m).display !== 'none' ? [txt(document.getElementById('report-title')), [].map.call(document.querySelectorAll('#report-table-container tr'), (r) => [].map.call(r.cells, txt).join(' | '))] : null;";
    await shot('load', view);
    await shot('entries', "return { entries: allData.map((e) => Object.keys(e).map((k) => k + '=' + e[k]).join('|')), taps: allTapsData.map((e) => Object.keys(e).map((k) => k + '=' + e[k]).join('|')), counts: window.connectionCounts };");
    // every filter value's report, then a few filters off
    const icons = await page.locator('#filter-options .report-icon').count();
    for (let i = 0; i < icons; i++) {
      await page.locator('#filter-options .report-icon').nth(i).click({ force: true });
      await page.waitForTimeout(150);
      await shot('report:' + i, report);
      await page.evaluate(() => { const m = document.getElementById('report-modal'); m.style.display = 'none'; m.classList.remove('active', 'show', 'visible'); });
    }
    const boxes = page.locator('#filter-options .filter-item input[type=checkbox]');
    const nb = await boxes.count();
    for (const i of [0, 1, Math.floor(nb / 2), nb - 1]) {
      if (i < 0 || i >= nb) continue;
      await boxes.nth(i).click({ force: true });
      await shot('off:' + i, view);
      await boxes.nth(i).click({ force: true });
    }
    await page.click('#toggle-proposed', { force: true });
    await shot('proposed off', view);
    await page.click('#toggle-proposed', { force: true });
    for (const q of ['gss', 'bal', 'mal']) {
      await page.fill('#search-box', q);
      await page.dispatchEvent('#search-box', 'input');
      await shot('search:' + q, "return [].map.call(document.querySelectorAll('#search-results li, #search-results div'), txt);");
    }
    // substation popups (first few markers)
    for (const i of [0, 1, 10, 50]) {
      const ok = await page.evaluate((i) => { const m = allMarkers[i]; if (!m) return false; m.fire('click'); return true; }, i);
      if (!ok) continue;
      await page.waitForTimeout(300);
      await shot('popup:' + i, "const p = document.querySelector('.leaflet-popup-content'); return p ? txt(p) : null;");
      await page.evaluate(() => map.closePopup());
    }
  }
};

/* ---------------- browser plumbing ---------------- */
async function newContext(browser, base, profile, route, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: opts.phone ? { width: 390, height: 844 } : { width: 1280, height: 900 }, deviceScaleFactor: opts.phone ? 2 : 1, isMobile: !!opts.phone, hasTouch: !!opts.phone, timezoneId: 'Asia/Kolkata', locale: 'en-IN' });
  await ctx.addCookies([{ name: 'mzo_session', value: cookie(profile), domain: new URL(base).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
  const version = await fetch(base + '/version.json').then((r) => r.json()).then((j) => j.version).catch(() => '');
  await ctx.addInitScript(({ profile, version, theme, ready }) => {
    try {
      localStorage.setItem('mzo_user_profile', JSON.stringify(profile)); localStorage.setItem('mzo_authenticated', 'true');
      if (version) localStorage.setItem('mzo_app_version', version);
      if (theme) { localStorage.setItem('theme', theme); localStorage.setItem('mzo_theme', theme); }
    } catch (_) {}
    window.__fdp = null;
    if (!ready) return;
    const test = new Function(ready);
    const t = () => { if (window.__fdp != null) return; let ok = false; try { ok = !!test(); } catch (_) {} if (ok) { window.__fdp = performance.now(); return; } requestAnimationFrame(t); };
    requestAnimationFrame(t);
  }, { profile, version, theme: opts.theme || 'dark', ready: opts.ready || '' });
  const stats = { blocked: [], data: [] };
  await ctx.route('**/*', async (r) => {
    const req = r.request(), url = req.url();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) { stats.blocked.push(req.method() + ' ' + url.slice(0, 100)); return r.abort('blockedbyclient'); }
    if (/script\.google(usercontent)?\.com|nominatim\.openstreetmap|overpass/.test(url)) { stats.blocked.push('external ' + url.slice(0, 60)); return r.abort('blockedbyclient'); }
    const hit = route && route(url);
    if (hit) { stats.data.push(url.slice(0, 120)); return r.fulfill({ status: 200, headers: { 'content-type': hit.type, 'access-control-allow-origin': '*' }, body: req.method() === 'HEAD' ? '' : fs.readFileSync(hit.file) }); }
    return r.continue();
  });
  ctx.__stats = stats;
  return ctx;
}

async function settle(page, ms) {
  await page.waitForFunction(() => window.__fdp != null, null, { timeout: ms || 120000 }).catch(() => {});
  await page.waitForTimeout(800);
}

async function runOne(browser, base, cfg, profile, route, opts) {
  const ctx = await newContext(browser, base, PROFILES[profile], route, Object.assign({ ready: cfg.ready }, opts));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror ' + String(e.message || e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  const states = {};
  // --smoke: only the first two states of each walk (the loaded page and the rows it keeps)
  const smoke = flag('smoke');
  const shot = async (label, body) => { if (smoke && Object.keys(states).length >= 2) throw new Error('smoke: walk stopped after the loaded state');
    await page.waitForTimeout(60); try { states[label] = deepMap(await evalIn(page, body), (x) => x.split(base).join('<base>')); /* links name the base under test */ } catch (e) { states[label] = 'ERROR ' + String(e.message || e).slice(0, 160); } };
  await page.goto(base + '/' + cfg.url, { waitUntil: 'domcontentloaded' });
  await settle(page);
  try { await cfg.walk(page, shot, { phone: !!opts.phone }); } catch (e) { states.__walk = 'walk failed: ' + String(e.message || e).slice(0, 300); }
  const rowsSource = await page.evaluate(() => (window.MzoRows && Object.keys(MzoRows.last).length ? JSON.stringify(MzoRows.last) : '')).catch(() => '');
  await ctx.close();
  return { states, errors, blocked: ctx.__stats.blocked, rowsSource };
}

function deepMap(v, fn) {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map((x) => deepMap(x, fn));
  if (v && typeof v === 'object') { const o = {}; Object.keys(v).forEach((k) => { o[k] = deepMap(v[k], fn); }); return o; }
  return v;
}
// Leaf strings that differ (arrays index by index), for the report.
function leaves(a, b, at, out) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (Array.isArray(a) && Array.isArray(b)) { for (let i = 0; i < Math.max(a.length, b.length); i++) leaves(a[i], b[i], at + '[' + i + ']', out); if (a.length !== b.length) out.push({ at: at + '.length', old: a.length, new: b.length }); return out; }
  if (a && b && typeof a === 'object' && typeof b === 'object') { Object.keys(Object.assign({}, a, b)).forEach((k) => leaves(a[k], b[k], at + '.' + k, out)); return out; }
  out.push({ at, old: a, new: b });
  return out;
}
// Known rules: { why, fix(oldString) → string } rewrites old values; { why, leaf(old, new) → bool }
// accepts one differing value pair. A state is explained when nothing else differs.
function diffStates(a, b, known) {
  const out = [];
  Object.keys(Object.assign({}, a, b)).forEach((k) => {
    if (JSON.stringify(a[k]) === JSON.stringify(b[k])) return;
    let cur = a[k];
    const why = new Set();
    for (const rule of known || []) {
      if (!rule.fix) continue;
      const next = deepMap(cur, rule.fix);
      if (JSON.stringify(next) !== JSON.stringify(cur)) { why.add(rule.why); cur = next; }
    }
    const rest = leaves(cur, b[k], '', []).filter((x) => {
      const r = (known || []).find((q) => q.leaf && q.leaf(x.old, x.new, x.at));
      if (r) why.add(r.why);
      return !r;
    });
    out.push({ state: k, explained: rest.length ? null : [...why], leaves: leaves(a[k], b[k], '', []).slice(0, 6), unexplained: rest.slice(0, 8) });
  });
  return out;
}

async function parity(pw) {
  const olds = String(arg('old')).split(','), news = String(arg('new')).split(',');
  if (olds.length !== news.length) throw new Error('--old and --new need the same number of bases');
  const pages = String(arg('pages', Object.keys(PAGES).join(','))).split(',');
  const profiles = String(arg('profiles', 'admin,region,ccc')).split(',');
  const themes = String(arg('themes', 'dark')).split(',');
  const outDir = arg('out', path.join(process.cwd(), '.scratch', 'legacy-parity'));
  fs.mkdirSync(outDir, { recursive: true });
  const route = router(arg('snap'));
  const browser = await pw.chromium.launch({ channel: process.env.QA_CHANNEL || 'chrome', headless: true });
  const summary = [];
  const variants = [];
  for (const theme of themes) for (const prof of profiles) variants.push({ theme, prof, phone: false });
  if (flag('phone')) variants.push({ theme: themes[0], prof: 'admin', phone: true });
  const jobs = [];
  for (const p of pages) for (const v of variants) for (let i = 0; i < olds.length; i++) jobs.push({ p, v, i });
  const conc = Number(arg('concurrency', 3));
  const worker = async () => {
    for (;;) {
      const job = jobs.shift();
      if (!job) return;
      const { p, v, i } = job;
      {
        const [a, b] = await Promise.all([runOne(browser, olds[i], PAGES[p], v.prof, route, v), runOne(browser, news[i], PAGES[p], v.prof, route, v)]);
        const d = diffStates(a.states, b.states, PAGES[p].known);
        const bad = d.filter((x) => !x.explained);
        const reasons = {};
        d.filter((x) => x.explained).forEach((x) => x.explained.forEach((w) => { reasons[w] = (reasons[w] || 0) + 1; }));
        const tag = `${p}-${v.prof}-${v.theme}${v.phone ? '-390' : ''}-${new URL(news[i]).port}`;
        summary.push({ page: p, profile: v.prof, theme: v.theme, phone: v.phone, old: olds[i], new: news[i], states: Object.keys(a.states).length, differences: d.length, unexplained: bad.length, reasons, errorsOld: a.errors.length, errorsNew: b.errors.length, rowsSource: b.rowsSource });
        fs.writeFileSync(path.join(outDir, tag + '.json'), JSON.stringify({ page: p, differences: d, oldStates: a.states, newStates: b.states, oldErrors: a.errors, newErrors: b.errors, blockedOld: a.blocked, blockedNew: b.blocked, rowsSource: b.rowsSource }, null, 1));
        console.log(`[parity] ${p} ${v.prof} ${v.theme}${v.phone ? ' 390px' : ''}: ${new URL(olds[i]).port} vs ${new URL(news[i]).port}: ${Object.keys(a.states).length} states, ${d.length} differ, ${bad.length} UNEXPLAINED; console errors old ${a.errors.length} / new ${b.errors.length}${b.rowsSource ? '; rows ' + b.rowsSource.slice(0, 160) : ''}`);
        Object.keys(reasons).forEach((w) => console.log(`    known (${reasons[w]} states): ${w}`));
        bad.slice(0, 10).forEach((x) => { console.log(`    UNEXPLAINED ${x.state}:`); x.unexplained.forEach((l) => console.log(`      ${l.at}: ${String(JSON.stringify(l.old)).slice(0, 200)} → ${String(JSON.stringify(l.new)).slice(0, 200)}`)); });
      }
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 1));
  await browser.close();
}

async function timing(pw) {
  const bases = { old: arg('old'), new: arg('new') };
  const runsN = Number(arg('runs', 5)), cpu = Number(arg('cpu', 1));
  const route = router(arg('snap'));
  const pages = String(arg('pages', Object.keys(PAGES).join(','))).split(',');
  const browser = await pw.chromium.launch({ channel: process.env.QA_CHANNEL || 'chrome', headless: true });
  const med = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? Math.round(s[Math.floor((s.length - 1) / 2)]) : null; };
  const rows = [];
  for (const p of pages) {
    const cfg = PAGES[p];
    for (const which of ['old', 'new']) {
      const cold = [], warm = [];
      for (let i = 0; i < runsN; i++) {
        const ctx = await newContext(browser, bases[which], PROFILES.admin, route, { ready: cfg.timingReady || cfg.ready });
        const page = await ctx.newPage();
        page.on('dialog', (d) => d.dismiss().catch(() => {}));
        if (cpu > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu }); }
        for (const pass of ['cold', 'warm']) {
          await page.goto(bases[which] + '/' + cfg.url, { waitUntil: 'domcontentloaded' });
          if (cfg.timingStart) await cfg.timingStart(page);
          await page.waitForFunction(() => window.__fdp != null, null, { timeout: 180000 }).catch(() => {});
          const ms = await page.evaluate(() => window.__fdp);
          (pass === 'cold' ? cold : warm).push(ms);
          if (pass === 'cold') await page.waitForTimeout(2500); // background checks and cache writes finish
        }
        await ctx.close();
      }
      rows.push({ page: p, which, base: bases[which], cold: med(cold), warm: med(warm), coldAll: cold.map((x) => (x == null ? null : Math.round(x))), warmAll: warm.map((x) => (x == null ? null : Math.round(x))) });
      console.log(`[timing] ${p} ${which}: first data paint cold ${med(cold)} ms, warm ${med(warm)} ms (runs ${cold.map((x) => Math.round(x)).join('/')} · ${warm.map((x) => Math.round(x)).join('/')})${cpu > 1 ? ', cpu x' + cpu : ''}`);
    }
  }
  await browser.close();
  const out = arg('out');
  if (out) fs.writeFileSync(out, JSON.stringify(rows, null, 1));
}

async function shots(pw) {
  const base = arg('new'), outDir = arg('out'), label = arg('label', 'new');
  fs.mkdirSync(outDir, { recursive: true });
  const route = router(arg('snap'));
  const pages = String(arg('pages', Object.keys(PAGES).join(','))).split(',');
  const browser = await pw.chromium.launch({ channel: process.env.QA_CHANNEL || 'chrome', headless: true });
  for (const p of pages) {
    for (const theme of ['light', 'dark']) {
      for (const phone of [false, true]) {
        const ctx = await newContext(browser, base, PROFILES.admin, route, { ready: PAGES[p].ready, theme, phone });
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 200)));
        await page.goto(base + '/' + PAGES[p].url, { waitUntil: 'domcontentloaded' });
        await settle(page);
        if (PAGES[p].beforeShot) await PAGES[p].beforeShot(page);
        await page.waitForTimeout(600);
        const file = path.join(outDir, `${p}-${label}-${theme}-${phone ? 'phone' : 'desktop'}.png`);
        await page.screenshot({ path: file, fullPage: false });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        console.log(`[shots] ${path.basename(file)}${errors.length ? ' page errors: ' + errors.join(' | ') : ''}${overflow > 1 ? ' horizontal overflow ' + overflow + ' px' : ''}`);
        await ctx.close();
      }
    }
    // Inside the workstation shell (app.html#<nav key>), desktop, light and dark
    for (const theme of ['light', 'dark']) {
      const ctx = await newContext(browser, base, PROFILES.admin, route, { theme });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 200)));
      await page.goto(base + '/app.html#' + PAGES[p].nav, { waitUntil: 'domcontentloaded' });
      const frame = await page.waitForSelector('iframe', { timeout: 30000 }).then((h) => h.contentFrame()).catch(() => null);
      if (frame) await frame.waitForFunction(new Function(PAGES[p].ready), null, { timeout: 120000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const file = path.join(outDir, `${p}-${label}-${theme}-shell.png`);
      await page.screenshot({ path: file });
      console.log(`[shots] ${path.basename(file)}${frame ? '' : ' (no frame)'}${errors.length ? ' page errors: ' + errors.join(' | ') : ''}`);
      await ctx.close();
    }
  }
  await browser.close();
}

// Recompute the differences of saved parity runs with the current known rules (no browser).
function rediff() {
  const outDir = arg('out', path.join(process.cwd(), '.scratch', 'legacy-parity'));
  for (const f of fs.readdirSync(outDir).filter((x) => x.endsWith('.json') && x !== 'summary.json').sort()) {
    const j = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'));
    const p = j.page || f.split('-')[0];
    if (arg('pages') && !String(arg('pages')).split(',').includes(p)) continue;
    const d = diffStates(j.oldStates, j.newStates, (PAGES[p] || {}).known);
    const bad = d.filter((x) => !x.explained);
    const reasons = {};
    d.filter((x) => x.explained).forEach((x) => x.explained.forEach((w) => { reasons[w] = (reasons[w] || 0) + 1; }));
    console.log(`[rediff] ${f}: ${Object.keys(j.oldStates).length} states, ${d.length} differ, ${bad.length} UNEXPLAINED; console errors old ${j.oldErrors.length} / new ${j.newErrors.length}`);
    Object.keys(reasons).forEach((w) => console.log(`    known (${reasons[w]} states): ${w}`));
    bad.slice(0, Number(arg('show', 10))).forEach((x) => { console.log(`    UNEXPLAINED ${x.state}:`); x.unexplained.forEach((l) => console.log(`      ${l.at}: ${String(JSON.stringify(l.old)).slice(0, 240)} → ${String(JSON.stringify(l.new)).slice(0, 240)}`)); });
  }
}

(async () => {
  const cmd = process.argv[2];
  if (cmd === 'rediff') return rediff();
  const pw = loadPlaywright();
  if (cmd === 'parity') await parity(pw);
  else if (cmd === 'timing') await timing(pw);
  else if (cmd === 'shots') await shots(pw);
  else { console.error('usage: legacy-pages.js parity|timing|shots …'); process.exit(2); }
})().catch((e) => { console.error(e); process.exit(1); });
