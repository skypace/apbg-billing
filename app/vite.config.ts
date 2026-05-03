import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Builds to ../public/sales-next/ during the migration.
// When the migration is complete, switch base + outDir to /sales/
// and delete the legacy single-file public/sales/index.html.
export default defineConfig({
  plugins: [react()],
  base: '/sales-next/',
  build: {
    outDir: resolve(__dirname, '../public/sales-next'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
  },
  server: {
    port: 5173,
  },
});
