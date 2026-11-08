import L from 'leaflet';
import type { Substation, TrunkLine } from '@/domain/types';
import { haversineKm } from '@/domain/geo';

export const SNAP_PX = 18;

export type SnapSs = {
  kind: 'substation';
  id: string;
  name: string;
  lat: number;
  lng: number;
  distPx: number;
  distKm: number;
};

export type SnapLinePoint = {
  kind: 'line';
  id: string;
  name: string;
  lat: number;
  lng: number;
  distPx: number;
};

function pxDist(map: L.Map, a: L.LatLngExpression, b: L.LatLngExpression): number {
  return map.latLngToContainerPoint(a).distanceTo(map.latLngToContainerPoint(b));
}

/** Nearest substation within SNAP_PX of the cursor (excludes `exceptId`). */
export function nearestSubstation(
  map: L.Map,
  cursor: L.LatLng,
  substations: Substation[],
  exceptId?: string | null,
): SnapSs | null {
  let best: SnapSs | null = null;
  for (const ss of substations) {
    if (exceptId && ss.id === exceptId) continue;
    const distPx = pxDist(map, cursor, [ss.lat, ss.lng]);
    if (distPx > SNAP_PX) continue;
    if (best && distPx >= best.distPx) continue;
    best = {
      kind: 'substation',
      id: ss.id,
      name: ss.name,
      lat: ss.lat,
      lng: ss.lng,
      distPx,
      distKm: haversineKm(cursor.lat, cursor.lng, ss.lat, ss.lng),
    };
  }
  return best;
}

/**
 * Closest point on any trunk line segment to the cursor, if within SNAP_PX.
 * `ssById` supplies endpoints.
 */
export function nearestPointOnLines(
  map: L.Map,
  cursor: L.LatLng,
  lines: TrunkLine[],
  ssById: Map<string, Substation>,
  exceptLineId?: string | null,
): SnapLinePoint | null {
  const zoom = map.getZoom();
  const cPt = map.project(cursor, zoom);
  let best: SnapLinePoint | null = null;

  for (const line of lines) {
    if (exceptLineId && line.id === exceptLineId) continue;
    const from = ssById.get(line.fromId);
    const to = ssById.get(line.toId);
    if (!from || !to) continue;

    const a = map.project(L.latLng(from.lat, from.lng), zoom);
    const b = map.project(L.latLng(to.lat, to.lng), zoom);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t =
      len2 === 0 ? 0 : Math.max(0, Math.min(1, ((cPt.x - a.x) * dx + (cPt.y - a.y) * dy) / len2));
    const closest = L.point(a.x + dx * t, a.y + dy * t);
    const distPx = cPt.distanceTo(closest);
    if (distPx > SNAP_PX) continue;
    if (best && distPx >= best.distPx) continue;

    const ll = map.unproject(closest, zoom);
    best = {
      kind: 'line',
      id: line.id,
      name: line.name,
      lat: ll.lat,
      lng: ll.lng,
      distPx,
    };
  }
  return best;
}
