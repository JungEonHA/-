/**
 * 프론트엔드 → 자체 백엔드(/api) 클라이언트.
 *
 * 브라우저는 Notion Secret 을 절대 알지 못한다. 이 모듈은 우리 서버만 호출하고,
 * 서버가 Secret 을 붙여 Notion 에 대신 요청한다.
 * (참고: Notion API 는 CORS 를 허용하지 않으므로 브라우저 직접 호출은 애초에 불가능하다.)
 */

import type { DatabaseSchemaLite, LogicalFieldKey } from './storage';
import type { DayRecordPayload } from './record';
import type { DayLog } from './events';
import type { VacationGrant } from '../../shared/grants';

export interface HealthInfo {
  ok: true;
  notionConfigured: boolean;
  databaseConfigured: boolean;
  writeAllowed: boolean;
  accessKeyRequired: boolean;
  notionVersion: string;
  /** 서버에 배포된 커밋 앞 8자. 옛 배포에는 없으므로 선택 필드다. */
  build?: string | null;
  /** 특별 휴가 부여 알림(디스코드)이 설정돼 있는지. */
  discordNotify?: boolean;
}

export interface ApiErrorShape {
  error: string;
  code: string;
  retryable: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ClientConfig {
  apiBase: string;
  accessKey: string;
}

function urlFor(config: ClientConfig, path: string): string {
  const base = config.apiBase.replace(/\/+$/, '');
  return `${base}/api${path}`;
}

/**
 * 호스팅 플랫폼의 HTML 오류 페이지에서 진단 코드를 뽑아낸다.
 * (예: Vercel 의 FUNCTION_INVOCATION_FAILED / NO_RESPONSE_FROM_FUNCTION)
 * 못 찾으면 null — 그 경우 상태 코드만 안내한다.
 */
function platformErrorCode(html: string): string | null {
  const m = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,4})\b/.exec(html.slice(0, 4000));
  return m ? ` · ${m[1]}` : null;
}

