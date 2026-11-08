import { formatCapacity, installedMva, isOverloaded } from '@/domain/geo';
import type { OrgUnit, Substation, TrunkLine, VoltageCode } from '@/domain/types';
import { VOLTAGE_CATALOG } from '@/domain/types';
import type { OutputScope, ReportExportKind } from '@/lib/outputNames';
import { reportCsvFilename } from '@/lib/outputNames';

export type ReportTabId =
  | 'executive'
  | 'dossier'
  | 'existing-ss'
  | 'proposed-ss'
  | 'existing-feeders'
  | 'proposed-feeders';

export const REPORT_TABS: { id: ReportTabId; label: string }[] = [
  { id: 'executive', label: 'Executive' },
  { id: 'dossier', label: 'District' },
  { id: 'existing-ss', label: 'Existing SS' },
  { id: 'proposed-ss', label: 'Proposed SS' },
  { id: 'existing-feeders', label: 'Existing Feeders' },
  { id: 'proposed-feeders', label: 'Proposed Feeders' },
];

export type VoltageBreakdown = {
  code: VoltageCode;
  label: string;
  ssExisting: number;
  ssProposed: number;
  lineExisting: number;
  lineProposed: number;
  lineKmExisting: number;
  mvaExisting: number;
  mvaProposed: number;
};

/** Canonical utility owners for inventory rollups. */
export const OWNER_ORDER = [
  'WBSEDCL',
  'WBSETCL',
  'POWERGRID',
  'NTPC',
  'DVC',
  'CESC',
] as const;

export type KnownOwner = (typeof OWNER_ORDER)[number];

/** Options for the Properties ownership select (same canonical list). */
export const OWNER_OPTIONS: readonly KnownOwner[] = OWNER_ORDER;

export type OwnerBreakdown = {
  owner: string;
  ssExisting: number;
  ssProposed: number;
  mvaExisting: number;
  mvaProposed: number;
};

export type OwnerVoltageBreakdown = {
  owner: string;
  voltageCode: VoltageCode;
  voltageLabel: string;
  ssExisting: number;
  ssProposed: number;
  mvaExisting: number;
  mvaProposed: number;
};

export type ExecutiveReport = {
  ssExisting: number;
  ssProposed: number;
  ssRetired: number;
  lineExisting: number;
  lineProposed: number;
  lineRetired: number;
  doubleCircuit: number;
  installedMvaExisting: number;
  installedMvaProposed: number;
  lineKmExisting: number;
  lineKmProposed: number;
  avgLoadingSs: number | null;
  avgLoadingLine: number | null;
  overloadedSs: number;
  overloadedLines: number;
  isolatedSs: number;
  oldestYear: number | null;
  byVoltage: VoltageBreakdown[];
  byOwner: OwnerBreakdown[];
  byOwnerVoltage: OwnerVoltageBreakdown[];
};

export type SsReportRow = {
  id: string;
  name: string;
  voltageCode: VoltageCode;
  status: string;
  owner: string;
  orgName: string;
  capacity: string;
  mva: number;
  loadingPct: number | null;
  overloaded: boolean;
  year: number | null;
  proposedImprovement: string;
  progress: string;
  remarks: string;
  lat: number;
  lng: number;
};

export type FeederReportRow = {
  id: string;
  name: string;
  voltageCode: VoltageCode;
  status: string;
  fromName: string;
  toName: string;
  lengthKm: number | null;
  conductor: string;
  circuitConfig: string;
  circuitCount: number;
  loadingPct: number | null;
  overloaded: boolean;
  year: number | null;
  remarks: string;
};

function orgName(orgUnits: OrgUnit[], id: string | null): string {
  if (!id) return '—';
  return orgUnits.find((o) => o.id === id)?.name ?? '—';
}

/** Map free-text owner to a stable inventory bucket.
 *  All 33 kV substations are WBSEDCL; blank 132/220 kV default to WBSETCL. */
