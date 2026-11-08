import type { AssetLifecycle, VoltageCode } from '@/domain/types';
import { VOLTAGE_CATALOG } from '@/domain/types';
import L from 'leaflet';

export function voltageColor(code: VoltageCode): string {
  return VOLTAGE_CATALOG.find((v) => v.code === code)?.color ?? '#64748b';
}

/**
 * Pixel size for SS markers by map zoom — quieter overview, full size near district/local.
 * Map minZoom is ~7; full size from ~13.
 */
export function ssSymbolSizeForZoom(zoom: number, selected = false): number {
  const z = Math.max(6, Math.min(16, zoom));
  let base: number;
  if (z <= 7) base = 10;
  else if (z <= 8) base = 12;
  else if (z <= 9) base = 14;
  else if (z <= 10) base = 17;
  else if (z <= 11) base = 19;
  else if (z <= 12) base = 21;
  else base = 22;
  return selected ? Math.min(28, Math.round(base * 1.28)) : base;
}

export function tapSymbolSizeForZoom(zoom: number, selected = false): number {
  const z = Math.max(6, Math.min(16, zoom));
  let base: number;
  if (z <= 8) base = 6;
  else if (z <= 10) base = 8;
  else if (z <= 12) base = 10;
  else base = 12;
  return selected ? Math.min(16, base + 4) : base;
}

/** Line weight scale: slightly thinner when zoomed out so corridors don't dominate. */
export function lineWeightScaleForZoom(zoom: number): number {
  if (zoom <= 8) return 0.55;
  if (zoom <= 9) return 0.7;
  if (zoom <= 10) return 0.85;
  return 1;
}

/** SVG symbol by voltage: square / diamond / hexagon / pentagon / circle */
export function substationIcon(
  voltage: VoltageCode,
  status: AssetLifecycle,
  selected = false,
  zoom = 12,
  sizeScale = 1,
): L.DivIcon {
  const color = voltageColor(voltage);
  const filled = status === 'existing';
  const size = Math.round(
    Math.min(52, Math.max(9, ssSymbolSizeForZoom(zoom, selected) * sizeScale)),
  );
  const stroke = size <= 12 ? (selected ? 2 : 1.25) : selected ? 3 : 2;
  const strokeW = Math.max(1, stroke * Math.sqrt(sizeScale));
  const shape = shapeSvg(voltage, size, color, filled, strokeW);

  return L.divIcon({
    className: 'pm-ss-icon',
    html: `<div class="pm-ss-wrap${selected ? ' is-selected' : ''}" style="width:${size}px;height:${size}px">${shape}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function shapeSvg(
  voltage: VoltageCode,
  size: number,
  color: string,
  filled: boolean,
  stroke: number,
): string {
  const fill = filled ? color : 'transparent';
  const common = `fill="${fill}" stroke="${color}" stroke-width="${stroke}"`;
  const pad = Math.max(2, Math.round(size * 0.14));

  if (voltage === '400') {
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect x="${pad}" y="${pad}" width="${size - pad * 2}" height="${size - pad * 2}" ${common}/></svg>`;
  }
  if (voltage === '220') {
    const c = size / 2;
    const r = size / 2 - pad;
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><polygon points="${c},${c - r} ${c + r},${c} ${c},${c + r} ${c - r},${c}" ${common}/></svg>`;
  }
  if (voltage === '132') {
    const c = size / 2;
    const r = size / 2 - pad;
    const pts = [0, 1, 2, 3, 4, 5]
      .map((i) => {
        const a = (Math.PI / 3) * i - Math.PI / 2;
        return `${c + r * Math.cos(a)},${c + r * Math.sin(a)}`;
      })
      .join(' ');
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><polygon points="${pts}" ${common}/></svg>`;
  }
  if (voltage === '66') {
    const c = size / 2;
    const r = size / 2 - pad;
    const pts = [0, 1, 2, 3, 4]
      .map((i) => {
        const a = (Math.PI * 2) / 5 * i - Math.PI / 2;
        return `${c + r * Math.cos(a)},${c + r * Math.sin(a)}`;
      })
      .join(' ');
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><polygon points="${pts}" ${common}/></svg>`;
  }
  // 33 kV circle
  const c = size / 2;
  const r = size / 2 - pad;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${c}" cy="${c}" r="${r}" ${common}/></svg>`;
}

export function tapIcon(selected = false, zoom = 12): L.DivIcon {
  const size = tapSymbolSizeForZoom(zoom, selected);
  return L.divIcon({
    className: 'pm-tap-icon',
    html: `<div class="pm-tap-mark${selected ? ' is-selected' : ''}" style="width:${size}px;height:${size}px"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export function lineStyle(
  voltage: VoltageCode,
  status: AssetLifecycle,
  selected = false,
  isTap = false,
  opts?: { circuitIndex?: number; parallelTotal?: number; zoom?: number; sizeScale?: number },
): L.PolylineOptions {
  const parallel = (opts?.parallelTotal ?? 1) > 1;
  const ckt2 = parallel && (opts?.circuitIndex ?? 0) > 0;
  const scale = lineWeightScaleForZoom(opts?.zoom ?? 12) * (opts?.sizeScale ?? 1);
  const base = selected ? (isTap ? 4 : 5.5) : isTap ? 2.5 : ckt2 ? 3.2 : 3.8;

  return {
    color: voltageColor(voltage),
    weight: Math.max(1, base * scale),
    opacity: selected ? 1 : ckt2 ? 0.95 : 0.88,
    dashArray: status === 'proposed' ? '8 6' : undefined,
    lineCap: 'round',
    lineJoin: 'round',
  };
}
