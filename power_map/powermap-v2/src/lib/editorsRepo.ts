import { supabase, supabaseConfigured, T } from '@/lib/supabase';

export interface EditorAccount {
  id: string;
  name: string;
  /** DRO portal account this scope belongs to; null on legacy PIN rows. */
  portalUsername: string | null;
  canEdit: boolean;
  active: boolean;
  notes: string;
  createdAt: string;
  /** Explicit SS ids the editor may edit (+ each SS connected network). */
  allowedSubstationIds: string[];
  /** District boundary names — SS inside these districts are also editable. */
  allowedDistricts: string[];
}

export type SuggestionStatus = 'pending' | 'approved' | 'rejected';
export type SuggestionAction = 'update' | 'create' | 'delete';
export type SuggestionAssetKind = 'substation' | 'line' | 'tap_node' | 'tap_lateral';

export interface EditSuggestion {
  id: string;
  editorId: string | null;
  editorName: string;
  action: SuggestionAction;
  assetKind: SuggestionAssetKind;
  assetId: string | null;
  summary: string;
  payload: Record<string, unknown>;
  lat: number | null;
  lng: number | null;
  status: SuggestionStatus;
  createdAt: string;
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function mapEditor(r: Record<string, unknown>): EditorAccount {
  return {
    id: r.id as string,
    name: r.name as string,
    portalUsername: (r.portal_username as string) ?? null,
    canEdit: Boolean(r.can_edit ?? true),
    active: Boolean(r.active ?? true),
    notes: (r.notes as string) ?? '',
    createdAt: (r.created_at as string) ?? '',
    allowedSubstationIds: Array.isArray(r.allowed_substation_ids)
      ? (r.allowed_substation_ids as string[])
      : [],
    allowedDistricts: Array.isArray(r.allowed_districts)
      ? (r.allowed_districts as string[])
      : [],
  };
}

function mapSuggestion(r: Record<string, unknown>): EditSuggestion {
  return {
    id: r.id as string,
    editorId: (r.editor_id as string) ?? null,
    editorName: (r.editor_name as string) ?? 'Editor',
    action: r.action as SuggestionAction,
    assetKind: r.asset_kind as SuggestionAssetKind,
    assetId: (r.asset_id as string) ?? null,
    summary: (r.summary as string) ?? '',
    payload: (r.payload as Record<string, unknown>) ?? {},
    lat: typeof r.lat === 'number' ? r.lat : r.lat != null ? Number(r.lat) : null,
    lng: typeof r.lng === 'number' ? r.lng : r.lng != null ? Number(r.lng) : null,
    status: (r.status as SuggestionStatus) ?? 'pending',
    createdAt: (r.created_at as string) ?? '',
  };
}

export async function listEditors(): Promise<{ ok: boolean; editors: EditorAccount[]; message?: string }> {
  if (!supabase || !supabaseConfigured) {
    return { ok: false, editors: [], message: 'Could not load editors right now' };
  }
  const { data, error } = await supabase
    .from(T.editors)
    .select('*')
    .eq('active', true)
    .order('name');
  if (error) {
    console.warn('[PowerMap] listEditors', error.message);
    return { ok: false, editors: [], message: 'Could not load editors right now' };
  }
  return { ok: true, editors: (data ?? []).map((r) => mapEditor(r as Record<string, unknown>)) };
}

/**
 * Attach an edit scope to a DRO portal account. The account's own portal
 * permission (`powermap.edit`) is what grants editing; this row only narrows it
 * to specific substations / districts, so no PIN is involved.
 */
export async function authorizeEditor(input: {
  portalUsername: string;
  name: string;
  notes?: string;
  allowedSubstationIds: string[];
  allowedDistricts: string[];
}): Promise<{ ok: boolean; message: string; editor?: EditorAccount }> {
  if (!supabase || !supabaseConfigured) {
    return { ok: false, message: 'Could not authorize right now' };
  }
  const portalUsername = input.portalUsername.trim();
  const name = input.name.trim() || portalUsername;
  if (!portalUsername) return { ok: false, message: 'Choose a portal user' };
  if (!input.allowedSubstationIds.length && !input.allowedDistricts.length) {
    return { ok: false, message: 'Select at least one substation or district' };
  }

  const { data, error } = await supabase
    .from(T.editors)
    .insert({
      name,
      portal_username: portalUsername,
      can_edit: true,
      active: true,
      notes: input.notes?.trim() || null,
      allowed_substation_ids: input.allowedSubstationIds,
      allowed_districts: input.allowedDistricts,
    })
    .select('*')
    .maybeSingle();

  if (error) {
    console.warn('[PowerMap] authorizeEditor', error.message);
    if (error.message.toLowerCase().includes('duplicate') || error.code === '23505') {
      return { ok: false, message: 'That portal user already has a scope' };
    }
    if (error.message.toLowerCase().includes('portal_username')) {
      return {
        ok: false,
        message: 'Database update needed — run migration 022_powermap_portal_editors.sql',
      };
    }
    if (error.message.toLowerCase().includes('allowed_substation') || error.code === '42703') {
      return {
        ok: false,
        message: 'Database update needed — run migration 009_editor_scope_suggestions.sql',
      };
    }
    return { ok: false, message: 'Could not authorize right now' };
  }
  return {
    ok: true,
    message: `Authorized ${name} for selective edit`,
    editor: data ? mapEditor(data as Record<string, unknown>) : undefined,
  };
}

export async function revokeEditor(id: string): Promise<{ ok: boolean; message: string }> {
  if (!supabase || !supabaseConfigured) {
    return { ok: false, message: 'Could not revoke right now' };
  }
  const { error } = await supabase
    .from(T.editors)
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) {
    console.warn('[PowerMap] revokeEditor', error.message);
    return { ok: false, message: 'Could not revoke right now' };
  }
  // Only the area limit goes away; edit rights live on the portal account.
  return { ok: true, message: 'Area limit removed — this user can now edit anywhere' };
}

