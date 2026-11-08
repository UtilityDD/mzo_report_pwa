import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import {
  buildFocus33Context,
  isSubstationDimmed,
  isTapLateralDimmed,
  isTapNodeDimmed,
  isTrunkLineDimmed,
  VOLTAGE_DIM_LINE_FACTOR,
  VOLTAGE_DIM_SS_OPACITY,
  VOLTAGE_DIM_TAP_OPACITY,
} from '@/lib/voltageFocus';
import { parallelCircuitLatLngs, lineDisplayLabel, formatCapacity, haversineKm } from '@/domain/geo';
import { createBoundaryLayers, createBasemapLayer, basemapToBack, fitDefaultZone, readMapAppearance, ensurePlaceLabelsPane, ensureCalloutsPane, type BoundaryHandle, type MapAppearance } from './boundaryLayers';
import { feederLabelOffsetPx, feederLabelPlacement } from './feederLabels';
import { lineStyle, substationIcon, tapIcon } from './symbology';
import { nearestPointOnLines, nearestSubstation } from './mapSnap';
import {
  buildVoltageCheckWashDataUrl,
  nearestVoltageCheckCell,
} from '@/lib/voltageCheck';
import { useNetworkStore } from '@/store/networkStore';

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Compact feeder label for map (prefer Ckt N on parallel corridors). */
function shortFeederName(name: string, index: number, parallelTotal: number) {
  const ckt = name.match(/Ckt\s*\d+/i)?.[0];
  if (parallelTotal > 1) return ckt ?? `Ckt ${index + 1}`;
  const trimmed = name
    .replace(/\s*\(\d+\s*kV\)/i, '')
    .replace(/\s*·\s*Ckt\s*\d+/i, '')
    .replace(/\s*·\s*[^·]+$/i, '')
    .trim();
  return trimmed || name;
}

