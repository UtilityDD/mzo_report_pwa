import { haversineKm } from '@/domain/geo';
import type { Substation } from '@/domain/types';
import { loadDistrictPolygons } from '@/lib/districts';
import { SITING_DISTRICTS } from '@/lib/sitingSuggestions';

export type VoltageCheckCell = {
  id: string;
  lat: number;
  lng: number;
  district: string;
  /** Distance to nearest in-service 33 kV SS (km) */
  dist33Km: number;
  nearest33Id: string;
  nearest33Name: string;
  dist132Km: number | null;
  nearest132Name: string | null;
  farFrom132: boolean;
  row: number;
  col: number;
};

export type VoltageCheckBounds = {
  minLng: number;
  maxLng: number;
  minLat: number;
  maxLat: number;
};

export type VoltageCheckAnalysis = {
  districts: string[];
  ss33Count: number;
  targetSpacingKm: number;
  cutOffKm: number;
  bounds: VoltageCheckBounds;
  cells: VoltageCheckCell[];
  /** Local maxima of the far field — seed for the side list */
  hotspots: VoltageCheckCell[];
  message: string | null;
};

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

function pointInDistrict(lng: number, lat: number, d: DistrictPoly): boolean {
  return d.rings.some((ring) => pointInRing(lng, lat, ring));
}

function inStudy(lng: number, lat: number, districts: DistrictPoly[]): DistrictPoly | null {
  return districts.find((d) => pointInDistrict(lng, lat, d)) ?? null;
}

function ringBounds(ring: Ring): VoltageCheckBounds {
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const p of ring) {
    minLng = Math.min(minLng, p[0]);
    maxLng = Math.max(maxLng, p[0]);
    minLat = Math.min(minLat, p[1]);
    maxLat = Math.max(maxLat, p[1]);
  }
  return { minLng, maxLng, minLat, maxLat };
}

function studyBounds(districts: DistrictPoly[]): VoltageCheckBounds {
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const d of districts) {
    for (const ring of d.rings) {
      const b = ringBounds(ring);
      minLng = Math.min(minLng, b.minLng);
      maxLng = Math.max(maxLng, b.maxLng);
      minLat = Math.min(minLat, b.minLat);
      maxLat = Math.max(maxLat, b.maxLat);
    }
  }
  return { minLng, maxLng, minLat, maxLat };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function nearestAmong(
  lat: number,
  lng: number,
  stations: Substation[],
  exceptId?: string,
): { ss: Substation; km: number } | null {
  let best: { ss: Substation; km: number } | null = null;
  for (const ss of stations) {
    if (exceptId && ss.id === exceptId) continue;
    const km = haversineKm(lat, lng, ss.lat, ss.lng);
    if (!best || km < best.km) best = { ss, km };
  }
  return best;
}

function isInteriorPoint(
  lng: number,
  lat: number,
  districts: DistrictPoly[],
  bufferKm: number,
): boolean {
  if (!inStudy(lng, lat, districts)) return false;
  const dLat = bufferKm / 111;
  const dLng = bufferKm / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const offsets: [number, number][] = [
    [0, dLat],
    [0, -dLat],
    [dLng, 0],
    [-dLng, 0],
    [dLng * 0.7, dLat * 0.7],
    [dLng * 0.7, -dLat * 0.7],
    [-dLng * 0.7, dLat * 0.7],
    [-dLng * 0.7, -dLat * 0.7],
  ];
  return offsets.every(([dlng, dlat]) => Boolean(inStudy(lng + dlng, lat + dlat, districts)));
}

/**
 * Distance wash for areas farther than a cut-off from any in-service 33 kV SS.
 * Districts and cut-off are caller-controlled (defaults: study trio + auto spacing).
 */
