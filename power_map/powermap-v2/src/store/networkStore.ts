import { create } from 'zustand';
import { DEFAULT_MASK_OPACITY } from '@/domain/types';
import type {
  AssetLifecycle,
  MapLayerSettings,
  NetworkFilters,
  OrgUnit,
  Selection,
  Substation,
  TapLateral,
  TapNode,
  ToolMode,
  TrunkLine,
  VoltageCode,
} from '@/domain/types';
import { haversineKm, isOldAsset, isOverloaded } from '@/domain/geo';
import {
  authorizeEditor as authorizeEditorRemote,
  listEditors,
  listPendingSuggestions,
  reviewSuggestion,
  revokeEditor as revokeEditorRemote,
  verifyEditorLogin,
  type EditSuggestion,
  type EditorAccount,
} from '@/lib/editorsRepo';
import {
  ALL_VOLTAGES,
  type VoltageFocus,
} from '@/lib/voltageFocus';
import {
  buildScopeBadgeLabel,
  printPatchFromScope,
  sceneById,
  type SceneId,
} from '@/lib/mapScope';
import {
  boundsGeoAspect,
  suggestPrintLayout,
} from '@/lib/printSuggest';
import {
  DEFAULT_PRINT_SETTINGS,
  buildPrintAssets,
  printSheetTitle,
  type PrintSettings,
} from '@/lib/printLayout';
import {
  deletePersonalDraft,
  draftId,
  isDraftStale,
  listPersonalDrafts,
  putPersonalDraft,
  type PersonalDraft,
} from '@/lib/personalDrafts';
import {
  canEditorTouchLine,
  canEditorTouchSubstation,
  resolveEditableSubstationIds,
} from '@/lib/editorScope';
import {
  analyze33KvSiting,
  SITING_DISTRICTS,
  type SitingAnalysis,
} from '@/lib/sitingSuggestions';
import {
  analyzeVoltageCheck,
  type VoltageCheckAnalysis,
  type VoltageCheckCell,
} from '@/lib/voltageCheck';
import {
  computeAnalytics,
  createLine,
  createSubstation,
  createTapLateral,
  createTapOnLine,
  linesConnectedTo,
  loadNetwork,
  emptyNetwork,
  persistLine,
  persistSubstation,
  persistTapLateral,
  persistTapNode,
  persistSubstationBundle,
  probeSupabaseBridge,
  pushNetworkToSupabase,
  removeEntity,
  reprojectTapsForLine,
  tapsOnLine,
} from '@/lib/networkRepo';

export type AdminRole = 'super' | 'editor' | null;

/**
 * Edit rights resolved from the host portal's session rather than the map's own
 * PIN prompt. The host fetches this (GET /api/powermap/me) and injects it via
 * `applyPortalIdentity`; standalone builds simply never call it and keep the PIN.
 */
export interface PortalIdentity {
  username: string;
  name: string;
  role: AdminRole;
  allowedSubstationIds: string[];
  allowedDistricts: string[];
  /** Editor with no scope row — the portal grant covers the whole network. */
  unrestricted: boolean;
}

/** Portal accounts a super admin can attach an edit scope to. */
export interface PortalUserOption {
  username: string;
  name: string;
}

interface DraftConnect {
  fromId: string | null;
}

interface DraftTap {
  sourceLineId: string | null;
  sourceTapId: string | null;
  sourceLat: number | null;
  sourceLng: number | null;
}

interface PlaceDraft {
  lat: number;
  lng: number;
}

interface UiState {
  tool: ToolMode;
  selection: Selection | null;
  panel:
    | 'properties'
    | 'filters'
    | 'layers'
    | 'reports'
    | 'settings'
    | 'place-ss'
    | 'siting'
    | 'voltage-check'
    | 'print'
    | null;
  searchOpen: boolean;
  searchQuery: string;
  statusMessage: string | null;
  connectDraft: DraftConnect;
  tapDraft: DraftTap;
  pendingDelete: Selection | null;
  /** Draft position while placing a new substation */
  placeDraft: PlaceDraft | null;
  /** Live cursor coords while Add SS is active */
  hoverCoords: PlaceDraft | null;
  /** Request map to fly to these coords (lat/lng entry) */
  mapFocus: PlaceDraft | null;
  /** Bumped to ask MapView to fit the default zone (reset home). */
  mapHomeNonce: number;
  /** User-dragged district name positions (persisted locally). */
  districtLabelPositions: Record<string, { lat: number; lng: number }>;
}

interface NetworkStore extends UiState {
  loaded: boolean;
  backend: 'local' | 'supabase';
  adminMode: boolean;
  adminRole: AdminRole;
  adminName: string | null;
  /** Logged-in editor account (scope); null for super / viewer */
  editorAccount: EditorAccount | null;
  /** Resolved SS ids this editor may edit (explicit + districts) */
  editableSsIds: string[];
  /** Host portal supplied identity — hides the standalone name + PIN unlock. */
  portalManaged: boolean;
  portalIdentity: PortalIdentity | null;
  /** Editor whose portal grant is not narrowed by a scope row. */
  editorUnrestricted: boolean;
  /** Portal accounts available to scope, injected by the host. */
  portalUsers: PortalUserOption[];
  editors: EditorAccount[];
  /** Pending suggestions (super admin map + review) */
  suggestions: EditSuggestion[];
  showSuggestionsOnMap: boolean;
  /** Suggestion highlighted from the side-panel list */
  focusedSuggestionId: string | null;
  /** On-device personal drafts for the current editor (never live / never cloud). */
  personalDrafts: PersonalDraft[];
  showPersonalDraftsOnMap: boolean;
  focusedPersonalDraftId: string | null;
  /** Live map-edit hint (snap target, distance) for status bar */
  editCursorHint: string | null;
  /** 33 kV spacing-based siting analysis */
  sitingAnalysis: SitingAnalysis | null;
  sitingBusy: boolean;
  showSitingOnMap: boolean;
  focusedSitingId: string | null;
  /** Quiet / focused map while the siting panel is open */
  sitingActive: boolean;
  sitingLayerStash: MapLayerSettings | null;
  sitingBasemap: 'google' | 'none';
  /** When true, proposed 33 kV SS are left out of siting / voltage-check distance. */
  assessExcludeProposed33: boolean;
  /** When true, proposed 132 kV SS are left out of far-from-132 assessment. */
  assessExcludeProposed132: boolean;
  /** Inspection: far-from-33 kV distance wash */
  voltageCheckAnalysis: VoltageCheckAnalysis | null;
  voltageCheckBusy: boolean;
  showVoltageCheckOnMap: boolean;
  voltageCheckActive: boolean;
  /** Map layers before entering voltage-check inspection */
  voltageCheckLayerStash: MapLayerSettings | null;
  /** Side list (hotspots + map clicks) */
  voltageCheckList: VoltageCheckCell[];
  focusedVoltageCheckId: string | null;
  /** Districts included in the next / last voltage check */
  voltageCheckDistricts: string[];
  /** Manual cut-off km; null = auto from 33 kV spacing */
  voltageCheckCutOffKm: number | null;
  /** Preferred basemap while voltage-check is active */
  voltageCheckBasemap: 'google' | 'none';
  printSettings: PrintSettings;
  printPreviewOpen: boolean;
  printLayoutHint: string;
  substations: Substation[];
  lines: TrunkLine[];
  tapNodes: TapNode[];
  tapLaterals: TapLateral[];
  orgUnits: OrgUnit[];
  filters: NetworkFilters;
  mapLayers: MapLayerSettings;
  /** Active scene preset; `custom` after manual filter/layer edits. */
  sceneId: SceneId;
  /** Dim non-focused voltage classes while keeping them on the map. */
  voltageFocus: VoltageFocus;
  availableDistricts: string[];
  /** Live dump stamp (NSC-style). Empty until first successful stamp/fetch. */
  networkVersion: string | null;
  /** True when the last load reused IndexedDB because the stamp matched. */
  networkCacheHit: boolean;