export function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const networkLayerRef = useRef<L.FeatureGroup | null>(null);
  const measureLayerRef = useRef<L.FeatureGroup | null>(null);
  const hintsLayerRef = useRef<L.FeatureGroup | null>(null);
  const voltageCheckLayerRef = useRef<L.FeatureGroup | null>(null);
  const boundaryRef = useRef<BoundaryHandle | null>(null);
  const basemapRef = useRef<L.Layer | null>(null);
  /** Active snap target for click-to-complete connect / tap */
  const snapRef = useRef<{
    kind: 'substation' | 'line';
    id: string;
    lat: number;
    lng: number;
  } | null>(null);
  const fittedRef = useRef<'none' | 'home'>('none');

  const loaded = useNetworkStore((s) => s.loaded);
  const tool = useNetworkStore((s) => s.tool);
  const selection = useNetworkStore((s) => s.selection);
  const substations = useNetworkStore((s) => s.substations);
  const lines = useNetworkStore((s) => s.lines);
  const tapNodes = useNetworkStore((s) => s.tapNodes);
  const tapLaterals = useNetworkStore((s) => s.tapLaterals);
  const connectDraft = useNetworkStore((s) => s.connectDraft);
  const tapDraft = useNetworkStore((s) => s.tapDraft);
  const filters = useNetworkStore((s) => s.filters);
  const mapLayers = useNetworkStore((s) => s.mapLayers);
  const suggestions = useNetworkStore((s) => s.suggestions);
  const showSuggestionsOnMap = useNetworkStore((s) => s.showSuggestionsOnMap);
  const focusedSuggestionId = useNetworkStore((s) => s.focusedSuggestionId);
  const personalDrafts = useNetworkStore((s) => s.personalDrafts);
  const showPersonalDraftsOnMap = useNetworkStore((s) => s.showPersonalDraftsOnMap);
  const focusedPersonalDraftId = useNetworkStore((s) => s.focusedPersonalDraftId);
  const adminRole = useNetworkStore((s) => s.adminRole);
  const sitingAnalysis = useNetworkStore((s) => s.sitingAnalysis);
  const showSitingOnMap = useNetworkStore((s) => s.showSitingOnMap);
  const focusedSitingId = useNetworkStore((s) => s.focusedSitingId);
  const voltageCheckAnalysis = useNetworkStore((s) => s.voltageCheckAnalysis);
  const showVoltageCheckOnMap = useNetworkStore((s) => s.showVoltageCheckOnMap);
  const voltageCheckActive = useNetworkStore((s) => s.voltageCheckActive);
  const sitingActive = useNetworkStore((s) => s.sitingActive);
  const focusedVoltageCheckId = useNetworkStore((s) => s.focusedVoltageCheckId);
  const voltageFocus = useNetworkStore((s) => s.voltageFocus);

  const placeDraft = useNetworkStore((s) => s.placeDraft);
  const mapFocus = useNetworkStore((s) => s.mapFocus);
  const mapHomeNonce = useNetworkStore((s) => s.mapHomeNonce);
  const districtLabelPositions = useNetworkStore((s) => s.districtLabelPositions);
  const hoverCoords = useNetworkStore((s) => s.hoverCoords);
  const [mapZoom, setMapZoom] = useState(10);
  const [appearance, setAppearance] = useState<MapAppearance>(() => readMapAppearance());
  /** Bumps when the Leaflet map or boundary handle becomes ready so theme apply can run. */
  const [mapReadyTick, setMapReadyTick] = useState(0);

  // Follow DRO light/dark so mask + dim wash stay consistent with the shell.
  useEffect(() => {
    const sync = () => setAppearance(readMapAppearance());
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-appearance'],
    });
    const shell = document.querySelector('.app-shell');
    if (shell) {
      obs.observe(shell, { attributes: true, attributeFilter: ['data-appearance'] });
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', sync);
    // AppShell may mount the attribute slightly after first paint.
    const t = window.setTimeout(sync, 0);
    return () => {
      obs.disconnect();
      mq.removeEventListener('change', sync);
      window.clearTimeout(t);
    };
  }, []);

  // Init map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: [25.85, 88.55],
      zoom: 9,
      zoomControl: false,
      attributionControl: true,
      minZoom: 7,
      zoomAnimation: true,
      fadeAnimation: true,
      markerZoomAnimation: true,
      zoomAnimationThreshold: 8,
      inertia: true,
      inertiaDeceleration: 2800,
      inertiaMaxSpeed: 2200,
      easeLinearity: 0.22,
      wheelPxPerZoomLevel: 90,
      wheelDebounceTime: 28,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      bounceAtZoomLimits: false,
      preferCanvas: false,
    });
    fitDefaultZone(map, null);

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    const initialId = useNetworkStore.getState().mapLayers.basemap;
    const initialAppearance = readMapAppearance();
    const container = map.getContainer();
    container.classList.toggle('basemap-none', initialId === 'none');
    container.classList.toggle('basemap-photo', initialId === 'google-hybrid');
    container.classList.toggle('pm-appearance-dark', initialAppearance === 'dark');
    container.classList.toggle('pm-appearance-light', initialAppearance === 'light');
    container.classList.toggle(
      'pm-basemap-invert',
      initialAppearance === 'dark' && (initialId === 'google' || initialId === 'osm'),
    );

    if (initialId !== 'none') {
      const initialBasemap = createBasemapLayer(initialId, initialAppearance);
      initialBasemap.addTo(map);
      basemapRef.current = initialBasemap;
    }

    const networkLayer = L.featureGroup().addTo(map);
    const measureLayer = L.featureGroup().addTo(map);
    const hintsLayer = L.featureGroup().addTo(map);
    const voltageCheckLayer = L.featureGroup().addTo(map);
    networkLayerRef.current = networkLayer;
    measureLayerRef.current = measureLayer;
    hintsLayerRef.current = hintsLayer;
    voltageCheckLayerRef.current = voltageCheckLayer;
    mapRef.current = map;
    setMapZoom(map.getZoom());
    setMapReadyTick((n) => n + 1);
    // Panes for label stacking: symbols < place names < callouts
    ensurePlaceLabelsPane(map);
    ensureCalloutsPane(map);
    const onZoom = () => setMapZoom(map.getZoom());
    map.on('zoomend', onZoom);

    map.pm.setLang('en');
    map.pm.addControls({
      position: 'topleft',
      drawMarker: false,
      drawCircleMarker: false,
      drawPolyline: false,
      drawRectangle: false,
      drawPolygon: false,
      drawCircle: false,
      drawText: false,
      editMode: false,
      dragMode: false,
      removalMode: false,
      rotateMode: false,
      cutPolygon: false,
    });
    const pmRoot = containerRef.current.querySelector('.leaflet-pm-toolbar');
    if (pmRoot instanceof HTMLElement) pmRoot.style.display = 'none';

    let cancelled = false;
    void createBoundaryLayers(map)
      .then((handle) => {
        if (cancelled) {
          handle.destroy();
          return;
        }
        boundaryRef.current = handle;
        useNetworkStore.getState().setAvailableDistricts(handle.districtNames);
        const layers = useNetworkStore.getState().mapLayers;
        const tool = useNetworkStore.getState().tool;
        const labelPositions = useNetworkStore.getState().districtLabelPositions;
        handle.apply({
          showMask: layers.showMask,
          maskOpacity: layers.maskOpacity,
          showDistricts: layers.showDistricts,
          showDistrictLabels: layers.showDistrictLabels,
          showBlocks: layers.showBlocks,
          showBlockLabels: layers.showBlockLabels,
          focusedDistricts: layers.focusedDistricts,
          dimAllDistricts: layers.dimAllDistricts,
          districtsInteractive: tool === 'cursor' && layers.showDistricts,
          appearance: readMapAppearance(),
          districtLabelPositions: labelPositions,
          onDistrictClick: (name, additive) => {
            useNetworkStore.getState().toggleDistrictFocus(name, additive);
          },
          onDistrictLabelMove: (name, lat, lng) => {
            useNetworkStore.getState().setDistrictLabelPosition(name, lat, lng);
          },
        });
        // Default home: North Bengal districts fill the pane
        fitDefaultZone(map, handle.bounds);
        fittedRef.current = 'home';
        networkLayerRef.current?.bringToFront();
        measureLayerRef.current?.bringToFront();
        setMapReadyTick((n) => n + 1);
      })
      .catch(() => {
        /* boundaries optional — basemap still works */
        if (fittedRef.current === 'none') {
          fitDefaultZone(map, null);
          fittedRef.current = 'home';
        }
      });

    return () => {
      cancelled = true;
      map.off('zoomend', onZoom);
      boundaryRef.current?.destroy();
      boundaryRef.current = null;
      map.remove();
      mapRef.current = null;
      basemapRef.current = null;
    };
  }, []);

  // Fallback if boundaries are slow: still home to North Bengal frame (not statewide SS hull)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    if (fittedRef.current === 'home') return;
    fitDefaultZone(map, boundaryRef.current?.bounds ?? null);
    fittedRef.current = 'home';
  }, [loaded, mapReadyTick]);

  // Swap basemap when selection changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (basemapRef.current) {
      map.removeLayer(basemapRef.current);
      basemapRef.current = null;
    }

    if (mapLayers.basemap !== 'none') {
      const next = createBasemapLayer(mapLayers.basemap, appearance);
      next.addTo(map);
      basemapToBack(next);
      basemapRef.current = next;
    }

    const container = map.getContainer();
    container.classList.toggle('basemap-none', mapLayers.basemap === 'none');
    container.classList.toggle('basemap-photo', mapLayers.basemap === 'google-hybrid');
    container.classList.toggle('pm-appearance-dark', appearance === 'dark');
    container.classList.toggle('pm-appearance-light', appearance === 'light');
    // Street tiles (Google/OSM) need a CSS invert in dark mode; Esri swaps to dark gray.
    container.classList.toggle(
      'pm-basemap-invert',
      appearance === 'dark' &&
        (mapLayers.basemap === 'google' || mapLayers.basemap === 'osm'),
    );

    boundaryRef.current?.apply({
      showMask: mapLayers.showMask,
      maskOpacity: mapLayers.maskOpacity,
      showDistricts: mapLayers.showDistricts,
      showDistrictLabels: mapLayers.showDistrictLabels,
      showBlocks: mapLayers.showBlocks,
      showBlockLabels: mapLayers.showBlockLabels,
      focusedDistricts: mapLayers.focusedDistricts,
      dimAllDistricts: mapLayers.dimAllDistricts,
      districtsInteractive: tool === 'cursor' && mapLayers.showDistricts,
      appearance,
      districtLabelPositions,
      onDistrictClick: (name, additive) => {
        useNetworkStore.getState().toggleDistrictFocus(name, additive);
      },
      onDistrictLabelMove: (name, lat, lng) => {
        useNetworkStore.getState().setDistrictLabelPosition(name, lat, lng);
      },
    });
    networkLayerRef.current?.bringToFront();
    measureLayerRef.current?.bringToFront();
  }, [
    tool,
    appearance,
    mapReadyTick,
    mapLayers.basemap,
    mapLayers.showMask,
    mapLayers.maskOpacity,
    mapLayers.showDistricts,
    mapLayers.showDistrictLabels,
    mapLayers.showBlocks,
    mapLayers.showBlockLabels,
    mapLayers.focusedDistricts,
    mapLayers.dimAllDistricts,
    districtLabelPositions,
  ]);

  // Map click / cursor: place SS, drafts, snap-complete, deselect
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const el = map.getContainer();
    el.classList.remove(
      'pm-tool-add-ss',
      'pm-tool-connect',
      'pm-tool-tap',
      'pm-tool-move',
      'pm-tool-delete',
      'pm-tool-measure',
    );
    if (tool !== 'cursor') el.classList.add(`pm-tool-${tool}`);

    const onClick = (e: L.LeafletMouseEvent) => {
      const state = useNetworkStore.getState();
      const snap = snapRef.current;

      if (state.tool === 'add-ss') {
        const lat = Number(e.latlng.lat.toFixed(6));
        const lng = Number(e.latlng.lng.toFixed(6));
        state.setPlaceDraft({ lat, lng });
        state.flashStatus(`Clicked · ${lat.toFixed(6)}, ${lng.toFixed(6)}`);
        return;
      }

      if (state.tool === 'connect') {
        if (!state.connectDraft.fromId && snap?.kind === 'substation') {
          state.beginConnect(snap.id);
          return;
        }
        if (state.connectDraft.fromId && snap?.kind === 'substation') {
          void state.completeConnect(snap.id);
          return;
        }
      }

      if (state.tool === 'tap') {
        if (!state.tapDraft.sourceTapId && snap?.kind === 'line') {
          state.beginTapOnLine(snap.id, snap.lat, snap.lng);
          return;
        }
        if (state.tapDraft.sourceTapId && snap?.kind === 'substation') {
          void state.completeTapToSubstation(snap.id);
          return;
        }
        if (state.tapDraft.sourceTapId && snap?.kind === 'line') {
          void state.completeTapToLine(snap.id, snap.lat, snap.lng);
          return;
        }
      }

      // Feature clicks call DomEvent.stopPropagation — this only runs for empty map
      if (state.selection) {
        state.setSelection(null);
      }
      if (state.focusedSuggestionId) {
        state.focusSuggestion(null);
      }
      if (state.tool === 'connect' || state.tool === 'tap') {
        state.cancelDrafts();
      }
    };

    const onMove = (e: L.LeafletMouseEvent) => {
      const state = useNetworkStore.getState();
      const hints = hintsLayerRef.current;
      if (!hints) return;
      hints.clearLayers();
      snapRef.current = null;

      const visibleSs = state.visibleSubstations();
      const visibleLines = state.visibleLines();
      const ssById = new Map(state.substations.map((s) => [s.id, s]));
      const cursor = e.latlng;

      if (state.tool === 'add-ss') {
        const lat = Number(cursor.lat.toFixed(6));
        const lng = Number(cursor.lng.toFixed(6));
        state.setHoverCoords({ lat, lng });

        const ghost = L.circleMarker(cursor, {
          radius: 9,
          color: '#0b6e4f',
          weight: 2,
          fillColor: '#0b6e4f',
          fillOpacity: 0.2,
          interactive: false,
          className: 'pm-hint-ghost',
        });
        ghost.bindTooltip(`${lat.toFixed(6)}, ${lng.toFixed(6)}`, {
          permanent: true,
          direction: 'top',
          offset: [0, -10],
          className: 'pm-tip pm-tip-hint',
        });
        hints.addLayer(ghost);

        const near = nearestSubstation(map, cursor, visibleSs);
        if (near) {
          L.circleMarker([near.lat, near.lng], {
            radius: 16,
            color: '#f59e0b',
            weight: 2,
            dashArray: '4 3',
            fill: false,
            interactive: false,
          }).addTo(hints);
          state.setEditCursorHint(`Near ${near.name} — place carefully`);
        } else {
          state.setEditCursorHint('Click to place · tip shows live lat/lng');
        }
        return;
      }

      if (state.tool === 'connect') {
        const fromId = state.connectDraft.fromId;
        if (!fromId) {
          const near = nearestSubstation(map, cursor, visibleSs);
          if (near) {
            snapRef.current = {
              kind: 'substation',
              id: near.id,
              lat: near.lat,
              lng: near.lng,
            };
            L.circleMarker([near.lat, near.lng], {
              radius: 18,
              color: '#0b6e4f',
              weight: 2,
              fillColor: '#0b6e4f',
              fillOpacity: 0.12,
              interactive: false,
              className: 'pm-snap-ring',
            })
              .bindTooltip(`Snap · ${near.name}`, {
                permanent: true,
                direction: 'top',
                offset: [0, -14],
                className: 'pm-tip pm-tip-snap',
              })
              .addTo(hints);
            state.setEditCursorHint(`Snap to ${near.name} — click to start`);
          } else {
            state.setEditCursorHint('Move near a substation to snap · click source');
          }
          return;
        }

        const from = ssById.get(fromId);
        if (!from) return;
        const near = nearestSubstation(map, cursor, visibleSs, fromId);
        const endLat = near?.lat ?? cursor.lat;
        const endLng = near?.lng ?? cursor.lng;
        if (near) {
          snapRef.current = {
            kind: 'substation',
            id: near.id,
            lat: near.lat,
            lng: near.lng,
          };
        }

        const km = haversineKm(from.lat, from.lng, endLat, endLng);
        L.polyline(
          [
            [from.lat, from.lng],
            [endLat, endLng],
          ],
          {
            color: near ? '#0b6e4f' : '#64748b',
            weight: 2.5,
            dashArray: '6 5',
            opacity: 0.9,
            interactive: false,
            className: 'pm-rubber-band',
          },
        ).addTo(hints);

        if (near) {
          L.circleMarker([near.lat, near.lng], {
            radius: 18,
            color: '#0b6e4f',
            weight: 2,
            fillColor: '#0b6e4f',
            fillOpacity: 0.15,
            interactive: false,
            className: 'pm-snap-ring',
          }).addTo(hints);
          L.tooltip({
            permanent: true,
            direction: 'top',
            offset: [0, -14],
            className: 'pm-tip pm-tip-snap',
          })
            .setLatLng([near.lat, near.lng])
            .setContent(`Snap · ${near.name} · ${km.toFixed(2)} km`)
            .addTo(hints);
          state.setEditCursorHint(`Snap to ${near.name} · ${km.toFixed(2)} km — click to connect`);
        } else {
          L.tooltip({
            permanent: true,
            direction: 'right',
            offset: [10, 0],
            className: 'pm-tip pm-tip-hint',
          })
            .setLatLng(cursor)
            .setContent(`${km.toFixed(2)} km`)
            .addTo(hints);
          state.setEditCursorHint(`${km.toFixed(2)} km — snap to a target substation`);
        }
        return;
      }

      if (state.tool === 'tap') {
        if (!state.tapDraft.sourceTapId) {
          const onLine = nearestPointOnLines(map, cursor, visibleLines, ssById);
          if (onLine) {
            snapRef.current = {
              kind: 'line',
              id: onLine.id,
              lat: onLine.lat,
              lng: onLine.lng,
            };
            L.circleMarker([onLine.lat, onLine.lng], {
              radius: 8,
              color: '#0f766e',
              weight: 2,
              fillColor: '#0f766e',
              fillOpacity: 0.35,
              interactive: false,
            }).addTo(hints);
            L.tooltip({
              permanent: true,
              direction: 'top',
              offset: [0, -10],
              className: 'pm-tip pm-tip-snap',
            })
              .setLatLng([onLine.lat, onLine.lng])
              .setContent(`Snap · tap on ${onLine.name}`)
              .addTo(hints);
            state.setEditCursorHint(`Snap to feeder — click to start tap`);
          } else {
            state.setEditCursorHint('Move onto a feeder to snap · click to start tap');
          }
          return;
        }

        const originLat = state.tapDraft.sourceLat ?? cursor.lat;
        const originLng = state.tapDraft.sourceLng ?? cursor.lng;
        const nearSs = nearestSubstation(map, cursor, visibleSs);
        const nearLine = nearSs
          ? null
          : nearestPointOnLines(map, cursor, visibleLines, ssById, state.tapDraft.sourceLineId);

        let endLat = cursor.lat;
        let endLng = cursor.lng;
        let tip = '';
        if (nearSs) {
          snapRef.current = {
            kind: 'substation',
            id: nearSs.id,
            lat: nearSs.lat,
            lng: nearSs.lng,
          };
          endLat = nearSs.lat;
          endLng = nearSs.lng;
          tip = `Snap · ${nearSs.name}`;
          state.setEditCursorHint(`Snap to ${nearSs.name} — click to finish tap`);
        } else if (nearLine) {
          snapRef.current = {
            kind: 'line',
            id: nearLine.id,
            lat: nearLine.lat,
            lng: nearLine.lng,
          };
          endLat = nearLine.lat;
          endLng = nearLine.lng;
          tip = `Snap · ${nearLine.name}`;
          state.setEditCursorHint(`Snap to feeder — click to finish line-to-line tap`);
        } else {
          state.setEditCursorHint('Snap to a substation or feeder to finish');
        }

        const km = haversineKm(originLat, originLng, endLat, endLng);
        L.polyline(
          [
            [originLat, originLng],
            [endLat, endLng],
          ],
          {
            color: snapRef.current ? '#0f766e' : '#94a3b8',
            weight: 2.5,
            dashArray: '5 4',
            opacity: 0.9,
            interactive: false,
          },
        ).addTo(hints);

        if (snapRef.current) {
          L.circleMarker([endLat, endLng], {
            radius: 16,
            color: '#0f766e',
            weight: 2,
            fill: false,
            interactive: false,
            className: 'pm-snap-ring',
          }).addTo(hints);
          L.tooltip({
            permanent: true,
            direction: 'top',
            offset: [0, -12],
            className: 'pm-tip pm-tip-snap',
          })
            .setLatLng([endLat, endLng])
            .setContent(`${tip} · ${km.toFixed(2)} km`)
            .addTo(hints);
        } else {
          L.tooltip({
            permanent: true,
            direction: 'right',
            offset: [10, 0],
            className: 'pm-tip pm-tip-hint',
          })
            .setLatLng(cursor)
            .setContent(`${km.toFixed(2)} km`)
            .addTo(hints);
        }
        return;
      }

      if (state.tool === 'delete') {
        const nearSs = nearestSubstation(map, cursor, visibleSs);
        const nearLine = nearSs
          ? null
          : nearestPointOnLines(map, cursor, visibleLines, ssById);
        if (nearSs) {
          L.circleMarker([nearSs.lat, nearSs.lng], {
            radius: 18,
            color: '#dc2626',
            weight: 2,
            fillColor: '#dc2626',
            fillOpacity: 0.12,
            interactive: false,
          }).addTo(hints);
          L.tooltip({
            permanent: true,
            direction: 'top',
            offset: [0, -14],
            className: 'pm-tip pm-tip-danger',
          })
            .setLatLng([nearSs.lat, nearSs.lng])
            .setContent(`Delete · ${nearSs.name}`)
            .addTo(hints);
          state.setEditCursorHint(`Click ${nearSs.name} to delete`);
        } else if (nearLine) {
          L.circleMarker([nearLine.lat, nearLine.lng], {
            radius: 10,
            color: '#dc2626',
            weight: 2,
            fillColor: '#dc2626',
            fillOpacity: 0.2,
            interactive: false,
          }).addTo(hints);
          L.tooltip({
            permanent: true,
            direction: 'top',
            offset: [0, -10],
            className: 'pm-tip pm-tip-danger',
          })
            .setLatLng([nearLine.lat, nearLine.lng])
            .setContent(`Delete · ${nearLine.name}`)
            .addTo(hints);
          state.setEditCursorHint(`Click feeder to delete`);
        } else {
          state.setEditCursorHint('Hover an asset — red hint when in range');
        }
        return;
      }

      if (state.tool === 'move') {
        const near = nearestSubstation(map, cursor, visibleSs);
        if (near) {
          L.circleMarker([near.lat, near.lng], {
            radius: 16,
            color: '#0369a1',
            weight: 2,
            dashArray: '3 3',
            fill: false,
            interactive: false,
          }).addTo(hints);
          state.setEditCursorHint(`Drag ${near.name} — lines follow`);
        } else {
          state.setEditCursorHint('Hover a substation, then drag');
        }
        return;
      }

      if (state.editCursorHint) state.setEditCursorHint(null);
    };

    map.on('click', onClick);
    map.on('mousemove', onMove);
    return () => {
      map.off('click', onClick);
      map.off('mousemove', onMove);
      hintsLayerRef.current?.clearLayers();
      snapRef.current = null;
      useNetworkStore.getState().setEditCursorHint(null);
      el.classList.remove(
        'pm-tool-add-ss',
        'pm-tool-connect',
        'pm-tool-tap',
        'pm-tool-move',
        'pm-tool-delete',
        'pm-tool-measure',
      );
    };
  }, [tool, connectDraft.fromId, tapDraft.sourceTapId]);

  // Confirmed place-ss marker (panel selection)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || tool !== 'add-ss' || !placeDraft) return;

    const preview = L.circleMarker([placeDraft.lat, placeDraft.lng], {
      radius: 11,
      color: '#0b6e4f',
      weight: 3,
      fillColor: '#0b6e4f',
      fillOpacity: 0.35,
      interactive: false,
    }).addTo(map);
    preview.bindTooltip(
      `Selected · ${placeDraft.lat.toFixed(6)}, ${placeDraft.lng.toFixed(6)}`,
      { permanent: true, direction: 'top', className: 'pm-tip pm-tip-snap', offset: [0, -10] },
    );
    return () => {
      map.removeLayer(preview);
    };
  }, [tool, placeDraft]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapFocus) return;
    map.flyTo([mapFocus.lat, mapFocus.lng], Math.max(map.getZoom(), 14), { duration: 0.6 });
    useNetworkStore.getState().setMapFocus(null);
  }, [mapFocus]);

  useEffect(() => {
    if (!mapHomeNonce) return;
    const map = mapRef.current;
    if (!map) return;
    fittedRef.current = 'home';
    fitDefaultZone(map, boundaryRef.current?.bounds ?? null);
  }, [mapHomeNonce]);

  // Cursor + measure mode via Geoman
  useEffect(() => {
    const map = mapRef.current;
    const measureLayer = measureLayerRef.current;
    if (!map || !measureLayer) return;

    map.pm.disableDraw();
    map.pm.disableGlobalEditMode();
    map.pm.disableGlobalDragMode();
    measureLayer.clearLayers();

    if (tool === 'measure') {
      map.pm.enableDraw('Line', {
        snappable: true,
        templineStyle: { color: '#0f172a', dashArray: '4 4' },
        hintlineStyle: { color: '#64748b', dashArray: '2 4' },
        pathOptions: { color: '#0f172a', weight: 2 },
      });
      const onCreate = (e: { layer: L.Layer }) => {
        measureLayer.addLayer(e.layer);
        const latlngs = (e.layer as L.Polyline).getLatLngs() as L.LatLng[];
        let km = 0;
        for (let i = 1; i < latlngs.length; i++) {
          km += latlngs[i - 1].distanceTo(latlngs[i]) / 1000;
        }
        useNetworkStore.getState().flashStatus(`Measured ${km.toFixed(2)} km`);
        map.pm.enableDraw('Line', {
          snappable: true,
          pathOptions: { color: '#0f172a', weight: 2 },
        });
      };
      map.on('pm:create', onCreate);
      return () => {
        map.off('pm:create', onCreate);
        map.pm.disableDraw();
      };
    }

    return undefined;
  }, [tool]);

  // Render network
  useEffect(() => {
    const map = mapRef.current;
    const layer = networkLayerRef.current;
    if (!map || !layer || !loaded) return;

    layer.clearLayers();
    const state = useNetworkStore.getState();
    const visibleSs = state.visibleSubstations();
    const visibleLines = state.visibleLines();
    const visibleSsIds = new Set(visibleSs.map((s) => s.id));
    const ssById = new Map(substations.map((s) => [s.id, s]));
    const labelsPane = ensurePlaceLabelsPane(map);
    const calloutsPane = ensureCalloutsPane(map);
    const quiet = state.voltageCheckActive || state.sitingActive;
    const focus = state.voltageFocus;
    const focus33 =
      focus === '33' ? buildFocus33Context(substations, lines) : null;
    const dimSs = (ss: (typeof visibleSs)[0]) =>
      !quiet && isSubstationDimmed(focus, ss, focus33);
    const dimTrunkLine = (line: (typeof visibleLines)[0]) =>
      !quiet && isTrunkLineDimmed(focus, line, focus33);
    const lineById = new Map(lines.map((l) => [l.id, l]));
    map.getContainer().classList.toggle('pm-voltage-check-active', state.voltageCheckActive);
    map.getContainer().classList.toggle('pm-siting-active', state.sitingActive);

    // Group parallel circuits for offset
    const pairKey = (a: string, b: string) => [a, b].sort().join('|');
    const groups = new Map<string, typeof visibleLines>();
    visibleLines.forEach((l) => {
      const key = pairKey(l.fromId, l.toId);
      const g = groups.get(key) ?? [];
      g.push(l);
      groups.set(key, g);
    });

    groups.forEach((group) => {
      const sorted = [...group].sort(
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
        const selected = selection?.kind === 'line' && selection.id === line.id;
        const siblingSelected =
          selection?.kind === 'line' &&
          sorted.some((l) => l.id === selection.id) &&
          !selected;
        const style = lineStyle(line.voltageCode, line.status, selected, false, {
          circuitIndex: index,
          parallelTotal: sorted.length,
          zoom: mapZoom,
        });
        if (siblingSelected) style.opacity = 0.5;
        if (quiet) style.opacity = (style.opacity ?? 0.88) * 0.08;
        else if (dimTrunkLine(line)) {
          style.opacity = (style.opacity ?? 0.88) * VOLTAGE_DIM_LINE_FACTOR;
        }
        const poly = L.polyline(path, style);
        poly.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          const st = useNetworkStore.getState();
          if (st.tool === 'tap') {
            if (!st.tapDraft.sourceTapId) {
              st.beginTapOnLine(line.id, e.latlng.lat, e.latlng.lng);
            } else {
              void st.completeTapToLine(line.id, e.latlng.lat, e.latlng.lng);
            }
            return;
          }
          if (st.tool === 'delete') {
            st.requestDelete({ kind: 'line', id: line.id });
            return;
          }
          st.setSelection({ kind: 'line', id: line.id });
        });
        poly.bindTooltip(
          tool === 'delete'
            ? `Delete · ${lineDisplayLabel(line, sorted.length)}`
            : tool === 'tap'
              ? `Tap · ${lineDisplayLabel(line, sorted.length)}`
              : lineDisplayLabel(line, sorted.length),
          {
            sticky: true,
            opacity: 0.9,
            className: tool === 'delete' ? 'pm-tip pm-tip-danger' : 'pm-tip',
          },
        );
        layer.addLayer(poly);

        const showFeederName = mapLayers.showFeederNames;
        const showFeederLen = mapLayers.showFeederLength;
        if (showFeederName || showFeederLen) {
          const parts: string[] = [];
          if (showFeederName) {
            parts.push(shortFeederName(line.name, index, sorted.length));
          }
          if (showFeederLen && line.lengthKm != null) {
            parts.push(`${Number(line.lengthKm).toFixed(1)} km`);
          }
          const text = parts.filter(Boolean).join(' · ');
          if (text) {
            const place = feederLabelPlacement(map, path, index, sorted.length);
            const gap = feederLabelOffsetPx(map.getZoom(), sorted.length) * place.side;
            const icon = L.divIcon({
              className: 'pm-asset-label pm-feeder-label',
              html: `<div class="pm-feeder-label-rot" style="transform:translate(-50%,-50%) rotate(${place.angleDeg.toFixed(2)}deg) translateY(${-gap}px)"><span>${escapeHtml(text)}</span></div>`,
              iconSize: [0, 0],
              iconAnchor: [0, 0],
            });
            layer.addLayer(
              L.marker([place.lat, place.lng], {
                icon,
                interactive: false,
                pane: labelsPane,
                zIndexOffset: 100,
              }),
            );
          }
        }

        if (selected) {
          const bounds = L.latLngBounds(path);
          const sw = bounds.getSouthWest();
          const ne = bounds.getNorthEast();
          const dLat = Math.max((ne.lat - sw.lat) * 0.25, 0.0015);
          const dLng = Math.max((ne.lng - sw.lng) * 0.25, 0.0015);
          const padded = L.latLngBounds(
            [sw.lat - dLat, sw.lng - dLng],
            [ne.lat + dLat, ne.lng + dLng],
          );
          layer.addLayer(
            L.rectangle(padded, {
              color: '#0f172a',
              weight: 1.5,
              dashArray: '5 4',
              fill: false,
              opacity: 0.85,
              interactive: false,
              className: 'pm-line-select-box',
            }),
          );

          const handleIcon = L.divIcon({
            className: 'pm-line-handle',
            html: '<span class="pm-line-handle-sq"></span>',
            iconSize: [12, 12],
            iconAnchor: [6, 6],
          });
          const start = path[0];
          const end = path[path.length - 1];
          layer.addLayer(L.marker(start, { icon: handleIcon, interactive: false }));
          layer.addLayer(L.marker(end, { icon: handleIcon, interactive: false }));

          // Mid-span circuit badge for double circuits
          if (sorted.length > 1) {
            const mid = path[Math.floor(path.length / 2)];
            const badge = L.divIcon({
              className: 'pm-ckt-badge',
              html: `<span class="pm-ckt-badge-label">Ckt ${index + 1}</span>`,
              iconSize: [40, 18],
              iconAnchor: [20, 9],
            });
            layer.addLayer(
              L.marker(mid, {
                icon: badge,
                interactive: false,
                pane: labelsPane,
                zIndexOffset: 150,
              }),
            );
          }
        }
      });
    });

    // Tap laterals
    const tapById = new Map(tapNodes.map((t) => [t.id, t]));
    tapLaterals.forEach((lat) => {
      const fromTap = tapById.get(lat.fromTapId);
      if (!fromTap) return;
      let toLat: number;
      let toLng: number;
      if (lat.toKind === 'substation') {
        const ss = ssById.get(lat.toAssetId);
        if (!ss || !visibleSsIds.has(ss.id)) return;
        toLat = ss.lat;
        toLng = ss.lng;
      } else {
        const t = tapById.get(lat.toAssetId);
        if (!t) return;
        toLat = t.lat;
        toLng = t.lng;
      }
      const selected = selection?.kind === 'tap_lateral' && selection.id === lat.id;
      const latStyle = lineStyle(lat.voltageCode, lat.status, selected, true, { zoom: mapZoom });
      if (quiet) latStyle.opacity = (latStyle.opacity ?? 0.88) * 0.06;
      else if (isTapLateralDimmed(focus, lat, focus33)) {
        latStyle.opacity = (latStyle.opacity ?? 0.88) * VOLTAGE_DIM_LINE_FACTOR;
      }
      const poly = L.polyline(
        [
          [fromTap.lat, fromTap.lng],
          [toLat, toLng],
        ],
        latStyle,
      );
      poly.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        const st = useNetworkStore.getState();
        if (st.tool === 'delete') {
          st.requestDelete({ kind: 'tap_lateral', id: lat.id });
          return;
        }
        st.setSelection({ kind: 'tap_lateral', id: lat.id });
      });
      poly.bindTooltip(lat.name, { sticky: true, className: 'pm-tip' });
      layer.addLayer(poly);
    });

    // Tap nodes
    tapNodes.forEach((tap) => {
      if (!visibleLines.some((l) => l.id === tap.parentLineId)) return;
      const parentLine = lineById.get(tap.parentLineId);
      const selected = selection?.kind === 'tap_node' && selection.id === tap.id;
      const marker = L.marker([tap.lat, tap.lng], {
        icon: tapIcon(selected, mapZoom),
        zIndexOffset: 400,
        opacity: quiet
          ? 0.12
          : parentLine && isTapNodeDimmed(focus, tap, parentLine, focus33)
            ? VOLTAGE_DIM_TAP_OPACITY
            : 1,
      });
      marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        const st = useNetworkStore.getState();
        if (st.tool === 'delete') {
          st.requestDelete({ kind: 'tap_node', id: tap.id });
          return;
        }
        st.setSelection({ kind: 'tap_node', id: tap.id });
      });
      marker.bindTooltip(tap.name, { direction: 'top', className: 'pm-tip' });
      layer.addLayer(marker);
    });

    // Substations
    visibleSs.forEach((ss) => {
      const selected = selection?.kind === 'substation' && selection.id === ss.id;
      const isConnectFrom = connectDraft.fromId === ss.id;
      const marker = L.marker([ss.lat, ss.lng], {
        icon: substationIcon(ss.voltageCode, ss.status, selected || isConnectFrom, mapZoom),
        draggable: tool === 'move',
        zIndexOffset: 500,
        opacity: quiet
          ? ss.voltageCode === '33'
            ? 0.48
            : 0.18
          : dimSs(ss)
            ? VOLTAGE_DIM_SS_OPACITY
            : 1,
      });

      marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        const st = useNetworkStore.getState();
        if (st.tool === 'connect') {
          st.beginConnect(ss.id);
          return;
        }
        if (st.tool === 'tap' && st.tapDraft.sourceTapId) {
          void st.completeTapToSubstation(ss.id);
          return;
        }
        if (st.tool === 'delete') {
          st.requestDelete({ kind: 'substation', id: ss.id });
          return;
        }
        st.setSelection({ kind: 'substation', id: ss.id });
      });

      if (tool === 'move') {
        marker.on('drag', (ev) => {
          const ll = (ev.target as L.Marker).getLatLng();
          const hints = hintsLayerRef.current;
          if (!hints) return;
          hints.clearLayers();
          const connected = state.lines.filter((l) => l.fromId === ss.id || l.toId === ss.id);
          connected.forEach((l) => {
            const otherId = l.fromId === ss.id ? l.toId : l.fromId;
            const other = ssById.get(otherId);
            if (!other) return;
            L.polyline(
              [
                [ll.lat, ll.lng],
                [other.lat, other.lng],
              ],
              {
                color: '#0369a1',
                weight: 2,
                dashArray: '5 4',
                opacity: 0.85,
                interactive: false,
              },
            ).addTo(hints);
          });
          L.tooltip({
            permanent: true,
            direction: 'top',
            offset: [0, -16],
            className: 'pm-tip pm-tip-hint',
          })
            .setLatLng(ll)
            .setContent(`${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}`)
            .addTo(hints);
          useNetworkStore
            .getState()
            .setEditCursorHint(`Moving ${ss.name} · ${connected.length} feeder(s)`);
        });
        marker.on('dragend', () => {
          hintsLayerRef.current?.clearLayers();
          const ll = marker.getLatLng();
          void useNetworkStore.getState().moveSubstation(ss.id, ll.lat, ll.lng);
        });
      } else {
        marker.on('dragend', () => {
          const ll = marker.getLatLng();
          void useNetworkStore.getState().moveSubstation(ss.id, ll.lat, ll.lng);
        });
      }

      marker.bindTooltip(
        tool === 'delete'
          ? `Delete · ${ss.name}`
          : tool === 'connect'
            ? isConnectFrom
              ? `From · ${ss.name}`
              : `Connect · ${ss.name}`
            : tool === 'move'
              ? `Drag · ${ss.name}`
              : ss.name,
        {
          direction: 'top',
          offset: [0, -10],
          className: tool === 'delete' ? 'pm-tip pm-tip-danger' : 'pm-tip',
        },
      );
      layer.addLayer(marker);

      if (mapLayers.showSsNames || mapLayers.showSsCapacity) {
        const parts: string[] = [];
        if (mapLayers.showSsNames) parts.push(ss.name);
        if (mapLayers.showSsCapacity) {
          const cap = formatCapacity(ss.transformers);
          if (cap && cap !== '—') parts.push(cap);
        }
        const text = parts.join(' · ');
        if (text) {
          const icon = L.divIcon({
            className: 'pm-asset-label pm-ss-label',
            html: `<span>${escapeHtml(text)}</span>`,
            iconSize: [0, 0],
            iconAnchor: [0, 0],
          });
          layer.addLayer(
            L.marker([ss.lat, ss.lng], {
              icon,
              interactive: false,
              pane: labelsPane,
              zIndexOffset: 200,
            }),
          );
        }
      }
    });

    // Suggested edits (super admin review layer)
    if (
      showSuggestionsOnMap &&
      (adminRole === 'super' || adminRole === 'editor') &&
      suggestions.length
    ) {
      suggestions.forEach((sug) => {
        if (sug.lat == null || sug.lng == null) return;
        const focused = focusedSuggestionId === sug.id;
        const label = `Suggested · ${sug.editorName}: ${sug.summary}`;
        const icon = L.divIcon({
          className: `pm-suggestion-marker${focused ? ' is-focused' : ''}`,
          html: `<span class="pm-suggestion-dot${focused ? ' is-focused' : ''}"></span><span class="pm-suggestion-text">${escapeHtml(label)}</span>`,
          iconSize: [0, 0],
          iconAnchor: [0, 0],
        });
        const marker = L.marker([sug.lat, sug.lng], {
          icon,
          interactive: true,
          pane: calloutsPane,
          zIndexOffset: focused ? 200 : 100,
        });
        marker.bindTooltip(label, {
          permanent: focused,
          className: 'pm-tip pm-tip-suggestion',
        });
        if (focused) {
          L.circleMarker([sug.lat, sug.lng], {
            radius: 22,
            color: '#ea580c',
            weight: 2,
            dashArray: '4 3',
            fillColor: '#ea580c',
            fillOpacity: 0.12,
            interactive: false,
            className: 'pm-snap-ring',
          }).addTo(layer);
        }
        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          const st = useNetworkStore.getState();
          st.focusSuggestion(sug.id);
        });
        layer.addLayer(marker);
      });
    }

    // Personal on-device drafts (editor only)
    if (
      showPersonalDraftsOnMap &&
      adminRole === 'editor' &&
      personalDrafts.length
    ) {
      personalDrafts.forEach((draft) => {
        if (draft.lat == null || draft.lng == null) return;
        const focused = focusedPersonalDraftId === draft.id;
        const label = `Draft · ${draft.summary}`;
        const icon = L.divIcon({
          className: `pm-draft-marker${focused ? ' is-focused' : ''}`,
          html: `<span class="pm-draft-dot${focused ? ' is-focused' : ''}"></span><span class="pm-draft-text">${escapeHtml(label)}</span>`,
          iconSize: [0, 0],
          iconAnchor: [0, 0],
        });
        const marker = L.marker([draft.lat, draft.lng], {
          icon,
          interactive: true,
          pane: calloutsPane,
          zIndexOffset: focused ? 200 : 100,
        });
        marker.bindTooltip(label, {
          permanent: focused,
          className: 'pm-tip pm-tip-draft',
        });
        if (focused) {
          L.circleMarker([draft.lat, draft.lng], {
            radius: 22,
            color: '#0d9488',
            weight: 2,
            dashArray: '4 3',
            fillColor: '#0d9488',
            fillOpacity: 0.12,
            interactive: false,
            className: 'pm-snap-ring',
          }).addTo(layer);
        }
        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          useNetworkStore.getState().focusPersonalDraft(draft.id);
        });
        layer.addLayer(marker);
      });
    }

    // 33 kV spacing-based siting candidates
    if (showSitingOnMap && sitingAnalysis?.candidates.length) {
      sitingAnalysis.candidates.forEach((c) => {
        const focused = focusedSitingId === c.id;
        const nearer =
          c.nearerSs?.length > 0
            ? c.nearerSs
            : [{ id: c.nearestSsId, name: c.nearestSsName, km: c.gapKm }];
        const tipHtml = [
          `<div class="pm-siting-tip-title">33 kV site · ${escapeHtml(c.district)}</div>`,
          ...nearer.map(
            (n, i) =>
              `<div class="pm-siting-tip-row">${i + 1}. ${escapeHtml(n.name)} · <strong>${n.km.toFixed(1)} km</strong></div>`,
          ),
        ].join('');
        const icon = L.divIcon({
          className: `pm-siting-marker${focused ? ' is-focused' : ''}`,
          html: `<span class="pm-siting-dot${focused ? ' is-focused' : ''}"></span><span class="pm-siting-text">${escapeHtml(`+33 · ${c.gapKm.toFixed(1)} km`)}</span>`,
          iconSize: [0, 0],
          iconAnchor: [0, 0],
        });
        const marker = L.marker([c.lat, c.lng], {
          icon,
          interactive: true,
          pane: calloutsPane,
          zIndexOffset: focused ? 220 : 120,
        });
        marker.bindTooltip(tipHtml, {
          permanent: focused,
          direction: 'right',
          offset: [14, 0],
          className: 'pm-tip pm-tip-siting pm-tip-siting-rich',
        });
        if (focused) {
          L.circleMarker([c.lat, c.lng], {
            radius: 24,
            color: '#0369a1',
            weight: 2,
            dashArray: '4 3',
            fillColor: '#0369a1',
            fillOpacity: 0.1,
            interactive: false,
          }).addTo(layer);

          nearer.forEach((n, i) => {
            const ss = ssById.get(n.id);
            if (!ss) return;
            L.polyline(
              [
                [c.lat, c.lng],
                [ss.lat, ss.lng],
              ],
              {
                color: i === 0 ? '#0369a1' : '#38bdf8',
                weight: i === 0 ? 2 : 1.25,
                dashArray: i === 0 ? '4 4' : '2 4',
                opacity: i === 0 ? 0.9 : 0.65,
                interactive: false,
              },
            ).addTo(layer);

            const midLat = (c.lat + ss.lat) / 2;
            const midLng = (c.lng + ss.lng) / 2;
            const distIcon = L.divIcon({
              className: 'pm-siting-dist-label',
              html: `<span>${n.km.toFixed(1)} km</span>`,
              iconSize: [0, 0],
              iconAnchor: [0, 0],
            });
            layer.addLayer(
              L.marker([midLat, midLng], {
                icon: distIcon,
                interactive: false,
                pane: labelsPane,
                zIndexOffset: 180,
              }),
            );
          });
        }
        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          useNetworkStore.getState().focusSitingCandidate(c.id);
        });
        layer.addLayer(marker);
      });
    }

    hintsLayerRef.current?.bringToFront();
  }, [
    loaded,
    substations,
    lines,
    tapNodes,
    tapLaterals,
    selection,
    tool,
    connectDraft,
    tapDraft,
    filters,
    mapLayers.showSsNames,
    mapLayers.showSsCapacity,
    mapLayers.showFeederNames,
    mapLayers.showFeederLength,
    mapZoom,
    suggestions,
    showSuggestionsOnMap,
    focusedSuggestionId,
    personalDrafts,
    showPersonalDraftsOnMap,
    focusedPersonalDraftId,
    adminRole,
    sitingAnalysis,
    showSitingOnMap,
    focusedSitingId,
    voltageCheckActive,
    sitingActive,
    voltageFocus,
  ]);

  // Far-from-33 kV wash + hit targets
  useEffect(() => {
    const map = mapRef.current;
    const vcLayer = voltageCheckLayerRef.current;
    if (!map || !vcLayer) return;
    vcLayer.clearLayers();

    const active =
      voltageCheckActive && showVoltageCheckOnMap && voltageCheckAnalysis?.cells.length;
    if (!active || !voltageCheckAnalysis) return;

    const url = buildVoltageCheckWashDataUrl(voltageCheckAnalysis);
    const b = voltageCheckAnalysis.bounds;
    if (url) {
      L.imageOverlay(
        url,
        [
          [b.minLat, b.minLng],
          [b.maxLat, b.maxLng],
        ],
        { opacity: 0.92, interactive: false, className: 'pm-voltage-check-wash' },
      ).addTo(vcLayer);
    }

    const ssById = new Map(substations.map((s) => [s.id, s]));
    const focused = focusedVoltageCheckId
      ? voltageCheckAnalysis.cells.find((c) => c.id === focusedVoltageCheckId) ??
        voltageCheckAnalysis.hotspots.find((c) => c.id === focusedVoltageCheckId)
      : null;

    if (focused) {
      L.circleMarker([focused.lat, focused.lng], {
        radius: 18,
        color: '#b91c1c',
        weight: 2,
        dashArray: '4 3',
        fillColor: '#ef4444',
        fillOpacity: 0.12,
        interactive: false,
      }).addTo(vcLayer);
      const ss = ssById.get(focused.nearest33Id);
      if (ss) {
        L.polyline(
          [
            [focused.lat, focused.lng],
            [ss.lat, ss.lng],
          ],
          {
            color: '#b91c1c',
            weight: 1.75,
            dashArray: '5 4',
            opacity: 0.85,
            interactive: false,
          },
        ).addTo(vcLayer);
      }
    }

    // Sparse click targets on hotspots; hover via map mousemove over any far cell
    const hitIds = new Set(voltageCheckAnalysis.hotspots.map((c) => c.id));
    if (focused) hitIds.add(focused.id);
    const hitCells = voltageCheckAnalysis.cells.filter((c) => hitIds.has(c.id));

    hitCells.forEach((c) => {
      const tip = `${c.district} · ${c.nearest33Name} · ${c.dist33Km.toFixed(1)} km`;
      const marker = L.circleMarker([c.lat, c.lng], {
        radius: 14,
        color: 'transparent',
        weight: 0,
        fillColor: '#000',
        fillOpacity: 0.01,
        interactive: true,
        className: 'pm-voltage-check-hit',
      });
      marker.bindTooltip(tip, {
        sticky: true,
        direction: 'top',
        offset: [0, -8],
        className: 'pm-tip pm-tip-voltage-check',
      });
      marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        const st = useNetworkStore.getState();
        st.addVoltageCheckHit(c);
        st.focusVoltageCheckCell(c.id);
      });
      vcLayer.addLayer(marker);
    });

    const hoverTip = L.tooltip({
      sticky: true,
      direction: 'top',
      offset: [0, -10],
      className: 'pm-tip pm-tip-voltage-check',
      opacity: 0.95,
    });

    const onMapMove = (e: L.LeafletMouseEvent) => {
      const analysis = useNetworkStore.getState().voltageCheckAnalysis;
      if (!analysis?.cells.length) {
        map.closeTooltip(hoverTip);
        return;
      }
      const cell = nearestVoltageCheckCell(e.latlng.lat, e.latlng.lng, analysis.cells, 3.5);
      if (!cell) {
        map.closeTooltip(hoverTip);
        return;
      }
      hoverTip
        .setLatLng(e.latlng)
        .setContent(
          `${escapeHtml(cell.district)} · ${escapeHtml(cell.nearest33Name)} · <strong>${cell.dist33Km.toFixed(1)} km</strong>`,
        );
      if (!hoverTip.isOpen()) hoverTip.addTo(map);
    };

    const onMapClick = (e: L.LeafletMouseEvent) => {
      if (!useNetworkStore.getState().voltageCheckActive) return;
      if (!useNetworkStore.getState().showVoltageCheckOnMap) return;
      const analysis = useNetworkStore.getState().voltageCheckAnalysis;
      if (!analysis?.cells.length) return;
      const cell = nearestVoltageCheckCell(e.latlng.lat, e.latlng.lng, analysis.cells, 5);
      if (!cell) return;
      const st = useNetworkStore.getState();
      st.addVoltageCheckHit(cell);
      st.focusVoltageCheckCell(cell.id);
    };
    map.on('mousemove', onMapMove);
    map.on('click', onMapClick);

    return () => {
      map.off('mousemove', onMapMove);
      map.off('click', onMapClick);
      map.closeTooltip(hoverTip);
      vcLayer.clearLayers();
    };
  }, [
    voltageCheckActive,
    showVoltageCheckOnMap,
    voltageCheckAnalysis,
    focusedVoltageCheckId,
    substations,
  ]);

  return (
    <>
      <div ref={containerRef} className="map-root" />
      {tool === 'add-ss' && (
        <div className="coord-chip" aria-live="polite">
          <div className="coord-chip-label">
            {placeDraft ? 'Selected position' : 'Cursor'}
          </div>
          <div className="coord-chip-values">
            <span>
              Lat{' '}
              <strong>
                {(placeDraft ?? hoverCoords)?.lat?.toFixed(6) ?? '—'}
              </strong>
            </span>
            <span>
              Lng{' '}
              <strong>
                {(placeDraft ?? hoverCoords)?.lng?.toFixed(6) ?? '—'}
              </strong>
            </span>
          </div>
        </div>
      )}
    </>
  );
}
