/**
 * Notion 연동 코어 (서버 전용).
 *
 * 이 모듈은 프레임워크에 의존하지 않는다 — Vercel 서버리스 함수, Vite 개발 서버
 * 미들웨어, 그리고 단위 테스트(모의 서버)가 모두 같은 코드를 사용한다.
 *
 * 안전 원칙
 *  1. Property 이름을 하드코딩하지 않는다. 실제 DB 스키마를 런타임에 읽고,
 *     "논리 필드 → 실제 Property" 매핑을 통해서만 값을 쓴다.
 *  2. 매핑되지 않았거나 타입이 맞지 않는 필드는 **조용히 건너뛴다** (추측해서 쓰지 않는다).
 *  3. 삭제/아카이브/이름변경을 하는 코드 경로가 존재하지 않는다.
 *     페이지 갱신은 PATCH(부분 병합)이므로 매핑된 Property 외에는 건드리지 않는다.
 *  4. 같은 날짜의 중복 행을 만들지 않기 위해 항상 먼저 조회한 뒤 갱신/생성한다.
 */

import {
  FIELD_SPECS,
  FIELD_SPEC_BY_KEY,
  formatHoursKo,
  type FieldKind,
  type FieldMapping,
  type LogicalField,
} from '../shared/fields.js';

export {
  FIELD_SPECS,
  FIELD_SPEC_BY_KEY,
  suggestMapping,
  type FieldKind,
  type FieldMapping,
  type LogicalField,
} from '../shared/fields.js';

import { computeDay, type DayLog } from '../shared/events.js';
import { buildRecord, type DayRecordPayload } from '../shared/record.js';
import { mergeDayLogs, parseDayLog, serializeDayLog } from '../shared/dayLog.js';
import { parseTodoText } from '../shared/todos.js';

export { type DayRecordPayload } from '../shared/record.js';

export const DEFAULT_NOTION_VERSION = '2022-06-28';
const NOTION_BASE = 'https://api.notion.com/v1';

// ---------------------------------------------------------------------------
// Notion HTTP 클라이언트
// ---------------------------------------------------------------------------

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface NotionClientOptions {
  token: string;
  notionVersion?: string;
  fetchImpl?: FetchLike;
  /** 재시도 사이 대기 (테스트에서 0 으로 주입) */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  baseUrl?: string;
}

export class NotionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    /** 클라이언트가 재시도해도 의미가 있는 오류인지 */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'NotionError';
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class NotionClient {
  private readonly token: string;
  private readonly version: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly baseUrl: string;

  constructor(opts: NotionClientOptions) {
    this.token = opts.token;
    this.version = opts.notionVersion || DEFAULT_NOTION_VERSION;
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxRetries = opts.maxRetries ?? 3;
    this.baseUrl = opts.baseUrl ?? NOTION_BASE;
  }

  async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    let lastError: NotionError | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Notion-Version': this.version,
            'Content-Type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (err) {
        // 네트워크 장애 — 재시도 가치 있음
        lastError = new NotionError(
          `Notion 서버에 연결하지 못했습니다: ${(err as Error).message}`,
          0,
          'network_error',
          true,
        );
        if (attempt < this.maxRetries) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }

      if (res.ok) {
        return (await res.json()) as T;
      }

      const detail = await safeJson(res);
      const code = String(detail?.code ?? `http_${res.status}`);
      const message = String(detail?.message ?? `Notion API 오류 (HTTP ${res.status})`);
      const retryable = res.status === 429 || res.status >= 500;

      lastError = new NotionError(message, res.status, code, retryable);
      if (!retryable || attempt >= this.maxRetries) throw lastError;

      const retryAfter = Number(res.headers.get('retry-after'));
      await this.sleep(
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt),
      );
    }

    throw lastError ?? new NotionError('알 수 없는 오류', 0, 'unknown', true);
  }
}

function backoffMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt);
}

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 스키마 조회 + 매핑 제안
// ---------------------------------------------------------------------------

export interface NotionPropertyInfo {
  id: string;
  name: string;
  type: string;
  /** select / status 의 선택지 이름들 */
  options?: string[];
}

export interface DatabaseSchema {
  databaseId: string;
  title: string;
  url?: string;
  properties: NotionPropertyInfo[];
}

export async function fetchDatabaseSchema(
  client: NotionClient,
  databaseId: string,
): Promise<DatabaseSchema> {
  const db = await client.request<any>('GET', `/databases/${normalizeId(databaseId)}`);
  const properties: NotionPropertyInfo[] = Object.entries(db.properties ?? {}).map(
    ([name, raw]: [string, any]) => {
      const type = String(raw?.type ?? 'unknown');
      const options: string[] | undefined =
        type === 'select' ? (raw.select?.options ?? []).map((o: any) => String(o.name))
          : type === 'status' ? (raw.status?.options ?? []).map((o: any) => String(o.name))
            : undefined;
      return { id: String(raw?.id ?? name), name, type, ...(options ? { options } : {}) };
    },
  );

  return {
    databaseId: String(db.id ?? databaseId),
    title: plainTextFromRich(db.title) || '(제목 없음)',
    url: db.url,
    properties,
  };
}

