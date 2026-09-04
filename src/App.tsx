import { useEffect, useState } from 'react';
import { useNow } from './hooks/useNow';
import { useSnapshot, useStore } from './hooks/useAppStore';
import { HomePanel } from './components/HomePanel';
import { TodoPanel } from './components/TodoPanel';
import { VacationPanel } from './components/VacationPanel';
import { SummaryPanel } from './components/SummaryPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { WidgetPanel } from './components/WidgetPanel';
import { computeDay } from './lib/events';
import { DAY_MS, addMonths, formatClockSeconds, monthDateKeys, toDateKey, toMonthKey } from './lib/time';
import { Banner, StatusChip, UpdateBanner } from './components/ui';

type Tab = 'home' | 'todo' | 'vacation' | 'summary' | 'settings';

const TABS: Array<{ key: Tab; label: string; icon: string }> = [
  { key: 'home', label: '홈', icon: '🏠' },
  { key: 'todo', label: '할 일', icon: '📝' },
  { key: 'vacation', label: '휴가', icon: '🌴' },
  { key: 'summary', label: '집계', icon: '📊' },
  { key: 'settings', label: '설정', icon: '⚙️' },
];

/** 백그라운드에서 대기열을 비우는 주기 */
const DRAIN_INTERVAL_MS = 60_000;

/** 창으로 돌아올 때마다 Notion 을 읽지 않도록 두는 최소 간격 */
const PULL_THROTTLE_MS = 20_000;

/**
 * 위젯 모드에서 다른 기기 기록을 확인하는 주기.
 *
 * 임베드된 위젯은 Notion 페이지에 하루 종일 떠 있어서 focus/visibilitychange 가
 * 거의 발생하지 않는다. 그 상태로는 데스크탑에서 찍은 퇴근이 노트북 위젯에
 * 영영 안 보이므로, 위젯일 때만 주기적으로 읽는다.
 */
const WIDGET_PULL_INTERVAL_MS = 120_000;

