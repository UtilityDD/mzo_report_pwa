import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { formatCapacity, parallelCircuitLatLngs } from '@/domain/geo';
import type { Substation, TapLateral, TapNode, TrunkLine } from '@/domain/types';
import { createBasemapLayer, basemapToBack } from '@/features/map/boundaryLayers';
import { feederLabelOffsetPx, feederLabelPlacement } from '@/features/map/feederLabels';
import { lineStyle, substationIcon, tapIcon } from '@/features/map/symbology';
import { labelVisualCenterLatLng, mapStyleSsLabelPlacements, type SsLabelPlacement } from '@/features/print/labelLayout';
import {
  mergeLabelPlacements,
  type PrintSsLabelOverride,
} from '@/features/print/printLabelOverrides';
import {
  buildPrintAssets,
  buildPrintStyleSheet,
  paperSizeMm,
  previewSheetPx,
  printSheetTitle,
  PRINT_BASEMAPS,
  PRINT_LABEL_SIZE_OPTIONS,
  PRINT_PREVIEW_DPI_OPTIONS,
  type PrintSettings,
} from '@/lib/printLayout';
import { printSaveFilename, printSaveFilenameStem } from '@/lib/outputNames';
import { listStripFraction, sheetSizeLabel } from '@/lib/printSuggest';
import {
  computePrintVisualScale,
  labelSizeMultiplier,
  printStrokeScale,
  printSymbolZoom,
  scaledLabelPx,
  PRINT_FEEDER_LABEL_BASE_PX,
  PRINT_LABEL_BASE_PX,
} from '@/lib/printVisualScale';
import { useNetworkStore } from '@/store/networkStore';

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Soft max zoom — higher DPI loads sharper tiles when the pane is large enough. */
function maxZoomForPaper(settings: PrintSettings): number {
  let z: number;
  switch (settings.paperId) {
    case 'a4':
      z = 14;
      break;
    case 'a3':
      z = 15;
      break;
    case 'a2':
      z = 16;
      break;
    case 'a1':
      z = 17;
      break;
    default:
      z = 15;
  }
  const dpi = settings.previewDpi ?? 96;
  if (dpi >= 200) z += 2;
  else if (dpi >= 150) z += 1;
  return z;
}

function listColumnCount(n: number): number {
  if (n > 56) return 4;
  if (n > 32) return 3;
  if (n > 14) return 2;
  return 1;
}

export type PrintPreviewMapApi = {
  fit: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
};

