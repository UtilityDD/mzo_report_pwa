/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  /** Standalone builds only: super PIN (no default). */
  readonly VITE_ADMIN_PIN?: string;
  /** '1' bundles src/data/legacyNetwork.json as the offline seed (never for the DISHA build). */
  readonly VITE_BUNDLE_LEGACY_SEED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