export async function analyzeVoltageCheck(
  substations: Substation[],
  opts?: {
    maxHotspots?: number;
    /** District names to analyse (must match boundary names). */
    districtNames?: string[];
    /** Manual cut-off in km; omit / null / ≤0 for auto from 33 kV spacing. */
    cutOffKm?: number | null;
    /** When true, proposed 33 kV SS are ignored for distance. */
    excludeProposed33?: boolean;
    /** When true, proposed 132 kV SS are ignored for the far-from-132 flag. */
    excludeProposed132?: boolean;
  },
): Promise<VoltageCheckAnalysis> {
  const maxHotspots = opts?.maxHotspots ?? 40;
  const excludeProposed33 = opts?.excludeProposed33 ?? true;
  const excludeProposed132 = opts?.excludeProposed132 ?? true;
  const requested =
    opts?.districtNames?.filter((n) => n.trim().length > 0) ?? [...SITING_DISTRICTS];
  const scopeNames = requested.length > 0 ? requested : [...SITING_DISTRICTS];
  const want = new Set(scopeNames.map((n) => n.toLowerCase()));
  const allDistricts = await loadDistrictPolygons();
  const districts = allDistricts.filter((d) => want.has(d.name.toLowerCase())) as DistrictPoly[];
  const resolvedNames = districts.map((d) => d.name);

  const empty = (message: string, cutOffKm = 0): VoltageCheckAnalysis => ({
    districts: resolvedNames.length ? resolvedNames : scopeNames,
    ss33Count: 0,
    targetSpacingKm: 0,
    cutOffKm,
    bounds: { minLng: 0, maxLng: 0, minLat: 0, maxLat: 0 },
    cells: [],
    hotspots: [],
    message,
  });

  if (districts.length === 0) {
    return empty(
      `Could not load boundaries for: ${scopeNames.join(', ')}. Check district names and retry.`,
    );
  }
  if (districts.length < scopeNames.length) {
    const found = new Set(resolvedNames.map((n) => n.toLowerCase()));
    const missing = scopeNames.filter((n) => !found.has(n.toLowerCase()));
    if (missing.length) {
      return empty(`Missing district boundaries: ${missing.join(', ')}.`);
    }
  }

  const all33 = substations.filter(
    (ss) =>
      ss.voltageCode === '33' &&
      ss.status !== 'retired' &&
      (!excludeProposed33 || ss.status !== 'proposed'),
  );
  const all132 = substations.filter(
    (ss) =>
      ss.voltageCode === '132' &&
      ss.status !== 'retired' &&
      (!excludeProposed132 || ss.status !== 'proposed'),
  );
  const inScope = all33.filter((ss) => districts.some((d) => pointInDistrict(ss.lng, ss.lat, d)));

  if (inScope.length < 1) {
    return empty(
      `No ${excludeProposed33 ? 'existing ' : ''}33 kV substations in ${resolvedNames.join(', ')}.`,
    );
  }

  const nnKm: number[] = [];
  for (const ss of inScope) {
    const n = nearestAmong(ss.lat, ss.lng, inScope, ss.id);
    if (n) nnKm.push(n.km);
  }

  const manualCutOff =
    opts?.cutOffKm != null && Number.isFinite(opts.cutOffKm) && opts.cutOffKm > 0
      ? opts.cutOffKm
      : null;

  const targetSpacingKm = nnKm.length
    ? median(nnKm)
    : manualCutOff != null
      ? manualCutOff * 2
      : 12;
  const coverageRadiusKm = targetSpacingKm / 2;
  const autoCutOff = Math.max(coverageRadiusKm * 1.25, targetSpacingKm * 0.65);
  const cutOffKm = manualCutOff ?? autoCutOff;
  const far132Km = Math.max(cutOffKm * 1.5, targetSpacingKm * 1.1);
  const borderBufferKm = Math.max(Math.min(targetSpacingKm * 0.4, cutOffKm * 0.5), 2.5);

  const stepKm = Math.min(5, Math.max(2.5, targetSpacingKm * 0.33));
  const bounds = studyBounds(districts);
  const midLat = (bounds.minLat + bounds.maxLat) / 2;
  const latStep = stepKm / 111;
  const lngStep = stepKm / (111 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));

  const cols = Math.floor((bounds.maxLng - bounds.minLng) / lngStep) + 1;
  const rows = Math.floor((bounds.maxLat - bounds.minLat) / latStep) + 1;
  const grid: (VoltageCheckCell | null)[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => null),
  );

  const cells: VoltageCheckCell[] = [];

  for (let row = 0; row < rows; row++) {
    const lat = bounds.minLat + row * latStep;
    for (let col = 0; col < cols; col++) {
      const lng = bounds.minLng + col * lngStep;
      const district = inStudy(lng, lat, districts);
      if (!district) continue;
      if (!isInteriorPoint(lng, lat, districts, borderBufferKm)) continue;

      const near33 = nearestAmong(lat, lng, all33);
      if (!near33 || near33.km < cutOffKm) continue;

      const near132 = nearestAmong(lat, lng, all132);
      const dist132Km = near132 ? near132.km : null;
      const cell: VoltageCheckCell = {
        id: `vc-${row}-${col}`,
        lat: Number(lat.toFixed(6)),
        lng: Number(lng.toFixed(6)),
        district: district.name,
        dist33Km: near33.km,
        nearest33Id: near33.ss.id,
        nearest33Name: near33.ss.name,
        dist132Km,
        nearest132Name: near132?.ss.name ?? null,
        farFrom132: dist132Km != null && dist132Km >= far132Km,
        row,
        col,
      };
      grid[row][col] = cell;
      cells.push(cell);
    }
  }

  const peaks: VoltageCheckCell[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cell = grid[row][col];
      if (!cell) continue;
      let isPeak = true;
      for (let dr = -1; dr <= 1 && isPeak; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const n = grid[row + dr]?.[col + dc];
          if (n && n.dist33Km > cell.dist33Km + 0.05) {
            isPeak = false;
            break;
          }
        }
      }
      if (isPeak) peaks.push(cell);
    }
  }

  peaks.sort((a, b) => b.dist33Km - a.dist33Km);
  const hotspots = peaks.slice(0, maxHotspots);

  return {
    districts: resolvedNames,
    ss33Count: inScope.length,
    targetSpacingKm,
    cutOffKm,
    bounds,
    cells,
    hotspots,
    message:
      cells.length === 0
        ? `No interior areas past ${cutOffKm.toFixed(1)} km from 33 kV (typical spacing ${targetSpacingKm.toFixed(1)} km).`
        : null,
  };
}

