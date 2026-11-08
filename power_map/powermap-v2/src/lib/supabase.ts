import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Late-bound Power Map client for the DISHA host.
 * Credentials come from GET /api/powermap/config after login (never baked into the bundle).
 */

const T_PUBLIC = {
  voltageLevels: 'pm_voltage_levels',
  orgUnits: 'pm_org_units',
  assets: 'pm_assets',
  substations: 'pm_substations',
  transformers: 'pm_transformers',
  lines: 'pm_lines',
  tapNodes: 'pm_tap_nodes',
  tapLaterals: 'pm_tap_laterals',
  vSubstations: 'pm_v_substations',
  vLines: 'pm_v_lines',
  vTapNodes: 'pm_v_tap_nodes',
  vTapLaterals: 'pm_v_tap_laterals',
  editors: 'pm_editors',
  editSuggestions: 'pm_edit_suggestions',
  networkStamp: 'pm_network_stamp',
} as const;

const T_POWERMAP = {
  voltageLevels: 'voltage_levels',
  orgUnits: 'org_units',
  assets: 'assets',
  substations: 'substations',
  transformers: 'transformers',
  lines: 'lines',
  tapNodes: 'tap_nodes',
  tapLaterals: 'tap_laterals',
  vSubstations: 'v_substations',
  vLines: 'v_lines',
  vTapNodes: 'v_tap_nodes',
  vTapLaterals: 'v_tap_laterals',
  editors: 'editors',
  editSuggestions: 'edit_suggestions',
  networkStamp: 'v_network_stamp',
} as const;

export type PowerMapTables = typeof T_PUBLIC | typeof T_POWERMAP;

export let T: PowerMapTables = { ...T_PUBLIC };
export let supabase: SupabaseClient | null = null;
export let supabaseConfigured = false;

export type PowerMapLive = { ok: boolean; table?: string; reason?: string };

export function getPowerMapClient() {
  return supabase;
}
export function isPowerMapConfigured() {
  return supabaseConfigured;
}
export function getPowerMapTables() {
  return T;
}

function applyClient(url: string, key: string, schema = 'public') {
  const usePm = schema === 'powermap';
  T = usePm ? { ...T_POWERMAP } : { ...T_PUBLIC };
  supabase = createClient(url, key, {
    auth: { persistSession: false },
    db: { schema: usePm ? 'powermap' : 'public' },
  }) as unknown as SupabaseClient;
  supabaseConfigured = true;
}

export async function ensurePowerMapClient(): Promise<{
  configured: boolean;
  live?: PowerMapLive;
}> {
  try {
    const res = await fetch('/api/powermap/config', {
      credentials: 'include',
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) {
      window.location.href = '/login.html?next=' + encodeURIComponent('/power_map/v2/');
      return { configured: false };
    }
    if (res.ok) {
      const cfg = (await res.json()) as {
        url?: string | null;
        anonKey?: string | null;
        schema?: string | null;
        configured?: boolean;
        live?: PowerMapLive;
      };
      if (cfg.url && cfg.anonKey) {
        applyClient(cfg.url, cfg.anonKey, cfg.schema || 'public');
      }
      return { configured: supabaseConfigured, live: cfg.live };
    }
  } catch {
    /* offline */
  }
  return { configured: supabaseConfigured };
}
