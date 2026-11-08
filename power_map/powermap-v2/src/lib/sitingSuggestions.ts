import { haversineKm } from '@/domain/geo';
import type { Substation } from '@/domain/types';
import { loadDistrictPolygons } from '@/lib/districts';

/** Planning scope for 33 kV gap analysis */
export const SITING_DISTRICTS = [
  'Malda',
  'Dakshin Dinajpur',
  'Uttar Dinajpur',
] as const;

export type SitingNearSs = {
  id: string;
  name: string;
  km: number;
};

export type SitingCandidate = {
  id: string;
  lat: number;
  lng: number;
  district: string;
  /** Distance to nearest existing/proposed 33 kV SS (km) */
  gapKm: number;
  nearestSsId: string;
  nearestSsName: string;
  /** Nearby 33 kV substations sorted by distance (nearest first) */
  nearerSs: SitingNearSs[];
};

export type SitingAnalysis = {
  districts: string[];
  ssCount: number;
  medianNearestKm: number;
  meanNearestKm: number;
  /** Typical neighbour spacing (median NN) */
  targetSpacingKm: number;
  /** Desired coverage radius ≈ half of typical spacing */
  coverageRadiusKm: number;
  /** A sample is a gap if nearest SS is farther than this */
  gapThresholdKm: number;
  /** Min distance kept between suggested sites */
  candidateSpacingKm: number;
  candidates: SitingCandidate[];
  message: string | null;
};

type Ring = number[][];
type DistrictPoly = { name: string; rings: Ring[] };

type GridCell = {
  lat: number;
  lng: number;
  district: string;
  gapKm: number;
  nearestSsId: string;
  nearestSsName: string;
  row: number;
  col: number;
};

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

