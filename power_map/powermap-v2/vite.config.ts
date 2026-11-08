import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Built assets are committed under /power_map/v2/ so the VM can serve them
// without a Vite install (deploy only runs npm ci on the root package).
export default defineConfig({
  plugins: [react()],
  base: '/power_map/v2/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, '../v2'),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5174,
    host: true,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/login.html': 'http://127.0.0.1:3000',
      '/auth.js': 'http://127.0.0.1:3000',
      '/mzo_theme.css': 'http://127.0.0.1:3000',
      '/mzo_theme.js': 'http://127.0.0.1:3000',
    },
  },
});
