/**
 * 하루치 근무 로그를 Notion 의 텍스트 Property 하나에 담고 되읽는 형식.
 *
 * 왜 필요한가 — 기록은 원래 브라우저 안에만 쌓였다. 그래서 데스크탑에서 출근하고
 * 노트북에서 퇴근하는 것이 불가능했고, 더 나쁘게는 노트북이 같은 날짜의 행을
 * 자기 기준으로 덮어써서 오전 기록을 지웠다. Notion 행에 **이벤트 목록 자체**를
 * 실어 두면, 어느 기기든 그 목록을 읽어 자기 것과 합칠 수 있다.
 *
 * 설계 규칙
 *  - 이벤트는 append-only 이므로 병합은 **합집합**이다. 지우는 연산이 없다.
 *  - 같은 이벤트인지는 (종류, 시각) 으로 판단한다. 같은 동작을 두 기기가 각각
 *    기록했더라도 시각이 다르면 둘 다 남기고, 계산 단계에서 걸러진다
 *    (예: 중복 출근은 computeDay 가 무시한다).
 *  - 휴가시간처럼 "덮어쓰는 값"만 updatedAt 이 큰 쪽을 택한다.
 */

import type {
  CorrectedSegment,
  DayCorrection,
  DayLog,
  WorkEvent,
  WorkEventType,
} from './events.js';
import { dateKeyToEpoch } from './time.js';
import { sameTodos } from './todos.js';

/** 형식 버전. 앞으로 형식을 바꾸면 이 값을 올리고 파서에서 분기한다. */
export const EVENT_LOG_VERSION = 'v1';

const CODE_BY_TYPE: Record<WorkEventType, string> = {
  clock_in: 'i',
  away_start: 'as',
  away_end: 'ae',
  clock_out: 'o',
  resume: 'r',
};

const TYPE_BY_CODE: Record<string, WorkEventType> = {
  i: 'clock_in',
  as: 'away_start',
  ae: 'away_end',
  o: 'clock_out',
  r: 'resume',
};

/**
 * Notion rich_text 한 조각의 상한(2000자)에 걸리지 않도록 하는 안전선.
 * 시각을 그날 자정 기준 상대 ms 로 적으므로 이벤트 하나가 12자 안팎이다.
 * 즉 130개 넘는 이벤트가 있어야 닿는 값이고, 하루 근무 기록으로는 사실상 도달하지 않는다.
 */
const MAX_TEXT_LENGTH = 1900;

/**
 * 정정 사유의 최대 길이(문자).
 * 한글은 percent-encoding 하면 한 글자가 9자로 불어나므로 짧게 끊는다 —
 * 50자면 인코딩 후에도 450자 안쪽이라 위 상한을 위협하지 않는다.
 */
const MAX_REASON_LENGTH = 50;

/**
 * "v1 U:<epochMs> V:<휴가ms> T:<epochMs> i:<상대ms> as:<상대ms> …"
 *
 * 시각을 그날 자정(KST) 기준 상대값으로 적는 이유는 길이를 줄이기 위해서다.
 * 자정을 넘긴 근무는 86400000 을 넘는 값이 되므로 그대로 표현된다.
 *
 * `T` 는 업무 리스트를 마지막으로 고친 시각이다. 목록 본문은 여기 싣지 않는다 —
 * 사람이 읽는 값이라 Notion 의 자기 칸에 따로 적히고, 여기에는 "누가 더 최근에
 * 고쳤는가"를 가릴 시각만 둔다.
 */
