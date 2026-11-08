import { v4 as uuid } from 'uuid';
import {
  DEFAULT_ORG,
  type AssetLifecycle,
  type CircuitConfig,
  type NetworkAnalytics,
  type OrgUnit,
  type Substation,
  type TapLateral,
  type TapNode,
  type TransformerUnit,
  type TrunkLine,
  type VoltageCode,
} from '@/domain/types';
import {
  closestRatioOnSegment,
  defaultLineName,
  haversineKm,
  installedMva,
  pointAlong,
} from '@/domain/geo';
import { idbGetAll, idbPut, idbDelete, idbReplaceAll, idbGetMeta, idbSetMeta } from '@/lib/idb';
import {
  getPowerMapClient,
  getPowerMapTables,
  isPowerMapConfigured,
} from '@/lib/supabase';
import legacyNetwork from '@/data/legacyNetwork.json';

/** Resolve via getters so DRO’s late-bound client (after /api/powermap/config) is seen. */
function pmClient() {
  return getPowerMapClient();
}
function pmReady() {
  return isPowerMapConfigured() && Boolean(getPowerMapClient());
}
function pmTables() {
  return getPowerMapTables();
}

export interface NetworkState {
  substations: Substation[];
  lines: TrunkLine[];
  tapNodes: TapNode[];
  tapLaterals: TapLateral[];
  orgUnits: OrgUnit[];
  backend: 'local' | 'supabase';
  loaded: boolean;
  /** Dump stamp — reused until the live network revision changes (NSC-style). */
  networkVersion?: string;
  /** True when this paint came from IndexedDB because the stamp matched. */
  networkCacheHit?: boolean;
}

const NETWORK_VERSION_META = 'networkVersion';

export type LoadNetworkOpts = {
  /** Ignore IndexedDB stamp match and pull full pm_v_* rows. */
  force?: boolean;
};

function nowIso() {
  return new Date().toISOString();
}

function emptyNetwork(): NetworkState {
  return {
    substations: [],
    lines: [],
    tapNodes: [],
    tapLaterals: [],
    orgUnits: DEFAULT_ORG,
    backend: 'local',
    loaded: false,
    networkVersion: undefined,
    networkCacheHit: false,
  };
}

