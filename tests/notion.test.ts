import { beforeEach, describe, expect, it } from 'vitest';
import { NotionMock } from './mocks/notionMock';
import { handleApiRequest, type ApiRequest, type ServerEnv } from '../api/_router';
import {
  NotionClient,
  buildProperties,
  fetchDatabaseSchema,
  normalizeId,
  suggestMapping,
  upsertDayRecord,
  type DayRecordPayload,
} from '../api/_notion';

const DB_ID = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';

/**
 * 일부러 "우리가 하드코딩하지 않은" 이름들을 섞어 둔다.
 * 스키마를 런타임에 읽어 매핑하는 구조인지 검증하기 위함이다.
 */
function realisticMock() {
  return new NotionMock({
    databaseId: DB_ID,
    title: '근무 기록',
    properties: {
      '기록명': { id: 'p1', type: 'title' },
      '근무 일자': { id: 'p2', type: 'date' },
      '출근 시각': { id: 'p3', type: 'rich_text' },
      '퇴근 시각': { id: 'p4', type: 'rich_text' },
      '실 근무시간': { id: 'p5', type: 'number' },
      '자리 비움': { id: 'p6', type: 'number' },
      '휴가': { id: 'p7', type: 'number' },
      '인정 근무시간': { id: 'p8', type: 'number' },
      '상태': { id: 'p9', type: 'select', options: ['퇴근 완료', '근무 중'] },
      '메모': { id: 'p10', type: 'rich_text' },
      '담당자': { id: 'p11', type: 'people' },
    },
  });
}

function makeClient(mock: NotionMock) {
  return new NotionClient({
    token: mock.token,
    fetchImpl: mock.fetchImpl,
    sleep: async () => {},
    maxRetries: 3,
  });
}

const RECORD: DayRecordPayload = {
  date: '2026-08-10',
  clockInIso: '2026-08-10T09:00:00+09:00',
  clockOutIso: '2026-08-10T18:00:00+09:00',
  clockInText: '09:00',
  clockOutText: '18:00',
  actualHours: 8,
  awayHours: 1,
  vacationHours: 0,
  creditedHours: 8,
  statusText: '퇴근 완료',
};

