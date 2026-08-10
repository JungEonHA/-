import { expect, test, type Page } from '@playwright/test';

/**
 * 실제 브라우저에서의 종단 검증.
 *
 * 시간은 Playwright 의 가상 시계(page.clock)로 제어한다. 실제 시간을 기다리지 않으면서도
 * "탭 백그라운드", "컴퓨터 절전"처럼 타이머 콜백이 실행되지 않는 상황을 그대로 재현할 수 있다.
 *
 *  - clock.fastForward : 시계를 앞으로 감는다 (백그라운드 throttling 에 해당)
 *  - clock.setSystemTime : 타이머를 하나도 실행하지 않고 시각만 점프시킨다 (절전/복귀에 해당)
 */

/** 2026-08-10(월) 09:00 KST = 2026-08-10T00:00:00Z */
const START = new Date('2026-08-10T00:00:00.000Z');

async function boot(page: Page) {
  await page.clock.install({ time: START });
  await page.goto('/');
  await expect(page.getByTestId('btn-clock-in')).toBeVisible();
}

/** 절전 시뮬레이션: 타이머를 돌리지 않고 시각만 뛰게 한 뒤 복귀 이벤트를 보낸다. */
async function suspendAndWake(page: Page, msAhead: number) {
  const target = await page.evaluate(() => Date.now());
  await page.clock.setSystemTime(new Date(target + msAhead));
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
}

test.describe('출퇴근 타이머', () => {
  test('출근하면 실시간으로 근무시간이 증가한다', async ({ page }) => {
    await boot(page);

    await expect(page.getByTestId('status-chip')).toHaveText(/출근 전/);
    await expect(page.getByTestId('work-timer')).toHaveText('00:00:00');

    await page.getByTestId('btn-clock-in').click();

    await expect(page.getByTestId('status-chip')).toHaveText(/근무 중/);
    await expect(page.getByTestId('clock-in-at')).toHaveText('09:00');

    await page.clock.fastForward('01:30:15');
    await expect(page.getByTestId('work-timer')).toHaveText('01:30:15');

    await page.clock.fastForward('06:12:16');
    await expect(page.getByTestId('work-timer')).toHaveText('07:42:31');
  });

  test('자리 비움은 근무시간을 멈추고 자리비움 시간만 늘린다', async ({ page }) => {
    await boot(page);
    await page.getByTestId('btn-clock-in').click();

    await page.clock.fastForward('03:00:00');
    await expect(page.getByTestId('work-timer')).toHaveText('03:00:00');

    await page.getByTestId('btn-away-start').click();
    await expect(page.getByTestId('status-chip')).toHaveText(/자리 비움/);

    await page.clock.fastForward('01:00:00');
    await expect(page.getByTestId('work-timer')).toHaveText('03:00:00'); // 멈춤
    await expect(page.getByTestId('away-total')).toHaveText('01:00:00');

    await page.clock.fastForward('00:30:00');
    await expect(page.getByTestId('work-timer')).toHaveText('03:00:00');
    await expect(page.getByTestId('away-total')).toHaveText('01:30:00');
  });

  test('복귀하면 근무시간 측정이 재개된다', async ({ page }) => {
    await boot(page);
    await page.getByTestId('btn-clock-in').click();
    await page.clock.fastForward('03:00:00');
    await page.getByTestId('btn-away-start').click();
    await page.clock.fastForward('01:00:00');

    await page.getByTestId('btn-away-end').click();
    await expect(page.getByTestId('status-chip')).toHaveText(/근무 중/);

    await page.clock.fastForward('02:00:00');
    await expect(page.getByTestId('work-timer')).toHaveText('05:00:00');
    await expect(page.getByTestId('away-total')).toHaveText('01:00:00');
  });

  test('사양 예시대로 09-12-13-18 근무는 정확히 8시간이다', async ({ page }) => {
    await boot(page);

    await page.getByTestId('btn-clock-in').click(); // 09:00
    await page.clock.fastForward('03:00:00');
    await page.getByTestId('btn-away-start').click(); // 12:00
    await page.clock.fastForward('01:00:00');
    await page.getByTestId('btn-away-end').click(); // 13:00
    await page.clock.fastForward('05:00:00');
    await page.getByTestId('btn-clock-out').click(); // 18:00

    await expect(page.getByTestId('status-chip')).toHaveText(/퇴근 완료/);
    await expect(page.getByTestId('work-timer')).toHaveText('08:00:00');
    await expect(page.getByTestId('clock-out-at')).toHaveText('18:00');
    await expect(page.getByTestId('today-actual')).toHaveText('8시간');
    await expect(page.getByTestId('today-credited')).toHaveText('8시간');
    await expect(page.getByTestId('btn-finished')).toBeDisabled();
  });

  test('퇴근 후에는 시간이 더 이상 늘지 않는다', async ({ page }) => {
    await boot(page);
    await page.getByTestId('btn-clock-in').click();
    await page.clock.fastForward('08:00:00');
    await page.getByTestId('btn-clock-out').click();

    await page.clock.fastForward('05:00:00');
    await expect(page.getByTestId('work-timer')).toHaveText('08:00:00');
  });

  test('퇴근을 잘못 눌렀으면 복귀해서 이어서 일할 수 있다', async ({ page }) => {
    await boot(page);
    await page.getByTestId('btn-clock-in').click(); // 09:00
    await page.clock.fastForward('03:00:00');
    await page.getByTestId('btn-clock-out').click(); // 12:00 — 실수

    await page.clock.fastForward('01:00:00'); // 13:00
    await page.getByTestId('btn-resume').click();

    await expect(page.getByTestId('status-chip')).toHaveText(/근무 중/);
    await expect(page.getByTestId('clock-out-at')).toHaveText('--:--');

    await page.clock.fastForward('02:00:00'); // 15:00
    // 09~12 (3시간) + 13~15 (2시간). 퇴근해 있던 1시간은 빠진다.
    await expect(page.getByTestId('work-timer')).toHaveText('05:00:00');
    await expect(page.getByTestId('resume-note')).toContainText('1회 복귀');
  });
});

