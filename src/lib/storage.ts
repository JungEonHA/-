/**
 * 영속화 계층.
 *
 * Notion Embed 는 iframe 안에서 동작하므로 브라우저가 서드파티 스토리지를 막을 수 있다.
 * 그런 환경에서도 앱이 죽지 않도록:
 *   - localStorage 사용 가능 여부를 감지하고, 불가하면 메모리 저장소로 자동 대체한다.
 *   - 대체 모드일 때 UI 가 경고를 띄운다 (탭을 닫으면 기록이 사라지므로).
 *
 * 또한 저장 실패/손상에 대비해 직전 정상 스냅샷을 백업 키에 함께 보관한다.
 */

import type { LogicalField } from '../../shared/fields';
import type { DayLog } from './events';
import type { VacationConfig } from './vacation';
import { defaultVacationConfig } from './vacation';

export const STORAGE_KEY = 'worktime.studio.state.v1';
export const BACKUP_KEY = 'worktime.studio.state.v1.bak';

export interface NotionPropertyInfoLite {
  id: string;
  name: string;
  type: string;
  options?: string[];
}
export interface DatabaseSchemaLite {
  databaseId: string;
  title: string;
  url?: string;
  properties: NotionPropertyInfoLite[];
}

/** 서버와 공유하는 논리 필드 키 */
export type LogicalFieldKey = LogicalField;

export interface NotionSettings {
  /** 퇴근/휴가변경 시 자동 동기화 여부 */
  autoSync: boolean;
  /** 백엔드 주소. 빈 문자열이면 같은 오리진의 /api 를 사용 */
  apiBase: string;
  /** 서버가 APP_ACCESS_KEY 를 요구할 때 보낼 값 */
  accessKey: string;
  mapping: Partial<Record<LogicalFieldKey, string>>;
  schema: DatabaseSchemaLite | null;
  /** dateKey -> Notion page id (중복 생성 방지 빠른 경로) */
  pageIds: Record<string, string>;
}

export interface OutboxEntry {
  dateKey: string;
  attempts: number;
  /** 이 시각 이후에 재시도 */
  nextAttemptAt: number;
  lastError: string | null;
  queuedAt: number;
}

export interface AppState {
  version: 1;
  logs: Record<string, DayLog>;
  vacation: VacationConfig;
  notion: NotionSettings;
  outbox: Record<string, OutboxEntry>;
  lastSyncAt: number | null;
}

export function createInitialState(now: number): AppState {
  return {
    version: 1,
    logs: {},
    vacation: defaultVacationConfig(now),
    notion: {
      autoSync: true,
      apiBase: '',
      accessKey: '',
      mapping: {},
      schema: null,
      pageIds: {},
    },
    outbox: {},
    lastSyncAt: null,
  };
}

// ---------------------------------------------------------------------------
// 스토리지 백엔드
// ---------------------------------------------------------------------------

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  readonly persistent: boolean;
}