/** Build a fallback stamp when pm_network_stamp is not deployed yet. */
async function computeFallbackStamp(): Promise<string | null> {
  if (!pmReady()) return null;
  try {
    const [ss, ln, touch] = await Promise.all([
      pmClient()!.from(pmTables().vSubstations).select('id', { count: 'exact', head: true }),
      pmClient()!.from(pmTables().vLines).select('id', { count: 'exact', head: true }),
      pmClient()!
        .from(pmTables().assets)
        .select('updated_at')
        .eq('is_deleted', false)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    const ssCount = ss.count ?? 0;
    const lnCount = ln.count ?? 0;
    const maxUpdated =
      touch.data && typeof (touch.data as { updated_at?: string }).updated_at === 'string'
        ? (touch.data as { updated_at: string }).updated_at
        : '';
    if (!ssCount && !lnCount && !maxUpdated) return null;
    return `c:${ssCount}|${lnCount}|${maxUpdated}`;
  } catch (err) {
    console.warn('[PowerMap] fallback stamp failed', err);
    return null;
  }
}

/**
 * Cheap network identity. Prefer powermap.network_meta (032); otherwise
 * counts + max(updated_at). Same string → client keeps IndexedDB dump.
 */
export async function fetchNetworkStamp(): Promise<string | null> {
  if (!pmReady()) return null;
  const client = pmClient()!;
  const primary = pmTables().networkStamp || 'pm_network_stamp';
  const candidates = [primary, 'pm_network_stamp', 'v_network_stamp'].filter(
    (v, i, a) => a.indexOf(v) === i,
  );
  for (const table of candidates) {
    try {
      const { data, error } = await client.from(table).select('version').limit(1).maybeSingle();
      if (error) {
        console.warn('[PowerMap] stamp', table, error.message);
        continue;
      }
      const version = data && typeof (data as { version?: string }).version === 'string'
        ? (data as { version: string }).version
        : null;
      if (version) return version;
    } catch (err) {
      console.warn('[PowerMap] stamp', table, err);
    }
  }
  return computeFallbackStamp();
}

async function loadCachedNetworkIfFresh(liveVersion: string): Promise<NetworkState | null> {
  const cachedVersion = await idbGetMeta<string>(NETWORK_VERSION_META);
  if (!cachedVersion || cachedVersion !== liveVersion) return null;

  const [substations, lines, tapNodes, tapLaterals, orgUnits] = await Promise.all([
    idbGetAll('substations'),
    idbGetAll('lines'),
    idbGetAll('tapNodes'),
    idbGetAll('tapLaterals'),
    idbGetAll('orgUnits'),
  ]);
  if (!substations.length && !lines.length) return null;

  return {
    substations,
    lines,
    tapNodes,
    tapLaterals,
    orgUnits: orgUnits.length ? orgUnits : DEFAULT_ORG,
    backend: 'supabase',
    loaded: true,
    networkVersion: liveVersion,
    networkCacheHit: true,
  };
}

const LEGACY_SEED_REVISION =
  typeof (legacyNetwork as { seedRevision?: number }).seedRevision === 'number'
    ? (legacyNetwork as { seedRevision: number }).seedRevision
    : 1;

function pairKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function hasParallelCircuits(lines: TrunkLine[]) {
  const counts = new Map<string, number>();
  for (const l of lines) {
    const k = pairKey(l.fromId, l.toId);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.values()].some((c) => c > 1);
}

/** Bundled existing network (same seed the other Power Map app uses locally). */
function legacySeed(): NetworkState | null {
  const data = legacyNetwork as {
    substations?: Substation[];
    lines?: TrunkLine[];
    tapNodes?: TapNode[];
    tapLaterals?: TapLateral[];
    orgUnits?: OrgUnit[];
  };
  if (!data?.substations?.length) return null;
  return {
    substations: data.substations,
    lines: data.lines ?? [],
    tapNodes: data.tapNodes ?? [],
    tapLaterals: data.tapLaterals ?? [],
    orgUnits: data.orgUnits?.length ? data.orgUnits : DEFAULT_ORG,
    backend: 'local',
    loaded: true,
  };
}

function demoSeed(): NetworkState {
  const ss1: Substation = {
    id: uuid(),
    name: 'Malda GSS',
    status: 'existing',
    voltageCode: '132',
    lat: 25.0108,
    lng: 88.1411,
    orgUnitId: 'org-mld',
    transformers: [
      { id: uuid(), ratingMva: 50, quantity: 2, sequence: 1 },
      { id: uuid(), ratingMva: 31.5, quantity: 1, sequence: 2 },
    ],
    loadingPct: 72,
    commissionYear: 1998,
    proposalRef: '',
    remarks: 'Grid substation',
    owner: 'WBSETCL',
    version: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const ss2: Substation = {
    id: uuid(),
    name: 'English Bazar 33kV',
    status: 'existing',
    voltageCode: '33',
    lat: 25.0405,
    lng: 88.1485,
    orgUnitId: 'org-mld',
    transformers: [{ id: uuid(), ratingMva: 10, quantity: 2, sequence: 1 }],
    loadingPct: 65,
    commissionYear: 2005,
    proposalRef: '',
    remarks: '',
    owner: 'WBSEDCL',
    version: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  return {
    substations: [ss1, ss2],
    lines: [],
    tapNodes: [],
    tapLaterals: [],
    orgUnits: DEFAULT_ORG,
    backend: 'local',
    loaded: true,
  };
}

async function tryLoadSupabase(): Promise<NetworkState | null> {
  if (!pmReady()) return null;
  try {
    const { data: ssRows, error: ssErr } = await pmClient()!.from(pmTables().vSubstations).select('*').limit(1);
    if (ssErr) {
      console.warn('[PowerMap] Supabase bridge not ready:', ssErr.message);
      return null;
    }

    const [
      { data: substations, error: e1 },
      { data: lines, error: e2 },
      { data: taps },
      { data: laterals },
      { data: orgs },
      { data: xfmrs },
    ] = await Promise.all([
      pmClient()!.from(pmTables().vSubstations).select('*'),
      pmClient()!.from(pmTables().vLines).select('*'),
      pmClient()!.from(pmTables().vTapNodes).select('*'),
      pmClient()!.from(pmTables().vTapLaterals).select('*'),
      pmClient()!.from(pmTables().orgUnits).select('*'),
      pmClient()!.from(pmTables().transformers).select('*'),
    ]);

    if (e1 || e2) {
      console.warn('[PowerMap] Supabase read failed:', e1?.message || e2?.message);
      return null;
    }

    void ssRows;

    const xfmrBySs = new Map<string, TransformerUnit[]>();
    (xfmrs ?? []).forEach(
      (t: {
        id: string;
        substation_asset_id: string;
        rating_mva: number;
        quantity: number;
        sequence: number;
      }) => {
        const list = xfmrBySs.get(t.substation_asset_id) ?? [];
        list.push({
          id: t.id,
          ratingMva: Number(t.rating_mva),
          quantity: t.quantity,
          sequence: t.sequence,
        });
        xfmrBySs.set(t.substation_asset_id, list);
      },
    );

    const mappedSs: Substation[] = (substations ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      name: r.name as string,
      status: r.status as AssetLifecycle,
      voltageCode: r.voltage_code as VoltageCode,
      lat: Number(r.lat),
      lng: Number(r.lng),
      orgUnitId: (r.org_unit_id as string) ?? null,
      transformers: xfmrBySs.get(r.id as string) ?? [],
      loadingPct: r.loading_pct == null ? null : Number(r.loading_pct),
      commissionYear: r.commission_year == null ? null : Number(r.commission_year),
      proposalRef: (r.proposal_ref as string) ?? '',
      remarks: (r.remarks as string) ?? '',
      owner: (r.owner as string) ?? '',
      version: Number(r.version ?? 1),
      createdAt: (r.created_at as string) ?? nowIso(),
      updatedAt: (r.updated_at as string) ?? nowIso(),
    }));

    const mappedLines: TrunkLine[] = (lines ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      name: r.name as string,
      status: r.status as AssetLifecycle,
      voltageCode: r.voltage_code as VoltageCode,
      fromId: r.from_asset_id as string,
      toId: r.to_asset_id as string,
      circuitCount: Number(r.circuit_count ?? 1),
      circuitConfig: (r.circuit_config as CircuitConfig) ?? 'single',
      conductor: (r.conductor as string) ?? '',
      lengthKm: r.length_km == null ? null : Number(r.length_km),
      loadingPct: r.loading_pct == null ? null : Number(r.loading_pct),
      commissionYear: r.commission_year == null ? null : Number(r.commission_year),
      proposalRef: (r.proposal_ref as string) ?? '',
      remarks: (r.remarks as string) ?? '',
      owner: (r.owner as string) ?? '',
      version: Number(r.version ?? 1),
    }));

    const mappedTaps: TapNode[] = (taps ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      name: r.name as string,
      status: r.status as AssetLifecycle,
      parentLineId: r.parent_line_asset_id as string,
      positionRatio: Number(r.position_ratio),
      lat: Number(r.lat),
      lng: Number(r.lng),
      remarks: (r.remarks as string) ?? '',
    }));

    const mappedLaterals: TapLateral[] = (laterals ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      name: r.name as string,
      status: r.status as AssetLifecycle,
      voltageCode: r.voltage_code as VoltageCode,
      fromTapId: r.from_tap_asset_id as string,
      toKind: r.to_kind as 'substation' | 'tap_node',
      toAssetId: r.to_asset_id as string,
      conductor: (r.conductor as string) ?? '',
      lengthKm: r.length_km == null ? null : Number(r.length_km),
      loadingPct: r.loading_pct == null ? null : Number(r.loading_pct),
      commissionYear: r.commission_year == null ? null : Number(r.commission_year),
      proposalRef: (r.proposal_ref as string) ?? '',
      remarks: (r.remarks as string) ?? '',
      owner: (r.owner as string) ?? '',
    }));

    const mappedOrg: OrgUnit[] =
      (orgs ?? []).length > 0
        ? (orgs as Record<string, unknown>[]).map((o) => ({
            id: o.id as string,
            parentId: (o.parent_id as string) ?? null,
            type: o.type as OrgUnit['type'],
            name: o.name as string,
            code: (o.code as string) ?? '',
            aeTechName: (o.ae_tech_name as string) ?? undefined,
            phone: (o.phone as string) ?? undefined,
          }))
        : DEFAULT_ORG;

    return {
      substations: mappedSs,
      lines: mappedLines,
      tapNodes: mappedTaps,
      tapLaterals: mappedLaterals,
      orgUnits: mappedOrg,
      backend: 'supabase',
      loaded: true,
      networkCacheHit: false,
    };
  } catch (err) {
    console.warn('[PowerMap] Supabase load error', err);
    return null;
  }
}

