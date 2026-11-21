import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/ui',
  base: './',
  plugins: [react()],
  server: {
    // `agent-ball serve` reads a real repo; without it the UI falls back to demo data.
    proxy: {
      '/api': 'http://127.0.0.1:4747',
    },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
});
