import { useEffect, useRef, useState } from 'react';
import { useNetworkStore } from '@/store/networkStore';
import { ViewToggles } from './ViewToggles';

const BASEMAPS = [
  { id: 'google', label: 'Roads' },
  { id: 'google-hybrid', label: 'Hybrid' },
  { id: 'osm', label: 'OSM' },
  { id: 'esri', label: 'Gray' },
  { id: 'none', label: 'None' },
] as const;

/**
 * Compact layers / basemap / mask controls on the map canvas
 * (top-right). Full district dimming stays in the side Layers panel.
 */
export function MapLayersControl() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const mapLayers = useNetworkStore((s) => s.mapLayers);
  const setMapLayers = useNetworkStore((s) => s.setMapLayers);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const el = rootRef.current;
      if (el && !el.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="map-layers-control" ref={rootRef}>
      <ViewToggles variant="map" />
      <div className="map-layers-control-stack">
        <button
          type="button"
          className={`map-layers-toggle${open ? ' on' : ''}`}
          aria-expanded={open}
          aria-controls="map-layers-panel"
          onClick={() => setOpen((v) => !v)}
        >
          Layers
        </button>
        {open && (
          <div id="map-layers-panel" className="map-layers-panel" role="dialog" aria-label="Map layers">
            <p className="section-label">Basemap</p>
            <div className="chip-group map-layers-chips">
              {BASEMAPS.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className={`chip${mapLayers.basemap === b.id ? ' on' : ''}`}
                  onClick={() => setMapLayers({ basemap: b.id })}
                >
                  {b.label}
                </button>
              ))}
            </div>

            <p className="section-label">Boundaries</p>
            <label className="check-row">
              <input
                type="checkbox"
                checked={mapLayers.showDistricts}
                onChange={(e) => setMapLayers({ showDistricts: e.target.checked })}
              />
              Districts
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={mapLayers.showDistrictLabels}
                disabled={!mapLayers.showDistricts}
                onChange={(e) => setMapLayers({ showDistrictLabels: e.target.checked })}
              />
              District names
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={mapLayers.showBlocks}
                onChange={(e) => setMapLayers({ showBlocks: e.target.checked })}
              />
              Blocks
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={mapLayers.showBlockLabels}
                disabled={!mapLayers.showBlocks}
                onChange={(e) => setMapLayers({ showBlockLabels: e.target.checked })}
              />
              Block names
            </label>

            <p className="section-label">Network</p>
            <label className="check-row">
              <input
                type="checkbox"
                checked={mapLayers.showSsNames}
                onChange={(e) => setMapLayers({ showSsNames: e.target.checked })}
              />
              SS name
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={mapLayers.showSsCapacity}
                onChange={(e) => setMapLayers({ showSsCapacity: e.target.checked })}
              />
              SS capacity
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={mapLayers.showFeederNames}
                onChange={(e) => setMapLayers({ showFeederNames: e.target.checked })}
              />
              Feeder name
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={mapLayers.showFeederLength}
                onChange={(e) => setMapLayers({ showFeederLength: e.target.checked })}
              />
              Feeder length
            </label>

            <p className="section-label">Outside WB</p>
            <label className="check-row">
              <input
                type="checkbox"
                checked={mapLayers.showMask}
                onChange={(e) => setMapLayers({ showMask: e.target.checked })}
              />
              Dim outside West Bengal
            </label>
            <label className="field map-layers-opacity">
              <span>Mask opacity ({Math.round(mapLayers.maskOpacity * 100)}%)</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={mapLayers.maskOpacity}
                disabled={!mapLayers.showMask}
                onChange={(e) => setMapLayers({ maskOpacity: Number(e.target.value) })}
              />
            </label>
          </div>
        )}
      </div>
    </div>
  );
}
