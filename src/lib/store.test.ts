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
