import type { Substation, TapLateral, TapNode, TrunkLine } from '@/domain/types';
import { loadDistrictPolygons } from '@/lib/districts';
import type { PrintDisplayPurpose } from '@/lib/printSuggest';

export type PrintPaperId = 'a4' | 'a3' | 'a2' | 'a1' | 'custom';
export type PrintOrientation = 'landscape' | 'portrait';

export const PRINT_SHEET_MIN_MM = 100;
export const PRINT_SHEET_MAX_MM = 2500;

/** ISO sizes in millimetres (portrait width × height). */
export const PRINT_PAPERS: Record<
  Exclude<PrintPaperId, 'custom'>,
  { label: string; widthMm: number; heightMm: number }
> = {
  a4: { label: 'A4 (small)', widthMm: 210, heightMm: 297 },
  a3: { label: 'A3 (office)', widthMm: 297, heightMm: 420 },
  a2: { label: 'A2 (wall)', widthMm: 420, heightMm: 594 },
  a1: { label: 'A1 (large wall)', widthMm: 594, heightMm: 841 },
};

export type PrintPreviewDpi = 72 | 96 | 120 | 150 | 200;

export type PrintLabelSize = 'small' | 'normal' | 'large';

export const PRINT_LABEL_SIZE_OPTIONS: {
  value: PrintLabelSize;
  label: string;
  multiplier: number;
}[] = [
  { value: 'small', label: 'Small', multiplier: 0.85 },
  { value: 'normal', label: 'Normal', multiplier: 1 },
  { value: 'large', label: 'Large', multiplier: 1.28 },
];

export type PrintSettings = {
  paperId: PrintPaperId;
  orientation: PrintOrientation;
  customWidthMm: number;
  customHeightMm: number;
  districts: string[];
  title: string;
  subtitle: string;
  showSsNames: boolean;
  showFeederLength: boolean;
  showProposed: boolean;
  showDistrictBoundaries: boolean;
  listSide: 'left' | 'right';
  /** Bottom capacity list of substations. Off = map uses full sheet below header. */
  showSsList: boolean;
  displayPurpose: PrintDisplayPurpose;
  layoutLocked: boolean;
  /** Screen preview / tile sharpness (px per inch before viewport fit). */
  previewDpi: PrintPreviewDpi;
  /** Print preview / PDF basemap (same set as the live map). */
  basemap: 'google' | 'google-hybrid' | 'osm' | 'esri' | 'none';
  /** Map label typography — SS names and feeder lengths. */
  labelSize: PrintLabelSize;
};

export const DEFAULT_PRINT_SETTINGS: PrintSettings = {
  paperId: 'custom',
  orientation: 'landscape',
  customWidthMm: 420,
  customHeightMm: 297,
  districts: [],
  title: '',
  subtitle: '',
  showSsNames: true,
  showFeederLength: true,
  showProposed: true,
  showDistrictBoundaries: true,
  listSide: 'right',
  showSsList: true,
  displayPurpose: 'auto',
  layoutLocked: false,
  previewDpi: 96,
  basemap: 'esri',
  labelSize: 'normal',
};

export const PRINT_PREVIEW_DPI_OPTIONS: { value: PrintPreviewDpi; label: string }[] = [
  { value: 72, label: '72 — fast' },
  { value: 96, label: '96 — default' },
  { value: 120, label: '120' },
  { value: 150, label: '150 — sharp' },
  { value: 200, label: '200 — max' },
];

export const PRINT_BASEMAPS: {
  id: PrintSettings['basemap'];
  label: string;
}[] = [
  { id: 'esri', label: 'Light Gray' },
  { id: 'osm', label: 'OpenStreetMap' },
  { id: 'google', label: 'Google Roads' },
  { id: 'google-hybrid', label: 'Google Hybrid' },
  { id: 'none', label: 'No basemap' },
];

export function paperSizeMm(settings: PrintSettings): { widthMm: number; heightMm: number } {
  if (settings.paperId === 'custom') {
    return {
      widthMm: Math.min(PRINT_SHEET_MAX_MM, Math.max(PRINT_SHEET_MIN_MM, Number(settings.customWidthMm) || PRINT_SHEET_MIN_MM)),
      heightMm: Math.min(PRINT_SHEET_MAX_MM, Math.max(PRINT_SHEET_MIN_MM, Number(settings.customHeightMm) || PRINT_SHEET_MIN_MM)),
    };
  }
  const p = PRINT_PAPERS[settings.paperId];
  const w = p.widthMm;
  const h = p.heightMm;
  if (settings.orientation === 'landscape') {
    return { widthMm: Math.max(w, h), heightMm: Math.min(w, h) };
  }
  return { widthMm: Math.min(w, h), heightMm: Math.max(w, h) };
}