describe('ID 정규화', () => {
  it('하이픈/URL 형태를 모두 32자리로 정규화한다', () => {
    expect(normalizeId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(DB_ID);
    expect(normalizeId(DB_ID)).toBe(DB_ID);
    expect(normalizeId(`https://notion.so/workspace/${DB_ID}?v=123`)).toBe(DB_ID);
  });

  it('잘못된 값은 거부한다', () => {
    expect(() => normalizeId('nope')).toThrow();
  });
});

describe('스키마 조회와 매핑 제안', () => {
  it('실제 DB 의 Property 이름과 타입을 그대로 읽는다', async () => {
    const mock = realisticMock();
    const schema = await fetchDatabaseSchema(makeClient(mock), DB_ID);

    expect(schema.title).toBe('근무 기록');
    expect(schema.properties.map((p) => p.name)).toContain('근무 일자');
    expect(schema.properties.find((p) => p.name === '상태')?.options).toEqual([
      '퇴근 완료',
      '근무 중',
    ]);
  });

  it('띄어쓰기가 다른 이름도 후보로 매칭한다 (하드코딩이 아니라 제안)', async () => {
    const mock = realisticMock();
    const schema = await fetchDatabaseSchema(makeClient(mock), DB_ID);
    const { mapping } = suggestMapping(schema.properties);

    expect(mapping.title).toBe('기록명');
    expect(mapping.date).toBe('근무 일자');
    expect(mapping.clockIn).toBe('출근 시각');
    expect(mapping.clockOut).toBe('퇴근 시각');
    expect(mapping.status).toBe('상태');
  });

  it('같은 Property 를 두 필드에 중복 배정하지 않는다', async () => {
    const mock = realisticMock();
    const schema = await fetchDatabaseSchema(makeClient(mock), DB_ID);
    const { mapping } = suggestMapping(schema.properties);
    const used = Object.values(mapping);
    expect(new Set(used).size).toBe(used.length);
  });

  it('일치하는 Property 가 없으면 제안하지 않고 unmatched 로 보고한다', async () => {
    const mock = new NotionMock({
      databaseId: DB_ID,
      properties: {
        Name: { id: 'p1', type: 'title' },
        Date: { id: 'p2', type: 'date' },
      },
    });
    const schema = await fetchDatabaseSchema(makeClient(mock), DB_ID);
    const { mapping, unmatched } = suggestMapping(schema.properties);

    expect(mapping.date).toBe('Date');
    expect(unmatched).toContain('vacation');
    expect(unmatched).toContain('credited');
    expect(mapping.vacation).toBeUndefined();
  });
});

describe('값 인코딩', () => {
  it('타입별로 알맞은 형태로 인코딩한다', async () => {
    const mock = realisticMock();
    const schema = await fetchDatabaseSchema(makeClient(mock), DB_ID);
    const { mapping } = suggestMapping(schema.properties);
    const { properties } = buildProperties(schema, mapping, RECORD);

    expect(properties['근무 일자']).toEqual({ date: { start: '2026-08-10' } });
    expect(properties['출근 시각']).toEqual({
      rich_text: [{ type: 'text', text: { content: '09:00' } }],
    });
    expect(properties['실 근무시간']).toEqual({ number: 8 });
    expect(properties['상태']).toEqual({ select: { name: '퇴근 완료' } });
  });

  it('date 타입에 매핑된 출퇴근시간은 ISO 시각으로 쓴다', async () => {
    const mock = new NotionMock({
      databaseId: DB_ID,
      properties: {
        이름: { id: 'p1', type: 'title' },
        날짜: { id: 'p2', type: 'date' },
        출근시간: { id: 'p3', type: 'date' },
      },
    });
    const schema = await fetchDatabaseSchema(makeClient(mock), DB_ID);
    const { properties } = buildProperties(
      schema,
      { date: '날짜', clockIn: '출근시간' },
      RECORD,
    );
    expect(properties['출근시간']).toEqual({ date: { start: '2026-08-10T09:00:00+09:00' } });
  });

  it('매핑되지 않았거나 타입이 안 맞으면 건너뛰고 이유를 남긴다', async () => {
    const mock = realisticMock();
    const schema = await fetchDatabaseSchema(makeClient(mock), DB_ID);
    // 숫자 필드를 people 타입에 억지로 매핑
    const { properties, skipped } = buildProperties(
      schema,
      { date: '근무 일자', actualWork: '담당자' },
      RECORD,
    );

    expect(properties['담당자']).toBeUndefined();
    expect(skipped.find((s) => s.field === 'actualWork')?.reason).toContain('people');
    expect(skipped.find((s) => s.field === 'vacation')?.reason).toBe('매핑되지 않음');
  });

  it('매핑에 없는 기존 Property 는 페이로드에 포함되지 않는다 (기존 데이터 보호)', async () => {
    const mock = realisticMock();
    const schema = await fetchDatabaseSchema(makeClient(mock), DB_ID);
    const { mapping } = suggestMapping(schema.properties);
    const { properties } = buildProperties(schema, mapping, RECORD);
    expect(properties['메모']).toBeUndefined();
    expect(properties['담당자']).toBeUndefined();
  });
});

describe('중복 방지 upsert', () => {
  let mock: NotionMock;

  beforeEach(() => {
    mock = realisticMock();
  });

  async function upsert(record: DayRecordPayload, knownPageId?: string | null) {
    const client = makeClient(mock);
    const schema = await fetchDatabaseSchema(client, DB_ID);
    const { mapping } = suggestMapping(schema.properties);
    return upsertDayRecord({
      client,
      databaseId: DB_ID,
      schema,
      mapping,
      record,
      knownPageId: knownPageId ?? null,
    });
  }

  it('처음에는 새 행을 만든다', async () => {
    const res = await upsert(RECORD);
    expect(res.action).toBe('created');
    expect(mock.pages).toHaveLength(1);
    expect(mock.read(res.pageId)['실 근무시간']).toBe(8);
  });

  it('같은 날짜를 다시 저장하면 행이 늘지 않고 갱신된다', async () => {
    const first = await upsert(RECORD);
    const second = await upsert({ ...RECORD, actualHours: 9, creditedHours: 9 });

    expect(second.action).toBe('updated');
    expect(second.pageId).toBe(first.pageId);
    expect(mock.pages).toHaveLength(1);
    expect(mock.read(first.pageId)['실 근무시간']).toBe(9);
  });

  it('세 번을 연속 저장해도 행은 하나다', async () => {
    await upsert(RECORD);
    await upsert(RECORD);
    await upsert(RECORD);
    expect(mock.pages).toHaveLength(1);
  });

  it('날짜가 다르면 별도의 행을 만든다', async () => {
    await upsert(RECORD);
    await upsert({ ...RECORD, date: '2026-08-11' });
    expect(mock.pages).toHaveLength(2);
  });

  it('알고 있는 pageId 로는 조회 없이 바로 갱신한다', async () => {
    const first = await upsert(RECORD);
    mock.calls = [];
    const res = await upsert({ ...RECORD, actualHours: 7 }, first.pageId);

    expect(res.action).toBe('updated');
    expect(mock.calls.some((c) => c.path.endsWith('/query'))).toBe(false);
  });

  it('기억하던 pageId 가 사라졌으면 조회로 폴백한다', async () => {
    const first = await upsert(RECORD);
    const res = await upsert(RECORD, 'ffffffffffffffffffffffffffffffff');

    expect(res.action).toBe('updated');
    expect(res.pageId).toBe(first.pageId);
    expect(mock.pages).toHaveLength(1);
  });

  it('갱신 시 매핑 밖의 기존 값은 보존된다', async () => {
    const created = await upsert(RECORD);
    // 사용자가 Notion 에서 직접 메모를 적었다고 가정
    mock.pages[0]!.properties['메모'] = {
      rich_text: [{ type: 'text', text: { content: '건강검진' } }],
    };

    await upsert({ ...RECORD, actualHours: 6 });
    expect(mock.read(created.pageId)['메모']).toBe('건강검진');
    expect(mock.read(created.pageId)['실 근무시간']).toBe(6);
  });

  it('같은 날짜 행이 여러 개면 가장 오래된 것만 갱신하고 나머지는 건드리지 않는다', async () => {
    await upsert(RECORD);
    // Notion 쪽에서 수동으로 같은 날짜 행이 하나 더 생긴 상황
    mock.pages.push({
      id: 'dddd0000000000000000000000000002',
      created_time: new Date(1_800_000_000_000).toISOString(),
      archived: false,
      properties: { '근무 일자': { date: { start: '2026-08-10' } } },
      url: 'https://notion.so/dup',
    });

    const res = await upsert({ ...RECORD, actualHours: 5 });
    expect(res.duplicateWarning).toContain('2개');
    expect(mock.pages).toHaveLength(2); // 삭제하지 않는다
    expect(mock.read(res.pageId)['실 근무시간']).toBe(5);
    expect(mock.read('dddd0000000000000000000000000002')['실 근무시간']).toBeUndefined();
  });

  it('아카이브된 행은 무시하고 새로 만든다', async () => {
    const first = await upsert(RECORD);
    mock.pages[0]!.archived = true;

    const res = await upsert(RECORD);
    expect(res.action).toBe('created');
    expect(res.pageId).not.toBe(first.pageId);
  });

  it('삭제/아카이브 요청은 한 번도 보내지 않는다', async () => {
    await upsert(RECORD);
    await upsert({ ...RECORD, actualHours: 3 });
    expect(mock.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(mock.calls.some((c) => c.body?.archived === true)).toBe(false);
  });

  it('쓸 수 있는 Property 가 하나도 없으면 명확히 실패한다', async () => {
    const client = makeClient(mock);
    const schema = await fetchDatabaseSchema(client, DB_ID);
    await expect(
      upsertDayRecord({ client, databaseId: DB_ID, schema, mapping: {}, record: RECORD }),
    ).rejects.toThrow('매핑되지 않았습니다');
  });
});

describe('오류 처리와 재시도', () => {
  it('429 는 재시도 후 성공한다', async () => {
    const mock = realisticMock();
    mock.failures = [{ status: 429, code: 'rate_limited' }];
    const client = makeClient(mock);

    const schema = await fetchDatabaseSchema(client, DB_ID);
    expect(schema.title).toBe('근무 기록');
  });

  it('5xx 는 재시도한다', async () => {
    const mock = realisticMock();
    mock.failures = [{ status: 502 }, { status: 503 }];
    const schema = await fetchDatabaseSchema(makeClient(mock), DB_ID);
    expect(schema.properties.length).toBeGreaterThan(0);
  });

  it('네트워크 장애도 재시도 대상이다', async () => {
    const mock = realisticMock();
    mock.failures = ['network'];
    const schema = await fetchDatabaseSchema(makeClient(mock), DB_ID);
    expect(schema.title).toBe('근무 기록');
  });

  it('재시도 한도를 넘으면 retryable 오류로 던진다', async () => {
    const mock = realisticMock();
    mock.failures = [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }];
    await expect(fetchDatabaseSchema(makeClient(mock), DB_ID)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it('401 같은 영구 오류는 재시도하지 않는다', async () => {
    const mock = realisticMock();
    const client = new NotionClient({
      token: 'wrong-token',
      fetchImpl: mock.fetchImpl,
      sleep: async () => {},
    });

    await expect(fetchDatabaseSchema(client, DB_ID)).rejects.toMatchObject({
      status: 401,
      retryable: false,
    });
    expect(mock.calls).toHaveLength(1); // 재시도 없음
  });

  it('없는 DB 는 404 로 명확히 실패한다', async () => {
    const mock = realisticMock();
    await expect(
      fetchDatabaseSchema(makeClient(mock), 'ffffffffffffffffffffffffffffffff'),
    ).rejects.toMatchObject({ status: 404, retryable: false });
  });
});

describe('Property 추가 (opt-in)', () => {
  it('누락된 Property 만 추가하고 기존 것은 건드리지 않는다', async () => {
    const mock = new NotionMock({
      databaseId: DB_ID,
      properties: {
        이름: { id: 'p1', type: 'title' },
        날짜: { id: 'p2', type: 'date' },
      },
    });

    const res = await handleApiRequest(
      {
        method: 'POST',
        path: '/notion/add-properties',
        query: {},
        headers: {},
        body: { fields: ['vacation', 'credited'] },
      },
      { env: envFor(mock), fetchImpl: mock.fetchImpl, sleep: async () => {} },
    );

    expect(res.status).toBe(200);
    expect(mock.properties['휴가시간']?.type).toBe('number');
    expect(mock.properties['인정 근무시간']?.type).toBe('number');
    expect(mock.properties['날짜']).toEqual({ id: 'p2', type: 'date' }); // 그대로
  });

  it('이름이 겹치면 추가하지 않는다', async () => {
    const mock = new NotionMock({
      databaseId: DB_ID,
      properties: {
        이름: { id: 'p1', type: 'title' },
        휴가시간: { id: 'p2', type: 'rich_text' },
      },
    });
    const before = { ...mock.properties };

    await handleApiRequest(
      {
        method: 'POST',
        path: '/notion/add-properties',
        query: {},
        headers: {},
        body: { fields: ['vacation'] },
      },
      { env: envFor(mock), fetchImpl: mock.fetchImpl, sleep: async () => {} },
    );

    expect(mock.properties).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 라우터 레벨
// ---------------------------------------------------------------------------

function envFor(mock: NotionMock, extra: Partial<ServerEnv> = {}): ServerEnv {
  return {
    NOTION_TOKEN: mock.token,
    NOTION_DATABASE_ID: mock.databaseId,
    NOTION_ALLOW_WRITE: '1',
    ...extra,
  };
}

function req(partial: Partial<ApiRequest> & Pick<ApiRequest, 'method' | 'path'>): ApiRequest {
  return { query: {}, headers: {}, body: {}, ...partial };
}

describe('API 라우터', () => {
  it('/health 는 시크릿 없이도 응답하고 토큰 값을 노출하지 않는다', async () => {
    const mock = realisticMock();
    const res = await handleApiRequest(req({ method: 'GET', path: '/health' }), {
      env: envFor(mock),
      fetchImpl: mock.fetchImpl,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, notionConfigured: true, writeAllowed: true });
    expect(JSON.stringify(res.body)).not.toContain(mock.token);
  });

  it('토큰 미설정 시 503 과 안내 메시지', async () => {
    const res = await handleApiRequest(req({ method: 'GET', path: '/notion/schema' }), { env: {} });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'notion_not_configured', retryable: false });
  });

  it('한 단계 경로(/notion-*)와 두 단계 경로(/notion/*)를 모두 받는다', async () => {
    // 배포 환경에서 `/api/health`(한 단계)는 함수에 닿는데 `/api/notion/schema`
    // (두 단계)는 404 로 샜다. 프론트는 한 단계 경로를 쓰고, 서버는 양쪽을 받는다.
    const mock = realisticMock();
    const deps = { env: envFor(mock), fetchImpl: mock.fetchImpl };

    const flat = await handleApiRequest(req({ method: 'GET', path: '/notion-schema' }), deps);
    const nested = await handleApiRequest(req({ method: 'GET', path: '/notion/schema' }), deps);

    expect(flat.status).toBe(200);
    expect(flat.body).toEqual(nested.body);

    // 이름 자체에 하이픈이 든 경로도 잘리면 안 된다.
    // (핸들러가 bad_request 를 돌려준다는 건 라우팅이 닿았다는 뜻 — 404 가 아니다)
    const flatAdd = await handleApiRequest(
      req({ method: 'POST', path: '/notion-add-properties', body: { fields: [] } }),
      deps,
    );
    const nestedAdd = await handleApiRequest(
      req({ method: 'POST', path: '/notion/add-properties', body: { fields: [] } }),
      deps,
    );
    expect(flatAdd.body).toMatchObject({ code: 'bad_request' });
    expect(flatAdd.status).toBe(nestedAdd.status);
  });

  it('APP_ACCESS_KEY 가 설정되면 헤더 없이는 401', async () => {
    const mock = realisticMock();
    const env = envFor(mock, { APP_ACCESS_KEY: 's3cret' });

    const denied = await handleApiRequest(req({ method: 'GET', path: '/notion/schema' }), {
      env,
      fetchImpl: mock.fetchImpl,
    });
    expect(denied.status).toBe(401);

    const allowed = await handleApiRequest(
      req({ method: 'GET', path: '/notion/schema', headers: { 'x-app-key': 's3cret' } }),
      { env, fetchImpl: mock.fetchImpl },
    );
    expect(allowed.status).toBe(200);
  });

  it('NOTION_ALLOW_WRITE 가 1 이 아니면 쓰기를 막는다', async () => {
    const mock = realisticMock();
    const res = await handleApiRequest(
      req({
        method: 'POST',
        path: '/notion/upsert',
        body: { record: RECORD, mapping: { date: '근무 일자' } },
      }),
      { env: envFor(mock, { NOTION_ALLOW_WRITE: '0' }), fetchImpl: mock.fetchImpl },
    );

    expect(res.status).toBe(403);
    expect(mock.pages).toHaveLength(0);
  });

  it('upsert 전체 흐름이 라우터를 통해 동작한다', async () => {
    const mock = realisticMock();
    const deps = { env: envFor(mock), fetchImpl: mock.fetchImpl, sleep: async () => {} };

    const schemaRes = await handleApiRequest(req({ method: 'GET', path: '/notion/schema' }), deps);
    const { suggestedMapping, schema } = schemaRes.body as any;

    const first = await handleApiRequest(
      req({
        method: 'POST',
        path: '/notion/upsert',
        body: { record: RECORD, mapping: suggestedMapping, schema },
      }),
      deps,
    );
    const second = await handleApiRequest(
      req({
        method: 'POST',
        path: '/notion/upsert',
        body: { record: { ...RECORD, actualHours: 8.5 }, mapping: suggestedMapping, schema },
      }),
      deps,
    );

    expect((first.body as any).action).toBe('created');
    expect((second.body as any).action).toBe('updated');
    expect(mock.pages).toHaveLength(1);
  });

  it('Notion 오류를 그대로 전달하되 재시도 가능 여부를 알려준다', async () => {
    const mock = realisticMock();
    mock.failures = [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }];

    const res = await handleApiRequest(req({ method: 'GET', path: '/notion/schema' }), {
      env: envFor(mock),
      fetchImpl: mock.fetchImpl,
      sleep: async () => {},
    });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ retryable: true });
  });

  it('CORS 프리플라이트를 처리한다', async () => {
    const res = await handleApiRequest(req({ method: 'OPTIONS', path: '/notion/upsert' }), {
      env: {},
    });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('알 수 없는 경로는 404', async () => {
    const mock = realisticMock();
    const res = await handleApiRequest(req({ method: 'GET', path: '/nope' }), {
      env: envFor(mock),
      fetchImpl: mock.fetchImpl,
    });
    expect(res.status).toBe(404);
  });
});
