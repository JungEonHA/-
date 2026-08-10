/**
 * 근무 이벤트 엔진.
 *
 * 설계 원칙 — 근무시간은 "카운터를 증가"시켜 구하지 않는다.
 * 출근/자리비움/복귀/퇴근의 **절대 시각(epoch ms)** 만 append-only 로 기록하고,
 * 표시 시점마다 그 타임스탬프들로부터 경과시간을 다시 계산한다.
 *
 * 이 방식의 결과:
 *  - 브라우저 백그라운드에서 타이머가 throttling 돼도 값이 어긋나지 않는다.
 *  - 새로고침/탭 종료 후 복귀해도 이벤트만 복원하면 상태가 그대로다.
 *  - 컴퓨터 절전(suspend) 후 깨어나도 실제 흐른 시간이 그대로 반영된다.
 *  - setInterval 은 오직 "화면을 다시 그리는" 용도이며 계산에 관여하지 않는다.
 */

import { DAY_MS, toDateKey } from './time';

export type WorkEventType = 'clock_in' | 'away_start' | 'away_end' | 'clock_out' | 'resume';

export interface WorkEvent {
  type: WorkEventType;
  /** epoch milliseconds (UTC 절대시각) */
  at: number;
}

export interface DayLog {
  /** KST 기준 "YYYY-MM-DD". 하나의 근무일(출근 시점의 날짜)을 의미한다. */
  date: string;
  /** 시간 오름차순으로 정렬된 이벤트 목록 */
  events: WorkEvent[];
  /** 이 날짜에 사용한 휴가 시간 (ms) */
  vacationMs: number;
  memo?: string;
}

export type WorkStatus = 'not_started' | 'working' | 'away' | 'finished';

export const STATUS_LABEL_KO: Record<WorkStatus, string> = {
  not_started: '출근 전',
  working: '근무 중',
  away: '자리 비움',
  finished: '퇴근 완료',
};

export interface DayTotals {
  date: string;
  status: WorkStatus;
  clockInAt: number | null;
  clockOutAt: number | null;
  /** 실제 근무시간 (자리비움 제외) */
  actualMs: number;
  /** 자리 비움 누적시간 */
  awayMs: number;
  /** 휴가 대체시간 */
  vacationMs: number;
  /** 인정 근무시간 = 실제 근무시간 + 휴가 대체시간 */
  creditedMs: number;
  /** 자리 비움 횟수 */
  awayCount: number;
  /** 퇴근 후 업무에 복귀한 횟수 */
  resumeCount: number;
  /**
   * 퇴근 ~ 업무 복귀 사이의 누적시간.
   * 근무시간도 자리 비움시간도 아니다 — "퇴근한 상태였던 시간"이므로 어디에도 합산하지 않는다.
   */
  pausedMs: number;
  /** 아직 진행 중인 구간이 있는지 (working | away) */
  isLive: boolean;
}

/** 세션이 이 시간을 넘게 열려 있으면 "퇴근을 잊었을 가능성" 경고 */
export const STALE_SESSION_MS = 20 * 60 * 60 * 1000;

export function emptyDayLog(date: string): DayLog {
  return { date, events: [], vacationMs: 0 };
}

/**
 * 이벤트 목록으로부터 실제 근무시간/자리비움시간을 계산한다.
 *
 * `now` 는 항상 호출부에서 주입한다(테스트 가능성). 시계 역행(clock skew)이나
 * 잘못 저장된 미래 이벤트로 음수 구간이 생기지 않도록 마지막 이벤트 시각으로 clamp 한다.
 */
