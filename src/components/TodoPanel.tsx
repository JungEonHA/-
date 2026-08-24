/**
 * 할 일(업무 리스트) 탭.
 *
 * 이 목록은 근무 기록과 같은 하루(=같은 Notion 행)에 붙는다. 자정을 넘겨 일하는
 * 중이면 여전히 출근한 날짜에 적힌다 — 근무시간과 같은 기준이어야 나중에 행을 볼 때
 * "이 시간에 무엇을 했는지"가 어긋나지 않는다.
 *
 * 날짜는 고를 수 있다. 그날 안에 적어 두지 못한 목록을 나중에 채워 넣거나 문구를
 * 고치는 일이 실제로 생기는데, 오늘 칸만 열려 있으면 지난 행은 영영 손댈 수 없다.
 * 고르지 않은 동안에는 언제나 '지금 근무 중인 날'을 따라간다.
 *
 * 저장은 언제나 로컬이 먼저다. Notion 기록이 실패해도 적어 둔 내용은 남고,
 * 대기열에서 자동으로 다시 시도한다.
 */

import { useState } from 'react';
import { useSnapshot, useStore } from '../hooks/useAppStore';
import { MAX_TODOS, MAX_TODO_TEXT, todoSummary, type TodoItem } from '../lib/todos';
import { formatDateKeyKo, toDateKey } from '../lib/time';
import { Banner, Card, EditableText, EmptyState } from './ui';

export function TodoPanel({ now }: { now: number }) {
  const store = useStore();
  const { state } = useSnapshot();

  const activeDate = store.activeDate;
  // null 이면 "오늘을 따라간다". 자정을 넘겨 근무일이 바뀌어도 손대지 않은 화면이
  // 어제에 멈춰 있지 않도록, 고른 날짜를 저장하지 별도로 복사해 두지 않는다.
  const [picked, setPicked] = useState<string | null>(null);
  const dateKey = picked ?? activeDate;
  const isActiveDay = dateKey === activeDate;

  const todos = store.todosFor(dateKey);
  const { done, total } = todoSummary(todos);
  const hasRecord = !!state.logs[dateKey];

  const [draft, setDraft] = useState('');

  function add() {
    if (store.addTodo(dateKey, draft)) setDraft('');
  }

  // 앞날의 근무 기록 행을 새로 만들 이유는 없다. 다만 자정을 넘긴 근무 때문에
  // 활성 날짜가 오늘보다 앞설 수 있으니 그때는 그쪽을 상한으로 둔다.
  const maxDate = activeDate > toDateKey(now) ? activeDate : toDateKey(now);

  return (
    <div className="stack">
      <NotionLinkBanner />

      <Card
        title={isActiveDay ? '오늘 할 일' : '지난 날 할 일'}
        hint={
          isActiveDay && activeDate !== toDateKey(now)
            ? `${formatDateKeyKo(dateKey)} (자정을 넘긴 근무)`
            : formatDateKeyKo(dateKey)
        }
        action={
          <span className="todo__count" data-testid="todo-count">
            {total === 0 ? '0개' : `${done}/${total} 완료`}
          </span>
        }
      >
        <div className="field">
          <label className="field__label" htmlFor="todo-date">
            날짜
          </label>
          <div className="todo__date">
            <input
              id="todo-date"
              className="input"
              type="date"
              value={dateKey}
              max={maxDate}
              data-testid="todo-date"
              onChange={(e) => e.target.value && setPicked(e.target.value)}
            />
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              data-testid="todo-date-today"
              disabled={isActiveDay}
              onClick={() => setPicked(null)}
            >
              오늘로
            </button>
          </div>
          <span className="field__hint" data-testid="todo-date-hint">
            {isActiveDay
              ? '지난 날짜를 고르면 그날 목록을 그대로 고칠 수 있습니다.'
              : hasRecord
                ? '지난 날의 목록입니다. 고치면 그날 근무 기록 행에 다시 기록됩니다.'
                : '이 날짜에는 근무 기록이 없습니다. 할 일을 적으면 행이 새로 만들어집니다.'}
          </span>
        </div>

        <div className="todo__add mt12">
          <input
            className="input"
            data-testid="todo-input"
            placeholder="예: 3화 대본 초고 마감"
            maxLength={MAX_TODO_TEXT}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
          <button
            type="button"
            className="btn btn--primary"
            data-testid="todo-add"
            disabled={!draft.trim()}
            onClick={add}
          >
            추가
          </button>
        </div>

        {total > 0 && (
          <div className="todo__bar" aria-hidden="true">
            <div className="todo__barFill" style={{ width: `${(done / total) * 100}%` }} />
          </div>
        )}

        {total === 0 ? (
          <EmptyState>
            아직 적은 할 일이 없습니다. 위에 입력하고 Enter를 누르면{' '}
            {isActiveDay ? '오늘' : formatDateKeyKo(dateKey)} 근무 기록 행에 함께 저장됩니다.
          </EmptyState>
        ) : (
          <ul className="todo__list" data-testid="todo-list">
            {todos.map((todo, index) => (
              <TodoRow
                key={todo.id}
                todo={todo}
                dateKey={dateKey}
                first={index === 0}
                last={index === todos.length - 1}
              />
            ))}
          </ul>
        )}

        <p className="field__hint mt12">
          항목을 눌러 문구를 고칠 수 있고, 체크·수정·삭제는 즉시 Notion의 그날 행에 반영됩니다
          (하루 최대 {MAX_TODOS}개). 앱에서 모두 지우면 Notion 칸도 비워집니다 — Notion에서 직접
          고친 내용은 다음 동기화 때 앱의 목록으로 덮어써집니다.
        </p>
      </Card>

      {state.notion.employeeName && (
        <p className="field__hint">
          이 목록은 <b>{state.notion.employeeName}</b> 님의 {formatDateKeyKo(dateKey)} 행에
          기록됩니다.
        </p>
      )}
    </div>
  );
}

