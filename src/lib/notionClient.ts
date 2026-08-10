/**
 * 프론트엔드 → 자체 백엔드(/api) 클라이언트.
 *
 * 브라우저는 Notion Secret 을 절대 알지 못한다. 이 모듈은 우리 서버만 호출하고,
 * 서버가 Secret 을 붙여 Notion 에 대신 요청한다.
 * (참고: Notion API 는 CORS 를 허용하지 않으므로 브라우저 직접 호출은 애초에 불가능하다.)
 */

import type { DatabaseSchemaLite, LogicalFieldKey } from './storage';
import type { DayRecordPayload } from './record';

export interface HealthInfo {
  ok: true;
  notionConfigured: boolean;
  databaseConfigured: boolean;
  writeAllowed: boolean;
  accessKeyRequired: boolean;
  notionVersion: string;
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
    // 정적 호스팅(GitHub Pages 등)에서는 /api 가 없어 index.html(HTML)이 돌아온다.
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
  return call<SchemaResponse>(config, 'GET', '/notion/schema');
}

export interface UpsertResponse {
  action: 'created' | 'updated';
  pageId: string;
  url?: string;
  skipped: Array<{ field: LogicalFieldKey; reason: string }>;
  duplicateWarning?: string;
}

export function upsertRecord(
  config: ClientConfig,
  args: {
    record: DayRecordPayload;
    mapping: Partial<Record<LogicalFieldKey, string>>;
    schema?: DatabaseSchemaLite | null;
    knownPageId?: string | null;
  },
): Promise<UpsertResponse> {
  return call<UpsertResponse>(config, 'POST', '/notion/upsert', {
    record: args.record,
    mapping: args.mapping,
    // 스키마를 함께 보내면 서버의 왕복 요청을 줄인다. 없으면 서버가 직접 읽는다.
    ...(args.schema ? { schema: args.schema } : {}),
    knownPageId: args.knownPageId ?? null,
  });
}

export function addProperties(
  config: ClientConfig,
  fields: LogicalFieldKey[],
): Promise<{
  added: Array<{ field: LogicalFieldKey; name: string; type: string }>;
  schema: DatabaseSchemaLite;
  suggestedMapping: Partial<Record<LogicalFieldKey, string>>;
}> {
  return call(config, 'POST', '/notion/add-properties', { fields });
}
