/**
 * Backfill blank stock_allotments.date from created_at (Asia/Kolkata calendar day).
 */
const cfg = require('../data/supabase_config.json');

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

function calendarDateIst(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

(async () => {
  let from = 0;
  const page = 1000;
  const blanks = [];
  while (true) {
    const batch = await (
      await fetch(
        `${url}/rest/v1/stock_allotments?or=(date.is.null,date.eq.)&select=id,allotment_no,date,created_at&order=id.asc&limit=${page}&offset=${from}`,
        { headers: { apikey: key, Authorization: 'Bearer ' + key, 'Accept-Profile': 'mzo_insight' } }
      )
    ).json();
    if (!Array.isArray(batch) || !batch.length) break;
    blanks.push(...batch);
    if (batch.length < page) break;
    from += page;
  }
  console.log('Blank date rows:', blanks.length);
  const byDate = new Map();
  for (const r of blanks) {
    const date = calendarDateIst(r.created_at);
    if (!date) {
      console.warn('Skip id', r.id, 'no created_at');
      continue;
    }
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(r.id);
  }
  for (const [date, ids] of byDate.entries()) {
    // Patch in chunks of ids
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const filter = chunk.map((id) => `id.eq.${id}`).join(',');
      const res = await fetch(`${url}/rest/v1/stock_allotments?or=(${filter})`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ date })
      });
      if (!res.ok) {
        throw new Error(`PATCH ${date} failed ${res.status}: ${await res.text()}`);
      }
      process.stdout.write('.');
    }
  }
  console.log('\nRepaired date groups:', [...byDate.keys()]);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
