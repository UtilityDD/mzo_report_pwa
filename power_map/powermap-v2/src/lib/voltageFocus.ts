import type { AssetLifecycle, Substation, TapLateral, TrunkLine, VoltageCode } from '@/domain/types';

export type VoltageFocus = 'all' | 'ehv' | '33' | 'proposed';

export const MAP_VIEW_TOGGLES: {
  id: VoltageFocus;
  label: string;
  title: string;
}[] = [
  { id: 'all', label: 'All', title: 'Overview — full network' },
  { id: 'ehv', label: 'EHT', title: 'EHT — dim 33 kV' },
  { id: '33', label: '33', title: '33 kV — dim distant EHT; feeders to 33 stay bright' },
  { id: 'proposed', label: 'Proposed', title: 'Proposed only — dim existing network' },
];

export const ALL_VOLTAGES: VoltageCode[] = ['400', '220', '132', '66', '33'];

/** 33 kV view: substations/lines one hop from any 33 kV yard stay bright. */
export type Focus33Context = {
  brightSsIds: ReadonlySet<string>;
  brightLineIds: ReadonlySet<string>;
};

export function buildFocus33Context(
  substations: Pick<Substation, 'id' | 'voltageCode'>[],
  lines: Pick<TrunkLine, 'id' | 'fromId' | 'toId'>[],
): Focus33Context {
  const ssById = new Map(substations.map((s) => [s.id, s]));
  const brightSsIds = new Set<string>();
  const brightLineIds = new Set<string>();

  for (const ss of substations) {
    if (ss.voltageCode === '33') brightSsIds.add(ss.id);
  }

  for (const line of lines) {
    const from = ssById.get(line.fromId);
    const to = ssById.get(line.toId);
    if (!from || !to) continue;
    const touches33 = from.voltageCode === '33' || to.voltageCode === '33';
    if (!touches33) continue;
    brightLineIds.add(line.id);
    if (from.voltageCode !== '33') brightSsIds.add(from.id);
    if (to.voltageCode !== '33') brightSsIds.add(to.id);
  }

  return { brightSsIds, brightLineIds };
}

/** True when the asset should be drawn muted for the active voltage focus. */
export function isVoltageDimmed(focus: VoltageFocus, code: VoltageCode): boolean {
  if (focus === 'all' || focus === 'proposed') return false;
  if (focus === 'ehv') return code === '33';
  return code !== '33';
}

export function isSubstationDimmed(
  focus: VoltageFocus,
  ss: Pick<Substation, 'id' | 'voltageCode' | 'status'>,
  ctx: Focus33Context | null,
): boolean {
  if (focus === 'proposed') return ss.status !== 'proposed';
  if (focus === 'all') return false;
  if (focus === 'ehv') return ss.voltageCode === '33';
  if (ss.voltageCode === '33') return false;
  return !ctx?.brightSsIds.has(ss.id);
}

export function isTrunkLineDimmed(
  focus: VoltageFocus,
  line: Pick<TrunkLine, 'id' | 'voltageCode' | 'status'>,
  ctx: Focus33Context | null,
): boolean {
  if (focus === 'proposed') return line.status !== 'proposed';
  if (focus === 'all') return false;
  if (focus === 'ehv') return line.voltageCode === '33';
  if (line.voltageCode === '33') return false;
  return !ctx?.brightLineIds.has(line.id);
}

export function isTapLateralDimmed(
  focus: VoltageFocus,
  lat: Pick<TapLateral, 'voltageCode' | 'toKind' | 'toAssetId' | 'status'>,
  ctx: Focus33Context | null,
): boolean {
  if (focus === 'proposed') return lat.status !== 'proposed';
  if (focus === 'all') return false;
  if (focus === 'ehv') return lat.voltageCode === '33';
  if (lat.voltageCode === '33') return false;
  if (lat.toKind === 'substation' && ctx?.brightSsIds.has(lat.toAssetId)) return false;
  return true;
}

export function isTapNodeDimmed(
  focus: VoltageFocus,
  tap: { status: AssetLifecycle },
  parentLine: Pick<TrunkLine, 'id' | 'voltageCode' | 'status'>,
  ctx: Focus33Context | null,
): boolean {
  if (focus === 'proposed') return tap.status !== 'proposed' && parentLine.status !== 'proposed';
  if (focus === 'all') return false;
  if (focus === 'ehv') return parentLine.voltageCode === '33';
  return !ctx?.brightLineIds.has(parentLine.id);
}

export const VOLTAGE_DIM_LINE_FACTOR = 0.14;
export const VOLTAGE_DIM_SS_OPACITY = 0.22;
export const VOLTAGE_DIM_TAP_OPACITY = 0.14;
