import type { PrintPreviewDpi, PrintSettings } from '@/lib/printLayout';
import { PRINT_PAPERS, PRINT_SHEET_MAX_MM, PRINT_SHEET_MIN_MM, paperSizeMm } from '@/lib/printLayout';

export type PrintDisplayPurpose = 'desk' | 'wall' | 'noticeboard' | 'auto';

export const PRINT_DISPLAY_PURPOSES: {
  id: PrintDisplayPurpose;
  label: string;
  blurb: string;
}[] = [
  { id: 'auto', label: 'Auto', blurb: 'From district shape and SS count' },
  { id: 'desk', label: 'Desk', blurb: '~1–1.5 ft — handouts and tabletop' },
  { id: 'wall', label: 'Wall', blurb: '~2.5–3.5 ft — office / corridor' },
  { id: 'noticeboard', label: 'Board', blurb: '~4–6 ft — lobby / yard map-only' },
];

const MM_PER_FOOT = 304.8;
const HEADER_FRAC = 0.09;

export type ScopeLayoutMetrics = {
  bounds: [[number, number], [number, number]] | null;
  geoAspect: number;
  districtCount: number;
  ssCount: number;
};

export type PrintLayoutSuggestion = {
  paperId: 'custom';
  orientation: PrintSettings['orientation'];
  customWidthMm: number;
  customHeightMm: number;
  previewDpi: PrintPreviewDpi;
  showSsList: boolean;
  hint: string;
};

export function boundsGeoAspect(
  bounds: [[number, number], [number, number]] | null,
): number {
  if (!bounds) return 1.35;
  const [[minLat, minLng], [maxLat, maxLng]] = bounds;
  const latMid = (minLat + maxLat) / 2;
  const lngSpan = Math.max(0.01, maxLng - minLng) * Math.cos((latMid * Math.PI) / 180);
  const latSpan = Math.max(0.01, maxLat - minLat);
  return Math.max(0.4, Math.min(3.5, lngSpan / latSpan));
}

/** Fraction of sheet height reserved for the SS capacity strip. */
export function listStripFraction(ssCount: number, showList: boolean): number {
  if (!showList || ssCount <= 0) return 0;
  if (ssCount > 56) return 0.24;
  if (ssCount > 32) return 0.2;
  if (ssCount > 14) return 0.16;
  return 0.12;
}

function roundMm(n: number): number {
  return Math.min(PRINT_SHEET_MAX_MM, Math.max(PRINT_SHEET_MIN_MM, Math.round(n / 5) * 5));
}

function resolvePurpose(
  purpose: PrintDisplayPurpose,
  metrics: ScopeLayoutMetrics,
): Exclude<PrintDisplayPurpose, 'auto'> {
  if (purpose !== 'auto') return purpose;
  if (metrics.districtCount >= 4 || metrics.geoAspect > 1.85) return 'noticeboard';
  if (metrics.districtCount >= 2 || metrics.ssCount > 35) return 'wall';
  return 'desk';
}

function targetLongEdgeFeet(
  purpose: Exclude<PrintDisplayPurpose, 'auto'>,
  metrics: ScopeLayoutMetrics,
): number {
  let feet: number;
  switch (purpose) {
    case 'desk':
      feet = 1.25;
      break;
    case 'wall':
      feet = 3.0;
      break;
    case 'noticeboard':
      feet = 4.75;
      break;
    default:
      feet = 2.5;
  }
  if (metrics.districtCount === 0) feet = Math.max(feet, 3.25);
  if (metrics.ssCount > 45) feet += 0.4;
  if (metrics.geoAspect > 1.75) feet += 0.65;
  if (metrics.districtCount >= 3) feet += 0.5;
  return Math.min(8, Math.max(1.0, feet));
}

function purposeDpi(purpose: Exclude<PrintDisplayPurpose, 'auto'>): PrintPreviewDpi {
  if (purpose === 'noticeboard') return 150;
  if (purpose === 'wall') return 120;
  return 96;
}

function defaultShowSsList(
  purpose: Exclude<PrintDisplayPurpose, 'auto'>,
  ssCount: number,
): boolean {
  if (purpose === 'noticeboard') return false;
  if (purpose === 'desk') return true;
  return ssCount <= 42;
}

