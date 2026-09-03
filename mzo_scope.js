/**
 * MZO authorization scope — client-only.
 * Admins set zone/region/division/ccc (and optional nsc-autho codes) on portal_users.
 * Reports already download cached data; this module filters in the browser so Vercel
 * serverless functions are not asked to slice large CSVs.
 */
(function (global) {
  'use strict';

  const REGION_KEYS = ['_region', 'REGION', 'Region', 'region', 'REG', 'Region Name', 'regionName', 'REGION_NAME', 'REGION NAME', 'REGION_NORM'];
  const DIV_KEYS = ['_divn', 'DIVN_NAME', 'DIVN', 'Division', 'division', 'DIVISION', 'Division Name', 'divisionName', 'DIVN_NAME_1', 'DIVISION_NORM'];
  const CCC_KEYS = ['_supp', 'SUPP_OFF', 'CCC', 'ccc', 'Ccc', 'CCC name', 'CCC NAME', 'UNIT_NAME', 'cccName', 'Office', 'SUPPORT', 'Support Office', 'CCC_NORM'];
  const CODE_KEYS = ['CCC_CODE', 'ccc_code', 'cccCode', 'CCC Code', 'CCC CODE', 'Divn_code', 'OFFICE_CODE', 'code', 'Cost Center', 'COST CENTER'];

  const REGION_IDS = ['regionFilter', 'regionSelect', 'regionSelectDrawer', 'locationFilter', 'region', 'region-filter'];
  const DIV_IDS = ['divisionFilter', 'divisionSelect', 'divnSelect', 'divnSelectDrawer', 'division', 'division-filter'];
  const CCC_IDS = ['cccFilter', 'cccSelect', 'unitFilter', 'suppSelect', 'suppSelectDrawer', 'support', 'ccc-filter', 'ccc-select'];

  const HIERARCHY = {
    Malda: {
      aliases: ['malda', 'malda region'],
      prefix: '661',
      divisions: {
        Malda: { prefix: '6611', cccs: ['Manikchak', 'Golapganj', 'Baishnabnagar', 'Kaliachak', 'Mothabari', 'Sujapur', 'Rathbari', 'Fulbari', 'Mokdumpur'] },
        Chanchal: { prefix: '6612', cccs: ['Bhaluka', 'Samsi', 'Paranpur', 'Chanchal', 'Malatipur', 'Harishchandrapur', 'Kushida'] },
        Gazole: { prefix: '6613', cccs: ['Gazole', 'Gazol', 'Aiho', 'Pandua', 'Bamongola', 'Old Malda'] }
      }
    },
    Raiganj: {
      aliases: ['raiganj', 'uttar dinajpur', 'u/dinajpur', 'ud', 'u/d', 'uttar dinajpur region', 'u/dinajpur region', 'u_dinajpur'],
      prefix: '662',
      divisions: {
        Raiganj: { prefix: '6621', cccs: ['Itahar', 'Hemtabad', 'Kaliyaganj', 'Raiganj', 'Birnagar', 'Karandighi'] },
        Islampur: { prefix: '6622', cccs: ['Islampur', 'Chopra', 'Dalkhola', 'Goalpokher', 'Kanki'] }
      }
    },
    Balurghat: {
      aliases: ['balurghat', 'dakshin dinajpur', 'd/dinajpur', 'dd', 'd/d', 'dakshin dinajpur region', 'd/dinajpur region', 'd_dinajpur'],
      prefix: '663',
      divisions: {
        Balurghat: { prefix: '6631', cccs: ['Balurghat', 'Tapan', 'Kumarganj', 'Hili', 'Patiram'] },
        Buniadpur: { prefix: '6632', cccs: ['Buniadpur', 'Kusmandi', 'Harirampur', 'Gangarampur'] }
      }
    }
  };

  const CODE_TO_CCC = {
    '6611101': 'Manikchak', '6611102': 'Golapganj', '6611103': 'Baishnabnagar',
    '6611104': 'Kaliachak', '6611105': 'Mothabari', '6611106': 'Sujapur',
    '6611107': 'Rathbari', '6611108': 'Fulbari', '6611109': 'Mokdumpur',
    '6612101': 'Bhaluka', '6612102': 'Samsi', '6612103': 'Paranpur',
    '6612104': 'Chanchal', '6612105': 'Malatipur', '6612106': 'Harishchandrapur',
    '6612107': 'Kushida',
    '6613101': 'Gazole', '6613102': 'Aiho', '6613103': 'Pandua',
    '6613104': 'Bamongola', '6613105': 'Old Malda',
    '6621101': 'Itahar', '6621102': 'Hemtabad', '6621103': 'Kaliyaganj',
    '6621104': 'Raiganj', '6621105': 'Birnagar', '6621106': 'Karandighi',
    '6622101': 'Islampur', '6622102': 'Chopra', '6622103': 'Dalkhola',
    '6622104': 'Goalpokher', '6622105': 'Kanki',
    '6631101': 'Balurghat', '6631102': 'Tapan', '6631103': 'Kumarganj',
    '6631104': 'Hili', '6631105': 'Patiram',
    '6632101': 'Buniadpur', '6632102': 'Kusmandi', '6632103': 'Harirampur',
    '6632104': 'Gangarampur'
  };

  const CODE_TO_DIV = {
    '6611101': 'Malda', '6611102': 'Malda', '6611103': 'Malda', '6611104': 'Malda', '6611105': 'Malda',
    '6611106': 'Malda', '6611107': 'Malda', '6611108': 'Malda', '6611109': 'Malda',
    '6612101': 'Chanchal', '6612102': 'Chanchal', '6612103': 'Chanchal', '6612104': 'Chanchal',
    '6612105': 'Chanchal', '6612106': 'Chanchal', '6612107': 'Chanchal',
    '6613101': 'Gazole', '6613102': 'Gazole', '6613103': 'Gazole', '6613104': 'Gazole', '6613105': 'Gazole',
    '6621101': 'Raiganj', '6621102': 'Raiganj', '6621103': 'Raiganj', '6621104': 'Raiganj',
    '6621105': 'Raiganj', '6621106': 'Raiganj',
    '6622101': 'Islampur', '6622102': 'Islampur', '6622103': 'Islampur', '6622104': 'Islampur', '6622105': 'Islampur',
    '6631101': 'Balurghat', '6631102': 'Balurghat', '6631103': 'Balurghat', '6631104': 'Balurghat', '6631105': 'Balurghat',
    '6632101': 'Buniadpur', '6632102': 'Buniadpur', '6632103': 'Buniadpur', '6632104': 'Buniadpur'
  };

  let _cachedScope = null;
  let _cachedKey = '';

  function norm(v) {
    return String(v == null ? '' : v)
      .toLowerCase()
      .replace(/region|division|divn|ccc/g, ' ')
      .replace(/[^a-z0-9/]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normKey(k) {
    return String(k == null ? '' : k)
      .replace(/^\uFEFF/, '')
      .toLowerCase()
      .replace(/[\s_\-]+/g, ' ')
      .trim();
  }

  function pickField(row, keys) {
    if (!row || typeof row !== 'object') return '';
    for (let i = 0; i < keys.length; i++) {
      const v = row[keys[i]];
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
    const wanted = {};
    for (let i = 0; i < keys.length; i++) wanted[normKey(keys[i])] = true;
    const rowKeys = Object.keys(row);
    for (let i = 0; i < rowKeys.length; i++) {
      if (!wanted[normKey(rowKeys[i])]) continue;
      const v = row[rowKeys[i]];
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  }

  /** WBSEDCL office codes: 6611108, C36611108, C366111050 → 6611105 */
  function extractOfficeCodes(raw) {
    const s = String(raw == null ? '' : raw);
    const out = [];
    const re = /66[123]\d{4}/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      if (out.indexOf(m[0]) === -1) out.push(m[0]);
    }
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 7) {
      const last7 = digits.slice(-7);
      if (/^66[123]\d{4}$/.test(last7) && out.indexOf(last7) === -1) out.push(last7);
    }
    return out;
  }

  function collectCodes(row) {
    if (!row || typeof row !== 'object') return [];
    const codes = [];
    const seen = {};
    function add(v) {
      extractOfficeCodes(v).forEach(function (c) {
        if (!seen[c]) {
          seen[c] = 1;
          codes.push(c);
        }
      });
    }
    const wanted = {};
    for (let i = 0; i < CODE_KEYS.length; i++) wanted[normKey(CODE_KEYS[i])] = true;
    const rowKeys = Object.keys(row);
    for (let i = 0; i < rowKeys.length; i++) {
      const nk = normKey(rowKeys[i]);
      if (wanted[nk] || /(^| )(code|ccc|cost center)($| )/.test(nk)) {
        add(row[rowKeys[i]]);
      }
    }
    add(pickField(row, CCC_KEYS));
    return codes;
  }

  function regionNameOf(raw) {
    const n = norm(raw);
    if (!n) return '';
    const keys = Object.keys(HIERARCHY);
    for (let i = 0; i < keys.length; i++) {
      const name = keys[i];
      const aliases = HIERARCHY[name].aliases;
      if (n === norm(name) || aliases.indexOf(n) !== -1) return name;
      for (let a = 0; a < aliases.length; a++) {
        if (n.indexOf(aliases[a]) !== -1 || aliases[a].indexOf(n) !== -1) return name;
      }
    }
    return '';
  }

  function divisionNameOf(raw) {
    if (!raw) return '';
    const s = String(raw).trim();
    if (CODE_TO_DIV[s]) return CODE_TO_DIV[s];
    if (/^\d{4}$/.test(s)) {
      const regions = Object.keys(HIERARCHY);
      for (let r = 0; r < regions.length; r++) {
        const divs = Object.keys(HIERARCHY[regions[r]].divisions);
        for (let d = 0; d < divs.length; d++) {
          if (HIERARCHY[regions[r]].divisions[divs[d]].prefix === s) return divs[d];
        }
      }
    }
    const n = norm(raw);
    if (!n) return '';
    const regions = Object.keys(HIERARCHY);
    for (let r = 0; r < regions.length; r++) {
      const divs = Object.keys(HIERARCHY[regions[r]].divisions);
      for (let d = 0; d < divs.length; d++) {
        if (n === norm(divs[d]) || n.indexOf(norm(divs[d])) !== -1 || norm(divs[d]).indexOf(n) !== -1) {
          return divs[d];
        }
      }
    }
    return '';
  }

  function cccNameOf(raw) {
    if (!raw) return '';
    const s = String(raw).trim();
    if (CODE_TO_CCC[s]) return CODE_TO_CCC[s];
    const n = norm(raw);
    if (!n) return '';

    if (n === 'gazole' || n === 'gazol') return 'Gazole';

    const regions = Object.keys(HIERARCHY);
    for (let r = 0; r < regions.length; r++) {
      const divs = HIERARCHY[regions[r]].divisions;
      const dnames = Object.keys(divs);
      for (let d = 0; d < dnames.length; d++) {
        const cccs = divs[dnames[d]].cccs;
        for (let c = 0; c < cccs.length; c++) {
          const cnorm = norm(cccs[c]);
          if (n === cnorm || n.indexOf(cnorm) !== -1 || (n.length >= 4 && cnorm.indexOf(n) !== -1)) {
            return cccs[c] === 'Gazol' ? 'Gazole' : cccs[c];
          }
        }
      }
    }
    return String(raw || '').trim();
  }

  function foldCcc(name) {
    return name === 'Gazol' ? 'Gazole' : name;
  }

  function cccNameInDivision(raw, divisionName) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    const division = divisionNameOf(divisionName) || divisionName;
    const list = listCccs('', division).filter(function (c) { return c !== 'Gazol'; });
    const n = norm(s);
    if (!n) return '';
    for (let i = 0; i < list.length; i++) {
      if (norm(list[i]) === n) return foldCcc(list[i]);
    }
    const prefixed = [];
    for (let i = 0; i < list.length; i++) {
      const cn = norm(list[i]);
      if (cn.indexOf(n) === 0) prefixed.push(foldCcc(list[i]));
    }
    const uniq = prefixed.filter(function (c, i, a) { return a.indexOf(c) === i; });
    if (uniq.length === 1) return uniq[0];
    const named = cccNameOf(s);
    if (named && list.some(function (c) { return foldCcc(c) === named; })) return named;
    return named || s;
  }

  function parentOfCcc(cccName) {
    const ccc = cccNameOf(cccName);
    if (!ccc) return null;
    const regions = Object.keys(HIERARCHY);
    for (let r = 0; r < regions.length; r++) {
      const dnames = Object.keys(HIERARCHY[regions[r]].divisions);
      for (let d = 0; d < dnames.length; d++) {
        if (HIERARCHY[regions[r]].divisions[dnames[d]].cccs.indexOf(ccc) !== -1) {
          return { region: regions[r], division: dnames[d], ccc: ccc };
        }
      }
    }
    return null;
  }

  function regionOfDivision(divName) {
    const regions = Object.keys(HIERARCHY);
    for (let i = 0; i < regions.length; i++) {
      if (HIERARCHY[regions[i]].divisions[divName]) return regions[i];
    }
    return '';
  }

  function getProfile() {
    try {
      return JSON.parse(global.localStorage.getItem('mzo_user_profile') || '{}') || {};
    } catch (_) {
      return {};
    }
  }

  function parseExtraCodes(profile) {
    const raw = profile['nsc-autho'] != null ? profile['nsc-autho'] : (profile.nsc_autho || '');
    return String(raw)
      .split(/[;,]/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s && !/^(all|y)$/i.test(s); });
  }

  function addRegionNorms(region, into) {
    if (!region) return;
    into.regions.add(region);
    into.regionNorms.add(norm(region));
    const node = HIERARCHY[region];
    if (node && node.aliases) {
      node.aliases.forEach(function (a) { into.regionNorms.add(a); });
    }
  }

  function addAllFromRegion(region, into) {
    const node = HIERARCHY[region];
    if (!node) return;
    addRegionNorms(region, into);
    into.prefixes.push(node.prefix);
    Object.keys(node.divisions).forEach(function (div) {
      addAllFromDivision(region, div, into);
    });
  }

  function addAllFromDivision(region, div, into) {
    const node = HIERARCHY[region] && HIERARCHY[region].divisions[div];
    if (!node) return;
    addRegionNorms(region, into);
    into.divisions.add(div);
    into.divisionNorms.add(norm(div));
    into.prefixes.push(node.prefix);
    node.cccs.forEach(function (ccc) {
      into.cccs.add(ccc);
      into.cccNorms.add(norm(ccc));
    });
  }

  function addCcc(region, div, ccc, into) {
    addRegionNorms(region, into);
    into.divisions.add(div);
    into.divisionNorms.add(norm(div));
    into.cccs.add(ccc);
    into.cccNorms.add(norm(ccc));
    Object.keys(CODE_TO_CCC).forEach(function (code) {
      if (CODE_TO_CCC[code] === ccc) into.codes.add(code);
    });
  }

  function buildScope() {
    const profile = getProfile();
    const role = String(profile.role || '').trim().toLowerCase();
    const extraCodes = parseExtraCodes(profile);
    const zone = String(profile.zone_code || '').trim();
    const regionRaw = String(profile.region_code || '').trim();
    const divRaw = String(profile.division_code || '').trim();
    const cccRaw = String(profile.ccc_code || '').trim();

    if (role === 'admin') {
      return { unscoped: true, isAdmin: true, level: 'zone', label: 'All offices', profile: profile };
    }

    const into = {
      regions: new Set(),
      divisions: new Set(),
      cccs: new Set(),
      regionNorms: new Set(),
      divisionNorms: new Set(),
      cccNorms: new Set(),
      prefixes: [],
      codes: new Set()
    };

    extraCodes.forEach(function (token) {
      if (/^\d{7}$/.test(token)) into.codes.add(token);
      const cccFromCode = CODE_TO_CCC[token];
      const named = cccNameOf(token);
      const ccc = cccFromCode || named;
      if (!ccc) return;
      const parent = parentOfCcc(ccc);
      if (parent) addCcc(parent.region, parent.division, parent.ccc, into);
    });

    const region = regionNameOf(regionRaw);
    const division = divisionNameOf(divRaw);
    // Only treat as CCC-scoped when the value is a real office, not a leftover
    // placeholder or division name (e.g. ccc_code "Malda" must not become Old Malda).
    let ccc = '';
    if (cccRaw) {
      const n = norm(cccRaw);
      if (n && !/^(all|y|none|n a|na)$/.test(n)) {
        if (CODE_TO_CCC[String(cccRaw).trim()]) {
          ccc = CODE_TO_CCC[String(cccRaw).trim()];
        } else {
          const resolved = cccNameOf(cccRaw);
          const parent = resolved ? parentOfCcc(resolved) : null;
          const cnorm = parent ? norm(parent.ccc) : '';
          if (parent && (n === cnorm || n.indexOf(cnorm) !== -1) && (!division || parent.division === division)) {
            ccc = parent.ccc;
          }
        }
      }
    }
    if (/^\d{7}$/.test(cccRaw)) {
      into.codes.add(cccRaw);
      const cccFromCode = CODE_TO_CCC[cccRaw];
      const divFromCode = CODE_TO_DIV[cccRaw];
      if (cccFromCode && divFromCode) {
        const r = regionOfDivision(divFromCode);
        if (r) addCcc(r, divFromCode, cccFromCode, into);
        if (!division || divFromCode === division) ccc = cccFromCode;
      }
    }

    let level = '';
    if (ccc && division) {
      const r = region || regionOfDivision(division);
      if (r) addCcc(r, division, ccc, into);
      level = 'ccc';
    } else if (ccc && region) {
      const divs = Object.keys(HIERARCHY[region].divisions);
      for (let i = 0; i < divs.length; i++) {
        if (HIERARCHY[region].divisions[divs[i]].cccs.indexOf(ccc) !== -1) {
          addCcc(region, divs[i], ccc, into);
          break;
        }
      }
      level = 'ccc';
    } else if (division) {
      addAllFromDivision(region || regionOfDivision(division), division, into);
      level = 'division';
    } else if (ccc) {
      const parent = parentOfCcc(ccc);
      if (parent) {
        addCcc(parent.region, parent.division, parent.ccc, into);
        level = 'ccc';
      }
    } else if (region) {
      addAllFromRegion(region, into);
      level = 'region';
    } else if (extraCodes.length) {
      level = into.cccs.size <= 1 ? 'ccc' : 'codes';
    } else if (zone) {
      return { unscoped: true, isAdmin: false, level: 'zone', label: zone + ' (all offices)', profile: profile };
    } else {
      return { unscoped: true, isAdmin: false, level: 'zone', label: 'All offices', profile: profile };
    }

    if (ccc && level === 'division') level = 'ccc';
    if (ccc) level = 'ccc';
    else if (division) level = 'division';
    else if (region) level = 'region';

    const regionLabel = into.regions.size === 1 ? Array.from(into.regions)[0] + ' Region' : '';
    const divLabel = into.divisions.size === 1 ? Array.from(into.divisions)[0] + ' Division' : '';
    const cccLabel = (level === 'ccc' && into.cccs.size === 1) ? Array.from(into.cccs)[0] + ' CCC' : '';
    const label = cccLabel || divLabel || regionLabel || (extraCodes.length ? 'Assigned offices' : 'Assigned area');

    return {
      unscoped: false,
      isAdmin: false,
      level: level,
      label: label,
      region: into.regions.size === 1 ? Array.from(into.regions)[0] : '',
      division: into.divisions.size === 1 ? Array.from(into.divisions)[0] : '',
      ccc: (level === 'ccc' && into.cccs.size === 1) ? Array.from(into.cccs)[0] : '',
      regions: into.regions,
      divisions: into.divisions,
      cccs: into.cccs,
      regionNorms: into.regionNorms,
      divisionNorms: into.divisionNorms,
      cccNorms: into.cccNorms,
      prefixes: into.prefixes.filter(Boolean),
      codes: into.codes,
      profile: profile
    };
  }

  function getScope() {
    const profile = getProfile();
    const key = [
      profile.role, profile.zone_code, profile.region_code, profile.division_code,
      profile.ccc_code, profile['nsc-autho'] || profile.nsc_autho
    ].join('|');
    if (_cachedScope && _cachedKey === key) return _cachedScope;
    _cachedKey = key;
    _cachedScope = buildScope();
    return _cachedScope;
  }

  function inSetNorm(value, set) {
    if (!value || !set || !set.size) return false;
    const n = norm(value);
    if (set.has(n)) return true;
    const arr = Array.from(set);
    for (let i = 0; i < arr.length; i++) {
      if (n.indexOf(arr[i]) !== -1 || arr[i].indexOf(n) !== -1) return true;
    }
    return false;
  }

  function matchRow(row) {
    const scope = getScope();
    if (!scope || scope.unscoped) return true;
    if (!row || typeof row !== 'object') return true;

    const region = pickField(row, REGION_KEYS);
    const div = pickField(row, DIV_KEYS);
    const ccc = pickField(row, CCC_KEYS);
    const codes = collectCodes(row);

    if (!region && !div && !ccc && !codes.length) return true;

    for (let i = 0; i < codes.length; i++) {
      const rawCode = codes[i];
      if (scope.codes.has(rawCode)) return true;
      const named = CODE_TO_CCC[rawCode];
      if (named && inSetNorm(named, scope.cccNorms)) return true;
      for (let p = 0; p < scope.prefixes.length; p++) {
        if (rawCode.indexOf(scope.prefixes[p]) === 0) return true;
      }
    }

    if (scope.level === 'ccc') {
      if (inSetNorm(ccc, scope.cccNorms)) return true;
      return false;
    }
    if (scope.level === 'division' || scope.level === 'codes') {
      if (inSetNorm(div, scope.divisionNorms)) return true;
      if (inSetNorm(ccc, scope.cccNorms)) return true;
      return false;
    }
    if (scope.level === 'region') {
      if (inSetNorm(region, scope.regionNorms)) return true;
      if (inSetNorm(div, scope.divisionNorms)) return true;
      if (inSetNorm(ccc, scope.cccNorms)) return true;
    }
    return false;
  }

  function filterRows(rows) {
    if (!Array.isArray(rows)) return rows;
    const scope = getScope();
    if (!scope || scope.unscoped) return rows;
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      if (matchRow(rows[i])) out.push(rows[i]);
    }
    return out;
  }

  function findEls(ids) {
    const seen = [];
    ids.forEach(function (id) {
      document.querySelectorAll('[id="' + id + '"], [data-filter-key="' + id + '"]').forEach(function (el) {
        if (el && seen.indexOf(el) === -1) seen.push(el);
      });
    });
    return seen;
  }

  function nameInNorms(n, wantedNorms) {
    if (!n || n === 'all') return false;
    const arr = Array.from(wantedNorms || []);
    for (let i = 0; i < arr.length; i++) {
      if (n === arr[i] || n.indexOf(arr[i]) !== -1 || arr[i].indexOf(n) !== -1) return true;
    }
    return false;
  }

  function optionMatches(optVal, wantedNorms) {
    const raw = String(optVal == null ? '' : optVal).trim();
    if (!raw) return false;
    if (nameInNorms(norm(raw), wantedNorms)) return true;
    const fromCode = CODE_TO_CCC[raw] || '';
    if (fromCode && nameInNorms(norm(fromCode), wantedNorms)) return true;
    const codes = extractOfficeCodes(raw);
    for (let i = 0; i < codes.length; i++) {
      const named = CODE_TO_CCC[codes[i]];
      if (named && nameInNorms(norm(named), wantedNorms)) return true;
    }
    return false;
  }

  function pruneAndLock(els, wantedNorms, lock) {
    if (!els.length) return;
    els.forEach(function (el) {
      if (!el || !el.options) return;
      const prevVal = String(el.value || '');
      const keep = [];
      for (let i = 0; i < el.options.length; i++) {
        const opt = el.options[i];
        const val = opt.value;
        const vlow = String(val || '').trim().toLowerCase();
        if (!val || vlow === 'all' || /^select /i.test(String(opt.textContent || '').trim())) {
          if (!lock) keep.push(opt);
          continue;
        }
        if (optionMatches(val, wantedNorms) || optionMatches(opt.textContent, wantedNorms)) keep.push(opt);
      }
      if (!keep.length && lock) {
        for (let i = 0; i < el.options.length; i++) {
          const opt = el.options[i];
          const val = opt.value;
          const vlow = String(val || '').trim().toLowerCase();
          if (val && vlow !== 'all' && !/^select /i.test(String(opt.textContent || '').trim())) keep.push(opt);
        }
      }
      if (keep.length) {
        el.innerHTML = '';
        keep.forEach(function (opt) { el.appendChild(opt); });
        if (lock) {
          el.selectedIndex = 0;
          if (el.options[0]) el.options[0].selected = true;
        } else {
          let idx = -1;
          for (let i = 0; i < el.options.length; i++) {
            if (String(el.options[i].value || '') === prevVal) {
              idx = i;
              break;
            }
          }
          if (idx < 0) idx = 0;
          el.selectedIndex = idx;
          if (el.options[idx]) el.options[idx].selected = true;
        }
      }
      if (lock) {
        el.classList.add('mzo-filter-locked');
        el.setAttribute('aria-disabled', 'true');
        el.disabled = true;
      } else {
        el.classList.remove('mzo-filter-locked');
        el.removeAttribute('aria-disabled');
        el.disabled = false;
      }
    });
  }

  function lockFilters() {
    const scope = getScope();
    if (!scope || scope.unscoped) return;
    const regionEls = findEls(REGION_IDS);
    const divEls = findEls(DIV_IDS);
    const cccEls = findEls(CCC_IDS);

    if (scope.level === 'codes') {
      pruneAndLock(regionEls, scope.regionNorms, scope.regions.size === 1);
      pruneAndLock(divEls, scope.divisionNorms, scope.divisions.size === 1);
      pruneAndLock(cccEls, scope.cccNorms, false);
      return;
    }
    if (scope.level === 'region' || scope.level === 'division' || scope.level === 'ccc') {
      pruneAndLock(regionEls, scope.regionNorms, true);
    }
    if (scope.level === 'division' || scope.level === 'ccc') {
      pruneAndLock(divEls, scope.divisionNorms, true);
    }
    if (scope.level === 'ccc') {
      pruneAndLock(cccEls, scope.cccNorms, true);
    } else if (scope.level === 'division' || scope.level === 'region') {
      pruneAndLock(cccEls, scope.cccNorms, false);
    }
  }

  function isFilterLocked(filterId) {
    const scope = getScope();
    if (!scope || scope.unscoped) return false;
    const id = String(filterId || '').replace(/Drawer$/, '');
    if (id === 'regionSelect' || id === 'regionFilter' || id === 'region' || id === 'region-filter' || id === 'locationFilter') {
      return scope.level === 'region' || scope.level === 'division' || scope.level === 'ccc' ||
        (scope.level === 'codes' && scope.regions && scope.regions.size === 1);
    }
    if (id === 'divnSelect' || id === 'divisionSelect' || id === 'divisionFilter' || id === 'division' || id === 'division-filter') {
      return scope.level === 'division' || scope.level === 'ccc' ||
        (scope.level === 'codes' && scope.divisions && scope.divisions.size === 1);
    }
    if (id === 'suppSelect' || id === 'cccSelect' || id === 'cccFilter' || id === 'unitFilter' || id === 'ccc-filter' || id === 'ccc-select') {
      return scope.level === 'ccc';
    }
    return false;
  }

  function mountBanner() {
    const scope = getScope();
    if (!scope || scope.unscoped) return;
    if (document.getElementById('mzo-scope-banner')) return;
    const bar = document.createElement('div');
    bar.id = 'mzo-scope-banner';
    bar.style.cssText = [
      'font-size:12px',
      'line-height:1.3',
      'padding:6px 12px',
      'background:rgba(79,70,229,0.12)',
      'color:#3730a3',
      'border-bottom:1px solid rgba(79,70,229,0.2)',
      'display:flex',
      'align-items:center',
      'gap:8px',
      'font-family:inherit'
    ].join(';');
    const label = document.createTextNode('Showing ' + scope.label + ' — set by admin');
    const icon = document.createElement('span');
    icon.textContent = '◎';
    icon.style.fontWeight = '700';
    bar.appendChild(icon);
    bar.appendChild(label);
    const header = document.querySelector('.header, .dashboard-header, header, .app-header');
    if (header && header.parentNode) {
      header.parentNode.insertBefore(bar, header.nextSibling);
    } else if (document.body) {
      document.body.insertBefore(bar, document.body.firstChild);
    }
  }

  function listRegions() {
    return Object.keys(HIERARCHY);
  }

  function listDivisions(regionName) {
    const region = regionNameOf(regionName) || regionName;
    if (region && HIERARCHY[region]) return Object.keys(HIERARCHY[region].divisions);
    const all = [];
    listRegions().forEach(function (r) {
      Object.keys(HIERARCHY[r].divisions).forEach(function (d) { all.push(d); });
    });
    return all;
  }

  function listCccs(regionName, divName) {
    const division = divisionNameOf(divName) || divName;
    const region = regionNameOf(regionName) || regionOfDivision(division) || regionName;
    if (region && division && HIERARCHY[region] && HIERARCHY[region].divisions[division]) {
      return HIERARCHY[region].divisions[division].cccs.slice();
    }
    if (division) {
      const r = regionOfDivision(division);
      if (r) return HIERARCHY[r].divisions[division].cccs.slice();
    }
    return [];
  }

  function listAllUnits() {
    const out = [];
    listRegions().forEach(function (region) {
      Object.keys(HIERARCHY[region].divisions).forEach(function (div) {
        HIERARCHY[region].divisions[div].cccs.forEach(function (name) {
          let code = '';
          Object.keys(CODE_TO_CCC).forEach(function (c) {
            if (CODE_TO_CCC[c] === name) code = c;
          });
          out.push({ name: name, division: div, region: region, code: code });
        });
      });
    });
    out.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    return out;
  }

  function unitDisplayName(token) {
    const raw = String(token == null ? '' : token).trim();
    if (!raw) return '';
    if (/^(all|y)$/i.test(raw)) return 'All units';
    if (CODE_TO_CCC[raw]) return CODE_TO_CCC[raw];
    const named = cccNameOf(raw);
    return named || raw;
  }

  const api = {
    HIERARCHY: HIERARCHY,
    getProfile: getProfile,
    getScope: getScope,
    isUnscoped: function () { return !!(getScope() || {}).unscoped; },
    matchRow: matchRow,
    filterRows: filterRows,
    lockFilters: lockFilters,
    isFilterLocked: isFilterLocked,
    mountBanner: mountBanner,
    listRegions: listRegions,
    listDivisions: listDivisions,
    listCccs: listCccs,
    listAllUnits: listAllUnits,
    unitDisplayName: unitDisplayName,
    regionNameOf: regionNameOf,
    divisionNameOf: divisionNameOf,
    cccNameOf: cccNameOf,
    cccNameInDivision: cccNameInDivision,
    parentOfCcc: parentOfCcc
  };

  global.MzoScope = api;

  function boot() {
    try { mountBanner(); } catch (_) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : this);