export function serializeDayLog(log: DayLog): string {
  const base = dateKeyToEpoch(log.date);
  const head = [
    EVENT_LOG_VERSION,
    `U:${Math.max(0, Math.floor(log.updatedAt ?? 0))}`,
    `V:${Math.max(0, Math.floor(log.vacationMs || 0))}`,
  ];
  if (log.todosAt) head.push(`T:${Math.max(0, Math.floor(log.todosAt))}`);

  // 정정. 사유에는 공백이 들어가므로 percent-encoding 해서 토큰 하나로 만든다
  // (형식이 공백 구분이라 날것으로 넣으면 파서가 토큰 경계를 잘못 잡는다).
  // CT 는 정정을 취소했을 때도 남긴다 — 그래야 다른 기기의 옛 정정을 이긴다.
  if (log.correctionAt) head.push(`CT:${Math.max(0, Math.floor(log.correctionAt))}`);
  if (log.correction) {
    const c = log.correction;
    head.push(`C:${Math.max(0, Math.floor(c.actualMs))}`);
    head.push(`CB:${Math.max(0, Math.floor(c.beforeMs))}`);
    if (c.reason) head.push(`CR:${encodeURIComponent(c.reason.slice(0, MAX_REASON_LENGTH))}`);
    // 정정의 근거가 된 구간. "시작~끝" 을 쉼표로 잇고, 시각은 이벤트와 같은 상대 ms 다.
    // 음수가 나올 수 있어 구분자로 `-` 대신 `~` 를 쓴다.
    const segs = (c.segments ?? []).filter((seg) => seg.end > seg.start);
    if (segs.length > 0) {
      head.push(`CS:${segs.map((seg) => `${seg.start - base}~${seg.end - base}`).join(',')}`);
    }
  }

  // 타이머 밖에서 일해 더한 시간. 정정과 같은 이유로 XT 는 취소했을 때도 남긴다.
  if (log.extraAt) head.push(`XT:${Math.max(0, Math.floor(log.extraAt))}`);
  if (log.extra && log.extra.ms > 0) {
    head.push(`X:${Math.max(0, Math.floor(log.extra.ms))}`);
    if (log.extra.reason) {
      head.push(`XR:${encodeURIComponent(log.extra.reason.slice(0, MAX_REASON_LENGTH))}`);
    }
    // 더한 근무 구간. 정정 근거 구간(CS)과 같은 형식이다.
    const xsegs = (log.extra.segments ?? []).filter((seg) => seg.end > seg.start);
    if (xsegs.length > 0) {
      head.push(`XS:${xsegs.map((seg) => `${seg.start - base}~${seg.end - base}`).join(',')}`);
    }
  }

  const tail = [...log.events]
    .sort((a, b) => a.at - b.at)
    .map((ev) => `${CODE_BY_TYPE[ev.type]}:${ev.at - base}`);

  const text = [...head, ...tail].join(' ');
  if (text.length <= MAX_TEXT_LENGTH) return text;

  // 여기 오면 이미 비정상이지만, 잘라야 한다면 **오래된 것부터** 버린다.
  // 최근 이벤트가 현재 상태(근무 중/퇴근)를 결정하기 때문이다.
  while (tail.length > 0 && [...head, ...tail].join(' ').length > MAX_TEXT_LENGTH) tail.shift();
  return [...head, ...tail].join(' ');
}