export async function verifyEditorLogin(
  name: string,
  pin: string,
): Promise<{ ok: boolean; editor?: EditorAccount; message?: string }> {
  if (!supabase || !supabaseConfigured) {
    return { ok: false, message: 'Could not sign in right now' };
  }
  const pinHash = await sha256Hex(pin.trim());
  const { data, error } = await supabase
    .from(T.editors)
    .select('*')
    .eq('active', true)
    .eq('pin_hash', pinHash)
    .maybeSingle();

  if (error) {
    console.warn('[PowerMap] verifyEditorLogin', error.message);
    return { ok: false, message: 'Could not sign in right now' };
  }
  if (!data) return { ok: false, message: 'Incorrect name or PIN' };

  const editor = mapEditor(data as Record<string, unknown>);
  if (name.trim() && editor.name.toLowerCase() !== name.trim().toLowerCase()) {
    return { ok: false, message: 'Incorrect name or PIN' };
  }
  if (!editor.canEdit) {
    return { ok: false, message: 'This account cannot edit' };
  }
  return { ok: true, editor };
}

export async function listPendingSuggestions(): Promise<{
  ok: boolean;
  suggestions: EditSuggestion[];
  message?: string;
}> {
  if (!supabase || !supabaseConfigured) {
    return { ok: false, suggestions: [], message: 'Could not load suggestions' };
  }
  const { data, error } = await supabase
    .from(T.editSuggestions)
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) {
    console.warn('[PowerMap] listPendingSuggestions', error.message);
    return { ok: false, suggestions: [], message: 'Could not load suggestions' };
  }
  return {
    ok: true,
    suggestions: (data ?? []).map((r) => mapSuggestion(r as Record<string, unknown>)),
  };
}

export async function submitSuggestion(input: {
  editorId: string | null;
  editorName: string;
  action: SuggestionAction;
  assetKind: SuggestionAssetKind;
  assetId: string | null;
  summary: string;
  payload: Record<string, unknown>;
  lat?: number | null;
  lng?: number | null;
}): Promise<{ ok: boolean; message: string; suggestion?: EditSuggestion }> {
  if (!supabase || !supabaseConfigured) {
    return { ok: false, message: 'Could not submit suggestion right now' };
  }
  const { data, error } = await supabase
    .from(T.editSuggestions)
    .insert({
      editor_id: input.editorId,
      editor_name: input.editorName,
      action: input.action,
      asset_kind: input.assetKind,
      asset_id: input.assetId,
      summary: input.summary,
      payload: input.payload,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      status: 'pending',
    })
    .select('*')
    .maybeSingle();

  if (error) {
    console.warn('[PowerMap] submitSuggestion', error.message);
    if (error.message.toLowerCase().includes('edit_suggestions') || error.code === '42P01') {
      return {
        ok: false,
        message: 'Database update needed — run migration 009_editor_scope_suggestions.sql',
      };
    }
    return { ok: false, message: 'Could not submit suggestion right now' };
  }
  return {
    ok: true,
    message: 'Suggestion submitted for admin review',
    suggestion: data ? mapSuggestion(data as Record<string, unknown>) : undefined,
  };
}

export async function reviewSuggestion(
  id: string,
  status: 'approved' | 'rejected',
  reviewedBy: string,
): Promise<{ ok: boolean; message: string }> {
  if (!supabase || !supabaseConfigured) {
    return { ok: false, message: 'Could not review right now' };
  }
  const { error } = await supabase
    .from(T.editSuggestions)
    .update({
      status,
      reviewed_at: new Date().toISOString(),
      reviewed_by: reviewedBy,
    })
    .eq('id', id);
  if (error) {
    console.warn('[PowerMap] reviewSuggestion', error.message);
    return { ok: false, message: 'Could not review right now' };
  }
  return {
    ok: true,
    message: status === 'approved' ? 'Suggestion approved' : 'Suggestion rejected',
  };
}
