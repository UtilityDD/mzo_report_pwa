import { useNetworkStore } from '@/store/networkStore';
import { MAP_VIEW_TOGGLES } from '@/lib/voltageFocus';

type ViewTogglesProps = {
  /** `map` = overlay on canvas; `panel` = inline in Layers / desk toolbar */
  variant?: 'map' | 'panel';
};

export function ViewToggles({ variant = 'map' }: ViewTogglesProps) {
  const voltageFocus = useNetworkStore((s) => s.voltageFocus);
  const setVoltageFocus = useNetworkStore((s) => s.setVoltageFocus);

  return (
    <div
      className={`view-toggles${variant === 'panel' ? ' view-toggles--panel' : ''}`}
      role="group"
      aria-label="Map view"
    >
      {MAP_VIEW_TOGGLES.map((v) => (
        <button
          key={v.id}
          type="button"
          className={voltageFocus === v.id ? 'on' : ''}
          title={v.title}
          aria-pressed={voltageFocus === v.id}
          onClick={() => setVoltageFocus(v.id)}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}
