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

import { DAY_MS, dateKeyToEpoch, toDateKey } from './time.js';
import type { TodoItem } from './todos.js';

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
  /**
   * 이 로그를 마지막으로 손댄 시각.
   *
   * 기기 간 병합에서 "덮어쓰는 값"(휴가시간·업무 리스트 등)의 승자를 정하는 기준이다.
   * 이벤트는 합집합으로 합치므로 이 값과 무관하다.
   */
  updatedAt?: number;
  memo?: string;
  /**
   * 그날의 업무 리스트.
   *
   * 이벤트와 달리 사람이 쓴 값이라 합집합이 성립하지 않는다 (같은 항목을 고친 건지
   * 새로 적은 건지 알 수 없다). 그래서 휴가시간과 같은 규칙 — 마지막에 손댄 기기가 이긴다.
   */
  todos?: TodoItem[];
  /**
   * 업무 리스트를 마지막으로 고친 시각.
   *
   * `updatedAt` 과 따로 두는 이유: 출퇴근을 누르면 updatedAt 이 갱신되는데, 그것만으로
   * 목록의 승자를 정하면 "다른 기기에서 퇴근만 눌렀는데 적어 둔 목록이 사라지는" 일이 생긴다.
   */
  todosAt?: number;
  /**
   * 근무시간 정정.
   *
   * 왜 필요한가 — 퇴근을 안 찍고 가는 일이 실제로 생긴다. 그러면 세션이 열린 채로
   * 남아 근무시간이 계속 늘거나(진행 중), 엉뚱하게 긴 하루로 굳는다. 이벤트는
   * append-only 라 잘못 찍힌 시각을 지울 수 없으므로, 사람이 판단한 값을 **덮어쓰는
   * 값**으로 따로 얹는다.
   *
   * 원래 값(beforeMs)을 함께 남긴다 — 정정은 기록을 고치는 일이라 무엇을 무엇으로
   * 바꿨는지 남지 않으면 나중에 아무도 검증할 수 없다.
   */
  correction?: DayCorrection;
  /**
   * 정정을 마지막으로 손댄 시각. **정정을 취소했을 때도 갱신된다.**
   *
   * `correction` 안이 아니라 밖에 두는 이유는 업무 리스트(todosAt)와 똑같다 —
   * 취소는 "정정이 없음"이라는 상태인데, 시각을 정정 객체 안에 두면 취소한 순간
   * 시각도 같이 사라져서 병합 때 다른 기기의 옛 정정이 되살아난다.
   */
  correctionAt?: number;
}

export interface DayCorrection {
  /** 정정 후 실근무시간 (ms) */
  actualMs: number;
  /** 정정 직전에 계산되던 실근무시간 (ms) */
  beforeMs: number;
  /** 정정 사유 */
  reason: string;
  /**
   * 정정의 근거가 된 실제 근무 구간.
   *
   * 시간을 사람이 암산해서 "8시간" 이라고 적는 대신 **찍혀 있는 구간을 잘라** 정정하면
   * 채워진다 (예: 03:05~10:00 으로 찍혔지만 실제로는 05:00 에 끝났다 → 03:05~05:00).
   * 숫자만 남기면 "왜 그 숫자인가"가 사라지므로 구간 자체를 같이 남긴다.
   * 직접 시간을 적어 넣은 정정에는 없다.
   */
  segments?: CorrectedSegment[];
}

/** 정정으로 확정한 근무 구간 (epoch ms) */
export interface CorrectedSegment {
  start: number;
  end: number;
}

/**
 * 이벤트에서 잘라 낸 하루의 구간.
 *
 * computeDay 가 시간을 합산하는 단위이자, 화면에서 "언제부터 언제까지 찍혀 있나"를
 * 보여 주고 그걸 고쳐 정정하게 하는 단위이기도 하다.
 */
export interface WorkSegment {
  kind: 'work' | 'away';
  start: number;
  /** 아직 열려 있는 구간이면 `now` */
  end: number;
  /** 닫히지 않은(진행 중) 구간인지 */
  open: boolean;
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
  /** 사람이 근무시간을 정정했는지 */
  corrected: boolean;
  /** 정정 내역 (정정하지 않았으면 null) */
  correction: DayCorrection | null;
  /** 정정한 시각 (정정하지 않았으면 null) */
  correctedAt: number | null;
}

/** 세션이 이 시간을 넘게 열려 있으면 "퇴근을 잊었을 가능성" 경고 */
export const STALE_SESSION_MS = 20 * 60 * 60 * 1000;

