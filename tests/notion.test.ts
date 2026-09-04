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
import { formatHoursKo } from '../shared/fields';

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
      '직원': { id: 'p12', type: 'select', options: ['하정언', '박진규'] },
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
  employeeName: null,
  eventLogText: null,
  todoText: null,
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
    expect(mapping.employee).toBe('직원');
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

  it('소수 시간을 사람이 읽는 형태로 바꾼다', () => {
    expect(formatHoursKo(8.25)).toBe('8시간 15분');
    expect(formatHoursKo(8)).toBe('8시간');
    expect(formatHoursKo(0.75)).toBe('45분');
    expect(formatHoursKo(0)).toBe('0분');
    // 분 단위로 먼저 반올림하므로 "0시간 60분" 같은 표기가 나오면 안 된다
    expect(formatHoursKo(8.999)).toBe('9시간');
    expect(formatHoursKo(0.9999)).toBe('1시간');
  });

  it('텍스트 Property 에는 "8시간 15분", 숫자 Property 에는 소수로 쓴다', async () => {
    // 같은 값이라도 Property 타입에 따라 표현이 달라야 한다.
    // Notion 숫자 Property 는 시간:분 표시를 지원하지 않아 8.25 로만 보인다.
    const mock = new NotionMock({
      databaseId: DB_ID,
      properties: {
        이름: { id: 'p1', type: 'title' },
        날짜: { id: 'p2', type: 'date' },
        근무시간텍스트: { id: 'p3', type: 'rich_text' },
        근무시간숫자: { id: 'p4', type: 'number' },
      },
    });
    const schema = await fetchDatabaseSchema(makeClient(mock), DB_ID);
    const record: DayRecordPayload = { ...RECORD, actualHours: 8.25, creditedHours: 8.25 };

    const asText = buildProperties(
      schema,
      { date: '날짜', actualWork: '근무시간텍스트' },
      record,
    ).properties;
    const asNumber = buildProperties(
      schema,
      { date: '날짜', actualWork: '근무시간숫자' },
      record,
    ).properties;

    expect(asText['근무시간텍스트']).toEqual({
      rich_text: [{ type: 'text', text: { content: '8시간 15분' } }],
    });
    expect(asNumber['근무시간숫자']).toEqual({ number: 8.25 });
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

  /** Notion 에서 사람이 직접 만든 행을 흉내 낸다 (앱 제목 규칙과 다른 제목) */
  function manualRow(id: string, title: string, createdMs: number, employee?: string) {
    mock.pages.push({
      id,
      created_time: new Date(createdMs).toISOString(),
      archived: false,
      properties: {
        '기록명': { title: [{ type: 'text', text: { content: title } }] },
        '근무 일자': { date: { start: '2026-08-10' } },
        ...(employee ? { 직원: { select: { name: employee } } } : {}),
      },
      url: `https://notion.so/${id}`,
    });
  }

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

  it('사용자가 손으로 만든 같은 날짜 행은 절대 건드리지 않는다', async () => {
    // 실제로 있었던 사고: 날짜만 맞으면 가장 오래된 행을 갱신하는 바람에
    // 사용자가 적어 둔 "반차" 행의 제목·구분이 통째로 덮어써졌다.
    manualRow('dddd0000000000000000000000000002', '반차', 1_600_000_000_000);

    const res = await upsert({ ...RECORD, actualHours: 5 });

    expect(res.action).toBe('created'); // 남의 행을 갱신하지 않고 새로 만든다
    expect(res.foreignRowWarning).toContain('1개');
    expect(mock.pages).toHaveLength(2);
    expect(mock.read('dddd0000000000000000000000000002')).toEqual({
      '기록명': '반차',
      '근무 일자': '2026-08-10',
    });
  });

  it('앱이 만든 행이 여러 개면 가장 오래된 것만 갱신한다', async () => {
    const first = await upsert(RECORD);
    // 다른 기기에서 동시에 만들어졌다고 가정 (제목이 같으므로 앱 소유)
    mock.pages.push({
      id: 'dddd0000000000000000000000000003',
      created_time: new Date(1_900_000_000_000).toISOString(),
      archived: false,
      properties: {
        '기록명': { title: [{ type: 'text', text: { content: '2026-08-10 근무기록' } }] },
        '근무 일자': { date: { start: '2026-08-10' } },
      },
      url: 'https://notion.so/dup',
    });

    const res = await upsert({ ...RECORD, actualHours: 5 });
    expect(res.duplicateWarning).toContain('2개');
    expect(res.pageId).toBe(first.pageId);
    expect(mock.pages).toHaveLength(2); // 삭제하지 않는다
    expect(mock.read('dddd0000000000000000000000000003')['실 근무시간']).toBeUndefined();
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

  it('직원이 다르면 같은 날짜라도 각자의 행을 갖는다', async () => {
    const a = await upsert({ ...RECORD, employeeName: '하정언' });
    const b = await upsert({ ...RECORD, employeeName: '박진규', actualHours: 4 });

    expect(a.action).toBe('created');
    expect(b.action).toBe('created');
    expect(b.pageId).not.toBe(a.pageId);
    expect(mock.pages).toHaveLength(2);
    expect(mock.read(a.pageId)['직원']).toBe('하정언');
    expect(mock.read(b.pageId)['직원']).toBe('박진규');
    expect(mock.read(a.pageId)['실 근무시간']).toBe(8); // 서로 덮어쓰지 않았다
    expect(mock.read(b.pageId)['실 근무시간']).toBe(4);
  });

  it('같은 직원의 같은 날짜는 계속 한 행으로 갱신된다', async () => {
    const first = await upsert({ ...RECORD, employeeName: '하정언' });
    const second = await upsert({ ...RECORD, employeeName: '하정언', actualHours: 9 });

    expect(second.action).toBe('updated');
    expect(second.pageId).toBe(first.pageId);
    expect(mock.pages).toHaveLength(1);
    expect(mock.read(first.pageId)['실 근무시간']).toBe(9);
  });

  it('다른 직원이 손으로 만든 행에는 손대지 않는다', async () => {
    manualRow('dddd0000000000000000000000000009', '박진규 반차', 1_600_000_000_000, '박진규');

    const res = await upsert({ ...RECORD, employeeName: '하정언' });

    expect(res.action).toBe('created');
    // 직원 필터가 걸리므로 애초에 조회 결과에도 잡히지 않는다
    expect(res.foreignRowWarning).toBeUndefined();
    expect(mock.read('dddd0000000000000000000000000009')['기록명']).toBe('박진규 반차');
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
    expect(mock.properties['휴가사용시간']?.type).toBe('number');
    expect(mock.properties['인정근무시간']?.type).toBe('number');
    expect(mock.properties['날짜']).toEqual({ id: 'p2', type: 'date' }); // 그대로
  });

  it('직원 Property 도 만들어 준다 (여러 명이 쓰는 DB 의 전제)', async () => {
    const mock = new NotionMock({
      databaseId: DB_ID,
      properties: { 이름: { id: 'p1', type: 'title' }, 날짜: { id: 'p2', type: 'date' } },
    });

    await handleApiRequest(
      {
        method: 'POST',
        path: '/notion/add-properties',
        query: {},
        headers: {},
        body: { fields: ['employee'] },
      },
      { env: envFor(mock), fetchImpl: mock.fetchImpl, sleep: async () => {} },
    );

    expect(mock.properties['직원']?.type).toBe('select');
  });

  it('이름이 겹치면 기존 것을 건드리지 않고 다른 이름으로 만든다', async () => {
    const mock = new NotionMock({
      databaseId: DB_ID,
      properties: {
        이름: { id: 'p1', type: 'title' },
        휴가사용시간: { id: 'p2', type: 'rich_text' },
      },
    });

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

    // 기존 Property 는 타입까지 그대로
    expect(mock.properties['휴가사용시간']).toEqual({ id: 'p2', type: 'rich_text' });
    // 그리고 실제로 쓸 수 있는 새 Property 가 생겼다 (예전에는 조용히 아무것도 안 생겼다)
    expect(mock.properties['휴가사용시간 (2)']?.type).toBe('number');
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

  it('/health 는 배포된 커밋 앞 8자를 알려준다 (화면이 낡았는지 판정하는 기준)', async () => {
    const mock = realisticMock();
    const res = await handleApiRequest(req({ method: 'GET', path: '/health' }), {
      env: { ...envFor(mock), VERCEL_GIT_COMMIT_SHA: 'e497da491b5acb8fd234fa9caa75e5216b0a1a32' },
      fetchImpl: mock.fetchImpl,
    });
    expect(res.body).toMatchObject({ build: 'e497da49' });
  });

  it('커밋을 알 수 없는 배포에서는 build 가 null 이다', async () => {
    const mock = realisticMock();
    const res = await handleApiRequest(req({ method: 'GET', path: '/health' }), {
      env: envFor(mock),
      fetchImpl: mock.fetchImpl,
    });
    expect(res.body).toMatchObject({ build: null });
  });

  it('/health 가 휴가 알림 설정 여부를 알려 준다 (웹훅 값 자체는 내지 않는다)', async () => {
    const mock = realisticMock();
    const off = await handleApiRequest(req({ method: 'GET', path: '/health' }), {
      env: envFor(mock),
      fetchImpl: mock.fetchImpl,
    });
    expect(off.body).toMatchObject({ discordNotify: false });

    const on = await handleApiRequest(req({ method: 'GET', path: '/health' }), {
      env: { ...envFor(mock), WEBHOOK_WORKTIME_ID: 'wid', WEBHOOK_WORKTIME_TOKEN: 'wtok' },
      fetchImpl: mock.fetchImpl,
    });
    expect(on.body).toMatchObject({ discordNotify: true });
    // 값은 절대 새어 나가면 안 된다
    expect(JSON.stringify(on.body)).not.toContain('wtok');
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

  it('접근 키 앞뒤 공백은 무시한다 (대시보드 붙여넣기 사고 방지)', async () => {
    const mock = realisticMock();
    // 환경변수 쪽에 줄바꿈이 딸려 들어간 상황
    const env = envFor(mock, { APP_ACCESS_KEY: 's3cret\n' });

    const ok = await handleApiRequest(
      req({ method: 'GET', path: '/notion-schema', headers: { 'x-app-key': 's3cret' } }),
      { env, fetchImpl: mock.fetchImpl },
    );
    expect(ok.status).toBe(200);

    // 그래도 값이 다르면 여전히 막아야 한다
    const denied = await handleApiRequest(
      req({ method: 'GET', path: '/notion-schema', headers: { 'x-app-key': 'wrong' } }),
      { env, fetchImpl: mock.fetchImpl },
    );
    expect(denied.status).toBe(401);
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

describe('업무 리스트 쓰기 규칙', () => {
  const withTodos = (todoText: string | null): DayRecordPayload => ({ ...RECORD, todoText });

  it('체크리스트 텍스트를 매핑된 텍스트 칸에 쓴다', async () => {
    const mock = realisticMock();
    mock.properties['업무 리스트'] = { id: 'p13', type: 'rich_text' };
    const schema = await fetchDatabaseSchema(makeClient(mock), DB_ID);

    const { properties } = buildProperties(
      schema,
      { date: '근무 일자', todos: '업무 리스트' },
      withTodos('☑ 한 일\n☐ 남은 일'),
    );

    expect(properties['업무 리스트']).toEqual({
      rich_text: [{ type: 'text', text: { content: '☑ 한 일\n☐ 남은 일' } }],
    });
  });

  it('목록을 비우면 그 칸을 지운다', async () => {
    const mock = realisticMock();
    mock.properties['업무 리스트'] = { id: 'p13', type: 'rich_text' };
    const schema = await fetchDatabaseSchema(makeClient(mock), DB_ID);

    const { properties } = buildProperties(
      schema,
      { date: '근무 일자', todos: '업무 리스트' },
      withTodos(''),
    );

    expect(properties['업무 리스트']).toEqual({ rich_text: [] });
  });

  it('목록을 모르는 기기가 보내면 그 칸을 건드리지 않는다', async () => {
    const mock = realisticMock();
    mock.properties['업무 리스트'] = { id: 'p13', type: 'rich_text' };
    const schema = await fetchDatabaseSchema(makeClient(mock), DB_ID);

    const { properties, skipped } = buildProperties(
      schema,
      { date: '근무 일자', todos: '업무 리스트' },
      withTodos(null),
    );

    expect(properties['업무 리스트']).toBeUndefined();
    expect(skipped.some((s) => s.field === 'todos')).toBe(true);
  });

  it('제목 칸에 매핑돼도 제목을 덮어쓰지 않는다', async () => {
    // 텍스트 칸만 후보로 내주지만, 낡은 설정이 남아 있을 수 있다.
    const mock = realisticMock();
    const schema = await fetchDatabaseSchema(makeClient(mock), DB_ID);

    const { properties, skipped } = buildProperties(
      schema,
      { title: '기록명', todos: '기록명' },
      withTodos('☐ 무언가'),
    );

    expect(properties['기록명']).toEqual({
      title: [{ type: 'text', text: { content: '2026-08-10 근무기록' } }],
    });
    expect(skipped.some((s) => s.field === 'todos')).toBe(true);
  });
});

describe('특별 휴가 부여 API', () => {
  function grantMock() {
    return new NotionMock({
      databaseId: DB_ID,
      properties: {
        이름: { id: 'p1', type: 'title' },
        근무일: { id: 'p2', type: 'date' },
        구분: { id: 'p3', type: 'select', options: ['근무', '휴가', '특별부여'] },
        직원: { id: 'p4', type: 'select', options: ['하정언', '박진규'] },
        // 실제 DB 와 같은 함정: 앱이 쓰는 `근무상태` 가 따로 있어서 자동 매핑의
        // `상태` 는 이쪽에 붙는다. 부여를 구분 값으로 찾으면 영영 못 찾는다.
        근무상태: { id: 'p5', type: 'select', options: ['퇴근 완료', '근무 중'] },
      },
    });
  }

  const mapping = JSON.stringify({
    title: '이름',
    date: '근무일',
    status: '근무상태',
    employee: '직원',
  });

  it('부여하면 사유와 시간이 담긴 행이 생기고 전용 칸이 자동으로 만들어진다', async () => {
    const mock = grantMock();

    const res = await handleApiRequest(
      req({
        method: 'POST',
        path: '/notion/grants',
        body: {
          employee: '박진규',
          dateKey: '2026-08-13',
          hours: 16,
          reason: 'BIC 전시 참가',
          mapping: JSON.parse(mapping),
        },
      }),
      { env: envFor(mock), fetchImpl: mock.fetchImpl, sleep: async () => {} },
    );

    expect(res.status).toBe(200);
    expect(mock.properties['부여시간']?.type).toBe('number');
    expect(mock.properties['사유']?.type).toBe('rich_text');

    const page = mock.pages.at(-1)!;
    expect(page.properties['부여시간']).toEqual({ number: 16 });
    expect(page.properties['구분']).toEqual({ select: { name: '특별부여' } });
    // 앱이 근무 상태를 적는 칸은 건드리지 않는다
    expect(page.properties['근무상태']).toBeUndefined();
    expect(page.properties['직원']).toEqual({ select: { name: '박진규' } });
    expect(page.properties['근무일']).toEqual({ date: { start: '2026-08-13' } });
  });

  it('부여가 노션에 쓰인 뒤 디스코드 근무현황 채널로 알림이 나간다', async () => {
    const mock = grantMock();
    const sent: Array<{ url: string; body: any }> = [];

    const res = await handleApiRequest(
      req({
        method: 'POST',
        path: '/notion/grants',
        body: {
          employee: '박진규',
          dateKey: '2026-08-13',
          hours: 16,
          reason: 'BIC 전시 참가',
          grantedBy: '하정언',
          mapping: JSON.parse(mapping),
        },
      }),
      {
        env: {
          ...envFor(mock),
          WEBHOOK_WORKTIME_ID: 'wid',
          WEBHOOK_WORKTIME_TOKEN: 'wtok',
          DISCORD_USER_IDS: '하정언:996435919865401474,박진규:615060326127239171',
        },
        fetchImpl: mock.fetchImpl,
        discordFetch: async (url, init) => {
          sent.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
          return { ok: true, status: 200, text: async () => '' } as Response;
        },
        sleep: async () => {},
      },
    );

    expect(res.status).toBe(200);
    expect((res.body as { notice: unknown }).notice).toEqual({ sent: true });
    // 알림이 나갔다면 행은 이미 만들어져 있어야 한다 (순서가 뒤집히면 안 된다)
    expect(mock.pages.at(-1)!.properties['부여시간']).toEqual({ number: 16 });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.content).toContain('<@615060326127239171>');
    expect(sent[0]!.body.content).toContain('16시간');
    expect(sent[0]!.body.content).toContain('BIC 전시 참가');
  });

  it('웹훅이 없어도 부여는 성공한다 — 알림은 부가물이다', async () => {
    const mock = grantMock();
    const res = await handleApiRequest(
      req({
        method: 'POST',
        path: '/notion/grants',
        body: {
          employee: '박진규',
          dateKey: '2026-08-13',
          hours: 8,
          reason: '집안 사정',
          mapping: JSON.parse(mapping),
        },
      }),
      { env: envFor(mock), fetchImpl: mock.fetchImpl, sleep: async () => {} },
    );

    expect(res.status).toBe(200);
    expect((res.body as { notice: unknown }).notice).toEqual({
      sent: false,
      reason: 'not_configured',
    });
    expect(mock.pages.at(-1)!.properties['부여시간']).toEqual({ number: 8 });
  });

  it('디스코드가 죽어 있어도 부여는 되돌리지 않는다', async () => {
    const mock = grantMock();
    const res = await handleApiRequest(
      req({
        method: 'POST',
        path: '/notion/grants',
        body: {
          employee: '박진규',
          dateKey: '2026-08-13',
          hours: 8,
          reason: '집안 사정',
          mapping: JSON.parse(mapping),
        },
      }),
      {
        env: { ...envFor(mock), WEBHOOK_WORKTIME_ID: 'wid', WEBHOOK_WORKTIME_TOKEN: 'wtok' },
        fetchImpl: mock.fetchImpl,
        discordFetch: async () => {
          throw new Error('fetch failed');
        },
        sleep: async () => {},
      },
    );

    expect(res.status).toBe(200);
    expect((res.body as { notice: { sent: boolean } }).notice.sent).toBe(false);
    expect(mock.pages.at(-1)!.properties['부여시간']).toEqual({ number: 8 });
  });

  it('사유가 없으면 거부한다 — 나중에 근거를 확인할 수 없기 때문', async () => {
    const mock = grantMock();
    const res = await handleApiRequest(
      req({
        method: 'POST',
        path: '/notion/grants',
        body: { employee: '박진규', dateKey: '2026-08-13', hours: 8, reason: '   ' },
      }),
      { env: envFor(mock), fetchImpl: mock.fetchImpl, sleep: async () => {} },
    );
    expect(res.status).toBe(400);
  });

  it('0 이하 시간은 거부한다', async () => {
    const mock = grantMock();
    const res = await handleApiRequest(
      req({
        method: 'POST',
        path: '/notion/grants',
        body: { employee: '박진규', dateKey: '2026-08-13', hours: 0, reason: '전시' },
      }),
      { env: envFor(mock), fetchImpl: mock.fetchImpl, sleep: async () => {} },
    );
    expect(res.status).toBe(400);
  });

  it('부여를 읽어 오고, 그 사람 것만 돌려준다', async () => {
    const mock = grantMock();
    const deps = { env: envFor(mock), fetchImpl: mock.fetchImpl, sleep: async () => {} };

    for (const [employee, hours, reason] of [
      ['박진규', 16, 'BIC 전시 참가'],
      ['하정언', 4, '집안 사정'],
    ] as const) {
      await handleApiRequest(
        req({
          method: 'POST',
          path: '/notion/grants',
          body: { employee, dateKey: '2026-08-13', hours, reason, mapping: JSON.parse(mapping) },
        }),
        deps,
      );
    }

    const res = await handleApiRequest(
      req({ method: 'GET', path: '/notion/grants', query: { employee: '박진규', mapping } }),
      deps,
    );

    expect(res.status).toBe(200);
    const body = res.body as { grants: Array<{ ms: number; reason: string; dateKey: string }> };
    expect(body.grants).toHaveLength(1);
    expect(body.grants[0]!.ms).toBe(16 * 3600000);
    expect(body.grants[0]!.reason).toBe('BIC 전시 참가');
    expect(body.grants[0]!.dateKey).toBe('2026-08-13');
  });

  it('상태 매핑이 부여와 무관한 칸을 가리켜도 읽어 온다 (실제 DB 구조)', async () => {
    const mock = grantMock();
    const deps = { env: envFor(mock), fetchImpl: mock.fetchImpl, sleep: async () => {} };

    await handleApiRequest(
      req({
        method: 'POST',
        path: '/notion/grants',
        body: {
          employee: '박진규',
          dateKey: '2026-08-13',
          hours: 16,
          reason: 'BIC 전시 참가',
          mapping: JSON.parse(mapping),
        },
      }),
      deps,
    );

    const res = await handleApiRequest(
      req({ method: 'GET', path: '/notion/grants', query: { employee: '박진규', mapping } }),
      deps,
    );
    expect((res.body as { grants: unknown[] }).grants).toHaveLength(1);
  });

  it('근무 기록 행은 부여로 읽히지 않는다', async () => {
    const mock = grantMock();
    const deps = { env: envFor(mock), fetchImpl: mock.fetchImpl, sleep: async () => {} };

    // 평범한 근무 기록 행 하나
    mock.pages.push({
      id: 'work1',
      properties: {
        이름: { title: [{ text: { content: '2026-08-13 박진규 근무기록' } }] },
        구분: { select: { name: '근무' } },
        직원: { select: { name: '박진규' } },
        근무일: { date: { start: '2026-08-13' } },
      },
    } as any);

    const res = await handleApiRequest(
      req({ method: 'GET', path: '/notion/grants', query: { employee: '박진규', mapping } }),
      deps,
    );

    expect((res.body as { grants: unknown[] }).grants).toHaveLength(0);
  });

  it('쓰기가 꺼져 있으면 부여하지 못한다', async () => {
    const mock = grantMock();
    const res = await handleApiRequest(
      req({
        method: 'POST',
        path: '/notion/grants',
        body: { employee: '박진규', dateKey: '2026-08-13', hours: 8, reason: '전시' },
      }),
      {
        env: envFor(mock, { NOTION_ALLOW_WRITE: '0' }),
        fetchImpl: mock.fetchImpl,
        sleep: async () => {},
      },
    );
    expect(res.status).toBe(403);
  });
});

describe('기간 조회 (/notion/days)', () => {
  it('from/to 가 날짜 형식이 아니면 거절한다', async () => {
    const mock = realisticMock();
    const res = await handleApiRequest(
      {
        method: 'GET',
        path: '/notion-days',
        query: { from: '2026-08', to: '2026-08-31' },
        headers: {},
        body: {},
      },
      { env: envFor(mock), fetchImpl: mock.fetchImpl, sleep: async () => {} },
    );
    expect(res.status).toBe(400);
  });

  it('시작이 끝보다 뒤면 거절한다', async () => {
    const mock = realisticMock();
    const res = await handleApiRequest(
      {
        method: 'GET',
        path: '/notion-days',
        query: { from: '2026-08-31', to: '2026-08-01' },
        headers: {},
        body: {},
      },
      { env: envFor(mock), fetchImpl: mock.fetchImpl, sleep: async () => {} },
    );
    expect(res.status).toBe(400);
  });

  it('앱이 만들지 않은 행은 읽지 않는다', async () => {
    const mock = realisticMock();
    // 사람이 손으로 만든 행 — 제목이 소유권 표식과 다르다
    await mock.fetchImpl('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${mock.token}` },
      body: JSON.stringify({
        parent: { database_id: DB_ID },
        properties: {
          기록명: { title: [{ text: { content: '8월 정산 메모' } }] },
          '근무 일자': { date: { start: '2026-08-06' } },
        },
      }),
    });

    expect(mock.pages).toHaveLength(1);

    const res = await handleApiRequest(
      {
        method: 'GET',
        path: '/notion-days',
        query: { from: '2026-08-01', to: '2026-08-31' },
        headers: {},
        body: {},
      },
      { env: envFor(mock), fetchImpl: mock.fetchImpl, sleep: async () => {} },
    );

    expect(res.status).toBe(200);
    expect((res.body as any).days).toHaveLength(0);
  });
});
