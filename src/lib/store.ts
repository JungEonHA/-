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
}

export interface Snapshot {
  state: AppState;
  runtime: RuntimeState;
}

const MAX_BACKOFF_MS = 5 * 60 * 1000;
const BASE_BACKOFF_MS = 5 * 1000;
/** 이 횟수를 넘으면 자동 재시도를 멈추고 수동 재시도를 기다린다 (무한 호출 방지) */
export const MAX_AUTO_ATTEMPTS = 8;

function backoffFor(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}

export class AppStore {
  private snapshot: Snapshot;
  private listeners = new Set<() => void>();
  private store: KeyValueStore;
  private noticeSeq = 0;
  private draining = false;

  constructor(
    private readonly now: () => number = () => Date.now(),
    store?: KeyValueStore,
  ) {
    this.store = store ?? detectStore();
    const state = loadState(this.store, this.now());
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
    return { apiBase, accessKey };
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
    };
    this.notify('success', labels[action]);

    if (action === 'clock_out') this.enqueue(dateKey, { auto: true });
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

  setMappingField(field: LogicalFieldKey, propertyName: string | null) {
    this.setState((s) => {
      const mapping = { ...s.notion.mapping };
      if (propertyName) mapping[field] = propertyName;
      else delete mapping[field];
      return { ...s, notion: { ...s.notion, mapping } };
    });
  }

  // -- 백엔드 / 스키마 ---------------------------------------------------
  async checkBackend(): Promise<void> {
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
      await this.checkBackend();
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

    const mapping = this.snapshot.state.notion.mapping;
    if (!mapping.date && !mapping.title) {
      if (opts.force) this.notify('error', '먼저 설정에서 Notion Property 매핑을 완료하세요.');
      return;
    }

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
    const record = buildRecord(computeDay(log, this.now()));

    try {
      const res = await upsertRecord(this.clientConfig(), {
        record,
        mapping: notion.mapping,
        schema: notion.schema,
        knownPageId: notion.pageIds[dateKey] ?? null,
      });

      this.setState((s) => {
        const outbox = { ...s.outbox };
        delete outbox[dateKey];
        return {
          ...s,
          outbox,
          notion: { ...s.notion, pageIds: { ...s.notion.pageIds, [dateKey]: res.pageId } },
        };
      });

      if (res.duplicateWarning) this.notify('info', res.duplicateWarning);
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