export function computeDay(log: DayLog, now: number): DayTotals {
  const events = [...log.events].sort((a, b) => a.at - b.at);

  let actualMs = 0;
  let awayMs = 0;
  let awayCount = 0;
  let resumeCount = 0;
  let pausedMs = 0;
  let clockInAt: number | null = null;
  let clockOutAt: number | null = null;

  // 현재 열려 있는 구간의 시작 시각과 종류
  let openKind: 'work' | 'away' | null = null;
  let openSince = 0;

  for (const ev of events) {
    switch (ev.type) {
      case 'clock_in': {
        if (clockInAt !== null) break; // 중복 출근 무시
        clockInAt = ev.at;
        openKind = 'work';
        openSince = ev.at;
        break;
      }
      case 'away_start': {
        if (openKind !== 'work') break; // 근무 중이 아닐 때는 무시
        actualMs += Math.max(0, ev.at - openSince);
        openKind = 'away';
        openSince = ev.at;
        awayCount += 1;
        break;
      }
      case 'away_end': {
        if (openKind !== 'away') break;
        awayMs += Math.max(0, ev.at - openSince);
        openKind = 'work';
        openSince = ev.at;
        break;
      }
      case 'clock_out': {
        if (openKind === null || clockOutAt !== null) break;
        if (openKind === 'work') actualMs += Math.max(0, ev.at - openSince);
        else awayMs += Math.max(0, ev.at - openSince);
        clockOutAt = ev.at;
        openKind = null;
        break;
      }
      case 'resume': {
        // 퇴근을 잘못 눌렀거나 다시 일하게 된 경우. 퇴근 상태가 아니면 의미가 없다.
        if (clockOutAt === null) break;
        // 퇴근~복귀 사이는 근무도 자리 비움도 아니므로 별도로만 센다.
        pausedMs += Math.max(0, ev.at - clockOutAt);
        clockOutAt = null;
        openKind = 'work';
        openSince = ev.at;
        resumeCount += 1;
        break;
      }
    }
  }

  // 아직 열려 있는 구간은 "지금"까지로 계산한다.
  if (openKind !== null) {
    const effectiveNow = Math.max(now, openSince);
    if (openKind === 'work') actualMs += effectiveNow - openSince;
    else awayMs += effectiveNow - openSince;
  }

  const status: WorkStatus =
    clockInAt === null ? 'not_started'
      : clockOutAt !== null ? 'finished'
        : openKind === 'away' ? 'away'
          : 'working';

  const vacationMs = Math.max(0, log.vacationMs || 0);

  return {
    date: log.date,
    status,
    clockInAt,
    clockOutAt,
    actualMs,
    awayMs,
    vacationMs,
    creditedMs: actualMs + vacationMs,
    awayCount,
    resumeCount,
    pausedMs,
    isLive: openKind !== null,
  };
}

/** 진행 중(미퇴근) 세션이 비정상적으로 길게 열려 있는지 */
export function isStaleSession(totals: DayTotals, now: number): boolean {
  if (!totals.isLive || totals.clockInAt === null) return false;
  return now - totals.clockInAt > STALE_SESSION_MS;
}

// ---------------------------------------------------------------------------
// 상태 전이
// ---------------------------------------------------------------------------

export type ActionKind = 'clock_in' | 'away_start' | 'away_end' | 'clock_out' | 'resume';

export interface TransitionOk {
  ok: true;
  log: DayLog;
}
export interface TransitionError {
  ok: false;
  reason: string;
}
export type TransitionResult = TransitionOk | TransitionError;

const ALLOWED_FROM: Record<ActionKind, WorkStatus[]> = {
  clock_in: ['not_started'],
  away_start: ['working'],
  away_end: ['away'],
  clock_out: ['working', 'away'],
  resume: ['finished'],
};

const ACTION_LABEL_KO: Record<ActionKind, string> = {
  clock_in: '출근',
  away_start: '자리 비움',
  away_end: '복귀',
  clock_out: '퇴근',
  resume: '업무 복귀',
};

/**
 * 이벤트를 추가한다. 허용되지 않는 전이는 거부하고 이유를 돌려준다.
 * 원본 로그는 변경하지 않는다 (immutable).
 */
export function applyAction(log: DayLog, action: ActionKind, at: number): TransitionResult {
  const current = computeDay(log, at).status;
  if (!ALLOWED_FROM[action].includes(current)) {
    return {
      ok: false,
      reason: `현재 상태(${STATUS_LABEL_KO[current]})에서는 '${ACTION_LABEL_KO[action]}' 할 수 없습니다.`,
    };
  }

  // 시각 단조성 보장: 시스템 시계가 뒤로 갔더라도 이벤트 순서는 깨지지 않게 한다.
  const last = log.events.length > 0 ? log.events[log.events.length - 1]! .at : -Infinity;
  const stamped = Math.max(at, last);

  return {
    ok: true,
    log: { ...log, events: [...log.events, { type: action, at: stamped }] },
  };
}

/**
 * "지금 어느 날짜의 근무일을 다루고 있는가".
 *
 * 자정을 넘겨 근무 중이면 그 세션은 여전히 **출근한 날짜**에 귀속된다.
 * (22:00 출근 → 다음날 02:00 이면 계속 전날 근무일)
 * 열린 세션이 없으면 오늘(KST)이 활성 근무일이다.
 */
export function resolveActiveDate(logs: Record<string, DayLog>, now: number): string {
  const today = toDateKey(now);
  // 오늘과 어제만 확인하면 충분하다 — 그 이상 열려 있는 세션은 stale 경고로 처리.
  for (const candidate of [today, toDateKey(now - DAY_MS)]) {
    const log = logs[candidate];
    if (log && computeDay(log, now).isLive) return candidate;
  }
  return today;
}
