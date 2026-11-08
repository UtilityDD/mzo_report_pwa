import L from 'leaflet';
import { fetchBlockGeoJSON, fetchDistrictGeoJSON } from '@/lib/districts';
import { DEFAULT_MASK_OPACITY } from '@/domain/types';

/**
 * Fallback state outline, used only when the district file cannot be loaded.
 * It comes from a different survey than the districts, so its edge does not sit
 * exactly on the district edges — prefer the dissolved districts.
 */
const WB_STATE_FALLBACK_URL =
  'https://raw.githubusercontent.com/shuklaneerajdev/IndiaStateTopojsonFiles/master/WestBengal.geojson';

/**
 * Default map frame: Malda Zone and north Bengal (same as the other Power Map app).
 */
export const DEFAULT_ZONE_BOUNDS: [L.LatLngTuple, L.LatLngTuple] = [
  [24.95, 87.75],
  [27.15, 89.75],
];

/**
 * Fit the North Bengal / Malda Zone frame to the map pane.
 * Uses live district bounds when available; otherwise the hardcoded fallback.
 */
export function fitDefaultZone(map: L.Map, bounds?: L.LatLngBounds | null) {
  map.invalidateSize(false);
  const target =
    bounds && bounds.isValid() ? bounds : L.latLngBounds(DEFAULT_ZONE_BOUNDS);
  const { x, y } = map.getSize();
  const desktop = x >= 1000 || y >= 640;
  // Pixel padding clears tool rail / legend / side panel so districts fill the view
  const padX = desktop ? 56 : 28;
  const padY = desktop ? 48 : 32;
  map.fitBounds(target, {
    animate: false,
    maxZoom: desktop ? 11 : 10,
    paddingTopLeft: L.point(padX, padY),
    paddingBottomRight: L.point(desktop ? 36 : 24, padY),
  });
}

export type BasemapId = 'google' | 'google-hybrid' | 'osm' | 'esri' | 'none';

/** DRO shell appearance (`html` / `.app-shell` `data-appearance`). */
export type MapAppearance = 'light' | 'dark';

export function readMapAppearance(): MapAppearance {
  if (typeof document === 'undefined') return 'light';
  const from =
    document.querySelector('.app-shell')?.getAttribute('data-appearance') ||
    document.documentElement.getAttribute('data-appearance');
  if (from === 'dark') return 'dark';
  if (from === 'light') return 'light';
  // Match AppShell before the attribute is written on first paint.
  try {
    if (window.localStorage.getItem('dro.appearance') === 'dark') return 'dark';
    if (window.localStorage.getItem('dro.appearance') === 'light') return 'light';
  } catch {
    /* ignore */
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export interface BoundaryLayerOptions {
  showMask: boolean;
  maskOpacity: number;
  showDistricts: boolean;
  showDistrictLabels: boolean;
  /** CD block (sub-district) outlines; loaded on first use. */
  showBlocks: boolean;
  showBlockLabels: boolean;
  /** Empty = all undimmed (unless dimAllDistricts). Non-empty = only these stay bright. */
  focusedDistricts: string[];
  dimAllDistricts: boolean;
  /** Allow clicking districts to focus (cursor tool). */
  districtsInteractive: boolean;
  /** Light vs dark map chrome; defaults to live DRO appearance. */
  appearance?: MapAppearance;
  onDistrictClick?: (name: string, additive: boolean) => void;
  /** User-moved label positions (lat/lng). Missing names use the district centroid. */
  districtLabelPositions?: Record<string, { lat: number; lng: number }>;
  onDistrictLabelMove?: (name: string, lat: number, lng: number) => void;
}

export interface BoundaryHandle {
  group: L.LayerGroup;
  bounds: L.LatLngBounds | null;
  districtNames: string[];
  apply: (opts: BoundaryLayerOptions) => void;
  destroy: () => void;
}

type GeoJSONGeometry =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] };

type GeoJSONFeature = {
  type: 'Feature';
  properties?: Record<string, unknown>;
  geometry: GeoJSONGeometry | null;
};

type GeoJSONFC = {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
};

