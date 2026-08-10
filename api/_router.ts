/**
 * 프레임워크 비의존 API 라우터.
 *
 * Vercel 서버리스 함수, Vite 개발 서버 미들웨어, 단위 테스트가 모두 이 함수를 호출한다.
 * Notion Secret 은 오직 여기(서버)에서만 읽히며 응답에 포함되지 않는다.
 */

import {
  NotionClient,
  NotionError,
  addMissingProperties,
  fetchDatabaseSchema,
  normalizeId,
  suggestMapping,
  upsertDayRecord,
  type DatabaseSchema,
  type DayRecordPayload,
  type FieldMapping,
  type FetchLike,
  type LogicalField,
} from './_notion.js';

export interface ServerEnv {
  NOTION_TOKEN?: string;
  NOTION_DATABASE_ID?: string;
  NOTION_VERSION?: string;
  NOTION_ALLOW_WRITE?: string;
  APP_ACCESS_KEY?: string;
  ALLOWED_ORIGINS?: string;
}

export interface ApiRequest {
  method: string;
  /** "/api" 접두사를 제외한 경로. 예: "/notion/schema" */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: any;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface RouterDeps {
  env: ServerEnv;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

function json(status: number, body: unknown, extraHeaders: Record<string, string> = {}): ApiResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
    body,
  };
}

function corsHeaders(env: ServerEnv, origin: string | undefined): Record<string, string> {
  const allowed = (env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim()).filter(Boolean);
  const allowOrigin =
    allowed.includes('*') || !origin ? '*'
      : allowed.includes(origin) ? origin
        : 'null';
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-app-key',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function errorBody(err: unknown): { error: string; code: string; retryable: boolean } {
  if (err instanceof NotionError) {
    return { error: err.message, code: err.code, retryable: err.retryable };
  }
  return {
    error: (err as Error)?.message ?? '알 수 없는 서버 오류',
    code: 'internal_error',
    retryable: true,
  };
}

function statusFor(err: unknown): number {
  if (err instanceof NotionError) {
    // 0(네트워크 장애)은 502 로 바꿔 클라이언트가 재시도 대상으로 인식하게 한다.
    return err.status === 0 ? 502 : err.status;
  }
  return 500;
}

