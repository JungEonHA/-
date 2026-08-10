/**
 * DayTotals -> Notion 으로 보낼 하루치 페이로드 변환.
 * 서버(api/_notion.ts)의 DayRecordPayload 와 형태가 같아야 한다.
 */

import type { DayTotals } from './events';
import { formatClock, msToHours, toKstIso } from './time';

export interface DayRecordPayload {
  date: string;
  /** 이 기록의 주인. 여러 명이 같은 DB를 쓸 때 행을 가르는 두 번째 기준. */
  employeeName: string | null;
  clockInIso: string | null;
  clockOutIso: string | null;
  clockInText: string | null;
  clockOutText: string | null;
  actualHours: number;
  awayHours: number;
  vacationHours: number;
  creditedHours: number;
  statusText: string;
}

export function notionStatusText(totals: DayTotals): string {
  if (totals.status === 'finished') {
    return totals.actualMs === 0 && totals.vacationMs > 0 ? '휴가' : '퇴근 완료';
  }
  if (totals.status === 'working') return '근무 중';
  if (totals.status === 'away') return '자리 비움';
  return totals.vacationMs > 0 ? '휴가' : '출근 전';
}

export function buildRecord(totals: DayTotals, employeeName: string | null = null): DayRecordPayload {
  return {
    date: totals.date,
    employeeName: employeeName?.trim() ? employeeName.trim() : null,
    clockInIso: totals.clockInAt === null ? null : toKstIso(totals.clockInAt),
    clockOutIso: totals.clockOutAt === null ? null : toKstIso(totals.clockOutAt),
    clockInText: totals.clockInAt === null ? null : formatClock(totals.clockInAt),
    clockOutText: totals.clockOutAt === null ? null : formatClock(totals.clockOutAt),
    actualHours: msToHours(totals.actualMs),
    awayHours: msToHours(totals.awayMs),
    vacationHours: msToHours(totals.vacationMs),
    creditedHours: msToHours(totals.creditedMs),
    statusText: notionStatusText(totals),
  };
}
