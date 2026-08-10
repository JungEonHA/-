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
  getHealth,
  getSchema,
  upsertRecord,
  type ClientConfig,
  type HealthInfo,
} from './notionClient';
import {
  BACKUP_KEY,
  STORAGE_KEY,
  createInitialState,
  detectStore,
  loadState,
  normalizeState,
  saveState,
  type AppState,
  type KeyValueStore,
  type LogicalFieldKey,
  type NotionSettings,
  type OutboxEntry,
} from './storage';
import { toDateKey } from './time';
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
  private lastBackendCheckAt = 0;

  constructor(
    private readonly now: () => number = () => Date.now(),
    store?: KeyValueStore,
  ) {
    this.store = store ?? detectStore();
    const state = backfillMapping(loadState(this.store, this.now()));
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

  private setState(updater: (s: AppState) => AppState) {
    const next = updater(this.snapshot.state);
    const result = saveState(this.store, next);
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
        },
      },
    }));
    if (opts.auto && this.snapshot.state.notion.autoSync) void this.drainOutbox();
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
    const record = buildRecord(computeDay(log, this.now()), notion.employeeName);

    try {
      const res = await upsertRecord(this.clientConfig(), {
        record,
        mapping: notion.mapping,
        schema: notion.schema,
        knownPageId: notion.pageIds[dateKey] ?? null,
      });

      const warning = res.duplicateWarning ?? res.foreignRowWarning ?? null;
      this.setState((s) => {
        const outbox = { ...s.outbox };
        delete outbox[dateKey];
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
