import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  base: '/distributor/',
  build: {
    outDir: resolve(__dirname, '../public/distributor'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5175,
  },
});
