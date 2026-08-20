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

// 이 번들이 어느 배포에서 나왔는지. 서버(/api/health)가 같은 값을 돌려주므로,
// 앱은 자기 코드가 낡았는지 스스로 알 수 있다. 노션에 임베드한 위젯은 iframe 이
// 며칠씩 그대로 떠 있어서 고친 코드가 반영되지 않은 채 계속 돌아간다.
const buildId = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) ?? 'dev';

export default defineConfig({
  base,
  define: { __BUILD_ID__: JSON.stringify(buildId) },
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
