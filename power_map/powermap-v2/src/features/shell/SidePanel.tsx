import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { formatCapacity } from '@/domain/geo';
import type { AssetLifecycle, TrunkLine, VoltageCode } from '@/domain/types';
import { VOLTAGE_CATALOG } from '@/domain/types';
import { linesConnectedTo } from '@/lib/networkRepo';
import { OWNER_OPTIONS, downloadCsv } from '@/lib/reports';
import { voltageCheckCsvFilename } from '@/lib/outputNames';
import type { SitingCandidate } from '@/lib/sitingSuggestions';
import { SITING_DISTRICTS } from '@/lib/sitingSuggestions';
import type { VoltageCheckCell } from '@/lib/voltageCheck';
import { isDraftStale } from '@/lib/personalDrafts';
import { useNetworkStore } from '@/store/networkStore';
import { ViewToggles } from '@/features/map/ViewToggles';
import { ReportsForm } from '@/features/shell/ReportsPanel';
import { PrintForm } from '@/features/print/PrintForm';

function OwnerSelect({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const known = (OWNER_OPTIONS as readonly string[]).includes(value);
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">—</option>
      {OWNER_OPTIONS.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
      {value && !known && <option value={value}>{value}</option>}
    </select>
  );
}

export function SidePanel() {
  const panel = useNetworkStore((s) => s.panel);
  const selection = useNetworkStore((s) => s.selection);
  const setPanel = useNetworkStore((s) => s.setPanel);
  const setTool = useNetworkStore((s) => s.setTool);

  if (!panel) return null;

  const title =
    panel === 'properties'
      ? 'Properties'
      : panel === 'place-ss'
        ? 'Place Substation'
        : panel === 'filters'
          ? 'Filters'
          : panel === 'layers'
            ? 'Layers'
            : panel === 'reports'
              ? 'Reports'
              : panel === 'siting'
                ? '33 kV Siting'
                : panel === 'voltage-check'
                  ? 'Check voltage — far from 33 kV'
                  : panel === 'print'
                    ? 'Print Map'
                    : 'Settings';

  return (
    <aside className="side-panel">
      <div className="side-panel-header">
        <h2>{title}</h2>
        <button
          type="button"
          className="icon-btn"
          onClick={() => {
            if (panel === 'place-ss') setTool('cursor');
            setPanel(null);
          }}
          aria-label="Close"
        >
          <X size={16} />
        </button>
      </div>
      <div className="side-panel-body">
        {panel === 'place-ss' && <PlaceSubstationForm />}
        {panel === 'properties' && (selection ? <PropertiesForm /> : <EmptyProps />)}
        {panel === 'filters' && <FiltersForm />}
        {panel === 'layers' && <LayersForm />}
        {panel === 'reports' && <ReportsForm />}
        {panel === 'siting' && <SitingForm />}
        {panel === 'voltage-check' && <VoltageCheckForm />}
        {panel === 'print' && <PrintForm />}
        {panel === 'settings' && <SettingsForm />}
      </div>
    </aside>
  );
}

function PlaceSubstationForm() {
  const placeDraft = useNetworkStore((s) => s.placeDraft);
  const hoverCoords = useNetworkStore((s) => s.hoverCoords);
  const applyLatLngInput = useNetworkStore((s) => s.applyLatLngInput);
  const addSubstationAt = useNetworkStore((s) => s.addSubstationAt);
  const setPlaceDraft = useNetworkStore((s) => s.setPlaceDraft);

  const [latText, setLatText] = useState(placeDraft ? String(placeDraft.lat) : '');
  const [lngText, setLngText] = useState(placeDraft ? String(placeDraft.lng) : '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (placeDraft) {
      setLatText(placeDraft.lat.toFixed(6));
      setLngText(placeDraft.lng.toFixed(6));
      setError(null);
    }
  }, [placeDraft?.lat, placeDraft?.lng]);

  const parseCoords = (): { lat: number; lng: number } | null => {
    const lat = Number(latText);
    const lng = Number(lngText);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      setError('Enter valid numbers for latitude and longitude');
      return null;
    }
    if (lat < -90 || lat > 90) {
      setError('Latitude must be between -90 and 90');
      return null;
    }
    if (lng < -180 || lng > 180) {
      setError('Longitude must be between -180 and 180');
      return null;
    }
    setError(null);
    return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
  };

  const parseAndApply = () => {
    const coords = parseCoords();
    if (!coords) return;
    applyLatLngInput(coords.lat, coords.lng);
  };

  return (
    <div className="form-stack">
      <p className="muted">
        Click the map to pick a point, or type coordinates below. Preview updates before you create.
      </p>

      <div className="coord-readout">
        <div>
          <span>Hover</span>
          <strong>
            {hoverCoords
              ? `${hoverCoords.lat.toFixed(6)}, ${hoverCoords.lng.toFixed(6)}`
              : '—'}
          </strong>
        </div>
        <div>
          <span>Selected</span>
          <strong>
            {placeDraft
              ? `${placeDraft.lat.toFixed(6)}, ${placeDraft.lng.toFixed(6)}`
              : '—'}
          </strong>
        </div>
      </div>

      <div className="field-row">
        <Field label="Latitude">
          <input
            inputMode="decimal"
            placeholder="25.010800"
            value={latText}
            onChange={(e) => setLatText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') parseAndApply();
            }}
          />
        </Field>
        <Field label="Longitude">
          <input
            inputMode="decimal"
            placeholder="88.141100"
            value={lngText}
            onChange={(e) => setLngText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') parseAndApply();
            }}
          />
        </Field>
      </div>

      {error && <p className="field-error">{error}</p>}

      <button type="button" className="primary-btn ghost" onClick={parseAndApply}>
        Go to coordinates
      </button>
      <button
        type="button"
        className="primary-btn"
        onClick={() => {
          const coords = parseCoords();
          if (!coords) return;
          applyLatLngInput(coords.lat, coords.lng);
          void addSubstationAt(coords.lat, coords.lng);
        }}
      >
        Create substation here
      </button>
      {placeDraft && (
        <button
          type="button"
          className="text-btn"
          onClick={() => {
            setPlaceDraft(null);
            setLatText('');
            setLngText('');
          }}
        >
          Clear selection
        </button>
      )}
    </div>
  );
}

function EmptyProps() {
  return <p className="muted">Select a substation, line, or tap on the map.</p>;
}

function parseCoordPair(latText: string, lngText: string): { lat: number; lng: number } | null {
  const lat = Number(String(latText).trim());
  const lng = Number(String(lngText).trim());
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
}

type LineDraft = {
  id: string;
  name: string;
  status: AssetLifecycle;
  voltageCode: VoltageCode;
  conductor: string;
  loadingPct: string;
};

function lineToDraft(line: TrunkLine): LineDraft {
  return {
    id: line.id,
    name: line.name,
    status: line.status,
    voltageCode: line.voltageCode,
    conductor: line.conductor,
    loadingPct: line.loadingPct == null ? '' : String(line.loadingPct),
  };
}