/** Soft red–amber wash — strongest on far tails; near-cutoff stays almost clear. */
export function buildVoltageCheckWashDataUrl(
  analysis: VoltageCheckAnalysis,
  width = 640,
  height = 640,
): string | null {
  if (!analysis.cells.length || typeof document === 'undefined') return null;
  const { bounds, cells, cutOffKm } = analysis;
  const spanLng = bounds.maxLng - bounds.minLng;
  const spanLat = bounds.maxLat - bounds.minLat;
  if (spanLng <= 0 || spanLat <= 0) return null;

  const byDist = [...cells].sort((a, b) => a.dist33Km - b.dist33Km);
  // Prefer painting the worse half; if few cells, paint all of them
  const floorIdx =
    cells.length <= 12
      ? 0
      : Math.min(byDist.length - 1, Math.floor(byDist.length * 0.5));
  const washFloor = Math.max(cutOffKm, byDist[floorIdx]?.dist33Km ?? cutOffKm);
  const washCells = cells.filter((c) => c.dist33Km >= washFloor);
  if (!washCells.length) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const maxExtra = Math.max(
    0.5,
    ...washCells.map((c) => c.dist33Km - washFloor),
  );
  const rPx = Math.max(14, Math.min(width, height) * 0.032);

  for (const cell of washCells) {
    const x = ((cell.lng - bounds.minLng) / spanLng) * width;
    const y = ((bounds.maxLat - cell.lat) / spanLat) * height;
    // Steep ramp: near washFloor almost invisible, red only on extremes
    const linear = Math.min(1, Math.max(0, (cell.dist33Km - washFloor) / maxExtra));
    const t = linear * linear;
    const r = Math.round(245 + t * 10);
    const g = Math.round(170 - t * 140);
    const b = Math.round(20 + t * 20);
    const a = 0.08 + t * 0.55;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, rPx);
    grad.addColorStop(0, `rgba(${r},${g},${b},${a})`);
    grad.addColorStop(0.5, `rgba(${r},${g},${b},${a * 0.32})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, rPx, 0, Math.PI * 2);
    ctx.fill();
  }

  return canvas.toDataURL('image/png');
}

export function nearestVoltageCheckCell(
  lat: number,
  lng: number,
  cells: VoltageCheckCell[],
  maxKm = 4,
): VoltageCheckCell | null {
  let best: VoltageCheckCell | null = null;
  let bestKm = maxKm;
  for (const c of cells) {
    const km = haversineKm(lat, lng, c.lat, c.lng);
    if (km < bestKm) {
      bestKm = km;
      best = c;
    }
  }
  return best;
}
