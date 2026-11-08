import L from 'leaflet';

export type SsLabelInput = {
  id: string;
  name: string;
  lat: number;
  lng: number;
};

export type SsLabelPlacement = {
  id: string;
  name: string;
  anchorLat: number;
  anchorLng: number;
  labelLat: number;
  labelLng: number;
  /** True when label was moved away — draw a leader line */
  callout: boolean;
};

type Box = { x: number; y: number; w: number; h: number };

function estimateSize(name: string, scale = 1): { w: number; h: number } {
  const w = Math.min(
    180 * scale,
    Math.max(40 * scale, name.length * 5.6 * scale + 10 * scale),
  );
  return { w, h: 14 * scale };
}

/** Exported for print drag — must match layout collision box sizing. */
export function estimateLabelSize(name: string, scale = 1): { w: number; h: number } {
  return estimateSize(name, scale);
}

/** Screen-space Y offset below SS symbol — matches live map `.pm-ss-label`. */
const MAP_LABEL_OFFSET_Y = 12;

/** Screen-space visual center for a label marker (matches print CSS transforms). */
export function labelVisualCenterLatLng(
  map: L.Map,
  labelLat: number,
  labelLng: number,
  name: string,
  callout: boolean,
  layoutScale: number,
): L.LatLng {
  if (callout) return L.latLng(labelLat, labelLng);
  const pt = map.latLngToContainerPoint([labelLat, labelLng]);
  const { h } = estimateSize(name, layoutScale);
  const y = MAP_LABEL_OFFSET_Y * Math.max(0.85, layoutScale);
  return map.containerPointToLatLng(L.point(pt.x, pt.y + y + h / 2));
}

function overlaps(a: Box, b: Box, pad = 4): boolean {
  return !(
    a.x + a.w + pad <= b.x ||
    b.x + b.w + pad <= a.x ||
    a.y + a.h + pad <= b.y ||
    b.y + b.h + pad <= a.y
  );
}

function boxAt(cx: number, cy: number, w: number, h: number): Box {
  // Label is centered on the placement point for callouts; default sits to the right
  return { x: cx, y: cy - h / 2, w, h };
}

/** Candidate pixel offsets from the marker (dx, dy). */
function offsetRing(radius: number): [number, number][] {
  const out: [number, number][] = [];
  const steps = Math.max(8, Math.round(radius / 4));
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2 - Math.PI / 2;
    out.push([Math.cos(a) * radius, Math.sin(a) * radius]);
  }
  return out;
}

/** Default print labels at the SS — same placement idea as the live map (no auto callouts). */
export function mapStyleSsLabelPlacements(items: SsLabelInput[]): SsLabelPlacement[] {
  return items.map((it) => ({
    id: it.id,
    name: it.name,
    anchorLat: it.lat,
    anchorLng: it.lng,
    labelLat: it.lat,
    labelLng: it.lng,
    callout: false,
  }));
}

/**
 * Place SS name labels in screen space so they don't overlap.
 * Overlapping names are nudged outward with a callout leader.
 * @deprecated Prefer mapStyleSsLabelPlacements for print; use Arrange labels to fix overlaps.
 */
export function layoutSsLabels(
  map: L.Map,
  items: SsLabelInput[],
  visualScale = 1,
): SsLabelPlacement[] {
  const size = map.getSize();
  if (size.x < 40 || size.y < 40 || !items.length) {
    return items.map((it) => ({
      id: it.id,
      name: it.name,
      anchorLat: it.lat,
      anchorLng: it.lng,
      labelLat: it.lat,
      labelLng: it.lng,
      callout: false,
    }));
  }

  // Prefer denser clusters first so they claim nearby slots
  const sorted = [...items].sort((a, b) => {
    const densA = items.filter(
      (o) => Math.abs(o.lat - a.lat) + Math.abs(o.lng - a.lng) < 0.05,
    ).length;
    const densB = items.filter(
      (o) => Math.abs(o.lat - b.lat) + Math.abs(o.lng - b.lng) < 0.05,
    ).length;
    if (densB !== densA) return densB - densA;
    return a.name.localeCompare(b.name);
  });

  const placed: { box: Box; placement: SsLabelPlacement }[] = [];
  const s = Math.max(0.72, visualScale);
  const defaultOffsets: [number, number][] = [
    [12, -7],
    [12, 8],
    [-12, -7],
    [-12, 8],
    [0, -16],
    [0, 16],
    [24, 0],
    [-24, 0],
    ...offsetRing(28 * s),
    ...offsetRing(40 * s),
    ...offsetRing(54 * s),
    ...offsetRing(70 * s),
    ...offsetRing(88 * s),
  ].map(([dx, dy]) => [dx * s, dy * s] as [number, number]);

  for (const it of sorted) {
    const pt = map.latLngToContainerPoint([it.lat, it.lng]);
    const { w, h } = estimateSize(it.name, s);
    let chosen: { dx: number; dy: number; callout: boolean } | null = null;

    for (const [dx, dy] of defaultOffsets) {
      // First offset is "home" (no callout if free)
      const callout = Math.hypot(dx, dy) > 18 * s;
      const cx = callout ? pt.x + dx : pt.x + dx;
      const cy = callout ? pt.y + dy : pt.y + dy;
      const box = callout
        ? { x: cx - w / 2, y: cy - h / 2, w, h }
        : boxAt(cx, cy, w, h);

      // Keep mostly on-map
      if (box.x < -20 || box.y < -10 || box.x + box.w > size.x + 20 || box.y + box.h > size.y + 10) {
        continue;
      }

      const hit = placed.some((p) => overlaps(box, p.box));
      if (!hit) {
        chosen = { dx, dy, callout: Math.hypot(dx, dy) > 16 * s };
        break;
      }
    }

    if (!chosen) {
      // Last resort: push further out on a diagonal
      chosen = { dx: 96 * s, dy: -24 * s * (placed.length % 5), callout: true };
    }

    const labelPt = L.point(pt.x + chosen.dx, pt.y + chosen.dy);
    const ll = map.containerPointToLatLng(labelPt);
    const box = chosen.callout
      ? {
          x: labelPt.x - w / 2,
          y: labelPt.y - h / 2,
          w,
          h,
        }
      : boxAt(labelPt.x, labelPt.y, w, h);

    const placement: SsLabelPlacement = {
      id: it.id,
      name: it.name,
      anchorLat: it.lat,
      anchorLng: it.lng,
      labelLat: ll.lat,
      labelLng: ll.lng,
      callout: chosen.callout,
    };
    placed.push({ box, placement });
  }

  return placed.map((p) => p.placement);
}
