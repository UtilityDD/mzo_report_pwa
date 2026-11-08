import { useEffect, type ReactNode } from 'react';
import { useNetworkStore } from '@/store/networkStore';
import {
  PRINT_BASEMAPS,
  PRINT_LABEL_SIZE_OPTIONS,
  PRINT_PREVIEW_DPI_OPTIONS,
  PRINT_SHEET_MAX_MM,
  PRINT_SHEET_MIN_MM,
  paperSizeMm,
  previewSheetPx,
  printSheetTitle,
  type PrintPaperId,
} from '@/lib/printLayout';
import {
  PRINT_DISPLAY_PURPOSES,
  formatSheetFeet,
  formatSheetFeetDecimal,
  isoShortcutSettings,
  sheetSizeLabel,
  type PrintDisplayPurpose,
} from '@/lib/printSuggest';
import { SITING_DISTRICTS } from '@/lib/sitingSuggestions';

const QUICK_DISTRICTS = [...SITING_DISTRICTS];

const ISO_SHORTCUTS: { id: Exclude<PrintPaperId, 'custom'>; label: string }[] = [
  { id: 'a4', label: 'A4' },
  { id: 'a3', label: 'A3' },
  { id: 'a2', label: 'A2' },
  { id: 'a1', label: 'A1' },
];