async function loadLocal(): Promise<NetworkState> {
  const [substations, lines, tapNodes, tapLaterals, orgUnits] = await Promise.all([
    idbGetAll('substations'),
    idbGetAll('lines'),
    idbGetAll('tapNodes'),
    idbGetAll('tapLaterals'),
    idbGetAll('orgUnits'),
  ]);

  const imported = legacySeed();
  const appliedRevision = await idbGetMeta<number>('legacySeedRevision');
  const shouldUseImport =
    !!imported &&
    (!substations.length ||
      (substations.length < 20 && imported.substations.length > substations.length) ||
      (appliedRevision !== LEGACY_SEED_REVISION &&
        imported.substations.length === substations.length &&
        imported.lines.length >= lines.length &&
        (imported.lines.length > lines.length ||
          (hasParallelCircuits(imported.lines) && !hasParallelCircuits(lines)))));

  if (shouldUseImport && imported) {
    await idbReplaceAll({
      substations: imported.substations,
      lines: imported.lines,
      tapNodes: imported.tapNodes,
      tapLaterals: imported.tapLaterals,
      orgUnits: imported.orgUnits,
    });
    await idbSetMeta('legacySeedRevision', LEGACY_SEED_REVISION);
    return imported;
  }

  if (!substations.length && !lines.length) {
    const seed = demoSeed();
    await idbReplaceAll({
      substations: seed.substations,
      lines: seed.lines,
      tapNodes: seed.tapNodes,
      tapLaterals: seed.tapLaterals,
      orgUnits: seed.orgUnits,
    });
    return seed;
  }

  const cachedVersion = await idbGetMeta<string>(NETWORK_VERSION_META);
  return {
    substations,
    lines,
    tapNodes,
    tapLaterals,
    orgUnits: orgUnits.length ? orgUnits : DEFAULT_ORG,
    backend: 'local',
    loaded: true,
    networkVersion: cachedVersion,
    networkCacheHit: Boolean(cachedVersion),
  };
}

