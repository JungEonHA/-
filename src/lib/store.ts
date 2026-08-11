/**
 * 애플리케이션 상태 저장소.
 *
 * 데이터 안정성 원칙
 *  - 로컬(브라우저)이 1차 진실이다. Notion 동기화는 그 위에 얹힌 부가 작업이며,
 *    동기화가 실패해도 로컬 기록은 절대 지워지거나 되돌려지지 않는다.
 *  - 실패한 동기화는 outbox 에 남아 지수 백오프로 자동 재시도되고, 수동 재시도도 가능하다.
 *  - outbox 는 "어떤 날짜가 dirty 한가"만 담는다. 실제 전송 페이로드는 전송 직전에
 *    최신 로그로부터 다시 만들기 때문에, 재시도가 낡은 값을 덮어쓸 수 없다.
 */

import {
  applyAction,
  computeDay,
  emptyDayLog,
  resolveActiveDate,
  type ActionKind,
  type DayLog,
} from './events';
import { buildRecord } from './record';
import {
  ApiError,
  addProperties as apiAddProperties,
  getDay,
  getHealth,
  getSchema,
  upsertRecord,
  type ClientConfig,
  type HealthInfo,
} from './notionClient';
import { mergeDayLogs, sameDayLog, serializeDayLog } from '../../shared/dayLog';
import {
  BACKUP_KEY,
  SHARED_KEYS,
  STORAGE_KEY,
  createInitialState,
  detectStore,
  keysFor,
  loadState,
  normalizeState,
  saveState,
  seedFromShared,
  type AppState,
  type KeyValueStore,
  type LogicalFieldKey,
  type NotionSettings,
  type OutboxEntry,
  type StateKeys,
} from './storage';
import { toDateKey } from './time';
import { MAX_TODOS, MAX_TODO_TEXT, makeTodoId, type TodoItem } from './todos';
import { planVacationChange, type VacationConfig } from './vacation';
import { suggestMapping } from '../../shared/fields';

export type BackendStatus = 'checking' | 'ready' | 'unavailable' | 'error';

export interface Notice {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

export interface RuntimeState {
  storagePersistent: boolean;
  saveError: string | null;
  backend: BackendStatus;
  backendInfo: HealthInfo | null;
  backendError: string | null;
  syncing: boolean;
  notice: Notice | null;
  /**
   * 자동 동기화가 설정 문제로 막혀 있을 때의 이유.
   *
   * 예전에는 이 상황에서 조용히 return 해서, 사용자는 "대기열도 비어 있고 오류도
   * 없는데 Notion 에는 아무것도 없는" 상태를 원인 없이 마주했다. 이제는 설정 화면에
   * 계속 떠 있는다.
   */
  syncBlocked: string | null;
}

export interface Snapshot {
  state: AppState;
  runtime: RuntimeState;
}

const MAX_BACKOFF_MS = 5 * 60 * 1000;
const BASE_BACKOFF_MS = 5 * 1000;
/** 백엔드가 아예 없다고 확인된 뒤의 재확인 간격 */
const BACKEND_RECHECK_MS = 10 * 60 * 1000;
/** 이 횟수를 넘으면 자동 재시도를 멈추고 수동 재시도를 기다린다 (무한 호출 방지) */
export const MAX_AUTO_ATTEMPTS = 8;

function backoffFor(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}

/**
 * 캐시된 스키마로 **비어 있는 매핑 칸만** 채운다. 사용자가 고른 값은 절대 바꾸지 않는다.
 *
 * 새 논리 필드(`직원`)가 추가돼도 기존 사용자는 저장된 매핑을 그대로 들고 있어서,
 * "스키마 다시 읽기"를 누르기 전까지 그 필드가 비어 있다. 하필 그 필드가 여러 명의
 * 기록을 가르는 기준이면, 그 사이에 두 사람 기록이 한 행으로 섞인다.
 * 서버가 쓰는 제안 규칙과 같은 규칙을, 네트워크 없이 시작 시점에 한 번 적용한다.
 */
function backfillMapping(state: AppState): AppState {
  const props = state.notion.schema?.properties;
  if (!props || props.length === 0) return state;

  const { mapping: suggested } = suggestMapping(props);
  const merged = { ...suggested, ...state.notion.mapping };
  const changed = Object.keys(merged).length !== Object.keys(state.notion.mapping).length;
  if (!changed) return state;

  return { ...state, notion: { ...state.notion, mapping: merged } };
}

export class AppStore {
  private snapshot: Snapshot;
  private listeners = new Set<() => void>();
  private store: KeyValueStore;
  private noticeSeq = 0;
  private draining = false;
  private redrainRequested = false;
  private lastBackendCheckAt = 0;
  private outboxSeq = 0;
  private mappingHealAttempted = false;

