/**
 * 휴가 원장(ledger).
 *
 * 규칙
 *  - 매월 정해진 시간(기본 8시간)이 지급된다.
 *  - 그 밖에 사유를 달아 **특별 부여**한 시간이 더해진다 (전시 참가·천재지변 등).
 *    월 지급량을 올리는 것과 달리 그 달 한 번만 얹히고, 부여 내역은 Notion 에 남는다.
 *  - 쓰지 않은 휴가는 다음 달로 **이월**된다 (소멸 없음).
 *  - 사용 내역은 DayLog.vacationMs 에 날짜별로 저장된다 — 별도 원장을 두지 않아
 *    "근무기록"과 "휴가사용"이 어긋날 여지를 없앤다.
 *  - 잔여량은 항상 지급 누계 − 사용 누계로 다시 계산한다 (running balance 를
 *    따로 저장하지 않으므로 드리프트가 발생하지 않는다).
 *
 * 예) 1월 지급 8h, 1월 사용 3h → 잔여 5h.  2월 지급 8h → 2월 사용 가능 13h.
 */

import type { DayLog } from './events';
import type { VacationGrant } from '../../shared/grants';
import { grantedExtraIn, grantedExtraThrough } from '../../shared/grants';
import { HOUR_MS, addMonths, monthDiff, toMonthKey } from './time';

export const DEFAULT_MONTHLY_GRANT_MS = 8 * HOUR_MS;
export const DEFAULT_DAILY_VACATION_CAP_MS = 8 * HOUR_MS;

export interface VacationConfig {
  /** 지급이 시작되는 달 "YYYY-MM" */
  grantStartMonth: string;
  /** 매월 지급량 (ms) */
  monthlyGrantMs: number;
  /** 하루에 사용할 수 있는 최대 휴가 (ms) */
  dailyCapMs: number;
}

export interface VacationBalance {
  monthKey: string;
  /** 이번 달 지급 (정기) */
  grantedThisMonth: number;
  /** 이번 달 특별 부여 (사유가 붙은 추가 지급) */
  extraThisMonth: number;
  /** 이월 (이전 달까지의 지급+부여 누계 − 사용 누계) */
  carriedIn: number;
  /** 사용 가능 = 이월 + 이번 달 지급 + 이번 달 특별 부여 */
  available: number;
  /** 이번 달 사용 */
  usedThisMonth: number;
  /** 잔여 = 사용 가능 − 이번 달 사용 */
  remaining: number;
}

/** grantStartMonth 부터 monthKey(포함)까지의 지급 누계 */
export function grantedThrough(config: VacationConfig, monthKey: string): number {
  const months = monthDiff(config.grantStartMonth, monthKey) + 1;
  return months <= 0 ? 0 : months * config.monthlyGrantMs;
}

/** 날짜별 휴가 사용량 합계. `predicate` 로 범위를 좁힌다. */
function sumVacation(logs: Record<string, DayLog>, predicate: (dateKey: string) => boolean): number {
  let total = 0;
  for (const [dateKey, log] of Object.entries(logs)) {
    if (!log) continue;
    if (predicate(dateKey)) total += Math.max(0, log.vacationMs || 0);
  }
  return total;
}

export function computeBalance(
  logs: Record<string, DayLog>,
  config: VacationConfig,
  monthKey: string,
  grants: VacationGrant[] = [],
): VacationBalance {
  const prevMonth = addMonths(monthKey, -1);
  const monthPrefix = `${monthKey}-`;

  // 이월분에도 지난달까지의 특별 부여가 포함돼야 한다. 빠뜨리면 전달에 부여한
  // 휴가가 그 달을 넘기는 순간 사라져 버린다.
  const grantedBefore = grantedThrough(config, prevMonth) + grantedExtraThrough(grants, prevMonth);
  const usedBefore = sumVacation(logs, (d) => d.slice(0, 7) < monthKey);
  const carriedIn = grantedBefore - usedBefore;

  const grantedThisMonth =
    monthDiff(config.grantStartMonth, monthKey) >= 0 ? config.monthlyGrantMs : 0;
  const extraThisMonth = grantedExtraIn(grants, monthKey);

  const usedThisMonth = sumVacation(logs, (d) => d.startsWith(monthPrefix));
  const available = carriedIn + grantedThisMonth + extraThisMonth;

  return {
    monthKey,
    grantedThisMonth,
    extraThisMonth,
    carriedIn,
    available,
    usedThisMonth,
    remaining: available - usedThisMonth,
  };
}

export interface VacationChangeOk {
  ok: true;
  /** 이 날짜에 최종적으로 기록될 휴가 시간 */
  nextDayVacationMs: number;
}
export interface VacationChangeError {
  ok: false;
  reason: string;
}
export type VacationChangeResult = VacationChangeOk | VacationChangeError;

/**
 * 특정 날짜에 휴가를 `deltaMs` 만큼 추가(양수)하거나 취소(음수)할 수 있는지 검사한다.
 * 검증만 하고 상태는 바꾸지 않는다 — 호출부가 결과로 상태를 갱신한다.
 */
export function planVacationChange(
  logs: Record<string, DayLog>,
  config: VacationConfig,
  dateKey: string,
  deltaMs: number,
  grants: VacationGrant[] = [],
): VacationChangeResult {
  if (!Number.isFinite(deltaMs) || deltaMs === 0) {
    return { ok: false, reason: '변경할 휴가 시간을 선택하세요.' };
  }

  const current = Math.max(0, logs[dateKey]?.vacationMs ?? 0);
  const next = current + deltaMs;

  if (next < 0) {
    return {
      ok: false,
      reason: `취소할 휴가가 부족합니다. (해당 일자 사용량 ${current / HOUR_MS}시간)`,
    };
  }
  if (next > config.dailyCapMs) {
    return {
      ok: false,
      reason: `하루 최대 ${config.dailyCapMs / HOUR_MS}시간까지만 사용할 수 있습니다.`,
    };
  }

  if (deltaMs > 0) {
    const monthKey = dateKey.slice(0, 7);
    const balance = computeBalance(logs, config, monthKey, grants);
    if (deltaMs > balance.remaining) {
      return {
        ok: false,
        reason: `잔여 휴가가 부족합니다. (잔여 ${round1(balance.remaining / HOUR_MS)}시간)`,
      };
    }
  }

  return { ok: true, nextDayVacationMs: next };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 최근 휴가 사용 내역 (최신순) */
export function vacationHistory(
  logs: Record<string, DayLog>,
  limit = 12,
): Array<{ dateKey: string; ms: number }> {
  return Object.entries(logs)
    .filter(([, log]) => (log?.vacationMs ?? 0) > 0)
    .map(([dateKey, log]) => ({ dateKey, ms: log!.vacationMs }))
    .sort((a, b) => (a.dateKey < b.dateKey ? 1 : -1))
    .slice(0, limit);
}

export function defaultVacationConfig(now: number): VacationConfig {
  return {
    grantStartMonth: toMonthKey(now),
    monthlyGrantMs: DEFAULT_MONTHLY_GRANT_MS,
    dailyCapMs: DEFAULT_DAILY_VACATION_CAP_MS,
  };
}
