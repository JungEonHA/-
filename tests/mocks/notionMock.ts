/**
 * 인메모리 Notion API 모의 서버.
 *
 * 이 환경에서는 api.notion.com 으로 나가는 트래픽이 차단되어 있어 실제 호출을 할 수 없다.
 * 대신 Notion API 의 동작(스키마 조회, 필터 질의, 페이지 생성/부분갱신, 429/5xx 응답)을
 * 재현해 연동 로직을 검증한다.
 */

export interface MockProperty {
  id: string;
  type: string;
  options?: string[];
}

export interface MockPage {
  id: string;
  created_time: string;
  archived: boolean;
  properties: Record<string, any>;
  url: string;
}

export interface MockOptions {
  /** DB 의 Property 정의: 이름 -> 타입 */
  properties: Record<string, MockProperty>;
  title?: string;
  databaseId?: string;
}

export class NotionMock {
  readonly databaseId: string;
  title: string;
  properties: Record<string, MockProperty>;
  pages: MockPage[] = [];

  /** 호출 기록 — 어떤 요청이 몇 번 나갔는지 검증용 */
  calls: Array<{ method: string; path: string; body: any }> = [];

  /** 다음 N개의 요청에 대해 강제로 낼 오류 (앞에서부터 소비) */
  failures: Array<{ status: number; code?: string; message?: string } | 'network'> = [];

  private seq = 0;

  constructor(opts: MockOptions) {
    this.databaseId = (opts.databaseId ?? 'aaaaaaaabbbbccccddddeeeeeeeeeeee').replace(/-/g, '');
    this.title = opts.title ?? '근무시간';
    this.properties = opts.properties;
  }

  /** 토큰 유효성 검사에 쓰는 값 */
  token = 'ntn_test_secret';

  /** 실제 Notion 과 동일하게 32자리 hex id 를 만든다 */
  private nextId(): string {
    this.seq += 1;
    return `0fa9e${String(this.seq).padStart(3, '0')}`.padEnd(32, 'c');
  }

  fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const forced = this.failures.shift();
    if (forced === 'network') throw new TypeError('fetch failed');

    const path = url.replace(/^https:\/\/api\.notion\.com\/v1/, '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path, body });

    const auth = (init?.headers as Record<string, string> | undefined)?.['Authorization'];
    if (auth !== `Bearer ${this.token}`) {
      return jsonResponse(401, { code: 'unauthorized', message: 'API token is invalid.' });
    }

    if (forced) {
      return jsonResponse(
        forced.status,
        {
          code: forced.code ?? 'internal_server_error',
          message: forced.message ?? 'mock failure',
        },
        forced.status === 429 ? { 'retry-after': '0' } : {},
      );
    }

    // GET /databases/{id}
    const dbGet = /^\/databases\/([0-9a-f]{32})$/.exec(path);
    if (method === 'GET' && dbGet) {
      if (dbGet[1] !== this.databaseId) {
        return jsonResponse(404, { code: 'object_not_found', message: 'Could not find database.' });
      }
      return jsonResponse(200, this.databaseObject());
    }

    // PATCH /databases/{id} — property 추가
    if (method === 'PATCH' && dbGet) {
      for (const [name, def] of Object.entries(body?.properties ?? {})) {
        const type = Object.keys(def as object)[0]!;
        this.properties[name] = { id: `p_${name}`, type };
      }
      return jsonResponse(200, this.databaseObject());
    }

    // POST /databases/{id}/query
    const dbQuery = /^\/databases\/([0-9a-f]{32})\/query$/.exec(path);
    if (method === 'POST' && dbQuery) {
      const results = this.pages.filter((p) => !p.archived && matchesFilter(p, body?.filter));
      return jsonResponse(200, { object: 'list', results, has_more: false });
    }

    // POST /pages
    if (method === 'POST' && path === '/pages') {
      const id = this.nextId();
      const page: MockPage = {
        id,
        created_time: new Date(1_700_000_000_000 + this.seq * 1000).toISOString(),
        archived: false,
        properties: { ...(body?.properties ?? {}) },
        url: `https://notion.so/${id}`,
      };
      this.pages.push(page);
      return jsonResponse(200, page);
    }

    // PATCH /pages/{id} — 부분 병합 (기존 property 는 보존)
    const pagePatch = /^\/pages\/([0-9a-f]{32})$/.exec(path);
    if (method === 'PATCH' && pagePatch) {
      const page = this.pages.find((p) => p.id === pagePatch[1]);
      if (!page) {
        return jsonResponse(404, { code: 'object_not_found', message: 'Could not find page.' });
      }
      Object.assign(page.properties, body?.properties ?? {});
      return jsonResponse(200, page);
    }

    return jsonResponse(404, { code: 'not_found', message: `mock: ${method} ${path}` });
  };

  private databaseObject() {
    return {
      object: 'database',
      id: this.databaseId,
      url: `https://notion.so/${this.databaseId}`,
      title: [{ plain_text: this.title }],
      properties: Object.fromEntries(
        Object.entries(this.properties).map(([name, p]) => [
          name,
          {
            id: p.id,
            name,
            type: p.type,
            ...(p.type === 'select' || p.type === 'status'
              ? { [p.type]: { options: (p.options ?? []).map((o) => ({ name: o })) } }
              : {}),
          },
        ]),
      ),
    };
  }

  /** 특정 페이지의 property 를 사람이 읽기 쉬운 값으로 */
  read(pageId: string): Record<string, unknown> {
    const page = this.pages.find((p) => p.id === pageId);
    if (!page) throw new Error(`no page ${pageId}`);
    const out: Record<string, unknown> = {};
    for (const [name, raw] of Object.entries(page.properties)) {
      out[name] = decode(raw);
    }
    return out;
  }
}

function decode(raw: any): unknown {
  if (raw?.title) return raw.title.map((t: any) => t.text?.content ?? '').join('');
  if (raw?.rich_text) return raw.rich_text.map((t: any) => t.text?.content ?? '').join('');
  if ('number' in (raw ?? {})) return raw.number;
  if ('date' in (raw ?? {})) return raw.date?.start ?? null;
  if ('select' in (raw ?? {})) return raw.select?.name ?? null;
  if ('status' in (raw ?? {})) return raw.status?.name ?? null;
  return null;
}

function matchesFilter(page: MockPage, filter: any): boolean {
  if (!filter) return true;
  if (Array.isArray(filter.and)) return filter.and.every((f: any) => matchesFilter(page, f));
  if (Array.isArray(filter.or)) return filter.or.some((f: any) => matchesFilter(page, f));

  const raw = page.properties[filter.property];
  if (!raw) return false;
  if (filter.date?.equals !== undefined) return (raw.date?.start ?? null) === filter.date.equals;
  if (filter.rich_text?.equals !== undefined) return decode(raw) === filter.rich_text.equals;
  if (filter.title?.equals !== undefined) return decode(raw) === filter.title.equals;
  if (filter.select?.equals !== undefined) return (raw.select?.name ?? null) === filter.select.equals;
  if (filter.status?.equals !== undefined) return (raw.status?.name ?? null) === filter.status.equals;
  if (filter.multi_select?.contains !== undefined) {
    return (raw.multi_select ?? []).some((o: any) => o?.name === filter.multi_select.contains);
  }
  return false;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
