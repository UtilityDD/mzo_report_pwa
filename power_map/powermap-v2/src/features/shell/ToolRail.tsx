import {
  Crosshair,
  Plus,
  Link2,
  Split,
  Move,
  Trash2,
  Ruler,
  Layers,
  Filter,
  FileBarChart2,
  Settings,
  MapPinned,
  Activity,
  Printer,
  RotateCcw,
} from 'lucide-react';
import type { ToolMode } from '@/domain/types';
import { useNetworkStore } from '@/store/networkStore';

type PanelId = 'layers' | 'filters' | 'reports' | 'settings' | 'siting' | 'voltage-check' | 'print';

const tools: {
  id: ToolMode | PanelId | 'reset-map';
  label: string;
  icon: typeof Crosshair;
}[] = [
  { id: 'cursor', label: 'Select', icon: Crosshair },
  { id: 'add-ss', label: 'Add Substation', icon: Plus },
  { id: 'connect', label: 'Connect', icon: Link2 },
  { id: 'tap', label: 'Tap', icon: Split },
  { id: 'move', label: 'Move', icon: Move },
  { id: 'delete', label: 'Delete', icon: Trash2 },
  { id: 'measure', label: 'Measure', icon: Ruler },
  { id: 'siting', label: '33 kV Siting', icon: MapPinned },
  { id: 'voltage-check', label: 'Check voltage', icon: Activity },
  { id: 'print', label: 'Print Map', icon: Printer },
  { id: 'layers', label: 'Layers', icon: Layers },
  { id: 'filters', label: 'Filters', icon: Filter },
  { id: 'reports', label: 'Reports', icon: FileBarChart2 },
  { id: 'reset-map', label: 'Reset map', icon: RotateCcw },
  { id: 'settings', label: 'Settings', icon: Settings },
];

const PANEL_IDS: PanelId[] = [
  'layers',
  'filters',
  'reports',
  'settings',
  'siting',
  'voltage-check',
  'print',
];

export function ToolRail() {
  const tool = useNetworkStore((s) => s.tool);
  const panel = useNetworkStore((s) => s.panel);
  const setTool = useNetworkStore((s) => s.setTool);
  const setPanel = useNetworkStore((s) => s.setPanel);
  const resetMapView = useNetworkStore((s) => s.resetMapView);

  return (
    <aside className="tool-rail" aria-label="Tools">
      {tools.map((t) => {
        const Icon = t.icon;
        const isReset = t.id === 'reset-map';
        const isPanel = !isReset && PANEL_IDS.includes(t.id as PanelId);
        const active = isReset
          ? false
          : isPanel
            ? panel === t.id
            : tool === t.id && !isPanel;
        return (
          <button
            key={t.id}
            type="button"
            className={`tool-btn${active ? ' active' : ''}`}
            title={t.label}
            aria-label={t.label}
            onClick={() => {
              if (isReset) {
                resetMapView();
                return;
              }
              if (isPanel) {
                const panelId = t.id as PanelId;
                setPanel(panel === panelId ? null : panelId);
              } else {
                setTool(t.id as ToolMode);
                if (PANEL_IDS.includes(panel as PanelId)) {
                  setPanel(null);
                }
              }
            }}
          >
            <Icon size={18} strokeWidth={1.75} />
          </button>
        );
      })}
    </aside>
  );
}