// UUID / 32자리 hex 를 "hex 문자로 둘러싸이지 않은" 위치에서만 찾는다.
const UUID_RE =
  /(?<![0-9a-fA-F])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9a-fA-F])/;
const HEX32_RE = /(?<![0-9a-fA-F])[0-9a-fA-F]{32}(?![0-9a-fA-F])/;

/**
 * 하이픈 유무/전체 URL 형태를 모두 받아 32자리 id 로 정규화한다.
 *
 * 주의: 단순히 "hex 문자만 남기고 뒤에서 32자"를 취하면 안 된다 —
 * Notion DB URL 의 `?v=<view-id>` 처럼 뒤쪽에 또 다른 hex 덩어리가 붙는 경우
 * 엉뚱한 id 가 만들어진다. 그래서 쿼리스트링을 먼저 떼고 경계까지 확인한다.
 */
export function normalizeId(raw: string): string {
  const input = String(raw ?? '').split(/[?#]/)[0] ?? '';

  const uuid = UUID_RE.exec(input);
  if (uuid) return uuid[0].replace(/-/g, '').toLowerCase();

  const hex = HEX32_RE.exec(input);
  if (hex) return hex[0].toLowerCase();

  throw new NotionError(`잘못된 Notion ID: "${raw}"`, 400, 'invalid_id', false);
}

function plainTextFromRich(rich: any): string {
  if (!Array.isArray(rich)) return '';
  return rich.map((r: any) => r?.plain_text ?? r?.text?.content ?? '').join('');
}

// ---------------------------------------------------------------------------
// 값 인코딩
// ---------------------------------------------------------------------------

/** 논리값 -> Notion property 값. 타입이 호환되지 않으면 null (건너뜀). */
export function encodeValue(
  kind: FieldKind,
  propType: string,
  record: DayRecordPayload,
  field: LogicalField,
): unknown | null {
  const text = textValueFor(field, record);
  const num = numberValueFor(field, record);

  switch (propType) {
    case 'title':
      // 연동 로그나 업무 리스트가 실수로 제목에 매핑되면 제목이 통째로 덮인다. 그건 막는다.
      if (kind === 'eventLog' || kind === 'todos') return null;
      return text === null ? null : { title: [{ type: 'text', text: { content: text } }] };

    case 'rich_text':
      if (text === null) return null;
      // 빈 문자열은 "지운다"는 뜻이다 (업무 리스트를 모두 삭제한 경우).
      return text === '' ? { rich_text: [] } : { rich_text: [{ type: 'text', text: { content: text } }] };

    case 'number':
      if (kind !== 'duration') return null;
      return { number: num };

    case 'date': {
      if (kind === 'dateOnly') return { date: { start: record.date } };
      if (kind === 'timestamp') {
        const iso = field === 'clockIn' ? record.clockInIso : record.clockOutIso;
        return { date: iso ? { start: iso } : null };
      }
      return null;
    }

    case 'select':
      if (kind === 'status') return { select: record.statusText ? { name: record.statusText } : null };
      // 직원 이름이 비어 있으면 **건드리지 않는다** (기존 값을 지우지 않기 위해 null 로 건너뛴다).
      if (kind === 'employee') return text === null ? null : { select: { name: text } };
      return null;

    case 'status':
      if (kind === 'status') return { status: record.statusText ? { name: record.statusText } : null };
      if (kind === 'employee') return text === null ? null : { status: { name: text } };
      return null;

    case 'multi_select':
      if (kind !== 'employee') return null;
      return text === null ? null : { multi_select: [{ name: text }] };

    default:
      return null;
  }
}

/** 앱이 만든 행을 알아보기 위한 제목. 이 문자열이 소유권 표식 역할을 한다. */
export function appRowTitle(record: DayRecordPayload): string {
  const who = record.employeeName?.trim();
  return who ? `${record.date} ${who} 근무기록` : `${record.date} 근무기록`;
}

function textValueFor(field: LogicalField, r: DayRecordPayload): string | null {
  switch (field) {
    case 'title': return appRowTitle(r);
    case 'date': return r.date;
    case 'employee': return r.employeeName?.trim() ? r.employeeName.trim() : null;
    case 'eventLog': return r.eventLogText ?? null;
    case 'todos': return r.todoText;
    case 'clockIn': return r.clockInText ?? '-';
    case 'clockOut': return r.clockOutText ?? '-';
    // 텍스트 Property 에는 "8시간 15분" 으로 넣는다. 숫자 Property 는 소수 그대로.
    case 'actualWork': return formatHoursKo(r.actualHours);
    case 'awayTime': return formatHoursKo(r.awayHours);
    case 'vacation': return formatHoursKo(r.vacationHours);
    case 'credited': return formatHoursKo(r.creditedHours);
    case 'status': return r.statusText;
  }
}

function numberValueFor(field: LogicalField, r: DayRecordPayload): number | null {
  switch (field) {
    case 'actualWork': return r.actualHours;
    case 'awayTime': return r.awayHours;
    case 'vacation': return r.vacationHours;
    case 'credited': return r.creditedHours;
    default: return null;
  }
}

/** 매핑 + 실제 스키마를 근거로 Notion properties 페이로드를 만든다. */
export function buildProperties(
  schema: DatabaseSchema,
  mapping: FieldMapping,
  record: DayRecordPayload,
): { properties: Record<string, unknown>; skipped: Array<{ field: LogicalField; reason: string }> } {
  const properties: Record<string, unknown> = {};
  const skipped: Array<{ field: LogicalField; reason: string }> = [];
  const byName = new Map(schema.properties.map((p) => [p.name, p]));

  for (const spec of FIELD_SPECS) {
    const propName = mapping[spec.key];
    if (!propName) {
      skipped.push({ field: spec.key, reason: '매핑되지 않음' });
      continue;
    }
    const prop = byName.get(propName);
    if (!prop) {
      skipped.push({ field: spec.key, reason: `DB에 '${propName}' Property가 없음` });
      continue;
    }
    const value = encodeValue(spec.kind, prop.type, record, spec.key);
    if (value === null) {
      skipped.push({ field: spec.key, reason: `'${propName}'(${prop.type}) 타입에 쓸 수 없음` });
      continue;
    }
    properties[propName] = value;
  }

  return { properties, skipped };
}

// ---------------------------------------------------------------------------
// 중복 방지 upsert
// ---------------------------------------------------------------------------

/** 날짜 Property 타입에 맞는 조회 필터를 만든다. */
export function buildDateFilter(prop: NotionPropertyInfo, dateKey: string): unknown {
  switch (prop.type) {
    case 'date': return { property: prop.name, date: { equals: dateKey } };
    case 'rich_text': return { property: prop.name, rich_text: { equals: dateKey } };
    case 'title': return { property: prop.name, title: { equals: dateKey } };
    default: return null;
  }
}

/** 직원 Property 타입에 맞는 조회 필터를 만든다. */
export function buildEmployeeFilter(prop: NotionPropertyInfo, name: string): unknown {
  switch (prop.type) {
    case 'select': return { property: prop.name, select: { equals: name } };
    case 'status': return { property: prop.name, status: { equals: name } };
    case 'multi_select': return { property: prop.name, multi_select: { contains: name } };
    case 'rich_text': return { property: prop.name, rich_text: { equals: name } };
    case 'title': return { property: prop.name, title: { equals: name } };
    default: return null;
  }
}

/**
 * 페이지의 title Property 를 평문으로 뽑는다 (소유권 판정용).
 * `type` 필드에 기대지 않는다 — 갱신 직후 응답처럼 값만 담겨 오는 경우가 있다.
 */
export function pageTitleText(page: any): string {
  for (const raw of Object.values(page?.properties ?? {})) {
    const p = raw as any;
    if (p?.type === 'title' || Array.isArray(p?.title)) return plainTextFromRich(p.title);
  }
  return '';
}

export interface UpsertResult {
  action: 'created' | 'updated';
  pageId: string;
  url?: string;
  skipped: Array<{ field: LogicalField; reason: string }>;
  /** 앱이 만든 행이 2개 이상이면 경고만 하고 가장 오래된 것을 갱신한다 (삭제하지 않음). */
  duplicateWarning?: string;
  /** 앱이 만들지 않은 행을 발견해 건드리지 않고 비켜 갔을 때의 안내 */
  foreignRowWarning?: string;
  /**
   * 다른 기기의 기록까지 합친 결과. 클라이언트는 이걸 자기 로컬 기록으로 받아들여
   * 데스크탑/노트북이 같은 하루를 보게 된다. 연동 로그를 매핑하지 않았으면 없다.
   */
  mergedLog?: DayLog;
}

/**
 * 업무 리스트에 대한 "내가 마지막으로 고쳤다"는 주장을 뗀 사본.
 *
 * 목록 본문(todos)과 그 시각(todosAt)은 짝이다. 한쪽만 남으면 병합이 잘못된 승자를
 * 고른다 — 내용은 모르면서 시각만 최신인 기록이 이기기 때문이다.
 */
function withoutTodoClaim(log: DayLog): DayLog {
  const { todos: _todos, todosAt: _todosAt, ...rest } = log;
  return rest;
}

export async function upsertDayRecord(args: {
  client: NotionClient;
  databaseId: string;
  schema: DatabaseSchema;
  mapping: FieldMapping;
  record: DayRecordPayload;
  /** 이 기기의 원본 이벤트 목록. 주면 서버가 기존 행의 로그와 합쳐서 다시 계산한다. */
  dayLog?: DayLog | null;
  /** 앱이 기억하고 있는 페이지 id (빠른 경로). 없으면 조회로 찾는다. */
  knownPageId?: string | null;
  /** 진행 중인 근무시간 계산 기준 시각 (테스트 주입용) */
  now?: number;
}): Promise<UpsertResult> {
  const { client, schema, mapping } = args;
  const databaseId = normalizeId(args.databaseId);
  const now = args.now ?? Date.now();

  let record = args.record;

  const logProp = mapping.eventLog
    ? schema.properties.find((p) => p.name === mapping.eventLog)
    : undefined;
  const todosProp = mapping.todos
    ? schema.properties.find((p) => p.name === mapping.todos)
    : undefined;

  /**
   * 업무 리스트 칸을 못 쓰는 요청은 목록의 주인 행세를 하면 안 된다.
   *
   * Notion 임베드 위젯은 iframe 이라 브라우저가 저장소를 따로 쪼개 준다. 그래서 전체
   * 화면에서 `업무 리스트` Property 를 만들어도 위젯은 그 사실을 모른 채 예전 매핑으로
   * 계속 쓴다. 그런데도 이벤트 로그에는 "내가 방금 목록을 고쳤다"는 시각(T:)이 함께
   * 실려 나갔다. 그러면 다른 기기가 그 시각만 보고 자기 최신 목록을 버린 뒤, 정작 칸에
   * 남아 있던 낡은 목록을 되살린다 — 위젯에서 적은 항목은 영영 안 보이고 전체 화면에서
   * 한 완료 표시는 되돌아간다. 쓸 수 없으면 의견도 내지 않는 것이 맞다.
   */
  const incoming: DayLog | null = !args.dayLog
    ? null
    : todosProp
      ? args.dayLog
      : withoutTodoClaim(args.dayLog);

  let mergedLog: DayLog | null = incoming;

  /**
   * 기존 행에 실려 있던 다른 기기의 이벤트를 읽어 합친 뒤 근무시간을 다시 계산한다.
   *
   * 이걸 서버에서 하는 이유: 클라이언트가 "읽고 → 합치고 → 쓰는" 동안 다른 기기가
   * 끼어들면 그 사이 기록이 사라진다. 조회와 쓰기가 한 요청 안에서 끝나야 안전하다.
   */
  function absorb(page: any): void {
    if (!logProp || !incoming) return;
    const raw = page?.properties?.[logProp.name];
    const remote = parseDayLog(incoming.date, raw ? plainTextFromRich(raw.rich_text) : '');
    if (!remote) return;
    // 업무 리스트는 이벤트가 아니라 사람이 쓴 값이라 행에서 그대로 읽어 온다.
    // 이게 없으면 늦게 동기화한 기기가 다른 기기에서 적은 목록을 지워 버린다.
    if (todosProp) {
      const rawTodos = page?.properties?.[todosProp.name];
      remote.todos = parseTodoText(rawTodos ? plainTextFromRich(rawTodos.rich_text) : '');
    }
    mergedLog = mergeDayLogs(incoming, remote);
  }

  function currentProperties() {
    if (logProp && mergedLog) {
      record = buildRecord(
        computeDay(mergedLog, now),
        args.record.employeeName ?? null,
        serializeDayLog(mergedLog),
        mergedLog.todos ?? null,
      );
    }
    return buildProperties(schema, mapping, record);
  }

  let { properties, skipped } = currentProperties();
  if (Object.keys(properties).length === 0) {
    throw new NotionError(
      '쓸 수 있는 Property가 하나도 매핑되지 않았습니다. 설정에서 매핑을 확인하세요.',
      400,
      'no_mapped_properties',
      false,
    );
  }

  // 1) 앱이 기억하는 pageId 로 바로 갱신 시도
  if (args.knownPageId) {
    try {
      const pageId = normalizeId(args.knownPageId);
      // 연동 로그를 쓰는 경우에는 먼저 읽어야 다른 기기의 이벤트를 잃지 않는다.
      if (logProp && incoming) {
        absorb(await client.request<any>('GET', `/pages/${pageId}`));
        ({ properties, skipped } = currentProperties());
      }
      const page = await client.request<any>('PATCH', `/pages/${pageId}`, { properties });
      return {
        action: 'updated',
        pageId: String(page.id),
        url: page.url,
        skipped,
        ...(mergedLog ? { mergedLog } : {}),
      };
    } catch (err) {
      // 페이지가 지워졌거나 접근 불가하면 조회 경로로 폴백한다.
      const status = err instanceof NotionError ? err.status : 0;
      if (status !== 404 && status !== 400) throw err;
    }
  }

  // 2) "날짜(+직원)" 로 조회해서 앱이 이전에 만든 행을 찾는다.
  //
  //    여러 명이 같은 DB 를 쓰므로 날짜만으로는 행이 갈리지 않는다. 직원 Property 가
  //    매핑돼 있으면 반드시 함께 걸러야 서로의 기록을 덮어쓰지 않는다.
  const dateProp = mapping.date
    ? schema.properties.find((p) => p.name === mapping.date)
    : undefined;
  const employeeName = record.employeeName?.trim() || null;
  const employeeProp =
    mapping.employee && employeeName
      ? schema.properties.find((p) => p.name === mapping.employee)
      : undefined;

  const filters: unknown[] = [];
  if (dateProp) {
    const f = buildDateFilter(dateProp, record.date);
    if (f) filters.push(f);
  }
  if (employeeProp && employeeName) {
    const f = buildEmployeeFilter(employeeProp, employeeName);
    if (f) filters.push(f);
  }

  let existing: any[] = [];
  if (filters.length > 0) {
    const query = await client.request<any>('POST', `/databases/${databaseId}/query`, {
      filter: filters.length === 1 ? filters[0] : { and: filters },
      page_size: 25,
    });
    existing = (query.results ?? []).filter((p: any) => p && p.archived !== true);
  }

  // 3) 앱이 만든 행만 갱신 대상으로 삼는다.
  //
  //    예전에는 날짜만 맞으면 가장 오래된 행을 갱신했는데, 사용자가 손으로 적어 둔
  //    행("반차", "근무" 같은)이 그 조건에 걸리면 제목·구분이 통째로 덮어써졌다.
  //    실제로 그런 사고가 있었다. 소유권 표식(제목)이 일치하는 행만 건드린다.
  const ownedTitle = appRowTitle(record);
  const owned = existing.filter((p) => pageTitleText(p) === ownedTitle);
  const foreignCount = existing.length - owned.length;
  const foreignRowWarning =
    foreignCount > 0
      ? `${record.date}${employeeName ? ` · ${employeeName}` : ''} 에 앱이 만들지 않은 행이 ` +
        `${foreignCount}개 있습니다. 그 행들은 건드리지 않았습니다.`
      : null;

  if (owned.length > 0) {
    // 가장 먼저 만들어진 행을 정본으로 삼는다. 나머지는 건드리지 않는다.
    const target = owned.reduce((oldest: any, cur: any) =>
      String(cur.created_time ?? '') < String(oldest.created_time ?? '') ? cur : oldest,
    );
    // 조회 결과에 이미 Property 값이 들어 있으므로 추가 요청 없이 합칠 수 있다.
    absorb(target);
    ({ properties, skipped } = currentProperties());

    const page = await client.request<any>('PATCH', `/pages/${normalizeId(target.id)}`, {
      properties,
    });
    return {
      action: 'updated',
      pageId: String(page.id),
      url: page.url,
      skipped,
      ...(mergedLog ? { mergedLog } : {}),
      ...(owned.length > 1
        ? {
            duplicateWarning:
              `앱이 만든 ${record.date} 행이 ${owned.length}개 있습니다. ` +
              `가장 오래된 행만 갱신했습니다. 나머지는 그대로 두었으니 Notion에서 직접 정리하세요.`,
          }
        : {}),
      ...(foreignRowWarning ? { foreignRowWarning } : {}),
    };
  }

  // 4) 없으면 새로 만든다
  const page = await client.request<any>('POST', '/pages', {
    parent: { database_id: databaseId },
    properties,
  });
  return {
    action: 'created',
    pageId: String(page.id),
    url: page.url,
    skipped,
    ...(mergedLog ? { mergedLog } : {}),
    ...(foreignRowWarning ? { foreignRowWarning } : {}),
  };
}

/**
 * 한 직원의 특정 날짜 행에서 연동 로그만 읽어 온다 (쓰기 없음).
 *
 * 앱을 열자마자 "다른 기기에서 이미 출근했는지"를 알아야 하기 때문에 필요하다.
 * 이게 없으면 노트북을 열었을 때 화면은 "출근 전"인데 Notion 에는 근무 중인
 * 모순된 상태가 보인다.
 */
export async function fetchDayLog(args: {
  client: NotionClient;
  databaseId: string;
  schema: DatabaseSchema;
  mapping: FieldMapping;
  dateKey: string;
  employeeName: string | null;
}): Promise<{ found: boolean; pageId: string | null; dayLog: DayLog | null }> {
  const { client, schema, mapping, dateKey } = args;
  const databaseId = normalizeId(args.databaseId);
  const employeeName = args.employeeName?.trim() || null;

  const dateProp = mapping.date ? schema.properties.find((p) => p.name === mapping.date) : undefined;
  const employeeProp =
    mapping.employee && employeeName
      ? schema.properties.find((p) => p.name === mapping.employee)
      : undefined;

  const filters: unknown[] = [];
  if (dateProp) {
    const f = buildDateFilter(dateProp, dateKey);
    if (f) filters.push(f);
  }
  if (employeeProp && employeeName) {
    const f = buildEmployeeFilter(employeeProp, employeeName);
    if (f) filters.push(f);
  }
  if (filters.length === 0) return { found: false, pageId: null, dayLog: null };

  const query = await client.request<any>('POST', `/databases/${databaseId}/query`, {
    filter: filters.length === 1 ? filters[0] : { and: filters },
    page_size: 25,
  });
  const rows = (query.results ?? []).filter((p: any) => p && p.archived !== true);

  const ownedTitle = `${dateKey}${employeeName ? ` ${employeeName}` : ''} 근무기록`;
  const owned = rows.filter((p: any) => pageTitleText(p) === ownedTitle);
  if (owned.length === 0) return { found: false, pageId: null, dayLog: null };

  const target = owned.reduce((oldest: any, cur: any) =>
    String(cur.created_time ?? '') < String(oldest.created_time ?? '') ? cur : oldest,
  );

  return { found: true, pageId: String(target.id), dayLog: decodeRowLog(dateKey, target, schema, mapping) };
}

/** 행 하나를 DayLog 로 푼다. 하루 조회와 기간 조회가 같은 규칙을 쓰도록 한곳에 둔다. */
function decodeRowLog(
  dateKey: string,
  page: any,
  schema: DatabaseSchema,
  mapping: FieldMapping,
): DayLog | null {
  const logProp = mapping.eventLog
    ? schema.properties.find((p) => p.name === mapping.eventLog)
    : undefined;
  const raw = logProp ? page.properties?.[logProp.name] : undefined;
  const dayLog = parseDayLog(dateKey, raw ? plainTextFromRich(raw.rich_text) : '');

  const todosProp = mapping.todos
    ? schema.properties.find((p) => p.name === mapping.todos)
    : undefined;
  if (dayLog && todosProp) {
    const rawTodos = page.properties?.[todosProp.name];
    dayLog.todos = parseTodoText(rawTodos ? plainTextFromRich(rawTodos.rich_text) : '');
  } else if (dayLog?.todosAt) {
    // 목록 칸을 읽을 수 없으면 "누가 마지막으로 고쳤는가"도 알 수 없다. 그 시각만
    // 받아 두면 이 기기는 내용을 모른 채 최신 편집자 행세를 하게 되고, 다음 저장에서
    // 남의 목록을 자기 낡은 목록으로 덮어쓴다.
    delete dayLog.todosAt;
  }

  return dayLog;
}

/** 앱이 만든 행의 제목에서 날짜와 이름을 되뽑는다. 형식이 다르면 남의 행이다. */
export function parseAppRowTitle(title: string): { dateKey: string; employeeName: string | null } | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:\s+(.+?))?\s+근무기록$/.exec(title.trim());
  if (!m) return null;
  return { dateKey: m[1]!, employeeName: m[2]?.trim() || null };
}

