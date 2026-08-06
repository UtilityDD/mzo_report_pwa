/**
 * Backfill blank divn_name on the active NSC upload using CCC_CODE → Division map.
 * One PATCH per CCC code (41 updates) instead of per row.
 */
const cfg = require('../data/supabase_config.json');
const { byCode } = require('../lib/nsc_office_map');

const url = cfg.supabaseUrl;
const key = cfg.supabaseKey;
const headers = {
  apikey: key,
  Authorization: 'Bearer ' + key,
  'Accept-Profile': 'mzo_insight',
  'Content-Profile': 'mzo_insight',
  'Content-Type': 'application/json',
  Prefer: 'return=minimal'
};

(async () => {
  const meta = (
    await (
      await fetch(url + '/rest/v1/nsc_upload_meta?is_active=eq.true&select=id,published_rows,report_date&order=id.desc&limit=1', {
        headers: { apikey: key, Authorization: 'Bearer ' + key, 'Accept-Profile': 'mzo_insight' }
      })
    ).json()
  )[0];
  if (!meta) throw new Error('No active NSC upload');
  const id = meta.id;
  console.log('Repairing upload', meta);

  let patched = 0;
  for (const [code, divn] of Object.entries(byCode)) {
    const res = await fetch(
      `${url}/rest/v1/nsc_pending?upload_id=eq.${id}&ccc_code=eq.${encodeURIComponent(code)}&or=(divn_name.is.null,divn_name.eq.)`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ divn_name: divn })
      }
    );
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`PATCH ${code} failed ${res.status}: ${t}`);
    }
    patched++;
    process.stdout.write('.');
  }
  console.log('\nPatched CCC codes:', patched);

  // Verify
  let from = 0;
  const page = 1000;
  const byDiv = {};
  let blank = 0;
  while (true) {
    const batch = await (
      await fetch(
        `${url}/rest/v1/nsc_pending?upload_id=eq.${id}&select=divn_name&order=id.asc&limit=${page}&offset=${from}`,
        { headers: { apikey: key, Authorization: 'Bearer ' + key, 'Accept-Profile': 'mzo_insight' } }
      )
    ).json();
    if (!Array.isArray(batch) || !batch.length) break;
    for (const r of batch) {
      const d = (r.divn_name || '').trim() || '(blank)';
      if (d === '(blank)') blank++;
      byDiv[d] = (byDiv[d] || 0) + 1;
    }
    if (batch.length < page) break;
    from += page;
  }
  console.log('After repair divisions:', byDiv);
  console.log('blank remaining:', blank);
  if (blank) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