export async function handleApiRequest(req: ApiRequest, deps: RouterDeps): Promise<ApiResponse> {
  const { env } = deps;
  const cors = corsHeaders(env, req.headers['origin']);

  if (req.method === 'OPTIONS') return { status: 204, headers: cors, body: null };

  // 경로를 한 단계로 눌러서 받는다.
  //
  // 배포 환경에서 `/api/health`(한 단계)는 함수에 닿는데 `/api/notion/schema`
  // (두 단계)는 닿지 않고 404/SPA fallback 으로 새는 일이 있었다. 호스팅의
  // 캐치올 라우팅 동작에 기대지 않기 위해, 프론트는 `/notion-schema` 처럼
  // 한 단계 경로로 호출한다. 아래에서 기존 두 단계 경로로 정규화하므로
  // 라우팅 표는 그대로 두고 양쪽 형태를 모두 받는다.
  const path = (req.path.replace(/\/+$/, '') || '/').replace(/^\/notion-/, '/notion/');

  // ---- /health : 시크릿 없이 접근 가능 (프론트가 백엔드 존재 여부를 감지) ----
  if (path === '/health' && req.method === 'GET') {
    return json(
      200,
      {
        ok: true,
        notionConfigured: Boolean(env.NOTION_TOKEN),
        databaseConfigured: Boolean(env.NOTION_DATABASE_ID),
        writeAllowed: env.NOTION_ALLOW_WRITE === '1',
        accessKeyRequired: Boolean(env.APP_ACCESS_KEY),
        notionVersion: env.NOTION_VERSION || '2022-06-28',
      },
      cors,
    );
  }

  // ---- 이후 경로는 접근키 검사 ----
  if (env.APP_ACCESS_KEY && req.headers['x-app-key'] !== env.APP_ACCESS_KEY) {
    return json(401, { error: '접근 키가 올바르지 않습니다.', code: 'unauthorized', retryable: false }, cors);
  }

  if (!env.NOTION_TOKEN) {
    return json(
      503,
      {
        error: 'NOTION_TOKEN 이 서버에 설정되지 않았습니다. 배포 환경변수를 확인하세요.',
        code: 'notion_not_configured',
        retryable: false,
      },
      cors,
    );
  }

  const client = new NotionClient({
    token: env.NOTION_TOKEN,
    notionVersion: env.NOTION_VERSION,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });

  const databaseId = req.query['databaseId'] || req.body?.databaseId || env.NOTION_DATABASE_ID;
  if (!databaseId) {
    return json(
      503,
      {
        error: 'NOTION_DATABASE_ID 가 설정되지 않았습니다.',
        code: 'database_not_configured',
        retryable: false,
      },
      cors,
    );
  }

  try {
    // ---- 스키마 조회 + 매핑 제안 ----
    if (path === '/notion/schema' && req.method === 'GET') {
      const schema = await fetchDatabaseSchema(client, databaseId);
      const { mapping, unmatched } = suggestMapping(schema.properties);
      return json(200, { schema, suggestedMapping: mapping, unmatched }, cors);
    }

    // ---- 하루치 기록 upsert ----
    if (path === '/notion/upsert' && req.method === 'POST') {
      if (env.NOTION_ALLOW_WRITE !== '1') {
        return json(
          403,
          {
            error: 'NOTION_ALLOW_WRITE 가 "1" 이 아니라 쓰기가 비활성화되어 있습니다.',
            code: 'write_disabled',
            retryable: false,
          },
          cors,
        );
      }

      const record = req.body?.record as DayRecordPayload | undefined;
      const mapping = req.body?.mapping as FieldMapping | undefined;
      if (!record?.date || !mapping) {
        return json(
          400,
          { error: 'record 와 mapping 이 필요합니다.', code: 'bad_request', retryable: false },
          cors,
        );
      }

      const schema: DatabaseSchema =
        (req.body?.schema as DatabaseSchema | undefined) ??
        (await fetchDatabaseSchema(client, databaseId));

      const result = await upsertDayRecord({
        client,
        databaseId,
        schema,
        mapping,
        record,
        knownPageId: req.body?.knownPageId ?? null,
      });
      return json(200, result, cors);
    }

    // ---- 누락 Property 추가 (명시적 요청일 때만) ----
    if (path === '/notion/add-properties' && req.method === 'POST') {
      if (env.NOTION_ALLOW_WRITE !== '1') {
        return json(
          403,
          { error: '쓰기가 비활성화되어 있습니다.', code: 'write_disabled', retryable: false },
          cors,
        );
      }
      const fields = (req.body?.fields ?? []) as LogicalField[];
      if (!Array.isArray(fields) || fields.length === 0) {
        return json(400, { error: 'fields 가 필요합니다.', code: 'bad_request', retryable: false }, cors);
      }
      const schema = await fetchDatabaseSchema(client, databaseId);
      const result = await addMissingProperties({ client, databaseId, schema, fields });
      const refreshed = await fetchDatabaseSchema(client, databaseId);
      const { mapping } = suggestMapping(refreshed.properties);
      return json(200, { ...result, schema: refreshed, suggestedMapping: mapping }, cors);
    }

    // ---- 기록 되읽기 (로컬 데이터 복구/검증용, 읽기 전용) ----
    if (path === '/notion/records' && req.method === 'GET') {
      const schema = await fetchDatabaseSchema(client, databaseId);
      const res = await client.request<any>('POST', `/databases/${normalizeId(databaseId)}/query`, {
        page_size: 100,
      });
      const rows = (res.results ?? [])
        .filter((p: any) => p && p.archived !== true)
        .map((p: any) => ({ id: String(p.id), properties: shallowDecode(p.properties) }));
      return json(200, { schema, rows }, cors);
    }

    return json(404, { error: `알 수 없는 경로: ${path}`, code: 'not_found', retryable: false }, cors);
  } catch (err) {
    return json(statusFor(err), errorBody(err), cors);
  }
}

/** Notion property 값을 사람이 읽을 수 있는 원시값으로 얕게 변환 */
function shallowDecode(properties: Record<string, any> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(properties)) {
    switch (raw?.type) {
      case 'title': out[name] = joinRich(raw.title); break;
      case 'rich_text': out[name] = joinRich(raw.rich_text); break;
      case 'number': out[name] = raw.number; break;
      case 'date': out[name] = raw.date?.start ?? null; break;
      case 'select': out[name] = raw.select?.name ?? null; break;
      case 'status': out[name] = raw.status?.name ?? null; break;
      case 'checkbox': out[name] = raw.checkbox; break;
      default: out[name] = null;
    }
  }
  return out;
}

function joinRich(rich: any): string {
  return Array.isArray(rich) ? rich.map((r: any) => r?.plain_text ?? '').join('') : '';
}
