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
  type FieldKind,
  type FieldMapping,
  type LogicalField,
} from '../shared/fields.js';

export {
  FIELD_SPECS,
  FIELD_SPEC_BY_KEY,
  type FieldKind,
  type FieldMapping,
  type LogicalField,
} from '../shared/fields.js';

export const DEFAULT_NOTION_VERSION = '2022-06-28';
const NOTION_BASE = 'https://api.notion.com/v1';

// ---------------------------------------------------------------------------
// 앱이 서버로 보내는 하루치 기록
// ---------------------------------------------------------------------------

export interface DayRecordPayload {
  /** KST "YYYY-MM-DD" */
  date: string;
  /** ISO8601 (+09:00). 미출근이면 null */
  clockInIso: string | null;
  clockOutIso: string | null;
  /** 표시용 "HH:mm" */
  clockInText: string | null;
  clockOutText: string | null;
  actualHours: number;
  awayHours: number;
  vacationHours: number;
  creditedHours: number;
  /** 예: "퇴근 완료" */
  statusText: string;
}

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

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[\s_\-()[\]/·.]/g, '');
}

/**
 * 실제 스키마를 보고 매핑을 **제안**한다. 확정은 사용자가 UI 에서 한다.
 * 이름이 정확히/부분적으로 일치하고 타입까지 호환될 때만 제안한다.
 */
export function suggestMapping(properties: NotionPropertyInfo[]): {
  mapping: FieldMapping;
  unmatched: LogicalField[];
} {
  const mapping: FieldMapping = {};
  const unmatched: LogicalField[] = [];
  const taken = new Set<string>();

  // title 타입은 DB 당 하나뿐이므로 먼저 확정한다.
  const titleProp = properties.find((p) => p.type === 'title');
  if (titleProp) {
    mapping.title = titleProp.name;
    taken.add(titleProp.name);
  }

  for (const spec of FIELD_SPECS) {
    if (spec.key === 'title') continue;

    const compatible = properties.filter(
      (p) => spec.acceptedTypes.includes(p.type) && !taken.has(p.name),
    );
    if (compatible.length === 0) {
      unmatched.push(spec.key);
      continue;
    }

    const exact = compatible.find((p) => spec.candidates.includes(normalizeName(p.name)));
    const partial = compatible.find((p) => {
      const n = normalizeName(p.name);
      return spec.candidates.some((c) => n.includes(c) || c.includes(n));
    });

    const chosen = exact ?? partial;
    if (chosen) {
      mapping[spec.key] = chosen.name;
      taken.add(chosen.name);
    } else {
      unmatched.push(spec.key);
    }
  }

  return { mapping, unmatched };
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
      return text === null ? null : { title: [{ type: 'text', text: { content: text } }] };

    case 'rich_text':
      return text === null ? null : { rich_text: [{ type: 'text', text: { content: text } }] };

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
      if (kind !== 'status') return null;
      return { select: record.statusText ? { name: record.statusText } : null };

    case 'status':
      if (kind !== 'status') return null;
      return { status: record.statusText ? { name: record.statusText } : null };

    default:
      return null;
  }
}

function textValueFor(field: LogicalField, r: DayRecordPayload): string | null {
  switch (field) {
    case 'title': return `${r.date} 근무기록`;
    case 'date': return r.date;
    case 'clockIn': return r.clockInText ?? '-';
    case 'clockOut': return r.clockOutText ?? '-';
    case 'actualWork': return `${r.actualHours}h`;
    case 'awayTime': return `${r.awayHours}h`;
    case 'vacation': return `${r.vacationHours}h`;
    case 'credited': return `${r.creditedHours}h`;
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

export interface UpsertResult {
  action: 'created' | 'updated';
  pageId: string;
  url?: string;
  skipped: Array<{ field: LogicalField; reason: string }>;
  /** 같은 날짜의 행이 2개 이상 발견되면 경고만 하고 가장 오래된 것을 갱신한다 (삭제하지 않음). */
  duplicateWarning?: string;
}

export async function upsertDayRecord(args: {
  client: NotionClient;
  databaseId: string;
  schema: DatabaseSchema;
  mapping: FieldMapping;
  record: DayRecordPayload;
  /** 앱이 기억하고 있는 페이지 id (빠른 경로). 없으면 조회로 찾는다. */
  knownPageId?: string | null;
}): Promise<UpsertResult> {
  const { client, schema, mapping, record } = args;
  const databaseId = normalizeId(args.databaseId);

  const { properties, skipped } = buildProperties(schema, mapping, record);
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
      const page = await client.request<any>('PATCH', `/pages/${normalizeId(args.knownPageId)}`, {
        properties,
      });
      return { action: 'updated', pageId: String(page.id), url: page.url, skipped };
    } catch (err) {
      // 페이지가 지워졌거나 접근 불가하면 조회 경로로 폴백한다.
      const status = err instanceof NotionError ? err.status : 0;
      if (status !== 404 && status !== 400) throw err;
    }
  }

  // 2) 날짜로 조회해서 기존 행을 찾는다 (중복 생성 방지의 핵심)
  const dateMapping = mapping.date;
  const dateProp = dateMapping
    ? schema.properties.find((p) => p.name === dateMapping)
    : undefined;

  let existing: any[] = [];
  if (dateProp) {
    const filter = buildDateFilter(dateProp, record.date);
    if (filter) {
      const query = await client.request<any>('POST', `/databases/${databaseId}/query`, {
        filter,
        page_size: 10,
      });
      existing = (query.results ?? []).filter((p: any) => p && p.archived !== true);
    }
  }

  if (existing.length > 0) {
    // 가장 먼저 만들어진 행을 정본으로 삼는다. 나머지는 건드리지 않는다.
    const target = existing.reduce((oldest: any, cur: any) =>
      String(cur.created_time ?? '') < String(oldest.created_time ?? '') ? cur : oldest,
    );
    const page = await client.request<any>('PATCH', `/pages/${normalizeId(target.id)}`, {
      properties,
    });
    return {
      action: 'updated',
      pageId: String(page.id),
      url: page.url,
      skipped,
      ...(existing.length > 1
        ? {
            duplicateWarning:
              `같은 날짜(${record.date})의 행이 ${existing.length}개 있습니다. ` +
              `가장 오래된 행만 갱신했습니다. 나머지는 그대로 두었으니 Notion에서 직접 확인하세요.`,
          }
        : {}),
    };
  }

  // 3) 없으면 새로 만든다
  const page = await client.request<any>('POST', '/pages', {
    parent: { database_id: databaseId },
    properties,
  });
  return { action: 'created', pageId: String(page.id), url: page.url, skipped };
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

    // 이름 충돌을 피한다 — 같은 이름이 이미 있으면 건드리지 않는다.
    let name = spec.labelKo;
    if (existingNames.has(name)) continue;

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