test.describe('상태 복구', () => {
  test('새로고침해도 근무 상태와 경과시간이 복구된다', async ({ page }) => {
    await boot(page);
    await page.getByTestId('btn-clock-in').click();
    await page.clock.fastForward('02:34:56');
    await expect(page.getByTestId('work-timer')).toHaveText('02:34:56');

    await page.reload();

    await expect(page.getByTestId('status-chip')).toHaveText(/근무 중/);
    await expect(page.getByTestId('work-timer')).toHaveText('02:34:56');
    await expect(page.getByTestId('clock-in-at')).toHaveText('09:00');

    await page.clock.fastForward('00:05:04');
    await expect(page.getByTestId('work-timer')).toHaveText('02:40:00');
  });

  test('자리 비움 상태도 새로고침 후 유지된다', async ({ page }) => {
    await boot(page);
    await page.getByTestId('btn-clock-in').click();
    await page.clock.fastForward('02:00:00');
    await page.getByTestId('btn-away-start').click();
    await page.clock.fastForward('00:45:00');

    await page.reload();

    await expect(page.getByTestId('status-chip')).toHaveText(/자리 비움/);
    await expect(page.getByTestId('work-timer')).toHaveText('02:00:00');
    await expect(page.getByTestId('away-total')).toHaveText('00:45:00');
    await expect(page.getByTestId('btn-away-end')).toBeVisible();
  });

  test('탭이 백그라운드에 있는 동안 흐른 시간도 정확히 반영된다', async ({ page }) => {
    await boot(page);
    await page.getByTestId('btn-clock-in').click();

    // 탭을 숨기고 4시간이 지난 상황
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.fastForward('04:00:00');

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await expect(page.getByTestId('work-timer')).toHaveText('04:00:00');
  });

  test('컴퓨터 절전 후 복귀해도 실제 경과시간이 그대로 반영된다', async ({ page }) => {
    await boot(page);
    await page.getByTestId('btn-clock-in').click();
    await page.clock.fastForward('01:00:00');
    await expect(page.getByTestId('work-timer')).toHaveText('01:00:00');

    // 타이머 콜백이 한 번도 실행되지 않은 채 6시간 점프 (절전)
    await suspendAndWake(page, 6 * 60 * 60 * 1000);

    await expect(page.getByTestId('work-timer')).toHaveText('07:00:00');
  });

  test('자리 비움 중 절전하면 자리비움 시간만 늘어난다', async ({ page }) => {
    await boot(page);
    await page.getByTestId('btn-clock-in').click();
    await page.clock.fastForward('02:00:00');
    await page.getByTestId('btn-away-start').click();

    await suspendAndWake(page, 3 * 60 * 60 * 1000);

    await expect(page.getByTestId('work-timer')).toHaveText('02:00:00');
    await expect(page.getByTestId('away-total')).toHaveText('03:00:00');
  });
});