export function normalizeOwner(
  raw: string | null | undefined,
  voltageCode?: VoltageCode,
): string {
  if (voltageCode === '33') return 'WBSEDCL';
  const original = (raw ?? '').trim();
  if (!original) {
    if (voltageCode === '132' || voltageCode === '220' || voltageCode === '66') return 'WBSETCL';
    return 'Unassigned';
  }
  const t = original.toUpperCase().replace(/[\s._-]+/g, '');
  if (/WBSEDCL|WBPDCL|^SEDCL/.test(t) || t.includes('DISTRIBUTION')) return 'WBSEDCL';
  if (/WBSETCL|^SETCL|TRANSMISSION/.test(t)) return 'WBSETCL';
  if (/POWERGRID|PGCIL|^CTU/.test(t)) return 'POWERGRID';
  if (/NTPC/.test(t)) return 'NTPC';
  if (/^DVC|DAMODAR/.test(t)) return 'DVC';
  if (/CESC/.test(t)) return 'CESC';
  return original.replace(/\s+/g, ' ');
}

function ownerSortKey(owner: string): number {
  const i = OWNER_ORDER.indexOf(owner as (typeof OWNER_ORDER)[number]);
  if (i >= 0) return i;
  if (owner === 'Unassigned') return OWNER_ORDER.length + 100;
  return OWNER_ORDER.length;
}