export async function loadNetwork(opts: LoadNetworkOpts = {}): Promise<NetworkState> {
  const force = Boolean(opts.force);

  if (!force && pmReady()) {
    const liveVersion = await fetchNetworkStamp();
    if (liveVersion) {
      const cached = await loadCachedNetworkIfFresh(liveVersion);
      if (cached) {
        console.info('[PowerMap] network dump reused', liveVersion);
        return cached;
      }
    }
  }

  const remote = await tryLoadSupabase();
  if (remote && (remote.substations.length > 0 || remote.lines.length > 0)) {
    await idbReplaceAll(remote);
    const liveVersion = (await fetchNetworkStamp()) || `pull:${Date.now()}`;
    await idbSetMeta(NETWORK_VERSION_META, liveVersion);
    return { ...remote, networkVersion: liveVersion, networkCacheHit: false };
  }
  if (remote && remote.backend === 'supabase') {
    const local = await loadLocal();
    return { ...local, backend: 'supabase' };
  }
  return loadLocal();
}

/** After a cloud write, refresh the local dump stamp so this device stays consistent. */
async function rememberLiveStamp() {
  try {
    const v = await fetchNetworkStamp();
    if (v) await idbSetMeta(NETWORK_VERSION_META, v);
  } catch {
    /* ignore */
  }
}

export async function persistSubstation(ss: Substation) {
  await idbPut('substations', ss);
  if (!pmReady()) return;
  try {
    const { error: aErr } = await pmClient()!.from(pmTables().assets).upsert({
      id: ss.id,
      asset_kind: 'substation',
      name: ss.name,
      status: ss.status,
      org_unit_id: ss.orgUnitId,
      commission_year: ss.commissionYear,
      proposal_ref: ss.proposalRef || null,
      remarks: ss.remarks || null,
      loading_pct: ss.loadingPct,
      owner: ss.owner || null,
      is_deleted: false,
    });
    if (aErr) throw aErr;

    const { data: v } = await pmClient()!
      .from(pmTables().voltageLevels)
      .select('id')
      .eq('code', ss.voltageCode)
      .maybeSingle();
    if (!v?.id) return;

    const { error: sErr } = await pmClient()!.from(pmTables().substations).upsert({
      asset_id: ss.id,
      voltage_level_id: v.id,
      lat: ss.lat,
      lng: ss.lng,
    });
    if (sErr) throw sErr;

    await pmClient()!.from(pmTables().transformers).delete().eq('substation_asset_id', ss.id);
    if (ss.transformers.length) {
      const { error: tErr } = await pmClient()!.from(pmTables().transformers).insert(
        ss.transformers.map((t, i) => ({
          id: t.id,
          substation_asset_id: ss.id,
          rating_mva: t.ratingMva,
          quantity: t.quantity,
          sequence: t.sequence || i + 1,
        })),
      );
      if (tErr) throw tErr;
    }
    await rememberLiveStamp();
  } catch (err) {
    console.warn('[PowerMap] persistSubstation cloud failed', err);
  }
}