  private keys: StateKeys;

  constructor(
    private readonly now: () => number = () => Date.now(),
    store?: KeyValueStore,
    /**
     * 이 인스턴스가 쓸 저장 칸의 이름. URL 이 직원을 지정했을 때 그 이름을 넘긴다.
     * 같은 페이지에 위젯을 여러 개 띄워도 서로 덮어쓰지 않게 하는 유일한 장치다.
     */
    namespace: string | null = null,
  ) {
    this.store = store ?? detectStore();
    this.keys = keysFor(namespace);
    const state = backfillMapping(this.loadOrSeed(this.now()));
    // 저장된 대기열보다 뒤에서 이어 센다. 그러지 않으면 새로 연 탭이 낮은 번호를 발급해
    // "보내는 동안 또 바뀌었나" 판정이 한 번 어긋난다.
    this.outboxSeq = Object.values(state.outbox).reduce((max, e) => Math.max(max, e.seq ?? 0), 0);
    this.snapshot = {
      state,
      runtime: {
        storagePersistent: this.store.persistent,
        saveError: null,
        backend: 'checking',
        backendInfo: null,
        backendError: null,
        syncing: false,
        notice: null,
        syncBlocked: null,
      },
    };

    this.watchOtherTabs();
  }

  /**
   * 다른 탭이 저장소를 갱신하면 이 탭도 즉시 따라간다.
   *
   * `storage` 이벤트는 **다른** 탭에서만 발생하므로 자기 저장에는 반응하지 않는다.
   * 이게 없으면 여러 탭을 띄워 둔 사용자가 탭마다 서로 다른 근무시간을 보게 된다.
   */
  /**
   * 이 인스턴스의 칸을 읽는다. 아직 없으면 공용 칸의 연결 설정만 물려받아 시작한다.
   *
   * 기록 자체는 물려받지 않는다 — 그러면 다른 사람 기록을 자기 것으로 삼는 셈이다.
   * 비어 있어도 곧 `pullDay` 가 Notion 에서 그 사람 기록을 가져온다.
   */
  private loadOrSeed(now: number): AppState {
    if (this.keys.main === SHARED_KEYS.main) return loadState(this.store, now, this.keys);
    const own = this.store.getItem(this.keys.main) ?? this.store.getItem(this.keys.backup);
    if (own) return loadState(this.store, now, this.keys);

    // 물려받은 값을 즉시 자기 칸에 적어 둔다. 그래야 다음 읽기가 이 경로를 타지 않는다.
    const seeded = seedFromShared(loadState(this.store, now), now);
    saveState(this.store, seeded, this.keys);
    return seeded;
  }

  private watchOtherTabs() {
    if (typeof window === 'undefined' || !this.store.persistent) return;
    window.addEventListener('storage', (e) => {
      // 자기 칸의 변경만 따라간다. 같은 페이지의 다른 직원 위젯이 저장했다고
      // 이쪽까지 그 사람 상태로 바뀌면 안 된다.
      if (e.key !== null && e.key !== this.keys.main) return;
      this.snapshot = { ...this.snapshot, state: this.latestState() };
      this.emit();
    });
  }

  // -- React 연동 --------------------------------------------------------
  getSnapshot = (): Snapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit() {
    for (const l of this.listeners) l();
  }

  /**
   * 저장소에 실제로 들어 있는 최신 상태. 읽지 못하면 메모리 상태로 물러난다.
   *
   * 같은 브라우저에서 앱을 여러 탭에 띄우면 탭마다 "페이지를 연 시점"의 스냅샷을
   * 메모리에 들고 있다. 낡은 탭이 무엇이든 한 번 저장하는 순간 그 스냅샷이 통째로
   * 최신 기록을 덮어쓴다 — 실제로 이 경로로 하루치 이벤트와 매핑이 전부 날아갔다.
   * 그래서 쓰기는 언제나 "지금 저장소에 있는 값" 위에서 한다.
   */
  private latestState(): AppState {
    try {
      // `loadOrSeed` 를 거쳐야 한다. 아직 자기 칸이 저장된 적 없는 위젯에서
      // 곧바로 `loadState` 를 부르면 빈 상태가 나오고, 그 위에 첫 저장이 얹히면서
      // 물려받은 접근 키·매핑이 그대로 날아간다.
      return backfillMapping(this.loadOrSeed(this.now()));
    } catch {
      return this.snapshot.state;
    }
  }

