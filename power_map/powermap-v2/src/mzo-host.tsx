import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Search } from 'lucide-react';
import { App as PowerMapApp } from './App';
import { useNetworkStore } from './store/networkStore';
import { ensurePowerMapClient } from './lib/supabase';
import 'leaflet/dist/leaflet.css';
import './styles/global.css';
import './styles/mzo-host.css';

function shellAppearance(): 'light' | 'dark' {
  try {
    const from =
      document.documentElement.getAttribute('data-theme') ||
      document.documentElement.getAttribute('data-appearance') ||
      (document.body.classList.contains('light-theme') ? 'light' : '');
    if (from === 'dark' || from === 'light') return from;
    const stored = localStorage.getItem('mzo_theme') || localStorage.getItem('theme');
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    /* ignore */
  }
  return 'light';
}

function MzoPowerMapHost() {
  const loaded = useNetworkStore((s) => s.loaded);
  const backend = useNetworkStore((s) => s.backend);
  const substations = useNetworkStore((s) => s.substations);
  const lines = useNetworkStore((s) => s.lines);
  const networkVersion = useNetworkStore((s) => s.networkVersion);
  const networkCacheHit = useNetworkStore((s) => s.networkCacheHit);
  const reloadFromSupabase = useNetworkStore((s) => s.reloadFromSupabase);
  const setSearchOpen = useNetworkStore((s) => s.setSearchOpen);
  const searchOpen = useNetworkStore((s) => s.searchOpen);

  const [clientReady, setClientReady] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [appearance, setAppearance] = useState<'light' | 'dark'>(shellAppearance);

  useEffect(() => {
    const sync = () => setAppearance(shellAppearance());
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-appearance', 'class'],
    });
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('storage', sync);
    return () => {
      obs.disconnect();
      window.removeEventListener('storage', sync);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const store = useNetworkStore.getState();
    void store.applyPortalIdentity(null);
    void (async () => {
      try {
        await ensurePowerMapClient();
      } finally {
        if (!cancelled) setClientReady(true);
      }
      try {
        const res = await fetch('/api/powermap/me', {
          credentials: 'include',
          signal: AbortSignal.timeout(8000),
        });
        if (res.status === 401) {
          window.location.href = '/login.html?next=' + encodeURIComponent('/power_map/v2/');
          return;
        }
        if (!res.ok) {
          if (!cancelled) await store.applyPortalIdentity(null);
          return;
        }
        const me = await res.json();
        if (cancelled) return;
        await store.applyPortalIdentity({
          username: me.username || 'viewer',
          name: me.name || me.username || 'Viewer',
          role: me.role || null,
          allowedSubstationIds: me.allowedSubstationIds || [],
          allowedDistricts: me.allowedDistricts || [],
          unrestricted: me.unrestricted !== false,
        });
      } catch {
        if (!cancelled) await store.applyPortalIdentity(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Map-local search: Shift+/ (and the toolbar button). Shell ⌘K stays for reports.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '?' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        e.preventDefault();
        setSearchOpen(!useNetworkStore.getState().searchOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSearchOpen]);

  const onRefresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    void reloadFromSupabase().finally(() => setRefreshing(false));
  };

  const versionLabel = networkVersion
    ? networkVersion.startsWith('r:')
      ? networkVersion.split('|')[0]
      : networkVersion.startsWith('c:')
        ? 'c…'
        : networkVersion.length > 24
          ? `${networkVersion.slice(0, 22)}…`
          : networkVersion
    : 'no-stamp';

  const showLoadOverlay = !clientReady || !loaded;

  return (
    <div className="pm-page">
      <div className="pm-desk-toolbar">
        <div className="pm-desk-toolbar-start">
          <button
            type="button"
            className="pm-desk-search"
            onClick={() => setSearchOpen(!searchOpen)}
            disabled={!loaded}
          >
            <Search size={15} />
            Search network
            <kbd>Shift+/</kbd>
          </button>
        </div>
        {loaded && backend !== 'supabase' ? (
          <span
            className="pm-offline-badge"
            title="Could not reach the live network database. Showing a copy saved earlier on this device."
          >
            Offline copy · {substations.length} SS · {lines.length} lines
          </span>
        ) : loaded ? (
          <button
            type="button"
            className="pm-desk-version muted"
            onClick={onRefresh}
            disabled={refreshing}
            title={
              networkCacheHit
                ? `Stamp unchanged (${networkVersion || '—'}) — reused device copy. Click to force refresh.`
                : `Live from Supabase (${networkVersion || 'stamp missing'}). Click to refresh.`
            }
          >
            {`${networkCacheHit ? 'Cached' : 'Live'} · ${versionLabel} · ${substations.length} SS · ${lines.length} lines`}
            {refreshing ? ' · refreshing…' : ''}
          </button>
        ) : (
          <span className="pm-desk-version muted" aria-hidden>
            —
          </span>
        )}
      </div>
      <div className="pm-root" data-appearance={appearance}>
        {showLoadOverlay && (
          <div className="pm-load-overlay" role="status" aria-live="polite">
            <div className="pm-load-card">
              <div className="pm-load-spinner" />
              <p>{clientReady ? 'Loading network…' : 'Connecting…'}</p>
            </div>
          </div>
        )}
        {clientReady ? <PowerMapApp /> : null}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MzoPowerMapHost />
  </StrictMode>,
);
