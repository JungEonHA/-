/**
 * Notion Embed 용 컴팩트 위젯.
 *
 * 전체 앱(탭 4개 + 집계 카드)은 임베드 블록 안에서 너무 크다. 위젯은 "지금 상태와
 * 다음 동작" 하나만 담아 한 화면에 들어가게 한다 — 사람마다 블록을 하나씩 두고
 * 노션 페이지에서 바로 찍는 용도다.
 *
 * 설계 원칙 하나: **버튼은 절대 사라지지 않는다.** 서버 오류든 네트워크 문제든
 * 퇴근 버튼을 못 누르는 상황을 만들면 안 되므로, 문제는 배너로만 알리고 조작부는
 * 항상 남겨 둔다. (기록은 어차피 로컬에 먼저 쌓이고 나중에 동기화된다.)
 */

import { useState } from 'react';
import { computeDay, type WorkStatus } from '../lib/events';
import { formatClock, formatDateKeyKo, formatDuration, formatDurationKo } from '../lib/time';
import { MAX_TODO_TEXT, todoSummary } from '../lib/todos';
import { fullViewUrl } from '../lib/bootParams';
import { useSnapshot, useStore } from '../hooks/useAppStore';
import { StatusChip, UpdateBanner } from './ui';

export function WidgetPanel({ now }: { now: number }) {
  const store = useStore();
  const { state, runtime } = useSnapshot();
  const [skippedSetup, setSkippedSetup] = useState(false);

  const activeDate = store.activeDate;
  const today = computeDay(store.logFor(activeDate), now);
  const name = state.notion.employeeName.trim();

  // 한 번도 연결한 적이 없거나, 누구 기록인지 정해지지 않았을 때만 설정 화면을 띄운다.
  // 일시적인 네트워크 오류로는 여기 오지 않는다 (위 주석의 원칙).
  const blocked = store.syncBlockReason();
  if (!skippedSetup && (state.notion.schema === null || blocked !== null)) {
    return <WidgetSetup reason={blocked} onSkip={() => setSkippedSetup(true)} />;
  }

  const timerClass =
    today.status === 'working' ? 'widget__timer widget__timer--live'
      : today.status === 'away' ? 'widget__timer widget__timer--away'
        : 'widget__timer';

  const pending = runtime.backend === 'ready' ? Object.keys(state.outbox).length : 0;
  const alert = alertFor(state, runtime, pending);

  const fullUrl =
    typeof window === 'undefined'
      ? '/'
      : fullViewUrl(window.location.origin, window.location.pathname, name);

  return (
    <div className="widget" data-testid="widget">
      <div className="widget__head">
        <span className="widget__who" data-testid="widget-employee">
          {name || '이름 미설정'}
        </span>
        <StatusChip status={today.status} testId="widget-status" />
        <span className="header__spacer" />
        <span className="widget__day">{formatDateKeyKo(activeDate)}</span>
      </div>

      {runtime.staleBuild && <UpdateBanner />}

      {alert && (
        <p className={`widget__alert widget__alert--${alert.kind}`} data-testid="widget-alert">
          {alert.text}
        </p>
      )}

      <div className={timerClass} data-testid="widget-timer">
        {formatDuration(today.actualMs)}
      </div>

      <div className="widget__meta">
        <Meta
          label="출근"
          value={today.clockInAt === null ? '--:--' : formatClock(today.clockInAt)}
        />
        <Meta
          label="퇴근"
          value={today.clockOutAt === null ? '--:--' : formatClock(today.clockOutAt)}
        />
        <Meta label="자리 비움" value={formatDurationKo(today.awayMs)} />
        <Meta label="인정 근무" value={formatDurationKo(today.creditedMs)} accent />
      </div>

      <WidgetActions status={today.status} />

      <WidgetTodos dateKey={activeDate} />

      <div className="widget__foot">
        <span data-testid="widget-sync">{syncText(state, runtime, pending)}</span>
        <span className="header__spacer" />
        <a className="widget__link" href={fullUrl} target="_blank" rel="noopener noreferrer">
          전체 화면 ↗
        </a>
      </div>
    </div>
  );
}

