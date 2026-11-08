import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNetworkStore } from '@/store/networkStore';
import { buildPrintAssets } from '@/lib/printLayout';
import type { OutputScope } from '@/lib/outputNames';
import { geoJsonFilename } from '@/lib/outputNames';
import {
  REPORT_TABS,
  buildDistrictDossier,
  buildExecutiveReport,
  buildFeederReportRows,
  buildSsReportRows,
  exportDistrictDossierCsv,
  exportExecutiveCsv,
  exportFeedersCsv,
  exportSsCsv,
  type DistrictDossier,
  type FeederReportRow,
  type ReportTabId,
  type SsReportRow,
} from '@/lib/reports';

function pct(v: number | null | undefined) {
  if (v == null) return '—';
  return `${Math.round(v)}%`;
}

function km(v: number | null | undefined) {
  if (v == null) return '—';
  return v.toFixed(1);
}

export function ReportsForm() {
  const [tab, setTab] = useState<ReportTabId>('executive');
  const allSubstations = useNetworkStore((s) => s.substations);
  const allLines = useNetworkStore((s) => s.lines);
  const orgUnits = useNetworkStore((s) => s.orgUnits);
  const mapLayers = useNetworkStore((s) => s.mapLayers);
  const filters = useNetworkStore((s) => s.filters);
  const sceneId = useNetworkStore((s) => s.sceneId);
  const scopeBadgeLabel = useNetworkStore((s) => s.scopeBadgeLabel);
  const setSelection = useNetworkStore((s) => s.setSelection);
  const setMapFocus = useNetworkStore((s) => s.setMapFocus);
  const flashStatus = useNetworkStore((s) => s.flashStatus);
  const setPanel = useNetworkStore((s) => s.setPanel);
  const syncPrintFromScope = useNetworkStore((s) => s.syncPrintFromScope);
  const setPrintPreviewOpen = useNetworkStore((s) => s.setPrintPreviewOpen);
  const voltageFocus = useNetworkStore((s) => s.voltageFocus);

  const filteredSs = useMemo(
    () => useNetworkStore.getState().visibleSubstations(),
    [allSubstations, allLines, filters],
  );
  const filteredLines = useMemo(
    () => useNetworkStore.getState().visibleLines(),
    [allSubstations, allLines, filters],
  );

  const focusedDistricts = mapLayers.dimAllDistricts
    ? []
    : mapLayers.focusedDistricts;
  const focusKey = focusedDistricts.join('|');

  const [scoped, setScoped] = useState<{
    substations: typeof filteredSs;
    lines: typeof filteredLines;
    inDistrictIds: string[];
    districtNames: string[];
  } | null>(null);
  const [scopeBusy, setScopeBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!focusedDistricts.length) {
      setScoped(null);
      setScopeBusy(false);
      return;
    }
    setScopeBusy(true);
    void buildPrintAssets(filteredSs, filteredLines, focusedDistricts, {
      includeProposed: filters.showProposed && filters.statuses.includes('proposed'),
    }).then((bundle) => {
      if (cancelled) return;
      setScoped({
        substations: bundle.substations,
        lines: bundle.lines,
        inDistrictIds: bundle.inDistrictIds,
        districtNames: bundle.districtNames,
      });
      setScopeBusy(false);
    });
    return () => {
      cancelled = true;
    };
  }, [focusKey, filteredSs, filteredLines, filters.showProposed, filters.statuses]);

  const substations = scoped?.substations ?? filteredSs;
  const lines = scoped?.lines ?? filteredLines;
  const badge = scopeBadgeLabel();

  const outputScope = useMemo((): OutputScope => {
    const districts = focusedDistricts.length
      ? focusedDistricts
      : scoped?.districtNames.length
        ? scoped.districtNames
        : undefined;
    return { districts, voltageFocus };
  }, [focusedDistricts, scoped?.districtNames, voltageFocus]);

  const executive = useMemo(
    () => buildExecutiveReport(substations, lines),
    [substations, lines],
  );
  const existingSs = useMemo(
    () => buildSsReportRows(substations, orgUnits, 'existing'),
    [substations, orgUnits],
  );
  const proposedSs = useMemo(
    () => buildSsReportRows(substations, orgUnits, 'proposed'),
    [substations, orgUnits],
  );
  const existingFeeders = useMemo(
    () => buildFeederReportRows(lines, allSubstations, 'existing'),
    [lines, allSubstations],
  );
  const proposedFeeders = useMemo(
    () => buildFeederReportRows(lines, allSubstations, 'proposed'),
    [lines, allSubstations],
  );

  const dossier: DistrictDossier | null = useMemo(() => {
    if (!scoped || !scoped.inDistrictIds.length) return null;
    return buildDistrictDossier(
      scoped.substations,
      scoped.lines,
      scoped.inDistrictIds,
      scoped.districtNames.length ? scoped.districtNames : focusedDistricts,
      orgUnits,
    );
  }, [scoped, focusedDistricts, orgUnits]);

  useEffect(() => {
    if (tab === 'dossier' && !focusedDistricts.length) {
      setTab('executive');
    }
  }, [tab, focusedDistricts.length]);

  const focusSs = (row: SsReportRow) => {
    setSelection({ kind: 'substation', id: row.id });
    setMapFocus({ lat: row.lat, lng: row.lng });
    flashStatus(`Selected · ${row.name}`);
  };

  const focusFeeder = (row: FeederReportRow) => {
    setSelection({ kind: 'line', id: row.id });
    const line = useNetworkStore.getState().lines.find((l) => l.id === row.id);
    const from = line ? allSubstations.find((s) => s.id === line.fromId) : undefined;
    const to = line ? allSubstations.find((s) => s.id === line.toId) : undefined;
    if (from && to) {
      setMapFocus({
        lat: (from.lat + to.lat) / 2,
        lng: (from.lng + to.lng) / 2,
      });
    }
    flashStatus(`Selected · ${row.name}`);
  };

  const exportCurrent = () => {
    if (tab === 'executive') exportExecutiveCsv(executive, outputScope);
    else if (tab === 'dossier' && dossier) exportDistrictDossierCsv(dossier, outputScope);
    else if (tab === 'existing-ss') exportSsCsv(existingSs, 'existing', outputScope);
    else if (tab === 'proposed-ss') exportSsCsv(proposedSs, 'proposed', outputScope);
    else if (tab === 'existing-feeders') exportFeedersCsv(existingFeeders, 'existing', outputScope);
    else exportFeedersCsv(proposedFeeders, 'proposed', outputScope);
    flashStatus('CSV exported');
  };

  const openPrint = () => {
    syncPrintFromScope();
    setPanel('print');
    setPrintPreviewOpen(true);
  };

  const exportGeoJson = () => {
    const ss = substations;
    const ls = lines;
    const geo = {
      type: 'FeatureCollection',
      features: [
        ...ss.map((s) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
          properties: { kind: 'substation', ...s },
        })),
        ...ls.map((l) => {
          const from = allSubstations.find((s) => s.id === l.fromId);
          const to = allSubstations.find((s) => s.id === l.toId);
          return {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: from && to ? [[from.lng, from.lat], [to.lng, to.lat]] : [],
            },
            properties: { kind: 'line', ...l },
          };
        }),
      ],
    };
    const blob = new Blob([JSON.stringify(geo, null, 2)], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = geoJsonFilename(outputScope);
    a.click();
    URL.revokeObjectURL(url);
    flashStatus('GeoJSON exported');
  };

  const tabs = REPORT_TABS.filter(
    (t) => t.id !== 'dossier' || focusedDistricts.length > 0,
  );

  return (
    <div className="form-stack reports-panel">
      <p className="muted reports-filter-note">
        Reporting on: <strong>{badge}</strong>
        {scopeBusy ? ' · resolving districts…' : ''}
        {focusedDistricts.length
          ? ' · in-district + connecting feeders'
          : ' · map filters (focus a district for the dossier)'}
      </p>

      <div className="report-tabs" role="tablist" aria-label="Report type">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`report-tab${tab === t.id ? ' is-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'executive' && <ExecutiveView report={executive} />}
      {tab === 'dossier' &&
        (dossier ? (
          <DossierView
            dossier={dossier}
            onSelectSs={focusSs}
            onSelectFeeder={focusFeeder}
          />
        ) : (
          <p className="muted">
            Focus one or more districts on the map (or Layers) to build a district dossier.
          </p>
        ))}
      {tab === 'existing-ss' && (
        <SsTable
          rows={existingSs}
          empty="No existing substations in the current scope."
          onSelect={focusSs}
          showLoading
        />
      )}
      {tab === 'proposed-ss' && (
        <SsTable
          rows={proposedSs}
          empty="No proposed substations in the current scope."
          onSelect={focusSs}
          showLoading={false}
        />
      )}
      {tab === 'existing-feeders' && (
        <FeederTable
          rows={existingFeeders}
          empty="No existing feeders in the current scope."
          onSelect={focusFeeder}
          showLoading
        />
      )}
      {tab === 'proposed-feeders' && (
        <FeederTable
          rows={proposedFeeders}
          empty="No proposed feeders in the current scope."
          onSelect={focusFeeder}
          showLoading={false}
        />
      )}

      <div className="btn-row">
        <button type="button" className="primary-btn" onClick={exportCurrent}>
          Export CSV
        </button>
        <button type="button" className="primary-btn ghost" onClick={exportGeoJson}>
          Export GeoJSON
        </button>
        <button type="button" className="primary-btn ghost" onClick={openPrint}>
          Print scope
        </button>
      </div>
      {sceneId === 'custom' && (
        <p className="muted">Scene is Custom — filters or layers were changed manually.</p>
      )}
    </div>
  );
}

function DossierView({
  dossier,
  onSelectSs,
  onSelectFeeder,
}: {
  dossier: DistrictDossier;
  onSelectSs: (row: SsReportRow) => void;
  onSelectFeeder: (row: FeederReportRow) => void;
}) {
  return (
    <div className="form-stack">
      <p className="section-label">{dossier.districtNames.join(' · ') || 'District'}</p>
      <div className="report-card">
        <div>
          <span>In-district SS</span>
          <strong>{dossier.inDistrictCount}</strong>
        </div>
        <div>
          <span>Linked outside</span>
          <strong>{dossier.linkedOutsideCount}</strong>
        </div>
        <div>
          <span>In-district MVA</span>
          <strong>{dossier.mvaInDistrict.toFixed(1)}</strong>
        </div>
        <div>
          <span>Internal feeders</span>
          <strong>{dossier.feedersInternal}</strong>
        </div>
        <div>
          <span>Leaving feeders</span>
          <strong>{dossier.feedersLeaving}</strong>
        </div>
        <div>
          <span>Feeder km</span>
          <strong>{dossier.feederKm.toFixed(1)}</strong>
        </div>
        <div>
          <span>Overloaded SS</span>
          <strong className={dossier.overloadedSs ? 'is-warn' : ''}>
            {dossier.overloadedSs}
          </strong>
        </div>
        <div>
          <span>Isolated SS</span>
          <strong>{dossier.isolatedInDistrict}</strong>
        </div>
      </div>

      <p className="section-label">In-district substations</p>
      <SsTable
        rows={dossier.inDistrictSs}
        empty="No substations inside the focused district(s)."
        onSelect={onSelectSs}
        showLoading
      />

      {dossier.linkedOutsideSs.length > 0 && (
        <>
          <p className="section-label">Linked outside hubs</p>
          <SsTable
            rows={dossier.linkedOutsideSs}
            empty=""
            onSelect={onSelectSs}
            showLoading={false}
          />
        </>
      )}

      <p className="section-label">Internal feeders</p>
      <FeederTable
        rows={dossier.internalFeeders}
        empty="No feeders wholly inside the district(s)."
        onSelect={onSelectFeeder}
        showLoading
      />

      <p className="section-label">Feeders leaving</p>
      <FeederTable
        rows={dossier.leavingFeeders}
        empty="No feeders leave the focused district(s)."
        onSelect={onSelectFeeder}
        showLoading
      />
    </div>
  );
}

function ExecutiveView({
  report,
}: {
  report: ReturnType<typeof buildExecutiveReport>;
}) {
  const voltageRows = report.byVoltage.filter(
    (v) => v.ssExisting || v.ssProposed || v.lineExisting || v.lineProposed,
  );
  const ownerRows = report.byOwner;
  const detailRows = report.byOwnerVoltage;

  return (
    <div className="form-stack">
      <div className="report-card">
        <div>
          <span>Existing SS</span>
          <strong>{report.ssExisting}</strong>
        </div>
        <div>
          <span>Proposed SS</span>
          <strong>{report.ssProposed}</strong>
        </div>
        <div>
          <span>Installed MVA</span>
          <strong>{report.installedMvaExisting.toFixed(1)}</strong>
        </div>
        <div>
          <span>Planned MVA</span>
          <strong>{report.installedMvaProposed.toFixed(1)}</strong>
        </div>
        <div>
          <span>Existing feeders</span>
          <strong>{report.lineExisting}</strong>
        </div>
        <div>
          <span>Proposed feeders</span>
          <strong>{report.lineProposed}</strong>
        </div>
        <div>
          <span>Existing km</span>
          <strong>{report.lineKmExisting.toFixed(1)}</strong>
        </div>
        <div>
          <span>Proposed km</span>
          <strong>{report.lineKmProposed.toFixed(1)}</strong>
        </div>
        <div>
          <span>Overloaded SS</span>
          <strong className={report.overloadedSs ? 'is-warn' : ''}>{report.overloadedSs}</strong>
        </div>
        <div>
          <span>Isolated SS</span>
          <strong>{report.isolatedSs}</strong>
        </div>
      </div>

      <p className="section-label">SS & capacity by voltage</p>
      <div className="report-table-wrap">
        <table className="report-table report-table-compact">
          <thead>
            <tr>
              <th>Voltage</th>
              <th>Ex SS</th>
              <th>Ex MVA</th>
              <th>Pr SS</th>
              <th>Pr MVA</th>
            </tr>
          </thead>
          <tbody>
            {voltageRows.map((v) => (
              <tr key={v.code}>
                <td>{v.label}</td>
                <td>{v.ssExisting || '—'}</td>
                <td>{v.mvaExisting ? v.mvaExisting.toFixed(1) : '—'}</td>
                <td>{v.ssProposed || '—'}</td>
                <td>{v.mvaProposed ? v.mvaProposed.toFixed(1) : '—'}</td>
              </tr>
            ))}
            <tr className="report-total-row">
              <td>Total</td>
              <td>{report.ssExisting}</td>
              <td>{report.installedMvaExisting.toFixed(1)}</td>
              <td>{report.ssProposed}</td>
              <td>{report.installedMvaProposed.toFixed(1)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="section-label">SS & capacity by owner</p>
      <div className="report-table-wrap">
        <table className="report-table report-table-compact">
          <thead>
            <tr>
              <th>Owner</th>
              <th>Ex SS</th>
              <th>Ex MVA</th>
              <th>Pr SS</th>
              <th>Pr MVA</th>
            </tr>
          </thead>
          <tbody>
            {ownerRows.map((o) => (
              <tr key={o.owner}>
                <td>{o.owner}</td>
                <td>{o.ssExisting || '—'}</td>
                <td>{o.mvaExisting ? o.mvaExisting.toFixed(1) : '—'}</td>
                <td>{o.ssProposed || '—'}</td>
                <td>{o.mvaProposed ? o.mvaProposed.toFixed(1) : '—'}</td>
              </tr>
            ))}
            {!ownerRows.length && (
              <tr>
                <td colSpan={5} className="muted">
                  No substations in scope
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="section-label">Owner × voltage</p>
      <div className="report-table-wrap">
        <table className="report-table report-table-compact">
          <thead>
            <tr>
              <th>Owner</th>
              <th>kV</th>
              <th>Ex SS</th>
              <th>Ex MVA</th>
              <th>Pr SS</th>
              <th>Pr MVA</th>
            </tr>
          </thead>
          <tbody>
            {detailRows.map((r) => (
              <tr key={`${r.owner}-${r.voltageCode}`}>
                <td>{r.owner}</td>
                <td>{r.voltageCode}</td>
                <td>{r.ssExisting || '—'}</td>
                <td>{r.mvaExisting ? r.mvaExisting.toFixed(1) : '—'}</td>
                <td>{r.ssProposed || '—'}</td>
                <td>{r.mvaProposed ? r.mvaProposed.toFixed(1) : '—'}</td>
              </tr>
            ))}
            {!detailRows.length && (
              <tr>
                <td colSpan={6} className="muted">
                  No substations in scope
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SsTable({
  rows,
  empty,
  onSelect,
  showLoading,
}: {
  rows: SsReportRow[];
  empty: string;
  onSelect: (row: SsReportRow) => void;
  showLoading: boolean;
}) {
  if (!rows.length) return empty ? <p className="muted">{empty}</p> : null;

  const totalMva = rows.reduce((sum, r) => sum + r.mva, 0);

  // Group headers: voltage then owner
  type Block = { key: string; label: string; rows: SsReportRow[]; mva: number };
  const blocks: Block[] = [];
  for (const r of rows) {
    const key = `${r.voltageCode}|${r.owner}`;
    const last = blocks[blocks.length - 1];
    if (last && last.key === key) {
      last.rows.push(r);
      last.mva += r.mva;
    } else {
      blocks.push({
        key,
        label: `${r.voltageCode} kV · ${r.owner}`,
        rows: [r],
        mva: r.mva,
      });
    }
  }

  return (
    <div className="form-stack">
      <div className="report-mini-stats">
        <span>
          <strong>{rows.length}</strong> SS
        </span>
        <span>
          <strong>{totalMva.toFixed(1)}</strong> MVA
        </span>
        {showLoading && (
          <span>
            <strong>{rows.filter((r) => r.overloaded).length}</strong> overloaded
          </span>
        )}
      </div>
      <div className="report-table-wrap">
        <table className="report-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Owner</th>
              <th>Capacity</th>
              {showLoading && <th>Load</th>}
              <th>Org</th>
            </tr>
          </thead>
          <tbody>
            {blocks.map((block) => (
              <Fragment key={block.key}>
                <tr className="report-group-row">
                  <td colSpan={showLoading ? 5 : 4}>
                    <strong>{block.label}</strong>
                    <span className="muted">
                      {' '}
                      · {block.rows.length} SS · {block.mva.toFixed(1)} MVA
                    </span>
                  </td>
                </tr>
                {block.rows.map((r) => (
                  <tr
                    key={r.id}
                    className={r.overloaded ? 'is-overloaded' : undefined}
                    onClick={() => onSelect(r)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelect(r);
                      }
                    }}
                    tabIndex={0}
                    title="Click to select on map"
                  >
                    <td>
                      <div className="report-name">{r.name}</div>
                      {(r.year || r.proposedImprovement) && (
                        <div className="muted report-sub">
                          {[r.year, r.proposedImprovement].filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </td>
                    <td>{r.owner}</td>
                    <td>
                      <div>{r.capacity}</div>
                      <div className="muted report-sub">{r.mva.toFixed(1)} MVA</div>
                    </td>
                    {showLoading && (
                      <td className={r.overloaded ? 'is-warn' : undefined}>{pct(r.loadingPct)}</td>
                    )}
                    <td>{r.orgName}</td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FeederTable({
  rows,
  empty,
  onSelect,
  showLoading,
}: {
  rows: FeederReportRow[];
  empty: string;
  onSelect: (row: FeederReportRow) => void;
  showLoading: boolean;
}) {
  if (!rows.length) return empty ? <p className="muted">{empty}</p> : null;

  const totalKm = rows.reduce((sum, r) => sum + (r.lengthKm ?? 0), 0);

  return (
    <div className="form-stack">
      <div className="report-mini-stats">
        <span>
          <strong>{rows.length}</strong> feeders
        </span>
        <span>
          <strong>{totalKm.toFixed(1)}</strong> km
        </span>
        {showLoading && (
          <span>
            <strong>{rows.filter((r) => r.overloaded).length}</strong> overloaded
          </span>
        )}
      </div>
      <div className="report-table-wrap">
        <table className="report-table">
          <thead>
            <tr>
              <th>Feeder</th>
              <th>km</th>
              <th>Cond.</th>
              {showLoading && <th>Load</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className={r.overloaded ? 'is-overloaded' : undefined}
                onClick={() => onSelect(r)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(r);
                  }
                }}
                tabIndex={0}
                title="Click to select on map"
              >
                <td>
                  <div className="report-name">{r.name}</div>
                  <div className="muted report-sub">
                    {r.voltageCode} kV · {r.fromName} → {r.toName}
                    {r.circuitConfig === 'double' || r.circuitCount > 1
                      ? ` · ${r.circuitConfig}/${r.circuitCount}`
                      : ''}
                    {r.year || r.remarks
                      ? ` · ${[r.year, r.remarks].filter(Boolean).join(' · ')}`
                      : ''}
                  </div>
                </td>
                <td>{km(r.lengthKm)}</td>
                <td>{r.conductor}</td>
                {showLoading && (
                  <td className={r.overloaded ? 'is-warn' : undefined}>{pct(r.loadingPct)}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
