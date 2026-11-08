import { useEffect } from 'react';
import { MapView } from '@/features/map/MapView';
import { MapLayersControl } from '@/features/map/MapLayersControl';
import { PrintSheet } from '@/features/print/PrintSheet';
import { ConfirmDialog } from '@/features/shell/ConfirmDialog';
import { SearchPalette } from '@/features/shell/SearchPalette';
import { SidePanel } from '@/features/shell/SidePanel';
import { StatusBar } from '@/features/shell/StatusBar';
import { ToolRail } from '@/features/shell/ToolRail';
import { useNetworkStore } from '@/store/networkStore';

export function App() {
  const bootstrap = useNetworkStore((s) => s.bootstrap);
  const loaded = useNetworkStore((s) => s.loaded);
  const printPreviewOpen = useNetworkStore((s) => s.printPreviewOpen);
  const printSettings = useNetworkStore((s) => s.printSettings);
  const setPrintPreviewOpen = useNetworkStore((s) => s.setPrintPreviewOpen);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  return (
    <div className="pm-shell">
      <div className="workspace">
        <ToolRail />
        <div className="map-stage">
          {!loaded && (
            <div className="boot-overlay">
              <div className="boot-card">
                <div className="boot-spinner" />
                <p>Loading network…</p>
              </div>
            </div>
          )}
          <MapView />
          <MapLayersControl />
          <div className="map-legend">
            <div className="legend-title">Symbology</div>
            <div className="legend-row"><span className="sym square" /> 400 kV</div>
            <div className="legend-row"><span className="sym diamond" /> 220 kV</div>
            <div className="legend-row"><span className="sym hex" /> 132 kV</div>
            <div className="legend-row"><span className="sym pentagon" /> 66 kV</div>
            <div className="legend-row"><span className="sym circle" /> 33 kV</div>
            <div className="legend-note">Filled = existing · Outline = proposed</div>
          </div>
          <SidePanel />
        </div>
      </div>
      <StatusBar />
      <SearchPalette />
      <ConfirmDialog />
      {printPreviewOpen && (
        <PrintSheet
          settings={printSettings}
          onClose={() => setPrintPreviewOpen(false)}
        />
      )}
    </div>
  );
}