/** 기간 조회에서 한 번에 훑을 최대 행 수. 100 * 10 = 1000 행이면 몇 달치를 덮는다. */
const RANGE_MAX_PAGES = 10;

/**
 * 기간 안의 기록을 한꺼번에 읽어 온다 (쓰기 없음).
 *
 * 기록의 원본은 Notion 이고 브라우저 저장소는 사본일 뿐이다. 그런데 하루씩 읽는
 * 경로밖에 없어서, 저장소가 빈 브라우저(=처음 여는 기기, 노션 위젯과 저장소가
 * 갈린 전체 화면)에서는 지난 기록이 영영 보이지 않았다. 이 함수가 그 구멍을 메운다.
 */
export async function fetchDayLogs(args: {
  client: NotionClient;
  databaseId: string;
  schema: DatabaseSchema;
  mapping: FieldMapping;
  from: string;
  to: string;
  employeeName: string | null;
}): Promise<{ days: Array<{ dateKey: string; pageId: string; dayLog: DayLog | null }> }> {
  const { client, schema, mapping, from, to } = args;
  const databaseId = normalizeId(args.databaseId);
  const employeeName = args.employeeName?.trim() || null;

  const dateProp = mapping.date ? schema.properties.find((p) => p.name === mapping.date) : undefined;
  const employeeProp =
    mapping.employee && employeeName
      ? schema.properties.find((p) => p.name === mapping.employee)
      : undefined;

  const filters: unknown[] = [];
  // 날짜 Property 가 진짜 date 일 때만 범위를 서버에서 좁힌다. 텍스트로 적힌
  // 날짜는 범위 비교가 안 되므로 그때는 전부 받아 제목으로 걸러낸다.
  if (dateProp?.type === 'date') {
    filters.push({ property: dateProp.name, date: { on_or_after: from } });
    filters.push({ property: dateProp.name, date: { on_or_before: to } });
  }
  if (employeeProp && employeeName) {
    const f = buildEmployeeFilter(employeeProp, employeeName);
    if (f) filters.push(f);
  }

  const best = new Map<string, any>();
  let cursor: string | undefined;
  for (let page = 0; page < RANGE_MAX_PAGES; page++) {
    const query = await client.request<any>('POST', `/databases/${databaseId}/query`, {
      ...(filters.length > 0 ? { filter: filters.length === 1 ? filters[0] : { and: filters } } : {}),
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });

    for (const row of query.results ?? []) {
      if (!row || row.archived === true) continue;
      const parsed = parseAppRowTitle(pageTitleText(row));
      if (!parsed) continue; // 앱이 만들지 않은 행 — 건드리지도 읽지도 않는다
      if (parsed.dateKey < from || parsed.dateKey > to) continue;
      // 이름이 지정됐으면 그 사람 행만. 제목이 소유권 표식이므로 여기서도 제목을 믿는다.
      if (employeeName && parsed.employeeName !== employeeName) continue;

      // 같은 날 행이 여럿이면 upsert 와 같은 규칙으로 가장 오래된 것을 고른다.
      const prev = best.get(parsed.dateKey);
      if (!prev || String(row.created_time ?? '') < String(prev.created_time ?? '')) {
        best.set(parsed.dateKey, row);
      }
    }

    if (!query.has_more || !query.next_cursor) break;
    cursor = String(query.next_cursor);
  }

  const days = [...best.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([dateKey, row]) => ({
      dateKey,
      pageId: String(row.id),
      dayLog: decodeRowLog(dateKey, row, schema, mapping),
    }));

  return { days };
}