export function suggestPrintLayout(
  metrics: ScopeLayoutMetrics,
  purpose: PrintDisplayPurpose = 'auto',
  opts?: { showSsList?: boolean },
): PrintLayoutSuggestion {
  const resolved = resolvePurpose(purpose, metrics);
  const showSsList = opts?.showSsList ?? defaultShowSsList(resolved, metrics.ssCount);
  const listFrac = listStripFraction(metrics.ssCount, showSsList);
  const mapFrac = Math.max(0.55, 1 - HEADER_FRAC - listFrac);
  const geoAspect = metrics.geoAspect;
  const longMm = targetLongEdgeFeet(resolved, metrics) * MM_PER_FOOT;

  let widthMm: number;
  let heightMm: number;
  let orientation: PrintSettings['orientation'];

  if (geoAspect >= 1) {
    widthMm = longMm;
    heightMm = widthMm / (geoAspect * mapFrac);
    orientation = 'landscape';
  } else {
    heightMm = longMm;
    widthMm = heightMm * mapFrac * geoAspect;
    orientation = 'portrait';
  }

  widthMm = roundMm(widthMm);
  heightMm = roundMm(heightMm);

  const purposeLabel =
    PRINT_DISPLAY_PURPOSES.find((p) => p.id === resolved)?.label ?? resolved;
  const listNote = showSsList ? `${metrics.ssCount} SS list` : 'map only';

  return {
    paperId: 'custom',
    orientation,
    customWidthMm: widthMm,
    customHeightMm: heightMm,
    previewDpi: purposeDpi(resolved),
    showSsList,
    hint: `${purposeLabel} · ${listNote} · ${geoAspect.toFixed(2)}∶1 map`,
  };
}

export function mmToFeet(mm: number): number {
  return mm / MM_PER_FOOT;
}

/** Primary user-facing size label, e.g. `3′ 2″ × 2′ 1″`. */
export function formatSheetFeet(widthMm: number, heightMm: number): string {
  const fmt = (mm: number) => {
    const totalIn = (mm / 25.4);
    const ft = Math.floor(totalIn / 12);
    const inch = Math.round(totalIn - ft * 12);
    if (ft <= 0) return `${inch}″`;
    if (inch === 0) return `${ft}′`;
    if (inch === 12) return `${ft + 1}′`;
    return `${ft}′ ${inch}″`;
  };
  return `${fmt(widthMm)} × ${fmt(heightMm)}`;
}

export function formatSheetFeetDecimal(widthMm: number, heightMm: number): string {
  return `${mmToFeet(widthMm).toFixed(1)} × ${mmToFeet(heightMm).toFixed(1)} ft`;
}

/** Nearest ISO size hint (informational only). */
export function nearestIsoHint(widthMm: number, heightMm: number): string | null {
  const long = Math.max(widthMm, heightMm);
  let best: { id: string; diff: number; long: number } | null = null;
  for (const [id, p] of Object.entries(PRINT_PAPERS)) {
    const isoLong = Math.max(p.widthMm, p.heightMm);
    const diff = Math.abs(long - isoLong);
    if (!best || diff < best.diff) best = { id, diff, long: isoLong };
  }
  if (!best || best.diff > best.long * 0.35) return null;
  return best.id.toUpperCase();
}

export function isoShortcutSettings(
  isoId: Exclude<PrintSettings['paperId'], 'custom'>,
  orientation: PrintSettings['orientation'] = 'landscape',
): Partial<PrintSettings> {
  const p = PRINT_PAPERS[isoId];
  const landscape = orientation === 'landscape';
  return {
    paperId: isoId,
    orientation,
    customWidthMm: landscape ? Math.max(p.widthMm, p.heightMm) : Math.min(p.widthMm, p.heightMm),
    customHeightMm: landscape ? Math.min(p.widthMm, p.heightMm) : Math.max(p.widthMm, p.heightMm),
    layoutLocked: true,
  };
}

export function sheetSizeLabel(settings: PrintSettings): string {
  const { widthMm, heightMm } = paperSizeMm(settings);
  const feet = formatSheetFeet(widthMm, heightMm);
  const iso = nearestIsoHint(widthMm, heightMm);
  return iso ? `${feet} (≈ ${iso})` : feet;
}
