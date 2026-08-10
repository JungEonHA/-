import { defineConfig, devices } from '@playwright/test';

/**
 * 이 컨테이너에는 Chromium 이 미리 설치돼 있고 다운로드가 막혀 있으므로
 * 번들 리비전 대신 설치된 실행 파일을 직접 가리킨다.
 */
const CHROMIUM_PATH = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const PORT = Number(process.env.E2E_PORT ?? 4173);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 7_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath: CHROMIUM_PATH,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    },
  },

  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],

  webServer: {
    command: `npx vite preview --port ${PORT} --host 127.0.0.1 --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