// ---------------------------------------------------------------------------
// Property 추가 (명시적 opt-in 일 때만)
// ---------------------------------------------------------------------------

/**
 * 매핑되지 않은 논리 필드용 Property 를 DB 에 **추가만** 한다.
 * 기존 Property 는 절대 수정/삭제하지 않는다.
 */
export async function addMissingProperties(args: {
  client: NotionClient;
  databaseId: string;
  schema: DatabaseSchema;
  fields: LogicalField[];
}): Promise<{ added: Array<{ field: LogicalField; name: string; type: string }> }> {
  const existingNames = new Set(args.schema.properties.map((p) => p.name));
  const patch: Record<string, unknown> = {};
  const added: Array<{ field: LogicalField; name: string; type: string }> = [];

  for (const field of args.fields) {
    const spec = FIELD_SPEC_BY_KEY[field];
    if (!spec || spec.key === 'title') continue; // title 은 항상 존재하므로 추가하지 않는다

    // 이름 충돌을 피한다 — 기존 Property 는 절대 건드리지 않고, 이름이 겹치면
    // 접미사를 붙여 새로 만든다. (예전에는 그냥 건너뛰어서, 사용자는 "추가했다"는
    // 메시지를 받았는데 실제로는 아무것도 안 생기는 일이 있었다.)
    const base = spec.createName ?? spec.labelKo;
    let name = base;
    for (let i = 2; existingNames.has(name) && i < 20; i++) name = `${base} (${i})`;
    if (existingNames.has(name)) continue;
    existingNames.add(name);

    patch[name] =
      spec.createAs === 'number' ? { number: { format: 'number' } }
        : spec.createAs === 'date' ? { date: {} }
          : spec.createAs === 'select' ? { select: {} }
            : { rich_text: {} };
    added.push({ field, name, type: spec.createAs });
  }

  if (added.length === 0) return { added: [] };

  await args.client.request('PATCH', `/databases/${normalizeId(args.databaseId)}`, {
    properties: patch,
  });
  return { added };
}

