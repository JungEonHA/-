import { describe, expect, it } from 'vitest';
import {
  MAX_TODOS,
  formatTodoText,
  makeTodoId,
  normalizeTodos,
  parseTodoText,
  sameTodos,
  todoSummary,
  type TodoItem,
} from './todos';

const item = (text: string, done = false): TodoItem => ({ id: `x${text}`, text, done });

describe('업무 리스트 텍스트 변환', () => {
  it('체크 상태를 사람이 읽을 수 있는 기호로 적는다', () => {
    expect(formatTodoText([item('대본 초고', true), item('썸네일 시안')])).toBe(
      '☑ 대본 초고\n☐ 썸네일 시안',
    );
  });

  it('빈 목록은 빈 문자열이다 (Notion 칸을 비우는 신호)', () => {
    expect(formatTodoText([])).toBe('');
  });

  it('적은 그대로 다시 읽어 낸다', () => {
    const todos = [item('3화 편집', true), item('BGM 고르기'), item('정산 확인', true)];
    const parsed = parseTodoText(formatTodoText(todos));
    expect(parsed.map((t) => [t.text, t.done])).toEqual([
      ['3화 편집', true],
      ['BGM 고르기', false],
      ['정산 확인', true],
    ]);
  });

  it('Notion 에서 손으로 고친 표기도 받아 준다', () => {
    const parsed = parseTodoText('- [x] 이미 함\n* ✅ 이것도\n⬜ 아직\n[ ] 이것도 아직\n그냥 한 줄');
    expect(parsed.map((t) => [t.text, t.done])).toEqual([
      ['이미 함', true],
      ['이것도', true],
      ['아직', false],
      ['이것도 아직', false],
      ['그냥 한 줄', false],
    ]);
  });

  it('빈 줄과 공백만 있는 줄은 항목으로 세지 않는다', () => {
    expect(parseTodoText('☐ 하나\n\n   \n☑ 둘')).toHaveLength(2);
    expect(parseTodoText('')).toEqual([]);
    expect(parseTodoText(null)).toEqual([]);
  });

  it('Notion 텍스트 한도를 넘으면 잘라 내되 몇 개가 빠졌는지 남긴다', () => {
    const many = Array.from({ length: MAX_TODOS }, (_, i) => item(`${i} ${'가'.repeat(120)}`));
    const text = formatTodoText(many);

    expect(text.length).toBeLessThanOrEqual(1900);
    expect(text).toContain('외 ');
    expect(text.trimEnd().endsWith('개는 앱에서 확인')).toBe(true);

    // 안내 줄이 되읽을 때 할 일로 둔갑하면 안 된다.
    const parsed = parseTodoText(text);
    expect(parsed.every((t) => !t.text.includes('앱에서 확인'))).toBe(true);
    expect(parsed.length).toBeLessThan(MAX_TODOS);
  });
});

describe('업무 리스트 정규화', () => {
  it('깨진 항목은 버리고 나머지는 살린다', () => {
    const todos = normalizeTodos([
      { id: 'a', text: '살아남음', done: true },
      null,
      { id: 'b' },
      { id: 'c', text: '   ' },
      { text: 'id 없음' },
      'not an object',
    ]);
    expect(todos.map((t) => t.text)).toEqual(['살아남음', 'id 없음']);
    expect(todos[0]!.done).toBe(true);
    expect(todos[1]!.id).toBeTruthy();
  });

  it('배열이 아니면 빈 목록', () => {
    expect(normalizeTodos(undefined)).toEqual([]);
    expect(normalizeTodos({ a: 1 })).toEqual([]);
  });

  it('id 가 겹치면 갈라 놓는다 (React 키가 충돌하지 않도록)', () => {
    const todos = normalizeTodos([
      { id: 'same', text: '하나' },
      { id: 'same', text: '둘' },
    ]);
    expect(todos[0]!.id).not.toBe(todos[1]!.id);
  });

  it('하루 최대 개수를 넘기지 않는다', () => {
    const raw = Array.from({ length: MAX_TODOS + 10 }, (_, i) => ({ id: `${i}`, text: `${i}` }));
    expect(normalizeTodos(raw)).toHaveLength(MAX_TODOS);
  });
});

describe('업무 리스트 유틸', () => {
  it('같은 밀리초에 만들어도 id 가 겹치지 않는다', () => {
    const ids = new Set(Array.from({ length: 50 }, () => makeTodoId(1_700_000_000_000)));
    expect(ids.size).toBe(50);
  });

  it('완료 개수를 센다', () => {
    expect(todoSummary([item('a', true), item('b'), item('c', true)])).toEqual({
      done: 2,
      total: 3,
    });
    expect(todoSummary(undefined)).toEqual({ done: 0, total: 0 });
  });

  it('내용 비교는 id 가 아니라 글과 체크 상태로 한다', () => {
    expect(sameTodos([item('a', true)], [{ id: 'other', text: 'a', done: true }])).toBe(true);
    expect(sameTodos([item('a', true)], [item('a', false)])).toBe(false);
    expect(sameTodos([], undefined)).toBe(true);
    expect(sameTodos([item('a')], [])).toBe(false);
  });
});
