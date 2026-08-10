/**
 * 개발용 스크린샷 생성기. 배포 산출물에는 포함되지 않는다.
 *   node scripts/screenshot.mjs <outDir>
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const outDir = process.argv[2] ?? 'shots';
const BASE = process.env.SHOT_BASE ?? 'http://127.0.0.1:4173';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

async function shoot(name, { width, height, colorScheme, steps }) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.clock.install({ time: new Date('2026-08-10T00:00:00.000Z') });
  await page.goto(BASE);
  await page.waitForSelector('[data-testid="btn-clock-in"]');
  if (steps) await steps(page);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true });
  await context.close();
}

/** 데모용 근무 이력을 심는다 */
async function seed(page) {
  await page.getByTestId('btn-clock-in').click();
  await page.clock.fastForward('03:00:00');
  await page.getByTestId('btn-away-start').click();
  await page.clock.fastForward('01:00:00');
  await page.getByTestId('btn-away-end').click();
  await page.clock.fastForward('01:42:31');
}

await shoot('01-home-mobile', {
  width: 390,
  height: 900,
  colorScheme: 'light',
  steps: seed,
});

await shoot('02-home-desktop', {
  width: 1180,
  height: 900,
  colorScheme: 'light',
  steps: seed,
});

await shoot('03-vacation', {
  width: 390,
  height: 900,
  colorScheme: 'light',
  steps: async (page) => {
    await page.getByTestId('tab-vacation').click();
    await page.getByTestId('vac-preset-2').click();
    await page.getByTestId('btn-vac-use').click();
    await page.waitForTimeout(200);
  },
});

await shoot('04-summary', {
  width: 390,
  height: 1000,
  colorScheme: 'light',
  steps: async (page) => {
    await seed(page);
    await page.getByTestId('btn-clock-out').click();
    await page.clock.fastForward('16:00:00');
    await page.reload();
    await page.getByTestId('btn-clock-in').click();
    await page.clock.fastForward('07:30:00');
    await page.getByTestId('btn-clock-out').click();
    await page.getByTestId('tab-summary').click();
  },
});

await shoot('05-settings', {
  width: 390,
  height: 1000,
  colorScheme: 'light',
  steps: async (page) => {
    await page.getByTestId('tab-settings').click();
    await page.waitForTimeout(400);
  },
});

await shoot('06-home-dark', {
  width: 390,
  height: 900,
  colorScheme: 'dark',
  steps: seed,
});

await browser.close();
console.log(`saved to ${outDir}/`);
