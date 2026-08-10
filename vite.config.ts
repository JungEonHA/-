// Production 빌드 설정. 테스트 설정은 vitest.config.ts 에 분리되어 있다.
//
// 여기에 vitest 의 `test` 블록을 두면 안 된다. 그 키는 vitest 의 타입 증강이
// 있어야 유효한데, 배포 중 타입체크(tsconfig.build.json)는 devDependencies 타입에
// 기대지 않으므로 TS2769 로 빌드가 깨진다.
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
});
