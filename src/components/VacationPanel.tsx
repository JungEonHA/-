import { useState } from 'react';
import { useSnapshot, useStore } from '../hooks/useAppStore';
import { computeBalance, vacationHistory } from '../lib/vacation';
import {
  HOUR_MS,
  addMonths,
  formatDateKeyKo,
  formatDurationKo,
  formatMonthKeyKo,
  toDateKey,
  toMonthKey,
} from '../lib/time';
import { Banner, Card, EmptyState, Tile } from './ui';

const PRESET_HOURS = [1, 2, 4, 8] as const;

/**
 * 휴가 화면.
 * 잔여량은 저장된 값이 아니라 "지급 누계 − 사용 누계"로 매번 다시 계산한다.
 */
export function VacationPanel({ now }: { now: number }) {
  const store = useStore();
  const { state } = useSnapshot();

  const [monthKey, setMonthKey] = useState(() => toMonthKey(now));
  const [dateKey, setDateKey] = useState(() => toDateKey(now));
  const [hours, setHours] = useState<number>(1);

  const balance = computeBalance(state.logs, state.vacation, monthKey);
  const history = vacationHistory(state.logs);
  const dayUsed = state.logs[dateKey]?.vacationMs ?? 0;

  return (
    <div className="stack">
      <Card
        title="휴가 현황"
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
              onClick={() => setMonthKey((m) => addMonths(m, 1))}
              aria-label="다음 달"
            >
              ›
            </button>
          </div>
        }
      >
        <div className="tiles">
          <Tile
            label="이번 달 지급"
            value={formatDurationKo(balance.grantedThisMonth)}
            testId="vac-granted"
          />
          <Tile label="이월" value={formatDurationKo(balance.carriedIn)} testId="vac-carried" />
          <Tile
            label="사용 가능"
            value={formatDurationKo(balance.available)}
            testId="vac-available"
          />
          <Tile
            label="이번 달 사용"
            value={formatDurationKo(balance.usedThisMonth)}
            testId="vac-used"
          />
          <Tile
            label="잔여"
            value={formatDurationKo(balance.remaining)}
            accent
            testId="vac-remaining"
          />
        </div>

        <div className="mt12">
          <Banner kind="info">
            사용하지 않은 휴가는 소멸하지 않고 다음 달로 이월됩니다. 휴가 시간은 실제 근무시간을
            대체하여 <b>인정 근무시간</b>에 합산됩니다.
          </Banner>
        </div>
      </Card>

      <Card title="휴가 사용 / 취소">
        <div className="field">
          <label className="field__label" htmlFor="vac-date">
            날짜
          </label>
          <input
            id="vac-date"
            className="input"
            type="date"
            value={dateKey}
            data-testid="vac-date"
            onChange={(e) => e.target.value && setDateKey(e.target.value)}
          />
          <span className="field__hint">
            {formatDateKeyKo(dateKey)} · 현재 사용량 {formatDurationKo(dayUsed)}
          </span>
        </div>

        <div className="field">
          <span className="field__label">시간</span>
          <div className="segmented">
            {PRESET_HOURS.map((h) => (
              <button
                key={h}
                type="button"
                className={`btn btn--sm ${hours === h ? 'btn--primary' : 'btn--ghost'}`}
                data-testid={`vac-preset-${h}`}
                onClick={() => setHours(h)}
              >
                {h}시간
              </button>
            ))}
          </div>
        </div>

        <div className="btnRow mt8">
          <button
            type="button"
            className="btn btn--primary"
            data-testid="btn-vac-use"
            onClick={() => store.changeVacation(dateKey, hours * HOUR_MS)}
          >
            휴가 사용
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            data-testid="btn-vac-cancel"
            onClick={() => store.changeVacation(dateKey, -hours * HOUR_MS)}
          >
            휴가 취소
          </button>
        </div>

        <p className="field__hint mt12">
          하루 최대 {state.vacation.dailyCapMs / HOUR_MS}시간까지 사용할 수 있으며, 잔여 휴가를
          초과하면 사용할 수 없습니다. 변경 사항은 Notion에도 함께 반영됩니다.
        </p>
      </Card>

      <Card title="사용 내역" hint="최근 12건">
        {history.length === 0 ? (
          <EmptyState>아직 사용한 휴가가 없습니다.</EmptyState>
        ) : (
          <div className="list" data-testid="vac-history">
            {history.map((h) => (
              <div className="listRow" key={h.dateKey}>
                <div className="listRow__main">
                  <div className="listRow__title">{formatDateKeyKo(h.dateKey)}</div>
                  <div className="listRow__sub">{h.dateKey}</div>
                </div>
                <div className="listRow__value">{formatDurationKo(h.ms)}</div>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => store.changeVacation(h.dateKey, -h.ms)}
                >
                  전체 취소
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
