import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotionMock } from '../../tests/mocks/notionMock';
import { handleApiRequest, type ServerEnv } from '../../api/_router';
import { AppStore } from './store';
import { computeDay } from './events';
import { memoryStore } from './storage.test';
import { HOUR_MS, dateKeyToEpoch } from './time';
import type { KeyValueStore } from './storage';

const DB_ID = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';
const DAY = '2026-08-10';
const t = (hour: number, dateKey = DAY) => dateKeyToEpoch(dateKey) + hour * HOUR_MS;

function makeMock() {
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
      '상태': { id: 'p9', type: 'select', options: [] },
    },
  });
}

/** 브라우저의 fetch('/api/...') 를 실제 라우터 + 모의 Notion 으로 연결한다. */
function installBackend(mock: NotionMock, env: Partial<ServerEnv> = {}) {
  const serverEnv: ServerEnv = {
    NOTION_TOKEN: mock.token,
    NOTION_DATABASE_ID: mock.databaseId,
    NOTION_ALLOW_WRITE: '1',
    ...env,
  };

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const res = await handleApiRequest(
      {
        method: init?.method ?? 'GET',
        path: url.pathname.replace(/^\/api/, ''),
        query: Object.fromEntries(url.searchParams),
        headers,
        body: init?.body ? JSON.parse(String(init.body)) : {},
      },
      { env: serverEnv, fetchImpl: mock.fetchImpl, sleep: async () => {} },
    );
    return new Response(res.body === null ? null : JSON.stringify(res.body), {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

/** 백엔드가 없는 정적 배포 상황 (index.html 이 돌아온다) */
function installNoBackend() {
  const calls = { count: 0 };
  vi.stubGlobal('fetch', async () => {
    calls.count += 1;
    return new Response('<!doctype html><html></html>', { status: 200 });
  });
  return calls;
}

/** 백엔드는 배포됐지만 함수가 크래시한 상황 (플랫폼이 HTML 오류 페이지를 준다) */
function installCrashedBackend() {
  vi.stubGlobal('fetch', async () => {
    return new Response(
      '<!doctype html><html><body>A server error has occurred\nFUNCTION_INVOCATION_FAILED</body></html>',
      { status: 500 },
    );
  });
}

async function makeReadyStore(_mock: NotionMock, kv?: KeyValueStore) {
  let clock = t(9);
  const store = new AppStore(() => clock, kv ?? memoryStore());
  store.updateNotionSettings({ autoSync: false });
  await store.checkBackend();
  await store.refreshSchema();
  return {
    store,
    setClock: (hour: number, dateKey = DAY) => {
      clock = t(hour, dateKey);
    },
    setClockRaw: (ms: number) => {
      clock = ms;
    },
  };
}

let mock: NotionMock;

beforeEach(() => {
  mock = makeMock();
  installBackend(mock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('출퇴근 흐름', () => {
  it('출근 → 자리비움 → 복귀 → 퇴근이 순서대로 기록된다', async () => {
    const { store, setClock } = await makeReadyStore(mock);

    setClock(9);
    expect(store.perform('clock_in')).toBe(true);
    setClock(12);
    expect(store.perform('away_start')).toBe(true);
    setClock(13);
    expect(store.perform('away_end')).toBe(true);
    setClock(18);
    expect(store.perform('clock_out')).toBe(true);

    const totals = computeDay(store.logFor(DAY), t(20));
    expect(totals.actualMs).toBe(8 * HOUR_MS);
    expect(totals.awayMs).toBe(1 * HOUR_MS);
    expect(totals.status).toBe('finished');
  });

  it('허용되지 않는 동작은 거부하고 오류 알림을 남긴다', async () => {
    const { store } = await makeReadyStore(mock);
    expect(store.perform('clock_out')).toBe(false);
    expect(store.getSnapshot().runtime.notice?.kind).toBe('error');
    expect(store.logFor(DAY).events).toHaveLength(0);
  });

  it('퇴근하면 해당 날짜가 동기화 대기열에 들어간다', async () => {
    const { store, setClock } = await makeReadyStore(mock);
    store.perform('clock_in');
    setClock(18);
    store.perform('clock_out');
    expect(Object.keys(store.getSnapshot().state.outbox)).toEqual([DAY]);
  });
});

describe('Notion 동기화', () => {
  it('퇴근 후 동기화하면 Notion 에 행이 생긴다', async () => {
    const { store, setClock } = await makeReadyStore(mock);
    store.perform('clock_in');
    setClock(18);
    store.perform('clock_out');

    await store.drainOutbox();

    expect(mock.pages).toHaveLength(1);
    const row = mock.read(mock.pages[0]!.id);
    expect(row['근무 일자']).toBe(DAY);
    expect(row['출근 시각']).toBe('09:00');
    expect(row['퇴근 시각']).toBe('18:00');
    expect(row['실 근무시간']).toBe(9);
    expect(row['상태']).toBe('퇴근 완료');
    expect(store.getSnapshot().state.outbox).toEqual({});
  });

  it('같은 날짜를 여러 번 동기화해도 행은 하나다', async () => {
    const { store, setClock } = await makeReadyStore(mock);
    store.perform('clock_in');
    setClock(18);
    store.perform('clock_out');

    await store.drainOutbox();
    store.enqueue(DAY);
    await store.drainOutbox();
    store.enqueue(DAY);
    await store.drainOutbox();

    expect(mock.pages).toHaveLength(1);
  });

  it('동기화 성공 시 pageId 를 기억해 다음부터는 조회를 생략한다', async () => {
    const { store, setClock } = await makeReadyStore(mock);
    store.perform('clock_in');
    setClock(18);
    store.perform('clock_out');
    await store.drainOutbox();

    expect(store.getSnapshot().state.notion.pageIds[DAY]).toBe(mock.pages[0]!.id);

    mock.calls = [];
    store.enqueue(DAY);
    await store.drainOutbox();
    expect(mock.calls.some((c) => c.path.endsWith('/query'))).toBe(false);
  });

  it('전송 직전에 최신 값으로 페이로드를 만든다 (낡은 값 덮어쓰기 방지)', async () => {
    const { store, setClock } = await makeReadyStore(mock);
    store.perform('clock_in');
    setClock(18);
    store.perform('clock_out');

    // 대기열에 들어간 뒤 휴가를 추가로 사용
    store.changeVacation(DAY, 1 * HOUR_MS);
    await store.drainOutbox();

    const row = mock.read(mock.pages[0]!.id);
    expect(row['휴가']).toBe(1);
    expect(row['인정 근무시간']).toBe(10); // 9h 근무 + 1h 휴가
  });

  it('자동 동기화가 켜져 있으면 퇴근 시 저절로 기록된다', async () => {
    const { store, setClock } = await makeReadyStore(mock);
    store.updateNotionSettings({ autoSync: true });

    store.perform('clock_in');
    setClock(18);
    store.perform('clock_out');

    await vi.waitFor(() => expect(mock.pages).toHaveLength(1));
    expect(store.getSnapshot().state.outbox).toEqual({});
  });
});

describe('동기화 실패 시 데이터 안전성', () => {
  it('Notion 오류가 나도 근무 기록은 사라지지 않고 대기열에 남는다', async () => {
    const { store, setClock } = await makeReadyStore(mock);
    store.perform('clock_in');
    setClock(18);
    store.perform('clock_out');

    mock.failures = [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }];
    await store.drainOutbox();

    // 로컬 기록 온전
    expect(computeDay(store.logFor(DAY), t(20)).actualMs).toBe(9 * HOUR_MS);
    // 대기열에 실패가 기록됨
    const entry = store.getSnapshot().state.outbox[DAY];
    expect(entry?.attempts).toBe(1);
    expect(entry?.lastError).toBeTruthy();
    expect(entry?.nextAttemptAt).toBeGreaterThan(0);
    expect(mock.pages).toHaveLength(0);
  });

  it('재시도가 성공하면 대기열이 비워진다', async () => {
    const { store, setClock } = await makeReadyStore(mock);
    store.perform('clock_in');
    setClock(18);
    store.perform('clock_out');

    mock.failures = [{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }];
    await store.drainOutbox();
    expect(store.getSnapshot().state.outbox[DAY]?.attempts).toBe(1);

    mock.failures = [];
    await store.drainOutbox({ force: true });

    expect(store.getSnapshot().state.outbox).toEqual({});
    expect(mock.pages).toHaveLength(1);
  });

  it('백오프 시간 전에는 자동 재시도하지 않지만 수동 강제는 가능하다', async () => {
    const { store, setClock } = await makeReadyStore(mock);
    store.perform('clock_in');
    setClock(18);
    store.perform('clock_out');

    mock.failures = [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }];
    await store.drainOutbox();
    mock.failures = [];

    mock.calls = [];
    await store.drainOutbox(); // 백오프 대기 중 -> 아무것도 보내지 않음
    expect(mock.pages).toHaveLength(0);

    await store.drainOutbox({ force: true });
    expect(mock.pages).toHaveLength(1);
  });

  it('백엔드가 없어도 근무 기록은 정상 동작한다 (정적 배포)', async () => {
    installNoBackend();
    let clock = t(9);
    const store = new AppStore(() => clock, memoryStore());

    await store.checkBackend();
    expect(store.getSnapshot().runtime.backend).toBe('unavailable');

    store.perform('clock_in');
    clock = t(18);
    store.perform('clock_out');

    expect(computeDay(store.logFor(DAY), t(19)).actualMs).toBe(9 * HOUR_MS);
    expect(store.getSnapshot().state.outbox[DAY]).toBeDefined();
  });

  it('함수 크래시(5xx HTML)를 "정적 배포"로 오진하지 않는다', async () => {
    // 백엔드가 없는 것과 백엔드가 죽은 것은 다르다. 둘 다 JSON 이 아닌 HTML 이
    // 돌아오므로, 상태 코드로 구분하지 않으면 사용자가 배포 자체를 의심하게 된다.
    installCrashedBackend();
    const store = new AppStore(() => t(9), memoryStore());

    await store.checkBackend();

    const { runtime } = store.getSnapshot();
    expect(runtime.backend).toBe('error');
    expect(runtime.backendError).toContain('500');
    expect(runtime.backendError).toContain('FUNCTION_INVOCATION_FAILED');
    expect(runtime.backendError).not.toContain('정적 배포');
  });

  it('백엔드가 없다고 확인되면 자동 재확인을 반복하지 않는다', async () => {
    // Notion 을 연결하지 않고 타이머만 쓰는 사용자에게 매분 실패하는 요청이
    // 무한히 나가면 안 된다.
    const calls = installNoBackend();
    let clock = t(9);
    const store = new AppStore(() => clock, memoryStore());
    store.updateNotionSettings({ autoSync: false });

    await store.checkBackend();
    expect(store.getSnapshot().runtime.backend).toBe('unavailable');
    expect(calls.count).toBe(1);

    store.perform('clock_in');
    clock = t(18);
    store.perform('clock_out');
    expect(store.getSnapshot().state.outbox[DAY]).toBeDefined();

    // 주기적 드레인(App 의 60초 타이머)이 여러 번 돌아도 요청이 늘지 않는다.
    // 첫 호출은 재확인 간격(10분)이 지났으므로 1회만 확인한다.
    clock = t(18);
    for (let i = 0; i < 6; i++) await store.drainOutbox();
    expect(calls.count).toBe(2);

    // 사용자가 직접 "연결 확인"을 누르면 간격과 무관하게 즉시 확인한다
    await store.checkBackend({ force: true });
    expect(calls.count).toBe(3);

    // 재확인 간격이 지나면 자동 확인도 다시 한 번 일어난다
    clock = t(18) + 11 * 60 * 1000;
    await store.drainOutbox();
    await store.drainOutbox();
    expect(calls.count).toBe(4);
  });

  it('매핑이 없으면 전송을 시도하지 않고 안내한다', async () => {
    let clock = t(9);
    const store = new AppStore(() => clock, memoryStore());
    store.updateNotionSettings({ autoSync: false });
    await store.checkBackend();

    store.perform('clock_in');
    clock = t(18);
    store.perform('clock_out');

    await store.drainOutbox({ force: true });

    expect(mock.pages).toHaveLength(0);
    expect(store.getSnapshot().runtime.notice?.text).toContain('매핑');
    expect(store.getSnapshot().state.outbox[DAY]).toBeDefined();
  });

  it('접근 키가 틀리면 401 로 실패하고 기록은 보존된다', async () => {
    installBackend(mock, { APP_ACCESS_KEY: 'right-key' });
    let clock = t(9);
    const store = new AppStore(() => clock, memoryStore());
    store.updateNotionSettings({ autoSync: false, accessKey: 'wrong-key' });

    await store.checkBackend();
    await store.refreshSchema();

    store.perform('clock_in');
    clock = t(18);
    store.perform('clock_out');
    await store.drainOutbox({ force: true });

    expect(mock.pages).toHaveLength(0);
    expect(computeDay(store.logFor(DAY), t(19)).actualMs).toBe(9 * HOUR_MS);
  });
});

describe('휴가 연동', () => {
  it('휴가 사용은 잔여를 넘지 못하고 Notion 에도 반영된다', async () => {
    const { store } = await makeReadyStore(mock);
    store.updateVacationConfig({ grantStartMonth: '2026-08' });

    expect(store.changeVacation(DAY, 4 * HOUR_MS)).toBe(true);
    expect(store.changeVacation(DAY, 8 * HOUR_MS)).toBe(false); // 하루 상한 초과

    await store.drainOutbox();
    expect(mock.read(mock.pages[0]!.id)['휴가']).toBe(4);
  });

  it('휴가를 취소하면 Notion 값도 함께 줄어든다', async () => {
    const { store } = await makeReadyStore(mock);
    store.updateVacationConfig({ grantStartMonth: '2026-08' });

    store.changeVacation(DAY, 4 * HOUR_MS);
    await store.drainOutbox();
    expect(mock.read(mock.pages[0]!.id)['휴가']).toBe(4);

    store.changeVacation(DAY, -3 * HOUR_MS);
    await store.drainOutbox();

    expect(mock.pages).toHaveLength(1);
    expect(mock.read(mock.pages[0]!.id)['휴가']).toBe(1);
  });
});

describe('새로고침 / 재시작 복구', () => {
  it('새 인스턴스가 진행 중인 근무 상태와 경과시간을 복원한다', async () => {
    const kv = memoryStore();
    let clock = t(9);
    const first = new AppStore(() => clock, kv);
    first.updateNotionSettings({ autoSync: false });
    first.perform('clock_in');
    clock = t(12);
    first.perform('away_start');

    // "새로고침" — 같은 저장소로 새 인스턴스
    const second = new AppStore(() => t(14), kv);
    const totals = computeDay(second.logFor(DAY), t(14));

    expect(totals.status).toBe('away');
    expect(totals.actualMs).toBe(3 * HOUR_MS);
    expect(totals.awayMs).toBe(2 * HOUR_MS);
    expect(second.activeDate).toBe(DAY);
  });

  it('대기 중인 동기화 항목도 재시작 후 유지된다', async () => {
    const kv = memoryStore();
    const { store, setClock } = await makeReadyStore(mock, kv);
    store.perform('clock_in');
    setClock(18);
    store.perform('clock_out');

    mock.failures = [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }];
    await store.drainOutbox();

    const revived = new AppStore(() => t(19), kv);
    expect(revived.getSnapshot().state.outbox[DAY]?.attempts).toBe(1);
    expect(revived.getSnapshot().state.notion.mapping.date).toBe('근무 일자');

    mock.failures = [];
    await revived.drainOutbox({ force: true });
    expect(mock.pages).toHaveLength(1);
  });

  it('내보내기/가져오기로 데이터를 옮길 수 있다', async () => {
    const { store, setClock } = await makeReadyStore(mock);
    store.perform('clock_in');
    setClock(18);
    store.perform('clock_out');

    const json = store.exportJson();
    const fresh = new AppStore(() => t(19), memoryStore());
    expect(fresh.importJson(json)).toBe(true);
    expect(computeDay(fresh.logFor(DAY), t(19)).actualMs).toBe(9 * HOUR_MS);
  });

  it('잘못된 JSON 가져오기는 기존 데이터를 훼손하지 않는다', async () => {
    const { store, setClock } = await makeReadyStore(mock);
    store.perform('clock_in');
    setClock(18);
    store.perform('clock_out');

    expect(store.importJson('{{{망가진')).toBe(false);
    expect(computeDay(store.logFor(DAY), t(19)).actualMs).toBe(9 * HOUR_MS);
  });
});

describe('자정을 넘긴 근무', () => {
  it('다음 날 새벽에 퇴근해도 출근한 날짜에 기록된다', async () => {
    const { store, setClockRaw } = await makeReadyStore(mock);

    setClockRaw(t(22));
    store.perform('clock_in');
    setClockRaw(t(2, '2026-08-11'));
    expect(store.activeDate).toBe(DAY);
    store.perform('clock_out');

    await store.drainOutbox();

    expect(mock.pages).toHaveLength(1);
    const row = mock.read(mock.pages[0]!.id);
    expect(row['근무 일자']).toBe(DAY);
    expect(row['실 근무시간']).toBe(4);
    expect(row['퇴근 시각']).toBe('02:00');
  });
});

describe('여러 직원이 같은 DB 를 쓸 때', () => {
  /** 직원 Property 가 있는 DB */
  function makeTeamMock() {
    return new NotionMock({
      databaseId: DB_ID,
      title: '근무 기록',
      properties: {
        '기록명': { id: 'p1', type: 'title' },
        '근무 일자': { id: 'p2', type: 'date' },
        '출근 시각': { id: 'p3', type: 'rich_text' },
        '퇴근 시각': { id: 'p4', type: 'rich_text' },
        '실 근무시간': { id: 'p5', type: 'number' },
        '직원': { id: 'p6', type: 'select', options: ['정어리', '박진규'] },
      },
    });
  }

  it('직원을 고르지 않으면 동기화를 멈추고 이유를 알려 준다', async () => {
    const team = makeTeamMock();
    installBackend(team);
    const { store, setClock } = await makeReadyStore(team);

    store.perform('clock_in');
    setClock(18);
    store.perform('clock_out');
    await store.drainOutbox();

    expect(team.pages).toHaveLength(0);
    expect(store.getSnapshot().runtime.syncBlocked).toContain('직원');
    // 기록은 그대로 대기열에 남아 있다 — 나중에 직원을 정하면 그대로 올라간다
    expect(Object.keys(store.getSnapshot().state.outbox)).toEqual([DAY]);
  });

  it('직원을 정하면 그 사람 이름으로 기록된다', async () => {
    const team = makeTeamMock();
    installBackend(team);
    const { store, setClock } = await makeReadyStore(team);
    store.setEmployeeName('정어리');

    store.perform('clock_in');
    setClock(18);
    store.perform('clock_out');
    await store.drainOutbox();

    expect(team.pages).toHaveLength(1);
    expect(team.read(team.pages[0]!.id)['직원']).toBe('정어리');
    expect(store.getSnapshot().state.lastSync?.employeeName).toBe('정어리');
  });

  it('두 사람이 같은 날 일해도 서로의 행을 덮어쓰지 않는다', async () => {
    const team = makeTeamMock();
    installBackend(team);

    const a = await makeReadyStore(team);
    a.store.setEmployeeName('정어리');
    a.store.perform('clock_in');
    a.setClock(18);
    a.store.perform('clock_out');
    await a.store.drainOutbox();

    const b = await makeReadyStore(team);
    b.store.setEmployeeName('박진규');
    b.store.perform('clock_in');
    b.setClock(14);
    b.store.perform('clock_out');
    await b.store.drainOutbox();

    expect(team.pages).toHaveLength(2);
    const rows = team.pages.map((p) => team.read(p.id));
    expect(rows.find((r) => r['직원'] === '정어리')?.['실 근무시간']).toBe(9);
    expect(rows.find((r) => r['직원'] === '박진규')?.['실 근무시간']).toBe(5);
  });

  it('직원을 바꾸면 이전 사람의 행을 더 이상 갱신하지 않는다', async () => {
    const team = makeTeamMock();
    installBackend(team);
    const { store, setClock } = await makeReadyStore(team);

    store.setEmployeeName('정어리');
    store.perform('clock_in');
    setClock(18);
    store.perform('clock_out');
    await store.drainOutbox();
    const firstPageId = team.pages[0]!.id;

    store.setEmployeeName('박진규');
    expect(store.getSnapshot().state.notion.pageIds).toEqual({});

    store.enqueue(DAY);
    await store.drainOutbox({ force: true });

    expect(team.pages).toHaveLength(2);
    expect(team.read(firstPageId)['직원']).toBe('정어리');
  });
});

describe('사용자가 손으로 만든 행 보호', () => {
  it('같은 날짜의 수동 행이 있어도 덮어쓰지 않고 새 행을 만든다', async () => {
    const { store, setClock } = await makeReadyStore(mock);

    // Notion 에 사람이 직접 적어 둔 "반차" 행
    mock.pages.push({
      id: 'dddd0000000000000000000000000001',
      created_time: new Date(1_600_000_000_000).toISOString(),
      archived: false,
      properties: {
        '기록명': { title: [{ type: 'text', text: { content: '반차' } }] },
        '근무 일자': { date: { start: DAY } },
      },
      url: 'https://notion.so/manual',
    });

    store.perform('clock_in');
    setClock(18);
    store.perform('clock_out');
    await store.drainOutbox();

    expect(mock.pages).toHaveLength(2);
    expect(mock.read('dddd0000000000000000000000000001')['기록명']).toBe('반차');
    expect(store.getSnapshot().state.lastSync?.warning).toContain('건드리지 않았습니다');
  });
});

describe('상태가 바뀔 때마다 Notion 에 반영', () => {
  it('출근만 해도 Notion 에 행이 생긴다', async () => {
    const { store } = await makeReadyStore(mock);
    store.perform('clock_in');
    await store.drainOutbox();

    expect(mock.pages).toHaveLength(1);
    expect(mock.read(mock.pages[0]!.id)['상태']).toBe('근무 중');
  });

  it('자리 비움 · 복귀 · 퇴근을 거쳐도 행은 하나로 유지된다', async () => {
    const { store, setClock } = await makeReadyStore(mock);

    store.perform('clock_in');
    await store.drainOutbox();
    setClock(12);
    store.perform('away_start');
    await store.drainOutbox();
    expect(mock.read(mock.pages[0]!.id)['상태']).toBe('자리 비움');

    setClock(13);
    store.perform('away_end');
    await store.drainOutbox();
    setClock(18);
    store.perform('clock_out');
    await store.drainOutbox();

    expect(mock.pages).toHaveLength(1);
    const row = mock.read(mock.pages[0]!.id);
    expect(row['상태']).toBe('퇴근 완료');
    expect(row['실 근무시간']).toBe(8);
  });

  it('퇴근을 취소하고 복귀하면 Notion 도 다시 근무 중으로 바뀐다', async () => {
    const { store, setClock } = await makeReadyStore(mock);

    store.perform('clock_in');
    setClock(12);
    store.perform('clock_out');
    await store.drainOutbox();
    expect(mock.read(mock.pages[0]!.id)['상태']).toBe('퇴근 완료');

    setClock(13);
    expect(store.perform('resume')).toBe(true);
    await store.drainOutbox();

    const row = mock.read(mock.pages[0]!.id);
    expect(row['상태']).toBe('근무 중');
    expect(row['퇴근 시각']).toBe('-');
    expect(mock.pages).toHaveLength(1);
  });
});

describe('업그레이드 시 매핑 보정', () => {
  it('저장된 매핑에 직원 칸이 없으면 캐시된 스키마로 채운다', async () => {
    const team = new NotionMock({
      databaseId: DB_ID,
      title: '근무 기록',
      properties: {
        '기록명': { id: 'p1', type: 'title' },
        '근무 일자': { id: 'p2', type: 'date' },
        '직원': { id: 'p3', type: 'select', options: ['정어리', '박진규'] },
      },
    });
    installBackend(team);

    // 직원 개념이 없던 시절에 저장된 상태
    const kv = memoryStore();
    const first = await makeReadyStore(team, kv);
    first.store.setMappingField('employee', null);
    expect(first.store.getSnapshot().state.notion.mapping.employee).toBeUndefined();

    // 새 버전이 배포돼 앱을 다시 연 상황 — 네트워크 없이도 빈 칸이 채워진다
    const revived = new AppStore(() => t(9), kv);
    expect(revived.getSnapshot().state.notion.mapping.employee).toBe('직원');
    // 사용자가 고른 값은 그대로 둔다
    expect(revived.getSnapshot().state.notion.mapping.date).toBe('근무 일자');
  });

  it('사용자가 고른 매핑은 덮어쓰지 않는다', async () => {
    const kv = memoryStore();
    const { store } = await makeReadyStore(mock, kv);
    store.setMappingField('status', '기록명');

    const revived = new AppStore(() => t(9), kv);
    expect(revived.getSnapshot().state.notion.mapping.status).toBe('기록명');
  });
});

describe('여러 탭을 열어 뒀을 때', () => {
  it('낡은 탭이 저장해도 최신 기록을 덮어쓰지 않는다', async () => {
    const kv = memoryStore();

    // 낡은 탭: 출근만 한 상태에서 페이지를 열어 둔 채 방치
    const stale = await makeReadyStore(mock, kv);
    stale.store.perform('clock_in');

    // 새 탭: 같은 브라우저에서 앱을 다시 열고 하루를 마무리
    const fresh = new AppStore(() => t(18), kv);
    fresh.perform('away_start');
    fresh.perform('away_end');
    fresh.perform('clock_out');
    const finished = computeDay(fresh.logFor(DAY), t(19));
    expect(finished.status).toBe('finished');

    // 낡은 탭에서 아무 설정이나 건드리면(입력창 blur 등) 저장이 일어난다
    stale.store.updateNotionSettings({ apiBase: 'https://example.com' });

    // 그래도 퇴근 기록은 살아 있어야 한다
    const after = new AppStore(() => t(19), kv);
    expect(computeDay(after.logFor(DAY), t(19)).status).toBe('finished');
    expect(after.getSnapshot().state.notion.apiBase).toBe('https://example.com');
  });

  it('낡은 탭이 저장해도 매핑과 pageId 가 사라지지 않는다', async () => {
    const kv = memoryStore();
    const stale = await makeReadyStore(mock, kv);

    const fresh = new AppStore(() => t(18), kv);
    fresh.setMappingField('status', '상태');
    fresh.perform('clock_in');

    stale.store.updateNotionSettings({ accessKey: 'k' });

    const after = new AppStore(() => t(19), kv);
    expect(after.getSnapshot().state.notion.mapping.status).toBe('상태');
    expect(after.logFor(DAY).events).toHaveLength(1);
  });
});

describe('데스크탑 ↔ 노트북 연동', () => {
  /** 직원 + 기기 연동 로그까지 갖춘 DB */
  function makeLinkedMock() {
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
        '상태': { id: 'p7', type: 'select', options: [] },
        '직원': { id: 'p8', type: 'select', options: ['정어리', '박진규'] },
        '이벤트로그': { id: 'p9', type: 'rich_text' },
      },
    });
  }

  /** 서로 다른 브라우저 = 서로 다른 저장소 */
  async function device(m: NotionMock, hour: number) {
    const d = await makeReadyStore(m, memoryStore());
    d.store.setEmployeeName('정어리');
    d.setClock(hour);
    return d;
  }

  it('데스크탑에서 출근하고 노트북에서 퇴근할 수 있다', async () => {
    const m = makeLinkedMock();
    installBackend(m);

    const desktop = await device(m, 9);
    desktop.store.perform('clock_in');
    await desktop.store.drainOutbox();

    // 노트북을 연다 — 아직 이 기기에는 아무 기록도 없다
    const laptop = await device(m, 18);
    expect(laptop.store.logFor(DAY).events).toHaveLength(0);

    await laptop.store.pullDay(DAY);

    // 데스크탑의 출근을 넘겨받아 "근무 중" 이 된다
    expect(computeDay(laptop.store.logFor(DAY), t(18)).status).toBe('working');
    expect(laptop.store.perform('clock_out')).toBe(true);
    await laptop.store.drainOutbox();

    expect(m.pages).toHaveLength(1);
    const row = m.read(m.pages[0]!.id);
    expect(row['출근 시각']).toBe('09:00');
    expect(row['퇴근 시각']).toBe('18:00');
    expect(row['실 근무시간']).toBe(9);
  });

  it('노트북이 먼저 출근을 눌러도 데스크탑 기록을 덮어쓰지 않는다', async () => {
    const m = makeLinkedMock();
    installBackend(m);

    const desktop = await device(m, 9);
    desktop.store.perform('clock_in');
    await desktop.store.drainOutbox();

    // 연동 전 상태의 노트북이 그냥 출근을 눌러 버린 경우
    const laptop = await device(m, 13);
    laptop.store.perform('clock_in');
    await laptop.store.drainOutbox();

    // 서버가 두 이벤트를 합치므로 이른 출근(09:00)이 살아남는다
    expect(m.pages).toHaveLength(1);
    expect(m.read(m.pages[0]!.id)['출근 시각']).toBe('09:00');
    // 노트북 화면도 합쳐진 기록을 따라간다
    expect(computeDay(laptop.store.logFor(DAY), t(13)).clockInAt).toBe(t(9));
  });

  it('자리 비움까지 포함해 양쪽 이벤트가 모두 살아남는다', async () => {
    const m = makeLinkedMock();
    installBackend(m);

    const desktop = await device(m, 9);
    desktop.store.perform('clock_in');
    desktop.setClock(12);
    desktop.store.perform('away_start');
    desktop.setClock(13);
    desktop.store.perform('away_end');
    await desktop.store.drainOutbox();

    const laptop = await device(m, 18);
    await laptop.store.pullDay(DAY);
    laptop.store.perform('clock_out');
    await laptop.store.drainOutbox();

    const totals = computeDay(laptop.store.logFor(DAY), t(19));
    expect(totals.actualMs).toBe(8 * HOUR_MS);
    expect(totals.awayMs).toBe(1 * HOUR_MS);
    expect(m.read(m.pages[0]!.id)['자리 비움']).toBe(1);
  });

  it('연동 로그를 매핑하지 않으면 가져오지 않는다 (기존 동작 유지)', async () => {
    const { store } = await makeReadyStore(mock);
    await store.pullDay(DAY);
    expect(store.logFor(DAY).events).toHaveLength(0);
  });

  it('다른 직원의 기록은 가져오지 않는다', async () => {
    const m = makeLinkedMock();
    installBackend(m);

    const jung = await device(m, 9);
    jung.store.perform('clock_in');
    await jung.store.drainOutbox();

    const park = await makeReadyStore(m, memoryStore());
    park.store.setEmployeeName('박진규');
    park.setClock(10);
    await park.store.pullDay(DAY);

    expect(park.store.logFor(DAY).events).toHaveLength(0);
  });
});