test.describe('휴가', () => {
  test('휴가를 사용하면 잔여가 줄고 인정 근무시간에 합산된다', async ({ page }) => {
    await boot(page);

    await page.getByTestId('tab-vacation').click();
    await expect(page.getByTestId('vac-granted')).toHaveText('8시간');
    await expect(page.getByTestId('vac-carried')).toHaveText('0분');
    await expect(page.getByTestId('vac-available')).toHaveText('8시간');
    await expect(page.getByTestId('vac-remaining')).toHaveText('8시간');

    await page.getByTestId('vac-preset-4').click();
    await page.getByTestId('btn-vac-use').click();

    await expect(page.getByTestId('vac-used')).toHaveText('4시간');
    await expect(page.getByTestId('vac-remaining')).toHaveText('4시간');

    await page.getByTestId('tab-home').click();
    await expect(page.getByTestId('today-vacation')).toHaveText('4시간');
    await expect(page.getByTestId('today-credited')).toHaveText('4시간');
    await expect(page.getByTestId('today-actual')).toHaveText('0분');
  });

  test('실제 근무와 휴가가 합쳐져 인정 근무시간이 된다', async ({ page }) => {
    await boot(page);
    await page.getByTestId('btn-clock-in').click();
    await page.clock.fastForward('04:00:00');
    await page.getByTestId('btn-clock-out').click();

    await page.getByTestId('tab-vacation').click();
    await page.getByTestId('vac-preset-4').click();
    await page.getByTestId('btn-vac-use').click();

    await page.getByTestId('tab-home').click();
    await expect(page.getByTestId('today-actual')).toHaveText('4시간');
    await expect(page.getByTestId('today-vacation')).toHaveText('4시간');
    await expect(page.getByTestId('today-credited')).toHaveText('8시간');
  });

  test('휴가를 취소하면 잔여가 복구된다', async ({ page }) => {
    await boot(page);
    await page.getByTestId('tab-vacation').click();

    await page.getByTestId('vac-preset-4').click();
    await page.getByTestId('btn-vac-use').click();
    await expect(page.getByTestId('vac-remaining')).toHaveText('4시간');

    await page.getByTestId('vac-preset-2').click();
    await page.getByTestId('btn-vac-cancel').click();

    await expect(page.getByTestId('vac-used')).toHaveText('2시간');
    await expect(page.getByTestId('vac-remaining')).toHaveText('6시간');
  });

  test('잔여를 초과해 사용하면 거부하고 값이 바뀌지 않는다', async ({ page }) => {
    await boot(page);
    await page.getByTestId('tab-vacation').click();

    await page.getByTestId('vac-preset-8').click();
    await page.getByTestId('btn-vac-use').click();
    await expect(page.getByTestId('vac-remaining')).toHaveText('0분');

    // 다른 날짜에 추가 사용 시도 -> 잔여 0 이므로 거부
    await page.getByTestId('vac-date').fill('2026-08-11');
    await page.getByTestId('vac-preset-1').click();
    await page.getByTestId('btn-vac-use').click();

    await expect(page.getByTestId('toast')).toContainText('잔여 휴가가 부족');
    await expect(page.getByTestId('vac-used')).toHaveText('8시간');
  });

  test('사용하지 않은 휴가는 다음 달로 이월된다', async ({ page }) => {
    await boot(page);
    await page.getByTestId('tab-vacation').click();

    // 8월에 3시간 사용
    await page.getByTestId('vac-preset-2').click();
    await page.getByTestId('btn-vac-use').click();
    await page.getByTestId('vac-preset-1').click();
    await page.getByTestId('btn-vac-use').click();
    await expect(page.getByTestId('vac-used')).toHaveText('3시간');

    // 9월로 이동: 이월 5시간 + 지급 8시간 = 13시간
    await page.getByLabel('다음 달').click();
    await expect(page.getByTestId('vac-carried')).toHaveText('5시간');
    await expect(page.getByTestId('vac-granted')).toHaveText('8시간');
    await expect(page.getByTestId('vac-available')).toHaveText('13시간');
    await expect(page.getByTestId('vac-remaining')).toHaveText('13시간');
  });
});

