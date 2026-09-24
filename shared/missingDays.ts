/**
 * 할 일이 빈 근무일 찾기.
 *
 * 왜 (CEO 2026-09-25): 할 일 목록이 동업 수익 배분에서 "그 달에 무엇을 했는가" 의 근거가 됐다.
 * 그래서 적는 걸 잊은 날을 나중에라도 채울 수 있어야 하는데, 지난 날짜를 고르는 기능은
 * 있어도 **어느 날이 비었는지**를 앱이 말해 주지 않으면 달력을 하루씩 눌러 봐야 한다.
 * 사람이 하나하나 챙길 수 없다는 게 요청의 핵심이었다.
 *
 * 빈 날 = 그날 실제로 일했는데(실근무 30분 이상) 사람이 직접 쓴 할 일이 하나도 없는 날.
 *  - 봇(랏코)이 마감을 보고 넣은 🤖 줄은 사람이 쓴 게 아니므로 세지 않는다.
 *    봇 쪽 표시는 `Dongbaek/discord-os/src/core/todo-seed.js` 와 같아야 한다.
 *  - 휴가만 쓴 날은 일한 날이 아니다.
 *  - 오늘(아직 끝나지 않은 근무일)과 그 뒤는 보지 않는다 — 지금 적고 있는 중이다.
 *
 * 서버(api/)도 같은 규칙을 쓸 수 있게 shared/ 에 둔다.
 */

import { computeDay, type DayLog } from './events';
import { MINUTE_MS } from './time';
import type { TodoItem } from './todos';

/** 봇이 넣은 줄의 표시 (줄 맨 앞) */
const AGENT_MARK = '🤖';

/** 이만큼도 안 일한 날은 "잠깐 켰다 끈 날" 로 보고 빈 날로 치지 않는다 */
export const MIN_WORK_FOR_TODO_MS = 30 * MINUTE_MS;

/** 사람이 직접 쓴 항목인가 */
export function isHumanTodo(todo: TodoItem): boolean {
  return !todo.text.trimStart().startsWith(AGENT_MARK);
}

/**
 * dateKeys 중에서 할 일이 빈 근무일만 오름차순으로 돌려준다.
 *
 * @param logs     날짜 → 그날 기록 (없는 날은 기록이 없는 것)
 * @param dateKeys 살펴볼 날짜들
 * @param before   이 날짜와 그 뒤는 보지 않는다 (보통 지금 근무 중인 날)
 * @param now      진행 중인 기록의 근무시간 계산용
 */
export function emptyTodoDays(
  logs: Readonly<Record<string, DayLog | undefined>>,
  dateKeys: readonly string[],
  before: string,
  now: number,
): string[] {
  const out: string[] = [];
  for (const dateKey of [...dateKeys].sort()) {
    if (dateKey >= before) continue;
    const log = logs[dateKey];
    if (!log) continue;
    if (computeDay(log, now).actualMs < MIN_WORK_FOR_TODO_MS) continue;
    if ((log.todos ?? []).some(isHumanTodo)) continue;
    out.push(dateKey);
  }
  return out;
}
