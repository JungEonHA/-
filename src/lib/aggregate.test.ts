import { describe, expect, it } from 'vitest';
import { summarizeMonth, summarizeWeek } from './aggregate';
import type { DayLog } from './events';
import { HOUR_MS, dateKeyToEpoch } from './time';

function day(date: string, startHour: number, endHour: number, vacationHours = 0): DayLog {
  const base = dateKeyToEpoch(date);
  return {
    date,
    vacationMs: vacationHours * HOUR_MS,
    events:
      startHour === endHour
        ? []
        : [
            { type: 'clock_in', at: base + startHour * HOUR_MS },
            { type: 'clock_out', at: base + endHour * HOUR_MS },
          ],
  };
}

/** 2026-08-10(월) ~ 08-16(일) 주 */
const LOGS: Record<string, DayLog> = {
  '2026-08-10': day('2026-08-10', 9, 18), // 월 9h
  '2026-08-11': day('2026-08-11', 9, 17), // 화 8h
  '2026-08-12': day('2026-08-12', 9, 13, 4), // 수 4h + 휴가 4h
  '2026-08-13': day('2026-08-13', 0, 0, 8), // 목 휴가 8h만
  '2026-08-14': day('2026-08-14', 10, 19), // 금 9h
  // 토·일 기록 없음
  '2026-08-03': day('2026-08-03', 9, 18), // 지난 주 (집계에서 제외되어야 함)
  '2026-09-01': day('2026-09-01', 9, 18), // 다음 달
};

const NOW = dateKeyToEpoch('2026-08-16') + 23 * HOUR_MS;

describe('주간 집계', () => {
  const week = summarizeWeek(LOGS, NOW, '2026-08-12');

  it('월요일부터 시작하는 7일을 담는다', () => {
    expect(week.weekStart).toBe('2026-08-10');
    expect(week.days).toHaveLength(7);
    expect(week.days.map((d) => d.date)).toEqual([
      '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13',
      '2026-08-14', '2026-08-15', '2026-08-16',
    ]);
  });

  it('기록이 없는 날은 0으로 채운다', () => {
    expect(week.days[5]!.actualMs).toBe(0);
    expect(week.days[6]!.status).toBe('not_started');
  });

  it('실제/휴가/인정 근무를 구분해 합산한다', () => {
    expect(week.actualMs).toBe(30 * HOUR_MS); // 9+8+4+0+9
    expect(week.vacationMs).toBe(12 * HOUR_MS); // 4+8
    expect(week.creditedMs).toBe(42 * HOUR_MS);
  });

  it('다른 주 기록은 포함하지 않는다', () => {
    expect(week.days.some((d) => d.date === '2026-08-03')).toBe(false);
  });

  it('휴가만 있는 날도 근무일로 센다', () => {
    expect(week.workedDays).toBe(5);
  });
});

describe('월간 집계', () => {
  const month = summarizeMonth(LOGS, NOW, '2026-08');

  it('해당 월의 모든 날짜를 담는다', () => {
    expect(month.days).toHaveLength(31);
  });

  it('월 전체 합계를 낸다 (8/3 지난주 포함, 9월 제외)', () => {
    expect(month.actualMs).toBe(39 * HOUR_MS); // 30 + 9(8/3)
    expect(month.vacationMs).toBe(12 * HOUR_MS);
    expect(month.creditedMs).toBe(51 * HOUR_MS);
    expect(month.workedDays).toBe(6);
  });

  it('다음 달은 별도로 집계된다', () => {
    const sep = summarizeMonth(LOGS, NOW, '2026-09');
    expect(sep.actualMs).toBe(9 * HOUR_MS);
    expect(sep.days).toHaveLength(30);
  });
});

describe('진행 중인 근무 반영', () => {
  it('아직 퇴근하지 않은 근무도 now 기준으로 집계에 포함된다', () => {
    const base = dateKeyToEpoch('2026-08-10');
    const logs = {
      '2026-08-10': {
        date: '2026-08-10',
        vacationMs: 0,
        events: [{ type: 'clock_in' as const, at: base + 9 * HOUR_MS }],
      },
    };
    const now = base + 14 * HOUR_MS;
    expect(summarizeWeek(logs, now, '2026-08-10').actualMs).toBe(5 * HOUR_MS);
    expect(summarizeMonth(logs, now, '2026-08').actualMs).toBe(5 * HOUR_MS);
  });
});
