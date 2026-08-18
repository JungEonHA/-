import { useState } from 'react';
import { useSnapshot, useStore } from '../hooks/useAppStore';
import { summarizeMonth, summarizeWeek } from '../lib/aggregate';
import {
  HOUR_MS,
  WEEKDAY_LABELS_KO,
  addMonths,
  dayOfWeek,
  formatClock,
  formatDurationKo,
  formatMonthKeyKo,
  shiftDateKey,
  toDateKey,
  toMonthKey,
} from '../lib/time';
import { STATUS_LABEL_KO, computeDay } from '../lib/events';
import { Banner, Card, EmptyState, Tile } from './ui';

/** 정정한 시각을 "8/18 14:30" 형태로 */
function formatCorrectedAt(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())} 정정`;
}

/** 주간 막대 높이의 기준(=100%)이 되는 하루 근무시간 */
const BAR_FULL_MS = 8 * HOUR_MS;

export function SummaryPanel({ now }: { now: number }) {
  const store = useStore();
  const { state } = useSnapshot();
  const [weekAnchor, setWeekAnchor] = useState(() => toDateKey(now));
  const [monthKey, setMonthKey] = useState(() => toMonthKey(now));

  const [fixDate, setFixDate] = useState(() => toDateKey(now));
  const [fixHours, setFixHours] = useState('8');
  const [fixReason, setFixReason] = useState('');

  const week = summarizeWeek(state.logs, now, weekAnchor);
  const month = summarizeMonth(state.logs, now, monthKey);
  const todayKey = toDateKey(now);

  // 0시간으로 정정한 날도 보여야 한다 — 안 그러면 정정하는 순간 목록에서 사라져서
  // 되돌릴 방법이 없어진다.
  const monthRows = month.days.filter((d) => d.actualMs > 0 || d.vacationMs > 0 || d.corrected);

  // 정정 이력은 달과 무관하게 전부 모아 최신순으로 보여 준다.
  const corrections = Object.values(state.logs)
    .filter((log) => log?.correction)
    .map((log) => ({ date: log.date, totals: computeDay(log, now) }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  // 정정하려는 날의 현재 값 — 무엇을 무엇으로 바꾸는지 미리 보여 준다.
  const fixTarget = state.logs[fixDate] ? computeDay(state.logs[fixDate]!, now) : null;

  return (
    <div className="stack">
      <Card
        title="이번 주"
        hint={`${week.weekStart.slice(5).replace('-', '.')} ~ ${shiftDateKey(week.weekStart, 6)
          .slice(5)
          .replace('-', '.')}`}
        action={
          <div className="segmented">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setWeekAnchor((d) => shiftDateKey(d, -7))}
              aria-label="이전 주"
            >
              ‹
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setWeekAnchor(todayKey)}
            >
              이번 주
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setWeekAnchor((d) => shiftDateKey(d, 7))}
              aria-label="다음 주"
            >
              ›
            </button>
          </div>
        }
      >
        <div className="week" data-testid="week-chart">
          {week.days.map((day) => {
            const workPct = Math.min(100, (day.actualMs / BAR_FULL_MS) * 100);
            const vacPct = Math.min(100 - workPct, (day.vacationMs / BAR_FULL_MS) * 100);
            return (
              <div className="weekDay" key={day.date}>
                <div className="weekDay__value">
                  {day.creditedMs > 0 ? (day.creditedMs / HOUR_MS).toFixed(1) : '-'}
                </div>
                <div
                  className="weekDay__bar"
                  title={`${day.date} 인정 ${formatDurationKo(day.creditedMs)}`}
                >
                  <div
                    className="weekDay__fill weekDay__fill--vacation"
                    style={{ height: `${vacPct}%` }}
                  />
                  <div
                    className="weekDay__fill weekDay__fill--work"
                    style={{ height: `${workPct}%` }}
                  />
                </div>
                <div
                  className={`weekDay__label ${day.date === todayKey ? 'weekDay__label--today' : ''}`}
                >
                  {WEEKDAY_LABELS_KO[dayOfWeek(day.date)]}
                </div>
              </div>
            );
          })}
        </div>

        <div className="legend">
          <span className="legend__key">
            <span className="legend__swatch" style={{ background: 'var(--primary)' }} />
            실제 근무
          </span>
          <span className="legend__key">
            <span className="legend__swatch" style={{ background: 'var(--away)' }} />
            휴가
          </span>
        </div>

        <div className="tiles mt16">
          <Tile label="주간 실제 근무" value={formatDurationKo(week.actualMs)} testId="sum-week-actual" />
          <Tile label="주간 휴가" value={formatDurationKo(week.vacationMs)} testId="sum-week-vacation" />
          <Tile
            label="주간 인정 근무"
            value={formatDurationKo(week.creditedMs)}
            accent
            testId="sum-week-credited"
          />
        </div>
      </Card>

      <Card
        title="이번 달"
        hint={formatMonthKeyKo(monthKey)}
        action={
          <div className="segmented">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setMonthKey((m) => addMonths(m, -1))}
              aria-label="이전 달"
            >
              ‹
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setMonthKey(toMonthKey(now))}
            >
              이번 달
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setMonthKey((m) => addMonths(m, 1))}
              aria-label="다음 달"
            >
              ›
            </button>
          </div>
        }
      >
        <div className="tiles">
          <Tile label="월간 실제 근무" value={formatDurationKo(month.actualMs)} testId="sum-month-actual" />
          <Tile label="월간 휴가" value={formatDurationKo(month.vacationMs)} testId="sum-month-vacation" />
          <Tile
            label="월간 인정 근무"
            value={formatDurationKo(month.creditedMs)}
            accent
            testId="sum-month-credited"
          />
          <Tile label="근무일수" value={`${month.workedDays}일`} />
        </div>
      </Card>

      <Card title="근무시간 정정" hint="퇴근을 못 찍은 날 바로잡기">
        <Banner kind="info">
          퇴근을 찍지 않으면 그날 기록이 계속 열려 있어 근무시간이 실제와 달라집니다. 아래에서
          실제 근무한 시간으로 바로잡으세요. <b>수정 전 값과 사유는 그대로 남습니다.</b>
        </Banner>

        <div className="field mt12">
          <label className="field__label" htmlFor="fix-date">
            날짜
          </label>
          <input
            id="fix-date"
            className="input"
            type="date"
            value={fixDate}
            data-testid="fix-date"
            onChange={(e) => e.target.value && setFixDate(e.target.value)}
          />
          <span className="field__hint" data-testid="fix-current">
            {fixTarget
              ? `현재 실근무 ${formatDurationKo(fixTarget.actualMs)} · ${STATUS_LABEL_KO[fixTarget.status]}`
              : '이 날짜에는 기록이 없습니다. 정정하면 새로 만들어집니다.'}
          </span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="fix-hours">
            실제 근무시간
          </label>
          <input
            id="fix-hours"
            className="input"
            type="number"
            min="0"
            max="24"
            step="0.5"
            value={fixHours}
            data-testid="fix-hours"
            onChange={(e) => setFixHours(e.target.value)}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="fix-reason">
            정정 사유
          </label>
          <input
            id="fix-reason"
            className="input"
            type="text"
            placeholder="예: 퇴근 찍는 것을 잊음"
            value={fixReason}
            data-testid="fix-reason"
            onChange={(e) => setFixReason(e.target.value)}
          />
        </div>

        <div className="btnRow mt8">
          <button
            type="button"
            className="btn btn--primary"
            data-testid="btn-fix-apply"
            disabled={!fixReason.trim() || fixHours === ''}
            onClick={() => {
              if (store.correctWorkTime(fixDate, Number(fixHours), fixReason)) setFixReason('');
            }}
          >
            근무시간 정정
          </button>
          {fixTarget?.corrected && (
            <button
              type="button"
              className="btn btn--ghost"
              data-testid="btn-fix-clear"
              onClick={() => store.clearCorrection(fixDate)}
            >
              정정 취소
            </button>
          )}
        </div>
      </Card>

      <Card title="정정 이력" hint={`${corrections.length}건`}>
        {corrections.length === 0 ? (
          <EmptyState>아직 정정한 기록이 없습니다.</EmptyState>
        ) : (
          <div className="list" data-testid="correction-history">
            {corrections.map(({ date, totals }) => (
              <div className="listRow" key={date}>
                <div className="listRow__main">
                  <div className="listRow__title">
                    {date.slice(5)} ({WEEKDAY_LABELS_KO[dayOfWeek(date)]}) · ✏️ 정정됨
                  </div>
                  <div className="listRow__sub">
                    수정 전 <b>{formatDurationKo(totals.correction!.beforeMs)}</b>
                    {' → '}
                    <b>{formatDurationKo(totals.correction!.actualMs)}</b>
                    {totals.correctedAt ? ` · ${formatCorrectedAt(totals.correctedAt)}` : ''}
                  </div>
                  {totals.correction!.reason && (
                    <div className="listRow__sub">사유: {totals.correction!.reason}</div>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => store.clearCorrection(date)}
                >
                  되돌리기
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="일별 상세" hint={formatMonthKeyKo(monthKey)}>
        {monthRows.length === 0 ? (
          <EmptyState>이 달에는 아직 기록이 없습니다.</EmptyState>
        ) : (
          <div className="list" data-testid="month-detail">
            {monthRows.map((day) => (
              <div className="listRow" key={day.date}>
                <div className="listRow__main">
                  <div className="listRow__title">
                    {day.date.slice(5)} ({WEEKDAY_LABELS_KO[dayOfWeek(day.date)]})
                  </div>
                  <div className="listRow__sub">
                    {day.clockInAt === null ? '—' : formatClock(day.clockInAt)}
                    {' ~ '}
                    {day.clockOutAt === null ? '진행 중' : formatClock(day.clockOutAt)}
                    {day.awayMs > 0 && ` · 비움 ${formatDurationKo(day.awayMs)}`}
                    {day.vacationMs > 0 && ` · 휴가 ${formatDurationKo(day.vacationMs)}`}
                    {` · ${STATUS_LABEL_KO[day.status]}`}
                    {day.corrected && ' · ✏️ 정정됨'}
                  </div>
                  {day.corrected && day.correction && (
                    <div className="listRow__sub" data-testid={`corrected-${day.date}`}>
                      수정 전 {formatDurationKo(day.correction.beforeMs)}
                      {' → '}
                      {formatDurationKo(day.correction.actualMs)}
                      {day.correction.reason && ` · ${day.correction.reason}`}
                    </div>
                  )}
                </div>
                <div className="listRow__value">{formatDurationKo(day.creditedMs)}</div>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  data-testid={`btn-fix-${day.date}`}
                  onClick={() => {
                    setFixDate(day.date);
                    setFixHours(String(Math.round((day.actualMs / HOUR_MS) * 100) / 100));
                  }}
                >
                  정정
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