export async function persistLine(line: TrunkLine) {
  await idbPut('lines', line);
  if (!pmReady()) return;
  try {
    const { error: aErr } = await pmClient()!.from(pmTables().assets).upsert({
      id: line.id,
      asset_kind: 'line',
      name: line.name,
      status: line.status,
      commission_year: line.commissionYear,
      proposal_ref: line.proposalRef || null,
      remarks: line.remarks || null,
      loading_pct: line.loadingPct,
      owner: line.owner || null,
      is_deleted: false,
    });
    if (aErr) throw aErr;

    const { data: v } = await pmClient()!
      .from(pmTables().voltageLevels)
      .select('id')
      .eq('code', line.voltageCode)
      .maybeSingle();
    if (!v?.id) return;

    const { error: lErr } = await pmClient()!.from(pmTables().lines).upsert({
      asset_id: line.id,
      voltage_level_id: v.id,
      from_asset_id: line.fromId,
      to_asset_id: line.toId,
      circuit_count: line.circuitCount,
      circuit_config: line.circuitConfig,
      conductor: line.conductor || null,
      length_km: line.lengthKm,
    });
    if (lErr) throw lErr;
    await rememberLiveStamp();
  } catch (err) {
    console.warn('[PowerMap] persistLine cloud failed', err);
  }
}

export async function persistTapNode(tap: TapNode) {
  await idbPut('tapNodes', tap);
  if (!pmReady()) return;
  try {
    await pmClient()!.from(pmTables().assets).upsert({
      id: tap.id,
      asset_kind: 'tap_node',
      name: tap.name,
      status: tap.status,
      remarks: tap.remarks || null,
      is_deleted: false,
    });
    await pmClient()!.from(pmTables().tapNodes).upsert({
      asset_id: tap.id,
      parent_line_asset_id: tap.parentLineId,
      position_ratio: tap.positionRatio,
      lat: tap.lat,
      lng: tap.lng,
    });
    await rememberLiveStamp();
  } catch (err) {
    console.warn('[PowerMap] persistTapNode cloud failed', err);
  }
}

export async function persistTapLateral(lateral: TapLateral) {
  await idbPut('tapLaterals', lateral);
  if (!pmReady()) return;
  try {
    const { data: v } = await pmClient()!
      .from(pmTables().voltageLevels)
      .select('id')
      .eq('code', lateral.voltageCode)
      .maybeSingle();
    await pmClient()!.from(pmTables().assets).upsert({
      id: lateral.id,
      asset_kind: 'tap_lateral',
      name: lateral.name,
      status: lateral.status,
      remarks: lateral.remarks || null,
      loading_pct: lateral.loadingPct,
      owner: lateral.owner || null,
      is_deleted: false,
    });
    if (v?.id) {
      await pmClient()!.from(pmTables().tapLaterals).upsert({
        asset_id: lateral.id,
        voltage_level_id: v.id,
        from_tap_asset_id: lateral.fromTapId,
        to_kind: lateral.toKind,
        to_asset_id: lateral.toAssetId,
        conductor: lateral.conductor || null,
        length_km: lateral.lengthKm,
      });
    }
    await rememberLiveStamp();
  } catch (err) {
    console.warn('[PowerMap] persistTapLateral cloud failed', err);
  }
}

export async function removeEntity(
  kind: 'substation' | 'line' | 'tap_node' | 'tap_lateral',
  id: string,
) {
  const store =
    kind === 'substation'
      ? 'substations'
      : kind === 'line'
        ? 'lines'
        : kind === 'tap_node'
          ? 'tapNodes'
          : 'tapLaterals';
  await idbDelete(store, id);
  if (!pmReady()) return;
  try {
    await pmClient()!.from(pmTables().assets).update({ is_deleted: true }).eq('id', id);
    await rememberLiveStamp();
  } catch (err) {
    console.warn('[PowerMap] removeEntity cloud failed', err);
  }
}

/** Probe whether the public pm_* bridge responds. */
export async function probeSupabaseBridge(): Promise<{ ok: boolean; message: string; counts?: { ss: number; lines: number } }> {
  if (!pmReady()) {
    return { ok: false, message: 'Not connected' };
  }
  const { error } = await pmClient()!.from(pmTables().vSubstations).select('id', { count: 'exact', head: true });
  if (error) {
    console.warn('[PowerMap] probe', error.message);
    return { ok: false, message: 'Not connected' };
  }
  const [{ count: ss }, { count: lines }] = await Promise.all([
    pmClient()!.from(pmTables().vSubstations).select('id', { count: 'exact', head: true }),
    pmClient()!.from(pmTables().vLines).select('id', { count: 'exact', head: true }),
  ]);
  return {
    ok: true,
    message: 'Connected',
    counts: { ss: ss ?? 0, lines: lines ?? 0 },
  };
}