function SubstationPropertiesForm({ ssId }: { ssId: string }) {
  const ss = useNetworkStore((s) => s.substations.find((x) => x.id === ssId));
  const allLines = useNetworkStore((s) => s.lines);
  const substations = useNetworkStore((s) => s.substations);
  const orgUnits = useNetworkStore((s) => s.orgUnits);
  const adminMode = useNetworkStore((s) => s.adminMode);
  const adminRole = useNetworkStore((s) => s.adminRole);
  const editorCanEditSs = useNetworkStore((s) => s.editorCanEditSs);
  const saveSubstationBundle = useNetworkStore((s) => s.saveSubstationBundle);
  const savePersonalDraftBundle = useNetworkStore((s) => s.savePersonalDraftBundle);
  const personalDraftForAsset = useNetworkStore((s) => s.personalDraftForAsset);
  const discardPersonalDraft = useNetworkStore((s) => s.discardPersonalDraft);
  const substationsLive = useNetworkStore((s) => s.substations);
  const linesLive = useNetworkStore((s) => s.lines);
  const requestDelete = useNetworkStore((s) => s.requestDelete);
  const flashStatus = useNetworkStore((s) => s.flashStatus);
  const setPanel = useNetworkStore((s) => s.setPanel);

  const related = linesConnectedTo(ssId, allLines);
  const relatedKey = related.map((l) => `${l.id}:${l.version}`).join('|');
  const existingDraft = personalDraftForAsset('substation', ssId);
  const draftStale = existingDraft
    ? isDraftStale(existingDraft, { substations: substationsLive, lines: linesLive })
    : null;

  const [name, setName] = useState(ss?.name ?? '');
  const [voltageCode, setVoltageCode] = useState<VoltageCode>(ss?.voltageCode ?? '33');
  const [status, setStatus] = useState<AssetLifecycle>(ss?.status ?? 'existing');
  const [transformers, setTransformers] = useState(ss?.transformers ?? []);
  const [loadingPct, setLoadingPct] = useState(ss?.loadingPct == null ? '' : String(ss.loadingPct));
  const [commissionYear, setCommissionYear] = useState(
    ss?.commissionYear == null ? '' : String(ss.commissionYear),
  );
  const [orgUnitId, setOrgUnitId] = useState(ss?.orgUnitId ?? '');
  const [proposalRef, setProposalRef] = useState(ss?.proposalRef ?? '');
  const [owner, setOwner] = useState(ss?.owner ?? '');
  const [remarks, setRemarks] = useState(ss?.remarks ?? '');
  const [latText, setLatText] = useState(ss ? ss.lat.toFixed(6) : '');
  const [lngText, setLngText] = useState(ss ? ss.lng.toFixed(6) : '');
  const [lineDrafts, setLineDrafts] = useState<LineDraft[]>(() => related.map(lineToDraft));
  const [draftComment, setDraftComment] = useState(existingDraft?.comment ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!ss) return;
    setName(ss.name);
    setVoltageCode(ss.voltageCode);
    setStatus(ss.status);
    setTransformers(ss.transformers);
    setLoadingPct(ss.loadingPct == null ? '' : String(ss.loadingPct));
    setCommissionYear(ss.commissionYear == null ? '' : String(ss.commissionYear));
    setOrgUnitId(ss.orgUnitId ?? '');
    setProposalRef(ss.proposalRef);
    setOwner(ss.owner);
    setRemarks(ss.remarks);
    setLatText(ss.lat.toFixed(6));
    setLngText(ss.lng.toFixed(6));
    setError(null);
  }, [ss?.id, ss?.version, ss?.updatedAt, ss?.lat, ss?.lng]);

  useEffect(() => {
    setLineDrafts(related.map(lineToDraft));
    // relatedKey captures id+version of connected lines
  }, [ssId, relatedKey]);

  useEffect(() => {
    setDraftComment(existingDraft?.comment ?? '');
  }, [existingDraft?.id, existingDraft?.updatedAt]);

  if (!ss) return <EmptyProps />;

  const coords = parseCoordPair(latText, lngText);
  const ssDirty =
    name !== ss.name ||
    voltageCode !== ss.voltageCode ||
    status !== ss.status ||
    loadingPct !== (ss.loadingPct == null ? '' : String(ss.loadingPct)) ||
    commissionYear !== (ss.commissionYear == null ? '' : String(ss.commissionYear)) ||
    (orgUnitId || null) !== (ss.orgUnitId ?? null) ||
    proposalRef !== ss.proposalRef ||
    owner !== ss.owner ||
    remarks !== ss.remarks ||
    JSON.stringify(transformers) !== JSON.stringify(ss.transformers) ||
    !coords ||
    coords.lat !== Number(ss.lat.toFixed(6)) ||
    coords.lng !== Number(ss.lng.toFixed(6));

  const dirtyLines = lineDrafts.filter((d) => {
    const orig = related.find((l) => l.id === d.id);
    if (!orig) return false;
    return (
      d.name !== orig.name ||
      d.status !== orig.status ||
      d.voltageCode !== orig.voltageCode ||
      d.conductor !== orig.conductor ||
      d.loadingPct !== (orig.loadingPct == null ? '' : String(orig.loadingPct))
    );
  });

  const dirty = ssDirty || dirtyLines.length > 0;
  const canEdit =
    adminMode && (adminRole === 'super' || editorCanEditSs(ssId));
  const outOfScope = adminMode && adminRole === 'editor' && !editorCanEditSs(ssId);
  const isEditor = adminRole === 'editor';

  const patchLineDraft = (id: string, patch: Partial<LineDraft>) => {
    setLineDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  };

  const applyStoredDraft = () => {
    const payloadSs = existingDraft?.payload.ss;
    const payloadLines = existingDraft?.payload.relatedLines;
    if (!payloadSs) {
      flashStatus('Draft has no substation payload');
      return;
    }
    setName(payloadSs.name);
    setVoltageCode(payloadSs.voltageCode);
    setStatus(payloadSs.status);
    setTransformers(payloadSs.transformers);
    setLoadingPct(payloadSs.loadingPct == null ? '' : String(payloadSs.loadingPct));
    setCommissionYear(payloadSs.commissionYear == null ? '' : String(payloadSs.commissionYear));
    setOrgUnitId(payloadSs.orgUnitId ?? '');
    setProposalRef(payloadSs.proposalRef);
    setOwner(payloadSs.owner);
    setRemarks(payloadSs.remarks);
    setLatText(payloadSs.lat.toFixed(6));
    setLngText(payloadSs.lng.toFixed(6));
    if (payloadLines?.length) {
      setLineDrafts(payloadLines.map(lineToDraft));
    }
    setDraftComment(existingDraft.comment);
    flashStatus('Draft loaded into form');
  };

  const save = async () => {
    if (!canEdit) {
      flashStatus('Unlock in Settings to edit');
      setPanel('settings');
      return;
    }
    const parsed = parseCoordPair(latText, lngText);
    if (!parsed) {
      setError('Enter valid latitude (−90…90) and longitude (−180…180).');
      return;
    }
    if (isEditor && !draftComment.trim()) {
      setError('Add a personal comment before saving the draft.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const nextSs: typeof ss = {
        ...ss,
        name: name.trim() || ss.name,
        voltageCode,
        status,
        transformers,
        loadingPct: loadingPct === '' ? null : Number(loadingPct),
        commissionYear: commissionYear === '' ? null : Number(commissionYear),
        orgUnitId: orgUnitId || null,
        proposalRef,
        owner,
        remarks,
        lat: parsed.lat,
        lng: parsed.lng,
      };
      const nextLines = lineDrafts.map((d) => {
        const orig = related.find((l) => l.id === d.id)!;
        return {
          ...orig,
          name: d.name.trim() || orig.name,
          status: d.status,
          voltageCode: d.voltageCode,
          conductor: d.conductor,
          loadingPct: d.loadingPct === '' ? null : Number(d.loadingPct),
        };
      });
      const result = isEditor
        ? await savePersonalDraftBundle(nextSs, nextLines, draftComment)
        : await saveSubstationBundle(nextSs, nextLines);
      flashStatus(result.message);
      if (!result.ok) setError(result.message);
    } finally {
      setSaving(false);
    }
  };

  const otherIdOf = (line: TrunkLine) => (line.fromId === ss.id ? line.toId : line.fromId);

  const corridorGroups = (() => {
    const map = new Map<string, TrunkLine[]>();
    for (const l of related) {
      const key = otherIdOf(l);
      const g = map.get(key) ?? [];
      g.push(l);
      map.set(key, g);
    }
    return [...map.entries()].map(([otherId, lines]) => ({
      otherId,
      remoteName: substations.find((s) => s.id === otherId)?.name ?? '—',
      lines: [...lines].sort(
        (a, b) => a.circuitCount - b.circuitCount || a.name.localeCompare(b.name),
      ),
    }));
  })();

  return (
    <div className={`form-stack${canEdit ? '' : ' is-readonly'}`}>
      {!canEdit && (
        <p className="readonly-banner">
          {outOfScope
            ? 'Outside your authorized area — view only.'
            : 'View only. Unlock in Settings to edit this substation and related lines.'}
        </p>
      )}
      {isEditor && canEdit && (
        <p className="muted">
          Saves stay on this device only (personal drafts). Promote to a suggestion for review comes
          later — live map is unchanged.
        </p>
      )}
      {isEditor && existingDraft && (
        <div className={`admin-box${draftStale?.stale ? ' draft-stale' : ''}`}>
          <p className="section-label">On-device draft</p>
          {draftStale?.stale ? (
            <p className="field-error">
              Live map changed since this draft:{' '}
              {draftStale.details.slice(0, 2).join('; ')}
              {draftStale.details.length > 2 ? '…' : ''}
            </p>
          ) : (
            <p className="muted">Saved {new Date(existingDraft.updatedAt).toLocaleString()}</p>
          )}
          <p className="muted">{existingDraft.comment}</p>
          <div className="form-actions">
            <button type="button" className="primary-btn ghost" onClick={applyStoredDraft}>
              Load into form
            </button>
            <button
              type="button"
              className="danger-btn"
              onClick={() => void discardPersonalDraft(existingDraft.id)}
            >
              Discard draft
            </button>
          </div>
        </div>
      )}
      <fieldset disabled={!canEdit} className="form-fieldset">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="field-row">
          <Field label="Voltage">
            <select
              value={voltageCode}
              onChange={(e) => {
                const next = e.target.value as VoltageCode;
                setVoltageCode(next);
                // Suggest owner only when blank
                if (!owner.trim()) {
                  if (next === '33') setOwner('WBSEDCL');
                  else if (next === '132' || next === '220' || next === '66') setOwner('WBSETCL');
                }
              }}
            >
              {VOLTAGE_CATALOG.map((v) => (
                <option key={v.code} value={v.code}>
                  {v.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value as AssetLifecycle)}>
              <option value="existing">Existing</option>
              <option value="proposed">Proposed</option>
              <option value="retired">Retired</option>
            </select>
          </Field>
        </div>

        <div className="field-row">
          <Field label="Latitude">
            <input inputMode="decimal" value={latText} onChange={(e) => setLatText(e.target.value)} />
          </Field>
          <Field label="Longitude">
            <input inputMode="decimal" value={lngText} onChange={(e) => setLngText(e.target.value)} />
          </Field>
        </div>

        <Field label="Capacity">
          <input value={formatCapacity(transformers)} readOnly title="Edit units below" />
        </Field>
        <div className="xfmr-editor">
          {transformers.map((t, idx) => (
            <div key={t.id} className="xfmr-row">
              <input
                type="number"
                min={1}
                value={t.quantity}
                onChange={(e) => {
                  setTransformers(
                    transformers.map((x, i) =>
                      i === idx ? { ...x, quantity: Number(e.target.value) || 1 } : x,
                    ),
                  );
                }}
              />
              <span>×</span>
              <input
                type="number"
                step="0.1"
                min={0.1}
                value={t.ratingMva}
                onChange={(e) => {
                  setTransformers(
                    transformers.map((x, i) =>
                      i === idx ? { ...x, ratingMva: Number(e.target.value) || 0.1 } : x,
                    ),
                  );
                }}
              />
              <span>MVA</span>
              <button
                type="button"
                className="xfmr-delete-btn"
                title="Remove transformer unit"
                aria-label="Remove transformer unit"
                disabled={transformers.length <= 1}
                onClick={() =>
                  setTransformers(
                    transformers
                      .filter((_, i) => i !== idx)
                      .map((x, i) => ({ ...x, sequence: i + 1 })),
                  )
                }
              >
                <X size={14} strokeWidth={2.5} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="text-btn"
            onClick={() =>
              setTransformers([
                ...transformers,
                {
                  id: crypto.randomUUID(),
                  ratingMva: 10,
                  quantity: 1,
                  sequence: transformers.length + 1,
                },
              ])
            }
          >
            + Add transformer unit
          </button>
        </div>
        <div className="field-row">
          <Field label="Loading %">
            <input type="number" value={loadingPct} onChange={(e) => setLoadingPct(e.target.value)} />
          </Field>
          <Field label="Commission year">
            <input
              type="number"
              value={commissionYear}
              onChange={(e) => setCommissionYear(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Division / org">
          <select value={orgUnitId} onChange={(e) => setOrgUnitId(e.target.value)}>
            <option value="">—</option>
            {orgUnits
              .filter((o) => o.type === 'division' || o.type === 'ccc')
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Ownership">
          <OwnerSelect
            value={owner}
            onChange={setOwner}
            disabled={!canEdit}
          />
        </Field>
        <Field label="Proposed Improvement">
          <input
            value={proposalRef}
            onChange={(e) => setProposalRef(e.target.value)}
            placeholder="e.g. Augmentation 2×10 MVA, new bay…"
          />
        </Field>
        <Field label="Remarks">
          <textarea rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </Field>

        <p className="section-label">
          Related lines ({related.length})
        </p>
        <div className="related-lines">
          {related.length === 0 && <p className="muted">No connected trunk lines.</p>}
          {corridorGroups.map((group) => {
            const isMulti = group.lines.length > 1;

            return (
              <div
                key={group.otherId}
                className={`related-corridor${isMulti ? ' is-double' : ''}`}
              >
                <div className="related-corridor-head">
                  <h4>
                    ↔ {group.remoteName}
                    {isMulti ? ` · Double circuit` : ''}
                  </h4>
                </div>
                {isMulti && (
                  <p className="muted circuit-hint">Ckt 1 and Ckt 2 shown below</p>
                )}
                {group.lines.map((orig, i) => {
                  const d = lineDrafts.find((x) => x.id === orig.id);
                  if (!d) return null;
                  const cktLabel = isMulti ? `Ckt ${i + 1}` : null;
                  return (
                    <div
                      key={d.id}
                      id={`related-ckt-${d.id}`}
                      className="related-line-card"
                    >
                      {cktLabel && (
                        <p className="ckt-editing-label">
                          {cktLabel}
                          {orig.conductor ? ` · ${orig.conductor}` : ''}
                          {orig.lengthKm != null ? ` · ${orig.lengthKm.toFixed(2)} km` : ''}
                        </p>
                      )}
                      {!isMulti && (
                        <h4>
                          {orig.lengthKm?.toFixed(2) ?? '—'} km
                          {orig.conductor ? ` · ${orig.conductor}` : ''}
                        </h4>
                      )}
                      <Field label={cktLabel ? `Name (${cktLabel})` : 'Name'}>
                        <input
                          value={d.name}
                          onChange={(e) => patchLineDraft(d.id, { name: e.target.value })}
                        />
                      </Field>
                      <div className="field-row">
                        <Field label="Voltage">
                          <select
                            value={d.voltageCode}
                            onChange={(e) =>
                              patchLineDraft(d.id, {
                                voltageCode: e.target.value as VoltageCode,
                              })
                            }
                          >
                            {VOLTAGE_CATALOG.map((v) => (
                              <option key={v.code} value={v.code}>
                                {v.label}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label="Status">
                          <select
                            value={d.status}
                            onChange={(e) =>
                              patchLineDraft(d.id, {
                                status: e.target.value as AssetLifecycle,
                              })
                            }
                          >
                            <option value="existing">Existing</option>
                            <option value="proposed">Proposed</option>
                          </select>
                        </Field>
                      </div>
                      <div className="field-row">
                        <Field label={cktLabel ? `Conductor (${cktLabel})` : 'Conductor'}>
                          <input
                            value={d.conductor}
                            onChange={(e) =>
                              patchLineDraft(d.id, { conductor: e.target.value })
                            }
                          />
                        </Field>
                        <Field label="Loading %">
                          <input
                            type="number"
                            value={d.loadingPct}
                            onChange={(e) =>
                              patchLineDraft(d.id, { loadingPct: e.target.value })
                            }
                          />
                        </Field>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </fieldset>

      {error && <p className="field-error">{error}</p>}

      {isEditor && canEdit && (
        <Field label="Personal comment (required for drafts)">
          <textarea
            rows={2}
            value={draftComment}
            onChange={(e) => setDraftComment(e.target.value)}
            placeholder="Why this change — stays on this device"
          />
        </Field>
      )}

      <div className="form-actions">
        <button
          type="button"
          className="primary-btn"
          disabled={!canEdit || !dirty || saving || (isEditor && !draftComment.trim())}
          onClick={() => void save()}
        >
          {saving
            ? 'Saving…'
            : isEditor
              ? 'Save to my drafts'
              : dirtyLines.length
                ? 'Save SS & related lines'
                : 'Save / Update'}
        </button>
        <button
          type="button"
          className="danger-btn"
          disabled={!canEdit}
          onClick={() => requestDelete({ kind: 'substation', id: ss.id })}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

type CircuitDraft = {
  id: string;
  name: string;
  status: AssetLifecycle;
  voltageCode: VoltageCode;
  circuitCount: number;
  circuitConfig: 'single' | 'double';
  conductor: string;
  loadingPct: string;
  proposalRef: string;
  remarks: string;
};

function lineToCircuitDraft(line: TrunkLine): CircuitDraft {
  return {
    id: line.id,
    name: line.name,
    status: line.status,
    voltageCode: line.voltageCode,
    circuitCount: line.circuitCount,
    circuitConfig: line.circuitConfig,
    conductor: line.conductor,
    loadingPct: line.loadingPct == null ? '' : String(line.loadingPct),
    proposalRef: line.proposalRef,
    remarks: line.remarks,
  };
}

function LinePropertiesForm({ lineId }: { lineId: string }) {
  const line = useNetworkStore((s) => s.lines.find((x) => x.id === lineId));
  const allLines = useNetworkStore((s) => s.lines);
  const substations = useNetworkStore((s) => s.substations);
  const adminMode = useNetworkStore((s) => s.adminMode);
  const adminRole = useNetworkStore((s) => s.adminRole);
  const editorCanEditLine = useNetworkStore((s) => s.editorCanEditLine);
  const updateLine = useNetworkStore((s) => s.updateLine);
  const savePersonalDraftLine = useNetworkStore((s) => s.savePersonalDraftLine);
  const personalDraftForAsset = useNetworkStore((s) => s.personalDraftForAsset);
  const discardPersonalDraft = useNetworkStore((s) => s.discardPersonalDraft);
  const substationsLive = useNetworkStore((s) => s.substations);
  const linesLive = useNetworkStore((s) => s.lines);
  const requestDelete = useNetworkStore((s) => s.requestDelete);
  const flashStatus = useNetworkStore((s) => s.flashStatus);
  const setPanel = useNetworkStore((s) => s.setPanel);
  const setSelection = useNetworkStore((s) => s.setSelection);

  const siblings = line
    ? allLines
        .filter(
          (l) =>
            (l.fromId === line.fromId && l.toId === line.toId) ||
            (l.fromId === line.toId && l.toId === line.fromId),
        )
        .sort((a, b) => a.circuitCount - b.circuitCount || a.name.localeCompare(b.name))
    : [];
  const isDouble = siblings.length > 1;
  const siblingKey = siblings.map((l) => `${l.id}:${l.version}`).join('|');
  const existingDraft = personalDraftForAsset('line', lineId);
  const draftStale = existingDraft
    ? isDraftStale(existingDraft, { substations: substationsLive, lines: linesLive })
    : null;
  const isEditor = adminRole === 'editor';
  const canEditLine =
    adminMode && (adminRole === 'super' || (line ? editorCanEditLine(line.id) : false));

  const [drafts, setDrafts] = useState<CircuitDraft[]>(() =>
    (siblings.length ? siblings : line ? [line] : []).map(lineToCircuitDraft),
  );
  const [draftComment, setDraftComment] = useState(existingDraft?.comment ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const source = siblings.length ? siblings : line ? [line] : [];
    setDrafts(source.map(lineToCircuitDraft));
  }, [siblingKey, lineId]);

  useEffect(() => {
    setDraftComment(existingDraft?.comment ?? '');
  }, [existingDraft?.id, existingDraft?.updatedAt]);

  if (!line) return <EmptyProps />;

  const from = substations.find((s) => s.id === line.fromId);
  const to = substations.find((s) => s.id === line.toId);
  const circuitList = siblings.length ? siblings : [line];

  const patchDraft = (id: string, patch: Partial<CircuitDraft>) => {
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  };

  const dirtyDrafts = drafts.filter((d) => {
    const orig = circuitList.find((l) => l.id === d.id);
    if (!orig) return false;
    return (
      d.name !== orig.name ||
      d.status !== orig.status ||
      d.voltageCode !== orig.voltageCode ||
      d.circuitCount !== orig.circuitCount ||
      d.circuitConfig !== orig.circuitConfig ||
      d.conductor !== orig.conductor ||
      d.loadingPct !== (orig.loadingPct == null ? '' : String(orig.loadingPct)) ||
      d.proposalRef !== orig.proposalRef ||
      d.remarks !== orig.remarks
    );
  });

  const applyStoredDraft = () => {
    const payloadLine = existingDraft?.payload.line;
    if (!payloadLine) {
      flashStatus('Draft has no feeder payload');
      return;
    }
    setDrafts((prev) =>
      prev.map((d) => (d.id === payloadLine.id ? lineToCircuitDraft(payloadLine) : d)),
    );
    setDraftComment(existingDraft.comment);
    flashStatus('Draft loaded into form');
  };

  const save = async () => {
    if (!adminMode) {
      flashStatus('Unlock in Settings to edit');
      setPanel('settings');
      return;
    }
    if (!dirtyDrafts.length) return;
    if (isEditor && !draftComment.trim()) {
      setError('Add a personal comment before saving the draft.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      if (isEditor) {
        let lastMsg = '';
        for (const d of dirtyDrafts) {
          if (!editorCanEditLine(d.id)) {
            setError(`Feeder “${d.name}” is outside your authorized area`);
            return;
          }
          const orig = circuitList.find((l) => l.id === d.id)!;
          const next = {
            ...orig,
            name: d.name.trim() || orig.name,
            voltageCode: d.voltageCode,
            status: d.status,
            circuitCount: Number(d.circuitCount) || 1,
            circuitConfig: isDouble ? ('double' as const) : d.circuitConfig,
            conductor: d.conductor,
            loadingPct: d.loadingPct === '' ? null : Number(d.loadingPct),
            proposalRef: d.proposalRef,
            remarks: d.remarks,
          };
          const result = await savePersonalDraftLine(next, draftComment);
          lastMsg = result.message;
          if (!result.ok) {
            setError(result.message);
            flashStatus(result.message);
            return;
          }
        }
        flashStatus(lastMsg || 'Saved on this device only — not on the live map');
        return;
      }
      for (const d of dirtyDrafts) {
        const orig = circuitList.find((l) => l.id === d.id)!;
        await updateLine(d.id, {
          name: d.name.trim() || orig.name,
          voltageCode: d.voltageCode,
          status: d.status,
          circuitCount: Number(d.circuitCount) || 1,
          circuitConfig: isDouble ? 'double' : d.circuitConfig,
          conductor: d.conductor,
          loadingPct: d.loadingPct === '' ? null : Number(d.loadingPct),
          proposalRef: d.proposalRef,
          remarks: d.remarks,
        });
      }
      flashStatus(
        isDouble
          ? `Saved ${dirtyDrafts.length} circuit${dirtyDrafts.length > 1 ? 's' : ''}`
          : 'Line updated',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="form-stack">
      {!adminMode && (
        <p className="readonly-banner">
          View only. Unlock in Settings to edit lines.
        </p>
      )}
      {isEditor && canEditLine && (
        <p className="muted">
          Saves stay on this device only (personal drafts). Live map is unchanged until promote →
          suggestion is available later.
        </p>
      )}
      {isEditor && existingDraft && (
        <div className={`admin-box${draftStale?.stale ? ' draft-stale' : ''}`}>
          <p className="section-label">On-device draft</p>
          {draftStale?.stale ? (
            <p className="field-error">
              Live map changed since this draft:{' '}
              {draftStale.details.slice(0, 2).join('; ')}
            </p>
          ) : (
            <p className="muted">Saved {new Date(existingDraft.updatedAt).toLocaleString()}</p>
          )}
          <p className="muted">{existingDraft.comment}</p>
          <div className="form-actions">
            <button type="button" className="primary-btn ghost" onClick={applyStoredDraft}>
              Load into form
            </button>
            <button
              type="button"
              className="danger-btn"
              onClick={() => void discardPersonalDraft(existingDraft.id)}
            >
              Discard draft
            </button>
          </div>
        </div>
      )}

      <div className="endpoint-coords">
        <div>
          <span className="muted">From · {from?.name ?? '—'}</span>
          <strong className="coords">
            {from ? `${from.lat.toFixed(6)}, ${from.lng.toFixed(6)}` : '—'}
          </strong>
        </div>
        <div>
          <span className="muted">To · {to?.name ?? '—'}</span>
          <strong className="coords">
            {to ? `${to.lat.toFixed(6)}, ${to.lng.toFixed(6)}` : '—'}
          </strong>
        </div>
      </div>

      {isDouble && (
        <p className="section-label">
          Double circuit · {circuitList.length} feeders
        </p>
      )}

      <fieldset disabled={!adminMode} className="form-fieldset double-ckt-stack">
        {drafts.map((d, i) => {
          const orig = circuitList.find((l) => l.id === d.id);
          const selected = d.id === line.id;
          return (
            <div
              key={d.id}
              className={`related-line-card double-ckt-card${selected ? ' is-active-ckt' : ''}`}
              onClick={() => {
                if (d.id !== line.id) setSelection({ kind: 'line', id: d.id });
              }}
            >
              <p className="ckt-editing-label">
                {isDouble ? `Ckt ${i + 1}` : 'Line'}
                {orig?.conductor ? ` · ${orig.conductor}` : ''}
                {orig?.lengthKm != null ? ` · ${orig.lengthKm.toFixed(2)} km` : ''}
              </p>
              <Field label="Name">
                <input
                  value={d.name}
                  onChange={(e) => patchDraft(d.id, { name: e.target.value })}
                  onFocus={() => {
                    if (d.id !== line.id) setSelection({ kind: 'line', id: d.id });
                  }}
                />
              </Field>
              <div className="field-row">
                <Field label="Voltage">
                  <select
                    value={d.voltageCode}
                    onChange={(e) =>
                      patchDraft(d.id, { voltageCode: e.target.value as VoltageCode })
                    }
                  >
                    {VOLTAGE_CATALOG.map((v) => (
                      <option key={v.code} value={v.code}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Status">
                  <select
                    value={d.status}
                    onChange={(e) =>
                      patchDraft(d.id, { status: e.target.value as AssetLifecycle })
                    }
                  >
                    <option value="existing">Existing</option>
                    <option value="proposed">Proposed</option>
                  </select>
                </Field>
              </div>
              {!isDouble && (
                <div className="field-row">
                  <Field label="Circuit #">
                    <input
                      type="number"
                      min={1}
                      value={d.circuitCount}
                      onChange={(e) =>
                        patchDraft(d.id, { circuitCount: Number(e.target.value) || 1 })
                      }
                    />
                  </Field>
                  <Field label="Config">
                    <select
                      value={d.circuitConfig}
                      onChange={(e) =>
                        patchDraft(d.id, {
                          circuitConfig: e.target.value as 'single' | 'double',
                        })
                      }
                    >
                      <option value="single">Single</option>
                      <option value="double">Double</option>
                    </select>
                  </Field>
                </div>
              )}
              {isDouble && (
                <div className="field-row">
                  <Field label="Circuit #">
                    <input type="number" value={i + 1} readOnly />
                  </Field>
                  <Field label="Config">
                    <input value="Double" readOnly />
                  </Field>
                </div>
              )}
              <Field label="Conductor">
                <input
                  value={d.conductor}
                  onChange={(e) => patchDraft(d.id, { conductor: e.target.value })}
                />
              </Field>
              <div className="field-row">
                <Field label="Length (km)">
                  <input type="number" step="0.01" value={orig?.lengthKm ?? ''} readOnly />
                </Field>
                <Field label="Loading %">
                  <input
                    type="number"
                    value={d.loadingPct}
                    onChange={(e) => patchDraft(d.id, { loadingPct: e.target.value })}
                  />
                </Field>
              </div>
              <Field label="Proposal">
                <input
                  value={d.proposalRef}
                  onChange={(e) => patchDraft(d.id, { proposalRef: e.target.value })}
                />
              </Field>
              <Field label="Remarks">
                <textarea
                  rows={2}
                  value={d.remarks}
                  onChange={(e) => patchDraft(d.id, { remarks: e.target.value })}
                />
              </Field>
              {isDouble && adminMode && (
                <button
                  type="button"
                  className="text-btn danger-text"
                  onClick={(e) => {
                    e.stopPropagation();
                    requestDelete({ kind: 'line', id: d.id });
                  }}
                >
                  Delete Ckt {i + 1}
                </button>
              )}
            </div>
          );
        })}
      </fieldset>

      {error && <p className="field-error">{error}</p>}

      {isEditor && canEditLine && (
        <Field label="Personal comment (required for drafts)">
          <textarea
            rows={2}
            value={draftComment}
            onChange={(e) => setDraftComment(e.target.value)}
            placeholder="Why this change — stays on this device"
          />
        </Field>
      )}

      <div className="form-actions">
        <button
          type="button"
          className="primary-btn"
          disabled={
            !adminMode ||
            !dirtyDrafts.length ||
            saving ||
            (isEditor && !draftComment.trim())
          }
          onClick={() => void save()}
        >
          {saving
            ? 'Saving…'
            : isEditor
              ? 'Save to my drafts'
              : isDouble
                ? dirtyDrafts.length > 1
                  ? 'Save both circuits'
                  : `Save Ckt ${Math.max(1, drafts.findIndex((d) => d.id === dirtyDrafts[0]?.id) + 1)}`
                : 'Save / Update'}
        </button>
        {!isDouble && (
          <button
            type="button"
            className="danger-btn"
            disabled={!adminMode}
            onClick={() => requestDelete({ kind: 'line', id: line.id })}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function PropertiesForm() {
  const selection = useNetworkStore((s) => s.selection)!;
  const substations = useNetworkStore((s) => s.substations);
  const lines = useNetworkStore((s) => s.lines);
  const tapNodes = useNetworkStore((s) => s.tapNodes);
  const tapLaterals = useNetworkStore((s) => s.tapLaterals);
  const updateTapLateral = useNetworkStore((s) => s.updateTapLateral);
  const requestDelete = useNetworkStore((s) => s.requestDelete);

  if (selection.kind === 'substation') {
    const ss = substations.find((s) => s.id === selection.id);
    if (!ss) return <EmptyProps />;
    return <SubstationPropertiesForm key={ss.id} ssId={ss.id} />;
  }

  if (selection.kind === 'line') {
    const line = lines.find((l) => l.id === selection.id);
    if (!line) return <EmptyProps />;
    return <LinePropertiesForm key={line.id} lineId={line.id} />;
  }

  if (selection.kind === 'tap_lateral') {
    const lat = tapLaterals.find((l) => l.id === selection.id);
    if (!lat) return <EmptyProps />;
    return (
      <div className="form-stack">
        <Field label="Name">
          <input value={lat.name} onChange={(e) => void updateTapLateral(lat.id, { name: e.target.value })} />
        </Field>
        <div className="field-row">
          <Field label="Voltage">
            <select
              value={lat.voltageCode}
              onChange={(e) =>
                void updateTapLateral(lat.id, { voltageCode: e.target.value as VoltageCode })
              }
            >
              {VOLTAGE_CATALOG.map((v) => (
                <option key={v.code} value={v.code}>
                  {v.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select
              value={lat.status}
              onChange={(e) =>
                void updateTapLateral(lat.id, { status: e.target.value as AssetLifecycle })
              }
            >
              <option value="existing">Existing</option>
              <option value="proposed">Proposed</option>
            </select>
          </Field>
        </div>
        <Field label="Conductor">
          <input
            value={lat.conductor}
            onChange={(e) => void updateTapLateral(lat.id, { conductor: e.target.value })}
          />
        </Field>
        <Field label="Length (km)">
          <input type="number" value={lat.lengthKm ?? ''} readOnly />
        </Field>
        <Field label="Remarks">
          <textarea
            rows={3}
            value={lat.remarks}
            onChange={(e) => void updateTapLateral(lat.id, { remarks: e.target.value })}
          />
        </Field>
        <button type="button" className="danger-btn" onClick={() => requestDelete(selection)}>
          Delete tap lateral
        </button>
      </div>
    );
  }

  const tap = tapNodes.find((t) => t.id === selection.id);
  if (!tap) return <EmptyProps />;
  return (
    <div className="form-stack">
      <p className="muted">Tap node on parent line</p>
      <Field label="Name">
        <input value={tap.name} readOnly />
      </Field>
      <div className="coords muted">
        ratio {tap.positionRatio.toFixed(3)} · {tap.lat.toFixed(5)}, {tap.lng.toFixed(5)}
      </div>
      <button type="button" className="danger-btn" onClick={() => requestDelete(selection)}>
        Delete tap node
      </button>
    </div>
  );
}

function FiltersForm() {
  const filters = useNetworkStore((s) => s.filters);
  const setFilters = useNetworkStore((s) => s.setFilters);
  const orgUnits = useNetworkStore((s) => s.orgUnits);

  const toggleVoltage = (code: VoltageCode) => {
    const voltages = filters.voltages.includes(code)
      ? filters.voltages.filter((v) => v !== code)
      : [...filters.voltages, code];
    setFilters({ voltages });
  };

  return (
    <div className="form-stack">
      <label className="check-row">
        <input
          type="checkbox"
          checked={filters.showProposed}
          onChange={(e) => setFilters({ showProposed: e.target.checked })}
        />
        Show proposed
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={filters.statuses.includes('existing')}
          onChange={(e) =>
            setFilters({
              statuses: e.target.checked
                ? Array.from(new Set([...filters.statuses, 'existing' as const]))
                : filters.statuses.filter((s) => s !== 'existing'),
            })
          }
        />
        Existing
      </label>
      <div className="chip-group">
        {VOLTAGE_CATALOG.map((v) => (
          <button
            key={v.code}
            type="button"
            className={`chip${filters.voltages.includes(v.code) ? ' on' : ''}`}
            onClick={() => toggleVoltage(v.code)}
          >
            {v.code} kV
          </button>
        ))}
      </div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={filters.overloadedOnly}
          onChange={(e) => setFilters({ overloadedOnly: e.target.checked })}
        />
        Overloaded (≥80%)
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={filters.oldOnly}
          onChange={(e) => setFilters({ oldOnly: e.target.checked })}
        />
        Old assets (&lt;2000)
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={filters.needUpgradeOnly}
          onChange={(e) => setFilters({ needUpgradeOnly: e.target.checked })}
        />
        Need upgradation
      </label>
      <Field label="Division">
        <select
          value={filters.orgUnitIds[0] ?? ''}
          onChange={(e) =>
            setFilters({ orgUnitIds: e.target.value ? [e.target.value] : [] })
          }
        >
          <option value="">All divisions</option>
          {orgUnits
            .filter((o) => o.type === 'division')
            .map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
        </select>
      </Field>
    </div>
  );
}

function LayersForm() {
  const mapLayers = useNetworkStore((s) => s.mapLayers);
  const availableDistricts = useNetworkStore((s) => s.availableDistricts);
  const resetMapView = useNetworkStore((s) => s.resetMapView);
  const districtLabelPositions = useNetworkStore((s) => s.districtLabelPositions);
  const resetDistrictLabelPositions = useNetworkStore((s) => s.resetDistrictLabelPositions);
  const setMapLayers = useNetworkStore((s) => s.setMapLayers);
  const clearDistrictFocus = useNetworkStore((s) => s.clearDistrictFocus);
  const dimAllDistricts = useNetworkStore((s) => s.dimAllDistricts);
  const focusOnlyDistrict = useNetworkStore((s) => s.focusOnlyDistrict);

  const focused = mapLayers.focusedDistricts;
  const focusing = focused.length > 0;
  const allDimmed = mapLayers.dimAllDistricts;

  const setUndimmed = (name: string, undimmed: boolean) => {
    const all = availableDistricts;
    if (allDimmed) {
      if (undimmed) {
        setMapLayers({ dimAllDistricts: false, focusedDistricts: [name] });
      }
      return;
    }
    if (!focusing) {
      if (!undimmed) {
        setMapLayers({ focusedDistricts: all.filter((d) => d !== name) });
      }
      return;
    }
    if (undimmed) {
      const next = focused.includes(name) ? focused : [...focused, name];
      setMapLayers({
        focusedDistricts: next.length >= all.length ? [] : next,
      });
    } else {
      setMapLayers({ focusedDistricts: focused.filter((d) => d !== name) });
    }
  };

  return (
    <div className="form-stack">
      <button type="button" className="primary-btn ghost" onClick={() => resetMapView()}>
        Reset to default look
      </button>
      <p className="muted" style={{ marginTop: 0 }}>
        Clears siting / voltage-check focus, restores Overview scene, resets district label
        positions, and fits the zone.
      </p>
      <p className="section-label">View</p>
      <ViewToggles variant="panel" />

      <p className="muted">
        With the <strong>Select</strong> tool, click a district on the map to undim it (others dim).
        Hold <kbd>Shift</kbd> and click to undim several.
      </p>

      <div className="field">
        <span>Basemap</span>
        <div className="chip-group" style={{ marginTop: 6 }}>
          {(
            [
              { id: 'google', label: 'Google Roads' },
              { id: 'google-hybrid', label: 'Google Hybrid' },
              { id: 'osm', label: 'OpenStreetMap' },
              { id: 'esri', label: 'Light Gray' },
              { id: 'none', label: 'No basemap' },
            ] as const
          ).map((b) => (
            <button
              key={b.id}
              type="button"
              className={`chip${mapLayers.basemap === b.id ? ' on' : ''}`}
              onClick={() => setMapLayers({ basemap: b.id })}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>

      <label className="check-row">
        <input
          type="checkbox"
          checked={mapLayers.showDistricts}
          onChange={(e) => setMapLayers({ showDistricts: e.target.checked })}
        />
        District boundaries
      </label>

      <label className="check-row">
        <input
          type="checkbox"
          checked={mapLayers.showDistrictLabels}
          disabled={!mapLayers.showDistricts}
          onChange={(e) => setMapLayers({ showDistrictLabels: e.target.checked })}
        />
        District name labels
      </label>
      {mapLayers.showDistricts && mapLayers.showDistrictLabels && (
        <p className="muted" style={{ marginTop: 0 }}>
          Drag a name on the map to move it.
          {Object.keys(districtLabelPositions).length > 0 && (
            <>
              {' '}
              <button
                type="button"
                className="text-btn"
                onClick={() => resetDistrictLabelPositions()}
              >
                Reset label positions
              </button>
            </>
          )}
        </p>
      )}

      <label className="check-row">
        <input
          type="checkbox"
          checked={mapLayers.showBlocks}
          onChange={(e) => setMapLayers({ showBlocks: e.target.checked })}
        />
        Block (sub-district) boundaries
      </label>

      <label className="check-row">
        <input
          type="checkbox"
          checked={mapLayers.showBlockLabels}
          disabled={!mapLayers.showBlocks}
          onChange={(e) => setMapLayers({ showBlockLabels: e.target.checked })}
        />
        Block name labels <span className="muted">(zoom in)</span>
      </label>

      <p className="section-label">Network labels</p>
      <label className="check-row">
        <input
          type="checkbox"
          checked={mapLayers.showSsNames}
          onChange={(e) => setMapLayers({ showSsNames: e.target.checked })}
        />
        SS name
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={mapLayers.showSsCapacity}
          onChange={(e) => setMapLayers({ showSsCapacity: e.target.checked })}
        />
        SS capacity
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={mapLayers.showFeederNames}
          onChange={(e) => setMapLayers({ showFeederNames: e.target.checked })}
        />
        Feeder name
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={mapLayers.showFeederLength}
          onChange={(e) => setMapLayers({ showFeederLength: e.target.checked })}
        />
        Feeder length
      </label>

      {mapLayers.showDistricts && availableDistricts.length > 0 && (
        <div className="district-focus-block">
          <div className="district-focus-header">
            <span>District dim / undim</span>
            <div className="district-focus-actions">
              <button type="button" className="text-btn" onClick={dimAllDistricts}>
                Dim all
              </button>
              <button type="button" className="text-btn" onClick={clearDistrictFocus}>
                Undim all
              </button>
            </div>
          </div>
          <p className="muted" style={{ margin: '0 0 8px' }}>
            {allDimmed
              ? 'All dimmed — click a district or tick one to undim'
              : focusing
                ? `${focused.length} undimmed · ${availableDistricts.length - focused.length} dimmed`
                : 'All undimmed'}
          </p>
          <div className="district-check-list">
            {availableDistricts.map((name) => {
              const undimmed = !allDimmed && (!focusing || focused.includes(name));
              return (
                <label key={name} className={`district-check${undimmed ? '' : ' is-dimmed'}`}>
                  <input
                    type="checkbox"
                    checked={undimmed}
                    onChange={(e) => setUndimmed(name, e.target.checked)}
                  />
                  <button
                    type="button"
                    className="district-name-btn"
                    title="Focus only this district"
                    onClick={() => focusOnlyDistrict(name)}
                  >
                    {name}
                  </button>
                </label>
              );
            })}
          </div>
        </div>
      )}

      <label className="check-row">
        <input
          type="checkbox"
          checked={mapLayers.showMask}
          onChange={(e) => setMapLayers({ showMask: e.target.checked })}
        />
        Dim outside West Bengal
      </label>

      <label className="field">
        <span>Mask opacity ({Math.round(mapLayers.maskOpacity * 100)}%)</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={mapLayers.maskOpacity}
          disabled={!mapLayers.showMask}
          onChange={(e) => setMapLayers({ maskOpacity: Number(e.target.value) })}
        />
      </label>
    </div>
  );
}

function SitingForm() {
  const analysis = useNetworkStore((s) => s.sitingAnalysis);
  const busy = useNetworkStore((s) => s.sitingBusy);
  const showOnMap = useNetworkStore((s) => s.showSitingOnMap);
  const focusedId = useNetworkStore((s) => s.focusedSitingId);
  const sitingBasemap = useNetworkStore((s) => s.sitingBasemap);
  const excludeProposed33 = useNetworkStore((s) => s.assessExcludeProposed33);
  const excludeProposed132 = useNetworkStore((s) => s.assessExcludeProposed132);
  const runSitingAnalysis = useNetworkStore((s) => s.runSitingAnalysis);
  const clearSitingAnalysis = useNetworkStore((s) => s.clearSitingAnalysis);
  const setShowSitingOnMap = useNetworkStore((s) => s.setShowSitingOnMap);
  const focusSitingCandidate = useNetworkStore((s) => s.focusSitingCandidate);
  const adoptSitingCandidate = useNetworkStore((s) => s.adoptSitingCandidate);
  const setSitingBasemap = useNetworkStore((s) => s.setSitingBasemap);
  const setAssessExcludeProposed33 = useNetworkStore((s) => s.setAssessExcludeProposed33);
  const setAssessExcludeProposed132 = useNetworkStore((s) => s.setAssessExcludeProposed132);
  const focusOnlyDistrict = useNetworkStore((s) => s.focusOnlyDistrict);
  const toggleDistrictFocus = useNetworkStore((s) => s.toggleDistrictFocus);

  const focusScopeDistricts = () => {
    SITING_DISTRICTS.forEach((name, i) => {
      if (i === 0) focusOnlyDistrict(name);
      else toggleDistrictFocus(name, true);
    });
  };

  return (
    <div className="form-stack">
      <p className="muted">
        Suggests new <strong>33 kV</strong> sites in interior coverage holes — using typical
        neighbour spacing of existing 33 kV substations in {SITING_DISTRICTS.join(', ')}.
        Opening this view dims the network so candidates stay in focus. Sites near the outer
        state/district border are ignored; candidates are spaced ~ that typical distance apart.
      </p>

      <div className="field">
        <span className="section-label">Basemap</span>
        <div className="chip-group" role="group" aria-label="Siting basemap">
          {(
            [
              { id: 'google' as const, label: 'Google map' },
              { id: 'none' as const, label: 'No basemap' },
            ] as const
          ).map((b) => (
            <button
              key={b.id}
              type="button"
              className={`chip${sitingBasemap === b.id ? ' on' : ''}`}
              onClick={() => setSitingBasemap(b.id)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="section-label">Assessment scope</span>
        <label className="check-row">
          <input
            type="checkbox"
            checked={excludeProposed33}
            onChange={(e) => setAssessExcludeProposed33(e.target.checked)}
          />
          Exclude proposed 33 kV SS
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={excludeProposed132}
            onChange={(e) => setAssessExcludeProposed132(e.target.checked)}
          />
          Exclude proposed 132 kV SS
        </label>
        <p className="muted" style={{ marginTop: 4 }}>
          When checked, only existing stations count for coverage (re-run after changing). Shared
          with Check voltage for 33 / 132 kV rules.
        </p>
      </div>

      <div className="btn-row">
        <button
          type="button"
          className="primary-btn"
          disabled={busy}
          onClick={() => void runSitingAnalysis()}
        >
          {busy ? 'Analysing…' : analysis ? 'Re-run analysis' : 'Run analysis'}
        </button>
        <button
          type="button"
          className="primary-btn ghost"
          disabled={busy}
          onClick={focusScopeDistricts}
        >
          Focus districts
        </button>
      </div>

      {analysis && (
        <>
          <div className="siting-stats">
            <div>
              <span className="muted">33 kV SS in scope</span>
              <strong>{analysis.ssCount}</strong>
            </div>
            <div>
              <span className="muted">Typical spacing</span>
              <strong>{analysis.targetSpacingKm.toFixed(1)} km</strong>
            </div>
            <div>
              <span className="muted">Gap threshold</span>
              <strong>{analysis.gapThresholdKm.toFixed(1)} km</strong>
            </div>
            <div>
              <span className="muted">Min site spacing</span>
              <strong>{analysis.candidateSpacingKm.toFixed(1)} km</strong>
            </div>
            <div>
              <span className="muted">Candidates</span>
              <strong>{analysis.candidates.length}</strong>
            </div>
          </div>

          {analysis.message && <p className="muted">{analysis.message}</p>}

          <label className="check-row">
            <input
              type="checkbox"
              checked={showOnMap}
              onChange={(e) => setShowSitingOnMap(e.target.checked)}
            />
            Show candidates on map
          </label>

          <div className="suggestion-list">
            {analysis.candidates.map((c: SitingCandidate) => (
              <div
                key={c.id}
                className={`siting-row${focusedId === c.id ? ' is-focused' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => focusSitingCandidate(c.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    focusSitingCandidate(c.id);
                  }
                }}
              >
                <div>
                  <strong>
                    Gap {c.gapKm.toFixed(1)} km · {c.district}
                  </strong>
                  <p className="muted">
                    {c.lat.toFixed(5)}, {c.lng.toFixed(5)}
                  </p>
                  <ul className="siting-near-list">
                    {(c.nearerSs?.length
                      ? c.nearerSs
                      : [{ id: c.nearestSsId, name: c.nearestSsName, km: c.gapKm }]
                    ).map((n, i) => (
                      <li key={n.id}>
                        <span className="siting-near-rank">{i + 1}.</span>
                        <span className="siting-near-name">{n.name}</span>
                        <span className="siting-near-km">{n.km.toFixed(1)} km</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="suggestion-actions">
                  <button
                    type="button"
                    className="text-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      adoptSitingCandidate(c.id);
                    }}
                  >
                    Place here
                  </button>
                </div>
              </div>
            ))}
          </div>

          <button
            type="button"
            className="primary-btn ghost"
            onClick={clearSitingAnalysis}
          >
            Clear results
          </button>
        </>
      )}
    </div>
  );
}

function VoltageCheckForm() {
  const analysis = useNetworkStore((s) => s.voltageCheckAnalysis);
  const busy = useNetworkStore((s) => s.voltageCheckBusy);
  const showOnMap = useNetworkStore((s) => s.showVoltageCheckOnMap);
  const list = useNetworkStore((s) => s.voltageCheckList);
  const focusedId = useNetworkStore((s) => s.focusedVoltageCheckId);
  const selectedDistricts = useNetworkStore((s) => s.voltageCheckDistricts);
  const cutOffKm = useNetworkStore((s) => s.voltageCheckCutOffKm);
  const voltageCheckBasemap = useNetworkStore((s) => s.voltageCheckBasemap);
  const excludeProposed33 = useNetworkStore((s) => s.assessExcludeProposed33);
  const excludeProposed132 = useNetworkStore((s) => s.assessExcludeProposed132);
  const availableDistricts = useNetworkStore((s) => s.availableDistricts);
  const runVoltageCheckAnalysis = useNetworkStore((s) => s.runVoltageCheckAnalysis);
  const clearVoltageCheckAnalysis = useNetworkStore((s) => s.clearVoltageCheckAnalysis);
  const setShowVoltageCheckOnMap = useNetworkStore((s) => s.setShowVoltageCheckOnMap);
  const focusVoltageCheckCell = useNetworkStore((s) => s.focusVoltageCheckCell);
  const setVoltageCheckDistricts = useNetworkStore((s) => s.setVoltageCheckDistricts);
  const toggleVoltageCheckDistrict = useNetworkStore((s) => s.toggleVoltageCheckDistrict);
  const setVoltageCheckCutOffKm = useNetworkStore((s) => s.setVoltageCheckCutOffKm);
  const setVoltageCheckBasemap = useNetworkStore((s) => s.setVoltageCheckBasemap);
  const setAssessExcludeProposed33 = useNetworkStore((s) => s.setAssessExcludeProposed33);
  const setAssessExcludeProposed132 = useNetworkStore((s) => s.setAssessExcludeProposed132);
  const focusOnlyDistrict = useNetworkStore((s) => s.focusOnlyDistrict);
  const toggleDistrictFocus = useNetworkStore((s) => s.toggleDistrictFocus);

  const districtOptions = (
    availableDistricts.length ? availableDistricts : [...SITING_DISTRICTS]
  )
    .slice()
    .sort((a, b) => a.localeCompare(b));

  const [cutOffText, setCutOffText] = useState(
    cutOffKm != null ? String(cutOffKm) : '',
  );
  const autoCutOff = cutOffKm == null;

  useEffect(() => {
    setCutOffText(cutOffKm != null ? String(cutOffKm) : '');
  }, [cutOffKm]);

  const focusScopeDistricts = () => {
    const names = selectedDistricts.length ? selectedDistricts : [...SITING_DISTRICTS];
    names.forEach((name, i) => {
      if (i === 0) focusOnlyDistrict(name);
      else toggleDistrictFocus(name, true);
    });
  };

  const applyCutOffFromText = (raw: string) => {
    const t = raw.trim();
    if (!t) {
      setVoltageCheckCutOffKm(null);
      return;
    }
    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0) {
      setVoltageCheckCutOffKm(null);
      setCutOffText('');
      return;
    }
    setVoltageCheckCutOffKm(n);
  };

  const run = () => {
    applyCutOffFromText(cutOffText);
    focusScopeDistricts();
    void runVoltageCheckAnalysis();
  };

  const exportList = () => {
    const exportDistricts = selectedDistricts.length
      ? selectedDistricts
      : [...new Set(list.map((c) => c.district).filter(Boolean))];
    downloadCsv(
      voltageCheckCsvFilename(exportDistricts),
      [
        'Area / district',
        'Nearest 33 kV SS',
        'Distance km',
        'Also far from 132 kV',
        'Nearest 132 kV SS',
        'Distance to 132 km',
        'Lat',
        'Lng',
      ],
      list.map((c: VoltageCheckCell) => [
        c.district,
        c.nearest33Name,
        c.dist33Km.toFixed(2),
        c.farFrom132 ? 'yes' : '',
        c.nearest132Name ?? '',
        c.dist132Km != null ? c.dist132Km.toFixed(2) : '',
        c.lat,
        c.lng,
      ]),
    );
  };

  return (
    <div className="form-stack">
      <p className="muted">
        Inspection view of how far places sit from the nearest <strong>in-service 33 kV</strong>{' '}
        substation. Pick any district(s) and a cut-off (or leave Auto). Colour marks far tails —
        not measured voltage. Use Google map for place names, or no basemap for a clearer wash.
      </p>

      <div className="field">
        <span className="section-label">Basemap</span>
        <div className="chip-group" role="group" aria-label="Voltage check basemap">
          {(
            [
              { id: 'google' as const, label: 'Google map' },
              { id: 'none' as const, label: 'No basemap' },
            ] as const
          ).map((b) => (
            <button
              key={b.id}
              type="button"
              className={`chip${voltageCheckBasemap === b.id ? ' on' : ''}`}
              onClick={() => setVoltageCheckBasemap(b.id)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="section-label">Assessment scope</span>
        <label className="check-row">
          <input
            type="checkbox"
            checked={excludeProposed33}
            onChange={(e) => setAssessExcludeProposed33(e.target.checked)}
          />
          Exclude proposed 33 kV SS
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={excludeProposed132}
            onChange={(e) => setAssessExcludeProposed132(e.target.checked)}
          />
          Exclude proposed 132 kV SS
        </label>
        <p className="muted" style={{ marginTop: 4 }}>
          When checked, only existing stations count (re-run after changing). Shared with 33 kV
          Siting.
        </p>
      </div>

      <label className="field">
        <span className="section-label">Cut-off from nearest 33 kV</span>
        <div className="btn-row" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="number"
            min={1}
            max={80}
            step={0.5}
            placeholder="Auto"
            disabled={autoCutOff}
            value={autoCutOff ? '' : cutOffText}
            onChange={(e) => setCutOffText(e.target.value)}
            onBlur={(e) => applyCutOffFromText(e.target.value)}
            style={{ flex: 1, minWidth: 0 }}
          />
          <span className="muted">km</span>
        </div>
        <label className="check-row" style={{ marginTop: 6 }}>
          <input
            type="checkbox"
            checked={autoCutOff}
            onChange={(e) => {
              if (e.target.checked) {
                setVoltageCheckCutOffKm(null);
                setCutOffText('');
              } else {
                const seed = analysis?.cutOffKm ?? 8;
                setVoltageCheckCutOffKm(seed);
                setCutOffText(String(Number(seed.toFixed(1))));
              }
            }}
          />
          Auto from typical 33 kV spacing
          {analysis && autoCutOff ? ` (${analysis.cutOffKm.toFixed(1)} km last run)` : ''}
        </label>
      </label>

      <div className="field">
        <div className="district-focus-header">
          <span className="section-label">Districts</span>
          <span className="btn-row">
            <button
              type="button"
              className="text-btn"
              onClick={() => setVoltageCheckDistricts([...SITING_DISTRICTS])}
            >
              Study trio
            </button>
            <button
              type="button"
              className="text-btn"
              onClick={() => setVoltageCheckDistricts(districtOptions)}
            >
              All
            </button>
          </span>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          {selectedDistricts.length} selected · tick any district below
        </p>
        <div className="district-check-list voltage-check-districts">
          {districtOptions.map((name) => {
            const on = selectedDistricts.some((d) => d.toLowerCase() === name.toLowerCase());
            return (
              <label key={name} className={`district-check${on ? '' : ' is-dimmed'}`}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggleVoltageCheckDistrict(name)}
                />
                <span>{name}</span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="btn-row">
        <button
          type="button"
          className="primary-btn"
          disabled={busy || selectedDistricts.length === 0}
          onClick={run}
        >
          {busy ? 'Analysing…' : analysis ? 'Re-run check' : 'Run check'}
        </button>
        <button
          type="button"
          className="primary-btn ghost"
          disabled={busy || selectedDistricts.length === 0}
          onClick={focusScopeDistricts}
        >
          Focus districts
        </button>
      </div>

      {analysis && (
        <>
          <div className="siting-stats">
            <div>
              <span className="muted">33 kV SS in scope</span>
              <strong>{analysis.ss33Count}</strong>
            </div>
            <div>
              <span className="muted">Typical spacing</span>
              <strong>{analysis.targetSpacingKm.toFixed(1)} km</strong>
            </div>
            <div>
              <span className="muted">Cut-off used</span>
              <strong>{analysis.cutOffKm.toFixed(1)} km</strong>
            </div>
            <div>
              <span className="muted">Districts</span>
              <strong>{analysis.districts.length}</strong>
            </div>
            <div>
              <span className="muted">Far cells</span>
              <strong>{analysis.cells.length}</strong>
            </div>
            <div>
              <span className="muted">List rows</span>
              <strong>{list.length}</strong>
            </div>
          </div>

          {analysis.message && <p className="muted">{analysis.message}</p>}

          <label className="check-row">
            <input
              type="checkbox"
              checked={showOnMap}
              onChange={(e) => setShowVoltageCheckOnMap(e.target.checked)}
            />
            Show wash on map
          </label>

          <div className="btn-row">
            <button
              type="button"
              className="primary-btn ghost"
              disabled={list.length === 0}
              onClick={exportList}
            >
              Export CSV
            </button>
          </div>

          <div className="suggestion-list">
            {list.map((c: VoltageCheckCell) => (
              <div
                key={c.id}
                className={`siting-row voltage-check-row${focusedId === c.id ? ' is-focused' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => focusVoltageCheckCell(c.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    focusVoltageCheckCell(c.id);
                  }
                }}
              >
                <div>
                  <strong>
                    {c.dist33Km.toFixed(1)} km · {c.district}
                  </strong>
                  <p className="muted">
                    Nearest 33 kV: {c.nearest33Name}
                    {c.farFrom132 ? ' · also far from 132 kV' : ''}
                  </p>
                </div>
              </div>
            ))}
          </div>

          <button
            type="button"
            className="primary-btn ghost"
            onClick={clearVoltageCheckAnalysis}
          >
            Clear results
          </button>
        </>
      )}
    </div>
  );
}

function SettingsForm() {
  const backend = useNetworkStore((s) => s.backend);
  const adminMode = useNetworkStore((s) => s.adminMode);
  const adminRole = useNetworkStore((s) => s.adminRole);
  const adminName = useNetworkStore((s) => s.adminName);
  const editors = useNetworkStore((s) => s.editors);
  const suggestions = useNetworkStore((s) => s.suggestions);
  const showSuggestionsOnMap = useNetworkStore((s) => s.showSuggestionsOnMap);
  const substations = useNetworkStore((s) => s.substations);
  const availableDistricts = useNetworkStore((s) => s.availableDistricts);
  const editableSsIds = useNetworkStore((s) => s.editableSsIds);
  const portalManaged = useNetworkStore((s) => s.portalManaged);
  const portalIdentity = useNetworkStore((s) => s.portalIdentity);
  const editorUnrestricted = useNetworkStore((s) => s.editorUnrestricted);
  const portalUsers = useNetworkStore((s) => s.portalUsers);
  const resumePortalEditing = useNetworkStore((s) => s.resumePortalEditing);
  const unlockAdmin = useNetworkStore((s) => s.unlockAdmin);
  const lockAdmin = useNetworkStore((s) => s.lockAdmin);
  const authorizeEditor = useNetworkStore((s) => s.authorizeEditor);
  const revokeEditor = useNetworkStore((s) => s.revokeEditor);
  const refreshEditors = useNetworkStore((s) => s.refreshEditors);
  const refreshSuggestions = useNetworkStore((s) => s.refreshSuggestions);
  const approveSuggestion = useNetworkStore((s) => s.approveSuggestion);
  const rejectSuggestion = useNetworkStore((s) => s.rejectSuggestion);
  const focusSuggestion = useNetworkStore((s) => s.focusSuggestion);
  const focusedSuggestionId = useNetworkStore((s) => s.focusedSuggestionId);
  const setShowSuggestionsOnMap = useNetworkStore((s) => s.setShowSuggestionsOnMap);
  const personalDrafts = useNetworkStore((s) => s.personalDrafts);
  const showPersonalDraftsOnMap = useNetworkStore((s) => s.showPersonalDraftsOnMap);
  const setShowPersonalDraftsOnMap = useNetworkStore((s) => s.setShowPersonalDraftsOnMap);
  const focusPersonalDraft = useNetworkStore((s) => s.focusPersonalDraft);
  const focusedPersonalDraftId = useNetworkStore((s) => s.focusedPersonalDraftId);
  const discardPersonalDraft = useNetworkStore((s) => s.discardPersonalDraft);
  const refreshPersonalDrafts = useNetworkStore((s) => s.refreshPersonalDrafts);
  const lines = useNetworkStore((s) => s.lines);
  const checkSupabase = useNetworkStore((s) => s.checkSupabase);
  const pushToSupabase = useNetworkStore((s) => s.pushToSupabase);
  const reloadFromSupabase = useNetworkStore((s) => s.reloadFromSupabase);
  const [busy, setBusy] = useState(false);
  const [loginName, setLoginName] = useState('');
  const [pin, setPin] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [scopeSsIds, setScopeSsIds] = useState<string[]>([]);
  const [scopeDistricts, setScopeDistricts] = useState<string[]>([]);
  const [ssFilter, setSsFilter] = useState('');
  const [guideOpen, setGuideOpen] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const tryUnlock = async () => {
    setBusy(true);
    try {
      const ok = await unlockAdmin(pin, loginName);
      if (ok) {
        setPin('');
        setLoginName('');
      }
    } finally {
      setBusy(false);
    }
  };

  const tryAuthorize = async () => {
    setBusy(true);
    try {
      const ok = await authorizeEditor(newUsername, {
        allowedSubstationIds: scopeSsIds,
        allowedDistricts: scopeDistricts,
      });
      if (ok) {
        setNewUsername('');
        setScopeSsIds([]);
        setScopeDistricts([]);
      }
    } finally {
      setBusy(false);
    }
  };

  const toggleSs = (id: string) => {
    setScopeSsIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const toggleDistrict = (name: string) => {
    setScopeDistricts((prev) =>
      prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name],
    );
  };

  const filteredSs = substations
    .filter((s) => !ssFilter.trim() || s.name.toLowerCase().includes(ssFilter.trim().toLowerCase()))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="form-stack">
      <div className="admin-box">
        <p>
          Access:{' '}
          <strong>
            {!adminMode
              ? 'View only'
              : adminRole === 'super'
                ? 'Super admin'
                : `Editor · ${adminName ?? '—'}`}
          </strong>
        </p>
        {portalManaged && portalIdentity && (
          <p className="muted">
            Signed in as <strong>{portalIdentity.name}</strong> ({portalIdentity.username})
          </p>
        )}
        {adminMode ? (
          <>
            <p className="muted">
              {adminRole === 'super'
                ? 'You can edit the network, authorize editors, and review suggestions.'
                : editorUnrestricted
                  ? 'You can save personal drafts (this device) for any SS + feeders.'
                  : `You can save personal drafts for ${editableSsIds.length} authorized SS (+ connected feeders) on this device.`}
            </p>
            <button type="button" className="danger-btn" onClick={lockAdmin}>
              {portalManaged ? 'Pause editing' : 'Lock'}
            </button>
          </>
        ) : portalManaged ? (
          <>
            <p className="muted">
              {portalIdentity?.role
                ? 'Editing is paused for this session.'
                : 'Your portal account does not have Power Map edit permission. Ask a DRO admin to grant it under Admin → Users.'}
            </p>
            {portalIdentity?.role && (
              <button
                type="button"
                className="primary-btn"
                disabled={busy}
                onClick={() => void run(resumePortalEditing)}
              >
                Resume editing
              </button>
            )}
          </>
        ) : (
          <>
            <Field label="Name">
              <input
                value={loginName}
                placeholder="Your name"
                onChange={(e) => setLoginName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void tryUnlock();
                }}
              />
            </Field>
            <Field label="PIN">
              <input
                type="password"
                autoComplete="off"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void tryUnlock();
                }}
              />
            </Field>
            <button type="button" className="primary-btn" disabled={busy} onClick={() => void tryUnlock()}>
              Unlock to edit
            </button>
            <p className="muted">Ask your admin for a name and PIN if you need edit access.</p>
          </>
        )}
      </div>

      {adminRole === 'editor' && adminMode && (
        <div className="admin-box">
          <p className="section-label">My drafts (this device)</p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={showPersonalDraftsOnMap}
              onChange={(e) => setShowPersonalDraftsOnMap(e.target.checked)}
            />
            Show on map (teal markers)
          </label>
          <button
            type="button"
            className="primary-btn ghost"
            disabled={busy}
            onClick={() => void run(refreshPersonalDrafts)}
          >
            Refresh drafts
          </button>
          {personalDrafts.length === 0 && (
            <p className="muted">No drafts yet — edit an SS or feeder and Save to my drafts.</p>
          )}
          {personalDrafts.map((draft) => {
            const stale = isDraftStale(draft, { substations, lines });
            const focused = focusedPersonalDraftId === draft.id;
            return (
              <div
                key={draft.id}
                className={`suggestion-row${focused ? ' is-focused' : ''}${stale.stale ? ' draft-stale' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => focusPersonalDraft(draft.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    focusPersonalDraft(draft.id);
                  }
                }}
              >
                <div>
                  <strong>{draft.summary}</strong>
                  {stale.stale && <span className="field-error"> · live changed</span>}
                  <p className="muted">{draft.comment}</p>
                  <p className="muted">{new Date(draft.updatedAt).toLocaleString()}</p>
                </div>
                <button
                  type="button"
                  className="danger-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    void discardPersonalDraft(draft.id);
                  }}
                >
                  Discard
                </button>
              </div>
            );
          })}
          <p className="muted">Promote to suggestion for super-admin review will come later.</p>
        </div>
      )}

      {adminRole === 'super' && (
        <>
          <div className="admin-box">
            <p className="section-label">Suggested edits</p>
            <label className="check-row">
              <input
                type="checkbox"
                checked={showSuggestionsOnMap}
                onChange={(e) => setShowSuggestionsOnMap(e.target.checked)}
              />
              Show on map (orange markers)
            </label>
            <button
              type="button"
              className="primary-btn ghost"
              disabled={busy}
              onClick={() => void run(refreshSuggestions)}
            >
              Refresh suggestions
            </button>
            <div className="suggestion-list">
              {suggestions.length === 0 && <p className="muted">No pending suggestions.</p>}
              {suggestions.map((sug) => (
                <div
                  key={sug.id}
                  className={`suggestion-row${focusedSuggestionId === sug.id ? ' is-focused' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => focusSuggestion(sug.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      focusSuggestion(sug.id);
                    }
                  }}
                >
                  <div>
                    <strong>{sug.summary}</strong>
                    <p className="muted">
                      By {sug.editorName}
                      {sug.createdAt ? ` · ${new Date(sug.createdAt).toLocaleString()}` : ''}
                      {sug.lat != null ? ' · click to focus on map' : ''}
                    </p>
                  </div>
                  <div className="suggestion-actions">
                    <button
                      type="button"
                      className="text-btn"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void run(() => approveSuggestion(sug.id));
                      }}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="text-btn danger-text"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void run(() => rejectSuggestion(sug.id));
                      }}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="admin-box">
            <p className="section-label">Limit an editor to an area</p>
            <p className="muted">
              Edit rights come from the portal (Admin → Users → Power Map → Edit). Add a row here
              only to restrict someone to certain substations and/or districts (SS + connected
              feeders); without one their grant covers the whole network.
            </p>
            <Field label="Portal user">
              {portalUsers.length ? (
                <select value={newUsername} onChange={(e) => setNewUsername(e.target.value)}>
                  <option value="">Select a user…</option>
                  {portalUsers.map((u) => (
                    <option key={u.username} value={u.username}>
                      {u.name} ({u.username})
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={newUsername}
                  placeholder="portal username"
                  onChange={(e) => setNewUsername(e.target.value)}
                />
              )}
            </Field>

            <p className="section-label">Districts ({scopeDistricts.length} selected)</p>
            <div className="scope-checklist">
              {availableDistricts.length === 0 && (
                <p className="muted">District boundaries still loading…</p>
              )}
              {availableDistricts.map((d) => (
                <label key={d} className="check-row">
                  <input
                    type="checkbox"
                    checked={scopeDistricts.includes(d)}
                    onChange={() => toggleDistrict(d)}
                  />
                  {d}
                </label>
              ))}
            </div>

            <p className="section-label">Substations ({scopeSsIds.length} selected)</p>
            <Field label="Filter SS">
              <input
                value={ssFilter}
                placeholder="Search name…"
                onChange={(e) => setSsFilter(e.target.value)}
              />
            </Field>
            <div className="scope-checklist scope-checklist-tall">
              {filteredSs.map((ss) => (
                <label key={ss.id} className="check-row">
                  <input
                    type="checkbox"
                    checked={scopeSsIds.includes(ss.id)}
                    onChange={() => toggleSs(ss.id)}
                  />
                  {ss.name}{' '}
                  <span className="muted">· {ss.voltageCode} kV</span>
                </label>
              ))}
            </div>

            <button
              type="button"
              className="primary-btn"
              disabled={
                busy ||
                !newUsername.trim() ||
                (scopeSsIds.length === 0 && scopeDistricts.length === 0)
              }
              onClick={() => void tryAuthorize()}
            >
              Limit to selected area
            </button>
            <button
              type="button"
              className="primary-btn ghost"
              disabled={busy}
              onClick={() => void run(refreshEditors)}
            >
              Refresh list
            </button>
            <div className="editor-list">
              {editors.length === 0 && <p className="muted">No area limits set.</p>}
              {editors.map((ed) => (
                <div key={ed.id} className="editor-row">
                  <div>
                    <strong>{ed.name}</strong>
                    <span className="muted">
                      {ed.portalUsername ? ` (${ed.portalUsername})` : ' · legacy PIN'}
                      {' '}
                      · {ed.allowedSubstationIds.length} SS
                      {ed.allowedDistricts.length
                        ? ` · ${ed.allowedDistricts.length} district(s)`
                        : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="text-btn danger-text"
                    disabled={busy}
                    onClick={() => void run(() => revokeEditor(ed.id))}
                  >
                    Remove limit
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="admin-box">
            <p className="section-label">System</p>
            <p className="muted">
              Status:{' '}
              <strong>{backend === 'supabase' ? 'Online' : 'Offline copy'}</strong>
            </p>
            <button
              type="button"
              className="primary-btn ghost"
              disabled={busy}
              onClick={() => void run(checkSupabase)}
            >
              Check connection
            </button>
            <button
              type="button"
              className="primary-btn"
              disabled={busy}
              onClick={() => void run(pushToSupabase)}
            >
              Publish network
            </button>
            <button
              type="button"
              className="primary-btn ghost"
              disabled={busy}
              onClick={() => void run(reloadFromSupabase)}
            >
              Refresh from cloud
            </button>
          </div>

          <div className="admin-box">
            <button
              type="button"
              className="guide-toggle"
              onClick={() => setGuideOpen((o) => !o)}
            >
              <span className="section-label" style={{ margin: 0 }}>
                User guide
              </span>
              <span className="muted">{guideOpen ? 'Hide' : 'Show'}</span>
            </button>
            {guideOpen && (
              <div className="user-guide">
                <ol>
                  <li>
                    <strong>Unlock</strong> — Settings → PIN → Unlock. Lock when done.
                  </li>
                  <li>
                    <strong>Authorize editors</strong> — Name + PIN, pick SS and/or districts →
                    Authorize. They unlock with name + PIN.
                  </li>
                  <li>
                    <strong>Review suggestions</strong> — Editor saves become orange map markers;
                    Approve applies to live network, Reject discards.
                  </li>
                  <li>
                    <strong>Add SS / Connect / Tap</strong> — unlock first; editors only within
                    their authorized SS + connected feeders.
                  </li>
                  <li>
                    <strong>System</strong> — Check connection · Publish network · Refresh from
                    cloud.
                  </li>
                </ol>
                <p className="muted">Full copy: docs/SUPER_ADMIN_GUIDE.md</p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
