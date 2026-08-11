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

import type { DayLog, WorkEvent, WorkEventType } from './events.js';
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

  for (const token of tokens.slice(1)) {
    const sep = token.indexOf(':');
    if (sep < 0) continue;
    const code = token.slice(0, sep);
    const value = Number(token.slice(sep + 1));
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
    const type = TYPE_BY_CODE[code];
    if (!type) continue;
    events.push({ type, at: base + value });
  }

  events.sort((a, b) => a.at - b.at);
  return { date: dateKey, events, vacationMs, updatedAt, ...(todosAt ? { todosAt } : {}) };
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

  return {
    date: a.date,
    events,
    vacationMs: newer.vacationMs,
    updatedAt: Math.max(aAt, bAt),
    ...(newer.memo ? { memo: newer.memo } : {}),
    ...(todos ? { todos } : {}),
    ...(todosAt ? { todosAt } : {}),
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
  return a.events.every((ev, i) => {
    const other = b.events[i];
    return !!other && other.type === ev.type && other.at === ev.at;
  });
}