function PrintMiniMap({
  substations,
  lines,
  tapNodes,
  tapLaterals,
  inDistrictIds,
  bounds,
  contentBounds,
  districtCount,
  districtBoundaries,
  settings,
  layoutKey,
  visualScale,
  labelOverrides,
  labelArrangeMode,
  labelLayoutEpoch,
  onLabelMove,
  onMapReady,
}: {
  substations: Substation[];
  lines: TrunkLine[];
  tapNodes: TapNode[];
  tapLaterals: TapLateral[];
  inDistrictIds: string[];
  bounds: [[number, number], [number, number]] | null;
  contentBounds: [[number, number], [number, number]] | null;
  districtCount: number;
  districtBoundaries: { name: string; latLngRings: [number, number][][] }[];
  settings: PrintSettings;
  layoutKey: string;
  visualScale: number;
  labelOverrides: Record<string, PrintSsLabelOverride>;
  labelArrangeMode: boolean;
  /** Bump to invalidate cached auto-layout (reset labels, scope change). */
  labelLayoutEpoch: number;
  onLabelMove: (id: string, lat: number, lng: number) => void;
  onMapReady?: (api: PrintPreviewMapApi) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const networkRef = useRef<L.FeatureGroup | null>(null);
  const districtsLayerRef = useRef<L.FeatureGroup | null>(null);
  const basemapRef = useRef<L.Layer | null>(null);
  const placeLabelsRef = useRef<() => void>(() => {});
  const boundsRef = useRef(bounds);
  const contentBoundsRef = useRef(contentBounds);
  const districtCountRef = useRef(districtCount);
  const settingsRef = useRef(settings);
  const inDistrictRef = useRef(inDistrictIds);
  const visualScaleRef = useRef(visualScale);
  const labelOverridesRef = useRef(labelOverrides);
  const labelArrangeModeRef = useRef(labelArrangeMode);
  const onLabelMoveRef = useRef(onLabelMove);
  const onMapReadyRef = useRef(onMapReady);
  const userViewRef = useRef(false);
  const fittingRef = useRef(false);
  const labelLayoutCacheKeyRef = useRef('');
  const labelLayoutCacheRef = useRef<SsLabelPlacement[]>([]);
  const labelLayoutEpochRef = useRef(labelLayoutEpoch);
  const draggingLabelIdRef = useRef<string | null>(null);
  boundsRef.current = bounds;
  contentBoundsRef.current = contentBounds;
  districtCountRef.current = districtCount;
  settingsRef.current = settings;
  inDistrictRef.current = inDistrictIds;
  visualScaleRef.current = visualScale;
  labelOverridesRef.current = labelOverrides;
  labelArrangeModeRef.current = labelArrangeMode;
  labelLayoutEpochRef.current = labelLayoutEpoch;
  onLabelMoveRef.current = onLabelMove;
  onMapReadyRef.current = onMapReady;

  const strokeScale = () => printStrokeScale(visualScaleRef.current);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.style.setProperty('--print-visual-scale', String(visualScale));
    el.dataset.printScale = visualScale.toFixed(2);
  }, [visualScale, layoutKey]);

  const symbolZoom = (map: L.Map) =>
    printSymbolZoom(map.getZoom(), visualScaleRef.current);

  const fitToContent = (map: L.Map, force = false) => {
    if (userViewRef.current && !force) return;
    const s = settingsRef.current;
    const districts = districtsLayerRef.current;
    const dCount = districtCountRef.current;
    map.invalidateSize(false);
    const size = map.getSize();
    if (size.x < 40 || size.y < 40) return;

    let target: L.LatLngBounds | null = null;

    const content = contentBoundsRef.current;
    if (content) {
      const cb = L.latLngBounds(content);
      if (cb.isValid()) target = cb;
    }

    // Single district: include full district outline for framing.
    if (dCount <= 1 && districts && districts.getLayers().length > 0) {
      const db = districts.getBounds();
      if (db.isValid()) target = target ? target.extend(db) : db;
    }

    if (!target && boundsRef.current) {
      const bb = L.latLngBounds(boundsRef.current);
      if (bb.isValid()) target = bb;
    }

    if (!target || !target.isValid()) {
      map.setView([25.85, 88.55], 9);
      fittingRef.current = false;
      return;
    }

    const padFrac = dCount > 1 ? 0.02 : 0.012;
    const padX = Math.max(4, Math.round(size.x * padFrac));
    const padY = Math.max(4, Math.round(size.y * padFrac));
    fittingRef.current = true;
    map.fitBounds(target, {
      animate: false,
      padding: [padY, padX],
      maxZoom: maxZoomForPaper(s),
    });
    window.setTimeout(() => {
      fittingRef.current = false;
    }, 0);
  };

  // Init map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      zoomControl: false,
      attributionControl: false,
      dragging: true,
      scrollWheelZoom: true,
      doubleClickZoom: true,
      boxZoom: false,
      keyboard: false,
    });
    const initialBasemap = settingsRef.current.basemap || 'esri';
    if (initialBasemap !== 'none') {
      const layer = createBasemapLayer(initialBasemap);
      layer.addTo(map);
      basemapRef.current = layer;
    }
    map.getContainer().classList.toggle('basemap-none', initialBasemap === 'none');
    const districts = L.featureGroup().addTo(map);
    const network = L.featureGroup().addTo(map);
    districtsLayerRef.current = districts;
    networkRef.current = network;
    mapRef.current = map;

    const ro = new ResizeObserver(() => {
      window.requestAnimationFrame(() => {
        if (mapRef.current && !userViewRef.current) fitToContent(mapRef.current);
      });
    });
    ro.observe(containerRef.current);

    const markUserView = () => {
      if (fittingRef.current) return;
      userViewRef.current = true;
    };
    map.on('zoomend', markUserView);
    map.on('dragend', markUserView);

    const api: PrintPreviewMapApi = {
      fit: () => {
        userViewRef.current = false;
        fitToContent(map, true);
        placeLabelsRef.current();
      },
      zoomIn: () => {
        userViewRef.current = true;
        map.zoomIn();
        placeLabelsRef.current();
      },
      zoomOut: () => {
        userViewRef.current = true;
        map.zoomOut();
        placeLabelsRef.current();
      },
    };
    onMapReadyRef.current?.(api);

    const onPrintPrepare = () => {
      userViewRef.current = false;
      fitToContent(map, true);
      placeLabelsRef.current();
      window.setTimeout(() => {
        fitToContent(map, true);
        placeLabelsRef.current();
      }, 80);
      window.setTimeout(() => {
        fitToContent(map, true);
        placeLabelsRef.current();
      }, 250);
    };
    window.addEventListener('powermap:print-prepare', onPrintPrepare);

    return () => {
      ro.disconnect();
      map.off('zoomend', markUserView);
      map.off('dragend', markUserView);
      window.removeEventListener('powermap:print-prepare', onPrintPrepare);
      map.remove();
      mapRef.current = null;
      networkRef.current = null;
      districtsLayerRef.current = null;
      basemapRef.current = null;
    };
  }, []);

  // Swap basemap when preview selection changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const id = settings.basemap || 'esri';
    if (basemapRef.current) {
      map.removeLayer(basemapRef.current);
      basemapRef.current = null;
    }
    if (id !== 'none') {
      const next = createBasemapLayer(id);
      next.addTo(map);
      basemapToBack(next);
      basemapRef.current = next;
    }
    map.getContainer().classList.toggle('basemap-none', id === 'none');
    window.requestAnimationFrame(() => {
      fitToContent(map);
      placeLabelsRef.current();
    });
  }, [settings.basemap]);

  // Draw district boundaries
  useEffect(() => {
    const map = mapRef.current;
    const group = districtsLayerRef.current;
    if (!map || !group) return;
    group.clearLayers();

    if (settings.showDistrictBoundaries) {
      districtBoundaries.forEach((d) => {
        d.latLngRings.forEach((ring) => {
          if (ring.length < 3) return;
          group.addLayer(
            L.polygon(ring, {
              color: '#0f172a',
              weight: Math.max(0.65, 1.1 * strokeScale()),
              opacity: 0.9,
              fillColor: '#64748b',
              fillOpacity: 0.04,
              interactive: false,
            }),
          );
        });
      });
    }

    fitToContent(map);
  }, [districtBoundaries, settings.showDistrictBoundaries, layoutKey, visualScale]);

  // Draw network
  useEffect(() => {
    const map = mapRef.current;
    const group = networkRef.current;
    if (!map || !group) return;

    group.clearLayers();

    const vs = strokeScale();
    const z = symbolZoom(map);
    const ssById = new Map(substations.map((s) => [s.id, s]));

    const pairKey = (a: string, b: string) => [a, b].sort().join('|');
    const groups = new Map<string, TrunkLine[]>();
    lines.forEach((l) => {
      const key = pairKey(l.fromId, l.toId);
      const g = groups.get(key) ?? [];
      g.push(l);
      groups.set(key, g);
    });

    groups.forEach((groupLines) => {
      const sorted = [...groupLines].sort(
        (a, b) => a.circuitCount - b.circuitCount || a.name.localeCompare(b.name),
      );
      sorted.forEach((line, index) => {
        const from = ssById.get(line.fromId);
        const to = ssById.get(line.toId);
        if (!from || !to) return;
        const path = parallelCircuitLatLngs(
          from.lat,
          from.lng,
          to.lat,
          to.lng,
          index,
          sorted.length,
        );
        group.addLayer(
          L.polyline(path, {
            ...lineStyle(line.voltageCode, line.status, false, false, {
              circuitIndex: index,
              parallelTotal: sorted.length,
              zoom: z,
              sizeScale: vs,
            }),
            interactive: false,
          }),
        );

        // Feeder length labels are placed after fitBounds (same mid-span logic as main map)
      });
    });

    const lineIds = new Set(lines.map((l) => l.id));
    const tapById = new Map(tapNodes.map((t) => [t.id, t]));
    tapLaterals.forEach((lat) => {
      const fromTap = tapById.get(lat.fromTapId);
      if (!fromTap) return;
      let toLat: number;
      let toLng: number;
      if (lat.toKind === 'substation') {
        const target = ssById.get(lat.toAssetId);
        if (!target) return;
        toLat = target.lat;
        toLng = target.lng;
      } else {
        const toTap = tapById.get(lat.toAssetId);
        if (!toTap) return;
        toLat = toTap.lat;
        toLng = toTap.lng;
      }
      group.addLayer(
        L.polyline(
          [
            [fromTap.lat, fromTap.lng],
            [toLat, toLng],
          ],
          {
            ...lineStyle(lat.voltageCode, lat.status, false, true, {
              zoom: z,
              sizeScale: vs,
            }),
            interactive: false,
          },
        ),
      );
    });

    tapNodes.forEach((tap) => {
      if (!lineIds.has(tap.parentLineId)) return;
      group.addLayer(
        L.marker([tap.lat, tap.lng], {
          icon: tapIcon(false, z),
          interactive: false,
          zIndexOffset: 380,
        }),
      );
    });

    substations.forEach((ss) => {
      // In-district symbols only here. Outside symbols are added after fitBounds
      // when the SS falls inside the page view.
      if (inDistrictIds.length && !inDistrictIds.includes(ss.id)) return;
      group.addLayer(
        L.marker([ss.lat, ss.lng], {
          icon: substationIcon(ss.voltageCode, ss.status, false, z, vs),
          interactive: false,
          zIndexOffset: 400,
        }),
      );
    });

    const placeFeederLengths = () => {
      if (!settings.showFeederLength) return;
      const mapZ = map.getZoom();
      const scale = visualScaleRef.current;
      const labelSize = settingsRef.current.labelSize ?? 'normal';
      group.eachLayer((layer) => {
        const any = layer as L.Layer & { options?: { pmPrintFeederLen?: boolean } };
        if (any.options?.pmPrintFeederLen) group.removeLayer(layer);
      });

      groups.forEach((groupLines) => {
        const sorted = [...groupLines].sort(
          (a, b) => a.circuitCount - b.circuitCount || a.name.localeCompare(b.name),
        );
        sorted.forEach((line, index) => {
          if (line.lengthKm == null) return;
          const from = ssById.get(line.fromId);
          const to = ssById.get(line.toId);
          if (!from || !to) return;
          const path = parallelCircuitLatLngs(
            from.lat,
            from.lng,
            to.lat,
            to.lng,
            index,
            sorted.length,
          );
          const place = feederLabelPlacement(map, path, index, sorted.length);
          const gap = feederLabelOffsetPx(mapZ, sorted.length, strokeScale()) * place.side;
          const fontPx = scaledLabelPx(PRINT_FEEDER_LABEL_BASE_PX, scale, labelSize);
          const icon = L.divIcon({
            className: 'print-map-label print-feeder-label',
            html: `<div class="print-feeder-label-rot" style="transform:translate(-50%,-50%) rotate(${place.angleDeg.toFixed(2)}deg) translateY(${-gap}px)"><span style="font-size:${fontPx.toFixed(2)}px">${Number(line.lengthKm).toFixed(1)} km</span></div>`,
            iconSize: [0, 0],
            iconAnchor: [0, 0],
          });
          group.addLayer(
            L.marker([place.lat, place.lng], {
              icon,
              interactive: false,
              zIndexOffset: 200,
              pmPrintFeederLen: true,
            } as L.MarkerOptions & { pmPrintFeederLen: boolean }),
          );
        });
      });
    };

    const placeLabels = () => {
      const scale = visualScaleRef.current;
      const labelSize = settingsRef.current.labelSize ?? 'normal';
      const stroke = strokeScale();
      const labelPx = scaledLabelPx(PRINT_LABEL_BASE_PX, scale, labelSize);
      const layoutScale = scale * labelSizeMultiplier(labelSize);
      const calloutWeight = Math.max(0.5, 0.65 * stroke);
      const dotR = Math.max(1.2, 1.6 * stroke);
      const arrange = labelArrangeModeRef.current;
      group.eachLayer((layer) => {
        const any = layer as L.Layer & {
          options?: { pmPrintLabel?: boolean; pmPrintOutsideSs?: boolean };
        };
        if (any.options?.pmPrintLabel || any.options?.pmPrintOutsideSs) {
          group.removeLayer(layer);
        }
      });

      const inSet = new Set(inDistrictIds);
      const coreSs =
        inDistrictIds.length > 0
          ? substations.filter((ss) => inSet.has(ss.id))
          : substations;

      if (settings.showSsNames) {
        const cacheKey = `${layoutKey}-e${labelLayoutEpochRef.current}-s${settings.showSsNames}-ls${labelSize}-vs${layoutScale.toFixed(2)}-n${coreSs.length}`;
        if (labelLayoutCacheKeyRef.current !== cacheKey) {
          labelLayoutCacheKeyRef.current = cacheKey;
          labelLayoutCacheRef.current = mapStyleSsLabelPlacements(
            coreSs.map((ss) => ({
              id: ss.id,
              name: ss.name,
              lat: ss.lat,
              lng: ss.lng,
            })),
          );
        }
        const placements = mergeLabelPlacements(
          labelLayoutCacheRef.current,
          labelOverridesRef.current,
          map,
        );

        const leaderHi = {
          color: '#2563eb',
          weight: Math.max(1.2, calloutWeight * 1.65),
          opacity: 1,
          dashArray: `${Math.max(3, 3 * stroke)} ${Math.max(4, 4 * stroke)}`,
        };
        const leaderNormal = {
          color: '#94a3b8',
          weight: calloutWeight,
          opacity: 0.7,
          dashArray: `${Math.max(2, 2 * stroke)} ${Math.max(3, 3 * stroke)}`,
        };
        const dotHi = {
          color: '#2563eb',
          weight: Math.max(1.1, stroke),
          fillColor: '#dbeafe',
          fillOpacity: 1,
        };
        const dotNormal = {
          color: '#475569',
          weight: Math.max(0.6, stroke * 0.85),
          fillColor: '#ffffff',
          fillOpacity: 1,
        };

        type PrintLabelLayerOpts = {
          pmPrintLabel?: boolean;
          pmPrintSsId?: string;
          pmPrintLeaderLine?: boolean;
          pmPrintLeaderDot?: boolean;
        };

        const findSsLabelLayers = (ssId: string) => {
          let line: L.Polyline | null = null;
          let dot: L.CircleMarker | null = null;
          let labelMarker: L.Marker | null = null;
          group.eachLayer((layer) => {
            const opts = (layer as L.Layer & { options?: PrintLabelLayerOpts }).options;
            if (opts?.pmPrintSsId !== ssId) return;
            if (opts.pmPrintLeaderLine) line = layer as L.Polyline;
            else if (opts.pmPrintLeaderDot) dot = layer as L.CircleMarker;
            else if (opts.pmPrintLabel) labelMarker = layer as L.Marker;
          });
          return { line, dot, labelMarker };
        };

        const setLabelDragVisual = (ssId: string | null, active: boolean) => {
          const root = containerRef.current;
          if (root) root.classList.toggle('label-drag-active', active);
          draggingLabelIdRef.current = active ? ssId : null;
          if (!ssId) return;
          const { line, dot, labelMarker } = findSsLabelLayers(ssId);
          line?.setStyle(active ? leaderHi : leaderNormal);
          dot?.setStyle(active ? dotHi : dotNormal);
          const iconEl = labelMarker?.getElement();
          iconEl?.classList.toggle('is-dragging', active);
        };

        const upsertLeader = (
          ssId: string,
          anchorLat: number,
          anchorLng: number,
          labelLat: number,
          labelLng: number,
          active: boolean,
        ) => {
          const dist = map
            .latLngToContainerPoint([anchorLat, anchorLng])
            .distanceTo(map.latLngToContainerPoint([labelLat, labelLng]));
          if (dist <= 8) return;

          let { line, dot } = findSsLabelLayers(ssId);
          if (!line) {
            line = L.polyline(
              [
                [anchorLat, anchorLng],
                [labelLat, labelLng],
              ],
              {
                ...leaderNormal,
                interactive: false,
                pmPrintLabel: true,
                pmPrintSsId: ssId,
                pmPrintLeaderLine: true,
              } as L.PolylineOptions & PrintLabelLayerOpts,
            );
            group.addLayer(line);
          } else {
            line.setLatLngs([
              [anchorLat, anchorLng],
              [labelLat, labelLng],
            ]);
          }
          line.setStyle(active ? leaderHi : leaderNormal);

          if (!dot) {
            dot = L.circleMarker([anchorLat, anchorLng], {
              radius: dotR,
              ...dotNormal,
              interactive: false,
              pmPrintLabel: true,
              pmPrintSsId: ssId,
              pmPrintLeaderDot: true,
            } as L.CircleMarkerOptions & PrintLabelLayerOpts);
            group.addLayer(dot);
          }
          dot.setStyle(active ? dotHi : dotNormal);
        };

        placements.forEach((p) => {
          const override = labelOverridesRef.current[p.id];
          const centered =
            Boolean(override) || arrange || p.callout;
          let markerLat = override?.labelLat ?? p.labelLat;
          let markerLng = override?.labelLng ?? p.labelLng;
          if (arrange && !override && !p.callout) {
            const center = labelVisualCenterLatLng(
              map,
              p.labelLat,
              p.labelLng,
              p.name,
              false,
              layoutScale,
            );
            markerLat = center.lat;
            markerLng = center.lng;
          }
          const showLeader =
            map
              .latLngToContainerPoint([p.anchorLat, p.anchorLng])
              .distanceTo(map.latLngToContainerPoint([markerLat, markerLng])) > 14;

          if (showLeader) {
            group.addLayer(
              L.polyline(
                [
                  [p.anchorLat, p.anchorLng],
                  [markerLat, markerLng],
                ],
                {
                  ...leaderNormal,
                  interactive: false,
                  pmPrintLabel: true,
                  pmPrintSsId: p.id,
                  pmPrintLeaderLine: true,
                } as L.PolylineOptions & PrintLabelLayerOpts,
              ),
            );
            group.addLayer(
              L.circleMarker([p.anchorLat, p.anchorLng], {
                radius: dotR,
                ...dotNormal,
                interactive: false,
                pmPrintLabel: true,
                pmPrintSsId: p.id,
                pmPrintLeaderDot: true,
              } as L.CircleMarkerOptions & PrintLabelLayerOpts),
            );
          }

          const icon = L.divIcon({
            className: `print-map-label print-ss-label${centered ? ' is-callout' : ''}${arrange ? ' is-draggable' : ''}`,
            html: `<span style="font-size:${labelPx.toFixed(2)}px">${escapeHtml(p.name)}</span>`,
            iconSize: [0, 0],
            iconAnchor: [0, 0],
          });
          const marker = L.marker([markerLat, markerLng], {
            icon,
            draggable: arrange,
            interactive: arrange,
            zIndexOffset: 500,
            pmPrintLabel: true,
            pmPrintSsId: p.id,
          } as L.MarkerOptions & { pmPrintLabel: boolean; pmPrintSsId: string });
          if (arrange) {
            const ssId = p.id;
            marker.on('dragstart', (e) => {
              L.DomEvent.stopPropagation(e);
              setLabelDragVisual(ssId, true);
              upsertLeader(
                ssId,
                p.anchorLat,
                p.anchorLng,
                marker.getLatLng().lat,
                marker.getLatLng().lng,
                true,
              );
            });
            marker.on('drag', (e) => {
              L.DomEvent.stopPropagation(e);
              const ll = marker.getLatLng();
              upsertLeader(ssId, p.anchorLat, p.anchorLng, ll.lat, ll.lng, true);
            });
            marker.on('dragend', (e) => {
              L.DomEvent.stopPropagation(e);
              setLabelDragVisual(null, false);
              const ll = marker.getLatLng();
              onLabelMoveRef.current(ssId, ll.lat, ll.lng);
            });
          }
          group.addLayer(marker);
        });
      }

      // Outside linked ends: symbol + name if the SS sits in the page view;
      // otherwise feeder stub name only (no symbol off-page).
      if (inDistrictIds.length > 0) {
        const view = map.getBounds().pad(0.02);
        const labeled = new Set<string>();
        lines.forEach((line) => {
          const fromIn = inSet.has(line.fromId);
          const toIn = inSet.has(line.toId);
          if (fromIn === toIn) return;
          const inside = ssById.get(fromIn ? line.fromId : line.toId);
          const outside = ssById.get(fromIn ? line.toId : line.fromId);
          if (!inside || !outside || labeled.has(outside.id)) return;
          labeled.add(outside.id);

          const onPage = view.contains(L.latLng(outside.lat, outside.lng));
          if (onPage) {
            group.addLayer(
              L.marker([outside.lat, outside.lng], {
                icon: substationIcon(
                  outside.voltageCode,
                  outside.status,
                  false,
                  symbolZoom(map),
                  strokeScale(),
                ),
                interactive: false,
                zIndexOffset: 420,
                pmPrintOutsideSs: true,
              } as L.MarkerOptions & { pmPrintOutsideSs: boolean }),
            );
            if (settings.showSsNames) {
              const icon = L.divIcon({
                className: 'print-map-label print-ss-label print-link-label',
                html: `<span style="font-size:${labelPx.toFixed(2)}px">${escapeHtml(outside.name)}</span>`,
                iconSize: [0, 0],
                iconAnchor: [0, 0],
              });
              group.addLayer(
                L.marker([outside.lat, outside.lng], {
                  icon,
                  interactive: false,
                  zIndexOffset: 480,
                  pmPrintLabel: true,
                } as L.MarkerOptions & { pmPrintLabel: boolean }),
              );
            }
          } else if (settings.showSsNames) {
            const t = 0.78;
            const lat = inside.lat + (outside.lat - inside.lat) * t;
            const lng = inside.lng + (outside.lng - inside.lng) * t;
            const icon = L.divIcon({
              className: 'print-map-label print-ss-label print-link-label is-callout',
              html: `<span style="font-size:${labelPx.toFixed(2)}px">${escapeHtml(outside.name)}</span>`,
              iconSize: [0, 0],
              iconAnchor: [0, 0],
            });
            group.addLayer(
              L.marker([lat, lng], {
                icon,
                interactive: false,
                zIndexOffset: 480,
                pmPrintLabel: true,
              } as L.MarkerOptions & { pmPrintLabel: boolean }),
            );
          }
        });
      }
    };
    placeLabelsRef.current = () => {
      placeFeederLengths();
      placeLabels();
    };

    if (!labelArrangeModeRef.current) {
      fitToContent(map);
    }
    placeFeederLengths();
    placeLabels();
    const t = labelArrangeModeRef.current
      ? undefined
      : window.setTimeout(() => {
          fitToContent(map);
          placeFeederLengths();
          placeLabels();
        }, 140);
    return () => {
      if (t !== undefined) window.clearTimeout(t);
    };
  }, [
    substations,
    lines,
    tapNodes,
    tapLaterals,
    inDistrictIds,
    bounds,
    contentBounds,
    districtCount,
    settings.showSsNames,
    settings.showFeederLength,
    settings.labelSize,
    layoutKey,
    visualScale,
    labelLayoutEpoch,
  ]);

  // Repaint labels only when overrides or arrange mode change — avoid redrawing network.
  useEffect(() => {
    labelOverridesRef.current = labelOverrides;
    placeLabelsRef.current();
  }, [labelOverrides]);

  useEffect(() => {
    labelArrangeModeRef.current = labelArrangeMode;
    labelLayoutCacheKeyRef.current = '';
    placeLabelsRef.current();
  }, [labelArrangeMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    userViewRef.current = false;
    const t1 = window.setTimeout(() => fitToContent(map, true), 50);
    const t2 = window.setTimeout(() => fitToContent(map, true), 200);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [layoutKey]);

  // Full-page arrange: normal map pan; resize map when entering/exiting.
  useEffect(() => {
    const map = mapRef.current;
    const el = containerRef.current;
    if (!map || !el) return;

    map.scrollWheelZoom.enable();
    map.doubleClickZoom.enable();
    map.dragging.enable();
    el.classList.remove('space-pan');

    const run = () => {
      map.invalidateSize(false);
      userViewRef.current = false;
      labelLayoutCacheKeyRef.current = '';
      fitToContent(map, true);
      placeLabelsRef.current();
    };
    const t1 = window.requestAnimationFrame(run);
    const t2 = window.setTimeout(run, 120);
    return () => {
      window.cancelAnimationFrame(t1);
      window.clearTimeout(t2);
    };
  }, [labelArrangeMode]);

  return (
    <div
      ref={containerRef}
      className={`print-map-canvas${labelArrangeMode ? ' labels-arrange' : ''}`}
    />
  );
}