function collectOuterRings(data: GeoJSONFC): number[][][] {
  const rings: number[][][] = [];
  for (const feature of data.features) {
    const g = feature.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') rings.push(g.coordinates[0]);
    else if (g.type === 'MultiPolygon') {
      for (const poly of g.coordinates) rings.push(poly[0]);
    }
  }
  return rings;
}

/** ~1 cm, so shared vertices survive float noise but real corners stay distinct. */
const VERTEX_GRID = 1e7;

function vertexKey(pt: number[]): string {
  return `${Math.round(pt[0] * VERTEX_GRID)},${Math.round(pt[1] * VERTEX_GRID)}`;
}

type BoundaryEdge = { a: number[]; b: number[]; ka: string; kb: string };

/**
 * Merge adjacent polygons by discarding every edge that two of them share, then
 * re-chaining what is left into closed rings. Neighbouring districts in the
 * source file are built on one topology and use identical vertices, so the
 * result is the exact state outline rather than a second, slightly different
 * survey of it. Returns null if the rings do not chain cleanly.
 */
function dissolveRings(rings: number[][][]): number[][][] | null {
  const edges = new Map<string, { edge: BoundaryEdge; count: number }>();

  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const ka = vertexKey(a);
      const kb = vertexKey(b);
      if (ka === kb) continue;
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const hit = edges.get(key);
      if (hit) hit.count += 1;
      else edges.set(key, { edge: { a, b, ka, kb }, count: 1 });
    }
  }

  const perimeter: BoundaryEdge[] = [];
  for (const { edge, count } of edges.values()) {
    if (count === 1) perimeter.push(edge);
  }
  if (!perimeter.length) return null;

  const adjacency = new Map<string, number[]>();
  perimeter.forEach((edge, index) => {
    for (const k of [edge.ka, edge.kb]) {
      const list = adjacency.get(k);
      if (list) list.push(index);
      else adjacency.set(k, [index]);
    }
  });

  const used = new Set<number>();
  const outlines: number[][][] = [];

  for (let i = 0; i < perimeter.length; i++) {
    if (used.has(i)) continue;
    const first = perimeter[i];
    used.add(i);
    const ring: number[][] = [first.a, first.b];
    let cursor = first.kb;

    while (cursor !== first.ka) {
      let next = -1;
      for (const candidate of adjacency.get(cursor) ?? []) {
        if (!used.has(candidate)) {
          next = candidate;
          break;
        }
      }
      if (next < 0) break;
      used.add(next);
      const edge = perimeter[next];
      const forward = edge.ka === cursor;
      ring.push(forward ? edge.b : edge.a);
      cursor = forward ? edge.kb : edge.ka;
    }

    // An open chain means the source rings are not edge-matched; bail out so the
    // caller can fall back instead of drawing a mask with a torn edge.
    if (cursor !== first.ka) return null;
    if (ring.length < 4) continue;
    ring[ring.length - 1] = ring[0];
    outlines.push(ring);
  }

  return outlines.length ? outlines : null;
}