// ---------------------------------------------------------------------------
// 특별 휴가 부여
//
// 부여는 근무 기록과 성격이 다른 행이다. `구분 = 특별부여` 로만 구별하며,
// fetchDayLog 는 제목이 `… 근무기록` 인 행만 보므로 서로 간섭하지 않는다.
//
// 부여 전용 두 칸(부여시간·사유)은 이 기능이 직접 만들고 직접 읽는다. 나머지
// (제목·날짜·직원·구분)는 사용자가 이미 확정한 매핑을 그대로 쓴다.

import {
  GRANT_KIND,
  GRANT_KIND_PROP,
  GRANT_HOURS_PROP,
  GRANT_REASON_PROP,
  grantTitle,
  type VacationGrant,
} from '../shared/grants.js';

export { GRANT_KIND, type VacationGrant } from '../shared/grants.js';

const HOUR_IN_MS = 3600000;

/** 부여 전용 칸이 없으면 만든다. 있으면 아무것도 하지 않는다. */
export async function ensureGrantProperties(args: {
  client: NotionClient;
  databaseId: string;
  schema: DatabaseSchema;
}): Promise<{ added: string[] }> {
  const existing = new Set(args.schema.properties.map((p) => p.name));
  const patch: Record<string, unknown> = {};
  const added: string[] = [];

  if (!existing.has(GRANT_HOURS_PROP)) {
    patch[GRANT_HOURS_PROP] = { number: { format: 'number' } };
    added.push(GRANT_HOURS_PROP);
  }
  if (!existing.has(GRANT_REASON_PROP)) {
    patch[GRANT_REASON_PROP] = { rich_text: {} };
    added.push(GRANT_REASON_PROP);
  }
  if (added.length === 0) return { added: [] };

  await args.client.request('PATCH', `/databases/${normalizeId(args.databaseId)}`, {
    properties: patch,
  });
  return { added };
}