function Meta({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`widget__metaItem ${accent ? 'widget__metaItem--accent' : ''}`}>
      <div className="widget__metaLabel">{label}</div>
      <div className="widget__metaValue">{value}</div>
    </div>
  );
}

function WidgetActions({ status }: { status: WorkStatus }) {
  const store = useStore();

  if (status === 'not_started') {
    return (
      <button
        type="button"
        className="btn btn--primary btn--block"
        data-testid="btn-clock-in"
        onClick={() => store.perform('clock_in')}
      >
        업무 시작
      </button>
    );
  }

  if (status === 'finished') {
    return (
      <div className="stack">
        <button
          type="button"
          className="btn btn--primary btn--block"
          data-testid="btn-resume"
          onClick={() => store.perform('resume')}
        >
          업무 복귀하기
        </button>
        <p className="widget__hint">
          퇴근을 잘못 눌렀거나 일을 더 하게 됐다면 누르세요. 퇴근~복귀 사이는 근무시간에서
          빠집니다.
        </p>
      </div>
    );
  }

  return (
    <div className="btnRow">
      {status === 'working' ? (
        <button
          type="button"
          className="btn btn--away"
          data-testid="btn-away-start"
          onClick={() => store.perform('away_start')}
        >
          자리 비움
        </button>
      ) : (
        <button
          type="button"
          className="btn btn--primary"
          data-testid="btn-away-end"
          onClick={() => store.perform('away_end')}
        >
          복귀하기
        </button>
      )}
      <button
        type="button"
        className="btn btn--danger"
        data-testid="btn-clock-out"
        onClick={() => store.perform('clock_out')}
      >
        퇴근하기
      </button>
    </div>
  );
}

/**
 * 위젯 안의 할 일 목록.
 *
 * 기본은 접혀 있다. 임베드 블록의 높이는 사용자가 Notion 에서 손으로 맞춰 둔 값이라,
 * 이미 걸어 둔 위젯이 갑자기 길어져 버튼이 잘리면 안 된다. 펼치면 그 자리에서
 * 추가·체크까지 되고, 그대로 그날 근무 기록 행에 저장된다.
 */