function ringBounds(ring: Ring): { minLng: number; maxLng: number; minLat: number; maxLat: number } {
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

function studyBounds(districts: DistrictPoly[]) {
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

function nearerStations(
  lat: number,
  lng: number,
  stations: Substation[],
  maxKm: number,
  limit = 12,
): SitingNearSs[] {
  return stations
    .map((ss) => ({
      id: ss.id,
      name: ss.name,
      km: haversineKm(lat, lng, ss.lat, ss.lng),
    }))
    .filter((n) => n.km <= maxKm)
    .sort((a, b) => a.km - b.km)
    .slice(0, limit);
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

/**
 * True if the point is well inside the *union* of the study districts.
 * Checks that offsets at `bufferKm` still land in the study area — so shared
 * internal district borders are OK, but the outer state/district edge is not.
 */
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
 * Suggest new 33 kV sites from the spacing pattern of existing 33 kV
 * substations inside Malda + Dakshin/Uttar Dinajpur.
 *
 * Guards against border clustering:
 * - gaps measured vs *all* 33 kV SS (not only in-district)
 * - candidates must sit inward of the study-area outer edge
 * - only local maxima of the gap field are kept
 * - candidates are spaced ~ typical neighbour spacing apart
 */
export async function analyze33KvSiting(
  substations: Substation[],
  opts?: {
    maxCandidates?: number;
    /** When true, proposed 33 kV SS are ignored for spacing and coverage. */
    excludeProposed33?: boolean;
  },
): Promise<SitingAnalysis> {
  const maxCandidates = opts?.maxCandidates ?? 15;
  const excludeProposed33 = opts?.excludeProposed33 ?? true;
  const want = new Set(SITING_DISTRICTS.map((n) => n.toLowerCase()));
  const allDistricts = await loadDistrictPolygons();
  const districts = allDistricts.filter((d) => want.has(d.name.toLowerCase())) as DistrictPoly[];

  const empty = (message: string): SitingAnalysis => ({
    districts: [...SITING_DISTRICTS],
    ssCount: 0,
    medianNearestKm: 0,
    meanNearestKm: 0,
    targetSpacingKm: 0,
    coverageRadiusKm: 0,
    gapThresholdKm: 0,
    candidateSpacingKm: 0,
    candidates: [],
    message,
  });

  if (districts.length < 3) {
    return empty('Could not load all three district boundaries. Check network and retry.');
  }

  const all33 = substations.filter(
    (ss) =>
      ss.voltageCode === '33' &&
      ss.status !== 'retired' &&
      (!excludeProposed33 || ss.status !== 'proposed'),
  );

  const inScope = all33.filter((ss) => districts.some((d) => pointInDistrict(ss.lng, ss.lat, d)));

  if (inScope.length < 2) {
    return empty(
      `Need at least two ${excludeProposed33 ? 'existing ' : ''}33 kV substations in the three districts (found ${inScope.length}).`,
    );
  }

  // Spacing pattern from in-district SS only
  const nnKm: number[] = [];
  for (const ss of inScope) {
    const n = nearestAmong(ss.lat, ss.lng, inScope, ss.id);
    if (n) nnKm.push(n.km);
  }

  const medianNearestKm = median(nnKm);
  const meanNearestKm = nnKm.reduce((a, b) => a + b, 0) / nnKm.length;
  const targetSpacingKm = medianNearestKm;
  const coverageRadiusKm = targetSpacingKm / 2;
  // Underserved if farther than ~65% of typical spacing from any 33 kV
  const gapThresholdKm = Math.max(coverageRadiusKm * 1.15, targetSpacingKm * 0.55);
  // Keep suggested sites roughly one typical spacing apart
  const candidateSpacingKm = Math.max(targetSpacingKm * 0.9, gapThresholdKm * 1.35);
  // Stay this far inside the outer study boundary (avoids state-border false gaps)
  const borderBufferKm = Math.max(targetSpacingKm * 0.45, gapThresholdKm * 0.85, 4);

  // Grid ~1/3 of spacing so local maxima resolve cleanly
  const stepKm = Math.min(5, Math.max(2.5, targetSpacingKm * 0.33));
  const bounds = studyBounds(districts);
  const midLat = (bounds.minLat + bounds.maxLat) / 2;
  const latStep = stepKm / 111;
  const lngStep = stepKm / (111 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));

  const cols = Math.floor((bounds.maxLng - bounds.minLng) / lngStep) + 1;
  const rows = Math.floor((bounds.maxLat - bounds.minLat) / latStep) + 1;
  const grid: (GridCell | null)[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => null),
  );

  for (let row = 0; row < rows; row++) {
    const lat = bounds.minLat + row * latStep;
    for (let col = 0; col < cols; col++) {
      const lng = bounds.minLng + col * lngStep;
      const district = inStudy(lng, lat, districts);
      if (!district) continue;
      if (!isInteriorPoint(lng, lat, districts, borderBufferKm)) continue;

      // Distance to *any* 33 kV — outside SS suppress false border gaps
      const near = nearestAmong(lat, lng, all33);
      if (!near || near.km < gapThresholdKm) continue;

      grid[row][col] = {
        lat: Number(lat.toFixed(6)),
        lng: Number(lng.toFixed(6)),
        district: district.name,
        gapKm: near.km,
        nearestSsId: near.ss.id,
        nearestSsName: near.ss.name,
        row,
        col,
      };
    }
  }

  // Keep only local maxima of the gap field (true holes, not ridge along edge)
  const peaks: GridCell[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cell = grid[row][col];
      if (!cell) continue;
      let isPeak = true;
      for (let dr = -1; dr <= 1 && isPeak; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const n = grid[row + dr]?.[col + dc];
          if (n && n.gapKm > cell.gapKm + 0.05) {
            isPeak = false;
            break;
          }
        }
      }
      if (isPeak) peaks.push(cell);
    }
  }

  peaks.sort((a, b) => b.gapKm - a.gapKm);
  const picked: SitingCandidate[] = [];
  // List every 33 kV within ~2.5× typical spacing (or at least past the gap)
  const nearerRadiusKm = Math.max(targetSpacingKm * 2.5, gapThresholdKm * 2.2, 20);

  for (const c of peaks) {
    if (picked.length >= maxCandidates) break;
    const tooClose = picked.some(
      (p) => haversineKm(c.lat, c.lng, p.lat, p.lng) < candidateSpacingKm,
    );
    if (tooClose) continue;

    const nearerSs = nearerStations(c.lat, c.lng, all33, nearerRadiusKm);
    picked.push({
      id: `sit-${picked.length + 1}-${c.lat.toFixed(4)}-${c.lng.toFixed(4)}`,
      lat: c.lat,
      lng: c.lng,
      district: c.district,
      gapKm: c.gapKm,
      nearestSsId: c.nearestSsId,
      nearestSsName: c.nearestSsName,
      nearerSs,
    });
  }

  return {
    districts: [...SITING_DISTRICTS],
    ssCount: inScope.length,
    medianNearestKm,
    meanNearestKm,
    targetSpacingKm,
    coverageRadiusKm,
    gapThresholdKm,
    candidateSpacingKm,
    candidates: picked,
    message:
      picked.length === 0
        ? `No interior gaps above ${gapThresholdKm.toFixed(1)} km (typical spacing ${targetSpacingKm.toFixed(1)} km).`
        : null,
  };
}