function avg(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function connectedIds(lines: TrunkLine[]): Set<string> {
  const set = new Set<string>();
  lines.forEach((l) => {
    set.add(l.fromId);
    set.add(l.toId);
  });
  return set;
}

export function buildExecutiveReport(
  substations: Substation[],
  lines: TrunkLine[],
): ExecutiveReport {
  const ssExisting = substations.filter((s) => s.status === 'existing');
  const ssProposed = substations.filter((s) => s.status === 'proposed');
  const lineExisting = lines.filter((l) => l.status === 'existing');
  const lineProposed = lines.filter((l) => l.status === 'proposed');
  const connected = connectedIds(lines);

  const byVoltage: VoltageBreakdown[] = VOLTAGE_CATALOG.map((v) => {
    const ssE = ssExisting.filter((s) => s.voltageCode === v.code);
    const ssP = ssProposed.filter((s) => s.voltageCode === v.code);
    const lnE = lineExisting.filter((l) => l.voltageCode === v.code);
    const lnP = lineProposed.filter((l) => l.voltageCode === v.code);
    return {
      code: v.code,
      label: v.label,
      ssExisting: ssE.length,
      ssProposed: ssP.length,
      lineExisting: lnE.length,
      lineProposed: lnP.length,
      lineKmExisting: lnE.reduce((sum, l) => sum + (l.lengthKm ?? 0), 0),
      mvaExisting: ssE.reduce((sum, s) => sum + installedMva(s.transformers), 0),
      mvaProposed: ssP.reduce((sum, s) => sum + installedMva(s.transformers), 0),
    };
  });

  const ownerBuckets = new Map<
    string,
    {
      ssExisting: number;
      ssProposed: number;
      mvaExisting: number;
      mvaProposed: number;
      byV: Map<
        VoltageCode,
        { ssExisting: number; ssProposed: number; mvaExisting: number; mvaProposed: number }
      >;
    }
  >();

  const bump = (s: Substation, kind: 'existing' | 'proposed') => {
    const owner = normalizeOwner(s.owner, s.voltageCode);
    let bucket = ownerBuckets.get(owner);
    if (!bucket) {
      bucket = {
        ssExisting: 0,
        ssProposed: 0,
        mvaExisting: 0,
        mvaProposed: 0,
        byV: new Map(),
      };
      ownerBuckets.set(owner, bucket);
    }
    const mva = installedMva(s.transformers);
    let cell = bucket.byV.get(s.voltageCode);
    if (!cell) {
      cell = { ssExisting: 0, ssProposed: 0, mvaExisting: 0, mvaProposed: 0 };
      bucket.byV.set(s.voltageCode, cell);
    }
    if (kind === 'existing') {
      bucket.ssExisting += 1;
      bucket.mvaExisting += mva;
      cell.ssExisting += 1;
      cell.mvaExisting += mva;
    } else {
      bucket.ssProposed += 1;
      bucket.mvaProposed += mva;
      cell.ssProposed += 1;
      cell.mvaProposed += mva;
    }
  };

  ssExisting.forEach((s) => bump(s, 'existing'));
  ssProposed.forEach((s) => bump(s, 'proposed'));

  const byOwner: OwnerBreakdown[] = [...ownerBuckets.entries()]
    .map(([owner, b]) => ({
      owner,
      ssExisting: b.ssExisting,
      ssProposed: b.ssProposed,
      mvaExisting: b.mvaExisting,
      mvaProposed: b.mvaProposed,
    }))
    .sort(
      (a, b) =>
        ownerSortKey(a.owner) - ownerSortKey(b.owner) ||
        a.owner.localeCompare(b.owner),
    );

  const byOwnerVoltage: OwnerVoltageBreakdown[] = [];
  for (const [owner, b] of [...ownerBuckets.entries()].sort(
    (a, b) => ownerSortKey(a[0]) - ownerSortKey(b[0]) || a[0].localeCompare(b[0]),
  )) {
    for (const v of VOLTAGE_CATALOG) {
      const cell = b.byV.get(v.code);
      if (!cell) continue;
      if (!cell.ssExisting && !cell.ssProposed) continue;
      byOwnerVoltage.push({
        owner,
        voltageCode: v.code,
        voltageLabel: v.label,
        ssExisting: cell.ssExisting,
        ssProposed: cell.ssProposed,
        mvaExisting: cell.mvaExisting,
        mvaProposed: cell.mvaProposed,
      });
    }
  }

  const years = substations
    .map((s) => s.commissionYear)
    .filter((y): y is number => y != null);

  return {
    ssExisting: ssExisting.length,
    ssProposed: ssProposed.length,
    ssRetired: substations.filter((s) => s.status === 'retired').length,
    lineExisting: lineExisting.length,
    lineProposed: lineProposed.length,
    lineRetired: lines.filter((l) => l.status === 'retired').length,
    doubleCircuit: lines.filter((l) => l.circuitConfig === 'double' || l.circuitCount > 1)
      .length,
    installedMvaExisting: ssExisting.reduce((sum, s) => sum + installedMva(s.transformers), 0),
    installedMvaProposed: ssProposed.reduce((sum, s) => sum + installedMva(s.transformers), 0),
    lineKmExisting: lineExisting.reduce((sum, l) => sum + (l.lengthKm ?? 0), 0),
    lineKmProposed: lineProposed.reduce((sum, l) => sum + (l.lengthKm ?? 0), 0),
    avgLoadingSs: avg(
      ssExisting.map((s) => s.loadingPct).filter((v): v is number => v != null),
    ),
    avgLoadingLine: avg(
      lineExisting.map((l) => l.loadingPct).filter((v): v is number => v != null),
    ),
    overloadedSs: substations.filter((s) => isOverloaded(s.loadingPct)).length,
    overloadedLines: lines.filter((l) => isOverloaded(l.loadingPct)).length,
    isolatedSs: substations.filter((s) => s.status !== 'retired' && !connected.has(s.id))
      .length,
    oldestYear: years.length ? Math.min(...years) : null,
    byVoltage,
    byOwner,
    byOwnerVoltage,
  };
}

export function buildSsReportRows(
  substations: Substation[],
  orgUnits: OrgUnit[],
  status: 'existing' | 'proposed',
): SsReportRow[] {
  const voltRank = (code: VoltageCode) =>
    VOLTAGE_CATALOG.find((v) => v.code === code)?.sortOrder ?? 99;
  return substations
    .filter((s) => s.status === status)
    .map((s) => {
      const owner = normalizeOwner(s.owner, s.voltageCode);
      return {
        id: s.id,
        name: s.name,
        voltageCode: s.voltageCode,
        status: s.status,
        owner,
        orgName: orgName(orgUnits, s.orgUnitId),
        capacity: formatCapacity(s.transformers),
        mva: installedMva(s.transformers),
        loadingPct: s.loadingPct,
        overloaded: isOverloaded(s.loadingPct),
        year: s.commissionYear,
        proposedImprovement: s.proposalRef,
        progress: s.owner,
        remarks: s.remarks,
        lat: s.lat,
        lng: s.lng,
      };
    })
    .sort((a, b) => {
      const vo = voltRank(a.voltageCode) - voltRank(b.voltageCode);
      if (vo) return vo;
      const oo = ownerSortKey(a.owner) - ownerSortKey(b.owner);
      if (oo) return oo;
      if (a.owner !== b.owner) return a.owner.localeCompare(b.owner);
      if (status === 'existing') {
        const la = a.loadingPct ?? -1;
        const lb = b.loadingPct ?? -1;
        if (lb !== la) return lb - la;
      }
      return a.name.localeCompare(b.name);
    });
}

export function buildFeederReportRows(
  lines: TrunkLine[],
  substations: Substation[],
  status: 'existing' | 'proposed' = 'existing',
): FeederReportRow[] {
  const byId = new Map(substations.map((s) => [s.id, s]));
  return lines
    .filter((l) => l.status === status)
    .map((l) => ({
      id: l.id,
      name: l.name,
      voltageCode: l.voltageCode,
      status: l.status,
      fromName: byId.get(l.fromId)?.name ?? '—',
      toName: byId.get(l.toId)?.name ?? '—',
      lengthKm: l.lengthKm,
      conductor: l.conductor || '—',
      circuitConfig: l.circuitConfig,
      circuitCount: l.circuitCount,
      loadingPct: l.loadingPct,
      overloaded: isOverloaded(l.loadingPct),
      year: l.commissionYear,
      remarks: l.remarks,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function downloadCsv(filename: string, headers: string[], rows: (string | number | null | undefined)[][]) {
  const esc = (c: string | number | null | undefined) =>
    `"${String(c ?? '').replace(/"/g, '""')}"`;
  const body = [
    headers.map(esc).join(','),
    ...rows.map((r) => r.map(esc).join(',')),
  ].join('\n');
  const blob = new Blob([body], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportSsCsv(
  rows: SsReportRow[],
  kind: 'existing' | 'proposed',
  scope: OutputScope = {},
) {
  const exportKind: ReportExportKind = kind === 'existing' ? 'existing-ss' : 'proposed-ss';
  downloadCsv(
    reportCsvFilename(exportKind, scope),
    [
      'Name',
      'Voltage kV',
      'Status',
      'Owner',
      'Division/Org',
      'Capacity',
      'MVA',
      'Loading %',
      'Year',
      'Proposed Improvement',
      'Remarks',
      'Lat',
      'Lng',
    ],
    rows.map((r) => [
      r.name,
      r.voltageCode,
      r.status,
      r.owner,
      r.orgName,
      r.capacity,
      r.mva,
      r.loadingPct,
      r.year,
      r.proposedImprovement,
      r.remarks,
      r.lat,
      r.lng,
    ]),
  );
}

export function exportFeedersCsv(
  rows: FeederReportRow[],
  kind: 'existing' | 'proposed' = 'existing',
  scope: OutputScope = {},
) {
  const exportKind: ReportExportKind =
    kind === 'existing' ? 'existing-feeders' : 'proposed-feeders';
  downloadCsv(
    reportCsvFilename(exportKind, scope),
    [
      'Name',
      'Voltage kV',
      'From',
      'To',
      'Length km',
      'Conductor',
      'Circuit',
      'Circuits',
      'Loading %',
      'Year',
      'Remarks',
    ],
    rows.map((r) => [
      r.name,
      r.voltageCode,
      r.fromName,
      r.toName,
      r.lengthKm,
      r.conductor,
      r.circuitConfig,
      r.circuitCount,
      r.loadingPct,
      r.year,
      r.remarks,
    ]),
  );
}

export function exportExecutiveCsv(report: ExecutiveReport, scope: OutputScope = {}) {
  downloadCsv(
    reportCsvFilename('executive', scope),
    ['Section', 'Owner / Voltage', 'Existing SS', 'Existing MVA', 'Proposed SS', 'Proposed MVA', 'Extra'],
    [
      [
        'Totals',
        'All',
        report.ssExisting,
        report.installedMvaExisting.toFixed(1),
        report.ssProposed,
        report.installedMvaProposed.toFixed(1),
        '',
      ],
      ...report.byVoltage.map((v) => [
        'By voltage',
        v.label,
        v.ssExisting,
        v.mvaExisting.toFixed(1),
        v.ssProposed,
        v.mvaProposed.toFixed(1),
        `feeders ${v.lineExisting} · ${v.lineKmExisting.toFixed(1)} km`,
      ]),
      ...report.byOwner.map((o) => [
        'By owner',
        o.owner,
        o.ssExisting,
        o.mvaExisting.toFixed(1),
        o.ssProposed,
        o.mvaProposed.toFixed(1),
        '',
      ]),
      ...report.byOwnerVoltage.map((r) => [
        'By owner × voltage',
        `${r.owner} · ${r.voltageLabel}`,
        r.ssExisting,
        r.mvaExisting.toFixed(1),
        r.ssProposed,
        r.mvaProposed.toFixed(1),
        '',
      ]),
    ],
  );
}

function ssRowsAll(substations: Substation[], orgUnits: OrgUnit[]): SsReportRow[] {
  return [
    ...buildSsReportRows(substations, orgUnits, 'existing'),
    ...buildSsReportRows(substations, orgUnits, 'proposed'),
  ];
}

function feederRowsAll(
  lines: TrunkLine[],
  substations: Substation[],
): FeederReportRow[] {
  return [
    ...buildFeederReportRows(lines, substations, 'existing'),
    ...buildFeederReportRows(lines, substations, 'proposed'),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

export type DistrictDossier = {
  districtNames: string[];
  inDistrictCount: number;
  linkedOutsideCount: number;
  mvaInDistrict: number;
  feedersInternal: number;
  feedersLeaving: number;
  feederKm: number;
  overloadedSs: number;
  isolatedInDistrict: number;
  inDistrictSs: SsReportRow[];
  linkedOutsideSs: SsReportRow[];
  internalFeeders: FeederReportRow[];
  leavingFeeders: FeederReportRow[];
};

/** District-focused pack: in-boundary SS, links out, and linked outside hubs. */
export function buildDistrictDossier(
  substations: Substation[],
  lines: TrunkLine[],
  inDistrictIds: string[],
  districtNames: string[],
  orgUnits: OrgUnit[],
): DistrictDossier {
  const core = new Set(inDistrictIds);
  const inSs = substations.filter((s) => core.has(s.id));
  const outSs = substations.filter((s) => !core.has(s.id));
  const connected = connectedIds(lines);

  const internal: TrunkLine[] = [];
  const leaving: TrunkLine[] = [];
  for (const l of lines) {
    const a = core.has(l.fromId);
    const b = core.has(l.toId);
    if (a && b) internal.push(l);
    else if (a || b) leaving.push(l);
  }

  return {
    districtNames,
    inDistrictCount: inSs.length,
    linkedOutsideCount: outSs.length,
    mvaInDistrict: inSs.reduce((sum, s) => sum + installedMva(s.transformers), 0),
    feedersInternal: internal.length,
    feedersLeaving: leaving.length,
    feederKm: [...internal, ...leaving].reduce((sum, l) => sum + (l.lengthKm ?? 0), 0),
    overloadedSs: inSs.filter((s) => isOverloaded(s.loadingPct)).length,
    isolatedInDistrict: inSs.filter(
      (s) => s.status !== 'retired' && !connected.has(s.id),
    ).length,
    inDistrictSs: ssRowsAll(inSs, orgUnits),
    linkedOutsideSs: ssRowsAll(outSs, orgUnits),
    internalFeeders: feederRowsAll(internal, substations),
    leavingFeeders: feederRowsAll(leaving, substations),
  };
}

export function exportDistrictDossierCsv(dossier: DistrictDossier, scope: OutputScope = {}) {
  downloadCsv(
    reportCsvFilename('dossier', {
      ...scope,
      districts: scope.districts?.length ? scope.districts : dossier.districtNames,
    }),
    ['Section', 'Name', 'Detail', 'Value'],
    [
      ['Summary', 'Districts', dossier.districtNames.join(' · '), ''],
      ['Summary', 'In-district SS', '', dossier.inDistrictCount],
      ['Summary', 'Linked outside SS', '', dossier.linkedOutsideCount],
      ['Summary', 'In-district MVA', '', dossier.mvaInDistrict.toFixed(1)],
      ['Summary', 'Internal feeders', '', dossier.feedersInternal],
      ['Summary', 'Leaving feeders', '', dossier.feedersLeaving],
      ['Summary', 'Feeder km', '', dossier.feederKm.toFixed(1)],
      ['Summary', 'Overloaded SS', '', dossier.overloadedSs],
      ['Summary', 'Isolated SS', '', dossier.isolatedInDistrict],
      ...dossier.inDistrictSs.map((r) => [
        'In-district SS',
        r.name,
        `${r.voltageCode} kV · ${r.capacity}`,
        r.mva,
      ]),
      ...dossier.linkedOutsideSs.map((r) => [
        'Linked outside SS',
        r.name,
        `${r.voltageCode} kV · ${r.capacity}`,
        r.mva,
      ]),
      ...dossier.internalFeeders.map((r) => [
        'Internal feeder',
        r.name,
        `${r.fromName} → ${r.toName}`,
        r.lengthKm,
      ]),
      ...dossier.leavingFeeders.map((r) => [
        'Leaving feeder',
        r.name,
        `${r.fromName} → ${r.toName}`,
        r.lengthKm,
      ]),
    ],
  );
}