export function emptyDayLog(date: string): DayLog {
  return { date, events: [], vacationMs: 0 };
}

interface Walk {
  segments: WorkSegment[];
  clockInAt: number | null;
  clockOutAt: number | null;
  awayCount: number;
  resumeCount: number;
  pausedMs: number;
  /** 마지막까지 닫히지 않은 구간이 있는지 */
  openKind: 'work' | 'away' | null;
}

/**
 * 이벤트 목록을 시간 구간으로 펼친다. 근무시간 계산과 화면 표시가 같은 결과를 보게
 * 하려고 한곳에서만 만든다 — 따로 계산하면 언젠가 반드시 어긋난다.
 *
 * 시계 역행(clock skew)이나 잘못 저장된 미래 이벤트로 음수 구간이 생기지 않도록
 * 구간의 끝은 시작보다 앞설 수 없게 clamp 한다.
 */
export function walkDay(log: DayLog, now: number): Walk {
  const events = [...log.events].sort((a, b) => a.at - b.at);

  const segments: WorkSegment[] = [];
  let clockInAt: number | null = null;
  let clockOutAt: number | null = null;
  let awayCount = 0;
  let resumeCount = 0;
  let pausedMs = 0;

  // 현재 열려 있는 구간의 시작 시각과 종류
  let openKind: 'work' | 'away' | null = null;
  let openSince = 0;

  const close = (at: number) => {
    if (openKind === null) return;
    segments.push({ kind: openKind, start: openSince, end: Math.max(at, openSince), open: false });
  };

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
        close(ev.at);
        openKind = 'away';
        openSince = ev.at;
        awayCount += 1;
        break;
      }
      case 'away_end': {
        if (openKind !== 'away') break;
        close(ev.at);
        openKind = 'work';
        openSince = ev.at;
        break;
      }
      case 'clock_out': {
        if (openKind === null || clockOutAt !== null) break;
        close(ev.at);
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

  // 아직 열려 있는 구간은 "지금"까지로 본다.
  if (openKind !== null) {
    segments.push({
      kind: openKind,
      start: openSince,
      end: Math.max(now, openSince),
      open: true,
    });
  }

  return { segments, clockInAt, clockOutAt, awayCount, resumeCount, pausedMs, openKind };
}

/** 그날 찍혀 있는 구간들. 정정 여부와 무관하게 **원래 기록**을 돌려준다. */
export function daySegments(log: DayLog, now: number): WorkSegment[] {
  return walkDay(log, now).segments;
}

/** 그날 찍혀 있는 근무 구간만 (자리 비움 제외) */
export function workSegments(log: DayLog, now: number): WorkSegment[] {
  return walkDay(log, now).segments.filter((s) => s.kind === 'work');
}

/** 구간 길이의 합 (ms). 길이가 0 이하인 구간은 무시한다. */
export function segmentsTotalMs(segments: readonly CorrectedSegment[]): number {
  let total = 0;
  for (const s of segments) total += Math.max(0, s.end - s.start);
  return total;
}

/**
 * 이벤트 목록으로부터 실제 근무시간/자리비움시간을 계산한다.
 *
 * `now` 는 항상 호출부에서 주입한다(테스트 가능성).
 */