export function districtName(props: Record<string, unknown> | undefined): string {
  if (!props) return 'District';
  for (const k of ['district', 'DISTRICT', 'dtname', 'DT_NAME', 'NAME_2', 'name', 'NAME']) {
    const v = props[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return 'District';
}

export function blockName(props: Record<string, unknown> | undefined): string {
  const v = props?.block;
  return typeof v === 'string' && v.trim() ? v.trim() : 'Block';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
}

function ringCentroid(ring: number[][]): [number, number] {
  let x = 0;
  let y = 0;
  const n = Math.max(ring.length - 1, 1);
  for (let i = 0; i < n; i++) {
    x += ring[i][0];
    y += ring[i][1];
  }
  return [y / n, x / n];
}

function featureCentroid(feature: GeoJSONFeature): [number, number] | null {
  const g = feature.geometry;
  if (!g) return null;
  if (g.type === 'Polygon') return ringCentroid(g.coordinates[0]);
  if (g.type === 'MultiPolygon' && g.coordinates[0]?.[0]) {
    return ringCentroid(g.coordinates[0][0]);
  }
  return null;
}

export function isMaldaAndNorthDistrict(name: string) {
  return /malda|maldah|dinajpur|darjeel|darjil|jalpaiguri|alipurduar|cooch|koch.?bihar|kalimpong/i.test(
    name,
  );
}

/** Bounds covering Malda Zone plus north Bengal districts. */
export function boundsForMaldaAndNorth(districtData: GeoJSONFC | null): L.LatLngBounds {
  const fallback = L.latLngBounds(DEFAULT_ZONE_BOUNDS);
  if (!districtData?.features?.length) return fallback;

  const selected = districtData.features.filter((f) =>
    isMaldaAndNorthDistrict(districtName(f.properties)),
  );
  if (!selected.length) return fallback;

  const layer = L.geoJSON({
    type: 'FeatureCollection',
    features: selected,
  } as GeoJSON.GeoJsonObject);
  const b = layer.getBounds();
  return b.isValid() ? b : fallback;
}

async function fetchGeoJSON(url: string): Promise<GeoJSONFC> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return (await res.json()) as GeoJSONFC;
}

/**
 * Below this zoom the state holds 344 blocks, so their labels would be an
 * unreadable pile; district labels cover that range instead.
 */
const BLOCK_LABEL_MIN_ZOOM = 11;

/** Hairline sub-division, deliberately weaker than the district stroke. */
const BLOCK_STYLE: L.PathOptions = {
  color: '#0f766e',
  weight: 0.7,
  opacity: 0.55,
  dashArray: '3 3',
  fill: false,
  interactive: false,
};

/** Above network markers (600), below callouts/popups; keeps place names readable. */
export const PLACE_LABELS_PANE = 'pmPlaceLabels';
const PLACE_LABELS_Z = '640';

/** Above place labels — suggestions, drafts, siting chips. */
export const CALLOUTS_PANE = 'pmCallouts';
const CALLOUTS_Z = '680';

export function ensurePlaceLabelsPane(map: L.Map): string {
  if (!map.getPane(PLACE_LABELS_PANE)) {
    const pane = map.createPane(PLACE_LABELS_PANE);
    pane.style.zIndex = PLACE_LABELS_Z;
    pane.style.pointerEvents = 'none';
  }
  return PLACE_LABELS_PANE;
}

export function ensureCalloutsPane(map: L.Map): string {
  if (!map.getPane(CALLOUTS_PANE)) {
    const pane = map.createPane(CALLOUTS_PANE);
    pane.style.zIndex = CALLOUTS_Z;
  }
  return CALLOUTS_PANE;
}

function styleForDistrict(
  name: string,
  focusedDistricts: string[],
  dimAllDistricts: boolean,
  appearance: MapAppearance,
): L.PathOptions {
  const focusing = focusedDistricts.length > 0;
  const bright = !dimAllDistricts && (!focusing || focusedDistricts.includes(name));
  if (bright) {
    return {
      color: focusing ? '#0b6e4f' : '#0f766e',
      weight: focusing ? 2 : 1.35,
      opacity: 1,
      fillColor: focusing ? '#0b6e4f' : '#0f766e',
      fillOpacity: focusing ? 0.08 : 0.03,
    };
  }
  // Light mode: soft slate wash. Dark mode: deep ink veil (matches mask).
  if (appearance === 'light') {
    return {
      color: '#64748b',
      weight: 1,
      opacity: 0.45,
      fillColor: '#94a3b8',
      fillOpacity: 0.2,
    };
  }
  return {
    color: '#94a3b8',
    weight: 1,
    opacity: 0.35,
    fillColor: '#0f172a',
    fillOpacity: 0.48,
  };
}

function maskStyle(opacity: number, appearance: MapAppearance): L.PathOptions {
  // Slider is 0…1: 100% fully hides the map outside West Bengal.
  const fillOpacity = Math.min(1, Math.max(0, Number(opacity) || 0));
  if (appearance === 'light') {
    return {
      stroke: false,
      // Cool gray wash — clearly softer than the dark ink veil.
      fillColor: '#64748b',
      fillOpacity,
      fillRule: 'evenodd',
    };
  }
  return {
    stroke: false,
    fillColor: '#0f172a',
    fillOpacity,
    fillRule: 'evenodd',
  };
}

export async function createBoundaryLayers(map: L.Map): Promise<BoundaryHandle> {
  let districtData: GeoJSONFC | null = null;
  try {
    districtData = await fetchDistrictGeoJSON<GeoJSONFC>();
  } catch {
    districtData = null;
  }

  // Punch the mask with the districts' own outline so the two layers share every
  // vertex. Dissolving also drops the internal district edges, which would
  // otherwise leave hairlines along shared borders under the even-odd fill.
  const districtRings = districtData ? collectOuterRings(districtData) : [];
  const rings =
    (districtRings.length ? dissolveRings(districtRings) : null) ??
    (districtRings.length ? districtRings : collectOuterRings(await fetchGeoJSON(WB_STATE_FALLBACK_URL)));

  const districtNames = districtData
    ? [...new Set(districtData.features.map((f) => districtName(f.properties)))].sort((a, b) =>
        a.localeCompare(b),
      )
    : [];

  const maskFeature: GeoJSONFeature = {
    type: 'Feature',
    properties: { role: 'mask' },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-180, -90],
          [180, -90],
          [180, 90],
          [-180, 90],
          [-180, -90],
        ],
        ...rings,
      ],
    },
  };

  const group = L.layerGroup().addTo(map);

  const maskLayer = L.geoJSON(maskFeature as GeoJSON.GeoJsonObject, {
    interactive: false,
    style: maskStyle(DEFAULT_MASK_OPACITY, readMapAppearance()),
  }).addTo(group);

  let clickHandler: BoundaryLayerOptions['onDistrictClick'];
  let latestFocused: string[] = [];
  let latestDimAll = false;
  let latestAppearance: MapAppearance = readMapAppearance();

  const districtLayer = districtData
    ? L.geoJSON(districtData as GeoJSON.GeoJsonObject, {
        interactive: false,
        style: (feature) => {
          const name = districtName(feature?.properties as Record<string, unknown>);
          return styleForDistrict(name, latestFocused, latestDimAll, latestAppearance);
        },
        onEachFeature: (feature, layer) => {
          const name = districtName(feature.properties as Record<string, unknown>);
          (layer as L.Layer & { __districtName?: string }).__districtName = name;
          layer.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            const additive = Boolean(
              (e as L.LeafletMouseEvent).originalEvent?.shiftKey ||
                (e as L.LeafletMouseEvent).originalEvent?.metaKey ||
                (e as L.LeafletMouseEvent).originalEvent?.ctrlKey,
            );
            clickHandler?.(name, additive);
          });
        },
      })
    : null;

  let blockLayer: L.GeoJSON | null = null;
  let blockLabelGroup: L.LayerGroup | null = null;
  let blockState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  let destroyed = false;
  let latestOpts: BoundaryLayerOptions | null = null;

  const loadBlocks = () => {
    if (blockState !== 'idle') return;
    blockState = 'loading';
    void fetchBlockGeoJSON<GeoJSONFC>()
      .then((data) => {
        if (destroyed) return;
        blockLayer = L.geoJSON(data as GeoJSON.GeoJsonObject, {
          interactive: false,
          style: BLOCK_STYLE,
        });
        const labels = L.layerGroup();
        const blockPane = ensurePlaceLabelsPane(map);
        for (const feature of data.features) {
          const c = featureCentroid(feature);
          if (!c) continue;
          labels.addLayer(
            L.marker(c, {
              interactive: false,
              pane: blockPane,
              zIndexOffset: 100,
              icon: L.divIcon({
                className: 'pm-block-label',
                html: `<span>${escapeHtml(blockName(feature.properties))}</span>`,
                iconSize: [0, 0],
                iconAnchor: [0, 0],
              }),
            }),
          );
        }
        blockLabelGroup = labels;
        blockState = 'ready';
        if (latestOpts) apply(latestOpts);
      })
      .catch(() => {
        blockState = 'failed';
      });
  };

  type LabelEntry = { name: string; marker: L.Marker; defaultLatLng: L.LatLng };
  const labelEntries: LabelEntry[] = [];
  const labelGroup = L.layerGroup();
  const placePane = ensurePlaceLabelsPane(map);
  let onLabelMove: ((name: string, lat: number, lng: number) => void) | undefined;
  if (districtData) {
    for (const feature of districtData.features) {
      const c = featureCentroid(feature);
      if (!c) continue;
      const name = districtName(feature.properties);
      const defaultLatLng = L.latLng(c[0], c[1]);
      const marker = L.marker(defaultLatLng, {
        interactive: true,
        draggable: true,
        autoPan: false,
        pane: placePane,
        zIndexOffset: 200,
        title: 'Drag to move label',
        icon: L.divIcon({
          className: 'pm-district-label',
          html: `<span>${escapeHtml(name)}</span>`,
          iconSize: undefined,
          iconAnchor: undefined,
        }),
      });
      marker.on('dragend', () => {
        const ll = marker.getLatLng();
        onLabelMove?.(name, Number(ll.lat.toFixed(6)), Number(ll.lng.toFixed(6)));
      });
      // Keep map/district clicks from firing when finishing a label drag.
      marker.on('click', (e) => L.DomEvent.stopPropagation(e));
      labelEntries.push({ name, marker, defaultLatLng });
      labelGroup.addLayer(marker);
    }
  }

  let bounds: L.LatLngBounds | null = null;
  try {
    bounds = boundsForMaldaAndNorth(districtData);
  } catch {
    bounds = L.latLngBounds(DEFAULT_ZONE_BOUNDS);
  }

  const apply = (opts: BoundaryLayerOptions) => {
    latestOpts = opts;
    latestFocused = opts.focusedDistricts;
    latestDimAll = opts.dimAllDistricts;
    clickHandler = opts.onDistrictClick;
    const appearance = opts.appearance ?? readMapAppearance();
    latestAppearance = appearance;

    if (opts.showMask) {
      if (!group.hasLayer(maskLayer)) maskLayer.addTo(group);
      maskLayer.setStyle(maskStyle(opts.maskOpacity, appearance));
    } else if (group.hasLayer(maskLayer)) {
      group.removeLayer(maskLayer);
    }

    if (districtLayer) {
      if (opts.showDistricts) {
        if (!group.hasLayer(districtLayer)) districtLayer.addTo(group);
        districtLayer.eachLayer((layer) => {
          const name =
            (layer as L.Layer & { __districtName?: string }).__districtName ??
            districtName(
              (layer as L.GeoJSON & { feature?: GeoJSONFeature }).feature?.properties,
            );
          if (layer instanceof L.Path) {
            layer.setStyle(
              styleForDistrict(name, opts.focusedDistricts, opts.dimAllDistricts, appearance),
            );
          }
        });
        districtLayer.eachLayer((layer) => {
          const el = (layer as L.Path).getElement?.();
          if (el instanceof HTMLElement || el instanceof SVGElement) {
            el.style.pointerEvents = opts.districtsInteractive ? 'auto' : 'none';
          }
          if ('options' in layer) {
            (layer as L.Path).options.interactive = opts.districtsInteractive;
          }
        });
      } else if (group.hasLayer(districtLayer)) {
        group.removeLayer(districtLayer);
      }
    }

    if (opts.showDistricts && opts.showDistrictLabels) {
      if (!group.hasLayer(labelGroup)) labelGroup.addTo(group);
      onLabelMove = opts.onDistrictLabelMove;
      const positions = opts.districtLabelPositions ?? {};
      const focusing = opts.focusedDistricts.length > 0;
      for (const entry of labelEntries) {
        const custom = positions[entry.name];
        const target = custom
          ? L.latLng(custom.lat, custom.lng)
          : entry.defaultLatLng;
        const cur = entry.marker.getLatLng();
        if (cur.lat !== target.lat || cur.lng !== target.lng) {
          entry.marker.setLatLng(target);
        }
        if (!entry.marker.dragging?.enabled()) entry.marker.dragging?.enable();
        const el = entry.marker.getElement();
        if (el) {
          const bright =
            !opts.dimAllDistricts &&
            (!focusing || opts.focusedDistricts.includes(entry.name));
          el.classList.toggle('is-dimmed', !bright);
          el.classList.toggle('is-focused', focusing && bright);
          el.classList.toggle('is-custom', Boolean(custom));
        }
      }
    } else if (group.hasLayer(labelGroup)) {
      group.removeLayer(labelGroup);
    }

    if (opts.showBlocks) {
      if (blockLayer) {
        if (!group.hasLayer(blockLayer)) blockLayer.addTo(group);
      } else {
        loadBlocks();
      }
    } else if (blockLayer && group.hasLayer(blockLayer)) {
      group.removeLayer(blockLayer);
    }

    if (blockLabelGroup) {
      const showLabels =
        opts.showBlocks && opts.showBlockLabels && map.getZoom() >= BLOCK_LABEL_MIN_ZOOM;
      if (showLabels && !group.hasLayer(blockLabelGroup)) blockLabelGroup.addTo(group);
      else if (!showLabels && group.hasLayer(blockLabelGroup)) group.removeLayer(blockLabelGroup);
    }

    // Keep blocks under the district strokes, and the mask under everything.
    // Place-name labels use pmPlaceLabels pane (above network symbols).
    if (opts.showBlocks && blockLayer && group.hasLayer(blockLayer)) blockLayer.bringToBack();
    if (opts.showMask && group.hasLayer(maskLayer)) maskLayer.bringToBack();
  };

  // Block labels are zoom-gated, so re-evaluate whenever the zoom settles.
  const onZoomEnd = () => {
    if (latestOpts) apply(latestOpts);
  };
  map.on('zoomend', onZoomEnd);

  return {
    group,
    bounds,
    districtNames,
    apply,
    destroy: () => {
      destroyed = true;
      map.off('zoomend', onZoomEnd);
      group.remove();
    },
  };
}

