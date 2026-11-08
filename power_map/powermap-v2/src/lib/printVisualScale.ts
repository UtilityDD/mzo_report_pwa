import type { PrintLabelSize } from '@/lib/printLayout';

/** Baseline: A3 landscape long edge (~16.5 in) at ~480×340 px map pane. */
const REF_PAPER_LONG_IN = 16.54;
const REF_MAP_W = 480;
const REF_MAP_H = 340;

export type PrintVisualScaleInput = {
  mapPanePx: { w: number; h: number };
  paperMm: { w: number; h: number };
};

/**
 * Scale factor for print symbols, line weights, and label typography.
 * Tuned for desk (~0.85–1.1) through noticeboard (~2–2.8).
 */
export function computePrintVisualScale(input: PrintVisualScaleInput): number {
  const { mapPanePx, paperMm } = input;
  const paperLongIn = Math.max(paperMm.w, paperMm.h) / 25.4;
  const fromPaper = paperLongIn / REF_PAPER_LONG_IN;

  const mapW = Math.max(120, mapPanePx.w);
  const mapH = Math.max(90, mapPanePx.h);
  const fromPx = Math.sqrt((mapW * mapH) / (REF_MAP_W * REF_MAP_H));

  const scale = Math.sqrt(fromPaper * fromPx);
  return Math.min(2.85, Math.max(0.72, scale));
}

/**
 * Stroke / icon scale — sublinear so large sheets stay crisp, not cartoon-thick.
 * Applied instead of raw visualScale on lines and symbols.
 */
export function printStrokeScale(visualScale: number): number {
  const s = Math.max(0.72, visualScale);
  return Math.min(1.32, Math.max(0.9, Math.pow(s, 0.35)));
}

/** Slight zoom nudge for icons only — most sizing comes from printStrokeScale. */
export function printSymbolZoom(mapZoom: number, visualScale: number): number {
  const boost = Math.log2(Math.max(0.72, visualScale)) * 0.4;
  return Math.min(16, Math.max(8, mapZoom + boost));
}

export const PRINT_LABEL_BASE_PX = 8.5;
export const PRINT_FEEDER_LABEL_BASE_PX = 7.5;

const LABEL_SIZE_MULT: Record<PrintLabelSize, number> = {
  small: 0.85,
  normal: 1,
  large: 1.28,
};

export function labelSizeMultiplier(size: PrintLabelSize = 'normal'): number {
  return LABEL_SIZE_MULT[size] ?? 1;
}

export function scaledLabelPx(
  base: number,
  visualScale: number,
  labelSize: PrintLabelSize = 'normal',
): number {
  return Math.min(24, Math.max(6, base * visualScale * labelSizeMultiplier(labelSize)));
}
