/**
 * 하루치 업무 리스트(할 일).
 *
 * 근무시간과 달리 이 값은 사람이 쓴 문장이라 이벤트로부터 다시 계산할 수 없다.
 * 그래서 Notion 에는 **사람이 그대로 읽을 수 있는 체크리스트 텍스트**로 적고,
 * 다시 읽을 때 같은 형식으로 되돌린다. 그래야
 *  - Notion 에서 그 칸만 봐도 그날 무엇을 했는지 알 수 있고,
 *  - 데스크탑에서 적은 목록이 노트북에서도 이어진다.
 *
 * 서버(api/)와 프론트엔드(src/)가 같은 규칙을 써야 하므로 shared/ 에 둔다.
 */

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
}

/** 한 항목의 최대 길이. 이보다 길면 할 일 목록이 아니라 문서다. */
export const MAX_TODO_TEXT = 200;

/** 하루 최대 항목 수 */
export const MAX_TODOS = 40;

/**
 * Notion rich_text 한 조각의 상한(2000자)에 대한 안전선.
 * 넘치면 뒤쪽을 자르되, 몇 개를 못 적었는지 마지막 줄에 남긴다 —
 * 조용히 사라지면 사용자는 기록이 갔다고 믿게 된다.
 */
const MAX_TEXT_LENGTH = 1900;

const DONE_MARK = '☑';
const OPEN_MARK = '☐';

/** 되읽기는 넉넉하게 받는다 (Notion 에서 손으로 고쳤을 수도 있다) */
const DONE_MARKS = ['☑', '✅', '✔', '[x]', '[X]', '[v]'];
const OPEN_MARKS = ['☐', '⬜', '□', '[ ]', '[]'];

/** 잘렸다는 표시. 되읽을 때 이 줄은 항목으로 취급하지 않는다. */
const OVERFLOW_PREFIX = '…';

let idSeq = 0;

/** 항목 식별자. 같은 밀리초에 여러 개를 만들어도 겹치지 않는다. */
export function makeTodoId(now: number): string {
  idSeq = (idSeq + 1) % 46656; // 36^3
  return `t${Math.max(0, Math.floor(now)).toString(36)}-${idSeq.toString(36)}`;
}

/** 신뢰할 수 없는 입력을 TodoItem[] 로 정규화한다. 깨진 항목은 버린다. */
export function normalizeTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const items: TodoItem[] = [];
  const seen = new Set<string>();

  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const v = value as Partial<TodoItem>;
    const text = typeof v.text === 'string' ? v.text.trim().slice(0, MAX_TODO_TEXT) : '';
    if (!text) continue;

    let id = typeof v.id === 'string' && v.id ? v.id : `p${items.length}`;
    while (seen.has(id)) id = `${id}_`;
    seen.add(id);

    items.push({ id, text, done: v.done === true });
    if (items.length >= MAX_TODOS) break;
  }
  return items;
}

/** Notion 텍스트 칸에 적을 체크리스트 문자열 */
export function formatTodoText(todos: TodoItem[]): string {
  const lines = todos.map((t) => `${t.done ? DONE_MARK : OPEN_MARK} ${t.text}`);
  const text = lines.join('\n');
  if (text.length <= MAX_TEXT_LENGTH) return text;

  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    // 마지막 안내 줄이 들어갈 자리를 남겨 둔다.
    if (length + line.length + 1 > MAX_TEXT_LENGTH - 40) break;
    kept.push(line);
    length += line.length + 1;
  }
  return [...kept, `${OVERFLOW_PREFIX} 외 ${todos.length - kept.length}개는 앱에서 확인`].join('\n');
}

/** `formatTodoText` 의 역변환. 형식이 아니면 빈 목록. */
export function parseTodoText(text: string | null | undefined): TodoItem[] {
  if (!text) return [];
  const items: TodoItem[] = [];

  for (const rawLine of String(text).split(/\r?\n/)) {
    // "- ☑ 항목" 처럼 불릿이 앞에 붙어 있어도 받는다.
    let line = rawLine.trim().replace(/^[-*•]\s*/, '');
    if (!line || line.startsWith(OVERFLOW_PREFIX)) continue;

    let done = false;
    const doneMark = DONE_MARKS.find((m) => line.startsWith(m));
    if (doneMark) {
      done = true;
      line = line.slice(doneMark.length);
    } else {
      const openMark = OPEN_MARKS.find((m) => line.startsWith(m));
      if (openMark) line = line.slice(openMark.length);
    }

    // 이모지 변형 선택자(✅️ 처럼 뒤에 붙는 U+FE0F)를 떼어 낸다.
    line = line.replace(/^️/, '').trim();
    if (!line) continue;

    items.push({ id: `p${items.length}`, text: line.slice(0, MAX_TODO_TEXT), done });
    if (items.length >= MAX_TODOS) break;
  }

  return items;
}

export function todoSummary(todos: TodoItem[] | undefined): { done: number; total: number } {
  const list = todos ?? [];
  return { done: list.filter((t) => t.done).length, total: list.length };
}

/** 두 목록이 같은 내용인지 (불필요한 저장/전송을 피하기 위해) */
export function sameTodos(a: TodoItem[] | undefined, b: TodoItem[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  return x.every((t, i) => {
    const other = y[i];
    return !!other && other.text === t.text && other.done === t.done;
  });
}
