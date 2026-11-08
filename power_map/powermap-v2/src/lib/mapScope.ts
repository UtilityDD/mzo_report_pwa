import type {
  MapLayerSettings,
  NetworkFilters,
  VoltageCode,
} from '@/domain/types';
import { DEFAULT_MASK_OPACITY } from '@/domain/types';

export type SceneId =
  | 'overview'
  | 'district-focus'
  | 'ehv'
  | 'local-33'
  | 'proposed'
  | 'present'
  | 'print-ready'
  | 'custom';

export type ScenePreset = {
  id: Exclude<SceneId, 'custom'>;
  label: string;
  blurb: string;
  filters: Partial<NetworkFilters>;
  mapLayers: Partial<MapLayerSettings>;
  /** Sync print settings from current focus / filters when applied. */
  syncPrint?: boolean;
};

const allVoltages: VoltageCode[] = ['400', '220', '132', '66', '33'];
export const SCENE_PRESETS: ScenePreset[] = [
  {
    id: 'overview',
    label: 'Overview',
    blurb: 'Full network, quiet labels',
    filters: {
      voltages: [...allVoltages],
      statuses: ['existing', 'proposed'],
      showProposed: true,
      overloadedOnly: false,
      oldOnly: false,
      needUpgradeOnly: false,
      orgUnitIds: [],
    },
    mapLayers: {
      basemap: 'none',
      showMask: true,
      maskOpacity: DEFAULT_MASK_OPACITY,
      showDistricts: true,
      showDistrictLabels: true,
      showBlocks: false,
      showBlockLabels: false,
      showSsNames: false,
      showSsCapacity: false,
      showFeederNames: false,
      showFeederLength: false,
      focusedDistricts: [],
      dimAllDistricts: false,
    },
  },
  {
    id: 'district-focus',
    label: 'District focus',
    blurb: 'Keep your focus; tidy for ops',
    filters: {
      voltages: [...allVoltages],
      statuses: ['existing', 'proposed'],
      showProposed: true,
      overloadedOnly: false,
      oldOnly: false,
      needUpgradeOnly: false,
    },
    mapLayers: {
      basemap: 'esri',
      showMask: true,
      showDistricts: true,
      showDistrictLabels: true,
      showBlocks: true,
      showBlockLabels: false,
      showSsNames: true,
      showSsCapacity: false,
      showFeederNames: false,
      showFeederLength: true,
      // focusedDistricts left as-is by applyScene
    },
    syncPrint: true,
  },
  {
    id: 'ehv',
    label: 'EHV spine',
    blurb: 'EHT in focus — 33 kV dimmed',
    filters: {
      voltages: [...allVoltages],
      statuses: ['existing', 'proposed'],
      showProposed: true,
      overloadedOnly: false,
      oldOnly: false,
      needUpgradeOnly: false,
      orgUnitIds: [],
    },
    mapLayers: {
      basemap: 'esri',
      showMask: true,
      showDistricts: true,
      showDistrictLabels: false,
      showBlocks: false,
      showBlockLabels: false,
      showSsNames: true,
      showFeederLength: true,
      showFeederNames: false,
      focusedDistricts: [],
      dimAllDistricts: false,
    },
  },
  {
    id: 'local-33',
    label: '33 kV local',
    blurb: '33 kV in focus — other voltages dimmed',
    filters: {
      voltages: [...allVoltages],
      statuses: ['existing', 'proposed'],
      showProposed: true,
      overloadedOnly: false,
      oldOnly: false,
      needUpgradeOnly: false,
    },
    mapLayers: {
      basemap: 'google',
      showMask: false,
      showDistricts: true,
      showDistrictLabels: false,
      showBlocks: true,
      showBlockLabels: true,
      showSsNames: true,
      showFeederLength: false,
      focusedDistricts: [],
      dimAllDistricts: false,
    },
  },
  {
    id: 'proposed',
    label: 'Proposed',
    blurb: 'Proposed assets bright; existing network dimmed',
    filters: {
      voltages: [...allVoltages],
      statuses: ['proposed'],
      showProposed: true,
      overloadedOnly: false,
      oldOnly: false,
      needUpgradeOnly: false,
      orgUnitIds: [],
    },
    mapLayers: {
      basemap: 'esri',
      showMask: true,
      showDistricts: true,
      showDistrictLabels: false,
      showBlocks: false,
      showSsNames: true,
      showFeederLength: true,
      focusedDistricts: [],
      dimAllDistricts: false,
    },
  },
  {
    id: 'present',
    label: 'Present',
    blurb: 'Clean canvas for meetings',
    filters: {
      voltages: [...allVoltages],
      statuses: ['existing', 'proposed'],
      showProposed: true,
      overloadedOnly: false,
      oldOnly: false,
      needUpgradeOnly: false,
    },
    mapLayers: {
      basemap: 'none',
      showMask: true,
      showDistricts: true,
      showDistrictLabels: false,
      showBlocks: false,
      showBlockLabels: false,
      showSsNames: false,
      showSsCapacity: false,
      showFeederNames: false,
      showFeederLength: false,
    },
  },
  {
    id: 'print-ready',
    label: 'Print-ready',
    blurb: 'Matches print sheet defaults',
    filters: {
      voltages: [...allVoltages],
      statuses: ['existing', 'proposed'],
      showProposed: true,
      overloadedOnly: false,
      oldOnly: false,
      needUpgradeOnly: false,
    },
    mapLayers: {
      basemap: 'esri',
      showMask: false,
      showDistricts: true,
      showDistrictLabels: false,
      showBlocks: false,
      showSsNames: true,
      showFeederLength: true,
      showFeederNames: false,
    },
    syncPrint: true,
  },
];