const ESRI_CANVAS = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
const ESRI_ATTRIBUTION =
  'Tiles &copy; Esri — Esri, HERE, Garmin, &copy; OpenStreetMap contributors';

/**
 * Esri splits its light canvas into a label-free base and a separate reference
 * layer carrying the place names, so the light basemap is a group of two tiles.
 * Esri stops at zoom 16 and serves a "Map data not yet available" placeholder
 * above it, hence maxNativeZoom — Leaflet upscales instead of showing that.
 */
function createEsriCanvas(dark: boolean): L.LayerGroup {
  const style = dark ? 'World_Dark_Gray' : 'World_Light_Gray';
  const base = L.tileLayer(`${ESRI_CANVAS}/${style}_Base/MapServer/tile/{z}/{y}/{x}`, {
    maxZoom: 20,
    maxNativeZoom: 16,
    attribution: ESRI_ATTRIBUTION,
    updateWhenIdle: false,
    updateWhenZooming: true,
    keepBuffer: 4,
  });
  const labels = L.tileLayer(
    `${ESRI_CANVAS}/${style}_Reference/MapServer/tile/{z}/{y}/{x}`,
    { maxZoom: 20, maxNativeZoom: 16, updateWhenIdle: false, keepBuffer: 4 },
  );
  return L.layerGroup([base, labels]);
}