test.describe('주간 / 월간 집계', () => {
  test('근무한 날이 주간·월간 집계에 반영된다', async ({ page }) => {
    await boot(page);

    await page.getByTestId('btn-clock-in').click();
    await page.clock.fastForward('09:00:00'); // 09:00 -> 18:00
    await page.getByTestId('btn-clock-out').click();

    await page.getByTestId('tab-summary').click();

    await expect(page.getByTestId('sum-week-actual')).toHaveText('9시간');
    await expect(page.getByTestId('sum-week-credited')).toHaveText('9시간');
    await expect(page.getByTestId('sum-month-actual')).toHaveText('9시간');
    await expect(page.getByTestId('month-detail')).toContainText('08-10');
  });

  test('여러 날의 근무와 휴가가 누적된다', async ({ page }) => {
    await boot(page);

    // 8/10 (월) 8시간 근무
    await page.getByTestId('btn-clock-in').click();
    await page.clock.fastForward('08:00:00');
    await page.getByTestId('btn-clock-out').click();

    // 8/11 (화) 09:00 으로 이동해 7시간 근무
    await page.clock.fastForward('17:00:00'); // 17:00 -> 다음날 10:00... 아래에서 보정
    await page.reload();
    await page.getByTestId('btn-clock-in').click();
    await page.clock.fastForward('07:00:00');
    await page.getByTestId('btn-clock-out').click();

    // 8/11 에 1시간 휴가
    await page.getByTestId('tab-vacation').click();
    await page.getByTestId('vac-preset-1').click();
    await page.getByTestId('btn-vac-use').click();

    await page.getByTestId('tab-summary').click();
    await expect(page.getByTestId('sum-week-actual')).toHaveText('15시간');
    await expect(page.getByTestId('sum-week-vacation')).toHaveText('1시간');
    await expect(page.getByTestId('sum-week-credited')).toHaveText('16시간');
    await expect(page.getByTestId('sum-month-credited')).toHaveText('16시간');
  });
});

test.describe('Notion 연동 UI', () => {
  test('백엔드가 없으면 안내만 하고 기록 기능은 계속 동작한다', async ({ page }) => {
    await boot(page);
    await page.getByTestId('btn-clock-in').click();
    await page.clock.fastForward('01:00:00');

    await page.getByTestId('tab-settings').click();
    await expect(page.locator('.banner')).toContainText(/백엔드|NOTION_TOKEN/);

    // 대기열에는 남아 있고, 홈의 타이머는 계속 정상 동작
    await page.getByTestId('tab-home').click();
    await expect(page.getByTestId('work-timer')).toHaveText('01:00:00');
  });

  test('매핑 전에는 스키마 안내를 보여준다', async ({ page }) => {
    await boot(page);
    await page.getByTestId('tab-settings').click();
    await expect(page.getByText('Property 매핑')).toBeVisible();
    await expect(page.locator('.empty').first()).toContainText('실제 Property 목록');
  });
});

test.describe('반응형 레이아웃', () => {
  test('탭 네비게이션이 모든 화면 폭에서 동작한다', async ({ page }) => {
    await boot(page);

    for (const size of [
      { width: 360, height: 720 },
      { width: 768, height: 1024 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(size);
      await page.getByTestId('tab-summary').click();
      await expect(page.getByTestId('week-chart')).toBeVisible();
      await page.getByTestId('tab-home').click();
      await expect(page.getByTestId('work-timer')).toBeVisible();

      // 가로 스크롤이 생기면 Notion Embed 안에서 잘려 보인다
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `가로 스크롤 발생 @${size.width}px`).toBeLessThanOrEqual(1);
    }
  });
});