export function sceneById(id: SceneId): ScenePreset | undefined {
  return SCENE_PRESETS.find((s) => s.id === id);
}

/** Live badge text from filters + district focus (+ optional scene name). */
export function buildScopeBadgeLabel(opts: {
  sceneId: SceneId;
  filters: NetworkFilters;
  focusedDistricts: string[];
}): string {
  const parts: string[] = [];
  const scene = sceneById(opts.sceneId);
  if (scene) parts.push(scene.label);
  else if (opts.sceneId === 'custom') parts.push('Custom');

  const focused = opts.focusedDistricts;
  if (focused.length === 1) parts.push(focused[0]);
  else if (focused.length === 2) parts.push(`${focused[0]} & ${focused[1]}`);
  else if (focused.length > 2) parts.push(`${focused.length} districts`);

  const volts = [...opts.filters.voltages].sort(
    (a, b) => Number(b) - Number(a),
  );
  if (volts.length && volts.length < 4) {
    parts.push(volts.map((v) => `${v} kV`).join(' · '));
  }

  const st = opts.filters.statuses.filter((s) => s === 'existing' || s === 'proposed');
  if (st.length === 1) parts.push(st[0] === 'existing' ? 'Existing' : 'Proposed');
  else if (!opts.filters.showProposed) parts.push('Existing');

  if (opts.filters.overloadedOnly) parts.push('Overloaded');
  if (opts.filters.oldOnly) parts.push('Old');
  if (opts.filters.needUpgradeOnly) parts.push('Need upgrade');

  return parts.filter(Boolean).join(' · ') || 'Full network';
}

/** Print fields derived from the live map scope (district focus + filters + labels). */
export function printPatchFromScope(opts: {
  filters: NetworkFilters;
  mapLayers: MapLayerSettings;
}): {
  districts: string[];
  showProposed: boolean;
  basemap: MapLayerSettings['basemap'];
  showSsNames: boolean;
  showFeederLength: boolean;
  showDistrictBoundaries: boolean;
} {
  const focused = opts.mapLayers.dimAllDistricts
    ? []
    : opts.mapLayers.focusedDistricts;
  const showProposed =
    opts.filters.showProposed && opts.filters.statuses.includes('proposed');
  return {
    districts: [...focused],
    showProposed,
    basemap: opts.mapLayers.basemap,
    showSsNames: opts.mapLayers.showSsNames,
    showFeederLength: opts.mapLayers.showFeederLength,
    showDistrictBoundaries: opts.mapLayers.showDistricts,
  };
}
