import { Search, Zap } from 'lucide-react';
import { useNetworkStore } from '@/store/networkStore';

export function TopBar() {
  const backend = useNetworkStore((s) => s.backend);
  const adminMode = useNetworkStore((s) => s.adminMode);
  const adminRole = useNetworkStore((s) => s.adminRole);
  const adminName = useNetworkStore((s) => s.adminName);
  const setSearchOpen = useNetworkStore((s) => s.setSearchOpen);
  const searchOpen = useNetworkStore((s) => s.searchOpen);
  const substations = useNetworkStore((s) => s.substations);
  const lines = useNetworkStore((s) => s.lines);
  const setPanel = useNetworkStore((s) => s.setPanel);

  const ssCount = substations.length;
  const lineCount = lines.length;
  const label = `${ssCount} SS · ${lineCount} lines`;
  const title =
    backend === 'supabase' ? 'Connected — live network' : 'Working from a local copy';

  const accessLabel =
    adminRole === 'super' ? 'Super admin' : adminRole === 'editor' ? adminName || 'Editor' : null;

  return (
    <header className="top-bar">
      <div className="brand">
        <div className="brand-mark">
          <Zap size={16} />
        </div>
        <div className="brand-text">
          <span className="brand-name">Power Map</span>
          <span className="brand-ver">DRO</span>
        </div>
      </div>

      <button
        type="button"
        className="search-trigger"
        onClick={() => setSearchOpen(!searchOpen)}
      >
        <Search size={15} />
        <span>Search network</span>
        <kbd>⌘K</kbd>
      </button>

      <div className="top-meta">
        {adminMode && accessLabel && (
          <button
            type="button"
            className={`admin-pill${adminRole === 'super' ? ' is-super' : ''}`}
            title="Open Settings"
            onClick={() => setPanel('settings')}
          >
            {accessLabel}
          </button>
        )}
        <button
          type="button"
          className={`sync-pill ${backend}`}
          title={title}
          onClick={() => setPanel('settings')}
        >
          <span className="sync-dot" aria-hidden />
          {label}
        </button>
      </div>
    </header>
  );
}
