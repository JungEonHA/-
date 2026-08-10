/**
 * 테스트 전용 설정.
 *
 * production 빌드 설정(vite.config.ts)과 분리되어 있다.
 * vitest 는 vite.config.* 보다 vitest.config.* 를 우선해서 읽으므로,
 * 여기서 vite 설정을 그대로 물려받은 뒤 test 블록만 얹는다.
 *
 * 분리 이유: `test` 키는 vitest 의 타입 증강이 있어야 유효하다.
 * 배포 환경의 타입체크는 devDependencies 타입에 기대지 않으므로,
 * vite.config.ts 에 test 블록이 남아 있으면 배포 빌드가 깨진다.
 */
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      globals: true,
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts'],
      setupFiles: [],
    },
  }),
);
