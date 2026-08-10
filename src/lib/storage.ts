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

/** 이 저장소 인스턴스가 쓰는 키 한 쌍 */
export interface StateKeys {
  main: string;
  backup: string;
}

export const SHARED_KEYS: StateKeys = { main: STORAGE_KEY, backup: BACKUP_KEY };

/**
 * 직원별 저장 칸의 키.
 *
 * 브라우저는 iframe 의 저장소를 "상위 사이트 + iframe 출처"로 나눈다. 그래서 같은
 * Notion 페이지에 위젯을 두 개 띄우면 **둘이 같은 칸을 쓴다** — 사람마다 블록을
 * 나눠도 이름과 기록이 서로 덮어써진다. 실제로 그렇게 됐다.
 *
 * URL 이 사람을 지정하면 그 사람 전용 칸으로 가른다. 이러면 한 페이지에 위젯을
 * 몇 개를 띄우든 서로 침범하지 않는다.
 */
export function keysFor(namespace: string | null): StateKeys {
  const name = namespace?.trim();
  if (!name) return SHARED_KEYS;
  return { main: `${STORAGE_KEY}::${name}`, backup: `${BACKUP_KEY}::${name}` };
}

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
  /** 근무 상태가 바뀔 때마다 자동 동기화할지 여부 */
  autoSync: boolean;
  /** 백엔드 주소. 빈 문자열이면 같은 오리진의 /api 를 사용 */
  apiBase: string;
  /** 서버가 APP_ACCESS_KEY 를 요구할 때 보낼 값 */
  accessKey: string;
  /**
   * 이 기기를 쓰는 직원 이름 (Notion `직원` Property 값).
   *
   * 기록은 브라우저마다 따로 쌓이므로 "한 기기 = 한 사람"이 전제다.
   * 이 값이 날짜와 함께 Notion 행을 가르는 기준이 된다.
   */
  employeeName: string;
  mapping: Partial<Record<LogicalFieldKey, string>>;
  schema: DatabaseSchemaLite | null;
  /** dateKey -> Notion page id (중복 생성 방지 빠른 경로) */
  pageIds: Record<string, string>;
}

/** 마지막으로 성공한 동기화의 결과. "정말 갔는지" 확인할 수 있게 남긴다. */
export interface LastSyncInfo {
  at: number;
  dateKey: string;
  employeeName: string | null;
  action: 'created' | 'updated';
  pageUrl: string | null;
  /** 기존 수동 행을 건드리지 않고 비켜 갔을 때의 안내 */
  warning: string | null;
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
  lastSync: LastSyncInfo | null;
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
      employeeName: '',
      mapping: {},
      schema: null,
      pageIds: {},
    },
    outbox: {},
    lastSyncAt: null,
    lastSync: null,
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
              ['clock_in', 'away_start', 'away_end', 'clock_out', 'resume'].includes(
                (e as any).type,
              ),
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
    employeeName: typeof n.employeeName === 'string' ? n.employeeName : '',
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

  const ls = obj.lastSync;
  const lastSync: LastSyncInfo | null =
    ls && typeof ls === 'object' && typeof ls.at === 'number' && typeof ls.dateKey === 'string'
      ? {
          at: ls.at,
          dateKey: ls.dateKey,
          employeeName: typeof ls.employeeName === 'string' ? ls.employeeName : null,
          action: ls.action === 'created' ? 'created' : 'updated',
          pageUrl: typeof ls.pageUrl === 'string' ? ls.pageUrl : null,
          warning: typeof ls.warning === 'string' ? ls.warning : null,
        }
      : null;

  return {
    version: 1,
    logs,
    vacation,
    notion,
    outbox,
    lastSyncAt: typeof obj.lastSyncAt === 'number' ? obj.lastSyncAt : null,
    lastSync,
  };
}

export function loadState(
  store: KeyValueStore,
  now: number,
  keys: StateKeys = SHARED_KEYS,
): AppState {
  for (const key of [keys.main, keys.backup]) {
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

export function saveState(
  store: KeyValueStore,
  state: AppState,
  keys: StateKeys = SHARED_KEYS,
): { ok: boolean; error?: string } {
  try {
    const serialized = JSON.stringify(state);
    const previous = store.getItem(keys.main);
    store.setItem(keys.main, serialized);
    // 새 값이 성공적으로 쓰인 뒤에만 백업을 갱신한다.
    if (previous) store.setItem(keys.backup, previous);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * 직원 칸을 처음 만들 때 공용 칸에서 물려받을 것만 추린다.
 *
 * 접근 키·매핑·스키마·휴가 정책은 "이 브라우저가 어느 Notion DB 를 보는가"에 대한
 * 것이라 사람이 달라도 같다. 반면 이름·기록·대기열·pageId 는 사람의 것이므로 비운다.
 * 이게 없으면 위젯을 하나 걸 때마다 접근 키부터 다시 넣어야 한다.
 */
export function seedFromShared(base: AppState, now: number): AppState {
  const fresh = createInitialState(now);
  return {
    ...fresh,
    vacation: base.vacation,
    notion: {
      ...fresh.notion,
      autoSync: base.notion.autoSync,
      apiBase: base.notion.apiBase,
      accessKey: base.notion.accessKey,
      mapping: { ...base.notion.mapping },
      schema: base.notion.schema,
    },
  };
}