/**
 * Prefer atomic RPC (007) for SS + related lines; fall back to row upserts.
 */
export async function persistSubstationBundle(
  ss: Substation,
  relatedLines: TrunkLine[],
): Promise<{ ok: boolean; usedRpc: boolean; message?: string }> {
  await idbPut('substations', ss);
  await Promise.all(relatedLines.map((l) => idbPut('lines', l)));

  if (!pmReady()) {
    return { ok: true, usedRpc: false, message: 'Saved on this device' };
  }

  const ssPayload = {
    id: ss.id,
    name: ss.name,
    status: ss.status,
    voltageCode: ss.voltageCode,
    lat: ss.lat,
    lng: ss.lng,
    orgUnitId: ss.orgUnitId,
    commissionYear: ss.commissionYear,
    proposalRef: ss.proposalRef,
    remarks: ss.remarks,
    loadingPct: ss.loadingPct,
    owner: ss.owner,
  };
  const xfmrPayload = ss.transformers.map((t) => ({
    id: t.id,
    ratingMva: t.ratingMva,
    quantity: t.quantity,
    sequence: t.sequence,
  }));
  const linesPayload = relatedLines.map((l) => ({
    id: l.id,
    name: l.name,
    status: l.status,
    voltageCode: l.voltageCode,
    conductor: l.conductor,
    loadingPct: l.loadingPct,
    remarks: l.remarks,
  }));

  const { data, error } = await pmClient()!.rpc('pm_admin_update_substation_bundle', {
    p_ss: ssPayload,
    p_transformers: xfmrPayload,
    p_lines: linesPayload,
  });

  if (!error) {
    const n = (data as { linesUpdated?: number } | null)?.linesUpdated ?? relatedLines.length;
    return {
      ok: true,
      usedRpc: true,
      message: relatedLines.length ? `Saved substation and ${n} related line(s)` : 'Substation saved',
    };
  }

  console.warn('[PowerMap] admin RPC unavailable, using upserts:', error.message);
  try {
    await persistSubstation(ss);
    for (const line of relatedLines) await persistLine(line);
    return {
      ok: true,
      usedRpc: false,
      message: relatedLines.length
        ? `Saved substation and ${relatedLines.length} related line(s)`
        : 'Substation saved',
    };
  } catch (err) {
    console.warn('[PowerMap] persistSubstationBundle failed', err);
    return {
      ok: false,
      usedRpc: false,
      message: 'Could not save — try again',
    };
  }
}