class MemoryStore implements KeyValueStore {
  private map = new Map<string, string>();
  readonly persistent = false;
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

class LocalStore implements KeyValueStore {
  readonly persistent = true;
  getItem(key: string) {
    return window.localStorage.getItem(key);
  }
  setItem(key: string, value: string) {
    window.localStorage.setItem(key, value);
  }
}

/** localStorage 를 실제로 읽고 쓸 수 있는지 확인 (iframe 차단/사생활 모드 대응) */
export function detectStore(): KeyValueStore {
  try {
    const probe = '__worktime_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return new LocalStore();
  } catch {
    return new MemoryStore();
  }
}

// ---------------------------------------------------------------------------
// 직렬화 / 검증
// ---------------------------------------------------------------------------

/** 신뢰할 수 없는 입력을 AppState 로 정규화한다. 깨진 항목은 버리고 나머지는 살린다. */
export function normalizeState(raw: unknown, now: number): AppState {
  const base = createInitialState(now);
  if (!raw || typeof raw !== 'object') return base;
  const obj = raw as Partial<AppState>;

  const logs: Record<string, DayLog> = {};
  for (const [dateKey, value] of Object.entries(obj.logs ?? {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !value || typeof value !== 'object') continue;
    const v = value as Partial<DayLog>;
    const events = Array.isArray(v.events)
      ? v.events
          .filter(
            (e): e is { type: DayLog['events'][number]['type']; at: number } =>
              !!e &&
              typeof (e as any).at === 'number' &&
              Number.isFinite((e as any).at) &&
              ['clock_in', 'away_start', 'away_end', 'clock_out'].includes((e as any).type),
          )
          .map((e) => ({ type: e.type, at: e.at }))
          .sort((a, b) => a.at - b.at)
      : [];
    const vacationMs =
      typeof v.vacationMs === 'number' && Number.isFinite(v.vacationMs)
        ? Math.max(0, v.vacationMs)
        : 0;
    if (events.length === 0 && vacationMs === 0) continue;
    logs[dateKey] = { date: dateKey, events, vacationMs, ...(v.memo ? { memo: v.memo } : {}) };
  }

  const vacation: VacationConfig = {
    grantStartMonth:
      typeof obj.vacation?.grantStartMonth === 'string' &&
      /^\d{4}-\d{2}$/.test(obj.vacation.grantStartMonth)
        ? obj.vacation.grantStartMonth
        : base.vacation.grantStartMonth,
    monthlyGrantMs:
      typeof obj.vacation?.monthlyGrantMs === 'number' && obj.vacation.monthlyGrantMs >= 0
        ? obj.vacation.monthlyGrantMs
        : base.vacation.monthlyGrantMs,
    dailyCapMs:
      typeof obj.vacation?.dailyCapMs === 'number' && obj.vacation.dailyCapMs > 0
        ? obj.vacation.dailyCapMs
        : base.vacation.dailyCapMs,
  };

  const n: Partial<NotionSettings> = obj.notion ?? {};
  const notion: NotionSettings = {
    autoSync: typeof n.autoSync === 'boolean' ? n.autoSync : true,
    apiBase: typeof n.apiBase === 'string' ? n.apiBase : '',
    accessKey: typeof n.accessKey === 'string' ? n.accessKey : '',
    mapping: n.mapping && typeof n.mapping === 'object' ? { ...n.mapping } : {},
    schema: n.schema && typeof n.schema === 'object' ? n.schema : null,
    pageIds: n.pageIds && typeof n.pageIds === 'object' ? { ...n.pageIds } : {},
  };

  const outbox: Record<string, OutboxEntry> = {};
  for (const [dateKey, entry] of Object.entries(obj.outbox ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Partial<OutboxEntry>;
    outbox[dateKey] = {
      dateKey,
      attempts: typeof e.attempts === 'number' ? e.attempts : 0,
      nextAttemptAt: typeof e.nextAttemptAt === 'number' ? e.nextAttemptAt : 0,
      lastError: typeof e.lastError === 'string' ? e.lastError : null,
      queuedAt: typeof e.queuedAt === 'number' ? e.queuedAt : now,
    };
  }

  return {
    version: 1,
    logs,
    vacation,
    notion,
    outbox,
    lastSyncAt: typeof obj.lastSyncAt === 'number' ? obj.lastSyncAt : null,
  };
}

export function loadState(store: KeyValueStore, now: number): AppState {
  for (const key of [STORAGE_KEY, BACKUP_KEY]) {
    const raw = store.getItem(key);
    if (!raw) continue;
    try {
      return normalizeState(JSON.parse(raw), now);
    } catch {
      // 손상된 슬롯 — 다음 슬롯(백업)으로 넘어간다.
    }
  }
  return createInitialState(now);
}

export function saveState(store: KeyValueStore, state: AppState): { ok: boolean; error?: string } {
  try {
    const serialized = JSON.stringify(state);
    const previous = store.getItem(STORAGE_KEY);
    store.setItem(STORAGE_KEY, serialized);
    // 새 값이 성공적으로 쓰인 뒤에만 백업을 갱신한다.
    if (previous) store.setItem(BACKUP_KEY, previous);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