async function call<T>(
  config: ClientConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(urlFor(config, path), {
      method,
      headers: {
        'content-type': 'application/json',
        ...(config.accessKey ? { 'x-app-key': config.accessKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    throw new ApiError(
      `백엔드에 연결하지 못했습니다: ${(err as Error).message}`,
      'network_error',
      true,
      0,
    );
  }

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // JSON 이 아니면 두 가지 경우가 있고, 둘을 구분하지 않으면 오진이 된다.
    //
    //  (1) 백엔드가 아예 없음 — 정적 호스팅에서는 /api 가 SPA fallback 에 걸려
    //      index.html(200) 이 오거나 404 가 온다.
    //  (2) 백엔드는 있는데 죽었음 — 서버리스 함수가 크래시하면 플랫폼이
    //      5xx HTML 에러 페이지를 돌려준다.
    //
    // (2) 를 "정적 배포"로 안내하면 사용자가 배포 자체를 의심하게 되므로,
    // 상태 코드로 갈라서 실제 원인을 그대로 보여준다.
    if (res.status >= 500) {
      throw new ApiError(
        `백엔드는 있지만 서버 오류로 응답하지 못했습니다 (HTTP ${res.status}${
          platformErrorCode(text) ?? ''
        }). 배포 플랫폼의 함수 로그를 확인하세요.`,
        'backend_crashed',
        true,
        res.status,
      );
    }
    throw new ApiError(
      '이 주소에는 Notion 연동 백엔드가 없습니다. (정적 배포 모드)',
      'no_backend',
      false,
      res.status,
    );
  }

  if (!res.ok) {
    const e = parsed as Partial<ApiErrorShape> | null;
    throw new ApiError(
      e?.error ?? `요청 실패 (HTTP ${res.status})`,
      e?.code ?? `http_${res.status}`,
      e?.retryable ?? res.status >= 500,
      res.status,
    );
  }

  return parsed as T;
}

export function getHealth(config: ClientConfig): Promise<HealthInfo> {
  return call<HealthInfo>(config, 'GET', '/health');
}

export interface SchemaResponse {
  schema: DatabaseSchemaLite;
  suggestedMapping: Partial<Record<LogicalFieldKey, string>>;
  unmatched: LogicalFieldKey[];
}

export function getSchema(config: ClientConfig): Promise<SchemaResponse> {
  return call<SchemaResponse>(config, 'GET', '/notion-schema');
}

export interface UpsertResponse {
  action: 'created' | 'updated';
  pageId: string;
  url?: string;
  skipped: Array<{ field: LogicalFieldKey; reason: string }>;
  duplicateWarning?: string;
  foreignRowWarning?: string;
  /** 다른 기기 기록까지 합친 결과. 연동 로그를 매핑했을 때만 온다. */
  mergedLog?: DayLog;
}

export function upsertRecord(
  config: ClientConfig,
  args: {
    record: DayRecordPayload;
    dayLog?: DayLog | null;
    mapping: Partial<Record<LogicalFieldKey, string>>;
    schema?: DatabaseSchemaLite | null;
    knownPageId?: string | null;
  },
): Promise<UpsertResponse> {
  return call<UpsertResponse>(config, 'POST', '/notion-upsert', {
    record: args.record,
    // 원본 이벤트 목록을 함께 보내면 서버가 기존 행의 로그와 합쳐 준다.
    // 조회와 쓰기가 한 요청 안에서 끝나야 그 사이 다른 기기의 기록을 잃지 않는다.
    ...(args.dayLog ? { dayLog: args.dayLog } : {}),
    mapping: args.mapping,
    // 스키마를 함께 보내면 서버의 왕복 요청을 줄인다. 없으면 서버가 직접 읽는다.
    ...(args.schema ? { schema: args.schema } : {}),
    knownPageId: args.knownPageId ?? null,
  });
}

export interface DayResponse {
  found: boolean;
  pageId: string | null;
  dayLog: DayLog | null;
}

/** 다른 기기가 남긴 그날의 기록을 읽어 온다 (쓰기 없음). */
export function getDay(
  config: ClientConfig,
  args: {
    dateKey: string;
    employeeName: string | null;
    mapping: Partial<Record<LogicalFieldKey, string>>;
  },
): Promise<DayResponse> {
  const params = new URLSearchParams({ date: args.dateKey, mapping: JSON.stringify(args.mapping) });
  if (args.employeeName) params.set('employee', args.employeeName);
  return call<DayResponse>(config, 'GET', `/notion-day?${params.toString()}`);
}

export interface DaysResponse {
  days: Array<{ dateKey: string; pageId: string; dayLog: DayLog | null }>;
}

/**
 * 기간 안의 기록을 한꺼번에 읽어 온다 (쓰기 없음).
 * 저장소가 빈 기기에서 지난 기록을 되살리는 데 쓴다.
 */
export function getDays(
  config: ClientConfig,
  args: {
    from: string;
    to: string;
    employeeName: string | null;
    mapping: Partial<Record<LogicalFieldKey, string>>;
  },
): Promise<DaysResponse> {
  const params = new URLSearchParams({
    from: args.from,
    to: args.to,
    mapping: JSON.stringify(args.mapping),
  });
  if (args.employeeName) params.set('employee', args.employeeName);
  return call<DaysResponse>(config, 'GET', `/notion-days?${params.toString()}`);
}

/** 그 사람에게 부여된 특별 휴가 목록 (읽기 전용). */
export function getGrants(
  config: ClientConfig,
  args: {
    employeeName: string | null;
    mapping: Partial<Record<LogicalFieldKey, string>>;
  },
): Promise<{ grants: VacationGrant[] }> {
  const params = new URLSearchParams({ mapping: JSON.stringify(args.mapping) });
  if (args.employeeName) params.set('employee', args.employeeName);
  return call<{ grants: VacationGrant[] }>(config, 'GET', `/notion-grants?${params.toString()}`);
}

/** 특별 휴가를 부여한다 (Notion 에 새 행을 만든다). */
export function addGrant(
  config: ClientConfig,
  args: {
    employeeName: string | null;
    dateKey: string;
    hours: number;
    reason: string;
    mapping: Partial<Record<LogicalFieldKey, string>>;
    /** 부여한 사람. 디스코드 알림 문구에만 쓴다. */
    grantedBy?: string | null;
  },
): Promise<{ grant: VacationGrant; notice?: GrantNoticeResult }> {
  return call<{ grant: VacationGrant; notice?: GrantNoticeResult }>(
    config,
    'POST',
    '/notion-grants',
    {
      employee: args.employeeName,
      dateKey: args.dateKey,
      hours: args.hours,
      reason: args.reason,
      mapping: args.mapping,
      grantedBy: args.grantedBy ?? null,
    },
  );
}

/** 디스코드 근무현황 채널 알림의 결과. 부여 자체의 성패와는 무관하다. */
export type GrantNoticeResult =
  | { sent: true }
  | { sent: false; reason: 'not_configured' | 'failed'; detail?: string };

/** 부여를 되돌린다 (Notion 휴지통). */
export function revokeGrant(config: ClientConfig, id: string): Promise<{ ok: true }> {
  return call<{ ok: true }>(config, 'POST', '/notion-grants/revoke', { id });
}

export function addProperties(
  config: ClientConfig,
  fields: LogicalFieldKey[],
): Promise<{
  added: Array<{ field: LogicalFieldKey; name: string; type: string }>;
  schema: DatabaseSchemaLite;
  suggestedMapping: Partial<Record<LogicalFieldKey, string>>;
}> {
  return call(config, 'POST', '/notion-add-properties', { fields });
}
