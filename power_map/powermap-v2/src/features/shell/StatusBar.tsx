import { useNetworkStore } from '@/store/networkStore';

export function StatusBar() {
  const loaded = useNetworkStore((s) => s.loaded);
  const statusMessage = useNetworkStore((s) => s.statusMessage);
  const editCursorHint = useNetworkStore((s) => s.editCursorHint);
  const analytics = useNetworkStore((s) => s.analytics);
  const tool = useNetworkStore((s) => s.tool);
  const connectDraft = useNetworkStore((s) => s.connectDraft);
  const tapDraft = useNetworkStore((s) => s.tapDraft);
  const placeDraft = useNetworkStore((s) => s.placeDraft);
  if (!loaded) return null;
  const a = analytics();

  let hint = 'Select an asset · click a district to focus';
  if (tool === 'add-ss') {
    hint = placeDraft
      ? `Selected ${placeDraft.lat.toFixed(5)}, ${placeDraft.lng.toFixed(5)} — confirm in panel`
      : 'Click map to place · live lat/lng follow the cursor';
  }
  if (tool === 'connect') {
    hint = connectDraft.fromId
      ? 'Rubber-band to target · snaps within range'
      : 'Move near a substation to snap · click source';
  }
  if (tool === 'tap') {
    hint = tapDraft.sourceTapId
      ? 'Rubber-band to SS or feeder · snaps within range'
      : 'Move onto a feeder to snap · click to start tap';
  }
  if (tool === 'move') hint = 'Drag a substation — dashed feeders preview the move';
  if (tool === 'delete') hint = 'Hover for a red delete tip · click an asset';
  if (tool === 'measure') hint = 'Draw a path · vertices snap to nearby points';

  return (
    <footer className="status-bar">
      <div className="status-hint">
        {statusMessage ?? editCursorHint ?? hint}
      </div>
      <div className="status-kpis">
        <span>
          <strong>{a.substationCount}</strong> SS
        </span>
        <span>
          <strong>{a.lineCount}</strong> lines
        </span>
        <span>
          <strong>{a.tapCount}</strong> taps
        </span>
        <span>
          <strong>{a.installedMva.toFixed(1)}</strong> MVA
        </span>
        <span>
          <strong>{a.totalLineKm.toFixed(1)}</strong> km
        </span>
        <span>
          <strong>{a.isolatedCount}</strong> isolated
        </span>
      </div>
    </footer>
  );
}
