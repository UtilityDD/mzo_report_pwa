import type { Substation, TrunkLine } from '@/domain/types';
import { getDb } from '@/lib/idb';

export type PersonalDraftAssetKind = 'substation' | 'line';

export type PersonalDraft = {
  /** `${username}|${assetKind}|${assetId}` */
  id: string;
  username: string;
  assetKind: PersonalDraftAssetKind;
  assetId: string;
  summary: string;
  /** Free-text note for the editor's own use. */
  comment: string;
  payload: {
    ss?: Substation;
    relatedLines?: TrunkLine[];
    line?: TrunkLine;
  };
  /** Live asset versions at draft time — detect stale live data. */
  baseVersions: Record<string, number>;
  lat: number | null;
  lng: number | null;
  updatedAt: string;
};

export function draftId(
  username: string,
  assetKind: PersonalDraftAssetKind,
  assetId: string,
): string {
  return `${username.trim().toLowerCase()}|${assetKind}|${assetId}`;
}

export async function listPersonalDrafts(username: string): Promise<PersonalDraft[]> {
  const key = username.trim().toLowerCase();
  if (!key) return [];
  const db = await getDb();
  const all = await db.getAll('personalDrafts');
  return all
    .filter((d) => d.username.toLowerCase() === key)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getPersonalDraft(id: string): Promise<PersonalDraft | undefined> {
  const db = await getDb();
  return db.get('personalDrafts', id);
}

export async function putPersonalDraft(draft: PersonalDraft): Promise<void> {
  const db = await getDb();
  await db.put('personalDrafts', draft);
}

export async function deletePersonalDraft(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('personalDrafts', id);
}

export function isDraftStale(
  draft: PersonalDraft,
  live: { substations: Substation[]; lines: TrunkLine[] },
): { stale: boolean; details: string[] } {
  const details: string[] = [];
  const ssById = new Map(live.substations.map((s) => [s.id, s]));
  const lineById = new Map(live.lines.map((l) => [l.id, l]));
  for (const [assetId, baseVer] of Object.entries(draft.baseVersions)) {
    const ss = ssById.get(assetId);
    if (ss && ss.version !== baseVer) {
      details.push(`${ss.name} (live v${ss.version} ≠ draft base v${baseVer})`);
      continue;
    }
    const line = lineById.get(assetId);
    if (line && line.version !== baseVer) {
      details.push(`${line.name} (live v${line.version} ≠ draft base v${baseVer})`);
    }
  }
  return { stale: details.length > 0, details };
}