/** Push current in-memory network into Supabase (replace active assets). */
export async function pushNetworkToSupabase(state: {
  orgUnits: OrgUnit[];
  substations: Substation[];
  lines: TrunkLine[];
  tapNodes: TapNode[];
  tapLaterals: TapLateral[];
}): Promise<{ ok: boolean; message: string }> {
  if (!pmReady()) {
    return { ok: false, message: 'Could not publish — try again later' };
  }

  const probe = await probeSupabaseBridge();
  if (!probe.ok) return { ok: false, message: 'Could not publish — try again later' };

  const { data: voltages, error: vErr } = await pmClient()!.from(pmTables().voltageLevels).select('id, code');
  if (vErr || !voltages?.length) {
    console.warn('[PowerMap] pushNetwork', vErr?.message);
    return { ok: false, message: 'Could not publish — try again later' };
  }
  const voltageId = Object.fromEntries(voltages.map((v: { code: string; id: string }) => [v.code, v.id]));

  // Soft-delete prior network
  await pmClient()!
    .from(pmTables().assets)
    .update({ is_deleted: true })
    .eq('is_deleted', false)
    .in('asset_kind', ['substation', 'line', 'tap_node', 'tap_lateral']);

  for (const o of state.orgUnits) {
    const { error } = await pmClient()!.from(pmTables().orgUnits).upsert({
      id: o.id,
      parent_id: o.parentId,
      type: o.type,
      name: o.name,
      code: o.code,
      ae_tech_name: o.aeTechName ?? null,
      phone: o.phone ?? null,
    });
    if (error) {
      console.warn('[PowerMap] org upsert', error.message);
      return { ok: false, message: `Could not publish org unit ${o.name}` };
    }
  }

  for (const ss of state.substations) {
    const { error: aErr } = await pmClient()!.from(pmTables().assets).upsert({
      id: ss.id,
      asset_kind: 'substation',
      name: ss.name,
      status: ss.status,
      org_unit_id: ss.orgUnitId,
      commission_year: ss.commissionYear,
      proposal_ref: ss.proposalRef || null,
      remarks: ss.remarks || null,
      loading_pct: ss.loadingPct,
      owner: ss.owner || null,
      is_deleted: false,
    });
    if (aErr) {
      console.warn('[PowerMap] ss asset', aErr.message);
      return { ok: false, message: `Could not publish ${ss.name}` };
    }

    const vid = voltageId[ss.voltageCode];
    if (!vid) return { ok: false, message: `Could not publish ${ss.name}` };

    const { error: sErr } = await pmClient()!.from(pmTables().substations).upsert({
      asset_id: ss.id,
      voltage_level_id: vid,
      lat: ss.lat,
      lng: ss.lng,
    });
    if (sErr) {
      console.warn('[PowerMap] ss row', sErr.message);
      return { ok: false, message: `Could not publish ${ss.name}` };
    }

    await pmClient()!.from(pmTables().transformers).delete().eq('substation_asset_id', ss.id);
    if (ss.transformers.length) {
      const { error: tErr } = await pmClient()!.from(pmTables().transformers).insert(
        ss.transformers.map((t, i) => ({
          id: t.id,
          substation_asset_id: ss.id,
          rating_mva: t.ratingMva,
          quantity: t.quantity,
          sequence: t.sequence || i + 1,
        })),
      );
      if (tErr) {
        console.warn('[PowerMap] xfmr', tErr.message);
        return { ok: false, message: `Could not publish transformers for ${ss.name}` };
      }
    }
  }

  for (const line of state.lines) {
    const { error: aErr } = await pmClient()!.from(pmTables().assets).upsert({
      id: line.id,
      asset_kind: 'line',
      name: line.name,
      status: line.status,
      loading_pct: line.loadingPct,
      remarks: line.remarks || null,
      owner: line.owner || null,
      is_deleted: false,
    });
    if (aErr) {
      console.warn('[PowerMap] line asset', aErr.message);
      return { ok: false, message: `Could not publish line ${line.name}` };
    }

    const vid = voltageId[line.voltageCode];
    const { error: lErr } = await pmClient()!.from(pmTables().lines).upsert({
      asset_id: line.id,
      voltage_level_id: vid,
      from_asset_id: line.fromId,
      to_asset_id: line.toId,
      circuit_count: line.circuitCount,
      circuit_config: line.circuitConfig,
      conductor: line.conductor || null,
      length_km: line.lengthKm,
    });
    if (lErr) {
      console.warn('[PowerMap] line row', lErr.message);
      return { ok: false, message: `Could not publish line ${line.name}` };
    }
  }

  for (const tap of state.tapNodes) {
    await pmClient()!.from(pmTables().assets).upsert({
      id: tap.id,
      asset_kind: 'tap_node',
      name: tap.name,
      status: tap.status,
      remarks: tap.remarks || null,
      is_deleted: false,
    });
    await pmClient()!.from(pmTables().tapNodes).upsert({
      asset_id: tap.id,
      parent_line_asset_id: tap.parentLineId,
      position_ratio: tap.positionRatio,
      lat: tap.lat,
      lng: tap.lng,
    });
  }

  for (const lat of state.tapLaterals) {
    const vid = voltageId[lat.voltageCode];
    await pmClient()!.from(pmTables().assets).upsert({
      id: lat.id,
      asset_kind: 'tap_lateral',
      name: lat.name,
      status: lat.status,
      remarks: lat.remarks || null,
      is_deleted: false,
    });
    if (vid) {
      await pmClient()!.from(pmTables().tapLaterals).upsert({
        asset_id: lat.id,
        voltage_level_id: vid,
        from_tap_asset_id: lat.fromTapId,
        to_kind: lat.toKind,
        to_asset_id: lat.toAssetId,
        conductor: lat.conductor || null,
        length_km: lat.lengthKm,
      });
    }
  }

  return {
    ok: true,
    message: `Published ${state.substations.length} substations and ${state.lines.length} lines`,
  };
}

export function createSubstation(input: {
  name: string;
  lat: number;
  lng: number;
  voltageCode: VoltageCode;
  status: AssetLifecycle;
  orgUnitId: string | null;
  transformers: TransformerUnit[];
}): Substation {
  const ts = nowIso();
  return {
    id: uuid(),
    name: input.name,
    status: input.status,
    voltageCode: input.voltageCode,
    lat: input.lat,
    lng: input.lng,
    orgUnitId: input.orgUnitId,
    transformers: input.transformers,
    loadingPct: null,
    commissionYear: null,
    proposalRef: '',
    remarks: '',
    owner: '',
    version: 1,
    createdAt: ts,
    updatedAt: ts,
  };
}