/** 형식이 아니거나 비어 있으면 null. 깨진 토큰은 조용히 건너뛴다. */
export function parseDayLog(dateKey: string, text: string | null | undefined): DayLog | null {
  if (!text) return null;
  const tokens = String(text).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens[0] !== EVENT_LOG_VERSION) return null;

  const base = dateKeyToEpoch(dateKey);
  const events: WorkEvent[] = [];
  let updatedAt = 0;
  let vacationMs = 0;
  let todosAt = 0;
  let cActual: number | null = null;
  let cBefore = 0;
  let cAt = 0;
  let cReason = '';
  let cSegments: CorrectedSegment[] = [];
  let xMs = 0;
  let xAt = 0;
  let xReason = '';
  let xSegments: CorrectedSegment[] = [];

  for (const token of tokens.slice(1)) {
    const sep = token.indexOf(':');
    if (sep < 0) continue;
    const code = token.slice(0, sep);
    const rawValue = token.slice(sep + 1);

    // 사유는 숫자가 아니므로 숫자 검사보다 먼저 처리한다.
    if (code === 'XR') {
      try {
        xReason = decodeURIComponent(rawValue).slice(0, MAX_REASON_LENGTH);
      } catch {
        xReason = '';
      }
      continue;
    }
    if (code === 'CR') {
      try {
        cReason = decodeURIComponent(rawValue).slice(0, MAX_REASON_LENGTH);
      } catch {
        // 깨진 인코딩은 사유만 버리고 정정 자체는 살린다.
        cReason = '';
      }
      continue;
    }
    // 구간 목록도 숫자가 아니다. 깨진 조각은 그 조각만 버린다.
    if (code === 'CS' || code === 'XS') {
      const parsed = rawValue
        .split(',')
        .map((pair) => {
          const [a, b] = pair.split('~');
          const start = Number(a);
          const end = Number(b);
          if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
          return { start: base + start, end: base + end };
        })
        .filter((seg): seg is CorrectedSegment => seg !== null);
      if (code === 'CS') cSegments = parsed;
      else xSegments = parsed;
      continue;
    }

    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;

    if (code === 'U') {
      updatedAt = Math.max(0, value);
      continue;
    }
    if (code === 'V') {
      vacationMs = Math.max(0, value);
      continue;
    }
    if (code === 'T') {
      todosAt = Math.max(0, value);
      continue;
    }
    if (code === 'C') {
      cActual = Math.max(0, value);
      continue;
    }
    if (code === 'CB') {
      cBefore = Math.max(0, value);
      continue;
    }
    if (code === 'CT') {
      cAt = Math.max(0, value);
      continue;
    }
    if (code === 'X') {
      xMs = Math.max(0, value);
      continue;
    }
    if (code === 'XT') {
      xAt = Math.max(0, value);
      continue;
    }
    const type = TYPE_BY_CODE[code];
    if (!type) continue;
    events.push({ type, at: base + value });
  }

  events.sort((a, b) => a.at - b.at);
  const correction: DayCorrection | null =
    cActual === null
      ? null
      : {
          actualMs: cActual,
          beforeMs: cBefore,
          reason: cReason,
          ...(cSegments.length > 0 ? { segments: cSegments } : {}),
        };

  return {
    date: dateKey,
    events,
    vacationMs,
    updatedAt,
    ...(todosAt ? { todosAt } : {}),
    ...(cAt ? { correctionAt: cAt } : {}),
    ...(correction ? { correction } : {}),
    ...(xAt ? { extraAt: xAt } : {}),
    ...(xMs > 0
      ? { extra: { ms: xMs, reason: xReason, ...(xSegments.length > 0 ? { segments: xSegments } : {}) } }
      : {}),
  };
}

/**
 * 두 기기의 하루 기록을 합친다.
 *
 * 이벤트는 합집합, 휴가시간처럼 덮어쓰는 값은 마지막으로 손댄 쪽을 따른다.
 * 어느 쪽이 null 이면 나머지를 그대로 돌려준다.
 */