/**
 * 그 직원에게 부여된 특별 휴가를 전부 읽는다.
 *
 * 부여 행을 알아보는 기준은 **`부여시간` 칸에 값이 있는가** 하나다. 사용자 매핑에
 * 기대지 않는 이유가 있다: 실제 DB 에는 `근무상태`(앱이 쓰는 칸)와 `구분`(사람이 쓰는 칸)이
 * 둘 다 있어서 자동 매핑이 `상태`를 `근무상태` 에 붙인다. 그 상태로 구분 값을 찾으면
 * 부여 행을 영영 못 찾는다. `부여시간` 은 이 기능만 쓰는 칸이라 오인할 여지가 없다.
 */
export async function fetchGrants(args: {
  client: NotionClient;
  databaseId: string;
  schema: DatabaseSchema;
  mapping: FieldMapping;
  employeeName: string | null;
}): Promise<{ grants: VacationGrant[] }> {
  const { client, schema, mapping } = args;
  const databaseId = normalizeId(args.databaseId);
  const employeeName = args.employeeName?.trim() || null;

  const dateProp = mapping.date ? schema.properties.find((p) => p.name === mapping.date) : undefined;
  const employeeProp =
    mapping.employee && employeeName
      ? schema.properties.find((p) => p.name === mapping.employee)
      : undefined;

  // 부여 칸이 아직 없으면 부여된 적도 없다는 뜻이다.
  if (!schema.properties.some((p) => p.name === GRANT_HOURS_PROP)) return { grants: [] };

  const filters: unknown[] = [
    { property: GRANT_HOURS_PROP, number: { is_not_empty: true } },
  ];

  if (employeeProp && employeeName) {
    const f = buildEmployeeFilter(employeeProp, employeeName);
    if (f) filters.push(f);
  }

  const grants: VacationGrant[] = [];
  let cursor: string | undefined;
  do {
    const res = await client.request<any>('POST', `/databases/${databaseId}/query`, {
      filter: filters.length === 1 ? filters[0] : { and: filters },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });

    for (const page of res.results ?? []) {
      if (!page || page.archived === true) continue;
      const hours = page.properties?.[GRANT_HOURS_PROP]?.number;
      if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) continue;

      const dateRaw = dateProp ? page.properties?.[dateProp.name]?.date?.start : null;
      const reasonRaw = page.properties?.[GRANT_REASON_PROP];

      grants.push({
        id: String(page.id),
        // 날짜 칸이 비어 있으면 만든 날을 기준으로 삼는다 — 부여가 통째로
        // 사라지는 것보다 낫다.
        dateKey: String(dateRaw ?? page.created_time ?? '').slice(0, 10),
        ms: Math.round(hours * HOUR_IN_MS),
        reason: reasonRaw ? plainTextFromRich(reasonRaw.rich_text) : '',
      });
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  grants.sort((a, b) => (a.dateKey < b.dateKey ? 1 : -1));
  return { grants };
}

/** 부여 행을 새로 만든다. 기존 행은 절대 건드리지 않는다. */
export async function createGrant(args: {
  client: NotionClient;
  databaseId: string;
  schema: DatabaseSchema;
  mapping: FieldMapping;
  employeeName: string | null;
  dateKey: string;
  hours: number;
  reason: string;
}): Promise<{ grant: VacationGrant }> {
  const { client, schema, mapping, dateKey, hours, reason } = args;
  const databaseId = normalizeId(args.databaseId);
  const employeeName = args.employeeName?.trim() || null;

  await ensureGrantProperties({ client, databaseId, schema });

  const properties: Record<string, unknown> = {
    [GRANT_HOURS_PROP]: { number: hours },
    [GRANT_REASON_PROP]: { rich_text: [{ text: { content: reason.slice(0, 1900) } }] },
  };

  const titleProp = schema.properties.find((p) => p.type === 'title');
  if (titleProp) {
    properties[titleProp.name] = { title: [{ text: { content: grantTitle(hours) } }] };
  }

  // 구분 값은 노션 표에서 사람이 알아보라고 적는 보조 표시다. 읽을 때는 쓰지 않으므로
  // 칸이 없으면 그냥 넘어간다. 앱이 쓰는 `근무상태` 를 오염시키지 않도록 이름이 정확히
  // `구분` 인 select 에만 적는다.
  const kindProp = schema.properties.find((p) => p.name === GRANT_KIND_PROP);
  if (kindProp?.type === 'select') properties[kindProp.name] = { select: { name: GRANT_KIND } };

  const dateProp = mapping.date ? schema.properties.find((p) => p.name === mapping.date) : undefined;
  if (dateProp?.type === 'date') properties[dateProp.name] = { date: { start: dateKey } };

  const employeeProp =
    mapping.employee && employeeName
      ? schema.properties.find((p) => p.name === mapping.employee)
      : undefined;
  if (employeeProp?.type === 'select' && employeeName) {
    properties[employeeProp.name] = { select: { name: employeeName } };
  } else if (employeeProp?.type === 'rich_text' && employeeName) {
    properties[employeeProp.name] = { rich_text: [{ text: { content: employeeName } }] };
  }

  const page = await client.request<any>('POST', '/pages', {
    parent: { database_id: databaseId },
    properties,
  });

  return {
    grant: {
      id: String(page.id),
      dateKey,
      ms: Math.round(hours * HOUR_IN_MS),
      reason,
    },
  };
}

/** 부여를 되돌린다 (노션 휴지통으로 보낸다 — 복구 가능). */
export async function revokeGrant(args: {
  client: NotionClient;
  pageId: string;
}): Promise<void> {
  await args.client.request('PATCH', `/pages/${args.pageId}`, { archived: true });
}
