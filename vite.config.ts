import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { notionDevApiPlugin } from './scripts/vite-plugin-notion-api';

// `BASE_PATH` lets the same build be served from a GitHub Pages sub-path
// (e.g. https://<user>.github.io/<repo>/) as well as from a domain root
// (Vercel / Cloudflare). Defaults to root.
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  plugins: [react(), notionDevApiPlugin()],
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts'],
    setupFiles: [],
  },
});
