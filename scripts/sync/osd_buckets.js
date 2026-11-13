/**
 * OSD bucket helpers shared by sync_revenue_osd_from_crm.js.
 * Labels and keys are the contract for data/osd_summary.json and rem/osd.html.
 */

const CLASS_ORDER = ['DOM', 'COM', 'IND', 'Others'];
const SUPPLY_ORDER = ['live', 'deemed', 'temp', 'other'];
const VALUE_ORDER = ['lt5k', '5k_10k', '10k_25k', '25k_50k', '50k_1l', '1l_plus'];
const AGING_ORDER = ['d0_90', 'd90_180', 'd180_365', 'y1_plus', 'never'];

const LABELS = {
  class: { DOM: 'Domestic', COM: 'Commercial', IND: 'Industrial', Others: 'Others' },
  supply: {
    live: 'Live',
    deemed: 'Deemed disconnection',
    temp: 'Temporary disconnection',
    other: 'Other / unknown'
  },
  value: {
    lt5k: 'Below ₹5,000',
    '5k_10k': '₹5,000 – ₹10,000',
    '10k_25k': '₹10,000 – ₹25,000',
    '25k_50k': '₹25,000 – ₹50,000',
    '50k_1l': '₹50,000 – ₹1 Lakh',
    '1l_plus': '₹1 Lakh and above'
  },
  aging: {
    d0_90: 'Paid within 90 days',
    d90_180: 'Not paid 90–180 days',
    d180_365: 'Not paid 180–365 days',
    y1_plus: 'Not paid over 1 year',
    never: 'Never / unknown'
  }
};

/** REM floor. The report also leaves out Government and Agriculture (OSD above this amount). */
const REM_OSD_MIN = 5000;

/**
 * Map raw CON_STATUS text → supply bucket.
 * Extend on the office network once distinct DB2 values are known.
 */
const SUPPLY_MAP = [
  { re: /\b(live|energised|energized|active|in\s*service)\b/i, key: 'live' },
  { re: /\b(deemed|pd\b|permanent\s*discon|permanently\s*discon)/i, key: 'deemed' },
  { re: /\b(temp|td\b|temporary\s*discon|tempo)/i, key: 'temp' },
  { re: /\b(discon|disconnected)\b/i, key: 'temp' }
];

function parseAmount(val) {
  if (val == null || val === '') return 0;
  const num = parseFloat(String(val).replace(/,/g, '').trim());
  return Number.isFinite(num) ? num : 0;
}

function classBucket(classDesc) {
  const u = String(classDesc || '').toUpperCase();
  if (/\bDOM|\bDOMESTIC|\bLT\s*DOM|\bDS\b/.test(u) || u.includes('DOMESTIC')) return 'DOM';
  if (/\bCOM|\bCOMMERCIAL|\bLT\s*COM/.test(u) || u.includes('COMMERCIAL')) return 'COM';
  if (/\bIND|\bINDUSTRIAL|\bLT\s*IND|\bHT\b/.test(u) || u.includes('INDUSTRIAL')) return 'IND';
  return 'Others';
}

function supplyBucket(conStatus) {
  const raw = String(conStatus || '').trim();
  if (!raw) return 'other';
  for (const rule of SUPPLY_MAP) {
    if (rule.re.test(raw)) return rule.key;
  }
  return 'other';
}

function valueBand(osd) {
  const n = Number(osd) || 0;
  if (n < 5000) return 'lt5k';
  if (n < 10000) return '5k_10k';
  if (n < 25000) return '10k_25k';
  if (n < 50000) return '25k_50k';
  if (n < 100000) return '50k_1l';
  return '1l_plus';
}

/** Parse paid dates from DB2 / sheet forms: dd.mm.yyyy, dd/mm/yyyy, yyyy-mm-dd, yyyymmdd. */
function parsePaidDate(val) {
  const s = String(val || '').trim();
  if (!s || s === '0' || /^#n\/?a$/i.test(s)) return null;
  let m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (m) {
    const d = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    let y = parseInt(m[3], 10);
    if (m[3].length === 2) y = (y > 50 ? 1900 : 2000) + y;
    if (y >= 1990 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return new Date(y, mo - 1, d);
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  m = s.match(/^(\d{8})$/);
  if (m) {
    const y = parseInt(s.slice(0, 4), 10);
    const mo = parseInt(s.slice(4, 6), 10);
    const d = parseInt(s.slice(6, 8), 10);
    if (y >= 1990 && mo >= 1 && mo <= 12) return new Date(y, mo - 1, d);
  }
  return null;
}

function agingBucket(paidDateVal, asOf = new Date()) {
  const dt = parsePaidDate(paidDateVal);
  if (!dt) return 'never';
  const days = Math.floor((asOf.getTime() - dt.getTime()) / 86400000);
  if (days < 0) return 'd0_90';
  if (days <= 90) return 'd0_90';
  if (days <= 180) return 'd90_180';
  if (days <= 365) return 'd180_365';
  return 'y1_plus';
}

function emptyBucket(keys) {
  const out = {};
  keys.forEach((k) => { out[k] = { key: k, consumers: 0, osd: 0 }; });
  return out;
}

function toList(map, order, labelGroup) {
  return order.map((key) => ({
    key,
    label: (LABELS[labelGroup] && LABELS[labelGroup][key]) || key,
    consumers: map[key].consumers,
    osd: Math.round(map[key].osd)
  }));
}

const DIV_BY_PREFIX = {
  6611: { region: 'Malda', division: 'Malda' },
  6612: { region: 'Malda', division: 'Chanchal' },
  6613: { region: 'Malda', division: 'Gazole' },
  6621: { region: 'Raiganj', division: 'Raiganj' },
  6622: { region: 'Raiganj', division: 'Islampur' },
  6631: { region: 'Balurghat', division: 'Balurghat' },
  6632: { region: 'Balurghat', division: 'Buniadpur' },
  6610: { region: 'Malda', division: 'Zonal / HQ' }
};

function officeFromCcc(cccCode) {
  const code = String(cccCode || '').trim();
  const prefix = code.slice(0, 4);
  const hit = DIV_BY_PREFIX[prefix] || { region: 'Other', division: 'Other' };
  return { region: hit.region, division: hit.division, cccCode: code };
}

module.exports = {
  CLASS_ORDER,
  SUPPLY_ORDER,
  VALUE_ORDER,
  AGING_ORDER,
  LABELS,
  REM_OSD_MIN,
  SUPPLY_MAP,
  parseAmount,
  DIV_BY_PREFIX,
  classBucket,
  supplyBucket,
  valueBand,
  parsePaidDate,
  agingBucket,
  emptyBucket,
  toList,
  officeFromCcc
};
