/**
 * 오늘 할 일(업무 리스트) 탭.
 *
 * 이 목록은 근무 기록과 같은 하루(=같은 Notion 행)에 붙는다. 자정을 넘겨 일하는
 * 중이면 여전히 출근한 날짜에 적힌다 — 근무시간과 같은 기준이어야 나중에 행을 볼 때
 * "이 시간에 무엇을 했는지"가 어긋나지 않는다.
 *
 * 저장은 언제나 로컬이 먼저다. Notion 기록이 실패해도 적어 둔 내용은 남고,
 * 대기열에서 자동으로 다시 시도한다.
 */

import { useState } from 'react';
import { useSnapshot, useStore } from '../hooks/useAppStore';
import { MAX_TODOS, MAX_TODO_TEXT, todoSummary, type TodoItem } from '../lib/todos';
import { formatDateKeyKo, toDateKey } from '../lib/time';
import { Banner, Card, EmptyState } from './ui';

export function TodoPanel({ now }: { now: number }) {
  const store = useStore();
  const { state } = useSnapshot();

  const dateKey = store.activeDate;
  const todos = store.todosFor(dateKey);
  const { done, total } = todoSummary(todos);

  const [draft, setDraft] = useState('');

  function add() {
    if (store.addTodo(dateKey, draft)) setDraft('');
  }

  return (
    <div className="stack">
      <NotionLinkBanner />

      <Card
        title="오늘 할 일"
        hint={`${formatDateKeyKo(dateKey)}${dateKey !== toDateKey(now) ? ' (자정을 넘긴 근무)' : ''}`}
        action={
          <span className="todo__count" data-testid="todo-count">
            {total === 0 ? '0개' : `${done}/${total} 완료`}
          </span>
        }
      >
        <div className="todo__add">
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
            아직 적은 할 일이 없습니다. 위에 입력하고 Enter를 누르면 오늘 근무 기록 행에 함께
            저장됩니다.
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
          체크·수정·삭제는 즉시 Notion의 그날 행에 반영됩니다(하루 최대 {MAX_TODOS}개). 앱에서 모두
          지우면 Notion 칸도 비워집니다 — Notion에서 직접 고친 내용은 다음 동기화 때 앱의 목록으로
          덮어써집니다.
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
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(todo.text);

  function commit() {
    store.editTodo(dateKey, todo.id, text);
    setEditing(false);
  }

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

      {editing ? (
        <input
          className="input todo__edit"
          autoFocus
          value={text}
          maxLength={MAX_TODO_TEXT}
          data-testid="todo-edit"
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setText(todo.text);
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="todo__text"
          title="눌러서 수정"
          onClick={() => {
            setText(todo.text);
            setEditing(true);
          }}
        >
          {todo.text}
        </button>
      )}

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
  const { mapping, schema } = state.notion;

  if (mapping.todos) {
    return (
      <Banner kind="success">
        적은 목록은 Notion “{mapping.todos}” 칸에 ☑/☐ 체크리스트로 자동 기록됩니다.
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
