import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotionMock } from '../../tests/mocks/notionMock';
import { handleApiRequest, type ServerEnv } from '../../api/_router';
import { AppStore } from './store';
import { computeDay } from './events';
import type { DayLog } from './events';
import { mergeDayLogs, parseDayLog, sameDayLog, serializeDayLog } from '../../shared/dayLog';
import { memoryStore } from './storage.test';
import { HOUR_MS, MINUTE_MS, dateKeyToEpoch } from './time';
import { MAX_TODOS } from './todos';
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

describe('특별 휴가 부여 권한 (상급자 결재)', () => {
  /** 직원 Property 와 부여 칸이 있는 DB */
  function makeGrantMock() {
    return new NotionMock({
      databaseId: DB_ID,
      title: '근무 기록',
      properties: {
        '기록명': { id: 'p1', type: 'title' },
        '근무 일자': { id: 'p2', type: 'date' },
        '실 근무시간': { id: 'p3', type: 'number' },
        '직원': { id: 'p4', type: 'select', options: ['하정언', '박진규'] },
        '부여시간': { id: 'p5', type: 'number' },
        '사유': { id: 'p6', type: 'rich_text' },
        '구분': { id: 'p7', type: 'select', options: ['특별부여'] },
      },
    });
  }

  it('대표가 아니면 부여할 수 없다', async () => {
    const team = makeGrantMock();
    installBackend(team);
    const { store } = await makeReadyStore(team);
    store.setEmployeeName('박진규');

    const ok = await store.grantVacation({ dateKey: DAY, hours: 8, reason: '특별 휴가' });

    expect(ok).toBe(false);
    expect(team.pages).toHaveLength(0);
  });

  it('대표는 다른 사람에게 부여할 수 있고, 그 사람 이름으로 기록된다', async () => {
    const team = makeGrantMock();
    installBackend(team);
    const { store } = await makeReadyStore(team);
    store.setEmployeeName('하정언');

    const ok = await store.grantVacation({
      dateKey: DAY,
      hours: 3,
      reason: '특별 휴가',
      targetEmployee: '박진규',
    });

    expect(ok).toBe(true);
    expect(team.pages).toHaveLength(1);
    const row = team.read(team.pages[0]!.id);
    // 부여를 누른 사람이 아니라 **받는 사람**으로 들어가야 한다.
    expect(row['직원']).toBe('박진규');
    expect(row['부여시간']).toBe(3);
  });

  it('대상을 지정하지 않으면 부여자 본인에게 들어간다', async () => {
    const team = makeGrantMock();
    installBackend(team);
    const { store } = await makeReadyStore(team);
    store.setEmployeeName('하정언');

    await store.grantVacation({ dateKey: DAY, hours: 2, reason: '포상' });

    expect(team.read(team.pages[0]!.id)['직원']).toBe('하정언');
  });

  it('남에게 준 부여는 부여자의 잔여 휴가에 섞이지 않는다', async () => {
    const team = makeGrantMock();
    installBackend(team);
    const { store } = await makeReadyStore(team);
    store.setEmployeeName('하정언');

    await store.grantVacation({
      dateKey: DAY,
      hours: 6,
      reason: '특별 휴가',
      targetEmployee: '박진규',
    });

    // 노션에는 들어갔지만
    expect(team.pages).toHaveLength(1);
    expect(team.read(team.pages[0]!.id)['직원']).toBe('박진규');
    // 부여자 본인의 목록(=잔여 계산의 근거)에는 잡히지 않는다.
    // 여기가 섞이면 대표가 남에게 줄 때마다 자기 잔여가 늘어난다.
    expect(store.getSnapshot().state.grants).toHaveLength(0);
  });

  it('대표가 아니면 부여를 취소할 수도 없다', async () => {
    const team = makeGrantMock();
    installBackend(team);
    const { store } = await makeReadyStore(team);
    store.setEmployeeName('하정언');
    await store.grantVacation({ dateKey: DAY, hours: 3, reason: '특별 휴가' });
    const granted = store.getSnapshot().state.grants;
    expect(granted).toHaveLength(1);

    store.setEmployeeName('박진규');
    const ok = await store.revokeVacationGrant(granted[0]!.id);

    expect(ok).toBe(false);
    // 노션 행이 그대로 남아 있어야 한다 (휴지통으로 가지 않았다)
    expect(team.pages).toHaveLength(1);
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
        '직원': { id: 'p6', type: 'select', options: ['하정언', '박진규'] },
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
    store.setEmployeeName('하정언');

    store.perform('clock_in');
    setClock(18);
    store.perform('clock_out');
    await store.drainOutbox();

    expect(team.pages).toHaveLength(1);
    expect(team.read(team.pages[0]!.id)['직원']).toBe('하정언');
    expect(store.getSnapshot().state.lastSync?.employeeName).toBe('하정언');
  });

  it('두 사람이 같은 날 일해도 서로의 행을 덮어쓰지 않는다', async () => {
    const team = makeTeamMock();
    installBackend(team);

    const a = await makeReadyStore(team);
    a.store.setEmployeeName('하정언');
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
    expect(rows.find((r) => r['직원'] === '하정언')?.['실 근무시간']).toBe(9);
    expect(rows.find((r) => r['직원'] === '박진규')?.['실 근무시간']).toBe(5);
  });

  it('직원을 바꾸면 이전 사람의 행을 더 이상 갱신하지 않는다', async () => {
    const team = makeTeamMock();
    installBackend(team);
    const { store, setClock } = await makeReadyStore(team);

    store.setEmployeeName('하정언');
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
    expect(team.read(firstPageId)['직원']).toBe('하정언');
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
        '직원': { id: 'p3', type: 'select', options: ['하정언', '박진규'] },
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
        '직원': { id: 'p8', type: 'select', options: ['하정언', '박진규'] },
        '이벤트로그': { id: 'p9', type: 'rich_text' },
      },
    });
  }

  /** 서로 다른 브라우저 = 서로 다른 저장소 */
  async function device(m: NotionMock, hour: number) {
    const d = await makeReadyStore(m, memoryStore());
    d.store.setEmployeeName('하정언');
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
    first.setEmployeeName('하정언');

    const second = new AppStore(() => t(9), kv);
    second.applyBootParams({ employeeName: '박진규', accessKey: null });
    expect(second.getSnapshot().state.notion.employeeName).toBe('박진규');

    // 재시작해도 유지된다
    expect(new AppStore(() => t(10), kv).getSnapshot().state.notion.employeeName).toBe('박진규');
  });

  it('사람이 바뀌면 이전 사람의 pageId 캐시를 버린다', () => {
    const kv = memoryStore();
    const first = new AppStore(() => t(9), kv);
    first.setEmployeeName('하정언');
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
    first.setEmployeeName('하정언');
    first.updateNotionSettings({ accessKey: 'stored-key' });

    const second = new AppStore(() => t(9), kv);
    expect(second.applyBootParams({ employeeName: null, accessKey: null })).toBe(false);

    const { notion } = second.getSnapshot().state;
    expect(notion.employeeName).toBe('하정언');
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

describe('한 페이지에 위젯을 여러 개 띄웠을 때', () => {
  /**
   * 브라우저는 iframe 저장소를 "상위 사이트 + iframe 출처"로 나눈다. 같은 Notion
   * 페이지의 두 위젯은 그 둘이 똑같아서 **한 칸을 공유한다**. 실제로 하정언 위젯과
   * 박진규 위젯이 서로의 이름과 근무시간을 덮어썼다. 그래서 같은 KeyValueStore 를
   * 공유시켜 재현한다.
   */
  function widget(name: string, hour: number, kv: KeyValueStore) {
    const store = new AppStore(() => t(hour), kv, name);
    store.updateNotionSettings({ autoSync: false });
    store.applyBootParams({ employeeName: name, accessKey: null });
    return store;
  }

  it('서로의 이름을 덮어쓰지 않는다', () => {
    const kv = memoryStore();
    widget('하정언', 9, kv);
    widget('박진규', 9, kv);

    // 새로고침해도 각자 자기 이름이어야 한다
    expect(new AppStore(() => t(10), kv, '하정언').getSnapshot().state.notion.employeeName).toBe(
      '하정언',
    );
    expect(new AppStore(() => t(10), kv, '박진규').getSnapshot().state.notion.employeeName).toBe(
      '박진규',
    );
  });

  it('서로의 근무시간을 덮어쓰지 않는다', () => {
    const kv = memoryStore();
    const a = widget('하정언', 9, kv);
    const b = widget('박진규', 9, kv);

    a.perform('clock_in');
    b.perform('clock_in');
    b.perform('clock_out');

    expect(computeDay(a.logFor(DAY), t(18)).status).toBe('working');
    expect(computeDay(b.logFor(DAY), t(18)).status).toBe('finished');

    const aAfter = new AppStore(() => t(18), kv, '하정언');
    const bAfter = new AppStore(() => t(18), kv, '박진규');
    expect(computeDay(aAfter.logFor(DAY), t(18)).status).toBe('working');
    expect(computeDay(bAfter.logFor(DAY), t(18)).status).toBe('finished');
  });

  it('한쪽이 저장해도 다른 쪽 pageId 캐시가 섞이지 않는다', () => {
    const kv = memoryStore();
    const a = widget('하정언', 9, kv);
    const b = widget('박진규', 9, kv);

    a.updateNotionSettings({ pageIds: { [DAY]: 'page-a' } });
    b.updateNotionSettings({ pageIds: { [DAY]: 'page-b' } });

    expect(new AppStore(() => t(10), kv, '하정언').getSnapshot().state.notion.pageIds).toEqual({
      [DAY]: 'page-a',
    });
    expect(new AppStore(() => t(10), kv, '박진규').getSnapshot().state.notion.pageIds).toEqual({
      [DAY]: 'page-b',
    });
  });

  it('새 직원 칸은 연결 설정만 물려받는다 — 위젯마다 접근 키를 다시 넣지 않도록', () => {
    const kv = memoryStore();
    const shared = new AppStore(() => t(9), kv);
    shared.updateNotionSettings({
      autoSync: false,
      accessKey: 'team-key',
      mapping: { date: '근무 일자' },
      pageIds: { [DAY]: 'page-of-someone-else' },
    });
    shared.setEmployeeName('하정언');
    shared.perform('clock_in');

    const fresh = new AppStore(() => t(10), kv, '박진규');
    const { notion, logs } = fresh.getSnapshot().state;

    expect(notion.accessKey).toBe('team-key');
    expect(notion.mapping.date).toBe('근무 일자');
    // 사람의 것은 물려받지 않는다 — 남의 기록을 자기 것으로 삼는 셈이므로
    expect(notion.employeeName).toBe('');
    expect(notion.pageIds).toEqual({});
    expect(logs).toEqual({});
  });

  it('이미 자기 칸이 있으면 공용 칸을 다시 물려받지 않는다', () => {
    const kv = memoryStore();
    const first = widget('박진규', 9, kv);
    first.perform('clock_in');

    const shared = new AppStore(() => t(10), kv);
    shared.updateNotionSettings({ autoSync: false, accessKey: 'changed-later' });

    const again = new AppStore(() => t(11), kv, '박진규');
    expect(computeDay(again.logFor(DAY), t(11)).status).toBe('working');
    expect(again.getSnapshot().state.notion.employeeName).toBe('박진규');
  });

  it('직원을 지정하지 않으면 예전처럼 공용 칸을 쓴다', () => {
    const kv = memoryStore();
    const plain = new AppStore(() => t(9), kv);
    plain.updateNotionSettings({ autoSync: false });
    plain.setEmployeeName('하정언');
    plain.perform('clock_in');

    const reopened = new AppStore(() => t(10), kv);
    expect(reopened.getSnapshot().state.notion.employeeName).toBe('하정언');
    expect(computeDay(reopened.logFor(DAY), t(10)).status).toBe('working');
  });
});

describe('직원 칸을 처음 만들 때의 저장 순서', () => {
  it('물려받은 연결 설정이 첫 저장에도 살아남는다', () => {
    const kv = memoryStore();
    const shared = new AppStore(() => t(9), kv);
    shared.updateNotionSettings({
      autoSync: false,
      accessKey: 'team-key',
      mapping: { date: '근무 일자' },
    });

    // 생성 직후의 첫 저장이 "빈 칸" 위에 얹히면 물려받은 값이 통째로 날아간다.
    // 실제로 위젯이 접근 키를 잃고 설정 화면으로 돌아갔다.
    const w = new AppStore(() => t(10), kv, '박진규');
    w.applyBootParams({ employeeName: '박진규', accessKey: null });

    expect(w.getSnapshot().state.notion.accessKey).toBe('team-key');
    expect(w.getSnapshot().state.notion.mapping.date).toBe('근무 일자');

    const reopened = new AppStore(() => t(11), kv, '박진규');
    expect(reopened.getSnapshot().state.notion.accessKey).toBe('team-key');
    expect(reopened.getSnapshot().state.notion.mapping.date).toBe('근무 일자');
    expect(reopened.getSnapshot().state.notion.employeeName).toBe('박진규');
  });
});

describe('업무 리스트(할 일)', () => {
  /** 업무 리스트 칸까지 갖춘 DB */
  function makeTodoMock() {
    return new NotionMock({
      databaseId: DB_ID,
      title: '근무 기록',
      properties: {
        '기록명': { id: 'p1', type: 'title' },
        '근무 일자': { id: 'p2', type: 'date' },
        '출근 시각': { id: 'p3', type: 'rich_text' },
        '퇴근 시각': { id: 'p4', type: 'rich_text' },
        '실 근무시간': { id: 'p5', type: 'number' },
        '상태': { id: 'p6', type: 'select', options: [] },
        '직원': { id: 'p7', type: 'select', options: ['하정언', '박진규'] },
        '이벤트로그': { id: 'p8', type: 'rich_text' },
        '업무 리스트': { id: 'p9', type: 'rich_text' },
      },
    });
  }

  async function todoStore(m: NotionMock, kv?: KeyValueStore) {
    const d = await makeReadyStore(m, kv);
    d.store.setEmployeeName('하정언');
    return d;
  }

  it('업무 리스트 칸을 자동으로 찾아 매핑한다', async () => {
    const m = makeTodoMock();
    installBackend(m);
    const { store } = await todoStore(m);
    expect(store.getSnapshot().state.notion.mapping.todos).toBe('업무 리스트');
  });

  it('적은 할 일이 그날 행에 체크리스트로 기록된다', async () => {
    const m = makeTodoMock();
    installBackend(m);
    const { store } = await todoStore(m);

    store.addTodo(DAY, '3화 대본 초고');
    store.addTodo(DAY, '썸네일 시안');
    store.toggleTodo(DAY, store.todosFor(DAY)[0]!.id);
    await store.drainOutbox();

    expect(m.pages).toHaveLength(1);
    expect(m.read(m.pages[0]!.id)['업무 리스트']).toBe('☑ 3화 대본 초고\n☐ 썸네일 시안');
  });

  it('출근 전에 적어도 그날 행이 만들어진다', async () => {
    const m = makeTodoMock();
    installBackend(m);
    const { store } = await todoStore(m);

    store.addTodo(DAY, '오늘 계획');
    await store.drainOutbox();

    expect(m.pages).toHaveLength(1);
    expect(m.read(m.pages[0]!.id)['기록명']).toBe(`${DAY} 하정언 근무기록`);
  });

  it('모두 지우면 Notion 칸도 비워진다', async () => {
    const m = makeTodoMock();
    installBackend(m);
    const { store } = await todoStore(m);

    store.addTodo(DAY, '지울 것');
    await store.drainOutbox();
    expect(m.read(m.pages[0]!.id)['업무 리스트']).toBe('☐ 지울 것');

    store.removeTodo(DAY, store.todosFor(DAY)[0]!.id);
    await store.drainOutbox();

    expect(m.pages).toHaveLength(1);
    expect(m.read(m.pages[0]!.id)['업무 리스트']).toBe('');
  });

  it('수정·이동·중복 삭제가 목록에 그대로 반영된다', async () => {
    const m = makeTodoMock();
    installBackend(m);
    const { store } = await todoStore(m);

    store.addTodo(DAY, '하나');
    store.addTodo(DAY, '둘');
    const [first, second] = store.todosFor(DAY);

    expect(store.editTodo(DAY, first!.id, '하나 고침')).toBe(true);
    // 빈 값으로는 지워지지 않는다 (삭제는 삭제 버튼으로만)
    expect(store.editTodo(DAY, first!.id, '   ')).toBe(false);
    expect(store.todosFor(DAY)[0]!.text).toBe('하나 고침');

    store.moveTodo(DAY, second!.id, -1);
    expect(store.todosFor(DAY).map((t) => t.text)).toEqual(['둘', '하나 고침']);

    // 맨 위에서 더 올리려 해도 아무 일도 일어나지 않는다
    store.moveTodo(DAY, second!.id, -1);
    expect(store.todosFor(DAY).map((t) => t.text)).toEqual(['둘', '하나 고침']);

    store.removeTodo(DAY, second!.id);
    store.removeTodo(DAY, second!.id);
    expect(store.todosFor(DAY).map((t) => t.text)).toEqual(['하나 고침']);
  });

  /**
   * 없어진 Property 를 가리키는 매핑.
   *
   * `누락 Property 추가` 를 여러 번 눌러 만들어진 `업무 리스트 (2)` 같은 껍데기를
   * Notion 에서 지우면, 그때 그 이름으로 매핑해 둔 기기는 존재하지 않는 칸을 계속
   * 가리킨다. 서버는 쓸 곳이 없어 목록을 조용히 버리고, 앱은 초록 배너로
   * "Notion 에 기록됩니다" 라고 말한다 — 적은 할 일이 어디에도 안 남는다.
   */
  it('없어진 Property 를 가리키던 매핑이 스스로 고쳐져 목록이 계속 기록된다', async () => {
    const kv = memoryStore();

    // 1) `누락 Property 추가` 를 눌러 껍데기 칸(`업무 리스트 (2)`)이 생겼던 시절의 기기.
    const withShell = new NotionMock({
      databaseId: DB_ID,
      title: '근무 기록',
      properties: {
        '기록명': { id: 'p1', type: 'title' },
        '근무 일자': { id: 'p2', type: 'date' },
        '실 근무시간': { id: 'p5', type: 'number' },
        '직원': { id: 'p7', type: 'select', options: ['하정언', '박진규'] },
        '이벤트로그': { id: 'p8', type: 'rich_text' },
        '업무 리스트': { id: 'p9', type: 'rich_text' },
        '업무 리스트 (2)': { id: 'p10', type: 'rich_text' },
      },
    });
    installBackend(withShell);
    const before = await todoStore(withShell, kv);
    before.store.setMappingField('todos', '업무 리스트 (2)');
    before.store.addTodo(DAY, '옛날 할 일');
    await before.store.drainOutbox();
    expect(withShell.read(withShell.pages[0]!.id)['업무 리스트 (2)']).toBe('☐ 옛날 할 일');

    // 2) 껍데기 칸을 Notion 에서 지웠다. 같은 기기(같은 localStorage)가 다시 열린다.
    const cleaned = makeTodoMock();
    installBackend(cleaned);
    const after = await todoStore(cleaned, kv);

    after.store.addTodo(DAY, '오늘 할 일');
    await after.store.drainOutbox();

    // 고쳐지지 않으면 서버는 쓸 칸을 못 찾아 목록을 통째로 버린다.
    expect(after.store.getSnapshot().state.notion.mapping.todos).toBe('업무 리스트');
    expect(cleaned.pages).toHaveLength(1);
    expect(cleaned.read(cleaned.pages[0]!.id)['업무 리스트']).toContain('오늘 할 일');
  });

  it('쓸 수 없는 칸에 매핑돼 목록이 버려지면 조용히 넘어가지 않고 알린다', async () => {
    const m = new NotionMock({
      databaseId: DB_ID,
      title: '근무 기록',
      properties: {
        '기록명': { id: 'p1', type: 'title' },
        '근무 일자': { id: 'p2', type: 'date' },
        '실 근무시간': { id: 'p5', type: 'number' },
        '직원': { id: 'p7', type: 'select', options: ['하정언', '박진규'] },
        '이벤트로그': { id: 'p8', type: 'rich_text' },
        '업무 리스트': { id: 'p9', type: 'rich_text' },
      },
    });
    installBackend(m);
    const { store } = await todoStore(m);

    // 텍스트가 아닌 칸을 골라 두면 서버는 쓸 수 없어 목록을 버린다.
    store.setMappingField('todos', '실 근무시간');
    store.addTodo(DAY, '어디에도 안 남는 할 일');
    await store.drainOutbox();

    expect(m.read(m.pages[0]!.id)['업무 리스트'] ?? '').toBe('');
    expect(store.getSnapshot().runtime.notice?.text).toContain('업무 리스트');
    expect(store.getSnapshot().runtime.notice?.text).toContain('Property 매핑');
  });

  it('없어진 Property 를 가리키는 동안에는 초록 배너 대신 경고를 낼 수 있게 알린다', async () => {
    const m = makeTodoMock();
    installBackend(m);
    const { store } = await todoStore(m);

    store.setMappingField('todos', '업무 리스트 (2)');
    expect(store.mappedProperty('todos')).toBeNull();
    expect(store.mappedProperty('eventLog')).toBe('이벤트로그');
  });

  it('지난 날의 목록을 고치면 오늘이 아니라 그날 행이 바뀐다', async () => {
    const m = makeTodoMock();
    installBackend(m);
    const { store } = await todoStore(m);

    const YESTERDAY = '2026-08-09';
    store.addTodo(YESTERDAY, '어제 못 적은 것');
    store.addTodo(DAY, '오늘 것');
    await store.drainOutbox();

    // 날짜별로 행이 따로 만들어졌는지부터 확인한다 — 한 행에 몰리면
    // 지난 날 수정이 오늘 기록을 덮어쓰는 셈이 된다.
    expect(m.pages).toHaveLength(2);
    const rowOf = (dateKey: string) =>
      m.pages
        .map((page) => m.read(page.id))
        .find((row) => String(row['기록명'] ?? '').startsWith(dateKey))!;
    expect(rowOf(YESTERDAY)['업무 리스트']).toBe('☐ 어제 못 적은 것');

    store.editTodo(YESTERDAY, store.todosFor(YESTERDAY)[0]!.id, '어제 대본 검토');
    store.toggleTodo(YESTERDAY, store.todosFor(YESTERDAY)[0]!.id);
    await store.drainOutbox();

    expect(m.pages).toHaveLength(2);
    expect(rowOf(YESTERDAY)['업무 리스트']).toBe('☑ 어제 대본 검토');
    expect(rowOf(DAY)['업무 리스트']).toBe('☐ 오늘 것');
  });

  it('빈 문자열은 추가되지 않고, 하루 개수 상한을 넘지 못한다', async () => {
    const m = makeTodoMock();
    installBackend(m);
    const { store } = await todoStore(m);

    expect(store.addTodo(DAY, '   ')).toBe(false);
    for (let i = 0; i < MAX_TODOS; i++) store.addTodo(DAY, `할 일 ${i}`);
    expect(store.addTodo(DAY, '넘치는 것')).toBe(false);
    expect(store.todosFor(DAY)).toHaveLength(MAX_TODOS);
    expect(store.getSnapshot().runtime.notice?.kind).toBe('error');
  });

  it('출근 기록이 없는 날에 적어도 새로고침 후 남아 있다', async () => {
    const m = makeTodoMock();
    installBackend(m);
    const kv = memoryStore();
    const { store } = await todoStore(m, kv);

    store.addTodo(DAY, '내일 할 것');

    // 이벤트가 하나도 없는 하루라 예전에는 저장 단계에서 통째로 버려졌다.
    const reopened = new AppStore(() => t(10), kv);
    expect(reopened.todosFor(DAY).map((t) => t.text)).toEqual(['내일 할 것']);
  });

  it('다른 기기가 적어 둔 목록을 가져와 이어서 쓴다', async () => {
    const m = makeTodoMock();
    installBackend(m);

    const desktop = await todoStore(m, memoryStore());
    desktop.store.addTodo(DAY, '데스크탑에서 적음');
    await desktop.store.drainOutbox();

    const laptop = await todoStore(m, memoryStore());
    expect(laptop.store.todosFor(DAY)).toHaveLength(0);

    await laptop.store.pullDay(DAY);
    expect(laptop.store.todosFor(DAY).map((t) => t.text)).toEqual(['데스크탑에서 적음']);
  });

  it('다른 기기에서 퇴근만 눌러도 적어 둔 목록이 지워지지 않는다', async () => {
    const m = makeTodoMock();
    installBackend(m);

    const laptop = await todoStore(m, memoryStore());
    laptop.setClock(9);
    laptop.store.perform('clock_in');
    await laptop.store.drainOutbox();

    const desktop = await todoStore(m, memoryStore());
    desktop.setClock(9);
    await desktop.store.pullDay(DAY);
    desktop.store.addTodo(DAY, '첫 항목');
    await desktop.store.drainOutbox();

    // 노트북이 그 시점의 목록을 한 번 받아 간다 (이제 **낡은 목록**을 들고 있다).
    laptop.setClock(10);
    await laptop.store.pullDay(DAY);
    expect(laptop.store.todosFor(DAY).map((t) => t.text)).toEqual(['첫 항목']);

    // 그 뒤 데스크탑에서만 목록이 자란다.
    desktop.setClock(11);
    desktop.store.addTodo(DAY, '둘째 항목');
    await desktop.store.drainOutbox();

    // 노트북은 목록에 손댄 적이 없다. 퇴근을 눌렀다는 이유로 낡은 목록이 이기면 안 된다.
    laptop.setClock(18);
    laptop.store.perform('clock_out');
    await laptop.store.drainOutbox();

    expect(m.pages).toHaveLength(1);
    expect(m.read(m.pages[0]!.id)['업무 리스트']).toBe('☐ 첫 항목\n☐ 둘째 항목');
    expect(m.read(m.pages[0]!.id)['퇴근 시각']).toBe('18:00');
  });

  it('나중에 목록을 고친 기기가 이긴다', async () => {
    const m = makeTodoMock();
    installBackend(m);

    const desktop = await todoStore(m, memoryStore());
    desktop.setClock(10);
    desktop.store.addTodo(DAY, '먼저 적은 것');
    await desktop.store.drainOutbox();

    const laptop = await todoStore(m, memoryStore());
    laptop.setClock(11);
    await laptop.store.pullDay(DAY);
    laptop.store.addTodo(DAY, '나중에 적은 것');
    await laptop.store.drainOutbox();

    expect(m.read(m.pages[0]!.id)['업무 리스트']).toBe('☐ 먼저 적은 것\n☐ 나중에 적은 것');
  });

  // Notion 임베드 위젯은 iframe 이라 브라우저가 저장소를 따로 쪼개 준다. 그래서 전체
  // 화면에서 `업무 리스트` Property 를 만들어도 위젯은 예전 매핑을 그대로 들고 있다.
  // 아래 두 가지가 그 상태에서 실제로 났던 고장이다.

  /** `업무 리스트` Property 가 생기기 전에 설정을 마친 기기 (= 임베드 위젯) */
  async function staleWidget(m: NotionMock) {
    const prop = m.properties['업무 리스트']!;
    delete m.properties['업무 리스트'];
    const d = await todoStore(m, memoryStore());
    // 그 뒤 전체 화면에서 Property 를 만들었다. 위젯은 그 사실을 모른다.
    m.properties['업무 리스트'] = prop;
    return d;
  }

  it('낡은 스키마를 들고 있어도 업무 리스트 칸을 스스로 찾아낸다', async () => {
    const m = makeTodoMock();
    installBackend(m);
    const widget = await staleWidget(m);
    expect(widget.store.getSnapshot().state.notion.mapping.todos).toBeUndefined();

    await widget.store.pullDay(DAY);
    expect(widget.store.getSnapshot().state.notion.mapping.todos).toBe('업무 리스트');

    // 매핑이 없던 동안에는 위젯에 적은 할 일이 Notion 으로 아예 나가지 못했다.
    widget.store.addTodo(DAY, '위젯에서 적음');
    await widget.store.drainOutbox();
    expect(m.read(m.pages[0]!.id)['업무 리스트']).toBe('☐ 위젯에서 적음');
  });

  it('업무 리스트 칸을 모르는 기기의 저장이 남의 최신 목록을 되돌리지 않는다', async () => {
    const m = makeTodoMock();
    installBackend(m);
    const widget = await staleWidget(m);

    const desktop = await todoStore(m, memoryStore());
    desktop.setClock(10);
    desktop.store.addTodo(DAY, '첫 항목');
    await desktop.store.drainOutbox();

    // 아직 보내지 않은 최신 목록을 데스크탑이 들고 있다.
    desktop.setClock(11);
    desktop.store.addTodo(DAY, '둘째 항목');

    // 그 사이 위젯이 저장한다. 칸을 모르니 목록은 못 올리는데,
    // 예전에는 "내가 방금 목록을 고쳤다"는 시각만 로그에 남겼다.
    widget.setClock(12);
    widget.store.addTodo(DAY, '위젯에서 적음');
    await widget.store.drainOutbox();
    expect(m.read(m.pages[0]!.id)['업무 리스트']).toBe('☐ 첫 항목');

    // 그 시각 때문에 데스크탑은 다음 읽기에서 자기 최신 목록을 버리고
    // 칸에 남아 있던 낡은 목록을 되살렸다.
    desktop.setClock(13);
    await desktop.store.pullDay(DAY);
    expect(desktop.store.todosFor(DAY).map((t) => t.text)).toEqual(['첫 항목', '둘째 항목']);
  });

  it('저장 중에 적은 할 일도 곧바로 이어서 전송된다', async () => {
    const m = makeTodoMock();
    installBackend(m);
    const { store } = await todoStore(m);
    store.updateNotionSettings({ autoSync: true });

    // 첫 전송이 끝나기 전에 두 번째를 적는다. 대기열은 날짜 하나로 합쳐지므로
    // 재실행이 없으면 두 번째 항목은 다음 주기(1분)까지 Notion 에 가지 못한다.
    store.addTodo(DAY, '첫 번째');
    store.addTodo(DAY, '두 번째');

    await vi.waitFor(() => {
      expect(m.pages).toHaveLength(1);
      expect(m.read(m.pages[0]!.id)['업무 리스트']).toBe('☐ 첫 번째\n☐ 두 번째');
    });
    expect(Object.keys(store.getSnapshot().state.outbox)).toEqual([]);
  });

  it('업무 리스트 칸이 없는 DB 에서도 목록은 기기에 남는다', async () => {
    // 기본 mock 에는 업무 리스트 칸이 없다 — 매핑이 비고, 동기화는 그 필드만 건너뛴다.
    const { store } = await makeReadyStore(mock);
    expect(store.getSnapshot().state.notion.mapping.todos).toBeUndefined();

    store.addTodo(DAY, '어딘가에는 남아야 함');
    await store.drainOutbox();

    expect(store.todosFor(DAY).map((t) => t.text)).toEqual(['어딘가에는 남아야 함']);
    expect(mock.pages).toHaveLength(1);
  });
});

describe('근무시간 정정 — 저장과 기기 간 병합', () => {
  it('직렬화했다가 다시 읽어도 정정이 그대로다 (사유의 공백 포함)', () => {
    const log: DayLog = {
      date: '2026-08-18',
      events: [{ type: 'clock_in', at: dateKeyToEpoch('2026-08-18') + 9 * 3600000 }],
      vacationMs: 0,
      updatedAt: 1000,
      correctionAt: 2000,
      correction: { actualMs: 8 * 3600000, beforeMs: 14 * 3600000, reason: '퇴근 찍는 것을 잊음' },
    };

    const back = parseDayLog('2026-08-18', serializeDayLog(log))!;
    expect(back.correction).toEqual(log.correction);
    expect(back.correctionAt).toBe(2000);
    expect(back.events).toHaveLength(1);
  });

  it('나중에 정정한 쪽이 이긴다', () => {
    const base: DayLog = { date: '2026-08-18', events: [], vacationMs: 0, updatedAt: 1 };
    const a: DayLog = {
      ...base,
      correctionAt: 100,
      correction: { actualMs: 3 * 3600000, beforeMs: 0, reason: '먼저' },
    };
    const b: DayLog = {
      ...base,
      correctionAt: 200,
      correction: { actualMs: 5 * 3600000, beforeMs: 0, reason: '나중' },
    };
    expect(mergeDayLogs(a, b)!.correction?.reason).toBe('나중');
    expect(mergeDayLogs(b, a)!.correction?.reason).toBe('나중');
  });

  it('정정을 취소하면 다른 기기의 옛 정정이 되살아나지 않는다', () => {
    const withCorrection: DayLog = {
      date: '2026-08-18',
      events: [],
      vacationMs: 0,
      updatedAt: 100,
      correctionAt: 100,
      correction: { actualMs: 3 * 3600000, beforeMs: 0, reason: '옛 정정' },
    };
    // 취소한 쪽: 정정은 없지만 "언제 취소했는지"는 남아 있다
    const cleared: DayLog = { date: '2026-08-18', events: [], vacationMs: 0, updatedAt: 200, correctionAt: 200 };

    expect(mergeDayLogs(withCorrection, cleared)!.correction).toBeUndefined();
    expect(mergeDayLogs(cleared, withCorrection)!.correction).toBeUndefined();
  });

  it('퇴근만 누른 기기가 다른 기기의 정정을 지우지 않는다', () => {
    const corrected: DayLog = {
      date: '2026-08-18',
      events: [],
      vacationMs: 0,
      updatedAt: 100,
      correctionAt: 100,
      correction: { actualMs: 8 * 3600000, beforeMs: 0, reason: '정정' },
    };
    // 나중에 출퇴근만 눌러 updatedAt 이 더 큰 기기 (정정은 만진 적 없음)
    const clockedOut: DayLog = {
      date: '2026-08-18',
      events: [{ type: 'clock_in', at: 500 }],
      vacationMs: 0,
      updatedAt: 999,
    };

    expect(mergeDayLogs(corrected, clockedOut)!.correction?.reason).toBe('정정');
  });
});

describe('근무시간 정정 — 찍힌 구간에서 잘라내기', () => {
  /** DAY 의 "HH:MM" epoch */
  const hm = (h: number, m = 0) => t(h) + m * MINUTE_MS;

  it('퇴근을 안 찍은 날은 실제 끝난 시각만 알려 주면 시간이 다시 계산된다', async () => {
    const { store, setClockRaw } = await makeReadyStore(mock);

    setClockRaw(hm(3, 5));
    store.perform('clock_in'); // 새벽 3시 5분 출근, 퇴근은 안 찍음
    setClockRaw(hm(10));
    expect(computeDay(store.logFor(DAY), hm(10)).actualMs).toBe(6 * HOUR_MS + 55 * MINUTE_MS);

    // 사람이 아는 것은 "5시에 끝났다"이지 "1시간 55분"이 아니다.
    const ok = store.correctWorkTimeBySegments(
      DAY,
      [{ start: hm(3, 5), end: hm(5) }],
      '퇴근 찍는 것을 잊음',
      hm(10),
    );
    expect(ok).toBe(true);

    const totals = computeDay(store.logFor(DAY), hm(12));
    expect(totals.actualMs).toBe(115 * MINUTE_MS);
    expect(totals.clockOutAt).toBe(hm(5));
    expect(totals.correction?.beforeMs).toBe(6 * HOUR_MS + 55 * MINUTE_MS);
    expect(totals.correction?.segments).toEqual([{ start: hm(3, 5), end: hm(5) }]);
    expect(totals.isLive).toBe(false);
  });

  it('구간이 여러 개면 각각 잘라서 합산한다', async () => {
    const { store, setClockRaw } = await makeReadyStore(mock);
    setClockRaw(hm(3, 5));
    store.perform('clock_in');
    setClockRaw(hm(10));
    store.perform('away_start');
    setClockRaw(hm(14));
    store.perform('away_end'); // 14:00 부터 다시 근무, 퇴근 안 찍음

    const ok = store.correctWorkTimeBySegments(
      DAY,
      [
        { start: hm(3, 5), end: hm(5) },
        { start: hm(14), end: hm(18) },
      ],
      '퇴근 찍는 것을 잊음',
      hm(23),
    );
    expect(ok).toBe(true);
    expect(computeDay(store.logFor(DAY), hm(23)).actualMs).toBe(5 * HOUR_MS + 55 * MINUTE_MS);
  });

  it('찍힌 구간 밖으로는 늘릴 수 없다', async () => {
    const { store, setClockRaw } = await makeReadyStore(mock);
    setClockRaw(hm(9));
    store.perform('clock_in');
    setClockRaw(hm(12));
    store.perform('clock_out');

    const ok = store.correctWorkTimeBySegments(DAY, [{ start: hm(9), end: hm(18) }], '더 일했음', hm(20));
    expect(ok).toBe(false);
    expect(store.getSnapshot().runtime.notice?.kind).toBe('error');
    expect(store.logFor(DAY).correction).toBeUndefined();
  });

  it('길이가 0 인 구간은 "그 시간엔 일하지 않았다"로 빠진다', async () => {
    const { store, setClockRaw } = await makeReadyStore(mock);
    setClockRaw(hm(9));
    store.perform('clock_in');
    setClockRaw(hm(12));
    store.perform('away_start');
    setClockRaw(hm(13));
    store.perform('away_end');
    setClockRaw(hm(18));
    store.perform('clock_out');

    store.correctWorkTimeBySegments(
      DAY,
      [
        { start: hm(9), end: hm(12) },
        { start: hm(13), end: hm(13) }, // 오후 구간은 통째로 제외
      ],
      '오후엔 자리만 지킴',
      hm(20),
    );
    const totals = computeDay(store.logFor(DAY), hm(20));
    expect(totals.actualMs).toBe(3 * HOUR_MS);
    expect(totals.correction?.segments).toHaveLength(1);
  });

  it('사유가 없으면 정정하지 않는다', async () => {
    const { store, setClockRaw } = await makeReadyStore(mock);
    setClockRaw(hm(9));
    store.perform('clock_in');
    expect(store.correctWorkTimeBySegments(DAY, [{ start: hm(9), end: hm(10) }], '  ', hm(11))).toBe(false);
    expect(store.logFor(DAY).correction).toBeUndefined();
  });

  it('아무것도 안 찍은 날은 구간 정정을 못 한다 (직접 입력으로 넘긴다)', async () => {
    const { store } = await makeReadyStore(mock);
    expect(store.correctWorkTimeBySegments(DAY, [{ start: t(9), end: t(18) }], '기록 없음', t(20))).toBe(false);
    expect(store.getSnapshot().runtime.notice?.kind).toBe('error');
  });

  it('두 번 정정해도 "수정 전" 은 최초 원본을 유지한다', async () => {
    const { store, setClockRaw } = await makeReadyStore(mock);
    setClockRaw(hm(9));
    store.perform('clock_in');
    setClockRaw(hm(20));
    store.perform('clock_out'); // 11시간으로 찍힘

    store.correctWorkTimeBySegments(DAY, [{ start: hm(9), end: hm(18) }], '퇴근 지연 입력', hm(21));
    store.correctWorkTimeBySegments(DAY, [{ start: hm(9), end: hm(17) }], '다시 확인', hm(22));

    const c = store.logFor(DAY).correction!;
    expect(c.beforeMs).toBe(11 * HOUR_MS);
    expect(c.actualMs).toBe(8 * HOUR_MS);
  });

  it('정정 구간은 Notion 을 거쳐 다른 기기까지 그대로 간다', () => {
    const log: DayLog = {
      date: DAY,
      events: [{ type: 'clock_in', at: hm(3, 5) }],
      vacationMs: 0,
      updatedAt: hm(10),
      correctionAt: hm(10),
      correction: {
        actualMs: 115 * MINUTE_MS,
        beforeMs: 7 * HOUR_MS,
        reason: '퇴근 찍는 것을 잊음',
        segments: [{ start: hm(3, 5), end: hm(5) }],
      },
    };
    const back = parseDayLog(DAY, serializeDayLog(log))!;
    expect(back.correction).toEqual(log.correction);
  });

  it('정정만 달라져도 "바뀐 기록"으로 본다 (안 그러면 다른 기기의 정정을 무시한다)', () => {
    const base: DayLog = { date: DAY, events: [], vacationMs: 0, updatedAt: 1 };
    const corrected: DayLog = {
      ...base,
      correctionAt: 100,
      correction: { actualMs: 2 * HOUR_MS, beforeMs: 9 * HOUR_MS, reason: '정정' },
    };
    expect(sameDayLog(base, corrected)).toBe(false);
    expect(sameDayLog(corrected, corrected)).toBe(true);
  });
});

describe('근무시간 추가 — 일한 구간을 적으면 알아서 계산한다', () => {
  /** DAY 의 "HH:MM" epoch */
  const hm = (h: number, m = 0) => t(h) + m * MINUTE_MS;

  it('"11:00~17:00" 을 적으면 6시간이 더해진다 (암산을 시키지 않는다)', async () => {
    const { store } = await makeReadyStore(mock);

    expect(store.addWorkRange(DAY, '11:00', '17:00', '노트북으로 작업', hm(18))).toBe(true);

    const totals = computeDay(store.logFor(DAY), hm(18));
    expect(totals.actualMs).toBe(6 * HOUR_MS);
    expect(totals.extraMs).toBe(6 * HOUR_MS);
    // 구간을 그대로 남긴다 — 숫자만 남으면 무슨 시간이었는지 알 수 없다.
    expect(totals.extra?.segments).toEqual([{ start: hm(11), end: hm(17) }]);
  });

  it('찍혀 있는 시간과 겹치는 부분은 빼고 더한다 (같은 시간을 두 번 세면 안 된다)', async () => {
    const { store, setClockRaw } = await makeReadyStore(mock);

    setClockRaw(hm(9));
    store.perform('clock_in');
    setClockRaw(hm(12));
    store.perform('clock_out'); // 09:00~12:00 찍힘

    // 11:00~17:00 중 11~12시는 이미 찍혀 있다 → 12:00~17:00 (5시간)만 더해져야 한다
    expect(store.addWorkRange(DAY, '11:00', '17:00', '이어서 작업', hm(18))).toBe(true);

    const totals = computeDay(store.logFor(DAY), hm(18));
    expect(totals.actualMs).toBe(8 * HOUR_MS); // 3시간 찍힘 + 5시간 추가
    expect(totals.extraMs).toBe(5 * HOUR_MS);
    expect(totals.extra?.segments).toEqual([{ start: hm(12), end: hm(17) }]);
  });

  it('구간이 통째로 이미 근무시간이면 거절한다', async () => {
    const { store, setClockRaw } = await makeReadyStore(mock);

    setClockRaw(hm(9));
    store.perform('clock_in');
    setClockRaw(hm(18));
    store.perform('clock_out');

    expect(store.addWorkRange(DAY, '11:00', '17:00', '중복', hm(19))).toBe(false);
    expect(computeDay(store.logFor(DAY), hm(19)).extraMs).toBe(0);
  });

  it('여러 구간을 더하면 쌓이고, 서로 겹치는 부분도 걸러진다', async () => {
    const { store } = await makeReadyStore(mock);

    store.addWorkRange(DAY, '11:00', '13:00', '오전', hm(18));
    store.addWorkRange(DAY, '12:00', '15:00', '오후', hm(18)); // 12~13 은 이미 더함

    const totals = computeDay(store.logFor(DAY), hm(18));
    expect(totals.extraMs).toBe(4 * HOUR_MS); // 11~13 + 13~15
    expect(totals.extra?.segments).toEqual([
      { start: hm(11), end: hm(13) },
      { start: hm(13), end: hm(15) },
    ]);
  });

  it('끝이 시작보다 앞서면 자정을 넘긴 것으로 본다 (22:00~02:00 = 4시간)', async () => {
    const { store } = await makeReadyStore(mock);

    expect(store.addWorkRange(DAY, '22:00', '02:00', '새벽 작업', hm(23))).toBe(true);
    expect(computeDay(store.logFor(DAY), hm(23)).extraMs).toBe(4 * HOUR_MS);
  });

  it('30분 단위도 그대로 계산된다', async () => {
    const { store } = await makeReadyStore(mock);

    store.addWorkRange(DAY, '13:15', '15:45', '외부 미팅', hm(16));
    expect(computeDay(store.logFor(DAY), hm(16)).extraMs).toBe(2 * HOUR_MS + 30 * MINUTE_MS);
  });

  it('근무 중인 날에 더해도 상태와 타이머는 그대로다', async () => {
    const { store, setClockRaw } = await makeReadyStore(mock);

    setClockRaw(hm(9));
    store.perform('clock_in');
    setClockRaw(hm(10));
    store.addWorkRange(DAY, '06:00', '08:00', '출근 전 작업', hm(10));

    const totals = computeDay(store.logFor(DAY), hm(10));
    expect(totals.status).toBe('working');
    expect(totals.isLive).toBe(true);
    expect(totals.actualMs).toBe(3 * HOUR_MS); // 1시간 찍힘 + 2시간 추가
    // 시간이 흐르면 찍힌 쪽만 늘어난다
    expect(computeDay(store.logFor(DAY), hm(11)).actualMs).toBe(4 * HOUR_MS);
  });

  it('사유 없이, 또는 형식이 아닌 시각으로는 더할 수 없다', async () => {
    const { store } = await makeReadyStore(mock);

    expect(store.addWorkRange(DAY, '11:00', '17:00', '   ', hm(18))).toBe(false);
    expect(store.addWorkRange(DAY, '아무거나', '17:00', '사유 있음', hm(18))).toBe(false);
    expect(store.addWorkRange(DAY, '11:00', '11:00', '길이 0', hm(18))).toBe(false);
    expect(store.logFor(DAY).extra).toBeUndefined();
  });

  it('구간 하나만 되돌릴 수 있다', async () => {
    const { store } = await makeReadyStore(mock);

    store.addWorkRange(DAY, '11:00', '13:00', '오전', hm(18));
    store.addWorkRange(DAY, '15:00', '17:00', '오후', hm(18));
    expect(computeDay(store.logFor(DAY), hm(18)).extraMs).toBe(4 * HOUR_MS);

    expect(store.removeAddedRange(DAY, 0, hm(19))).toBe(true);
    const totals = computeDay(store.logFor(DAY), hm(19));
    expect(totals.extraMs).toBe(2 * HOUR_MS);
    expect(totals.extra?.segments).toEqual([{ start: hm(15), end: hm(17) }]);
  });

  it('마지막 구간을 지우면 추가 자체가 사라지고, 취소 시각이 남는다', async () => {
    const { store } = await makeReadyStore(mock);

    store.addWorkRange(DAY, '11:00', '13:00', '오전', hm(18));
    expect(store.removeAddedRange(DAY, 0, hm(19))).toBe(true);

    expect(store.logFor(DAY).extra).toBeUndefined();
    // 취소 시각은 남아야 다른 기기의 옛 추가를 이긴다
    expect(store.logFor(DAY).extraAt).toBe(hm(19));
  });

  it('추가를 전부 취소하면 원래 값으로 돌아간다', async () => {
    const { store, setClockRaw } = await makeReadyStore(mock);

    setClockRaw(hm(9));
    store.perform('clock_in');
    setClockRaw(hm(12));
    store.perform('clock_out');
    store.addWorkRange(DAY, '13:00', '15:00', '오후 작업', hm(16));

    expect(store.clearAddedWorkTime(DAY, hm(17))).toBe(true);
    expect(computeDay(store.logFor(DAY), hm(17)).actualMs).toBe(3 * HOUR_MS);
  });

  it('새로고침해도 더한 구간이 남는다 (기록이 추가뿐인 날도)', async () => {
    const kv = memoryStore();
    const first = await makeReadyStore(mock, kv);
    first.store.addWorkRange(DAY, '11:00', '17:00', '종일 외근', hm(18));

    const second = await makeReadyStore(mock, kv);
    const totals = computeDay(second.store.logFor(DAY), hm(18));
    expect(totals.extraMs).toBe(6 * HOUR_MS);
    expect(totals.extra?.segments).toEqual([{ start: hm(11), end: hm(17) }]);
  });

  it('더하면 그날이 Notion 동기화 대기열에 오른다', async () => {
    const { store } = await makeReadyStore(mock);

    store.addWorkRange(DAY, '11:00', '17:00', '노트북 작업', hm(18));
    expect(Object.keys(store.getSnapshot().state.outbox)).toContain(DAY);
  });
});

describe('주소로 직접 연 화면 (지난 기록 되살리기)', () => {
  /** 직원 · 이벤트로그 · 업무 리스트까지 갖춘 DB */
  function makeFullMock() {
    return new NotionMock({
      databaseId: DB_ID,
      title: '근무 기록',
      properties: {
        '기록명': { id: 'p1', type: 'title' },
        '근무 일자': { id: 'p2', type: 'date' },
        '출근 시각': { id: 'p3', type: 'rich_text' },
        '퇴근 시각': { id: 'p4', type: 'rich_text' },
        '실 근무시간': { id: 'p5', type: 'number' },
        '상태': { id: 'p6', type: 'select', options: [] },
        '직원': { id: 'p7', type: 'select', options: ['하정언', '박진규'] },
        '이벤트로그': { id: 'p8', type: 'rich_text' },
        '업무 리스트': { id: 'p9', type: 'rich_text' },
      },
    });
  }

  async function device(m: NotionMock, name: string) {
    const d = await makeReadyStore(m, memoryStore());
    d.store.setEmployeeName(name);
    return d;
  }

  /** 하루를 통째로 찍고 보낸다 */
  async function workDay(d: Awaited<ReturnType<typeof device>>, dateKey: string) {
    d.setClock(9, dateKey);
    d.store.perform('clock_in');
    d.setClock(18, dateKey);
    d.store.perform('clock_out');
    await d.store.drainOutbox();
  }

  it('저장소가 빈 화면도 지난 기록을 Notion 에서 받아 온다', async () => {
    const m = makeFullMock();
    installBackend(m);

    // 노션 위젯 쪽 브라우저에 며칠치가 쌓인다
    const widget = await device(m, '하정언');
    await workDay(widget, '2026-08-06');
    await workDay(widget, '2026-08-07');
    await workDay(widget, '2026-08-10');

    // 주소로 직접 연 화면은 저장소가 따로라 아무것도 모르는 상태로 시작한다
    const direct = await device(m, '하정언');
    expect(Object.keys(direct.store.getSnapshot().state.logs)).toHaveLength(0);

    await direct.store.pullRange('2026-08-01', '2026-08-31');

    const logs = direct.store.getSnapshot().state.logs;
    expect(Object.keys(logs).sort()).toEqual(['2026-08-06', '2026-08-07', '2026-08-10']);
    expect(computeDay(direct.store.logFor('2026-08-07'), t(19, '2026-08-07')).actualMs).toBe(
      9 * HOUR_MS,
    );
  });

  it('적어 둔 할 일도 함께 돌아온다', async () => {
    const m = makeFullMock();
    installBackend(m);

    const widget = await device(m, '하정언');
    widget.setClock(9, '2026-08-06');
    widget.store.addTodo('2026-08-06', '오프닝 콘티');
    await widget.store.drainOutbox();

    const direct = await device(m, '하정언');
    await direct.store.pullRange('2026-08-01', '2026-08-31');

    expect(direct.store.todosFor('2026-08-06').map((td) => td.text)).toEqual(['오프닝 콘티']);
  });

  it('다른 직원의 기록은 가져오지 않는다', async () => {
    const m = makeFullMock();
    installBackend(m);

    const park = await device(m, '박진규');
    await workDay(park, '2026-08-06');

    const ha = await device(m, '하정언');
    await ha.store.pullRange('2026-08-01', '2026-08-31');

    expect(Object.keys(ha.store.getSnapshot().state.logs)).toHaveLength(0);
  });

  it('기간 밖의 기록은 가져오지 않는다', async () => {
    const m = makeFullMock();
    installBackend(m);

    const widget = await device(m, '하정언');
    await workDay(widget, '2026-07-30');
    await workDay(widget, '2026-08-06');

    const direct = await device(m, '하정언');
    await direct.store.pullRange('2026-08-01', '2026-08-31');

    expect(Object.keys(direct.store.getSnapshot().state.logs)).toEqual(['2026-08-06']);
  });

  it('방금 받아온 기간 안이면 다시 묻지 않는다', async () => {
    const m = makeFullMock();
    installBackend(m);
    const direct = await device(m, '하정언');

    const queries = () => m.calls.filter((c) => c.path.endsWith('/query')).length;

    await direct.store.pullRange('2026-08-01', '2026-09-30');
    const after = queries();

    // 집계 탭이 보고 있는 달 — 위에서 받은 두 달 안에 들어 있다
    await direct.store.pullRange('2026-09-01', '2026-09-30');
    expect(queries()).toBe(after);

    // 사용자가 더 예전 달로 넘기면 그건 새로 받아야 한다
    await direct.store.pullRange('2026-07-01', '2026-07-31');
    expect(queries()).toBeGreaterThan(after);
  });

  it('로컬에만 있는 기록을 지우지 않는다', async () => {
    const m = makeFullMock();
    installBackend(m);

    const direct = await device(m, '하정언');
    direct.setClock(9, '2026-08-06');
    direct.store.perform('clock_in');

    // Notion 에는 아직 아무것도 없다 (동기화 전)
    await direct.store.pullRange('2026-08-01', '2026-08-31');

    expect(direct.store.logFor('2026-08-06').events).toHaveLength(1);
  });
});