describe('Notion Embed 위젯의 URL 설정', () => {
  it('URL 이 지정한 이름과 접근 키를 반영한다', () => {
    const store = new AppStore(() => t(9), memoryStore());
    expect(store.applyBootParams({ employeeName: '박진규', accessKey: 'k1' })).toBe(true);

    const { notion } = store.getSnapshot().state;
    expect(notion.employeeName).toBe('박진규');
    expect(notion.accessKey).toBe('k1');
  });

  it('저장된 값보다 URL 을 우선한다 — 블록 주소가 곧 "누구의 위젯인가"이므로', () => {
    const kv = memoryStore();
    const first = new AppStore(() => t(9), kv);
    first.setEmployeeName('정어리');

    const second = new AppStore(() => t(9), kv);
    second.applyBootParams({ employeeName: '박진규', accessKey: null });
    expect(second.getSnapshot().state.notion.employeeName).toBe('박진규');

    // 재시작해도 유지된다
    expect(new AppStore(() => t(10), kv).getSnapshot().state.notion.employeeName).toBe('박진규');
  });

  it('사람이 바뀌면 이전 사람의 pageId 캐시를 버린다', () => {
    const kv = memoryStore();
    const first = new AppStore(() => t(9), kv);
    first.setEmployeeName('정어리');
    first.updateNotionSettings({ pageIds: { [DAY]: 'page-of-jeongeori' } });

    const second = new AppStore(() => t(9), kv);
    second.applyBootParams({ employeeName: '박진규', accessKey: null });
    expect(second.getSnapshot().state.notion.pageIds).toEqual({});
  });

  it('같은 사람이면 pageId 캐시를 유지한다 (매번 행을 다시 찾지 않도록)', () => {
    const kv = memoryStore();
    const first = new AppStore(() => t(9), kv);
    first.setEmployeeName('박진규');
    first.updateNotionSettings({ pageIds: { [DAY]: 'page-1' } });

    const second = new AppStore(() => t(9), kv);
    expect(second.applyBootParams({ employeeName: '박진규', accessKey: null })).toBe(false);
    expect(second.getSnapshot().state.notion.pageIds).toEqual({ [DAY]: 'page-1' });
  });

  it('URL 이 지정하지 않은 항목은 건드리지 않는다', () => {
    const kv = memoryStore();
    const first = new AppStore(() => t(9), kv);
    first.setEmployeeName('정어리');
    first.updateNotionSettings({ accessKey: 'stored-key' });

    const second = new AppStore(() => t(9), kv);
    expect(second.applyBootParams({ employeeName: null, accessKey: null })).toBe(false);

    const { notion } = second.getSnapshot().state;
    expect(notion.employeeName).toBe('정어리');
    expect(notion.accessKey).toBe('stored-key');
  });

  it('위젯이 URL 로 설정한 이름으로 Notion 에 기록한다', async () => {
    const kv = memoryStore();
    const ready = await makeReadyStore(mock, kv);
    ready.store.applyBootParams({ employeeName: '박진규', accessKey: null });

    ready.store.perform('clock_in');
    await ready.store.drainOutbox({ force: true });

    expect(ready.store.getSnapshot().state.lastSync?.employeeName).toBe('박진규');
  });
});