  bootstrap: () => Promise<void>;
  reloadFromSupabase: () => Promise<void>;
  pushToSupabase: () => Promise<void>;
  checkSupabase: () => Promise<void>;
  unlockAdmin: (pin: string, name?: string) => Promise<boolean>;
  applyPortalIdentity: (identity: PortalIdentity | null) => Promise<void>;
  resumePortalEditing: () => Promise<void>;
  setPortalUsers: (users: PortalUserOption[]) => void;
  lockAdmin: () => void;
  requireAdmin: () => boolean;
  requireSuperAdmin: () => boolean;
  refreshEditors: () => Promise<void>;
  refreshSuggestions: () => Promise<void>;
  authorizeEditor: (
    portalUsername: string,
    scope: { allowedSubstationIds: string[]; allowedDistricts: string[] },
  ) => Promise<boolean>;
  revokeEditor: (id: string) => Promise<void>;
  setShowSuggestionsOnMap: (on: boolean) => void;
  focusSuggestion: (id: string | null) => void;
  refreshPersonalDrafts: () => Promise<void>;
  savePersonalDraftBundle: (
    ss: Substation,
    relatedLines: TrunkLine[],
    comment: string,
  ) => Promise<{ ok: boolean; message: string }>;
  savePersonalDraftLine: (
    line: TrunkLine,
    comment: string,
  ) => Promise<{ ok: boolean; message: string }>;
  discardPersonalDraft: (id: string) => Promise<void>;
  focusPersonalDraft: (id: string | null) => void;
  setShowPersonalDraftsOnMap: (on: boolean) => void;
  personalDraftForAsset: (
    kind: 'substation' | 'line',
    assetId: string,
  ) => PersonalDraft | undefined;
  setEditCursorHint: (hint: string | null) => void;
  runSitingAnalysis: () => Promise<void>;
  clearSitingAnalysis: () => void;
  setShowSitingOnMap: (on: boolean) => void;
  focusSitingCandidate: (id: string | null) => void;
  adoptSitingCandidate: (id: string) => void;
  enterSiting: () => void;
  exitSiting: () => void;
  setSitingBasemap: (basemap: 'google' | 'none') => void;
  setAssessExcludeProposed33: (on: boolean) => void;
  setAssessExcludeProposed132: (on: boolean) => void;
  enterVoltageCheck: () => void;
  exitVoltageCheck: () => void;
  runVoltageCheckAnalysis: () => Promise<void>;
  clearVoltageCheckAnalysis: () => void;
  setShowVoltageCheckOnMap: (on: boolean) => void;
  focusVoltageCheckCell: (id: string | null) => void;
  addVoltageCheckHit: (cell: VoltageCheckCell) => void;
  setVoltageCheckDistricts: (names: string[]) => void;
  toggleVoltageCheckDistrict: (name: string) => void;
  setVoltageCheckCutOffKm: (km: number | null) => void;
  setVoltageCheckBasemap: (basemap: 'google' | 'none') => void;
  setPrintSettings: (patch: Partial<PrintSettings>) => void;
  setPrintPreviewOpen: (open: boolean) => void;
  applyScene: (id: Exclude<SceneId, 'custom'>) => void;
  setVoltageFocus: (focus: VoltageFocus) => void;
  /** Exit inspection modes, clear overlays, restore Overview scene + default zone view. */
  resetMapView: () => void;
  setDistrictLabelPosition: (name: string, lat: number, lng: number) => void;
  resetDistrictLabelPositions: () => void;
  syncPrintFromScope: () => void;
  applySuggestedPrintLayout: (force?: boolean) => Promise<void>;
  scopeBadgeLabel: () => string;
  approveSuggestion: (id: string) => Promise<void>;
  rejectSuggestion: (id: string) => Promise<void>;
  editorCanEditSs: (ssId: string) => boolean;
  editorCanEditLine: (lineId: string) => boolean;
  setTool: (tool: ToolMode) => void;
  setSelection: (sel: Selection | null) => void;
  setPanel: (panel: UiState['panel']) => void;
  setSearchOpen: (open: boolean) => void;
  setSearchQuery: (q: string) => void;
  flashStatus: (msg: string) => void;
  setFilters: (patch: Partial<NetworkFilters>) => void;
  setMapLayers: (patch: Partial<MapLayerSettings>) => void;
  setAvailableDistricts: (names: string[]) => void;
  toggleDistrictFocus: (name: string, additive?: boolean) => void;
  clearDistrictFocus: () => void;
  dimAllDistricts: () => void;
  focusOnlyDistrict: (name: string) => void;

  setPlaceDraft: (draft: PlaceDraft | null) => void;
  setHoverCoords: (coords: PlaceDraft | null) => void;
  setMapFocus: (coords: PlaceDraft | null) => void;
  applyLatLngInput: (lat: number, lng: number) => void;
  confirmPlaceSubstation: () => Promise<void>;
  addSubstationAt: (lat: number, lng: number) => Promise<void>;
  updateSubstation: (id: string, patch: Partial<Substation>) => Promise<void>;
  moveSubstation: (id: string, lat: number, lng: number) => Promise<void>;

  beginConnect: (ssId: string) => void;
  completeConnect: (toId: string) => Promise<void>;
  cancelDrafts: () => void;

  beginTapOnLine: (lineId: string, lat: number, lng: number) => void;
  completeTapToSubstation: (ssId: string) => Promise<void>;
  completeTapToLine: (lineId: string, lat: number, lng: number) => Promise<void>;

  updateLine: (id: string, patch: Partial<TrunkLine>) => Promise<void>;
  updateTapLateral: (id: string, patch: Partial<TapLateral>) => Promise<void>;
  saveSubstationBundle: (
    ss: Substation,
    relatedLines: TrunkLine[],
  ) => Promise<{ ok: boolean; message: string }>;

  requestDelete: (sel: Selection) => void;
  confirmDelete: () => Promise<void>;
  cancelDelete: () => void;

  visibleSubstations: () => Substation[];
  visibleLines: () => TrunkLine[];
  analytics: () => ReturnType<typeof computeAnalytics>;
}

const defaultFilters: NetworkFilters = {
  statuses: ['existing', 'proposed'],
  voltages: ['400', '220', '132', '66', '33'],
  orgUnitIds: [],
  overloadedOnly: false,
  oldOnly: false,
  needUpgradeOnly: false,
  showProposed: true,
};

const defaultMapLayers: MapLayerSettings = {
  // Open on a plain canvas: the district and block outlines are the reference,
  // so tiles only add noise until the user picks one.
  basemap: 'none',
  showMask: true,
  maskOpacity: DEFAULT_MASK_OPACITY,
  showDistricts: true,
  showDistrictLabels: true,
  showBlocks: true,
  showBlockLabels: true,
  showSsNames: false,
  showSsCapacity: false,
  showFeederNames: false,
  showFeederLength: false,
  focusedDistricts: [],
  dimAllDistricts: false,
};

const ADMIN_SESSION_KEY = 'powermap.adminSession';
const DISTRICT_LABEL_POS_KEY = 'powermap.districtLabelPositions';
const MUTATING_TOOLS: ToolMode[] = ['add-ss', 'connect', 'tap', 'move', 'delete'];

interface AdminSession {
  role: 'super' | 'editor';
  name: string;
  editorId?: string;
}

type DistrictLabelPos = Record<string, { lat: number; lng: number }>;

