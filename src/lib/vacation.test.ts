import { describe, expect, it } from 'vitest';
import { computeBalance, grantedThrough, planVacationChange, vacationHistory } from './vacation';
import type { DayLog } from './events';
import { HOUR_MS } from './time';

const CONFIG = {
  grantStartMonth: '2026-01',
  monthlyGrantMs: 8 * HOUR_MS,
  dailyCapMs: 8 * HOUR_MS,
};

function logsWith(entries: Record<string, number>): Record<string, DayLog> {
  return Object.fromEntries(
    Object.entries(entries).map(([date, hours]) => [
      date,
      { date, events: [], vacationMs: hours * HOUR_MS } satisfies DayLog,
    ]),
  );
}

describe('휴가 지급/이월', () => {
  it('지급 시작 월 이전에는 지급이 없다', () => {
    expect(grantedThrough(CONFIG, '2025-12')).toBe(0);
    expect(grantedThrough(CONFIG, '2025-06')).toBe(0);
  });

  it('지급 누계가 개월 수에 비례한다', () => {
    expect(grantedThrough(CONFIG, '2026-01')).toBe(8 * HOUR_MS);
    expect(grantedThrough(CONFIG, '2026-03')).toBe(24 * HOUR_MS);
    expect(grantedThrough(CONFIG, '2027-01')).toBe(104 * HOUR_MS); // 13개월
  });

  it('사양 예시: 1월 8h 지급 / 3h 사용 → 2월 사용 가능 13h', () => {
    const logs = logsWith({ '2026-01-15': 3 });

    const jan = computeBalance(logs, CONFIG, '2026-01');
    expect(jan.grantedThisMonth).toBe(8 * HOUR_MS);
    expect(jan.carriedIn).toBe(0);
    expect(jan.available).toBe(8 * HOUR_MS);
    expect(jan.usedThisMonth).toBe(3 * HOUR_MS);
    expect(jan.remaining).toBe(5 * HOUR_MS);

    const feb = computeBalance(logs, CONFIG, '2026-02');
    expect(feb.carriedIn).toBe(5 * HOUR_MS);
    expect(feb.grantedThisMonth).toBe(8 * HOUR_MS);
    expect(feb.available).toBe(13 * HOUR_MS);
    expect(feb.usedThisMonth).toBe(0);
    expect(feb.remaining).toBe(13 * HOUR_MS);
  });

  it('여러 달에 걸친 이월이 누적된다', () => {
    const logs = logsWith({ '2026-01-10': 2, '2026-02-10': 1, '2026-03-10': 4 });

    const apr = computeBalance(logs, CONFIG, '2026-04');
    // 1~3월 지급 24h, 사용 7h -> 이월 17h, 4월 지급 8h -> 25h
    expect(apr.carriedIn).toBe(17 * HOUR_MS);
    expect(apr.available).toBe(25 * HOUR_MS);
    expect(apr.remaining).toBe(25 * HOUR_MS);
  });

  it('한 달에 지급량보다 많이 써도 이월분에서 차감된다', () => {
    const logs = logsWith({ '2026-03-10': 8, '2026-03-11': 8 });
    const mar = computeBalance(logs, CONFIG, '2026-03');
    // 1,2월 미사용 16h 이월 + 3월 8h = 24h 사용가능, 16h 사용
    expect(mar.carriedIn).toBe(16 * HOUR_MS);
    expect(mar.available).toBe(24 * HOUR_MS);
    expect(mar.usedThisMonth).toBe(16 * HOUR_MS);
    expect(mar.remaining).toBe(8 * HOUR_MS);
  });

  it('잔여는 저장값이 아니라 매번 재계산되므로 드리프트가 없다', () => {
    const logs = logsWith({ '2026-01-05': 1, '2026-01-06': 1, '2026-01-07': 1 });
    const a = computeBalance(logs, CONFIG, '2026-06');
    const b = computeBalance(logs, CONFIG, '2026-06');
    expect(a).toEqual(b);
    // 1~6월 지급 48h − 사용 3h = 45h
    expect(a.remaining).toBe(45 * HOUR_MS);
  });
});

describe('휴가 사용/취소 검증', () => {
  it('잔여 범위 내에서는 사용할 수 있다', () => {
    const logs = logsWith({});
    const plan = planVacationChange(logs, CONFIG, '2026-01-20', 4 * HOUR_MS);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.nextDayVacationMs).toBe(4 * HOUR_MS);
  });

  it('잔여를 초과하면 거부한다', () => {
    const logs = logsWith({ '2026-01-10': 6 });
    const plan = planVacationChange(logs, CONFIG, '2026-01-20', 4 * HOUR_MS);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain('잔여 휴가가 부족');
  });

  it('하루 상한을 초과하면 거부한다', () => {
    const logs = logsWith({ '2026-02-10': 6 });
    // 잔여는 충분(1월 8h 이월 + 2월 8h - 6h = 10h)하지만 하루 상한 8h 초과
    const plan = planVacationChange(logs, CONFIG, '2026-02-10', 4 * HOUR_MS);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain('하루 최대');
  });

  it('사용한 만큼만 취소할 수 있다', () => {
    const logs = logsWith({ '2026-01-10': 3 });

    const ok = planVacationChange(logs, CONFIG, '2026-01-10', -2 * HOUR_MS);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.nextDayVacationMs).toBe(1 * HOUR_MS);

    const tooMuch = planVacationChange(logs, CONFIG, '2026-01-10', -5 * HOUR_MS);
    expect(tooMuch.ok).toBe(false);
  });

  it('취소하면 잔여가 복구되어 다시 쓸 수 있다', () => {
    const before = computeBalance(logsWith({ '2026-01-10': 8 }), CONFIG, '2026-01');
    const after = computeBalance(logsWith({ '2026-01-10': 0 }), CONFIG, '2026-01');
    expect(before.remaining).toBe(0);
    expect(after.remaining).toBe(8 * HOUR_MS);
  });

  it('0 또는 NaN 변경은 거부한다', () => {
    const logs = logsWith({});
    expect(planVacationChange(logs, CONFIG, '2026-01-10', 0).ok).toBe(false);
    expect(planVacationChange(logs, CONFIG, '2026-01-10', NaN).ok).toBe(false);
  });
});

describe('사용 내역', () => {
  it('최신순으로 반환하고 0시간은 제외한다', () => {
    const logs = logsWith({ '2026-01-10': 2, '2026-03-05': 1, '2026-02-02': 0 });
    const history = vacationHistory(logs);
    expect(history.map((h) => h.dateKey)).toEqual(['2026-03-05', '2026-01-10']);
  });
});