function WidgetTodos({ dateKey }: { dateKey: string }) {
  const store = useStore();
  useSnapshot(); // 목록이 바뀌면 다시 그린다
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');

  const todos = store.todosFor(dateKey);
  const { done, total } = todoSummary(todos);

  function add() {
    if (store.addTodo(dateKey, draft)) setDraft('');
  }

  return (
    <div className="widgetTodo">
      <button
        type="button"
        className="widgetTodo__toggle"
        data-testid="widget-todo-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">📝</span>
        <span>오늘 할 일</span>
        <span className="widgetTodo__count">{total === 0 ? '없음' : `${done}/${total}`}</span>
        <span className="header__spacer" />
        <span aria-hidden="true">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="widgetTodo__body">
          {todos.length > 0 && (
            <ul className="widgetTodo__list" data-testid="widget-todo-list">
              {todos.map((todo) => (
                <li
                  key={todo.id}
                  className={`widgetTodo__item ${todo.done ? 'widgetTodo__item--done' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={todo.done}
                    aria-label={`${todo.text} 완료 표시`}
                    onChange={() => store.toggleTodo(dateKey, todo.id)}
                  />
                  <span className="widgetTodo__text">{todo.text}</span>
                  <button
                    type="button"
                    className="widgetTodo__remove"
                    aria-label={`${todo.text} 삭제`}
                    onClick={() => store.removeTodo(dateKey, todo.id)}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="widgetTodo__add">
            <input
              className="input"
              data-testid="widget-todo-input"
              placeholder="할 일 적기"
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
              className="btn btn--primary btn--sm"
              data-testid="widget-todo-add"
              disabled={!draft.trim()}
              onClick={add}
            >
              추가
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 처음 여는 위젯의 설정 화면.
 *
 * 임베드 안에서 전체 설정 화면을 흉내 내지 않는다. 접근 키와 이름만 받고 나머지
 * (스키마 조회 · Property 매핑)는 "연결하기" 한 번으로 자동 처리한다.
 */
function WidgetSetup({ reason, onSkip }: { reason: string | null; onSkip: () => void }) {
  const store = useStore();
  const { state, runtime } = useSnapshot();
  const [accessKey, setAccessKey] = useState(state.notion.accessKey);
  const [name, setName] = useState(state.notion.employeeName);
  const [busy, setBusy] = useState(false);

  const employeeProp = state.notion.mapping.employee
    ? state.notion.schema?.properties.find((p) => p.name === state.notion.mapping.employee)
    : undefined;
  const options = employeeProp?.options ?? [];

  async function connect() {
    setBusy(true);
    try {
      store.updateNotionSettings({ accessKey: accessKey.trim() });
      store.setEmployeeName(name);
      await store.checkBackend({ force: true });
      if (store.getSnapshot().runtime.backend === 'ready') await store.refreshSchema();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="widget widget--setup" data-testid="widget-setup">
      <div className="widget__head">
        <span className="widget__who">근무 기록 위젯</span>
        <span className="header__spacer" />
        <span className="widget__day">최초 1회 설정</span>
      </div>

      {/* 연결이 안 풀리는 원인이 낡은 코드일 수도 있다. 설정 화면에서도 알린다. */}
      {runtime.staleBuild && <UpdateBanner />}

      <p className="widget__alert widget__alert--warn">
        {reason ?? '접근 키와 이름을 넣으면 이 위젯이 그 사람의 기록으로 동작합니다.'}
      </p>

      <label className="widget__label" htmlFor="widget-key">
        접근 키
      </label>
      <input
        id="widget-key"
        className="input"
        type="password"
        autoComplete="off"
        data-testid="widget-access-key"
        value={accessKey}
        onChange={(e) => setAccessKey(e.target.value)}
      />

      <label className="widget__label" htmlFor="widget-name">
        이름
      </label>
      {options.length > 0 ? (
        <select
          id="widget-name"
          className="select"
          data-testid="widget-employee-select"
          value={options.includes(name) ? name : ''}
          onChange={(e) => setName(e.target.value)}
        >
          <option value="">— 선택 —</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          id="widget-name"
          className="input"
          data-testid="widget-employee-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      )}

      <button
        type="button"
        className="btn btn--primary btn--block mt12"
        data-testid="widget-connect"
        disabled={busy}
        onClick={() => void connect()}
      >
        {busy ? '연결 중…' : '연결하기'}
      </button>

      <div className="widget__foot">
        <span>{runtime.backendError ?? ''}</span>
        <span className="header__spacer" />
        <button type="button" className="widget__link" onClick={onSkip}>
          타이머만 먼저 쓰기
        </button>
      </div>
    </div>
  );
}

type Alert = { kind: 'warn' | 'danger'; text: string };

/** 위젯 상단 한 줄 경고. 가장 급한 것 하나만 보여준다. */
function alertFor(
  state: { notion: { schema: unknown } },
  runtime: { storagePersistent: boolean; syncBlocked: string | null; backendError: string | null },
  pending: number,
): Alert | null {
  // 임베드에서 가장 흔하고 가장 치명적인 상황: 브라우저가 iframe 저장소를 막았다.
  // 이 경우 창을 닫는 순간 그날 기록이 사라지므로 제일 먼저 알린다.
  if (!runtime.storagePersistent) {
    return {
      kind: 'danger',
      text: '이 브라우저가 위젯의 저장을 막고 있어 창을 닫으면 기록이 사라집니다. 아래 “전체 화면”으로 사용하세요.',
    };
  }
  if (runtime.syncBlocked) return { kind: 'danger', text: runtime.syncBlocked };
  if (runtime.backendError && state.notion.schema !== null) {
    return { kind: 'warn', text: `서버 연결 문제: ${runtime.backendError}` };
  }
  if (pending > 0) return { kind: 'warn', text: `Notion 저장 대기 ${pending}건 — 자동으로 재시도합니다.` };
  return null;
}

function syncText(
  state: { lastSync: { at: number } | null },
  runtime: { syncing: boolean },
  pending: number,
): string {
  if (runtime.syncing) return 'Notion 저장 중…';
  if (pending > 0) return `저장 대기 ${pending}건`;
  if (state.lastSync) return `${formatClock(state.lastSync.at)} Notion 저장됨`;
  return '아직 Notion에 저장 전';
}