function TodoRow({
  todo,
  dateKey,
  first,
  last,
}: {
  todo: TodoItem;
  dateKey: string;
  first: boolean;
  last: boolean;
}) {
  const store = useStore();

  return (
    <li className={`todo__item ${todo.done ? 'todo__item--done' : ''}`} data-testid="todo-item">
      <input
        type="checkbox"
        className="todo__check"
        checked={todo.done}
        data-testid="todo-toggle"
        aria-label={`${todo.text} 완료 표시`}
        onChange={() => store.toggleTodo(dateKey, todo.id)}
      />

      <EditableText
        value={todo.text}
        maxLength={MAX_TODO_TEXT}
        className="todo__text"
        editClassName="todo__edit"
        editLabel={`${todo.text} 내용 수정`}
        testId="todo-text"
        editTestId="todo-edit"
        onCommit={(next) => store.editTodo(dateKey, todo.id, next)}
      />

      <span className="todo__tools">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-label="위로"
          disabled={first}
          onClick={() => store.moveTodo(dateKey, todo.id, -1)}
        >
          ↑
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-label="아래로"
          disabled={last}
          onClick={() => store.moveTodo(dateKey, todo.id, 1)}
        >
          ↓
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-label="삭제"
          data-testid="todo-remove"
          onClick={() => store.removeTodo(dateKey, todo.id)}
        >
          ✕
        </button>
      </span>
    </li>
  );
}

/**
 * Notion 쪽 준비 상태 안내.
 *
 * 적은 내용이 어디로 가는지(또는 아직 아무 데도 안 가는지)를 분명히 해 둔다.
 * 매핑이 없으면 목록은 이 기기에만 남는데, 그걸 모르면 Notion 을 열어 보고 나서야 안다.
 */
function NotionLinkBanner() {
  const store = useStore();
  const { state, runtime } = useSnapshot();
  const { schema } = state.notion;

  // `mapping.todos` 가 아니라 **실제로 쓸 수 있는 칸**을 본다. 이름만 남고 칸은
  // 없어진 매핑에도 초록 배너를 띄우던 탓에, 목록이 통째로 버려지는 동안에도
  // 화면은 "기록됩니다" 라고 말하고 있었다.
  const todosProp = store.mappedProperty('todos');

  if (todosProp) {
    return (
      <Banner kind="success">
        적은 목록은 Notion “{todosProp}” 칸에 ☑/☐ 체크리스트로 자동 기록됩니다.
      </Banner>
    );
  }

  // 스키마를 아직 못 읽었으면 매핑이 없는 게 정상이다. 설정으로 안내만 한다.
  if (!schema) {
    return (
      <Banner kind="info">
        Notion을 아직 연결하지 않아 목록이 이 기기에만 저장됩니다. 설정 › Notion 연결을 마치면
        그날 근무 기록 행에 함께 기록됩니다.
      </Banner>
    );
  }

  const candidates = schema.properties.filter((p) => p.type === 'rich_text');

  return (
    <Banner kind="warn">
      Notion DB에 업무 리스트를 적을 칸이 지정되지 않아 <b>목록이 이 기기에만 저장됩니다.</b>{' '}
      {candidates.length > 0
        ? '설정 › Property 매핑의 “업무 리스트”에서 텍스트 칸을 고르거나, '
        : ''}
      아래 버튼으로 새 칸을 만들 수 있습니다.
      <br />
      <button
        type="button"
        className="btn btn--ghost btn--sm mt8"
        data-testid="todo-add-property"
        disabled={runtime.backend !== 'ready'}
        onClick={() => void store.addMissingProperties(['todos'])}
      >
        Notion에 “업무 리스트” 칸 만들기
      </button>
    </Banner>
  );
}
