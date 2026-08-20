import { expect, test, type Page } from '@playwright/test';

/**
 * "고쳤다는데 화면은 그대로" 를 끝내기 위한 검증.
 *
 * 노션에 임베드한 위젯은 iframe 이라 노션 페이지를 닫기 전에는 다시 로드되지 않는다.
 * 그래서 배포된 코드와 화면이 돌리는 코드가 며칠씩 어긋날 수 있고, 2026-08-20 에
 * 실제로 그 상태가 버그 재발로 오인됐다. 여기서는 서버가 다른 커밋을 보고하는 상황을
 * 만들어, 앱이 스스로 낡음을 알아차리고 새로고침 줄을 띄우는지 확인한다.
 *
 * 이 스펙은 `VERCEL_GIT_COMMIT_SHA` 를 넣고 빌드한 dist 에서만 의미가 있다
 * (그러지 않으면 화면 빌드가 'dev' 라 판정 자체를 하지 않는다). 그냥 `npm run e2e`
 * 로 돌렸다면 조용히 건너뛴다 — 실패로 보고하면 진짜 회귀와 구분이 안 된다.
 */

/** 'dev' 빌드면 판정 자체를 하지 않으므로 이 스펙은 의미가 없다. */
async function skipUnlessStamped(page: Page) {
  const build = await page.evaluate(() => window.__worktimeBuild);
  test.skip(
    !build || build === 'dev',
    'VERCEL_GIT_COMMIT_SHA 를 넣고 빌드한 dist 에서만 검증할 수 있다',
  );
}

/** 서버가 화면과 **다른** 커밋을 배포하고 있는 상황 */
async function serveHealth(page: Page, build: string | null) {
  await page.route('**/api/health', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        notionConfigured: true,
        databaseConfigured: true,
        writeAllowed: true,
        accessKeyRequired: false,
        notionVersion: '2022-06-28',
        build,
      }),
    }),
  );
}

test.describe('낡은 화면 알림', () => {
  test('위젯이 배포보다 낡으면 새로고침 줄이 뜬다', async ({ page }) => {
    await serveHealth(page, 'ffffffff');
    await page.goto('/?widget=1');
    await skipUnlessStamped(page);

    await expect(page.getByTestId('widget-setup')).toBeVisible();
    await expect(page.getByTestId('update-banner')).toBeVisible();
    await expect(page.getByTestId('update-banner')).toContainText('업데이트');
  });

  test('배포와 같은 커밋이면 아무것도 뜨지 않는다', async ({ page }) => {
    await serveHealth(page, process.env.E2E_BUILD_ID ?? 'aaaaaaaa');
    await page.goto('/?widget=1');
    await skipUnlessStamped(page);

    await expect(page.getByTestId('widget-setup')).toBeVisible();
    await expect(page.getByTestId('update-banner')).toHaveCount(0);
  });

  test('전체 화면에서도 뜨고, 누르면 페이지를 다시 읽는다', async ({ page }) => {
    await serveHealth(page, 'ffffffff');
    await page.goto('/');
    await skipUnlessStamped(page);

    const banner = page.getByTestId('update-banner');
    await expect(banner).toBeVisible();

    // 새로고침이 실제로 일어나는지: 리로드로 사라지는 표식을 심어 두고 확인한다.
    await page.evaluate(() => {
      (window as unknown as { __beforeReload?: boolean }).__beforeReload = true;
    });
    await Promise.all([page.waitForLoadState('load'), banner.click()]);
    const survived = await page.evaluate(
      () => (window as unknown as { __beforeReload?: boolean }).__beforeReload === true,
    );
    expect(survived).toBe(false);
  });
});