export function PrintSheet({
  settings,
  onClose,
}: {
  settings: PrintSettings;
  onClose: () => void;
}) {
  const allSs = useNetworkStore((s) => s.substations);
  const allLines = useNetworkStore((s) => s.lines);
  const allTapNodes = useNetworkStore((s) => s.tapNodes);
  const allTapLaterals = useNetworkStore((s) => s.tapLaterals);
  const setPrintSettings = useNetworkStore((s) => s.setPrintSettings);
  const [bundle, setBundle] = useState<Awaited<ReturnType<typeof buildPrintAssets>> | null>(
    null,
  );
  const [busy, setBusy] = useState(true);
  const [isPrinting, setIsPrinting] = useState(false);
  const [labelArrangeMode, setLabelArrangeMode] = useState(false);
  const [labelOverrides, setLabelOverrides] = useState<Record<string, PrintSsLabelOverride>>(
    {},
  );
  const [labelLayoutEpoch, setLabelLayoutEpoch] = useState(0);
  const [viewport, setViewport] = useState(() =>
    typeof window !== 'undefined'
      ? { width: window.innerWidth, height: window.innerHeight }
      : { width: 1200, height: 800 },
  );
  const savedDocumentTitle = useRef<string | null>(null);
  const mapApiRef = useRef<PrintPreviewMapApi | null>(null);
  const handleMapReady = useCallback((api: PrintPreviewMapApi) => {
    mapApiRef.current = api;
  }, []);
  const printScopeKey = `${settings.districts.join('|')}-${settings.showProposed}`;

  useEffect(() => {
    setLabelOverrides({});
    setLabelArrangeMode(false);
    setLabelLayoutEpoch((n) => n + 1);
  }, [printScopeKey]);

  useEffect(() => {
    const onResize = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const districtNames =
    settings.districts.length > 0
      ? settings.districts
      : (bundle?.districtNames ?? []);
  const saveFilename = printSaveFilename(settings, districtNames);
  const saveFilenameStem = printSaveFilenameStem(settings, districtNames);

  const applyPrintDocumentTitle = () => {
    if (savedDocumentTitle.current === null) {
      savedDocumentTitle.current = document.title;
    }
    document.title = saveFilenameStem;
  };

  const restoreDocumentTitle = () => {
    if (savedDocumentTitle.current !== null) {
      document.title = savedDocumentTitle.current;
      savedDocumentTitle.current = null;
    }
  };

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void buildPrintAssets(allSs, allLines, settings.districts, {
      includeProposed: settings.showProposed,
      tapNodes: allTapNodes,
      tapLaterals: allTapLaterals,
    })
      .then((b) => {
        if (!cancelled) {
          setBundle(b);
          setBusy(false);
        }
      })
      .catch((err) => {
        console.error('[PrintSheet] buildPrintAssets failed', err);
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [allSs, allLines, allTapNodes, allTapLaterals, settings.districts, settings.showProposed]);

  const size = paperSizeMm(settings);
  const preview = useMemo(
    () => previewSheetPx(settings, viewport),
    [settings, viewport],
  );
  const layoutKey = `${settings.paperId}-${settings.orientation}-${preview.widthPx}x${preview.heightPx}-${settings.previewDpi}-${size.widthMm}x${size.heightMm}-${settings.showSsList}-${settings.listSide}-${settings.labelSize}`;

  const listRows = useMemo(() => {
    const inDistrict = new Set(bundle?.inDistrictIds ?? []);
    const source =
      inDistrict.size > 0
        ? (bundle?.substations ?? []).filter((s) => inDistrict.has(s.id))
        : (bundle?.substations ?? []);
    return [...source].sort((a, b) => {
      const va = Number(a.voltageCode);
      const vb = Number(b.voltageCode);
      if (vb !== va) return vb - va;
      return a.name.localeCompare(b.name);
    });
  }, [bundle]);

  const listCols = listColumnCount(listRows.length);
  const showSsList = settings.showSsList ?? true;
  const listFrac = listStripFraction(listRows.length, showSsList);
  const mapPaneFrac = Math.max(0.55, 1 - 0.09 - (showSsList ? listFrac : 0));
  const visualScale = useMemo(
    () =>
      computePrintVisualScale({
        mapPanePx: {
          w: preview.widthPx,
          h: Math.round(preview.heightPx * mapPaneFrac),
        },
        paperMm: { w: size.widthMm, h: size.heightMm },
      }),
    [preview.widthPx, preview.heightPx, mapPaneFrac, size.widthMm, size.heightMm],
  );
  const sheetTitle = printSheetTitle(settings, bundle?.districtNames ?? []);
  const sheetSub = settings.subtitle.trim();

  const handleLabelMove = (id: string, lat: number, lng: number) => {
    setLabelOverrides((prev) => ({
      ...prev,
      [id]: { labelLat: lat, labelLng: lng },
    }));
  };

  const resetLabels = () => {
    setLabelOverrides({});
    setLabelLayoutEpoch((n) => n + 1);
    window.dispatchEvent(new Event('powermap:print-prepare'));
  };

  useEffect(() => {
    document.body.classList.add('print-preview-open');

    // Literal mm + named @page — do not use CSS variables (print engines drop them)
    let pageStyle = document.getElementById('powermap-print-page');
    if (!pageStyle) {
      pageStyle = document.createElement('style');
      pageStyle.id = 'powermap-print-page';
      document.head.appendChild(pageStyle);
    }
    pageStyle.textContent = buildPrintStyleSheet(settings);

    // Keep laser visible during on-screen preview (presenting). Hide only via
    // @media print CSS so the pointer never lands on the PDF.
    const chromeSel =
      '.app-shell > .app-bar, .app-shell > .bottom-nav, .app-shell .sheet-root, .app-shell .present-nav-root, .app-shell .pm-desk-toolbar, .app-shell .page-masthead';

    const hideShellChrome = () => {
      document.querySelectorAll<HTMLElement>(chromeSel).forEach((el) => {
        if (el.dataset.pmPrintHide === undefined) {
          el.dataset.pmPrintHide = el.getAttribute('style') ?? '';
        }
        el.style.setProperty('display', 'none', 'important');
        el.style.setProperty('visibility', 'hidden', 'important');
        el.style.setProperty('height', '0', 'important');
      });
    };
    const restoreShellChrome = () => {
      document.querySelectorAll<HTMLElement>('[data-pm-print-hide]').forEach((el) => {
        const prev = el.dataset.pmPrintHide;
        el.removeAttribute('data-pm-print-hide');
        if (!prev) el.removeAttribute('style');
        else el.setAttribute('style', prev);
      });
    };

    // Hide as soon as preview opens — print engines often use a narrow page
    // width that re-shows mobile app-bar / bottom-nav via !important CSS.
    hideShellChrome();

    const onBeforePrint = () => {
      document.body.classList.add('is-printing');
      hideShellChrome();
      applyPrintDocumentTitle();
      window.dispatchEvent(new Event('powermap:print-prepare'));
    };
    const onAfterPrint = () => {
      document.body.classList.remove('is-printing');
      restoreDocumentTitle();
      // Keep chrome hidden while preview stays open; restore on unmount.
      setIsPrinting(false);
    };
    window.addEventListener('beforeprint', onBeforePrint);
    window.addEventListener('afterprint', onAfterPrint);

    return () => {
      document.body.classList.remove('print-preview-open');
      document.body.classList.remove('is-printing');
      restoreDocumentTitle();
      restoreShellChrome();
      pageStyle?.remove();
      window.removeEventListener('beforeprint', onBeforePrint);
      window.removeEventListener('afterprint', onAfterPrint);
    };
  }, [settings, saveFilenameStem]);

  const doPrint = () => {
    setIsPrinting(true);
    document.body.classList.add('is-printing');
    document
      .querySelectorAll<HTMLElement>(
        '.app-shell > .app-bar, .app-shell > .bottom-nav, .app-shell .sheet-root, .app-shell .present-nav-root, .app-shell .pm-desk-toolbar, .app-shell .page-masthead',
      )
      .forEach((el) => {
        if (el.dataset.pmPrintHide === undefined) {
          el.dataset.pmPrintHide = el.getAttribute('style') ?? '';
        }
        el.style.setProperty('display', 'none', 'important');
        el.style.setProperty('visibility', 'hidden', 'important');
        el.style.setProperty('height', '0', 'important');
      });
    applyPrintDocumentTitle();
    window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event('powermap:print-prepare'));
      window.setTimeout(() => {
        window.dispatchEvent(new Event('powermap:print-prepare'));
        window.setTimeout(() => window.print(), 800);
      }, 200);
    });
  };

  return (
    <div
      className={`print-overlay${labelArrangeMode ? ' label-arrange-mode' : ''}`}
      role="dialog"
      aria-label={labelArrangeMode ? 'Arrange print labels' : 'Print preview'}
    >
      <div className="print-toolbar no-print">
        <div className="print-toolbar-meta">
          <strong>{labelArrangeMode ? 'Arrange labels' : 'Print preview'}</strong>
          <span>
            {sheetSizeLabel(settings)} · {listRows.length} SS
            {showSsList ? '' : ' · map only'}
            {` · labels ${Math.round(visualScale * 100)}%`}
            {preview.scale < 1 ? ` · preview ${Math.round(preview.scale * 100)}%` : ''}
          </span>
          <span className="muted" title="Default name when you Save as PDF">
            Save as: {saveFilename}
          </span>
          <span className="muted print-toolbar-tip">
            {labelArrangeMode
              ? 'Full-screen map — drag labels, drag empty map to pan, scroll to zoom. Done arranging returns to sheet preview.'
              : 'Drag the map to pan · scroll to zoom · Arrange labels opens full-screen editor'}
          </span>
        </div>
        <div className="print-toolbar-size no-print">
          <label>
            Size
            <select
              value={settings.paperId}
              onChange={(e) =>
                setPrintSettings({
                  paperId: e.target.value as PrintSettings['paperId'],
                })
              }
            >
              <option value="a4">A4</option>
              <option value="a3">A3</option>
              <option value="a2">A2</option>
              <option value="a1">A1</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          {settings.paperId === 'custom' ? (
            <>
              <label>
                W
                <input
                  type="number"
                  min={100}
                  max={1200}
                  value={settings.customWidthMm}
                  onChange={(e) =>
                    setPrintSettings({
                      customWidthMm: Math.min(
                        1200,
                        Math.max(100, Number(e.target.value) || 100),
                      ),
                    })
                  }
                />
              </label>
              <label>
                H
                <input
                  type="number"
                  min={100}
                  max={1200}
                  value={settings.customHeightMm}
                  onChange={(e) =>
                    setPrintSettings({
                      customHeightMm: Math.min(
                        1200,
                        Math.max(100, Number(e.target.value) || 100),
                      ),
                    })
                  }
                />
              </label>
            </>
          ) : (
            <label>
              Orient
              <select
                value={settings.orientation}
                onChange={(e) =>
                  setPrintSettings({
                    orientation: e.target.value as PrintSettings['orientation'],
                  })
                }
              >
                <option value="landscape">Landscape</option>
                <option value="portrait">Portrait</option>
              </select>
            </label>
          )}
          <label>
            DPI
            <select
              value={settings.previewDpi ?? 96}
              onChange={(e) =>
                setPrintSettings({
                  previewDpi: Number(e.target.value) as PrintSettings['previewDpi'],
                })
              }
            >
              {PRINT_PREVIEW_DPI_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Labels
            <select
              value={settings.labelSize ?? 'normal'}
              onChange={(e) =>
                setPrintSettings({
                  labelSize: e.target.value as PrintSettings['labelSize'],
                })
              }
            >
              {PRINT_LABEL_SIZE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Basemap
            <select
              value={settings.basemap || 'esri'}
              onChange={(e) =>
                setPrintSettings({
                  basemap: e.target.value as PrintSettings['basemap'],
                })
              }
            >
              {PRINT_BASEMAPS.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
          <div className="print-toolbar-zoom" role="group" aria-label="Map zoom">
            <button
              type="button"
              className="primary-btn ghost print-zoom-btn"
              title="Zoom out"
              disabled={busy}
              onClick={() => mapApiRef.current?.zoomOut()}
            >
              −
            </button>
            <button
              type="button"
              className="primary-btn ghost print-zoom-btn"
              title="Fit map to sheet"
              disabled={busy}
              onClick={() => mapApiRef.current?.fit()}
            >
              Fit
            </button>
            <button
              type="button"
              className="primary-btn ghost print-zoom-btn"
              title="Zoom in"
              disabled={busy}
              onClick={() => mapApiRef.current?.zoomIn()}
            >
              +
            </button>
          </div>
        </div>
        <div className="btn-row">
          <button
            type="button"
            className={`primary-btn ghost${labelArrangeMode ? ' on' : ''}`}
            onClick={() => setLabelArrangeMode((v) => !v)}
            disabled={busy || !settings.showSsNames}
            title="Drag substation name labels on the map"
          >
            {labelArrangeMode ? 'Done arranging' : 'Arrange labels'}
          </button>
          <button
            type="button"
            className="primary-btn ghost"
            onClick={resetLabels}
            disabled={busy || !Object.keys(labelOverrides).length}
          >
            Reset labels
          </button>
          <button type="button" className="primary-btn" onClick={doPrint} disabled={busy}>
            Print / Save PDF
          </button>
          <button type="button" className="primary-btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      <div className="print-stage">
        <div
          className={`print-sheet list-${settings.listSide}${showSsList ? '' : ' map-only'}${labelArrangeMode ? ' arrange-fullpage' : ''}`}
          style={
            isPrinting
              ? {
                  width: `${size.widthMm}mm`,
                  height: `${size.heightMm}mm`,
                  maxWidth: 'none',
                  maxHeight: 'none',
                  aspectRatio: 'auto',
                  ['--print-list-frac' as string]: String(listFrac),
                  ['--print-list-cols' as string]: String(listCols),
                }
              : labelArrangeMode
                ? {
                    ['--print-list-frac' as string]: String(listFrac),
                    ['--print-list-cols' as string]: String(listCols),
                  }
                : {
                    width: preview.widthPx,
                    height: preview.heightPx,
                    maxWidth: '100%',
                    flexShrink: 0,
                    ['--print-list-frac' as string]: String(listFrac),
                    ['--print-list-cols' as string]: String(listCols),
                  }
          }
        >
          {!labelArrangeMode ? (
          <header className="print-sheet-header">
            <div className="print-sheet-title">
              <h1>{sheetTitle}</h1>
              {sheetSub ? <p>{sheetSub}</p> : null}
            </div>
            <div className="print-sheet-legend" aria-label="Voltage legend">
              <span>
                <i className="sym square" />
                400
              </span>
              <span>
                <i className="sym diamond" />
                220
              </span>
              <span>
                <i className="sym hex" />
                132
              </span>
              <span>
                <i className="sym pentagon" />
                66
              </span>
              <span>
                <i className="sym circle" />
                33
              </span>
            </div>
          </header>
          ) : (
            <div className="print-arrange-banner no-print">
              Full-screen label editor — sheet title and list hidden until you click Done arranging
            </div>
          )}

          <div className="print-sheet-body">
            <div className="print-map-pane">
              {busy || !bundle ? (
                <div className="print-map-loading">Preparing map…</div>
              ) : (
                <PrintMiniMap
                  substations={bundle.substations}
                  lines={bundle.lines}
                  tapNodes={bundle.tapNodes}
                  tapLaterals={bundle.tapLaterals}
                  inDistrictIds={bundle.inDistrictIds}
                  bounds={bundle.bounds}
                  contentBounds={bundle.contentBounds}
                  districtCount={districtNames.length || bundle.districtNames.length}
                  districtBoundaries={bundle.districtBoundaries}
                  settings={settings}
                  layoutKey={`${layoutKey}-c${listCols}-s${visualScale.toFixed(2)}-a${labelArrangeMode ? 1 : 0}`}
                  visualScale={visualScale}
                  labelOverrides={labelOverrides}
                  labelArrangeMode={labelArrangeMode}
                  labelLayoutEpoch={labelLayoutEpoch}
                  onLabelMove={handleLabelMove}
                  onMapReady={handleMapReady}
                />
              )}
            </div>

            {showSsList && !labelArrangeMode ? (
              <aside className="print-side-list">
                <ol className="print-ss-list">
                  {listRows.map((ss, i) => (
                    <li key={ss.id}>
                      <span className="print-ss-idx">{i + 1}</span>
                      <span
                        className={`print-volt-dot v-${ss.voltageCode}`}
                        aria-hidden
                      />
                      <span className="print-ss-name">
                        {ss.name}
                        {ss.status === 'proposed' ? '*' : ''}
                      </span>
                      <span className="print-ss-cap">
                        {formatCapacity(ss.transformers)}
                      </span>
                      <span className="print-ss-kv">{ss.voltageCode}</span>
                    </li>
                  ))}
                  {!listRows.length && !busy && (
                    <li className="print-ss-empty">No substations in selection.</li>
                  )}
                </ol>
              </aside>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