export function cssPageSize(settings: PrintSettings): string {
  const { widthMm, heightMm } = paperSizeMm(settings);
  return `${widthMm}mm ${heightMm}mm`;
}

/** Screen preview size in px — fits full sheet in viewport at chosen DPI. */
export function previewSheetPx(
  settings: PrintSettings,
  viewport?: { width: number; height: number },
): { widthPx: number; heightPx: number; scale: number } {
  const { widthMm, heightMm } = paperSizeMm(settings);
  const dpi = settings.previewDpi ?? 96;
  const pxPerMm = dpi / 25.4;
  const rawW = widthMm * pxPerMm;
  const rawH = heightMm * pxPerMm;

  const vw = viewport?.width ?? (typeof window !== 'undefined' ? window.innerWidth : 1200);
  const vh = viewport?.height ?? (typeof window !== 'undefined' ? window.innerHeight : 800);
  const maxW = Math.max(280, vw - 48);
  const maxH = Math.max(200, vh - 168);

  const scale = Math.min(1, maxW / rawW, maxH / rawH);
  return {
    widthPx: Math.max(240, Math.round(rawW * scale)),
    heightPx: Math.max(180, Math.round(rawH * scale)),
    scale,
  };
}

/** Clear sheet title — e.g. "Power Map of Malda District". */
export function printSheetTitle(
  settings: Pick<PrintSettings, 'title' | 'districts'>,
  fallbackDistricts: string[] = [],
): string {
  const custom = settings.title.trim();
  if (custom && !/^power network map$/i.test(custom)) return custom;
  const names = (settings.districts.length ? settings.districts : fallbackDistricts)
    .map((n) => n.trim())
    .filter(Boolean);
  if (!names.length) return 'Power Network Map';
  if (names.length === 1) {
    const n = names[0];
    return /district$/i.test(n) ? `Power Map of ${n}` : `Power Map of ${n} District`;
  }
  if (names.length === 2) return `Power Map of ${names[0]} & ${names[1]}`;
  return `Power Map of ${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

/** Named ISO @page size so browser print dialog matches; custom uses exact mm. */
export function cssPageRule(settings: PrintSettings): string {
  if (settings.paperId === 'custom') {
    const { widthMm, heightMm } = paperSizeMm(settings);
    return `size: ${widthMm}mm ${heightMm}mm`;
  }
  return `size: ${settings.paperId.toUpperCase()} ${settings.orientation}`;
}

/**
 * Literal print CSS (no CSS variables) — Chrome print preview often drops
 * custom-property mm sizes and then stretches the screen-pixel sheet.
 */
export function buildPrintStyleSheet(settings: PrintSettings): string {
  const { widthMm, heightMm } = paperSizeMm(settings);
  const page = cssPageRule(settings);
  const box = `
    width: ${widthMm}mm !important;
    height: ${heightMm}mm !important;
    max-width: none !important;
    max-height: none !important;
    aspect-ratio: auto !important;
    margin: 0 !important;
    padding: 0 !important;
    box-sizing: border-box !important;
  `;
  return `
@page { ${page}; margin: 0; }
body.is-printing .print-overlay {
  background: #fff !important;
}
body.is-printing .print-toolbar {
  display: none !important;
}
body.is-printing .print-stage {
  padding: 0 !important;
  overflow: hidden !important;
  ${box}
}
body.is-printing .print-sheet {
  ${box}
  box-shadow: none !important;
  overflow: hidden !important;
  font-family: "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif !important;
}
body.is-printing .print-sheet-header h1,
body.is-printing .print-sheet-header p,
body.is-printing .print-sheet-legend,
body.is-printing .print-side-list,
body.is-printing .print-ss-list,
body.is-printing .print-ss-name,
body.is-printing .print-ss-cap,
body.is-printing .print-ss-kv,
body.is-printing .print-ss-idx,
body.is-printing .print-map-label span,
body.is-printing .print-ss-label span,
body.is-printing .print-feeder-label span,
body.is-printing .print-district-label span {
  font-family: "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif !important;
}
body.is-printing .print-ss-label span,
body.is-printing .print-district-label span {
  font-weight: 600 !important;
  letter-spacing: 0.01em !important;
}
body.is-printing .print-feeder-label span,
body.is-printing .print-ss-cap,
body.is-printing .print-ss-kv,
body.is-printing .print-ss-idx {
  font-variant-numeric: tabular-nums !important;
  font-weight: 600 !important;
}
body.is-printing .print-sheet-body {
  flex: 1 1 0 !important;
  min-height: 0 !important;
  overflow: hidden !important;
  display: grid !important;
  grid-template-rows: minmax(0, 1fr) auto !important;
}
body.is-printing .print-map-pane,
body.is-printing .print-map-canvas,
body.is-printing .print-map-canvas.leaflet-container {
  height: 100% !important;
  min-height: 0 !important;
  overflow: hidden !important;
}
body.is-printing .print-side-list {
  max-height: calc(var(--print-list-frac, 0.18) * 100%) !important;
  min-height: 0 !important;
  overflow: hidden !important;
  flex-shrink: 0 !important;
}
body.is-printing .print-sheet.map-only .print-sheet-body {
  grid-template-rows: minmax(0, 1fr) !important;
}
body.is-printing .print-sheet.map-only .print-side-list {
  display: none !important;
}
@media print {
  html, body {
    ${box}
    overflow: hidden !important;
    background: #fff !important;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  /* Hide map chrome; keep .print-overlay. Do NOT hide .app-shell children —
     the overlay is nested under .pm-shell, so that rule blanked the PDF. */
  body.print-preview-open .pm-shell > :not(.print-overlay) {
    display: none !important;
  }
  /* DRO app chrome — must not appear on the PDF page.
     Print preview is often a narrow page width, which re-enables mobile
     .app-bar / .bottom-nav { display: … !important } — beat that specificity. */
  body.print-preview-open .app-shell > .app-bar,
  body.print-preview-open .app-shell > .bottom-nav,
  body.print-preview-open .app-shell .sidebar,
  body.print-preview-open .app-shell .page-masthead,
  body.print-preview-open .app-shell .pm-desk-toolbar,
  body.print-preview-open .pm-shell .view-toggles,
  body.print-preview-open .app-shell .present-fab-stack,
  body.print-preview-open .app-shell .present-hud,
  body.print-preview-open .app-shell .present-hotzone,
  body.print-preview-open .app-shell .present-nav-root,
  body.print-preview-open .app-shell .sheet-root,
  body.is-printing .app-shell > .app-bar,
  body.is-printing .app-shell > .bottom-nav,
  body.is-printing .app-shell .sidebar,
  body.is-printing .app-shell .page-masthead,
  body.is-printing .app-shell .pm-desk-toolbar,
  body.is-printing .pm-shell .view-toggles,
  body.is-printing .app-shell .present-fab-stack,
  body.is-printing .app-shell .present-hud,
  body.is-printing .app-shell .present-hotzone,
  body.is-printing .app-shell .present-nav-root,
  body.is-printing .app-shell .sheet-root,
  body.is-printing .app-shell .present-laser-layer,
  body.is-printing .present-laser-layer,
  body.print-preview-open .app-bar,
  body.print-preview-open .bottom-nav,
  body.is-printing .app-bar,
  body.is-printing .bottom-nav {
    display: none !important;
    visibility: hidden !important;
    height: 0 !important;
    max-height: 0 !important;
    min-height: 0 !important;
    overflow: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }
  body.print-preview-open .app-body,
  body.print-preview-open .main,
  body.print-preview-open .page-content,
  body.print-preview-open .pm-page,
  body.print-preview-open .pm-root,
  body.print-preview-open .pm-shell {
    display: block !important;
    height: auto !important;
    min-height: 0 !important;
    overflow: visible !important;
    background: #fff !important;
    padding: 0 !important;
    margin: 0 !important;
  }
  .print-overlay,
  .print-stage,
  .print-sheet {
    position: static !important;
    inset: auto !important;
    display: flex !important;
    flex-direction: column !important;
    ${box}
    background: #fff !important;
    overflow: hidden !important;
    box-shadow: none !important;
  }
  .print-sheet {
    page-break-after: avoid !important;
    page-break-inside: avoid !important;
    break-inside: avoid !important;
  }
  .no-print,
  .print-toolbar {
    display: none !important;
  }
  .print-sheet-body {
    flex: 1 1 auto !important;
    min-height: 0 !important;
    height: auto !important;
    overflow: hidden !important;
    grid-template-rows: minmax(0, 1fr) auto !important;
  }
  .print-sheet.map-only .print-sheet-body {
    grid-template-rows: minmax(0, 1fr) !important;
  }
  .print-sheet.map-only .print-side-list {
    display: none !important;
  }
  .print-map-pane {
    position: relative !important;
    min-height: 0 !important;
    height: 100% !important;
    overflow: hidden !important;
  }
  .print-map-canvas,
  .print-map-canvas.leaflet-container {
    position: absolute !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100% !important;
    min-height: 0 !important;
  }
  .print-side-list {
    max-height: none !important;
    overflow: hidden !important;
    flex-shrink: 0 !important;
  }
}
`.trim();
}

type Ring = number[][];
type DistrictPoly = { name: string; rings: Ring[] };

function pointInRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi + 0.0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPoly(lng: number, lat: number, d: DistrictPoly): boolean {
  return d.rings.some((ring) => pointInRing(lng, lat, ring));
}

export type PrintDistrictBoundary = {
  name: string;
  /** Leaflet [lat, lng] rings */
  latLngRings: [number, number][][];
};

export type PrintAssetBundle = {
  substations: Substation[];
  lines: TrunkLine[];
  tapNodes: TapNode[];
  tapLaterals: TapLateral[];
  /** SS that sit inside the selected district polygon(s). */
  inDistrictIds: string[];
  districtNames: string[];
  districtBoundaries: PrintDistrictBoundary[];
  bounds: [[number, number], [number, number]] | null;
  /** Tight hull around printed network — used for map fit (esp. multi-district). */
  contentBounds: [[number, number], [number, number]] | null;
};

function expandBoundsWithPoints(
  bounds: [[number, number], [number, number]] | null,
  points: Array<{ lat: number; lng: number }>,
): [[number, number], [number, number]] | null {
  if (!points.length) return bounds;
  let minLat = bounds ? bounds[0][0] : Infinity;
  let minLng = bounds ? bounds[0][1] : Infinity;
  let maxLat = bounds ? bounds[1][0] : -Infinity;
  let maxLng = bounds ? bounds[1][1] : -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
  }
  if (!Number.isFinite(minLat)) return bounds;
  return [
    [minLat, minLng],
    [maxLat, maxLng],
  ];
}

/** Filter network to selected districts (empty = use all available from caller). */
export async function buildPrintAssets(
  substations: Substation[],
  lines: TrunkLine[],
  districtNames: string[],
  opts?: {
    includeProposed?: boolean;
    tapNodes?: TapNode[];
    tapLaterals?: TapLateral[];
  },
): Promise<PrintAssetBundle> {
  const includeProposed = opts?.includeProposed ?? true;
  const allDistricts = (await loadDistrictPolygons()) as DistrictPoly[];
  const want = districtNames.map((n) => n.toLowerCase());
  const matched =
    want.length === 0
      ? []
      : allDistricts.filter((d) => want.includes(d.name.toLowerCase()));

  const statusOk = (status: string) =>
    status === 'existing' || (includeProposed && status === 'proposed');

  const eligible = substations.filter((s) => statusOk(s.status));

  let core: Substation[];
  if (!matched.length) {
    core = eligible;
  } else {
    core = eligible.filter((s) => matched.some((d) => pointInPoly(s.lng, s.lat, d)));
  }

  const coreIds = new Set(core.map((s) => s.id));

  // Lines that touch any in-district SS (feeds leaving the district included).
  const touchingLines = lines.filter((l) => {
    if (!statusOk(l.status)) return false;
    if (!matched.length) return coreIds.has(l.fromId) && coreIds.has(l.toId);
    return coreIds.has(l.fromId) || coreIds.has(l.toId);
  });

  // Pull in the far-end SS outside the district so those feeders actually draw.
  const byId = new Map(eligible.map((s) => [s.id, s]));
  const expanded = new Map(core.map((s) => [s.id, s]));
  if (matched.length) {
    for (const l of touchingLines) {
      for (const id of [l.fromId, l.toId]) {
        if (expanded.has(id)) continue;
        const remote = byId.get(id);
        if (remote) expanded.set(id, remote);
      }
    }
  }

  const ss = [...expanded.values()];
  const ssIds = new Set(ss.map((s) => s.id));

  // Keep every line whose both ends are now on the sheet (core↔core, core↔external).
  const filteredLines = matched.length
    ? lines.filter(
        (l) => statusOk(l.status) && ssIds.has(l.fromId) && ssIds.has(l.toId) &&
          (coreIds.has(l.fromId) || coreIds.has(l.toId)),
      )
    : touchingLines;

  // Boundaries to draw: selected districts, or districts that contain printed core SS
  let boundaryDistricts = matched;
  if (!boundaryDistricts.length && core.length) {
    const hit = new Set<string>();
    for (const s of core) {
      const d = allDistricts.find((x) => pointInPoly(s.lng, s.lat, x));
      if (d) hit.add(d.name);
    }
    boundaryDistricts = allDistricts.filter((d) => hit.has(d.name));
  }

  const districtBoundaries: PrintDistrictBoundary[] = boundaryDistricts.map((d) => ({
    name: d.name,
    latLngRings: d.rings.map((ring) =>
      ring.map((p) => [p[1], p[0]] as [number, number]),
    ),
  }));

  let bounds: [[number, number], [number, number]] | null = null;
  if (boundaryDistricts.length) {
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;
    for (const d of boundaryDistricts) {
      for (const ring of d.rings) {
        for (const p of ring) {
          minLng = Math.min(minLng, p[0]);
          maxLng = Math.max(maxLng, p[0]);
          minLat = Math.min(minLat, p[1]);
          maxLat = Math.max(maxLat, p[1]);
        }
      }
    }
    if (Number.isFinite(minLat)) {
      bounds = [
        [minLat, minLng],
        [maxLat, maxLng],
      ];
    }
  }

  // Frame = district (+ in-district SS only). Outside connectors stay off the fit
  // so the map stays zoomed to the selected area.
  bounds = expandBoundsWithPoints(bounds, core);

  const contentPoints: Array<{ lat: number; lng: number }> = [...core];
  for (const l of filteredLines) {
    if (coreIds.has(l.fromId)) {
      const s = ss.find((x) => x.id === l.fromId);
      if (s) contentPoints.push(s);
    }
    if (coreIds.has(l.toId)) {
      const s = ss.find((x) => x.id === l.toId);
      if (s) contentPoints.push(s);
    }
    const from = ss.find((x) => x.id === l.fromId);
    const to = ss.find((x) => x.id === l.toId);
    if (from && to && (coreIds.has(l.fromId) || coreIds.has(l.toId))) {
      contentPoints.push({
        lat: (from.lat + to.lat) / 2,
        lng: (from.lng + to.lng) / 2,
      });
    }
  }
  const lineIds = new Set(filteredLines.map((l) => l.id));
  const allTapNodes = opts?.tapNodes ?? [];
  const tapById = new Map<string, TapNode>();
  for (const t of allTapNodes) {
    if (statusOk(t.status) && lineIds.has(t.parentLineId)) tapById.set(t.id, t);
  }

  const tapLateralsPrint: TapLateral[] = [];
  for (const lat of opts?.tapLaterals ?? []) {
    if (!statusOk(lat.status)) continue;
    if (!tapById.has(lat.fromTapId)) continue;
    if (lat.toKind === 'substation') {
      if (!ssIds.has(lat.toAssetId)) continue;
    } else {
      const toTap = allTapNodes.find((t) => t.id === lat.toAssetId);
      if (!toTap || !statusOk(toTap.status) || !lineIds.has(toTap.parentLineId)) continue;
      tapById.set(toTap.id, toTap);
    }
    tapLateralsPrint.push(lat);
  }

  const tapNodesPrint = [...tapById.values()];
  for (const t of tapNodesPrint) contentPoints.push(t);
  for (const lat of tapLateralsPrint) {
    const fromTap = tapById.get(lat.fromTapId);
    if (!fromTap) continue;
    contentPoints.push(fromTap);
    if (lat.toKind === 'substation') {
      const targetSs = ss.find((x) => x.id === lat.toAssetId);
      if (targetSs) contentPoints.push(targetSs);
    } else {
      const toTap = tapById.get(lat.toAssetId);
      if (toTap) contentPoints.push(toTap);
    }
  }
  const contentBoundsWithTaps = expandBoundsWithPoints(null, contentPoints);

  return {
    substations: ss,
    lines: filteredLines,
    tapNodes: tapNodesPrint,
    tapLaterals: tapLateralsPrint,
    inDistrictIds: [...coreIds],
    districtNames: boundaryDistricts.map((d) => d.name),
    districtBoundaries,
    bounds,
    contentBounds: contentBoundsWithTaps,
  };
}