  private setState(updater: (s: AppState) => AppState) {
    const next = updater(this.latestState());
    const result = saveState(this.store, next, this.keys);
    this.snapshot = {
      state: next,
      runtime: {
        ...this.snapshot.runtime,
        saveError: result.ok ? null : (result.error ?? '저장에 실패했습니다.'),
      },
    };
    this.emit();
  }

  private setRuntime(patch: Partial<RuntimeState>) {
    this.snapshot = { ...this.snapshot, runtime: { ...this.snapshot.runtime, ...patch } };
    this.emit();
  }

  notify(kind: Notice['kind'], text: string) {
    this.setRuntime({ notice: { id: ++this.noticeSeq, kind, text } });
  }

  dismissNotice() {
    this.setRuntime({ notice: null });
  }

  // -- 파생값 ------------------------------------------------------------
  get activeDate(): string {
    return resolveActiveDate(this.snapshot.state.logs, this.now());
  }

  logFor(dateKey: string): DayLog {
    return this.snapshot.state.logs[dateKey] ?? emptyDayLog(dateKey);
  }

  /** await 이후에도 최신 값을 읽기 위한 접근자 (타입 좁히기 방지) */
  private backendStatus(): BackendStatus {
    return this.snapshot.runtime.backend;
  }

  private clientConfig(): ClientConfig {
    const { apiBase, accessKey } = this.snapshot.state.notion;
    // 붙여넣기로 딸려 들어온 공백/줄바꿈 때문에 URL 이 깨지거나 접근 키가
    // 어긋나는 일이 잦다. 저장값은 건드리지 않고 전송할 때만 다듬는다.
    return { apiBase: apiBase.trim(), accessKey: accessKey.trim() };
  }

  // -- 출퇴근 액션 -------------------------------------------------------
  perform(action: ActionKind): boolean {
    const at = this.now();
    const dateKey = action === 'clock_in' ? toDateKey(at) : this.activeDate;
    const current = this.logFor(dateKey);
    const result = applyAction(current, action, at);

    if (!result.ok) {
      this.notify('error', result.reason);
      return false;
    }

    this.setState((s) => ({ ...s, logs: { ...s.logs, [dateKey]: result.log } }));

    const labels: Record<ActionKind, string> = {
      clock_in: '출근 처리되었습니다.',
      away_start: '자리 비움 — 근무시간 측정을 멈췄습니다.',
      away_end: '복귀 — 근무시간 측정을 재개했습니다.',
      clock_out: '퇴근 처리되었습니다.',
      resume: '업무에 복귀했습니다 — 근무시간을 이어서 측정합니다.',
    };
    this.notify('success', labels[action]);

    // 모든 상태 변화를 Notion 에 반영한다.
    //
    // 예전에는 퇴근할 때만 보냈다. 그러다 보니 출근해서 일하는 동안 Notion 에는
    // 아무 흔적이 없었고, "기록이 안 넘어간다"는 오해를 샀다. 하루치 행은 어차피
    // upsert 로 하나만 유지되므로, 매 액션마다 같은 행을 갱신하면 된다.
    this.enqueue(dateKey, { auto: true });
    return true;
  }

  // -- 휴가 -------------------------------------------------------------
  changeVacation(dateKey: string, deltaMs: number): boolean {
    const { logs, vacation } = this.snapshot.state;
    const plan = planVacationChange(logs, vacation, dateKey, deltaMs);
    if (!plan.ok) {
      this.notify('error', plan.reason);
      return false;
    }

    this.setState((s) => {
      const base = s.logs[dateKey] ?? emptyDayLog(dateKey);
      return {
        ...s,
        logs: { ...s.logs, [dateKey]: { ...base, vacationMs: plan.nextDayVacationMs } },
      };
    });

    this.notify(
      'success',
      deltaMs > 0
        ? `${dateKey} 휴가 ${deltaMs / 3600000}시간 사용 처리했습니다.`
        : `${dateKey} 휴가 ${Math.abs(deltaMs) / 3600000}시간 취소했습니다.`,
    );
    this.enqueue(dateKey, { auto: true });
    return true;
  }

