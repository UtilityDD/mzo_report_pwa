import { useEffect, useMemo } from 'react';
import { useNetworkStore } from '@/store/networkStore';

export function SearchPalette() {
  const open = useNetworkStore((s) => s.searchOpen);
  const query = useNetworkStore((s) => s.searchQuery);
  const setSearchOpen = useNetworkStore((s) => s.setSearchOpen);
  const setSearchQuery = useNetworkStore((s) => s.setSearchQuery);
  const setSelection = useNetworkStore((s) => s.setSelection);
  const setMapFocus = useNetworkStore((s) => s.setMapFocus);
  const flashStatus = useNetworkStore((s) => s.flashStatus);
  const substations = useNetworkStore((s) => s.substations);
  const lines = useNetworkStore((s) => s.lines);
  const orgUnits = useNetworkStore((s) => s.orgUnits);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(!useNetworkStore.getState().searchOpen);
      }
      if (e.key === 'Escape') setSearchOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSearchOpen]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as { kind: 'substation' | 'line'; id: string; title: string; sub: string }[];

    const orgName = (id: string | null) =>
      orgUnits.find((o) => o.id === id)?.name ?? '';

    const ssHits = substations
      .filter((s) => {
        const blob = [
          s.name,
          s.voltageCode,
          s.remarks,
          s.proposalRef,
          s.owner,
          String(s.commissionYear ?? ''),
          String(s.loadingPct ?? ''),
          orgName(s.orgUnitId),
        ]
          .join(' ')
          .toLowerCase();
        return blob.includes(q);
      })
      .slice(0, 12)
      .map((s) => ({
        kind: 'substation' as const,
        id: s.id,
        title: s.name,
        sub: `${s.voltageCode} kV · ${s.status} · ${orgName(s.orgUnitId)}`,
      }));

    const lineHits = lines
      .filter((l) => {
        const blob = [l.name, l.voltageCode, l.remarks, l.proposalRef, l.conductor, l.owner]
          .join(' ')
          .toLowerCase();
        return blob.includes(q);
      })
      .slice(0, 8)
      .map((l) => ({
        kind: 'line' as const,
        id: l.id,
        title: l.name,
        sub: `${l.voltageCode} kV · ${l.status}`,
      }));

    return [...ssHits, ...lineHits];
  }, [query, substations, lines, orgUnits]);

  if (!open) return null;

  return (
    <div className="search-overlay" onClick={() => setSearchOpen(false)}>
      <div className="search-modal" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="search-input"
          placeholder="Search substations, voltage, division, remarks, improvement, progress…"
          value={query}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <ul className="search-results">
          {results.length === 0 && query && (
            <li className="search-empty">No matches</li>
          )}
          {results.map((r) => (
            <li key={`${r.kind}-${r.id}`}>
              <button
                type="button"
                onClick={() => {
                  setSelection({ kind: r.kind, id: r.id });
                  if (r.kind === 'substation') {
                    const ss = substations.find((s) => s.id === r.id);
                    if (ss) {
                      setMapFocus({ lat: ss.lat, lng: ss.lng });
                      flashStatus(`Located · ${ss.name}`);
                    }
                  } else {
                    const line = lines.find((l) => l.id === r.id);
                    const from = line
                      ? substations.find((s) => s.id === line.fromId)
                      : undefined;
                    const to = line
                      ? substations.find((s) => s.id === line.toId)
                      : undefined;
                    if (from && to) {
                      setMapFocus({
                        lat: (from.lat + to.lat) / 2,
                        lng: (from.lng + to.lng) / 2,
                      });
                      flashStatus(`Located · ${r.title}`);
                    }
                  }
                  setSearchOpen(false);
                  setSearchQuery('');
                }}
              >
                <strong>{r.title}</strong>
                <span>{r.sub}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
