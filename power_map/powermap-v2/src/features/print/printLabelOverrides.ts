import L from 'leaflet';
import { estimateLabelSize, type SsLabelPlacement } from '@/features/print/labelLayout';

export type PrintSsLabelOverride = {
  labelLat: number;
  labelLng: number;
};

const CALLOUT_PX = 14;
const DEFAULT_LABEL_OFFSET_Y = 12;

/** Merge auto-layout with user-dragged positions (screen-space callout detection). */
export function mergeLabelPlacements(
  placements: SsLabelPlacement[],
  overrides: Record<string, PrintSsLabelOverride>,
  map: L.Map,
): SsLabelPlacement[] {
  if (!Object.keys(overrides).length) return placements;
  return placements.map((p) => {
    const o = overrides[p.id];
    if (!o) return p;
    const anchor = map.latLngToContainerPoint([p.anchorLat, p.anchorLng]);
    const label = map.latLngToContainerPoint([o.labelLat, o.labelLng]);
    const callout = anchor.distanceTo(label) > CALLOUT_PX;
    return {
      ...p,
      labelLat: o.labelLat,
      labelLng: o.labelLng,
      callout,
    };
  });
}

/**
 * Leaflet marker position for a print SS label.
 * In arrange mode, anchor = visual text center so drag does not jump on first grab.
 */
export function printLabelMarkerLatLng(
  map: L.Map,
  placement: SsLabelPlacement,
  layoutScale: number,
  arrange: boolean,
  override?: PrintSsLabelOverride,
): { lat: number; lng: number; centered: boolean } {
  if (override) {
    return { lat: override.labelLat, lng: override.labelLng, centered: true };
  }
  if (placement.callout || !arrange) {
    return {
      lat: placement.labelLat,
      lng: placement.labelLng,
      centered: placement.callout,
    };
  }
  const { h } = estimateLabelSize(placement.name, layoutScale);
  const pt = map.latLngToContainerPoint([placement.labelLat, placement.labelLng]);
  const y = DEFAULT_LABEL_OFFSET_Y * Math.max(0.85, layoutScale);
  const center = map.containerPointToLatLng(L.point(pt.x, pt.y + y + h / 2));
  return { lat: center.lat, lng: center.lng, centered: true };
}