export function PrintForm() {
  const settings = useNetworkStore((s) => s.printSettings);
  const setPrintSettings = useNetworkStore((s) => s.setPrintSettings);
  const setPrintPreviewOpen = useNetworkStore((s) => s.setPrintPreviewOpen);
  const availableDistricts = useNetworkStore((s) => s.availableDistricts);
  const syncPrintFromScope = useNetworkStore((s) => s.syncPrintFromScope);
  const applySuggestedPrintLayout = useNetworkStore((s) => s.applySuggestedPrintLayout);
  const printLayoutHint = useNetworkStore((s) => s.printLayoutHint);
  const scopeBadgeLabel = useNetworkStore((s) => s.scopeBadgeLabel);
  const badge = scopeBadgeLabel();

  const districts =
    availableDistricts.length > 0
      ? [...availableDistricts].sort((a, b) => a.localeCompare(b))
      : QUICK_DISTRICTS;

  const size = paperSizeMm(settings);
  const preview = previewSheetPx(settings);

  const toggleDistrict = (name: string) => {
    const has = settings.districts.includes(name);
    const next = has
      ? settings.districts.filter((d) => d !== name)
      : [...settings.districts, name];
    setPrintSettings({ districts: next, layoutLocked: false });
  };

  const districtKey = settings.districts.join('|');
  useEffect(() => {
    if (settings.title.trim()) return;
    setPrintSettings({
      title: printSheetTitle({ title: '', districts: settings.districts }, settings.districts),
    });
  }, [districtKey, settings.title, settings.districts, setPrintSettings]);

  useEffect(() => {
    if (settings.layoutLocked) return;
    void applySuggestedPrintLayout();
  }, [districtKey, settings.displayPurpose, settings.showSsList, settings.layoutLocked, applySuggestedPrintLayout]);

  const setPurpose = (id: PrintDisplayPurpose) => {
    const patch: Partial<typeof settings> = { displayPurpose: id, layoutLocked: false };
    if (id === 'noticeboard') patch.showSsList = false;
    else if (id === 'desk') patch.showSsList = true;
    setPrintSettings(patch);
  };

  return (
    <div className="form-stack">
      <p className="muted">
        Custom-fit maps for desk, wall, or noticeboard — page size follows district shape. Toggle
        the SS capacity list to give the map the full sheet.
      </p>

      <div className="print-scope-card">
        <div>
          <span className="muted">Map scope</span>
          <strong>{badge}</strong>
        </div>
        <button type="button" className="primary-btn ghost" onClick={() => syncPrintFromScope()}>
          Use current scope
        </button>
      </div>

      <p className="section-label">Display purpose</p>
      <div className="chip-group" role="group" aria-label="Display purpose">
        {PRINT_DISPLAY_PURPOSES.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`chip${settings.displayPurpose === p.id ? ' on' : ''}`}
            title={p.blurb}
            aria-pressed={settings.displayPurpose === p.id}
            onClick={() => setPurpose(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="print-suggest-card">
        <div>
          <span className="muted">Suggested sheet</span>
          <strong>{sheetSizeLabel(settings)}</strong>
          <span className="muted">{formatSheetFeetDecimal(size.widthMm, size.heightMm)}</span>
        </div>
        {printLayoutHint ? <p className="muted">{printLayoutHint}</p> : null}
        <div className="btn-row">
          <button
            type="button"
            className="primary-btn ghost"
            onClick={() => void applySuggestedPrintLayout(true)}
          >
            Recalculate fit
          </button>
          {settings.layoutLocked ? (
            <span className="muted">Manual size — recalculate to return to auto fit</span>
          ) : null}
        </div>
      </div>

      <label className="check-row">
        <input
          type="checkbox"
          checked={settings.showSsList ?? true}
          onChange={(e) =>
            setPrintSettings({ showSsList: e.target.checked, layoutLocked: false })
          }
        />
        Show substation capacity list (off = map uses full page below header)
      </label>

      <Field label="Title">
        <input
          value={settings.title}
          onChange={(e) => setPrintSettings({ title: e.target.value })}
          placeholder="Auto from districts — e.g. Power Map of Malda District"
        />
      </Field>
      <Field label="Subtitle (optional)">
        <input
          value={settings.subtitle}
          onChange={(e) => setPrintSettings({ subtitle: e.target.value })}
          placeholder="Optional line under the title"
        />
      </Field>

      <p className="section-label">Map labels</p>
      <div className="field-row">
        <Field label="Label size">
          <select
            value={settings.labelSize ?? 'normal'}
            onChange={(e) =>
              setPrintSettings({
                labelSize: e.target.value as typeof settings.labelSize,
              })
            }
          >
            {PRINT_LABEL_SIZE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <p className="muted">Affects SS names and feeder length labels on the map.</p>

      <p className="section-label">Sheet size</p>
      <p className="muted">
        Auto mode uses <strong>custom</strong> mm from map shape — not forced to ISO.
      </p>
      <div className="field-row">
        <Field label="Width">
          <input
            type="number"
            min={PRINT_SHEET_MIN_MM}
            max={PRINT_SHEET_MAX_MM}
            value={settings.customWidthMm}
            onChange={(e) =>
              setPrintSettings({
                paperId: 'custom',
                customWidthMm: Math.min(
                  PRINT_SHEET_MAX_MM,
                  Math.max(PRINT_SHEET_MIN_MM, Number(e.target.value) || PRINT_SHEET_MIN_MM),
                ),
                layoutLocked: true,
              })
            }
          />
        </Field>
        <Field label="Height">
          <input
            type="number"
            min={PRINT_SHEET_MIN_MM}
            max={PRINT_SHEET_MAX_MM}
            value={settings.customHeightMm}
            onChange={(e) =>
              setPrintSettings({
                paperId: 'custom',
                customHeightMm: Math.min(
                  PRINT_SHEET_MAX_MM,
                  Math.max(PRINT_SHEET_MIN_MM, Number(e.target.value) || PRINT_SHEET_MIN_MM),
                ),
                layoutLocked: true,
              })
            }
          />
        </Field>
      </div>
      <p className="muted">
        <strong>{formatSheetFeet(size.widthMm, size.heightMm)}</strong>
        {' · '}
        {size.widthMm} × {size.heightMm} mm
        {' · '}
        {settings.orientation}
        {preview.scale < 1 ? ` · preview ${Math.round(preview.scale * 100)}% fit` : ''}
      </p>

      <p className="section-label">ISO shortcut (optional)</p>
      <div className="chip-group" role="group" aria-label="ISO paper shortcut">
        {ISO_SHORTCUTS.map((o) => (
          <button
            key={o.id}
            type="button"
            className={`chip${settings.paperId === o.id ? ' on' : ''}`}
            onClick={() => setPrintSettings(isoShortcutSettings(o.id, settings.orientation))}
          >
            {o.label}
          </button>
        ))}
      </div>

      <Field label="Preview DPI">
        <select
          value={settings.previewDpi ?? 96}
          onChange={(e) =>
            setPrintSettings({
              previewDpi: Number(e.target.value) as typeof settings.previewDpi,
            })
          }
        >
          {PRINT_PREVIEW_DPI_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>

      <p className="section-label">Districts</p>
      <div className="btn-row">
        <button
          type="button"
          className="text-btn"
          onClick={() => {
            setPrintSettings({ districts: [...QUICK_DISTRICTS], layoutLocked: false });
            void applySuggestedPrintLayout();
          }}
        >
          Malda + Dinajpurs
        </button>
        <button
          type="button"
          className="text-btn"
          onClick={() => {
            setPrintSettings({ districts: [], layoutLocked: false });
            void applySuggestedPrintLayout();
          }}
        >
          Clear (all)
        </button>
      </div>
      <div className="print-district-list">
        {districts.map((name) => (
          <label key={name} className="check-row">
            <input
              type="checkbox"
              checked={settings.districts.includes(name)}
              onChange={() => toggleDistrict(name)}
            />
            {name}
          </label>
        ))}
      </div>
      <p className="muted">
        {settings.districts.length === 0
          ? 'No district filter — full network (still respects proposed toggle).'
          : `${settings.districts.length} district(s) — map zooms to the area.`}
      </p>

      <p className="section-label">Map content</p>
      <div className="field">
        <span>Basemap</span>
        <div className="chip-group" style={{ marginTop: 6 }}>
          {PRINT_BASEMAPS.map((b) => (
            <button
              key={b.id}
              type="button"
              className={`chip${(settings.basemap || 'esri') === b.id ? ' on' : ''}`}
              aria-pressed={(settings.basemap || 'esri') === b.id}
              onClick={() => setPrintSettings({ basemap: b.id })}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={settings.showDistrictBoundaries}
          onChange={(e) =>
            setPrintSettings({ showDistrictBoundaries: e.target.checked })
          }
        />
        District boundaries
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={settings.showSsNames}
          onChange={(e) => setPrintSettings({ showSsNames: e.target.checked })}
        />
        Substation names on map
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={settings.showFeederLength}
          onChange={(e) => setPrintSettings({ showFeederLength: e.target.checked })}
        />
        Feeder lengths on map
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={settings.showProposed}
          onChange={(e) => setPrintSettings({ showProposed: e.target.checked })}
        />
        Include proposed assets
      </label>

      <button
        type="button"
        className="primary-btn"
        onClick={() => setPrintPreviewOpen(true)}
      >
        Open print preview
      </button>
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
