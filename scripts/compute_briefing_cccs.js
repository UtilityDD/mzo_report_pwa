const fs = require('fs');

const CCC_MAP = {
  // Malda Division (6611)
  '6611101': 'Manikchak',
  '6611102': 'Golapganj',
  '6611103': 'Baishnabnagar',
  '6611104': 'Kaliachak',
  '6611105': 'Mothabari',
  '6611106': 'Sujapur',
  '6611107': 'Rathbari',
  '6611108': 'Fulbari',
  '6611109': 'Mokdumpur',
  // Chanchal Division (6612)
  '6612101': 'Bhaluka',
  '6612102': 'Samsi',
  '6612103': 'Paranpur',
  '6612104': 'Chanchal',
  '6612105': 'Malatipur',
  '6612106': 'Harishchandrapur',
  '6612107': 'Kushida',
  // Gazole Division (6613)
  '6613101': 'Gazol',
  '6613102': 'Aiho',
  '6613103': 'Pandua',
  '6613104': 'Bamongola',
  '6613105': 'Old Malda',
  // Raiganj Division (6621)
  '6621101': 'Itahar',
  '6621102': 'Hemtabad',
  '6621103': 'Kaliyaganj',
  '6621104': 'Raiganj',
  '6621105': 'Birnagar',
  '6621106': 'Karandighi',
  // Islampur Division (6622)
  '6622101': 'Islampur',
  '6622102': 'Chopra',
  '6622103': 'Dalkhola',
  '6622104': 'Goalpokher',
  '6622105': 'Kanki',
  // Balurghat Division (6631)
  '6631101': 'Balurghat',
  '6631102': 'Tapan',
  '6631103': 'Kumarganj',
  '6631104': 'Hili',
  '6631105': 'Patiram',
  // Buniadpur Division (6632)
  '6632101': 'Buniadpur',
  '6632102': 'Kusmandi',
  '6632103': 'Harirampur',
  '6632104': 'Gangarampur'
};

const PREFIX_DIV = {
  '6611': 'Malda',
  '6612': 'Chanchal',
  '6613': 'Gazole',
  '6621': 'Raiganj',
  '6622': 'Islampur',
  '6631': 'Balurghat',
  '6632': 'Buniadpur'
};

function parseCsvLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur.trim());
  return result;
}

const VALID_DIVISIONS = ['Malda', 'Chanchal', 'Gazole', 'Raiganj', 'Islampur', 'Balurghat', 'Buniadpur'];

function normalizeDivName(d) {
  if (!d) return '';
  const s = String(d).trim().replace(/\s+division$/i, '');
  for (const v of VALID_DIVISIONS) {
    if (v.toLowerCase() === s.toLowerCase()) return v;
  }
  return '';
}