function readDistrictLabelPositions(): DistrictLabelPos {
  try {
    const raw = localStorage.getItem(DISTRICT_LABEL_POS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as DistrictLabelPos;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: DistrictLabelPos = {};
    for (const [name, pos] of Object.entries(parsed)) {
      if (
        pos &&
        typeof pos.lat === 'number' &&
        typeof pos.lng === 'number' &&
        Number.isFinite(pos.lat) &&
        Number.isFinite(pos.lng)
      ) {
        out[name] = { lat: pos.lat, lng: pos.lng };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeDistrictLabelPositions(positions: DistrictLabelPos) {
  try {
    if (Object.keys(positions).length === 0) localStorage.removeItem(DISTRICT_LABEL_POS_KEY);
    else localStorage.setItem(DISTRICT_LABEL_POS_KEY, JSON.stringify(positions));
  } catch {
    /* ignore */
  }
}

function readAdminSession(): AdminSession | null {
  try {
    const raw = sessionStorage.getItem(ADMIN_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AdminSession;
    if (parsed?.role === 'super' || parsed?.role === 'editor') return parsed;
    return null;
  } catch {
    return null;
  }
}

function writeAdminSession(session: AdminSession | null) {
  try {
    if (session) sessionStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(ADMIN_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

function expectedAdminPin(): string {
  return (import.meta.env.VITE_ADMIN_PIN as string | undefined)?.trim() || 'powermap';
}

const initialSession = readAdminSession();

export const useNetworkStore = create<NetworkStore>((set, get) => ({
  loaded: false,
  backend: 'local',
  adminMode: !!initialSession,
  adminRole: initialSession?.role ?? null,
  adminName: initialSession?.name ?? null,
  editorAccount: null,
  editableSsIds: [],
  portalManaged: false,
  portalIdentity: null,
  editorUnrestricted: false,
  portalUsers: [],
  editors: [],
  suggestions: [],
  showSuggestionsOnMap: true,
  focusedSuggestionId: null,
  personalDrafts: [],
  showPersonalDraftsOnMap: true,
  focusedPersonalDraftId: null,
  editCursorHint: null,
  sitingAnalysis: null,
  sitingBusy: false,
  showSitingOnMap: true,
  focusedSitingId: null,
  sitingActive: false,
  sitingLayerStash: null,
  sitingBasemap: 'google',
  assessExcludeProposed33: true,
  assessExcludeProposed132: true,
  voltageCheckAnalysis: null,
  voltageCheckBusy: false,
  showVoltageCheckOnMap: true,
  voltageCheckActive: false,
  voltageCheckLayerStash: null,
  voltageCheckList: [],
  focusedVoltageCheckId: null,
  voltageCheckDistricts: [...SITING_DISTRICTS],
  voltageCheckCutOffKm: null,
  voltageCheckBasemap: 'google',
  printSettings: { ...DEFAULT_PRINT_SETTINGS },
  printPreviewOpen: false,
  printLayoutHint: '',
  sceneId: 'overview',
  voltageFocus: 'all',
  substations: [],
  lines: [],
  tapNodes: [],
  tapLaterals: [],
  orgUnits: [],
  filters: defaultFilters,
  mapLayers: defaultMapLayers,
  availableDistricts: [],
  networkVersion: null,
  networkCacheHit: false,

  tool: 'cursor',
  selection: null,
  panel: null,
  searchOpen: false,
  searchQuery: '',
  statusMessage: null,
  connectDraft: { fromId: null },
  tapDraft: { sourceLineId: null, sourceTapId: null, sourceLat: null, sourceLng: null },
  pendingDelete: null,
  placeDraft: null,
  hoverCoords: null,
  mapFocus: null,
  mapHomeNonce: 0,
  districtLabelPositions: readDistrictLabelPositions(),

  bootstrap: async () => {
    let data;
    try {
      data = await loadNetwork();
    } catch (err) {
      console.error('[PowerMap] bootstrap load failed', err);
      data = { ...emptyNetwork(), loaded: true };
    }
    set({
      loaded: true,
      backend: data.backend,
      substations: data.substations,
      lines: data.lines,
      tapNodes: data.tapNodes,
      tapLaterals: data.tapLaterals,
      orgUnits: data.orgUnits,
      networkVersion: data.networkVersion || null,
      networkCacheHit: Boolean(data.networkCacheHit),
    });
    // When embedded, the host portal owns identity. Re-apply it so an editor's
    // scope resolves against the substations that just loaded, and ignore any
    // stale PIN session left in sessionStorage.
    if (get().portalManaged) {
      await get().applyPortalIdentity(get().portalIdentity);
      return;
    }

    const session = readAdminSession();
    if (session?.role === 'super') {
      set({
        adminMode: true,
        adminRole: 'super',
        adminName: session.name,
        editorAccount: null,
        editableSsIds: [],
      });
      void get().refreshEditors();
      void get().refreshSuggestions();
    } else if (session?.role === 'editor' && session.editorId) {
      const listed = await listEditors();
      const ed = listed.editors.find((e) => e.id === session.editorId);
      if (ed) {
        const editable = await resolveEditableSubstationIds(ed, data.substations);
        set({
          adminMode: true,
          adminRole: 'editor',
          adminName: ed.name,
          editorAccount: ed,
          editableSsIds: [...editable],
        });
      } else {
        writeAdminSession(null);
        set({ adminMode: false, adminRole: null, adminName: null });
      }
    }
  },

  reloadFromSupabase: async () => {
    const data = await loadNetwork({ force: true });
    set({
      backend: data.backend,
      substations: data.substations,
      lines: data.lines,
      tapNodes: data.tapNodes,
      tapLaterals: data.tapLaterals,
      orgUnits: data.orgUnits,
      networkVersion: data.networkVersion || null,
      networkCacheHit: false,
    });
    get().flashStatus(
      data.backend === 'supabase'
        ? `Network refreshed · ${data.substations.length} substations`
        : 'Could not refresh — showing your current copy',
    );
  },

  pushToSupabase: async () => {
    if (!get().requireSuperAdmin()) return;
    const state = get();
    const result = await pushNetworkToSupabase({
      orgUnits: state.orgUnits,
      substations: state.substations,
      lines: state.lines,
      tapNodes: state.tapNodes,
      tapLaterals: state.tapLaterals,
    });
    if (result.ok) {
      set({ backend: 'supabase' });
      await get().reloadFromSupabase();
    }
    get().flashStatus(result.message);
  },

  checkSupabase: async () => {
    const probe = await probeSupabaseBridge();
    get().flashStatus(
      probe.ok
        ? `Connection OK · ${probe.counts?.ss ?? 0} substations / ${probe.counts?.lines ?? 0} lines`
        : 'Connection failed — try again later',
    );
  },

  unlockAdmin: async (pin, name = '') => {
    const trimmedPin = pin.trim();
    if (!trimmedPin) {
      get().flashStatus('Enter your PIN');
      return false;
    }

    if (trimmedPin === expectedAdminPin()) {
      const session: AdminSession = { role: 'super', name: 'Super Admin' };
      writeAdminSession(session);
      set({
        adminMode: true,
        adminRole: 'super',
        adminName: session.name,
        editorAccount: null,
        editableSsIds: [],
      });
      await get().refreshEditors();
      await get().refreshSuggestions();
      get().flashStatus('Unlocked as super admin');
      return true;
    }

    const result = await verifyEditorLogin(name, trimmedPin);
    if (!result.ok || !result.editor) {
      get().flashStatus(result.message || 'Incorrect name or PIN');
      return false;
    }
    const editor = result.editor;
    const editable = await resolveEditableSubstationIds(editor, get().substations);
    writeAdminSession({ role: 'editor', name: editor.name, editorId: editor.id });
    set({
      adminMode: true,
      adminRole: 'editor',
      adminName: editor.name,
      editorAccount: editor,
      editableSsIds: [...editable],
    });
    get().flashStatus(`Unlocked · ${editor.name} · ${editable.size} SS in scope`);
    await get().refreshPersonalDrafts();
    return true;
  },

  applyPortalIdentity: async (identity) => {
    // The portal session is the only source of truth once it is in play.
    writeAdminSession(null);

    if (!identity || !identity.role) {
      set({
        portalManaged: true,
        portalIdentity: identity,
        adminMode: false,
        adminRole: null,
        adminName: identity?.name ?? null,
        editorAccount: null,
        editableSsIds: [],
        editorUnrestricted: false,
        personalDrafts: [],
        focusedPersonalDraftId: null,
      });
      return;
    }

    if (identity.role === 'super') {
      set({
        portalManaged: true,
        portalIdentity: identity,
        adminMode: true,
        adminRole: 'super',
        adminName: identity.name,
        editorAccount: null,
        editableSsIds: [],
        editorUnrestricted: false,
        personalDrafts: [],
        focusedPersonalDraftId: null,
      });
      await get().refreshEditors();
      await get().refreshSuggestions();
      return;
    }

    const account: EditorAccount = {
      id: identity.username,
      name: identity.name,
      portalUsername: identity.username,
      canEdit: true,
      active: true,
      notes: '',
      createdAt: '',
      allowedSubstationIds: identity.allowedSubstationIds,
      allowedDistricts: identity.allowedDistricts,
    };
    const editable = identity.unrestricted
      ? new Set<string>()
      : await resolveEditableSubstationIds(account, get().substations);
    set({
      portalManaged: true,
      portalIdentity: identity,
      adminMode: true,
      adminRole: 'editor',
      adminName: identity.name,
      editorAccount: account,
      editableSsIds: [...editable],
      editorUnrestricted: identity.unrestricted,
    });
    await get().refreshPersonalDrafts();
  },

  resumePortalEditing: async () => {
    const identity = get().portalIdentity;
    if (!identity?.role) return;
    await get().applyPortalIdentity(identity);
    get().flashStatus('Editing enabled');
  },

  setPortalUsers: (portalUsers) => set({ portalUsers }),

  lockAdmin: () => {
    writeAdminSession(null);
    const portalManaged = get().portalManaged;
    set({
      adminMode: false,
      adminRole: null,
      // Keep the portal identity so editing can be resumed without a PIN.
      adminName: portalManaged ? (get().portalIdentity?.name ?? null) : null,
      editorAccount: null,
      editableSsIds: [],
      editorUnrestricted: false,
      personalDrafts: [],
      focusedPersonalDraftId: null,
      tool: 'cursor',
      placeDraft: null,
      connectDraft: { fromId: null },
      tapDraft: { sourceLineId: null, sourceTapId: null, sourceLat: null, sourceLng: null },
    });
    get().flashStatus(
      portalManaged ? 'Editing paused — resume in Settings' : 'Locked — view only',
    );
  },

  requireAdmin: () => {
    if (get().adminMode) return true;
    const { portalManaged, portalIdentity } = get();
    get().flashStatus(
      !portalManaged
        ? 'Unlock in Settings to edit'
        : portalIdentity?.role
          ? 'Editing is paused — resume in Settings'
          : 'Your portal account has no Power Map edit permission',
    );
    set({ panel: 'settings' });
    return false;
  },

  requireSuperAdmin: () => {
    if (get().adminRole === 'super') return true;
    get().flashStatus('Not available for your account');
    return false;
  },

  editorCanEditSs: (ssId) => {
    if (get().adminRole === 'super') return true;
    if (get().adminRole !== 'editor') return false;
    if (get().editorUnrestricted) return true;
    return canEditorTouchSubstation(new Set(get().editableSsIds), ssId);
  },

  editorCanEditLine: (lineId) => {
    if (get().adminRole === 'super') return true;
    if (get().adminRole !== 'editor') return false;
    if (get().editorUnrestricted) return true;
    const line = get().lines.find((l) => l.id === lineId);
    if (!line) return false;
    return canEditorTouchLine(new Set(get().editableSsIds), line);
  },

  refreshEditors: async () => {
    const result = await listEditors();
    if (!result.ok) {
      if (get().adminRole === 'super') {
        get().flashStatus(result.message || 'Could not load editors');
      }
      set({ editors: [] });
      return;
    }
    set({ editors: result.editors });
  },

  refreshSuggestions: async () => {
    const result = await listPendingSuggestions();
    if (!result.ok) {
      set({ suggestions: [] });
      return;
    }
    set({ suggestions: result.suggestions });
  },

  setShowSuggestionsOnMap: (showSuggestionsOnMap) => set({ showSuggestionsOnMap }),

  focusSuggestion: (id) => {
    const sug = id ? get().suggestions.find((s) => s.id === id) : null;
    if (!sug) {
      set({ focusedSuggestionId: null });
      return;
    }
    set({ focusedSuggestionId: sug.id, showSuggestionsOnMap: true });
    if (sug.lat != null && sug.lng != null) {
      set({ mapFocus: { lat: sug.lat, lng: sug.lng } });
    }
    if (sug.assetId && sug.assetKind === 'substation') {
      set({ selection: { kind: 'substation', id: sug.assetId }, panel: 'settings' });
    } else if (sug.assetId && sug.assetKind === 'line') {
      set({ selection: { kind: 'line', id: sug.assetId }, panel: 'settings' });
    } else {
      set({ panel: 'settings' });
    }
    get().flashStatus(`Focused · ${sug.summary}`);
  },

  refreshPersonalDrafts: async () => {
    const username =
      get().portalIdentity?.username ||
      get().editorAccount?.portalUsername ||
      get().editorAccount?.name ||
      get().adminName ||
      '';
    if (!username || get().adminRole !== 'editor') {
      set({ personalDrafts: [], focusedPersonalDraftId: null });
      return;
    }
    const drafts = await listPersonalDrafts(username);
    set({ personalDrafts: drafts });
  },

  personalDraftForAsset: (kind, assetId) => {
    const username =
      get().portalIdentity?.username ||
      get().editorAccount?.portalUsername ||
      get().editorAccount?.name ||
      get().adminName ||
      '';
    if (!username) return undefined;
    const id = draftId(username, kind, assetId);
    return get().personalDrafts.find((d) => d.id === id);
  },

  savePersonalDraftBundle: async (ss, relatedLines, comment) => {
    if (!get().requireAdmin()) return { ok: false, message: 'Unlock required' };
    if (get().adminRole !== 'editor') {
      return { ok: false, message: 'Personal drafts are for authorized editors' };
    }
    if (!get().editorCanEditSs(ss.id)) {
      return { ok: false, message: 'This substation is outside your authorized area' };
    }
    for (const line of relatedLines) {
      if (!get().editorCanEditLine(line.id)) {
        return { ok: false, message: `Line “${line.name}” is outside your authorized area` };
      }
    }
    const username =
      get().portalIdentity?.username ||
      get().editorAccount?.portalUsername ||
      get().editorAccount?.name ||
      get().adminName ||
      '';
    if (!username) return { ok: false, message: 'No editor identity for drafts' };

    const note = comment.trim();
    if (!note) return { ok: false, message: 'Add a personal comment before saving the draft' };

    const liveSs = get().substations.find((s) => s.id === ss.id);
    const baseVersions: Record<string, number> = {
      [ss.id]: liveSs?.version ?? ss.version,
    };
    for (const line of relatedLines) {
      const live = get().lines.find((l) => l.id === line.id);
      baseVersions[line.id] = live?.version ?? line.version;
    }

    const draft: PersonalDraft = {
      id: draftId(username, 'substation', ss.id),
      username,
      assetKind: 'substation',
      assetId: ss.id,
      summary: `SS “${ss.name}” + ${relatedLines.length} feeder(s)`,
      comment: note,
      payload: { ss, relatedLines },
      baseVersions,
      lat: ss.lat,
      lng: ss.lng,
      updatedAt: new Date().toISOString(),
    };
    await putPersonalDraft(draft);
    await get().refreshPersonalDrafts();
    set({ showPersonalDraftsOnMap: true, focusedPersonalDraftId: draft.id });
    return {
      ok: true,
      message: 'Saved on this device only — not on the live map',
    };
  },

  savePersonalDraftLine: async (line, comment) => {
    if (!get().requireAdmin()) return { ok: false, message: 'Unlock required' };
    if (get().adminRole !== 'editor') {
      return { ok: false, message: 'Personal drafts are for authorized editors' };
    }
    if (!get().editorCanEditLine(line.id)) {
      return { ok: false, message: 'This feeder is outside your authorized area' };
    }
    const username =
      get().portalIdentity?.username ||
      get().editorAccount?.portalUsername ||
      get().editorAccount?.name ||
      get().adminName ||
      '';
    if (!username) return { ok: false, message: 'No editor identity for drafts' };
    const note = comment.trim();
    if (!note) return { ok: false, message: 'Add a personal comment before saving the draft' };

    const live = get().lines.find((l) => l.id === line.id);
    const from = get().substations.find((s) => s.id === line.fromId);
    const draft: PersonalDraft = {
      id: draftId(username, 'line', line.id),
      username,
      assetKind: 'line',
      assetId: line.id,
      summary: `Feeder “${line.name}”`,
      comment: note,
      payload: { line },
      baseVersions: { [line.id]: live?.version ?? line.version },
      lat: from?.lat ?? null,
      lng: from?.lng ?? null,
      updatedAt: new Date().toISOString(),
    };
    await putPersonalDraft(draft);
    await get().refreshPersonalDrafts();
    set({ showPersonalDraftsOnMap: true, focusedPersonalDraftId: draft.id });
    return {
      ok: true,
      message: 'Saved on this device only — not on the live map',
    };
  },

  discardPersonalDraft: async (id) => {
    await deletePersonalDraft(id);
    const focused = get().focusedPersonalDraftId === id ? null : get().focusedPersonalDraftId;
    await get().refreshPersonalDrafts();
    set({ focusedPersonalDraftId: focused });
    get().flashStatus('Personal draft discarded');
  },

  focusPersonalDraft: (id) => {
    const draft = id ? get().personalDrafts.find((d) => d.id === id) : null;
    if (!draft) {
      set({ focusedPersonalDraftId: null });
      return;
    }
    set({
      focusedPersonalDraftId: draft.id,
      showPersonalDraftsOnMap: true,
    });
    if (draft.lat != null && draft.lng != null) {
      set({ mapFocus: { lat: draft.lat, lng: draft.lng } });
    }
    if (draft.assetKind === 'substation') {
      set({ selection: { kind: 'substation', id: draft.assetId }, panel: 'properties' });
    } else {
      set({ selection: { kind: 'line', id: draft.assetId }, panel: 'properties' });
    }
    const stale = isDraftStale(draft, {
      substations: get().substations,
      lines: get().lines,
    });
    get().flashStatus(
      stale.stale
        ? `Draft · live map changed — review carefully`
        : `Draft · ${draft.summary}`,
    );
  },

  setShowPersonalDraftsOnMap: (showPersonalDraftsOnMap) => set({ showPersonalDraftsOnMap }),

  setEditCursorHint: (editCursorHint) => set({ editCursorHint }),

  runSitingAnalysis: async () => {
    get().enterSiting();
    set({ sitingBusy: true, panel: 'siting' });
    try {
      const analysis = await analyze33KvSiting(get().substations, {
        excludeProposed33: get().assessExcludeProposed33,
      });
      set({
        sitingAnalysis: analysis,
        focusedSitingId: null,
        showSitingOnMap: true,
        sitingActive: true,
        panel: 'siting',
      });
      if (analysis.message) {
        get().flashStatus(analysis.message);
      } else {
        get().flashStatus(
          `${analysis.candidates.length} candidate site(s) · typical spacing ${analysis.targetSpacingKm.toFixed(1)} km`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Siting analysis failed';
      get().flashStatus(msg);
      set({ sitingAnalysis: null });
    } finally {
      set({ sitingBusy: false });
    }
  },

  clearSitingAnalysis: () =>
    set({ sitingAnalysis: null, focusedSitingId: null }),

  setShowSitingOnMap: (showSitingOnMap) => set({ showSitingOnMap }),

  focusSitingCandidate: (id) => {
    const c = id
      ? get().sitingAnalysis?.candidates.find((x) => x.id === id)
      : null;
    if (!c) {
      set({ focusedSitingId: null });
      return;
    }
    get().enterSiting();
    set({
      focusedSitingId: c.id,
      showSitingOnMap: true,
      mapFocus: { lat: c.lat, lng: c.lng },
      panel: 'siting',
    });
    get().flashStatus(
      `Candidate · ${c.district} · ${c.nearerSs?.length ?? 1} nearby SS (nearest ${c.gapKm.toFixed(1)} km)`,
    );
  },

  adoptSitingCandidate: (id) => {
    const c = get().sitingAnalysis?.candidates.find((x) => x.id === id);
    if (!c) return;
    if (!get().requireAdmin()) return;
    get().exitSiting();
    set({
      focusedSitingId: c.id,
      placeDraft: { lat: c.lat, lng: c.lng },
      tool: 'add-ss',
      panel: 'place-ss',
      mapFocus: { lat: c.lat, lng: c.lng },
    });
    get().flashStatus(`Place draft at candidate · confirm in panel`);
  },

  enterSiting: () => {
    if (get().voltageCheckActive) get().exitVoltageCheck();
    if (get().sitingActive) {
      set({
        showSitingOnMap: true,
        mapLayers: {
          ...get().mapLayers,
          basemap: get().sitingBasemap,
        },
      });
      return;
    }
    const layers = get().mapLayers;
    const basemap = get().sitingBasemap;
    set({
      sitingActive: true,
      sitingLayerStash: { ...layers },
      showSitingOnMap: true,
      mapLayers: {
        ...layers,
        basemap,
        showSsNames: false,
        showSsCapacity: false,
        showFeederNames: false,
        showFeederLength: false,
      },
      sceneId: 'custom',
    });
  },

  exitSiting: () => {
    const stash = get().sitingLayerStash;
    set({
      sitingActive: false,
      sitingLayerStash: null,
      focusedSitingId: null,
      mapLayers: stash ? { ...stash } : get().mapLayers,
      sceneId: stash ? 'custom' : get().sceneId,
    });
  },

  setSitingBasemap: (basemap) => {
    set({ sitingBasemap: basemap });
    if (get().sitingActive || get().panel === 'siting') {
      set({
        mapLayers: { ...get().mapLayers, basemap },
        sceneId: 'custom',
      });
    }
  },

  setAssessExcludeProposed33: (assessExcludeProposed33) => set({ assessExcludeProposed33 }),

  setAssessExcludeProposed132: (assessExcludeProposed132) => set({ assessExcludeProposed132 }),

  enterVoltageCheck: () => {
    if (get().sitingActive) get().exitSiting();
    if (get().voltageCheckActive) {
      set({
        showVoltageCheckOnMap: true,
        mapLayers: {
          ...get().mapLayers,
          basemap: get().voltageCheckBasemap,
        },
      });
      return;
    }
    const layers = get().mapLayers;
    const basemap = get().voltageCheckBasemap;
    set({
      voltageCheckActive: true,
      voltageCheckLayerStash: { ...layers },
      showVoltageCheckOnMap: true,
      mapLayers: {
        ...layers,
        basemap,
        showSsNames: false,
        showSsCapacity: false,
        showFeederNames: false,
        showFeederLength: false,
      },
      sceneId: 'custom',
    });
  },

  exitVoltageCheck: () => {
    const stash = get().voltageCheckLayerStash;
    set({
      voltageCheckActive: false,
      voltageCheckLayerStash: null,
      focusedVoltageCheckId: null,
      mapLayers: stash ? { ...stash } : get().mapLayers,
      sceneId: stash ? 'custom' : get().sceneId,
    });
  },

  runVoltageCheckAnalysis: async () => {
    get().enterVoltageCheck();
    set({ voltageCheckBusy: true, panel: 'voltage-check' });
    try {
      const analysis = await analyzeVoltageCheck(get().substations, {
        districtNames: get().voltageCheckDistricts,
        cutOffKm: get().voltageCheckCutOffKm,
        excludeProposed33: get().assessExcludeProposed33,
        excludeProposed132: get().assessExcludeProposed132,
      });
      set({
        voltageCheckAnalysis: analysis,
        voltageCheckList: analysis.hotspots,
        focusedVoltageCheckId: null,
        showVoltageCheckOnMap: true,
        voltageCheckActive: true,
        panel: 'voltage-check',
      });
      if (analysis.message) {
        get().flashStatus(analysis.message);
      } else {
        get().flashStatus(
          `${analysis.hotspots.length} far area(s) · cut-off ${analysis.cutOffKm.toFixed(1)} km from 33 kV`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Voltage check failed';
      get().flashStatus(msg);
      set({ voltageCheckAnalysis: null, voltageCheckList: [] });
    } finally {
      set({ voltageCheckBusy: false });
    }
  },

  clearVoltageCheckAnalysis: () => {
    get().exitVoltageCheck();
    set({
      voltageCheckAnalysis: null,
      voltageCheckList: [],
      focusedVoltageCheckId: null,
    });
  },

  setShowVoltageCheckOnMap: (showVoltageCheckOnMap) => set({ showVoltageCheckOnMap }),

  setVoltageCheckDistricts: (names) => {
    const cleaned = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
    set({
      voltageCheckDistricts: cleaned.length ? cleaned : [...SITING_DISTRICTS],
    });
  },

  toggleVoltageCheckDistrict: (name) => {
    const cur = get().voltageCheckDistricts;
    const has = cur.some((d) => d.toLowerCase() === name.toLowerCase());
    if (has) {
      const next = cur.filter((d) => d.toLowerCase() !== name.toLowerCase());
      set({
        voltageCheckDistricts: next.length ? next : cur,
      });
      if (!next.length) {
        get().flashStatus('Keep at least one district selected');
      }
    } else {
      set({ voltageCheckDistricts: [...cur, name] });
    }
  },

  setVoltageCheckCutOffKm: (km) => {
    if (km == null || !Number.isFinite(km) || km <= 0) {
      set({ voltageCheckCutOffKm: null });
      return;
    }
    set({ voltageCheckCutOffKm: Math.min(80, Math.max(1, km)) });
  },

  setVoltageCheckBasemap: (basemap) => {
    set({ voltageCheckBasemap: basemap });
    if (get().voltageCheckActive || get().panel === 'voltage-check') {
      set({
        mapLayers: { ...get().mapLayers, basemap },
        sceneId: 'custom',
      });
    }
  },

  focusVoltageCheckCell: (id) => {
    const list = get().voltageCheckList;
    const fromList = id ? list.find((x) => x.id === id) : null;
    const fromCells = id
      ? get().voltageCheckAnalysis?.cells.find((x) => x.id === id)
      : null;
    const c = fromList ?? fromCells ?? null;
    if (!c) {
      set({ focusedVoltageCheckId: null });
      return;
    }
    get().enterVoltageCheck();
    set({
      focusedVoltageCheckId: c.id,
      showVoltageCheckOnMap: true,
      mapFocus: { lat: c.lat, lng: c.lng },
      panel: 'voltage-check',
    });
    get().flashStatus(
      `${c.district} · ${c.nearest33Name} · ${c.dist33Km.toFixed(1)} km`,
    );
  },

  addVoltageCheckHit: (cell) => {
    const list = get().voltageCheckList;
    const exists = list.some((x) => x.id === cell.id);
    set({
      voltageCheckList: exists ? list : [cell, ...list],
      focusedVoltageCheckId: cell.id,
      showVoltageCheckOnMap: true,
      panel: 'voltage-check',
    });
  },

  setPrintSettings: (patch) =>
    set({ printSettings: { ...get().printSettings, ...patch } }),

  applySuggestedPrintLayout: async (force = false) => {
    const settings = get().printSettings;
    if (settings.layoutLocked && !force) return;
    const bundle = await buildPrintAssets(
      get().substations,
      get().lines,
      settings.districts,
      {
        includeProposed: settings.showProposed,
        tapNodes: get().tapNodes,
        tapLaterals: get().tapLaterals,
      },
    );
    const metrics = {
      bounds: bundle.bounds,
      geoAspect: boundsGeoAspect(bundle.bounds),
      districtCount: settings.districts.length || bundle.districtNames.length,
      ssCount: bundle.inDistrictIds.length,
    };
    const suggestion = suggestPrintLayout(metrics, settings.displayPurpose, {
      showSsList: settings.showSsList,
    });
    set({
      printSettings: {
        ...settings,
        paperId: suggestion.paperId,
        orientation: suggestion.orientation,
        customWidthMm: suggestion.customWidthMm,
        customHeightMm: suggestion.customHeightMm,
        previewDpi: suggestion.previewDpi,
        layoutLocked: false,
      },
      printLayoutHint: suggestion.hint,
    });
  },

  setPrintPreviewOpen: (printPreviewOpen) => set({ printPreviewOpen }),

  applyScene: (id) => {
    if (id === 'proposed') {
      set({ voltageFocus: 'proposed', sceneId: 'custom' });
      get().flashStatus('Proposed · existing network dimmed');
      return;
    }
    const scene = sceneById(id);
    if (!scene) return;
    const prev = get().mapLayers;
    const nextLayers: MapLayerSettings = {
      ...prev,
      ...scene.mapLayers,
    };
    // District-focus keeps the user's current undimmed set.
    if (id === 'district-focus') {
      nextLayers.focusedDistricts = prev.focusedDistricts;
      nextLayers.dimAllDistricts = prev.dimAllDistricts;
    }
    let voltageFocus: VoltageFocus = get().voltageFocus;
    let nextFilters = { ...get().filters, ...scene.filters };
    if (id === 'overview') voltageFocus = 'all';
    else if (id === 'ehv' || id === 'local-33') {
      voltageFocus = id === 'ehv' ? 'ehv' : '33';
      nextFilters = { ...nextFilters, voltages: [...ALL_VOLTAGES] };
    }
    set({
      sceneId: id,
      filters: nextFilters,
      mapLayers: nextLayers,
      voltageFocus,
    });
    if (scene.syncPrint) get().syncPrintFromScope();
    if (id === 'district-focus' && !nextLayers.focusedDistricts.length && !nextLayers.dimAllDistricts) {
      get().flashStatus('District focus · click a district to undim');
    } else {
      get().flashStatus(`Scene · ${scene.label}`);
    }
  },

  setVoltageFocus: (focus) => {
    const prev = get();
    const patch: {
      voltageFocus: VoltageFocus;
      sceneId: SceneId;
      filters?: NetworkFilters;
    } = { voltageFocus: focus, sceneId: 'custom' };
    if (focus === 'ehv' || focus === '33') {
      patch.filters = { ...prev.filters, voltages: [...ALL_VOLTAGES] };
    } else if (
      focus !== 'proposed' &&
      prev.voltageFocus === 'proposed' &&
      prev.filters.statuses.length === 1 &&
      prev.filters.statuses[0] === 'proposed'
    ) {
      patch.filters = {
        ...prev.filters,
        statuses: ['existing', 'proposed'],
        showProposed: true,
      };
    }
    set(patch);
  },

  resetMapView: () => {
    if (get().sitingActive) get().exitSiting();
    if (get().voltageCheckActive) get().exitVoltageCheck();
    const scene = sceneById('overview');
    if (!scene) return;
    set({
      panel: null,
      tool: 'cursor',
      selection: null,
      placeDraft: null,
      hoverCoords: null,
      mapFocus: null,
      connectDraft: { fromId: null },
      tapDraft: { sourceLineId: null, sourceTapId: null, sourceLat: null, sourceLng: null },
      pendingDelete: null,
      editCursorHint: null,
      sitingAnalysis: null,
      focusedSitingId: null,
      showSitingOnMap: true,
      sitingActive: false,
      sitingLayerStash: null,
      voltageCheckAnalysis: null,
      voltageCheckList: [],
      focusedVoltageCheckId: null,
      showVoltageCheckOnMap: true,
      voltageCheckActive: false,
      voltageCheckLayerStash: null,
      focusedSuggestionId: null,
      focusedPersonalDraftId: null,
      printPreviewOpen: false,
      sceneId: 'overview',
      voltageFocus: 'all',
      filters: { ...defaultFilters, ...scene.filters },
      mapLayers: { ...defaultMapLayers, ...scene.mapLayers },
      mapHomeNonce: get().mapHomeNonce + 1,
      districtLabelPositions: {},
    });
    writeDistrictLabelPositions({});
    get().flashStatus('Map reset to default look');
  },

  setDistrictLabelPosition: (name, lat, lng) => {
    const next = {
      ...get().districtLabelPositions,
      [name]: { lat, lng },
    };
    writeDistrictLabelPositions(next);
    set({ districtLabelPositions: next });
  },

  resetDistrictLabelPositions: () => {
    writeDistrictLabelPositions({});
    set({ districtLabelPositions: {} });
    get().flashStatus('District labels reset');
  },

  syncPrintFromScope: () => {
    const patch = printPatchFromScope({
      filters: get().filters,
      mapLayers: get().mapLayers,
    });
    const prev = get().printSettings;
    const autoTitle = printSheetTitle(
      { title: '', districts: patch.districts },
      patch.districts,
    );
    set({
      printSettings: {
        ...prev,
        ...patch,
        title: prev.title.trim() ? prev.title : autoTitle,
        subtitle: '',
        layoutLocked: false,
      },
    });
    void get().applySuggestedPrintLayout(true);
    get().flashStatus(
      patch.districts.length
        ? `Print scope · ${patch.districts.length} district(s)`
        : 'Print scope · full network',
    );
  },

  scopeBadgeLabel: () => {
    const { sceneId, filters, mapLayers } = get();
    return buildScopeBadgeLabel({
      sceneId,
      filters,
      focusedDistricts: mapLayers.dimAllDistricts ? [] : mapLayers.focusedDistricts,
    });
  },

  authorizeEditor: async (portalUsername, scope) => {
    if (!get().requireSuperAdmin()) return false;
    const username = portalUsername.trim();
    const match = get().portalUsers.find(
      (u) => u.username.toLowerCase() === username.toLowerCase(),
    );
    const result = await authorizeEditorRemote({
      portalUsername: username,
      name: match?.name || username,
      allowedSubstationIds: scope.allowedSubstationIds,
      allowedDistricts: scope.allowedDistricts,
    });
    get().flashStatus(result.message);
    if (result.ok) await get().refreshEditors();
    return result.ok;
  },

  revokeEditor: async (id) => {
    if (!get().requireSuperAdmin()) return;
    const result = await revokeEditorRemote(id);
    get().flashStatus(result.message);
    if (result.ok) await get().refreshEditors();
  },

  approveSuggestion: async (id) => {
    if (!get().requireSuperAdmin()) return;
    const sug = get().suggestions.find((s) => s.id === id);
    if (!sug) return;

    // Mark approved first so nested saveSubstationBundle (super) applies live
    const reviewed = await reviewSuggestion(id, 'approved', get().adminName || 'Super Admin');
    if (!reviewed.ok) {
      get().flashStatus(reviewed.message);
      return;
    }

    if (sug.assetKind === 'substation' && sug.payload.ss) {
      const nextSs = sug.payload.ss as Substation;
      const related = (sug.payload.relatedLines as TrunkLine[] | undefined) ?? [];
      const apply = await get().saveSubstationBundle(
        nextSs,
        related.length ? related : linesConnectedTo(nextSs.id, get().lines),
      );
      get().flashStatus(apply.ok ? 'Suggestion approved & applied' : apply.message);
    } else if (sug.assetKind === 'line' && sug.payload.line) {
      const line = sug.payload.line as TrunkLine;
      const { id: _id, ...patch } = line;
      await get().updateLine(line.id, patch);
      get().flashStatus('Suggestion approved & applied');
    } else {
      get().flashStatus(reviewed.message);
    }
    await get().refreshSuggestions();
  },

  rejectSuggestion: async (id) => {
    if (!get().requireSuperAdmin()) return;
    const result = await reviewSuggestion(id, 'rejected', get().adminName || 'Super Admin');
    get().flashStatus(result.message);
    await get().refreshSuggestions();
  },

  setTool: (tool) => {
    if (MUTATING_TOOLS.includes(tool) && !get().adminMode) {
      get().requireAdmin();
      return;
    }
    set({
      tool,
      connectDraft: { fromId: null },
      tapDraft: { sourceLineId: null, sourceTapId: null, sourceLat: null, sourceLng: null },
      placeDraft: tool === 'add-ss' ? get().placeDraft : null,
      hoverCoords: null,
      editCursorHint: null,
      focusedSuggestionId: null,
      panel:
        tool === 'add-ss'
          ? 'place-ss'
          : tool === 'cursor'
            ? get().panel
            : get().panel === 'place-ss'
              ? null
              : get().panel,
    });
  },

  setSelection: (selection) =>
    set({
      selection,
      panel: selection ? 'properties' : get().panel === 'properties' ? null : get().panel,
    }),

  setPanel: (panel) => {
    const prev = get().panel;
    if (prev === 'voltage-check' && panel !== 'voltage-check') {
      get().exitVoltageCheck();
    }
    if (prev === 'siting' && panel !== 'siting') {
      get().exitSiting();
    }
    if (panel === 'voltage-check' && prev !== 'voltage-check') {
      get().enterVoltageCheck();
    }
    if (panel === 'siting' && prev !== 'siting') {
      get().enterSiting();
    }
    set({ panel });
  },
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),

  flashStatus: (statusMessage) => {
    set({ statusMessage });
    window.setTimeout(() => {
      if (get().statusMessage === statusMessage) set({ statusMessage: null });
    }, 2800);
  },

  setFilters: (patch) =>
    set({ filters: { ...get().filters, ...patch }, sceneId: 'custom' }),

  setMapLayers: (patch) =>
    set({ mapLayers: { ...get().mapLayers, ...patch }, sceneId: 'custom' }),

  setAvailableDistricts: (availableDistricts) => set({ availableDistricts }),

  toggleDistrictFocus: (name, additive = false) => {
    const layers = get().mapLayers;
    const current = layers.dimAllDistricts ? [] : layers.focusedDistricts;
    let next: string[];
    if (!additive) {
      next = current.length === 1 && current[0] === name && !layers.dimAllDistricts ? [] : [name];
    } else if (current.includes(name)) {
      next = current.filter((d) => d !== name);
    } else {
      next = [...current, name];
    }
    set({
      sceneId: 'custom',
      mapLayers: {
        ...get().mapLayers,
        showDistricts: true,
        dimAllDistricts: false,
        focusedDistricts: next,
      },
    });
    get().flashStatus(
      next.length === 0
        ? 'All districts undimmed'
        : next.length === 1
          ? `Focused: ${next[0]}`
          : `Focused: ${next.length} districts`,
    );
  },

  clearDistrictFocus: () => {
    set({
      sceneId: 'custom',
      mapLayers: {
        ...get().mapLayers,
        focusedDistricts: [],
        dimAllDistricts: false,
      },
    });
    get().flashStatus('All districts undimmed');
  },

  dimAllDistricts: () => {
    set({
      sceneId: 'custom',
      mapLayers: {
        ...get().mapLayers,
        showDistricts: true,
        focusedDistricts: [],
        dimAllDistricts: true,
      },
    });
    get().flashStatus('All districts dimmed');
  },

  focusOnlyDistrict: (name) => {
    set({
      sceneId: 'custom',
      mapLayers: {
        ...get().mapLayers,
        showDistricts: true,
        dimAllDistricts: false,
        focusedDistricts: [name],
      },
    });
  },

  setPlaceDraft: (placeDraft) => set({ placeDraft, panel: 'place-ss' }),

  setHoverCoords: (hoverCoords) => set({ hoverCoords }),

  setMapFocus: (mapFocus) => set({ mapFocus }),

  applyLatLngInput: (lat, lng) => {
    set({
      placeDraft: { lat, lng },
      mapFocus: { lat, lng },
      panel: 'place-ss',
      tool: 'add-ss',
    });
    get().flashStatus(`Position set · ${lat.toFixed(6)}, ${lng.toFixed(6)}`);
  },

  confirmPlaceSubstation: async () => {
    if (!get().requireAdmin()) return;
    const draft = get().placeDraft;
    if (!draft) {
      get().flashStatus('Click map or enter lat/lng first');
      return;
    }
    await get().addSubstationAt(draft.lat, draft.lng);
  },

  addSubstationAt: async (lat, lng) => {
    if (!get().requireAdmin()) return;
    const ss = createSubstation({
      name: 'New Substation',
      lat,
      lng,
      voltageCode: '33',
      status: 'proposed',
      orgUnitId: get().orgUnits.find((o) => o.type === 'division')?.id ?? null,
      transformers: [{ id: crypto.randomUUID(), ratingMva: 10, quantity: 1, sequence: 1 }],
    });
    await persistSubstation(ss);
    set({
      substations: [...get().substations, ss],
      selection: { kind: 'substation', id: ss.id },
      panel: 'properties',
      tool: 'cursor',
      placeDraft: null,
      hoverCoords: null,
    });
    get().flashStatus(`Substation created at ${lat.toFixed(6)}, ${lng.toFixed(6)}`);
  },

  updateSubstation: async (id, patch) => {
    if (!get().requireAdmin()) return;
    const substations = get().substations.map((s) =>
      s.id === id ? { ...s, ...patch, updatedAt: new Date().toISOString(), version: s.version + 1 } : s,
    );
    const ss = substations.find((s) => s.id === id)!;
    await persistSubstation(ss);
    set({ substations });
  },

  moveSubstation: async (id, lat, lng) => {
    if (!get().requireAdmin()) return;
    const state = get();
    const substations = state.substations.map((s) =>
      s.id === id ? { ...s, lat, lng, updatedAt: new Date().toISOString() } : s,
    );
    const moved = substations.find((s) => s.id === id)!;
    const lines = state.lines.map((l) => {
      if (l.fromId !== id && l.toId !== id) return l;
      const from = substations.find((s) => s.id === l.fromId)!;
      const to = substations.find((s) => s.id === l.toId)!;
      return {
        ...l,
        lengthKm: haversineKm(from.lat, from.lng, to.lat, to.lng),
      };
    });

    let tapNodes = [...state.tapNodes];
    for (const line of lines.filter((l) => l.fromId === id || l.toId === id)) {
      const from = substations.find((s) => s.id === line.fromId)!;
      const to = substations.find((s) => s.id === line.toId)!;
      const updated = reprojectTapsForLine(line, from, to, tapNodes);
      tapNodes = tapNodes.map((t) => updated.find((u) => u.id === t.id) ?? t);
    }

    await persistSubstation(moved);
    await Promise.all(lines.filter((l) => l.fromId === id || l.toId === id).map(persistLine));
    await Promise.all(tapNodes.map(persistTapNode));

    set({ substations, lines, tapNodes });
  },

  beginConnect: (ssId) => {
    if (!get().requireAdmin()) return;
    const { connectDraft } = get();
    if (!connectDraft.fromId) {
      set({ connectDraft: { fromId: ssId } });
      get().flashStatus('Select target substation');
      return;
    }
    if (connectDraft.fromId === ssId) {
      get().flashStatus('Choose a different substation');
      return;
    }
    void get().completeConnect(ssId);
  },

  completeConnect: async (toId) => {
    if (!get().requireAdmin()) return;
    const { connectDraft, substations, lines } = get();
    if (!connectDraft.fromId) return;
    const from = substations.find((s) => s.id === connectDraft.fromId);
    const to = substations.find((s) => s.id === toId);
    if (!from || !to) return;

    const existingParallel = lines.filter(
      (l) =>
        (l.fromId === from.id && l.toId === to.id) ||
        (l.fromId === to.id && l.toId === from.id),
    );

    const voltageCode: VoltageCode =
      from.voltageCode === to.voltageCode
        ? from.voltageCode
        : ([from.voltageCode, to.voltageCode].sort(
            (a, b) => Number(a) - Number(b),
          )[0] as VoltageCode);

    const line = createLine({
      from,
      to,
      voltageCode,
      status: 'proposed',
      circuitCount: existingParallel.length + 1,
      parallelTotal: existingParallel.length + 1,
      circuitConfig: existingParallel.length > 0 ? 'double' : 'single',
    });

    const nextLines = lines.map((l) => {
      const isSibling = existingParallel.some((s) => s.id === l.id);
      if (!isSibling || l.circuitConfig !== 'single') return l;
      return { ...l, circuitConfig: 'double' as const, version: l.version + 1 };
    });

    await persistLine(line);
    await Promise.all(
      nextLines
        .filter((l) => existingParallel.some((s) => s.id === l.id) && l.circuitConfig === 'double')
        .filter((l) => existingParallel.find((s) => s.id === l.id)?.circuitConfig === 'single')
        .map((l) => persistLine(l)),
    );

    set({
      lines: [...nextLines, line],
      connectDraft: { fromId: null },
      selection: { kind: 'line', id: line.id },
      panel: 'properties',
      tool: 'cursor',
    });
    get().flashStatus(
      existingParallel.length
        ? `Parallel circuit #${line.circuitCount} created`
        : 'Line created',
    );
  },

  cancelDrafts: () =>
    set({
      connectDraft: { fromId: null },
      tapDraft: { sourceLineId: null, sourceTapId: null, sourceLat: null, sourceLng: null },
    }),

  beginTapOnLine: (lineId, lat, lng) => {
    if (!get().requireAdmin()) return;
    const { lines, substations } = get();
    const line = lines.find((l) => l.id === lineId);
    if (!line) return;
    const from = substations.find((s) => s.id === line.fromId);
    const to = substations.find((s) => s.id === line.toId);
    if (!from || !to) return;

    const tap = createTapOnLine(line, from, to, lat, lng);
    void persistTapNode(tap).then(() => {
      set({
        tapNodes: [...get().tapNodes, tap],
        tapDraft: {
          sourceLineId: lineId,
          sourceTapId: tap.id,
          sourceLat: tap.lat,
          sourceLng: tap.lng,
        },
      });
      get().flashStatus('Now click a substation or another line');
    });
  },

  completeTapToSubstation: async (ssId) => {
    if (!get().requireAdmin()) return;
    const { tapDraft, substations, tapLaterals, tapNodes } = get();
    if (!tapDraft.sourceTapId) return;
    const tap = tapNodes.find((t) => t.id === tapDraft.sourceTapId);
    const ss = substations.find((s) => s.id === ssId);
    if (!tap || !ss) return;

    const lateral = createTapLateral({
      fromTap: tap,
      toKind: 'substation',
      toAssetId: ss.id,
      toLat: ss.lat,
      toLng: ss.lng,
      voltageCode: ss.voltageCode,
      status: 'proposed',
      name: `Tap → ${ss.name}`,
    });
    await persistTapLateral(lateral);
    set({
      tapLaterals: [...tapLaterals, lateral],
      tapDraft: { sourceLineId: null, sourceTapId: null, sourceLat: null, sourceLng: null },
      selection: { kind: 'tap_lateral', id: lateral.id },
      panel: 'properties',
      tool: 'cursor',
    });
    get().flashStatus('Tap lateral created');
  },

  completeTapToLine: async (lineId, lat, lng) => {
    if (!get().requireAdmin()) return;
    const { tapDraft, lines, substations, tapNodes, tapLaterals } = get();
    if (!tapDraft.sourceTapId || tapDraft.sourceLineId === lineId) {
      get().flashStatus('Choose a different line');
      return;
    }
    const sourceTap = tapNodes.find((t) => t.id === tapDraft.sourceTapId);
    const line = lines.find((l) => l.id === lineId);
    if (!sourceTap || !line) return;
    const from = substations.find((s) => s.id === line.fromId);
    const to = substations.find((s) => s.id === line.toId);
    if (!from || !to) return;

    const targetTap = createTapOnLine(line, from, to, lat, lng);
    await persistTapNode(targetTap);

    const lateral = createTapLateral({
      fromTap: sourceTap,
      toKind: 'tap_node',
      toAssetId: targetTap.id,
      toLat: targetTap.lat,
      toLng: targetTap.lng,
      voltageCode: line.voltageCode,
      status: 'proposed',
      name: `Tap link ${sourceTap.name} ↔ ${targetTap.name}`,
    });
    await persistTapLateral(lateral);

    set({
      tapNodes: [...get().tapNodes, targetTap],
      tapLaterals: [...tapLaterals, lateral],
      tapDraft: { sourceLineId: null, sourceTapId: null, sourceLat: null, sourceLng: null },
      selection: { kind: 'tap_lateral', id: lateral.id },
      panel: 'properties',
      tool: 'cursor',
    });
    get().flashStatus('Line-to-line tap created');
  },

  updateLine: async (id, patch) => {
    if (!get().requireAdmin()) return;
    if (get().adminRole === 'editor') {
      get().flashStatus('Use Save on the feeder form with a personal comment (device-only draft)');
      return;
    }
    const lines = get().lines.map((l) => (l.id === id ? { ...l, ...patch, version: l.version + 1 } : l));
    const line = lines.find((l) => l.id === id)!;
    await persistLine(line);
    set({ lines });
  },

  updateTapLateral: async (id, patch) => {
    if (!get().requireAdmin()) return;
    const tapLaterals = get().tapLaterals.map((l) => (l.id === id ? { ...l, ...patch } : l));
    const lateral = tapLaterals.find((l) => l.id === id)!;
    await persistTapLateral(lateral);
    set({ tapLaterals });
  },

  saveSubstationBundle: async (ss, relatedLines) => {
    if (!get().requireAdmin()) return { ok: false, message: 'Admin unlock required' };

    // Editors: personal on-device drafts only (promote → suggestion comes later)
    if (get().adminRole === 'editor') {
      return {
        ok: false,
        message: 'Add a personal comment and use “Save to my drafts”',
      };
    }

    const now = new Date().toISOString();
    const nextSs = { ...ss, updatedAt: now, version: ss.version + 1 };
    const relatedIds = new Set(relatedLines.map((l) => l.id));
    const nextRelated = relatedLines.map((l) => ({ ...l, version: l.version + 1 }));
    const lines = get().lines.map((l) => {
      const patched = nextRelated.find((p) => p.id === l.id);
      return patched ?? l;
    });

    // Recompute lengths for lines connected to this SS after coord change
    const withLengths = lines.map((l) => {
      if (!relatedIds.has(l.id) && l.fromId !== ss.id && l.toId !== ss.id) return l;
      if (l.fromId !== ss.id && l.toId !== ss.id) return l;
      const from = l.fromId === ss.id ? nextSs : get().substations.find((s) => s.id === l.fromId);
      const to = l.toId === ss.id ? nextSs : get().substations.find((s) => s.id === l.toId);
      if (!from || !to) return l;
      return {
        ...l,
        lengthKm: haversineKm(from.lat, from.lng, to.lat, to.lng),
      };
    });

    const bundleLines = withLengths.filter((l) => relatedIds.has(l.id));
    const result = await persistSubstationBundle(nextSs, bundleLines);
    if (!result.ok) return { ok: false, message: result.message || 'Save failed' };

    let tapNodes = [...get().tapNodes];
    for (const line of bundleLines) {
      const from = line.fromId === ss.id ? nextSs : get().substations.find((s) => s.id === line.fromId);
      const to = line.toId === ss.id ? nextSs : get().substations.find((s) => s.id === line.toId);
      if (!from || !to) continue;
      const updated = reprojectTapsForLine(line, from, to, tapNodes);
      tapNodes = tapNodes.map((t) => updated.find((u) => u.id === t.id) ?? t);
      await Promise.all(updated.map(persistTapNode));
    }

    set({
      substations: get().substations.map((s) => (s.id === nextSs.id ? nextSs : s)),
      lines: withLengths,
      tapNodes,
    });
    return {
      ok: true,
      message: result.message || 'Saved SS & related lines',
    };
  },

  requestDelete: (sel) => {
    if (!get().requireAdmin()) return;
    if (sel.kind === 'substation') {
      const deps = linesConnectedTo(sel.id, get().lines);
      if (deps.length) {
        set({ pendingDelete: sel });
        return;
      }
    }
    if (sel.kind === 'line') {
      const deps = tapsOnLine(sel.id, get().tapNodes);
      if (deps.length) {
        set({ pendingDelete: sel });
        return;
      }
    }
    set({ pendingDelete: sel });
  },

  confirmDelete: async () => {
    if (!get().requireAdmin()) return;
    const sel = get().pendingDelete;
    if (!sel) return;

    if (sel.kind === 'substation') {
      const lineIds = linesConnectedTo(sel.id, get().lines).map((l) => l.id);
      const tapIds = get().tapNodes.filter((t) => lineIds.includes(t.parentLineId)).map((t) => t.id);
      const lateralIds = get()
        .tapLaterals.filter(
          (l) =>
            tapIds.includes(l.fromTapId) ||
            (l.toKind === 'substation' && l.toAssetId === sel.id) ||
            (l.toKind === 'tap_node' && tapIds.includes(l.toAssetId)),
        )
        .map((l) => l.id);

      await Promise.all([
        ...lateralIds.map((id) => removeEntity('tap_lateral', id)),
        ...tapIds.map((id) => removeEntity('tap_node', id)),
        ...lineIds.map((id) => removeEntity('line', id)),
        removeEntity('substation', sel.id),
      ]);

      set({
        tapLaterals: get().tapLaterals.filter((l) => !lateralIds.includes(l.id)),
        tapNodes: get().tapNodes.filter((t) => !tapIds.includes(t.id)),
        lines: get().lines.filter((l) => !lineIds.includes(l.id)),
        substations: get().substations.filter((s) => s.id !== sel.id),
        selection: null,
        pendingDelete: null,
        panel: null,
      });
      get().flashStatus('Substation and connected network removed');
      return;
    }

    if (sel.kind === 'line') {
      const tapIds = tapsOnLine(sel.id, get().tapNodes).map((t) => t.id);
      const lateralIds = get()
        .tapLaterals.filter((l) => tapIds.includes(l.fromTapId) || (l.toKind === 'tap_node' && tapIds.includes(l.toAssetId)))
        .map((l) => l.id);
      await Promise.all([
        ...lateralIds.map((id) => removeEntity('tap_lateral', id)),
        ...tapIds.map((id) => removeEntity('tap_node', id)),
        removeEntity('line', sel.id),
      ]);
      set({
        tapLaterals: get().tapLaterals.filter((l) => !lateralIds.includes(l.id)),
        tapNodes: get().tapNodes.filter((t) => !tapIds.includes(t.id)),
        lines: get().lines.filter((l) => l.id !== sel.id),
        selection: null,
        pendingDelete: null,
        panel: null,
      });
      get().flashStatus('Line and taps removed');
      return;
    }

    if (sel.kind === 'tap_node') {
      const lateralIds = get()
        .tapLaterals.filter((l) => l.fromTapId === sel.id || (l.toKind === 'tap_node' && l.toAssetId === sel.id))
        .map((l) => l.id);
      await Promise.all([
        ...lateralIds.map((id) => removeEntity('tap_lateral', id)),
        removeEntity('tap_node', sel.id),
      ]);
      set({
        tapLaterals: get().tapLaterals.filter((l) => !lateralIds.includes(l.id)),
        tapNodes: get().tapNodes.filter((t) => t.id !== sel.id),
        selection: null,
        pendingDelete: null,
        panel: null,
      });
      return;
    }

    await removeEntity('tap_lateral', sel.id);
    set({
      tapLaterals: get().tapLaterals.filter((l) => l.id !== sel.id),
      selection: null,
      pendingDelete: null,
      panel: null,
    });
    get().flashStatus('Deleted');
  },

  cancelDelete: () => set({ pendingDelete: null }),

  visibleSubstations: () => {
    const { substations, filters } = get();
    return substations.filter((s) => {
      if (!filters.showProposed && s.status === 'proposed') return false;
      if (!filters.statuses.includes(s.status)) return false;
      if (!filters.voltages.includes(s.voltageCode)) return false;
      if (filters.orgUnitIds.length && s.orgUnitId && !filters.orgUnitIds.includes(s.orgUnitId))
        return false;
      if (filters.overloadedOnly && !isOverloaded(s.loadingPct)) return false;
      if (filters.oldOnly && !isOldAsset(s.commissionYear)) return false;
      if (filters.needUpgradeOnly && !(isOverloaded(s.loadingPct) || isOldAsset(s.commissionYear)))
        return false;
      return true;
    });
  },

  visibleLines: () => {
    const { lines, substations, filters } = get();
    const ssById = new Map(substations.map((s) => [s.id, s]));
    return lines.filter((l) => {
      if (!filters.showProposed && l.status === 'proposed') return false;
      if (!filters.statuses.includes(l.status)) return false;
      if (!filters.voltages.includes(l.voltageCode)) return false;
      // Need both endpoints for geometry, but do NOT hide an existing line
      // just because one end is a proposed SS that is filtered off the map.
      const from = ssById.get(l.fromId);
      const to = ssById.get(l.toId);
      if (!from || !to) return false;
      if (filters.overloadedOnly && !isOverloaded(l.loadingPct)) return false;
      if (filters.oldOnly && !isOldAsset(l.commissionYear)) return false;
      return true;
    });
  },

  analytics: () => {
    const ss = get().visibleSubstations();
    const lines = get().visibleLines();
    const taps = get().tapNodes.filter((t) => lines.some((l) => l.id === t.parentLineId));
    return computeAnalytics(ss, lines, taps);
  },
}));

export type { AssetLifecycle };
