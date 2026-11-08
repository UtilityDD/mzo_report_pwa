import 'leaflet';

declare module 'leaflet' {
  interface Map {
    pm: {
      setLang: (lang: string) => void;
      addControls: (opts: Record<string, unknown>) => void;
      enableDraw: (shape: string, opts?: Record<string, unknown>) => void;
      disableDraw: () => void;
      disableGlobalEditMode: () => void;
      disableGlobalDragMode: () => void;
    };
  }
}

declare module '@geoman-io/leaflet-geoman-free';
