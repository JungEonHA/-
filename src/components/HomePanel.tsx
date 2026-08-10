import { computeDay, isStaleSession, type DayLog, type WorkStatus } from '../lib/events';
import { summarizeMonth, summarizeWeek } from '../lib/aggregate';
import { computeBalance } from '../lib/vacation';
import {
  formatClock,
  formatDuration,
  formatDurationKo,
  formatDateKeyKo,
  toDateKey,
  HOUR_MS,
} from '../lib/time';
import { useStore, useSnapshot } from '../hooks/useAppStore';
import { Banner, Card, StatusChip, Tile } from './ui';

/**
 * 홈: 실시간 타이머 + 출퇴근 조작 + 오늘/주/월 요약.
 * 타이머 값은 저장된 timestamp 와 `now` 로부터 매 렌더마다 재계산된다.
 */
export function HomePanel({ now }: { now: number }) {
  const store = useStore();
  const { state } = useSnapshot();

  const activeDate = store.activeDate;
  const log: DayLog = store.logFor(activeDate);
  const today = computeDay(log, now);
  const stale = isStaleSession(today, now);

  const week = summarizeWeek(state.logs, now);
  const month = summarizeMonth(state.logs, now);
  const balance = computeBalance(state.logs, state.vacation, activeDate.slice(0, 7));

  const timerClass =
    today.status === 'working' ? 'hero__timer hero__timer--live'
      : today.status === 'away' ? 'hero__timer hero__timer--away'
        : 'hero__timer';

  const caption =
    today.status === 'not_started' ? '출근 버튼을 누르면 근무시간이 시작됩니다'
      : today.status === 'away' ? '자리 비움 중 — 근무시간이 멈춰 있습니다'
        : today.status === 'finished' ? '오늘 근무가 확정되었습니다 — 필요하면 업무에 복귀할 수 있습니다'
          : '실시간 근무시간이 측정되고 있습니다';

  return (
    <div className="stack">
      {stale && (
        <Banner kind="warn">
          {formatDateKeyKo(activeDate)}에 출근한 기록이 20시간 넘게 열려 있습니다. 퇴근 처리를
          잊지 않으셨나요?
        </Banner>
      )}

      <section className="card hero">
        <div className="hero__greeting">
          <b>{formatDateKeyKo(activeDate)}</b>
          {activeDate !== toDateKey(now) && ' (자정을 넘긴 근무)'}
        </div>

        <div className={timerClass} data-testid="work-timer" aria-live="off">
          {formatDuration(today.actualMs)}
        </div>
        <div className="hero__caption">{caption}</div>
        <div className="mt12">
          <StatusChip status={today.status} />
        </div>

        <div className="hero__meta">
          <div className="hero__metaItem">
            <div className="hero__metaLabel">출근</div>
            <div className="hero__metaValue mono" data-testid="clock-in-at">
              {today.clockInAt === null ? '--:--' : formatClock(today.clockInAt)}
            </div>
          </div>
          <div className="hero__metaItem">
            <div className="hero__metaLabel">퇴근</div>
            <div className="hero__metaValue mono" data-testid="clock-out-at">
              {today.clockOutAt === null ? '--:--' : formatClock(today.clockOutAt)}
            </div>
          </div>
          <div className="hero__metaItem">
            <div className="hero__metaLabel">자리 비움</div>
            <div className="hero__metaValue mono" data-testid="away-total">
              {formatDuration(today.awayMs)}
            </div>
          </div>
        </div>
      </section>

      <ActionButtons status={today.status} />

      <Card title="오늘 집계">
        <div className="tiles">
          <Tile label="실제 근무" value={formatDurationKo(today.actualMs)} testId="today-actual" />
          <Tile label="휴가 대체" value={formatDurationKo(today.vacationMs)} testId="today-vacation" />
          <Tile
            label="인정 근무"
            value={formatDurationKo(today.creditedMs)}
            accent
            testId="today-credited"
          />
          <Tile label="자리 비움" value={formatDurationKo(today.awayMs)} />
        </div>
        {today.resumeCount > 0 && (
          <p className="field__hint mt12" data-testid="resume-note">
            퇴근 후 {today.resumeCount}회 복귀 · 퇴근~복귀 사이{' '}
            {formatDurationKo(today.pausedMs)}는 근무시간에서 제외했습니다.
          </p>
        )}
      </Card>

      <div className="grid-2">
        <Card title="이번 주" hint="월~일">
          <div className="tiles">
            <Tile label="실제 근무" value={formatDurationKo(week.actualMs)} testId="week-actual" />
            <Tile label="휴가" value={formatDurationKo(week.vacationMs)} />
            <Tile label="인정 근무" value={formatDurationKo(week.creditedMs)} accent testId="week-credited" />
          </div>
        </Card>

        <Card title="이번 달">
          <div className="tiles">
            <Tile label="실제 근무" value={formatDurationKo(month.actualMs)} testId="month-actual" />
            <Tile label="휴가" value={formatDurationKo(month.vacationMs)} />
            <Tile label="인정 근무" value={formatDurationKo(month.creditedMs)} accent testId="month-credited" />
          </div>
        </Card>
      </div>

      <Card title="휴가 잔여" hint={`매월 ${state.vacation.monthlyGrantMs / HOUR_MS}시간 지급 · 이월`}>
        <div className="tiles">
          <Tile label="사용 가능" value={formatDurationKo(balance.available)} />
          <Tile label="이번 달 사용" value={formatDurationKo(balance.usedThisMonth)} />
          <Tile label="잔여" value={formatDurationKo(balance.remaining)} accent testId="home-vacation-remaining" />
        </div>
      </Card>
    </div>
  );
}

function ActionButtons({ status }: { status: WorkStatus }) {
  const store = useStore();

  if (status === 'not_started') {
    return (
      <button
        type="button"
        className="btn btn--primary btn--block btn--lg"
        data-testid="btn-clock-in"
        onClick={() => store.perform('clock_in')}
      >
        업무 시작 (출근)
      </button>
    );
  }

  // 퇴근 뒤에도 되돌릴 수 있어야 한다. 퇴근 버튼을 잘못 눌렀거나, 일이 남아
  // 다시 자리에 앉는 일이 실제로 흔하다. 복귀하면 근무시간이 이어서 누적된다.
  if (status === 'finished') {
    return (
      <div className="stack">
        <button type="button" className="btn btn--block btn--lg" disabled data-testid="btn-finished">
          오늘 근무 완료
        </button>
        <button
          type="button"
          className="btn btn--primary btn--block btn--lg"
          data-testid="btn-resume"
          onClick={() => store.perform('resume')}
        >
          업무 복귀하기
        </button>
        <p className="field__hint">
          퇴근을 잘못 눌렀거나 일을 더 하게 됐다면 누르세요. 지금부터 근무시간이 다시 쌓입니다.
          퇴근~복귀 사이 시간은 근무시간에 포함되지 않습니다.
        </p>
      </div>
    );
  }

  return (
    <div className="btnRow">
      {status === 'working' ? (
        <button
          type="button"
          className="btn btn--away btn--lg"
          data-testid="btn-away-start"
          onClick={() => store.perform('away_start')}
        >
          자리 비움
        </button>
      ) : (
        <button
          type="button"
          className="btn btn--primary btn--lg"
          data-testid="btn-away-end"
          onClick={() => store.perform('away_end')}
        >
          복귀하기
        </button>
      )}
      <button
        type="button"
        className="btn btn--danger btn--lg"
        data-testid="btn-clock-out"
        onClick={() => store.perform('clock_out')}
      >
        퇴근하기
      </button>
    </div>
  );
}
