/**
 * "할 일이 빈 근무일" 알림 — 전체 화면 할 일 탭과 노션 위젯이 같이 쓴다.
 *
 * 왜 (CEO 2026-09-25): 할 일 목록이 수익 배분의 근거가 되면서, 적는 걸 잊은 날을 나중에 채울 수
 * 있어야 했다. 지난 날짜를 고르는 기능은 있었지만 어느 날이 비었는지는 사람이 달력을 하루씩
 * 눌러 봐야 알았다. 여기서 빈 날을 모아 보여 주고, 누르면 그날로 간다.
 *
 * 보는 범위는 지난달 1일 ~ 어제다. 인사 정산이 매달 5일에 지난달 기록을 마감하므로
 * (discord-os/src/core/hr-desk.js), 그 전까지는 지난달 빈 날도 채울 수 있어야 한다.
 */

import { useSnapshot, useStore } from '../hooks/useAppStore';
import { emptyTodoDays } from '../../shared/missingDays';
import { addMonths, formatDateKeyKo, monthDateKeys } from '../lib/time';

/** 지난달 1일 ~ 이번 달 말일 */
export function recentDateKeys(activeDate: string): string[] {
  const month = activeDate.slice(0, 7);
  return [...monthDateKeys(addMonths(month, -1)), ...monthDateKeys(month)];
}

export function EmptyDays({
  now,
  selected,
  onPick,
  compact = false,
  max = compact ? 4 : 12,
}: {
  now: number;
  selected: string;
  onPick: (dateKey: string) => void;
  compact?: boolean;
  max?: number;
}) {
  const store = useStore();
  const { state } = useSnapshot();
  const days = emptyTodoDays(state.logs, recentDateKeys(store.activeDate), store.activeDate, now);

  if (days.length === 0) {
    return (
      <p className={compact ? 'emptyDays emptyDays--compact' : 'field__hint'} data-testid="empty-days-none">
        ✓ 지난달부터 어제까지, 일한 날에는 할 일이 모두 적혀 있습니다.
      </p>
    );
  }

  // 오래된 날부터 채우게 한다 — 인사 마감이 먼저 닥치는 쪽이다.
  const shown = days.slice(0, max);
  const rest = days.length - shown.length;

  return (
    <div className={`emptyDays ${compact ? 'emptyDays--compact' : ''}`} data-testid="empty-days">
      <span className="emptyDays__label">
        할 일이 빈 근무일 <b data-testid="empty-days-count">{days.length}일</b>
        {compact ? '' : ' — 누르면 그날 목록으로 갑니다'}
      </span>
      <span className="emptyDays__chips">
        {shown.map((d) => (
          <button
            key={d}
            type="button"
            className={`emptyDays__chip ${d === selected ? 'emptyDays__chip--on' : ''}`}
            data-testid="empty-day"
            onClick={() => onPick(d)}
          >
            {compact ? d.slice(5).replace('-', '/') : formatDateKeyKo(d)}
          </button>
        ))}
        {rest > 0 && <span className="emptyDays__more">외 {rest}일</span>}
      </span>
    </div>
  );
}
