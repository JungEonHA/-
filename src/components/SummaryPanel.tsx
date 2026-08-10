import { useState } from 'react';
import { useSnapshot } from '../hooks/useAppStore';
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
import { STATUS_LABEL_KO } from '../lib/events';
import { Card, EmptyState, Tile } from './ui';

/** 주간 막대 높이의 기준(=100%)이 되는 하루 근무시간 */
const BAR_FULL_MS = 8 * HOUR_MS;

export function SummaryPanel({ now }: { now: number }) {
  const { state } = useSnapshot();
  const [weekAnchor, setWeekAnchor] = useState(() => toDateKey(now));
  const [monthKey, setMonthKey] = useState(() => toMonthKey(now));

  const week = summarizeWeek(state.logs, now, weekAnchor);
  const month = summarizeMonth(state.logs, now, monthKey);
  const todayKey = toDateKey(now);

  const monthRows = month.days.filter((d) => d.actualMs > 0 || d.vacationMs > 0);

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
                  </div>
                </div>
                <div className="listRow__value">{formatDurationKo(day.creditedMs)}</div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