export function createLine(input: {
  from: Substation;
  to: Substation;
  voltageCode: VoltageCode;
  status: AssetLifecycle;
  circuitCount?: number;
  circuitConfig?: CircuitConfig;
  conductor?: string;
  parallelTotal?: number;
}): TrunkLine {
  const circuitCount = input.circuitCount ?? 1;
  const parallelTotal = input.parallelTotal ?? circuitCount;
  const circuitConfig =
    input.circuitConfig ?? (parallelTotal > 1 ? 'double' : 'single');
  return {
    id: uuid(),
    name: defaultLineName(input.from, input.to, input.voltageCode, {
      circuitCount,
      conductor: input.conductor,
      parallelTotal,
    }),
    status: input.status,
    voltageCode: input.voltageCode,
    fromId: input.from.id,
    toId: input.to.id,
    circuitCount,
    circuitConfig,
    conductor: input.conductor ?? '',
    lengthKm: haversineKm(input.from.lat, input.from.lng, input.to.lat, input.to.lng),
    loadingPct: null,
    commissionYear: null,
    proposalRef: '',
    remarks: '',
    owner: '',
    version: 1,
  };
}

export function createTapOnLine(
  line: TrunkLine,
  fromSs: Substation,
  toSs: Substation,
  clickLat: number,
  clickLng: number,
): TapNode {
  const ratio = closestRatioOnSegment(
    fromSs.lat,
    fromSs.lng,
    toSs.lat,
    toSs.lng,
    clickLat,
    clickLng,
  );
  const pt = pointAlong(fromSs.lat, fromSs.lng, toSs.lat, toSs.lng, ratio);
  return {
    id: uuid(),
    name: `Tap on ${line.name}`,
    status: line.status,
    parentLineId: line.id,
    positionRatio: ratio,
    lat: pt.lat,
    lng: pt.lng,
    remarks: '',
  };
}

export function createTapLateral(input: {
  fromTap: TapNode;
  toKind: 'substation' | 'tap_node';
  toAssetId: string;
  toLat: number;
  toLng: number;
  voltageCode: VoltageCode;
  status: AssetLifecycle;
  name?: string;
}): TapLateral {
  return {
    id: uuid(),
    name: input.name ?? `Lateral from ${input.fromTap.name}`,
    status: input.status,
    voltageCode: input.voltageCode,
    fromTapId: input.fromTap.id,
    toKind: input.toKind,
    toAssetId: input.toAssetId,
    conductor: '',
    lengthKm: haversineKm(input.fromTap.lat, input.fromTap.lng, input.toLat, input.toLng),
    loadingPct: null,
    commissionYear: null,
    proposalRef: '',
    remarks: '',
    owner: '',
  };
}

export function linesConnectedTo(ssId: string, lines: TrunkLine[]) {
  return lines.filter((l) => l.fromId === ssId || l.toId === ssId);
}

export function tapsOnLine(lineId: string, taps: TapNode[]) {
  return taps.filter((t) => t.parentLineId === lineId);
}

export function reprojectTapsForLine(
  line: TrunkLine,
  from: Substation,
  to: Substation,
  taps: TapNode[],
): TapNode[] {
  return taps
    .filter((t) => t.parentLineId === line.id)
    .map((t) => {
      const pt = pointAlong(from.lat, from.lng, to.lat, to.lng, t.positionRatio);
      return { ...t, lat: pt.lat, lng: pt.lng };
    });
}

export function computeAnalytics(
  substations: Substation[],
  lines: TrunkLine[],
  tapNodes: TapNode[],
): NetworkAnalytics {
  const connected = new Set<string>();
  lines.forEach((l) => {
    connected.add(l.fromId);
    connected.add(l.toId);
  });
  tapNodes.forEach(() => {
    /* tap laterals also connect — handled in store */
  });

  const loadings = substations
    .map((s) => s.loadingPct)
    .filter((v): v is number => v != null);
  const years = substations
    .map((s) => s.commissionYear)
    .filter((v): v is number => v != null);

  return {
    substationCount: substations.length,
    lineCount: lines.length,
    tapCount: tapNodes.length,
    installedMva: substations.reduce((sum, s) => sum + installedMva(s.transformers), 0),
    totalLineKm: lines.reduce((sum, l) => sum + (l.lengthKm ?? 0), 0),
    avgLoading: loadings.length ? loadings.reduce((a, b) => a + b, 0) / loadings.length : null,
    isolatedCount: substations.filter((s) => !connected.has(s.id)).length,
    oldestYear: years.length ? Math.min(...years) : null,
  };
}

export { emptyNetwork, demoSeed };