  updateVacationConfig(patch: Partial<VacationConfig>) {
    this.setState((s) => ({ ...s, vacation: { ...s.vacation, ...patch } }));
  }

  // -- 업무 리스트 -------------------------------------------------------
  //
  // 근무 이벤트와 달리 사람이 고쳐 쓰는 값이라 append-only 가 아니다. 그래서 바꿀
  // 때마다 `updatedAt` 을 찍는다 — 기기 간 병합에서 "마지막에 손댄 쪽"을 가리는 기준이다.

  todosFor(dateKey: string): TodoItem[] {
    return this.logFor(dateKey).todos ?? [];
  }

  private mutateTodos(dateKey: string, fn: (todos: TodoItem[]) => TodoItem[]): void {
    const at = this.now();
    this.setState((s) => {
      const base = s.logs[dateKey] ?? emptyDayLog(dateKey);
      return {
        ...s,
        logs: {
          ...s.logs,
          [dateKey]: { ...base, todos: fn(base.todos ?? []), updatedAt: at, todosAt: at },
        },
      };
    });
    this.enqueue(dateKey, { auto: true });
  }

  addTodo(dateKey: string, text: string): boolean {
    const clean = text.trim().slice(0, MAX_TODO_TEXT);
    if (!clean) return false;
    if (this.todosFor(dateKey).length >= MAX_TODOS) {
      this.notify('error', `할 일은 하루 ${MAX_TODOS}개까지 적을 수 있습니다.`);
      return false;
    }
    const id = makeTodoId(this.now());
    this.mutateTodos(dateKey, (todos) => [...todos, { id, text: clean, done: false }]);
    return true;
  }

