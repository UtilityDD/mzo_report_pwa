import type { PrintSettings } from '@/lib/printLayout';
import type { VoltageFocus } from '@/lib/voltageFocus';

export type OutputScope = {
  /** Focused or print-selected district names. */
  districts?: string[];
  /** Map view toggle (All / EHT / 33 / Proposed). */
  voltageFocus?: VoltageFocus;
};

export type ReportExportKind =
  | 'executive'
  | 'dossier'
  | 'existing-ss'
  | 'proposed-ss'
  | 'existing-feeders'
  | 'proposed-feeders';

const REPORT_KIND_SLUG: Record<ReportExportKind, string> = {
  executive: 'executive-summary',
  dossier: 'district-dossier',
  'existing-ss': 'existing-substations',
  'proposed-ss': 'proposed-substations',
  'existing-feeders': 'existing-feeders',
  'proposed-feeders': 'proposed-feeders',
};

/** Safe fragment for download / save-as filenames (Windows-friendly). */
export function sanitizeFilenamePart(text: string, maxLen = 48): string {
  return text
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s\-&+]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLen)
    .toLowerCase();
}

/** District selection → compact slug, e.g. `malda`, `malda-and-darjeeling`. */
export function districtFilenamePart(names: string[] | undefined): string {
  const list = (names ?? []).map((n) => n.trim()).filter(Boolean);
  if (!list.length) return 'full-network';
  if (list.length === 1) {
    return sanitizeFilenamePart(list[0].replace(/\bdistrict\b/i, '').trim());
  }
  if (list.length === 2) {
    return `${sanitizeFilenamePart(list[0])}-and-${sanitizeFilenamePart(list[1])}`;
  }
  if (list.length <= 4) {
    return list.map((n) => sanitizeFilenamePart(n.replace(/\bdistrict\b/i, '').trim())).join('-');
  }
  return `${sanitizeFilenamePart(list[0])}-plus-${list.length - 1}-districts`;
}

function viewFilenamePart(focus: VoltageFocus | undefined): string {
  if (!focus || focus === 'all') return '';
  if (focus === 'ehv') return 'eht-view';
  if (focus === '33') return '33kv-view';
  return 'proposed-view';
}

function datedSuffix(): string {
  return new Date().toISOString().slice(0, 10);
}

function joinBasename(parts: Array<string | undefined | null>): string {
  return parts
    .map((p) => (p ?? '').trim())
    .filter(Boolean)
    .join('_');
}

function printPaperSlug(
  settings: Pick<
    PrintSettings,
    'paperId' | 'orientation' | 'customWidthMm' | 'customHeightMm'
  >,
): string {
  if (settings.paperId === 'custom') {
    return `${settings.customWidthMm}x${settings.customHeightMm}mm`;
  }
  return `${settings.paperId}-${settings.orientation}`;
}

/** Slug stem for Save-as-PDF (no extension — browsers append .pdf). */
export function printSaveFilenameStem(
  settings: Pick<
    PrintSettings,
    'districts' | 'paperId' | 'orientation' | 'customWidthMm' | 'customHeightMm'
  >,
  districtNames: string[] = [],
): string {
  const districts = settings.districts.length ? settings.districts : districtNames;
  return joinBasename([
    'powermap',
    districtFilenamePart(districts),
    sanitizeFilenamePart(printPaperSlug(settings)),
    datedSuffix(),
  ]);
}

/** Full suggested PDF filename including extension (preview hint). */
export function printSaveFilename(
  settings: Pick<
    PrintSettings,
    'districts' | 'paperId' | 'orientation' | 'customWidthMm' | 'customHeightMm'
  >,
  districtNames: string[] = [],
): string {
  return `${printSaveFilenameStem(settings, districtNames)}.pdf`;
}

export function reportCsvFilename(kind: ReportExportKind, scope: OutputScope = {}): string {
  return `${joinBasename([
    'powermap',
    REPORT_KIND_SLUG[kind],
    districtFilenamePart(scope.districts),
    viewFilenamePart(scope.voltageFocus),
    datedSuffix(),
  ])}.csv`;
}

export function geoJsonFilename(scope: OutputScope = {}): string {
  return `${joinBasename([
    'powermap',
    'network',
    districtFilenamePart(scope.districts),
    viewFilenamePart(scope.voltageFocus),
    datedSuffix(),
  ])}.geojson`;
}

export function voltageCheckCsvFilename(districts: string[] = []): string {
  return `${joinBasename([
    'powermap',
    'far-from-33kv',
    districtFilenamePart(districts),
    datedSuffix(),
  ])}.csv`;
}
