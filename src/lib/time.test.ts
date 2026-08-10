import { describe, expect, it } from 'vitest';
import {
  addMonths,
  dateKeyToEpoch,
  dayOfWeek,
  formatClock,
  formatDateKeyKo,
  formatDuration,
  formatDurationKo,
  monthDateKeys,
  monthDiff,
  msToHours,
  shiftDateKey,
  startOfWeek,
  toDateKey,
  toKstIso,
  toMonthKey,
  weekDateKeys,
  HOUR_MS,
} from './time';

/** 2026-08-09 09:00 KST = 2026-08-09T00:00:00Z */
const AUG9_0900_KST = Date.UTC(2026, 7, 9, 0, 0, 0);

describe('KST 날짜 변환', () => {
  it('UTC 자정 직후는 KST 로 같은 날 09시다', () => {
    expect(toDateKey(Date.UTC(2026, 7, 9, 0, 0, 0))).toBe('2026-08-09');
    expect(formatClock(Date.UTC(2026, 7, 9, 0, 0, 0))).toBe('09:00');
  });

  it('UTC 15:00 부터는 KST 로 다음 날이다 (경계 검증)', () => {
    expect(toDateKey(Date.UTC(2026, 7, 9, 14, 59, 59))).toBe('2026-08-09');
    expect(toDateKey(Date.UTC(2026, 7, 9, 15, 0, 0))).toBe('2026-08-10');
    expect(formatClock(Date.UTC(2026, 7, 9, 15, 0, 0))).toBe('00:00');
  });

  it('dateKey <-> epoch 왕복이 일치한다', () => {
    for (const key of ['2026-01-01', '2026-02-28', '2024-02-29', '2026-12-31']) {
      expect(toDateKey(dateKeyToEpoch(key))).toBe(key);
    }
  });

  it('KST 자정의 epoch 는 UTC 전날 15:00 이다', () => {
    expect(dateKeyToEpoch('2026-08-09')).toBe(Date.UTC(2026, 7, 8, 15, 0, 0));
  });

  it('서머타임이 있는 지역과 달리 연중 오프셋이 일정하다', () => {
    // 북반구 여름/겨울 모두 +09:00 이어야 한다.
    expect(toKstIso(Date.UTC(2026, 0, 15, 3, 0, 0))).toBe('2026-01-15T12:00:00+09:00');
    expect(toKstIso(Date.UTC(2026, 6, 15, 3, 0, 0))).toBe('2026-07-15T12:00:00+09:00');
  });
});

describe('주/월 계산', () => {
  it('주는 월요일에 시작한다', () => {
    expect(startOfWeek('2026-08-09')).toBe('2026-08-03'); // 일요일 -> 그 주 월요일
    expect(startOfWeek('2026-08-10')).toBe('2026-08-10'); // 월요일
    expect(startOfWeek('2026-08-15')).toBe('2026-08-10'); // 토요일
  });

  it('주간 7일이 월~일 순서로 나온다', () => {
    expect(weekDateKeys('2026-08-12')).toEqual([
      '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13',
      '2026-08-14', '2026-08-15', '2026-08-16',
    ]);
  });

  it('요일 계산이 맞다', () => {
    expect(dayOfWeek('2026-08-09')).toBe(0); // 일
    expect(dayOfWeek('2026-08-10')).toBe(1); // 월
  });

  it('월 이동과 차이 계산', () => {
    expect(addMonths('2026-01', 1)).toBe('2026-02');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(monthDiff('2026-01', '2026-03')).toBe(2);
    expect(monthDiff('2025-11', '2026-02')).toBe(3);
    expect(monthDiff('2026-05', '2026-05')).toBe(0);
    expect(monthDiff('2026-05', '2026-03')).toBe(-2);
  });

  it('윤년 2월은 29일이다', () => {
    expect(monthDateKeys('2024-02')).toHaveLength(29);
    expect(monthDateKeys('2026-02')).toHaveLength(28);
    expect(monthDateKeys('2026-08')).toHaveLength(31);
  });

  it('월 경계를 넘어 날짜를 이동한다', () => {
    expect(shiftDateKey('2026-08-31', 1)).toBe('2026-09-01');
    expect(shiftDateKey('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('포맷', () => {
  it('소요시간은 HH:MM:SS 이며 24시간을 넘으면 시가 늘어난다', () => {
    expect(formatDuration(0)).toBe('00:00:00');
    expect(formatDuration(HOUR_MS * 7 + 42 * 60_000 + 31_000)).toBe('07:42:31');
    expect(formatDuration(HOUR_MS * 26 + 3 * 60_000 + 11_000)).toBe('26:03:11');
  });

  it('음수는 0으로 처리한다', () => {
    expect(formatDuration(-5000)).toBe('00:00:00');
  });

  it('한글 요약 포맷', () => {
    expect(formatDurationKo(0)).toBe('0분');
    expect(formatDurationKo(30 * 60_000)).toBe('30분');
    expect(formatDurationKo(HOUR_MS * 8)).toBe('8시간');
    expect(formatDurationKo(HOUR_MS * 8 + 30 * 60_000)).toBe('8시간 30분');
  });

  it('시간 단위 소수 변환은 소수점 2자리', () => {
    expect(msToHours(HOUR_MS * 8)).toBe(8);
    expect(msToHours(HOUR_MS * 7.5)).toBe(7.5);
    expect(msToHours(HOUR_MS / 3)).toBe(0.33);
  });

  it('날짜 한글 표기', () => {
    expect(formatDateKeyKo('2026-08-09')).toBe('8월 9일(일)');
    expect(toMonthKey(AUG9_0900_KST)).toBe('2026-08');
  });
});
