/**
 * 주간 / 월간 집계.
 *
 * 모든 값은 저장된 이벤트에서 매번 다시 계산한다 (캐시된 합계를 쓰지 않는다).
 * 진행 중인 근무도 `now` 기준으로 즉시 반영된다.
 */

import { computeDay, emptyDayLog, type DayLog, type DayTotals } from './events';
import { monthDateKeys, startOfWeek, toDateKey, toMonthKey, weekDateKeys } from './time';

export interface PeriodTotals {
  actualMs: number;
  awayMs: number;
  vacationMs: number;
  creditedMs: number;
  /** 실제로 근무한 날의 수 (실제 근무 또는 휴가가 있는 날) */
  workedDays: number;
}

export interface WeekSummary extends PeriodTotals {
  /** 주 시작(월요일) dateKey */
  weekStart: string;
  /** 월~일 7일치. 기록이 없는 날도 0 으로 채워 넣는다. */
  days: DayTotals[];
}

export interface MonthSummary extends PeriodTotals {
  monthKey: string;
  days: DayTotals[];
}

function totalsFor(logs: Record<string, DayLog>, dateKeys: string[], now: number): DayTotals[] {
  return dateKeys.map((dateKey) => computeDay(logs[dateKey] ?? emptyDayLog(dateKey), now));
}

function reduceTotals(days: DayTotals[]): PeriodTotals {
  return days.reduce<PeriodTotals>(
    (acc, d) => ({
      actualMs: acc.actualMs + d.actualMs,
      awayMs: acc.awayMs + d.awayMs,
      vacationMs: acc.vacationMs + d.vacationMs,
      creditedMs: acc.creditedMs + d.creditedMs,
      workedDays: acc.workedDays + (d.actualMs > 0 || d.vacationMs > 0 ? 1 : 0),
    }),
    { actualMs: 0, awayMs: 0, vacationMs: 0, creditedMs: 0, workedDays: 0 },
  );
}

/** 지정 날짜가 포함된 주(월~일, KST)의 집계 */
export function summarizeWeek(
  logs: Record<string, DayLog>,
  now: number,
  anchorDateKey = toDateKey(now),
): WeekSummary {
  const dateKeys = weekDateKeys(anchorDateKey);
  const days = totalsFor(logs, dateKeys, now);
  return { weekStart: startOfWeek(anchorDateKey), days, ...reduceTotals(days) };
}

/**
 * 근무 타이머 앱이 실제로 쓰이기 시작한 날짜(KST). 이보다 이전 기록은 앱이 만들어지기
 * 전에 다른 경로로 들어온 값이라 월간 합계에 넣으면 안 된다.
 */
export const MONTHLY_AGGREGATION_START = '2026-08-10';

/** 지정 월(KST)의 집계. 앱 시작일(MONTHLY_AGGREGATION_START) 이전 날짜는 제외한다. */
export function summarizeMonth(
  logs: Record<string, DayLog>,
  now: number,
  monthKey = toMonthKey(now),
): MonthSummary {
  const dateKeys = monthDateKeys(monthKey).filter((key) => key >= MONTHLY_AGGREGATION_START);
  const days = totalsFor(logs, dateKeys, now);
  return { monthKey, days, ...reduceTotals(days) };
}