export function computeDay(log: DayLog, now: number): DayTotals {
  const walk = walkDay(log, now);

  let actualMs = 0;
  let awayMs = 0;
  for (const seg of walk.segments) {
    const len = Math.max(0, seg.end - seg.start);
    if (seg.kind === 'work') actualMs += len;
    else awayMs += len;
  }

  const { clockInAt, clockOutAt, awayCount, resumeCount, pausedMs, openKind } = walk;

  const status: WorkStatus =
    clockInAt === null ? 'not_started'
      : clockOutAt !== null ? 'finished'
        : openKind === 'away' ? 'away'
          : 'working';

  const vacationMs = Math.max(0, log.vacationMs || 0);

  // 정정이 있으면 실근무시간을 사람이 정한 값으로 갈아끼운다.
  //
  // 그날은 더 이상 "진행 중"이 아니다. 숫자만 고정하고 상태를 그대로 두면 화면에서
  // 초가 계속 흐르는데 값은 안 변하는 모순된 표시가 된다. 정정은 곧 "그날은 이걸로
  // 마감" 이라는 선언이므로 완료로 본다 — **단, 그 이후에 다시 업무에 복귀했다면 얘기가
  // 다르다.** 정정 시각(correctionAt) 이후에 새 이벤트가 있다면 그날은 다시 열린
  // 것이므로, 정정으로 확정된 값(과거분)에 정정 이후 실제로 일한 시간(현재분)을
  // 더해서 보여준다. 정정을 통째로 무시해 버리면 정정 전의 잘못된 값(예: 퇴근을 못
  // 찍어 부풀려진 시간)이 되살아나므로, 정정은 유지한 채 그 뒤만 이어 붙인다.
  const correction = log.correction ?? null;
  const corrected = correction !== null;
  const correctionAt = log.correctionAt ?? 0;
  const resumedAfterCorrection = corrected && log.events.some((ev) => ev.at > correctionAt);

  let postCorrectionActualMs = 0;
  if (resumedAfterCorrection) {
    for (const seg of walk.segments) {
      if (seg.kind !== 'work' || seg.end <= correctionAt) continue;
      postCorrectionActualMs += Math.max(0, seg.end - Math.max(seg.start, correctionAt));
    }
  }

  const finalActualMs = corrected ? Math.max(0, correction.actualMs) + postCorrectionActualMs : actualMs;
  // 정정한 날은 출퇴근 기록 유무와 상관없이 마감된 것으로 본다. 아예 안 찍은 날을
  // 나중에 시간만 채우는 경우가 있는데, 그때 '출근 전'으로 남으면 근무시간은 있는데
  // 상태는 미출근인 모순된 행이 Notion 에 올라간다. 다시 복귀했다면 실제 상태(근무
  // 중/자리 비움/퇴근)를 그대로 보여준다.
  const finalStatus: WorkStatus = corrected && !resumedAfterCorrection ? 'finished' : status;

  // 구간을 잘라서 정정했다면 출퇴근 시각도 그 구간을 따른다 — 근무시간은 5시까지인데
  // 표시는 10시 퇴근으로 남아 있으면 어느 쪽이 맞는지 알 수 없다. 다시 복귀한 뒤에는
  // 정정 구간이 아니라 실제 출퇴근 시각을 보여준다.
  const fixed =
    corrected && !resumedAfterCorrection
      ? [...(correction.segments ?? [])].filter((s) => s.end > s.start).sort((a, b) => a.start - b.start)
      : [];
  const finalClockInAt = fixed.length > 0 ? fixed[0]!.start : clockInAt;
  const finalClockOutAt = fixed.length > 0 ? fixed[fixed.length - 1]!.end : clockOutAt;

  return {
    date: log.date,
    status: finalStatus,
    clockInAt: finalClockInAt,
    clockOutAt: finalClockOutAt,
    actualMs: finalActualMs,
    awayMs,
    vacationMs,
    creditedMs: finalActualMs + vacationMs,
    awayCount,
    resumeCount,
    pausedMs,
    isLive: corrected && !resumedAfterCorrection ? false : openKind !== null,
    corrected,
    correction,
    correctedAt: corrected ? (log.correctionAt ?? null) : null,
  };
}

/**
 * "HH:MM" 로 적은 시각을 그 구간 안의 절대시각으로 바꾼다.
 *
 * 자정을 넘겨 일한 날이 있으므로 날짜만으로는 시각이 정해지지 않는다 (22:00 출근 →
 * 02:00 퇴근). 그래서 전날·당일·다음날 세 후보 중 **그 구간에 들어오는 것**을 고르고,
 * 어느 것도 안 들어오면 가장 가까운 쪽으로 구간 안에 붙인다.
 * 정정은 "찍힌 구간 안에서" 만 하기로 했으므로 구간을 벗어나는 값은 만들지 않는다.
 */
export function clockToEpochWithin(
  dateKey: string,
  hhmm: string,
  segment: { start: number; end: number },
): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;

  const base = dateKeyToEpoch(dateKey) + hour * 60 * 60 * 1000 + minute * 60 * 1000;
  const candidates = [base - DAY_MS, base, base + DAY_MS];

  const inside = candidates.find((c) => c >= segment.start && c <= segment.end);
  if (inside !== undefined) return inside;

  let best = candidates[0]!;
  let bestGap = Infinity;
  for (const c of candidates) {
    const gap = c < segment.start ? segment.start - c : c - segment.end;
    if (gap < bestGap) {
      best = c;
      bestGap = gap;
    }
  }
  return Math.min(segment.end, Math.max(segment.start, best));
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
    log: {
      ...log,
      events: [...log.events, { type: action, at: stamped }],
      updatedAt: stamped,
    },
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
