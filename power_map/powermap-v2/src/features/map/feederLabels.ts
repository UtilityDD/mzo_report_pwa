import L from 'leaflet';

/**
 * Mid-length point on the path + screen angle of the rendered Leaflet line.
 * Offset from the line is applied in CSS pixels (stable across zoom).
 */
export function feederLabelPlacement(
  map: L.Map,
  path: [number, number][],
  circuitIndex: number,
  parallelTotal: number,
): { lat: number; lng: number; angleDeg: number; side: 1 | -1 } {
  if (path.length < 2) {
    const p = path[0] ?? [0, 0];
    return { lat: p[0], lng: p[1], angleDeg: 0, side: 1 };
  }

  const zoom = map.getZoom();
  const pts = path.map(([lat, lng]) => map.project(L.latLng(lat, lng), zoom));
  const segLens: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    const len = Math.sqrt(dx * dx + dy * dy);
    segLens.push(len);
    total += len;
  }

  const target = total / 2;
  let walked = 0;
  let segIdx = 0;
  let t = 0.5;
  for (let i = 0; i < segLens.length; i++) {
    if (walked + segLens[i] >= target || i === segLens.length - 1) {
      segIdx = i;
      t = segLens[i] > 0 ? (target - walked) / segLens[i] : 0.5;
      t = Math.min(1, Math.max(0, t));
      break;
    }
    walked += segLens[i];
  }

  const a = pts[segIdx];
  const b = pts[segIdx + 1] ?? pts[segIdx];
  const mid = L.point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  const ll = map.unproject(mid, zoom);

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (angleDeg > 90) angleDeg -= 180;
  if (angleDeg < -90) angleDeg += 180;

  const side: 1 | -1 =
    parallelTotal <= 1 ? 1 : circuitIndex < (parallelTotal - 1) / 2 ? -1 : 1;

  return { lat: ll.lat, lng: ll.lng, angleDeg, side };
}

/** Pixel gap from line — tighter when zoomed in, a bit more room when zoomed out. */
export function feederLabelOffsetPx(zoom: number, parallelTotal: number, sizeScale = 1) {
  const base = Math.max(7, Math.min(16, 22 - zoom));
  return (base + (parallelTotal > 1 ? 3 : 0)) * sizeScale;
}