  toggleTodo(dateKey: string, id: string): void {
    if (!this.todosFor(dateKey).some((t) => t.id === id)) return;
    this.mutateTodos(dateKey, (todos) =>
      todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t)),
    );
  }

  /** 빈 값은 무시한다 — 지우는 것은 삭제 버튼으로만 (실수로 날리지 않도록). */
  editTodo(dateKey: string, id: string, text: string): boolean {
    const clean = text.trim().slice(0, MAX_TODO_TEXT);
    const current = this.todosFor(dateKey).find((t) => t.id === id);
    if (!clean || !current || current.text === clean) return false;
    this.mutateTodos(dateKey, (todos) =>
      todos.map((t) => (t.id === id ? { ...t, text: clean } : t)),
    );
    return true;
  }

  removeTodo(dateKey: string, id: string): void {
    if (!this.todosFor(dateKey).some((t) => t.id === id)) return;
    this.mutateTodos(dateKey, (todos) => todos.filter((t) => t.id !== id));
  }

  /** 위/아래로 한 칸 옮긴다. 끝에서 더 가려 하면 아무 일도 하지 않는다. */
  moveTodo(dateKey: string, id: string, direction: -1 | 1): void {
    const todos = this.todosFor(dateKey);
    const from = todos.findIndex((t) => t.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= todos.length) return;
    this.mutateTodos(dateKey, (list) => {
      const next = [...list];
      const [moved] = next.splice(from, 1);
      if (moved) next.splice(to, 0, moved);
      return next;
    });
  }

  // -- 설정 -------------------------------------------------------------
  updateNotionSettings(patch: Partial<NotionSettings>) {
    this.setState((s) => ({ ...s, notion: { ...s.notion, ...patch } }));
  }

  /**
   * 이 기기를 쓰는 직원을 정한다.
   *
   * 사람이 바뀌면 이전 사람의 Notion 행을 계속 갱신하면 안 되므로 pageId 캐시를
   * 비운다. 다음 동기화 때 새 이름으로 행을 다시 찾거나 새로 만든다.
   */
  setEmployeeName(name: string) {
    const next = name.trim();
    if (next === this.snapshot.state.notion.employeeName) return;
    this.setState((s) => ({
      ...s,
      notion: { ...s.notion, employeeName: next, pageIds: {} },
    }));
    this.notify('success', next ? `이 기기의 직원을 "${next}" 로 설정했습니다.` : '직원 설정을 지웠습니다.');
  }

  /**
   * URL 이 지정한 설정을 반영한다 (Notion Embed 위젯용).
   *
   * 저장된 값보다 URL 을 우선한다. 임베드 블록의 주소가 곧 "이 위젯은 누구 것인가"의
   * 선언이기 때문이다 — 저장소가 비어 있든 남의 이름이 들어 있든 블록이 말하는
   * 사람으로 맞춘다. 지정하지 않은 항목(null)은 건드리지 않는다.
   *
   * @returns 실제로 바뀐 것이 있으면 true
   */
  applyBootParams(params: { employeeName: string | null; accessKey: string | null }): boolean {
    const n = this.snapshot.state.notion;
    const nextKey = params.accessKey;
    const nextName = params.employeeName?.trim() ?? null;
    const keyChanged = nextKey !== null && nextKey !== n.accessKey;
    const nameChanged = nextName !== null && nextName !== n.employeeName;
    if (!keyChanged && !nameChanged) return false;

    this.setState((s) => ({
      ...s,
      notion: {
        ...s.notion,
        ...(keyChanged ? { accessKey: nextKey } : {}),
        // 사람이 바뀌면 이전 사람의 Notion 행을 계속 갱신하면 안 된다.
        ...(nameChanged ? { employeeName: nextName, pageIds: {} } : {}),
      },
    }));
    return true;
  }

  setMappingField(field: LogicalFieldKey, propertyName: string | null) {
    this.setState((s) => {
      const mapping = { ...s.notion.mapping };
      if (propertyName) mapping[field] = propertyName;
      else delete mapping[field];
      return { ...s, notion: { ...s.notion, mapping } };
    });
  }

  // -- 백엔드 / 스키마 ---------------------------------------------------

  /**
   * 백엔드 존재 여부를 확인한다.
   *
   * Notion 을 아직 연결하지 않은 사용자(정적 배포 / 타이머만 사용)에게는 백엔드가
   * 영영 나타나지 않는다. 그런 상태에서 자동 확인을 계속 돌리면 실패하는 요청이
   * 1분마다 무한히 나가므로, 'unavailable' 로 확정된 뒤에는 재확인 간격을 늘린다.
   * 사용자가 직접 누르는 "연결 확인"은 force 로 항상 즉시 확인한다.
   */
  async checkBackend(opts: { force?: boolean } = {}): Promise<void> {
    const now = this.now();
    if (
      !opts.force &&
      this.backendStatus() === 'unavailable' &&
      now - this.lastBackendCheckAt < BACKEND_RECHECK_MS
    ) {
      return;
    }
    this.lastBackendCheckAt = now;

    this.setRuntime({ backend: 'checking', backendError: null });
    try {
      const info = await getHealth(this.clientConfig());
      const usable = info.notionConfigured && info.databaseConfigured;
      this.setRuntime({
        backend: usable ? 'ready' : 'error',
        backendInfo: info,
        backendError: usable
          ? null
          : 'NOTION_TOKEN / NOTION_DATABASE_ID 환경변수가 서버에 설정되지 않았습니다.',
      });
    } catch (err) {
      const e = err as ApiError;
      this.setRuntime({
        backend: e.code === 'no_backend' || e.status === 404 ? 'unavailable' : 'error',
        backendInfo: null,
        backendError: e.message,
      });
    }
  }

  /**
   * 저장해 둔 스키마가 낡아 새 Property 를 못 보는 상태를 스스로 고친다.
   *
   * Notion 임베드 위젯은 iframe 이라 브라우저가 저장소를 따로 쪼개 준다. 그래서 전체
   * 화면에서 `업무 리스트` Property 를 만들어도 위젯은 그 사실을 모르고, 예전 매핑으로
   * 계속 저장한다 — 위젯에 적은 할 일이 Notion 에 영영 안 올라간다. 사용자가 설정
   * 화면을 열어 "스키마 다시 읽기"를 누를 방법도 위젯 안에는 없다.
   *
   * 한 세션에 한 번만, 조용히 시도한다. Property 가 정말 없는 워크스페이스에서도
   * 요청 한 번으로 끝나고 토스트를 띄우지 않는다.
   */
  private async healMapping(): Promise<void> {
    if (this.mappingHealAttempted) return;
    if (this.snapshot.state.notion.mapping.todos) return;
    this.mappingHealAttempted = true;
    try {
      const res = await getSchema(this.clientConfig());
      this.setState((s) => ({
        ...s,
        notion: {
          ...s.notion,
          schema: res.schema,
          // 사용자가 직접 정한 매핑이 우선이고, 비어 있던 칸만 채운다.
          mapping: { ...res.suggestedMapping, ...s.notion.mapping },
        },
      }));
    } catch {
      // 조용히 넘어간다 — 읽기 실패로 잃는 것은 없고 다음 세션에 다시 시도한다.
    }
  }

  async refreshSchema(): Promise<void> {
    try {
      const res = await getSchema(this.clientConfig());
      this.setState((s) => ({
        ...s,
        notion: {
          ...s.notion,
          schema: res.schema,
          // 사용자가 이미 정한 매핑을 우선하고, 비어 있는 필드만 제안값으로 채운다.
          mapping: { ...res.suggestedMapping, ...s.notion.mapping },
        },
      }));
      this.notify(
        'success',
        `DB "${res.schema.title}" 의 Property ${res.schema.properties.length}개를 읽었습니다.`,
      );
    } catch (err) {
      this.notify('error', `스키마를 읽지 못했습니다: ${(err as Error).message}`);
    }
  }

  async addMissingProperties(fields: LogicalFieldKey[]): Promise<void> {
    try {
      const res = await apiAddProperties(this.clientConfig(), fields);
      this.setState((s) => ({
        ...s,
        notion: {
          ...s.notion,
          schema: res.schema,
          mapping: { ...s.notion.mapping, ...res.suggestedMapping },
        },
      }));
      this.notify(
        'success',
        res.added.length > 0
          ? `Property ${res.added.map((a) => a.name).join(', ')} 를 추가했습니다.`
          : '추가할 Property가 없습니다.',
      );
    } catch (err) {
      this.notify('error', `Property 추가 실패: ${(err as Error).message}`);
    }
  }

  // -- 동기화 outbox -----------------------------------------------------
  enqueue(dateKey: string, opts: { auto?: boolean } = {}) {
    const seq = ++this.outboxSeq;
    this.setState((s) => ({
      ...s,
      outbox: {
        ...s.outbox,
        [dateKey]: {
          dateKey,
          attempts: 0,
          nextAttemptAt: 0,
          lastError: null,
          queuedAt: s.outbox[dateKey]?.queuedAt ?? this.now(),
          seq,
        },
      },
    }));
    if (!opts.auto || !this.snapshot.state.notion.autoSync) return;
    // 이미 한 건을 보내는 중이면 그 회차는 이 항목을 못 본다. 표시해 두었다가
    // 끝나는 즉시 한 번 더 돌린다 — 그러지 않으면 방금 적은 할 일이 다음
    // 주기(1분)까지 Notion 에 안 간다.
    if (this.draining) this.redrainRequested = true;
    else void this.drainOutbox();
  }

  /**
   * 다른 기기에서 합쳐진 하루 기록을 이 기기의 기록으로 받아들인다.
   * 실제로 달라졌을 때만 저장한다 — 매 동기화마다 무의미한 쓰기를 만들지 않기 위해.
   */
  private adoptDayLog(incoming: DayLog): boolean {
    const current = this.snapshot.state.logs[incoming.date];
    const merged = mergeDayLogs(current ?? null, incoming);
    if (!merged || sameDayLog(current ?? null, merged)) return false;

    this.setState((s) => ({ ...s, logs: { ...s.logs, [merged.date]: merged } }));
    return true;
  }

  /**
   * 다른 기기가 남긴 그날의 기록을 읽어 와 합친다.
   *
   * 앱을 열었을 때와 창으로 돌아왔을 때 부른다. 이게 없으면 노트북 화면은 "출근 전"인데
   * Notion 에는 근무 중인 모순된 상태가 보인다. 읽기 전용이라 실패해도 잃는 것이 없다.
   */
  async pullDay(dateKey: string, opts: { notify?: boolean } = {}): Promise<void> {
    const { mapping, employeeName } = this.snapshot.state.notion;
    if (!mapping.eventLog) {
      if (opts.notify) {
        this.notify('error', '설정 › Property 매핑에서 “기기 연동 로그”를 지정해야 기기 간 기록이 합쳐집니다.');
      }
      return;
    }
    if (this.backendStatus() !== 'ready') {
      await this.checkBackend({ force: opts.notify === true });
      if (this.backendStatus() !== 'ready') return;
    }

    // 낡은 매핑으로는 업무 리스트를 읽지도 쓰지도 못한다. 읽기 직전에 한 번 고친다.
    await this.healMapping();

    try {
      const res = await getDay(this.clientConfig(), {
        dateKey,
        employeeName: employeeName.trim() || null,
        // 방금 고쳐졌을 수 있으므로 저장된 값을 다시 읽는다.
        mapping: this.snapshot.state.notion.mapping,
      });
      if (res.pageId) {
        this.setState((s) => ({
          ...s,
          notion: { ...s.notion, pageIds: { ...s.notion.pageIds, [dateKey]: res.pageId! } },
        }));
      }
      const changed = res.dayLog ? this.adoptDayLog(res.dayLog) : false;
      if (opts.notify) {
        this.notify(
          changed ? 'success' : 'info',
          changed ? '다른 기기의 기록을 가져와 합쳤습니다.' : '가져올 새 기록이 없습니다.',
        );
      }
    } catch (err) {
      // 읽기 실패는 조용히 넘긴다 — 로컬 기록은 그대로이고 다음 기회에 다시 시도한다.
      if (opts.notify) this.notify('error', `기록을 가져오지 못했습니다: ${(err as Error).message}`);
    }
  }

  /**
   * 이미 동기화가 끝난 날짜라도 강제로 다시 보낸다.
   *
   * 매핑을 나중에 고쳤을 때 예전에는 다시 보낼 방법이 아예 없었다 —
   * 대기열이 비어 있으면 "지금 동기화"도 아무 일도 하지 않았다.
   */
  resync(dateKey: string) {
    this.enqueue(dateKey);
    void this.drainOutbox({ force: true });
  }

  removeFromOutbox(dateKey: string) {
    this.setState((s) => {
      const outbox = { ...s.outbox };
      delete outbox[dateKey];
      return { ...s, outbox };
    });
  }

  /** 자동/수동 공통 큐 처리. 동시에 두 번 돌지 않는다. */
  async drainOutbox(opts: { force?: boolean } = {}): Promise<void> {
    if (this.draining) return;

    if (this.backendStatus() !== 'ready') {
      await this.checkBackend({ force: opts.force === true });
      if (this.backendStatus() !== 'ready') {
        if (opts.force) {
          this.notify(
            'error',
            this.snapshot.runtime.backendError ?? 'Notion 백엔드를 사용할 수 없습니다.',
          );
        }
        return;
      }
    }

    const blocked = this.syncBlockReason();
    if (blocked) {
      this.setRuntime({ syncBlocked: blocked });
      if (opts.force) this.notify('error', blocked);
      return;
    }
    this.setRuntime({ syncBlocked: null });

    this.draining = true;
    this.setRuntime({ syncing: true });

    try {
      let processed = 0;
      let failed = 0;

      for (const entry of this.dueEntries(opts.force === true)) {
        const ok = await this.syncOne(entry);
        if (ok) processed += 1;
        else failed += 1;
      }

      if (processed > 0) {
        this.setState((s) => ({ ...s, lastSyncAt: this.now() }));
        this.notify('success', `Notion에 ${processed}건 기록했습니다.`);
      } else if (opts.force && failed === 0) {
        this.notify('info', '동기화할 새 기록이 없습니다.');
      }
    } finally {
      this.draining = false;
      this.setRuntime({ syncing: false });
      if (this.redrainRequested) {
        this.redrainRequested = false;
        void this.drainOutbox();
      }
    }
  }

  /**
   * 지금 동기화하면 안 되는 이유. 없으면 null.
   * UI 가 그대로 띄우는 문구이므로 "무엇을 하면 되는지"까지 담는다.
   */
  syncBlockReason(): string | null {
    const { mapping, employeeName } = this.snapshot.state.notion;
    if (!mapping.date && !mapping.title) {
      return '설정 › Property 매핑에서 최소한 날짜(또는 제목)를 지정해야 Notion에 기록할 수 있습니다.';
    }
    // 직원 칸을 매핑해 놓고 이름을 비워 두면, 누구 기록인지 모르는 행이 만들어지고
    // 다른 사람 행과 섞인다. 그 전에 멈춘다.
    if (mapping.employee && !employeeName.trim()) {
      return '설정 › 직원에서 이 기기를 쓰는 사람을 먼저 선택하세요. 누구의 기록인지 정해야 다른 직원 기록과 섞이지 않습니다.';
    }
    return null;
  }

  private dueEntries(force: boolean): OutboxEntry[] {
    const now = this.now();
    return Object.values(this.snapshot.state.outbox)
      .filter((e) => force || (e.nextAttemptAt <= now && e.attempts < MAX_AUTO_ATTEMPTS))
      .sort((a, b) => a.queuedAt - b.queuedAt);
  }

  private async syncOne(entry: OutboxEntry): Promise<boolean> {
    const { dateKey } = entry;
    const { logs, notion } = this.snapshot.state;
    const log = logs[dateKey];

    // 로그가 사라진 날짜는 큐에서만 제거한다 (Notion 데이터는 건드리지 않는다).
    if (!log) {
      this.removeFromOutbox(dateKey);
      return false;
    }

    // 전송 직전에 최신 상태로 페이로드를 만든다 — 낡은 값 덮어쓰기 방지.
    const record = buildRecord(
      computeDay(log, this.now()),
      notion.employeeName,
      serializeDayLog(log),
      log.todos ?? null,
    );

    try {
      const res = await upsertRecord(this.clientConfig(), {
        record,
        dayLog: notion.mapping.eventLog ? log : null,
        mapping: notion.mapping,
        schema: notion.schema,
        knownPageId: notion.pageIds[dateKey] ?? null,
      });

      // 서버가 다른 기기의 이벤트까지 합쳐 돌려주면 그것을 이 기기의 기록으로 삼는다.
      if (res.mergedLog) this.adoptDayLog(res.mergedLog);

      const warning = res.duplicateWarning ?? res.foreignRowWarning ?? null;
      this.setState((s) => {
        const outbox = { ...s.outbox };
        // 보내는 동안 같은 날짜가 또 바뀌었다면(할 일을 연달아 적는 경우가 흔하다)
        // 방금 보낸 페이로드는 이미 낡았다. 큐에 남겨 곧바로 다시 보낸다.
        const latest = outbox[dateKey];
        if (latest && latest.seq !== entry.seq) {
          outbox[dateKey] = { ...latest, attempts: 0, nextAttemptAt: 0, lastError: null };
          this.redrainRequested = true;
        } else {
          delete outbox[dateKey];
        }
        return {
          ...s,
          outbox,
          notion: { ...s.notion, pageIds: { ...s.notion.pageIds, [dateKey]: res.pageId } },
          lastSync: {
            at: this.now(),
            dateKey,
            employeeName: record.employeeName,
            action: res.action,
            pageUrl: res.url ?? null,
            warning,
          },
        };
      });

      if (warning) this.notify('info', warning);
      return true;
    } catch (err) {
      const e = err as ApiError;
      // 실패해도 로컬 기록은 그대로 둔다. 큐에 남겨 재시도한다.
      this.setState((s) => {
        const prev = s.outbox[dateKey];
        if (!prev) return s;
        const attempts = prev.attempts + 1;
        return {
          ...s,
          outbox: {
            ...s.outbox,
            [dateKey]: {
              ...prev,
              attempts,
              nextAttemptAt: this.now() + backoffFor(attempts),
              lastError: e.message,
            },
          },
        };
      });
      this.notify('error', `${dateKey} 동기화 실패: ${e.message} (기록은 안전하게 보관됩니다)`);
      return false;
    }
  }

  // -- 백업 / 복구 -------------------------------------------------------
  exportJson(): string {
    return JSON.stringify(this.snapshot.state, null, 2);
  }

  importJson(text: string): boolean {
    try {
      const parsed = normalizeState(JSON.parse(text), this.now());
      this.setState(() => parsed);
      this.notify('success', '데이터를 가져왔습니다.');
      return true;
    } catch (err) {
      this.notify('error', `가져오기 실패: ${(err as Error).message}`);
      return false;
    }
  }

  resetAll() {
    this.setState(() => createInitialState(this.now()));
    this.notify('info', '모든 로컬 데이터를 초기화했습니다. (Notion 기록은 그대로입니다)');
  }
}

export { STORAGE_KEY, BACKUP_KEY };
