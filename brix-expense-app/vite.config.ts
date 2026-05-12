import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Brix Expense sub-app. Builds to ../public/expense/ and is served
// at /expense/* on the existing apbg-billing Netlify deploy.
// Lives parallel to app/ (Margin Minder) — isolated package.json,
// node_modules, and build tree so the two cannot affect each other.
export default defineConfig({
  plugins: [react()],
  base: '/expense/',
  build: {
    outDir: resolve(__dirname, '../public/expense'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
  },
  server: {
    port: 5174,
  },
});
