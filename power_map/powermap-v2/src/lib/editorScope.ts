import type { Substation, TrunkLine } from '@/domain/types';
import { linesConnectedTo } from '@/lib/networkRepo';
import { substationIdsInDistricts } from '@/lib/districts';
import type { EditorAccount } from '@/lib/editorsRepo';

/** Resolve all SS ids an editor may touch (explicit + district membership). */
export async function resolveEditableSubstationIds(
  editor: EditorAccount,
  substations: Substation[],
): Promise<Set<string>> {
  const ids = new Set(editor.allowedSubstationIds);
  if (editor.allowedDistricts.length) {
    const fromDistricts = await substationIdsInDistricts(substations, editor.allowedDistricts);
    for (const id of fromDistricts) ids.add(id);
  }
  return ids;
}

/** SS itself or any line attached to an allowed SS (connected network). */
export function canEditorTouchSubstation(
  allowedSs: Set<string>,
  ssId: string,
): boolean {
  return allowedSs.has(ssId);
}

export function canEditorTouchLine(
  allowedSs: Set<string>,
  line: TrunkLine,
): boolean {
  return allowedSs.has(line.fromId) || allowedSs.has(line.toId);
}

export function canEditorTouchTapOnLine(
  allowedSs: Set<string>,
  parentLine: TrunkLine | undefined,
): boolean {
  if (!parentLine) return false;
  return canEditorTouchLine(allowedSs, parentLine);
}

export function connectedNetworkLineIds(ssId: string, lines: TrunkLine[]): string[] {
  return linesConnectedTo(ssId, lines).map((l) => l.id);
}
