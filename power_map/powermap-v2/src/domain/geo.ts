import type { Substation, TransformerUnit, TrunkLine, VoltageCode } from './types';

export function formatCapacity(units: TransformerUnit[]): string {
  if (!units.length) return '—';
  return [...units]
    .sort((a, b) => a.sequence - b.sequence)
    .map((u) => `${u.quantity}×${trimNum(u.ratingMva)}`)
    .join(' + ') + ' MVA';
}

export function installedMva(units: TransformerUnit[]): number {
  return units.reduce((sum, u) => sum + u.ratingMva * u.quantity, 0);
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n);
}

export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(d: number) {
  return (d * Math.PI) / 180;
}

/** Point at ratio t along a straight segment */
export function pointAlong(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
  t: number,
): { lat: number; lng: number } {
  return {
    lat: lat1 + (lat2 - lat1) * t,
    lng: lng1 + (lng2 - lng1) * t,
  };
}

/** Closest point ratio on segment A→B to click P */
export function closestRatioOnSegment(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
  pLat: number,
  pLng: number,
): number {
  const dx = bLng - aLng;
  const dy = bLat - aLat;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return 0.5;
  let t = ((pLng - aLng) * dx + (pLat - aLat) * dy) / len2;
  return Math.min(0.95, Math.max(0.05, t));
}

/** Offset parallel polylines for multi-circuit display (degrees approx) */
export function offsetLatLngs(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
  index: number,
  count: number,
  spacingMeters = 18,
): [[number, number], [number, number]] {
  const path = parallelCircuitLatLngs(lat1, lng1, lat2, lng2, index, count, spacingMeters);
  return [path[0], path[path.length - 1]];
}

/**
 * Multi-point path for parallel circuits.
 * Circuit 1 stays on the straight corridor; circuit 2+ bow out near both ends
 * so both feeders stay visible at the substations and along the span.
 */
export function parallelCircuitLatLngs(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
  index: number,
  count: number,
  spacingMeters = 42,
  segments = 24,
): [number, number][] {
  if (count <= 1) return [[lat1, lng1], [lat2, lng2]];

  const mid = (count - 1) / 2;
  const offsetIndex = index - mid;
  // Keep first circuit nearly on-center; push others farther for clarity
  const signed =
    index === 0 && count === 2
      ? -0.35
      : offsetIndex === 0
        ? 0
        : offsetIndex;

  const dx = lng2 - lng1;
  const dy = lat2 - lat1;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const midLat = (lat1 + lat2) / 2;
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos((midLat * Math.PI) / 180) || 1;
  const nx = -dy / len;
  const ny = dx / len;

  const points: [number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const baseLat = lat1 + dy * t;
    const baseLng = lng1 + dx * t;
    const envelope = parallelOffsetEnvelope(t, index, count);
    const meters = signed * spacingMeters * envelope;
    const ox = (nx * meters) / mPerDegLng;
    const oy = (ny * meters) / mPerDegLat;
    points.push([baseLat + oy, baseLng + ox]);
  }
  // Snap true endpoints so lines meet the SS markers
  points[0] = [lat1, lng1];
  points[points.length - 1] = [lat2, lng2];
  return points;
}

/** 0 at terminals, rises quickly near ends, flat along mid-span */
function parallelOffsetEnvelope(t: number, index: number, count: number): number {
  const edge = 0.16;
  let body = 1;
  if (t < edge) body = smoothstep(0, edge, t);
  else if (t > 1 - edge) body = smoothstep(0, edge, 1 - t);

  // Extra bow on 2nd+ feeder near both ends so it peels away from Ckt 1
  if (index > 0 || count > 2) {
    const nearStart = Math.exp(-((t - 0.12) ** 2) / (2 * 0.04 ** 2));
    const nearEnd = Math.exp(-((t - 0.88) ** 2) / (2 * 0.04 ** 2));
    const bow = 1 + 0.55 * (nearStart + nearEnd);
    return body * bow;
  }
  return body * 0.55;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0 || 1)));
  return t * t * (3 - 2 * t);
}

export function defaultLineName(
  from: Substation,
  to: Substation,
  voltage: VoltageCode,
  opts?: { circuitCount?: number; conductor?: string; parallelTotal?: number },
) {
  const base = `${from.name} – ${to.name} (${voltage} kV)`;
  const multi = (opts?.parallelTotal ?? opts?.circuitCount ?? 1) > 1;
  if (!multi) return base;
  const ckt = opts?.circuitCount ?? 1;
  const cond = opts?.conductor?.trim();
  return `${base} · Ckt ${ckt}${cond ? ` · ${cond}` : ''}`;
}

/** Hover / list label distinguishing parallel circuits */
export function lineDisplayLabel(
  line: { name: string; circuitCount: number; conductor: string },
  parallelTotal = 1,
) {
  if (parallelTotal <= 1 && !line.conductor) return line.name;
  const parts = [line.name];
  // Name may already include Ckt / conductor from import; avoid doubling
  const hasCkt = /·\s*Ckt\s*\d+/i.test(line.name);
  if (!hasCkt && parallelTotal > 1) parts.push(`Ckt ${line.circuitCount}`);
  if (line.conductor && !line.name.includes(line.conductor)) parts.push(line.conductor);
  return parts.join(' · ');
}

export function isOverloaded(loadingPct: number | null, threshold = 80): boolean {
  return loadingPct != null && loadingPct >= threshold;
}

export function isOldAsset(year: number | null, cutoffYear = 2000): boolean {
  return year != null && year < cutoffYear;
}