export default function App({ widget = false }: { widget?: boolean }) {
  const store = useStore();
  const { state, runtime } = useSnapshot();
  const now = useNow(1000);
  const [tab, setTab] = useState<Tab>('home');

  const todayTotals = computeDay(store.logFor(store.activeDate), now);
  // Notion 을 아직 연결하지 않았다면 쌓인 기록은 "대기"가 아니라 그냥 로컬 기록이다.
  // 연결되지 않은 상태에서 배지를 띄우면 문제가 있는 것처럼 보이므로 감춘다.
  const pendingCount = runtime.backend === 'ready' ? Object.keys(state.outbox).length : 0;

  // 서버가 접근 키를 요구하는데 이 브라우저에는 없는 상태. 이러면 조회가 전부 401 이라
  // 기록이 하나도 안 뜨는데, 화면에는 아무 설명이 없었다.
  const needsAccessKey =
    runtime.backendInfo?.accessKeyRequired === true && state.notion.accessKey.trim() === '';

  // 백엔드 존재 여부는 시작 시 한 번 확인한다.
  useEffect(() => {
    void store.checkBackend();
  }, [store]);

  // 다른 기기(데스크탑/노트북)가 남긴 기록을 가져와 합친다.
  //
  // 앱을 열 때 한 번, 그리고 창으로 돌아올 때마다 확인한다 — 기기를 옮겨 앉는 순간이
  // 곧 "창을 다시 보는" 순간이기 때문이다. 자정을 넘긴 근무를 놓치지 않도록
  // 처음 열 때는 어제 날짜도 함께 본다. 읽기 전용이라 실패해도 잃는 것이 없다.
  useEffect(() => {
    void store.pullDay(toDateKey(Date.now()));
    void store.pullDay(toDateKey(Date.now() - DAY_MS));
    // 특별 휴가 부여는 다른 사람(대표)이 다른 기기에서 넣는다. 열 때마다 확인하지
    // 않으면 본인 화면의 잔여 휴가가 계속 옛날 값으로 남는다.
    void store.pullGrants();

    let lastPullAt = Date.now();
    const pull = () => {
      if (document.visibilityState === 'hidden') return;
      if (Date.now() - lastPullAt < PULL_THROTTLE_MS) return;
      lastPullAt = Date.now();
      void store.pullDay(store.activeDate);
      void store.pullGrants();
      void store.checkForUpdate();
    };
    document.addEventListener('visibilitychange', pull);
    window.addEventListener('focus', pull);
    return () => {
      document.removeEventListener('visibilitychange', pull);
      window.removeEventListener('focus', pull);
    };
  }, [store]);

  // 전체 화면은 지난 기록까지 Notion 에서 받아 온다.
  //
  // 노션 임베드 위젯과 주소로 직접 연 화면은 브라우저가 저장소를 갈라 놓아서
  // 서로의 기록을 못 본다. 하루치만 읽던 시절에는 그래서 전체 화면이 늘 텅 비어
  // 보였다 — 기록은 Notion 에 멀쩡히 있는데도.
  useEffect(() => {
    if (widget) return;
    const pullMonths = () => {
      if (document.visibilityState === 'hidden') return;
      const thisMonth = toMonthKey(Date.now());
      const start = monthDateKeys(addMonths(thisMonth, -1))[0]!;
      const end = monthDateKeys(thisMonth).slice(-1)[0]!;
      void store.pullRange(start, end);
    };
    pullMonths();
    window.addEventListener('focus', pullMonths);
    return () => window.removeEventListener('focus', pullMonths);
  }, [store, widget]);

  useEffect(() => {
    if (!widget) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void store.pullDay(store.activeDate);
      // 위젯은 노션 페이지가 닫히기 전까지 다시 로드되지 않는다. 새 배포를 스스로
      // 알아채지 못하면 고친 코드가 며칠씩 반영되지 않는다.
      void store.checkForUpdate();
    }, WIDGET_PULL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [store, widget]);

  // 실패한 동기화를 주기적으로/온라인 복귀 시 재시도한다.
  useEffect(() => {
    if (!state.notion.autoSync) return;

    const drain = () => {
      if (Object.keys(store.getSnapshot().state.outbox).length > 0) void store.drainOutbox();
    };
    const timer = setInterval(drain, DRAIN_INTERVAL_MS);
    window.addEventListener('online', drain);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', drain);
    };
  }, [store, state.notion.autoSync]);

  // 진행 중인 근무가 있으면 탭 제목에도 시간을 보여준다 (Notion 밖에서 열었을 때 유용).
  useEffect(() => {
    document.title = todayTotals.isLive
      ? `${formatHHMM(todayTotals.actualMs)} · 근무시간 관리`
      : '근무시간 관리';
  }, [todayTotals.isLive, Math.floor(todayTotals.actualMs / 60000)]);

  // Notion Embed 용 컴팩트 화면. 조작부만 남기고 탭/집계는 전체 화면에 맡긴다.
  if (widget) {
    return (
      <div className="app app--widget">
        <WidgetPanel now={now} />
        <Toast />
        <AutoDismiss />
      </div>
    );
  }

  return (
    <div className="app">
      <header className="header">
        <span className="header__mark" aria-hidden="true">
          ⏱
        </span>
        <div>
          <div className="header__title">근무시간 관리</div>
          <div className="header__date">{formatClockSeconds(now)} KST</div>
        </div>
        <span className="header__spacer" />
        <StatusChip status={todayTotals.status} testId="header-status-chip" />
      </header>

      {runtime.staleBuild && <UpdateBanner />}

      {/*
        접근 키가 없으면 서버가 모든 조회를 401 로 막는다. 그 실패는 조용히 넘어가도록
        돼 있어서(로컬 기록을 잃지 않기 위한 설계), 화면은 그냥 "기록이 없는 앱"처럼
        보였다 — 노션 위젯 링크에는 키가 실려 있고 주소로 직접 열면 없기 때문에,
        같은 사람이 같은 날 두 화면에서 전혀 다른 것을 보게 된다.
      */}
      {needsAccessKey && (
        <Banner kind="warn">
          이 브라우저에는 접근 키가 없어 Notion 기록을 불러오지 못합니다.{' '}
          <button type="button" className="banner__action" onClick={() => setTab('settings')}>
            설정 › 연결에서 접근 키 입력
          </button>
        </Banner>
      )}

      <nav className="nav" aria-label="주요 메뉴">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className="nav__item"
            aria-current={tab === t.key ? 'page' : undefined}
            data-testid={`tab-${t.key}`}
            onClick={() => setTab(t.key)}
          >
            <span className="nav__icon" aria-hidden="true">
              {t.icon}
            </span>
            <span>
              {t.label}
              {t.key === 'settings' && pendingCount > 0 ? ` (${pendingCount})` : ''}
            </span>
          </button>
        ))}
      </nav>

      <main className="app__body">
        {tab === 'home' && <HomePanel now={now} />}
        {tab === 'todo' && <TodoPanel now={now} />}
        {tab === 'vacation' && <VacationPanel now={now} />}
        {tab === 'summary' && <SummaryPanel now={now} />}
        {tab === 'settings' && <SettingsPanel />}
      </main>

      <Toast />

      <AutoDismiss />
    </div>
  );
}

function Toast() {
  const store = useStore();
  const { runtime } = useSnapshot();
  const notice = runtime.notice;
  if (!notice) return null;

  return (
    <div className={`toast toast--${notice.kind}`} role="status" data-testid="toast" key={notice.id}>
      <span>{notice.text}</span>
      <button
        type="button"
        className="toast__close"
        aria-label="알림 닫기"
        onClick={() => store.dismissNotice()}
      >
        ✕
      </button>
    </div>
  );
}

/** 토스트를 일정 시간 뒤 자동으로 닫는다 (오류는 더 오래 보여준다). */
function AutoDismiss() {
  const store = useStore();
  const { runtime } = useSnapshot();
  const notice = runtime.notice;

  useEffect(() => {
    if (!notice) return;
    const ms = notice.kind === 'error' ? 8000 : 3200;
    const timer = setTimeout(() => store.dismissNotice(), ms);
    return () => clearTimeout(timer);
  }, [notice?.id, notice?.kind, store]);

  return null;
}

function formatHHMM(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