/** Street/light basemaps follow shell appearance; hybrid/satellite stay photographic. */
export function createBasemapLayer(
  id: BasemapId,
  appearance: MapAppearance = 'light',
): L.Layer {
  const dark = appearance === 'dark';
  switch (id) {
    case 'none':
      return L.tileLayer('', {
        maxZoom: 20,
        attribution: 'No basemap',
      });
    case 'google':
      return L.tileLayer('https://{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
        maxZoom: 20,
        subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
        attribution: 'Map data &copy; Google',
        updateWhenIdle: false,
        keepBuffer: 4,
        className: dark ? 'pm-basemap-tiles-darkable' : undefined,
      });
    case 'google-hybrid':
      return L.tileLayer('https://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}', {
        maxZoom: 20,
        subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
        attribution: 'Map data &copy; Google',
        updateWhenIdle: false,
        keepBuffer: 4,
      });
    case 'osm':
      return L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap',
        updateWhenIdle: false,
        keepBuffer: 4,
        className: dark ? 'pm-basemap-tiles-darkable' : undefined,
      });
    case 'esri':
    default:
      return createEsriCanvas(dark);
  }
}

/** Push a basemap behind any other tile layers, group or not. */
export function basemapToBack(layer: L.Layer) {
  if (layer instanceof L.LayerGroup) {
    // Reverse order so the first child ends up furthest back.
    for (const child of layer.getLayers().reverse()) {
      if (child instanceof L.TileLayer) child.bringToBack();
    }
  } else if (layer instanceof L.TileLayer) {
    layer.bringToBack();
  }
}
