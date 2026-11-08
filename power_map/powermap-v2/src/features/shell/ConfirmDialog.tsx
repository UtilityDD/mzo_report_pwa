import { useNetworkStore } from '@/store/networkStore';
import { linesConnectedTo, tapsOnLine } from '@/lib/networkRepo';

export function ConfirmDialog() {
  const pending = useNetworkStore((s) => s.pendingDelete);
  const cancelDelete = useNetworkStore((s) => s.cancelDelete);
  const confirmDelete = useNetworkStore((s) => s.confirmDelete);
  const lines = useNetworkStore((s) => s.lines);
  const tapNodes = useNetworkStore((s) => s.tapNodes);
  const substations = useNetworkStore((s) => s.substations);

  if (!pending) return null;

  let message = 'Delete this asset?';
  if (pending.kind === 'substation') {
    const n = linesConnectedTo(pending.id, lines).length;
    const name = substations.find((s) => s.id === pending.id)?.name ?? 'Substation';
    message =
      n > 0
        ? `“${name}” has ${n} connected line(s). Delete the substation and all connected lines/taps?`
        : `Delete substation “${name}”?`;
  } else if (pending.kind === 'line') {
    const n = tapsOnLine(pending.id, tapNodes).length;
    message =
      n > 0
        ? `This line has ${n} tap(s). Delete the line and its taps?`
        : 'Delete this line?';
  }

  return (
    <div className="modal-overlay">
      <div className="modal-card">
        <h3>Confirm delete</h3>
        <p>{message}</p>
        <div className="modal-actions">
          <button type="button" className="primary-btn ghost" onClick={cancelDelete}>
            Cancel
          </button>
          <button type="button" className="danger-btn" onClick={() => void confirmDelete()}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
