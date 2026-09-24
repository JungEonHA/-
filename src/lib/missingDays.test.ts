import { describe, expect, it } from 'vitest';
import { emptyTodoDays, isHumanTodo } from '../../shared/missingDays';
import type { DayLog } from '../../shared/events';
import { HOUR_MS, MINUTE_MS, dateKeyToEpoch } from './time';

const at = (dateKey: string, h: number, m = 0) => dateKeyToEpoch(dateKey) + h * HOUR_MS + m * MINUTE_MS;

/** 그날 from~to 시에 일한 기록 */
function worked(dateKey: string, from: number, to: number, todos: DayLog['todos'] = []): DayLog {
  return {
    date: dateKey,
    events: [
      { type: 'clock_in', at: at(dateKey, from) },
      { type: 'clock_out', at: at(dateKey, to) },
    ],
    vacationMs: 0,
    todos,
  };
}

const todo = (text: string, done = false) => ({ id: text, text, done });
const NOW = at('2026-09-25', 12);

describe('할 일이 빈 근무일', () => {
  it('일했는데 사람이 쓴 할 일이 없는 날만 고른다', () => {
    const logs = {
      '2026-09-01': worked('2026-09-01', 9, 18, [todo('EP04 각본 초고', true)]),
      '2026-09-02': worked('2026-09-02', 9, 18),
      '2026-09-03': worked('2026-09-03', 10, 12, [todo('썸네일')]), // 체크 안 했어도 적은 날은 빈 날이 아니다
    };
    expect(emptyTodoDays(logs, Object.keys(logs), '2026-09-25', NOW)).toEqual(['2026-09-02']);
  });

  it('봇이 넣은 🤖 줄만 있는 날은 빈 날이다', () => {
    const logs = {
      '2026-09-04': worked('2026-09-04', 9, 18, [todo('🤖 [D-2] 콘텐츠 업로드일 — 9/6 마감')]),
    };
    expect(emptyTodoDays(logs, ['2026-09-04'], '2026-09-25', NOW)).toEqual(['2026-09-04']);
  });

  it('문장 가운데의 🤖 는 사람이 쓴 것이다', () => {
    expect(isHumanTodo(todo('로봇 🤖 캐릭터 시안'))).toBe(true);
    expect(isHumanTodo(todo('  🤖 [D-0] 마감'))).toBe(false);
  });

  it('기록이 없거나 30분도 안 일한 날, 휴가만 쓴 날은 빼고', () => {
    const logs: Record<string, DayLog> = {
      '2026-09-05': { date: '2026-09-05', events: [{ type: 'clock_in', at: at('2026-09-05', 9) }, { type: 'clock_out', at: at('2026-09-05', 9, 20) }], vacationMs: 0 },
      '2026-09-06': { date: '2026-09-06', events: [], vacationMs: 8 * HOUR_MS },
    };
    expect(emptyTodoDays(logs, ['2026-09-05', '2026-09-06', '2026-09-07'], '2026-09-25', NOW)).toEqual([]);
  });

  it('오늘과 그 뒤는 보지 않는다 — 아직 적고 있는 날이다', () => {
    const logs = {
      '2026-09-24': worked('2026-09-24', 9, 18),
      '2026-09-25': worked('2026-09-25', 9, 11),
    };
    expect(emptyTodoDays(logs, Object.keys(logs), '2026-09-25', NOW)).toEqual(['2026-09-24']);
  });

  it('날짜 순서대로 돌려준다', () => {
    const logs = {
      '2026-09-10': worked('2026-09-10', 9, 18),
      '2026-08-30': worked('2026-08-30', 9, 18),
    };
    expect(emptyTodoDays(logs, ['2026-09-10', '2026-08-30'], '2026-09-25', NOW)).toEqual(['2026-08-30', '2026-09-10']);
  });
});