export function mergeDayLogs(a: DayLog | null, b: DayLog | null): DayLog | null {
  if (!a) return b;
  if (!b) return a;

  const seen = new Set<string>();
  const events: WorkEvent[] = [];
  for (const ev of [...a.events, ...b.events]) {
    const key = `${ev.type}@${ev.at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ type: ev.type, at: ev.at });
  }
  events.sort((x, y) => x.at - y.at);

  const aAt = a.updatedAt ?? 0;
  const bAt = b.updatedAt ?? 0;
  const newer = bAt > aAt ? b : a;

  // 업무 리스트는 **자기 시각(todosAt)** 으로 승자를 가린다.
  //
  // updatedAt 을 쓰면 안 된다 — 데스크탑에서 목록을 적어 두고 노트북에서 퇴근만 눌러도
  // 노트북이 "더 최근"이 되어 목록을 통째로 지운다. 목록을 고친 사람만 목록을 이긴다.
  const aTodosAt = a.todosAt ?? 0;
  const bTodosAt = b.todosAt ?? 0;
  const todoWinner = bTodosAt > aTodosAt ? b : bTodosAt < aTodosAt ? a : newer;
  // "목록을 비웠다"도 뜻이 있는 값이라 빈 배열과 없음을 구분한다.
  // 이긴 쪽이 목록을 가진 적조차 없을 때만 반대쪽 것을 살린다.
  const todos = todoWinner.todos ?? (todoWinner === a ? b.todos : a.todos);
  const todosAt = Math.max(aTodosAt, bTodosAt);

  // 정정도 업무 리스트와 같은 이유로 **자기 시각**으로 승자를 가린다.
  // updatedAt 을 쓰면 데스크탑에서 정정해 둔 값이, 노트북에서 출퇴근만 눌러도 사라진다.
  // 이긴 쪽이 정정을 지웠다면(correction 없음) 지운 상태가 그대로 이겨야 한다.
  const aCorrAt = a.correctionAt ?? 0;
  const bCorrAt = b.correctionAt ?? 0;
  const corrWinner = bCorrAt > aCorrAt ? b : bCorrAt < aCorrAt ? a : newer;
  const correction = corrWinner.correction;
  const correctionAt = Math.max(aCorrAt, bCorrAt);

  // 추가 시간도 같은 규칙이다. **합치지 않는다** — 양쪽 값을 더하면 한 기기가 두 번
  // 동기화되기만 해도 시간이 불어난다. 마지막에 손댄 기기의 값이 그날의 값이다.
  const aExtraAt = a.extraAt ?? 0;
  const bExtraAt = b.extraAt ?? 0;
  const extraWinner = bExtraAt > aExtraAt ? b : bExtraAt < aExtraAt ? a : newer;
  const extra = extraWinner.extra;
  const extraAt = Math.max(aExtraAt, bExtraAt);

  return {
    date: a.date,
    events,
    vacationMs: newer.vacationMs,
    updatedAt: Math.max(aAt, bAt),
    ...(newer.memo ? { memo: newer.memo } : {}),
    ...(todos ? { todos } : {}),
    ...(todosAt ? { todosAt } : {}),
    ...(correctionAt ? { correctionAt } : {}),
    ...(correction ? { correction } : {}),
    ...(extraAt ? { extraAt } : {}),
    ...(extra ? { extra } : {}),
  };
}

/** 병합 결과가 실제로 달라졌는지 (불필요한 저장/렌더를 피하기 위해) */
export function sameDayLog(a: DayLog | null, b: DayLog | null): boolean {
  if (!a || !b) return a === b;
  if (a.events.length !== b.events.length) return false;
  if ((a.vacationMs || 0) !== (b.vacationMs || 0)) return false;
  // 업무 리스트만 달라진 경우도 "바뀐 것"이다. 이걸 빼면 다른 기기에서 적은
  // 목록을 받아 놓고도 저장하지 않아 화면에 영영 안 나타난다.
  if (!sameTodos(a.todos, b.todos)) return false;
  // 정정만 달라진 경우도 "바뀐 것"이다. 이걸 빼면 다른 기기에서 한 정정을 받아 놓고도
  // 저장하지 않아 이 기기에서는 영영 반영되지 않는다 (취소도 마찬가지다).
  if (!sameCorrection(a, b)) return false;
  // 추가 시간도 마찬가지다 — 다른 기기에서 얹은 시간을 받아 놓고 저장하지 않으면
  // 화면에는 영영 안 나타난다.
  if (!sameExtra(a, b)) return false;
  return a.events.every((ev, i) => {
    const other = b.events[i];
    return !!other && other.type === ev.type && other.at === ev.at;
  });
}

/** 추가 시간(및 추가 취소)이 같은 상태인지 */
function sameExtra(a: DayLog, b: DayLog): boolean {
  if ((a.extraAt ?? 0) !== (b.extraAt ?? 0)) return false;
  const x = a.extra;
  const y = b.extra;
  if (!x || !y) return !x && !y;
  if (x.ms !== y.ms || x.reason !== y.reason) return false;
  const xs = x.segments ?? [];
  const ys = y.segments ?? [];
  if (xs.length !== ys.length) return false;
  return xs.every((seg, i) => seg.start === ys[i]!.start && seg.end === ys[i]!.end);
}

/** 정정(및 정정 취소)이 같은 상태인지 */
function sameCorrection(a: DayLog, b: DayLog): boolean {
  if ((a.correctionAt ?? 0) !== (b.correctionAt ?? 0)) return false;
  const x = a.correction;
  const y = b.correction;
  if (!x || !y) return !x && !y;
  if (x.actualMs !== y.actualMs || x.beforeMs !== y.beforeMs || x.reason !== y.reason) return false;
  const xs = x.segments ?? [];
  const ys = y.segments ?? [];
  if (xs.length !== ys.length) return false;
  return xs.every((seg, i) => seg.start === ys[i]!.start && seg.end === ys[i]!.end);
}
