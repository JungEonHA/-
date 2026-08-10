import { useEffect, useState } from 'react';
import { useNow } from './hooks/useNow';
import { useSnapshot, useStore } from './hooks/useAppStore';
import { HomePanel } from './components/HomePanel';
import { VacationPanel } from './components/VacationPanel';
import { SummaryPanel } from './components/SummaryPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { computeDay } from './lib/events';
import { formatClockSeconds } from './lib/time';
import { StatusChip } from './components/ui';

type Tab = 'home' | 'vacation' | 'summary' | 'settings';

const TABS: Array<{ key: Tab; label: string; icon: string }> = [
  { key: 'home', label: '홈', icon: '🏠' },
  { key: 'vacation', label: '휴가', icon: '🌴' },
  { key: 'summary', label: '집계', icon: '📊' },
  { key: 'settings', label: '설정', icon: '⚙️' },
];

/** 백그라운드에서 대기열을 비우는 주기 */
const DRAIN_INTERVAL_MS = 60_000;

export default function App() {
  const store = useStore();
  const { state, runtime } = useSnapshot();
  const now = useNow(1000);
  const [tab, setTab] = useState<Tab>('home');

  const todayTotals = computeDay(store.logFor(store.activeDate), now);
  const pendingCount = Object.keys(state.outbox).length;

  // 백엔드 존재 여부는 시작 시 한 번 확인한다.
  useEffect(() => {
    void store.checkBackend();
  }, [store]);

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
        {tab === 'vacation' && <VacationPanel now={now} />}
        {tab === 'summary' && <SummaryPanel now={now} />}
        {tab === 'settings' && <SettingsPanel />}
      </main>

      {runtime.notice && (
        <div
          className={`toast toast--${runtime.notice.kind}`}
          role="status"
          data-testid="toast"
          key={runtime.notice.id}
        >
          <span>{runtime.notice.text}</span>
          <button
            type="button"
            className="toast__close"
            aria-label="알림 닫기"
            onClick={() => store.dismissNotice()}
          >
            ✕
          </button>
        </div>
      )}

      <AutoDismiss />
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