async function run() {
  console.log('Calculating accurate CCC hotspots for all divisions...');

  // 1. Pending MC
  try {
    const mcMeta = JSON.parse(fs.readFileSync('data/pending_mc_meta.json'));
    const res = await fetch(mcMeta.csvUrl);
    const csv = await res.text();
    const lines = csv.split('\n').filter(l => l.trim().length > 0);
    const headers = parseCsvLine(lines[0]);
    const divIdx = headers.indexOf('Division');
    const cccIdx = headers.indexOf('CCC');

    const mcCccs = {};
    for (let i = 1; i < lines.length; i++) {
      const parts = parseCsvLine(lines[i]);
      const div = normalizeDivName(parts[divIdx]);
      const ccc = parts[cccIdx];
      if (!div || !ccc) continue;
      if (!mcCccs[div]) mcCccs[div] = {};
      mcCccs[div][ccc] = (mcCccs[div][ccc] || 0) + 1;
    }

    const mcFormatted = {};
    for (const [div, cccs] of Object.entries(mcCccs)) {
      mcFormatted[div] = Object.entries(cccs)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
    }
    mcMeta.stats.divisionCccs = mcFormatted;
    fs.writeFileSync('data/pending_mc_meta.json', JSON.stringify(mcMeta, null, 2));
    console.log('Updated pending_mc_meta.json with divisionCccs');
  } catch (e) {
    console.error('Pending MC error:', e.message);
  }

  // 2. Load Extension
  try {
    const loadMeta = JSON.parse(fs.readFileSync('data/load_ext_meta.json'));
    const res = await fetch(loadMeta.csvUrl);
    const csv = await res.text();
    const lines = csv.split('\n').filter(l => l.trim().length > 0);
    const headers = parseCsvLine(lines[0]);
    const cccIdx = headers.indexOf('CCC CODE');
    const ageIdx = headers.indexOf('AGE_MONTHS');

    const loadCccs = {};
    for (let i = 1; i < lines.length; i++) {
      const parts = parseCsvLine(lines[i]);
      const code = parts[cccIdx];
      if (!code) continue;
      const prefix = code.slice(0, 4);
      const div = PREFIX_DIV[prefix];
      if (!div) continue;
      const cccName = CCC_MAP[code] || `CCC ${code}`;

      if (!loadCccs[div]) loadCccs[div] = {};
      if (!loadCccs[div][cccName]) loadCccs[div][cccName] = { total: 0, ageing1y: 0 };
      loadCccs[div][cccName].total++;
      const ageVal = parseInt(parts[ageIdx], 10) || 0;
      if (ageVal > 12) {
        loadCccs[div][cccName].ageing1y++;
      }
    }

    const loadFormatted = {};
    for (const [div, cccs] of Object.entries(loadCccs)) {
      loadFormatted[div] = Object.entries(cccs)
        .map(([name, stat]) => ({ name, count: stat.ageing1y || stat.total, total: stat.total }))
        .sort((a, b) => b.count - a.count);
    }
    loadMeta.stats.divisionCccs = loadFormatted;
    fs.writeFileSync('data/load_ext_meta.json', JSON.stringify(loadMeta, null, 2));
    console.log('Updated load_ext_meta.json with divisionCccs');
  } catch (e) {
    console.error('Load Ext error:', e.message);
  }

  // 3. Disconnection
  try {
    const disconMeta = JSON.parse(fs.readFileSync('data/disconnection_meta.json'));
    const res = await fetch(disconMeta.csvUrl);
    const csv = await res.text();
    const lines = csv.split('\n').filter(l => l.trim().length > 0);
    const headers = parseCsvLine(lines[0]);
    const cccIdx = headers.indexOf('CCC_CODE');
    const notosdIdx = headers.indexOf('NOTOSD');
    const paidDisconIdx = headers.indexOf('PAID/DISCON DATE');

    const disconCccs = {};
    for (let i = 1; i < lines.length; i++) {
      const parts = parseCsvLine(lines[i]);
      const code = (parts[cccIdx] || '').trim();
      if (!code) continue;
      const prefix = code.slice(0, 4);
      const div = PREFIX_DIV[prefix];
      if (!div) continue;
      const cccName = CCC_MAP[code] || `CCC ${code}`;

      const osd = parseFloat(parts[notosdIdx]) || 0;
      const dateStr = (parts[paidDisconIdx] || '').trim();
      const hasDate = dateStr !== '' && dateStr.toLowerCase() !== '#n/a' && dateStr !== '0';

      if (!disconCccs[div]) disconCccs[div] = {};
      if (!disconCccs[div][cccName]) disconCccs[div][cccName] = { noActionCount: 0, totalOsd: 0 };
      if (!hasDate) {
        disconCccs[div][cccName].noActionCount++;
        disconCccs[div][cccName].totalOsd += osd;
      }
    }

    const disconFormatted = {};
    for (const [div, cccs] of Object.entries(disconCccs)) {
      disconFormatted[div] = Object.entries(cccs)
        .map(([name, stat]) => ({
          name,
          count: stat.noActionCount,
          amountCr: (stat.totalOsd / 10000000).toFixed(2)
        }))
        .sort((a, b) => b.count - a.count);
    }
    disconMeta.stats.divisionCccs = disconFormatted;
    fs.writeFileSync('data/disconnection_meta.json', JSON.stringify(disconMeta, null, 2));
    console.log('Updated disconnection_meta.json with divisionCccs');
  } catch (e) {
    console.error('Disconnection error:', e.message);
  }

  // 4. Defective Meter (from summaryCsvUrl)
  try {
    const defMeta = JSON.parse(fs.readFileSync('data/defective_meta.json'));
    const res = await fetch(defMeta.summaryCsvUrl);
    const csv = await res.text();
    const lines = csv.split('\n').filter(l => l.trim().length > 0);
    const headers = parseCsvLine(lines[0]);
    const codeIdx = headers.indexOf('CCC_CODE');
    const divIdx = headers.indexOf('DIVISION');
    const over10Idx = headers.indexOf('over10');
    const ph3Idx = headers.indexOf('ph3');
    const totalIdx = headers.indexOf('total');

    const defCccs = {};
    for (let i = 1; i < lines.length; i++) {
      const parts = parseCsvLine(lines[i]);
      const code = parts[codeIdx];
      const divRaw = parts[divIdx];
      const div = normalizeDivName(divRaw);
      if (!div) continue;
      const cccName = CCC_MAP[code] || `CCC ${code}`;

      if (!defCccs[div]) defCccs[div] = {};
      if (!defCccs[div][cccName]) defCccs[div][cccName] = { over10: 0, ph3: 0, total: 0 };

      defCccs[div][cccName].over10 += parseInt(parts[over10Idx], 10) || 0;
      defCccs[div][cccName].ph3 += parseInt(parts[ph3Idx], 10) || 0;
      defCccs[div][cccName].total += parseInt(parts[totalIdx], 10) || 0;
    }

    const defFormatted = {};
    for (const [div, cccs] of Object.entries(defCccs)) {
      defFormatted[div] = Object.entries(cccs)
        .map(([name, stat]) => ({
          name,
          over10: stat.over10,
          ph3: stat.ph3,
          count: stat.over10, // default count is over10
          total: stat.total
        }))
        .sort((a, b) => b.over10 - a.over10);
    }
    defMeta.stats.divisionCccs = defFormatted;
    fs.writeFileSync('data/defective_meta.json', JSON.stringify(defMeta, null, 2));
    console.log('Updated defective_meta.json with divisionCccs');
  } catch (e) {
    console.error('Defective error:', e.message);
  }

  // 5. Pending NSC Delayed > 30 Days (from data/nsc.csv)
  try {
    const nscMetaPath = 'data/nsc_meta.json';
    const nscCsvPath = 'data/nsc.csv';
    if (fs.existsSync(nscMetaPath) && fs.existsSync(nscCsvPath)) {
      const nscMeta = JSON.parse(fs.readFileSync(nscMetaPath, 'utf8'));
      const csv = fs.readFileSync(nscCsvPath, 'utf8');
      const lines = csv.split('\n').filter(l => l.trim().length > 0);
      const headers = parseCsvLine(lines[0]);
      const divIdx = headers.indexOf('DIVN_NAME');
      const cccIdx = headers.indexOf('SUPP_OFF');
      const delayIdx = headers.indexOf('DelayInSC');

      let totalPending = 0;
      let totalOver30 = 0;
      const nscDivs = { Malda: 0, Chanchal: 0, Gazole: 0, Raiganj: 0, Islampur: 0, Balurghat: 0, Buniadpur: 0 };
      const nscCccs = {};

      for (let i = 1; i < lines.length; i++) {
        const parts = parseCsvLine(lines[i]);
        const divRaw = parts[divIdx];
        const div = normalizeDivName(divRaw);
        const ccc = parts[cccIdx];
        const delay = parseFloat(parts[delayIdx]) || 0;
        if (!div) continue;
        totalPending++;
        if (delay > 30) {
          totalOver30++;
          nscDivs[div] = (nscDivs[div] || 0) + 1;
          if (!nscCccs[div]) nscCccs[div] = {};
          nscCccs[div][ccc] = (nscCccs[div][ccc] || 0) + 1;
        }
      }

      const nscFormatted = {};
      for (const [div, cccs] of Object.entries(nscCccs)) {
        nscFormatted[div] = Object.entries(cccs)
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count);
      }

      if (!nscMeta.stats) nscMeta.stats = {};
      nscMeta.stats.totalPending = totalPending;
      nscMeta.stats.delayed30 = totalOver30;
      nscMeta.stats.divisions = nscDivs;
      nscMeta.stats.divisionCccs = nscFormatted;

      fs.writeFileSync(nscMetaPath, JSON.stringify(nscMeta, null, 2));
      console.log(`Updated nsc_meta.json with delayed30 (${totalOver30}) and divisionCccs`);
    }
  } catch (e) {
    console.error('NSC Delayed > 30 Days error:', e.message);
  }

  console.log('All division CCC computations finished successfully.');
}

run();
