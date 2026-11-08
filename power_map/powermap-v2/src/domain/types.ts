export type AssetLifecycle = 'proposed' | 'existing' | 'retired';
export type ToolMode =
  | 'cursor'
  | 'add-ss'
  | 'connect'
  | 'tap'
  | 'move'
  | 'delete'
  | 'measure';

export type VoltageCode = '400' | '220' | '132' | '66' | '33';

export type CircuitConfig = 'single' | 'double';

export interface VoltageLevel {
  id: string;
  code: VoltageCode;
  label: string;
  kvPrimary: number;
  color: string;
  sortOrder: number;
}

export interface OrgUnit {
  id: string;
  parentId: string | null;
  type: 'zone' | 'region' | 'division' | 'ccc';
  name: string;
  code: string;
  aeTechName?: string;
  phone?: string;
}

export interface TransformerUnit {
  id: string;
  ratingMva: number;
  quantity: number;
  sequence: number;
}

export interface Substation {
  id: string;
  name: string;
  status: AssetLifecycle;
  voltageCode: VoltageCode;
  lat: number;
  lng: number;
  orgUnitId: string | null;
  transformers: TransformerUnit[];
  loadingPct: number | null;
  commissionYear: number | null;
  proposalRef: string;
  remarks: string;
  owner: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TrunkLine {
  id: string;
  name: string;
  status: AssetLifecycle;
  voltageCode: VoltageCode;
  fromId: string;
  toId: string;
  circuitCount: number;
  circuitConfig: CircuitConfig;
  conductor: string;
  lengthKm: number | null;
  loadingPct: number | null;
  commissionYear: number | null;
  proposalRef: string;
  remarks: string;
  owner: string;
  version: number;
}

export interface TapNode {
  id: string;
  name: string;
  status: AssetLifecycle;
  parentLineId: string;
  positionRatio: number;
  lat: number;
  lng: number;
  remarks: string;
}

export type TapTargetKind = 'substation' | 'tap_node' | 'line';

export interface TapLateral {
  id: string;
  name: string;
  status: AssetLifecycle;
  voltageCode: VoltageCode;
  fromTapId: string;
  /** For line targets we create/use a tap on the target line */
  toKind: 'substation' | 'tap_node';
  toAssetId: string;
  conductor: string;
  lengthKm: number | null;
  loadingPct: number | null;
  commissionYear: number | null;
  proposalRef: string;
  remarks: string;
  owner: string;
}

export type SelectableKind = 'substation' | 'line' | 'tap_node' | 'tap_lateral';

export interface Selection {
  kind: SelectableKind;
  id: string;
}

export interface NetworkFilters {
  statuses: AssetLifecycle[];
  voltages: VoltageCode[];
  orgUnitIds: string[];
  overloadedOnly: boolean;
  oldOnly: boolean;
  needUpgradeOnly: boolean;
  showProposed: boolean;
}

export interface MapLayerSettings {
  /** Basemap tiles (Google shows admin lines in the map itself). */
  basemap: 'google' | 'google-hybrid' | 'osm' | 'esri' | 'none';
  /** Soft dim outside West Bengal. */
  showMask: boolean;
  /** 0..1, matching the map / side panel mask slider (1 = fully opaque outside WB). */
  maskOpacity: number;
  /** Clean district boundary overlay for district-level view. */
  showDistricts: boolean;
  showDistrictLabels: boolean;
  /** CD block (sub-district) outlines; the data loads on first use. */
  showBlocks: boolean;
  /** Block name labels, shown only once zoomed past the district level. */
  showBlockLabels: boolean;
  /** Permanent map labels for network assets */
  showSsNames: boolean;
  showSsCapacity: boolean;
  showFeederNames: boolean;
  showFeederLength: boolean;
  /**
   * Empty = all undimmed (unless dimAllDistricts).
   * Non-empty = only these stay bright; all others are dimmed.
   */
  focusedDistricts: string[];
  /** Force every district dimmed. */
  dimAllDistricts: boolean;
}

/** Shared so the store default and the initial mask paint cannot drift apart. */
export const DEFAULT_MASK_OPACITY = 0.7;

export interface NetworkAnalytics {
  substationCount: number;
  lineCount: number;
  tapCount: number;
  installedMva: number;
  totalLineKm: number;
  avgLoading: number | null;
  isolatedCount: number;
  oldestYear: number | null;
}

export const VOLTAGE_CATALOG: VoltageLevel[] = [
  { id: 'v-400', code: '400', label: '400 kV', kvPrimary: 400, color: '#dc2626', sortOrder: 1 },
  { id: 'v-220', code: '220', label: '220 kV', kvPrimary: 220, color: '#d97706', sortOrder: 2 },
  { id: 'v-132', code: '132', label: '132 kV', kvPrimary: 132, color: '#16a34a', sortOrder: 3 },
  { id: 'v-66', code: '66', label: '66 kV', kvPrimary: 66, color: '#7c3aed', sortOrder: 4 },
  { id: 'v-33', code: '33', label: '33 kV', kvPrimary: 33, color: '#2563eb', sortOrder: 5 },
];

export const DEFAULT_ORG: OrgUnit[] = [
  { id: 'org-mzo', parentId: null, type: 'zone', name: 'Malda Zone', code: 'MZO' },
  { id: 'org-mld', parentId: 'org-mzo', type: 'division', name: 'Malda', code: 'MLD' },
  { id: 'org-rgj', parentId: 'org-mzo', type: 'division', name: 'Raiganj', code: 'RGJ' },
  { id: 'org-blg', parentId: 'org-mzo', type: 'division', name: 'Balurghat', code: 'BLG' },
  { id: 'org-bnp', parentId: 'org-mzo', type: 'division', name: 'Buniadpur', code: 'BNP' },
  { id: 'org-gzl', parentId: 'org-mzo', type: 'division', name: 'Gazole', code: 'GZL' },
  { id: 'org-isl', parentId: 'org-mzo', type: 'division', name: 'Islampur', code: 'ISL' },
  { id: 'org-chc', parentId: 'org-mzo', type: 'division', name: 'Chanchal', code: 'CHC' },
];
