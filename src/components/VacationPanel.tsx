import { useEffect, useState } from 'react';
import { useSnapshot, useStore } from '../hooks/useAppStore';
import { computeBalance, vacationHistory } from '../lib/vacation';
import {
  HOUR_MS,
  WEEKDAY_LABELS_KO,
  addMonths,
  dayOfWeek,
  formatDateKeyKo,
  formatDurationKo,
  formatMonthKeyKo,
  toDateKey,
  toMonthKey,
} from '../lib/time';
import { dailyTargetHours } from '../../shared/dailyTargets';
import { GRANTOR_NAME, canGrantVacation } from '../../shared/grants';
import { Banner, Card, EmptyState, Tile } from './ui';

const PRESET_HOURS: readonly number[] = [1, 2, 4, 8];

/** 부여 사유로 자주 쓰는 것들. 눌러서 채우고 그대로 고쳐 쓸 수 있다. */
const REASON_PRESETS = ['특별 휴가', '개인 일정', '천재지변', '집안 사정', '포상'] as const;

/**
 * 휴가 화면.
 * 잔여량은 저장된 값이 아니라 "지급 누계 − 사용 누계"로 매번 다시 계산한다.
 */
export function VacationPanel({ now }: { now: number }) {
  const store = useStore();
  const { state } = useSnapshot();

  const [monthKey, setMonthKey] = useState(() => toMonthKey(now));
  const [dateKey, setDateKey] = useState(() => toDateKey(now));

  // 쓰는 쪽도 같은 표를 본다. 부여만 자동이면 정작 하루에 얹을 때 또 손으로 적게 된다.
  const useTargetHours = dailyTargetHours(state.notion.employeeName, dateKey);
  const [hours, setHours] = useState<number>(() => useTargetHours ?? 1);
  useEffect(() => {
    if (useTargetHours !== null) setHours(useTargetHours);
  }, [dateKey, useTargetHours]);

  const [grantDate, setGrantDate] = useState(() => toDateKey(now));
  const [grantReason, setGrantReason] = useState('');
  const [granting, setGranting] = useState(false);
  // 기본값은 자기 자신이다. 남의 계정을 기본으로 두면 무심코 눌렀을 때 엉뚱한
  // 사람에게 휴가가 꽂힌다 — 옮기는 것보다 되돌리는 쪽이 늘 번거롭다.
  const [grantTarget, setGrantTarget] = useState(() => state.notion.employeeName.trim());

  // 그 사람이 그 요일에 채워야 하는 시간. 휴가는 이 시간을 메워 주는 것이므로
  // 부여량은 거의 항상 이 값이다 — 손으로 적게 하면 틀릴 여지만 생긴다.
  const grantTargetHours = dailyTargetHours(grantTarget, grantDate);
  const [grantHours, setGrantHours] = useState<string>(() => String(grantTargetHours ?? 8));

  // 대상이나 날짜를 바꾸면 그 요일 기준으로 다시 채운다.
  //
  // 채운 뒤에 사람이 고친 값은 그대로 둔다 (타이핑은 이 효과를 다시 돌리지 않는다).
  // 예외적인 부여 — 반차처럼 표와 다른 시간 — 을 막지 않기 위해서다.
  useEffect(() => {
    if (grantTargetHours !== null) setGrantHours(String(grantTargetHours));
  }, [grantTarget, grantDate, grantTargetHours]);

  const balance = computeBalance(state.logs, state.vacation, monthKey, state.grants);
  const monthGrants = state.grants.filter((g) => g.dateKey.slice(0, 7) === monthKey);
  const history = vacationHistory(state.logs);
  const dayUsed = state.logs[dateKey]?.vacationMs ?? 0;

  // 부여는 대표만 한다 (상급자 결재). 나머지 사람에게는 폼 자체를 감춘다.
  const isGrantor = canGrantVacation(state.notion.employeeName);
  // 대상 후보는 노션 `직원` select 의 선택지를 그대로 쓴다 — 사람이 늘어도 코드를
  // 고칠 필요가 없다. 스키마를 아직 못 읽었으면 최소한 본인은 고를 수 있게 둔다.
  const employeeProp = state.notion.mapping.employee;
  const employeeOptions =
    state.notion.schema?.properties.find((p) => p.name === employeeProp)?.options ?? [];
  const targetChoices = employeeOptions.length
    ? employeeOptions
    : [state.notion.employeeName.trim()].filter(Boolean);

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
          <Tile
            label="특별 부여"
            value={formatDurationKo(balance.extraThisMonth)}
            testId="vac-extra"
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
            대체하여 <b>인정 근무시간</b>에 합산됩니다. 개인 일정·천재지변처럼 사유가 있는 휴가는
            아래 <b>특별 휴가 부여</b>로 따로 얹습니다 — 매달 지급량은 그대로 두고 그 달에만 더해집니다.
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
            {/* 그 요일에 채워야 하는 시간. 프리셋에 이미 있는 값이면 따로 내지 않는다. */}
            {useTargetHours !== null && !PRESET_HOURS.includes(useTargetHours) && (
              <button
                type="button"
                className={`btn btn--sm ${hours === useTargetHours ? 'btn--primary' : 'btn--ghost'}`}
                data-testid="vac-preset-target"
                onClick={() => setHours(useTargetHours)}
              >
                {useTargetHours}시간
              </button>
            )}
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
          {useTargetHours !== null && (
            <span className="field__hint" data-testid="vac-target-hint">
              {WEEKDAY_LABELS_KO[dayOfWeek(dateKey)]}요일에 채워야 하는 시간은{' '}
              <b>{useTargetHours}시간</b>이라 그 값으로 맞춰 두었습니다.
            </span>
          )}
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

      <Card
        title="특별 휴가 부여"
        hint={`${formatMonthKeyKo(monthKey)} ${monthGrants.length}건`}
        action={
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            data-testid="btn-grant-refresh"
            onClick={() => void store.pullGrants({ notify: true })}
          >
            새로고침
          </button>
        }
      >
        {!isGrantor && (
          <Banner kind="info">
            특별 휴가 부여는 {GRANTOR_NAME} 만 할 수 있습니다. 필요하면 {GRANTOR_NAME} 에게
            요청하세요. 아래 목록에서 내게 부여된 내역은 그대로 볼 수 있습니다.
          </Banner>
        )}

        {isGrantor && (
        <>
        <div className="field">
          <label className="field__label" htmlFor="grant-target">
            부여 대상
          </label>
          <select
            id="grant-target"
            className="input"
            value={grantTarget}
            data-testid="grant-target"
            onChange={(e) => setGrantTarget(e.target.value)}
          >
            {targetChoices.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <span className="field__hint">이 사람의 잔여 휴가에 더해집니다.</span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="grant-date">
            기준일
          </label>
          <input
            id="grant-date"
            className="input"
            type="date"
            value={grantDate}
            data-testid="grant-date"
            onChange={(e) => e.target.value && setGrantDate(e.target.value)}
          />
          <span className="field__hint">이 날이 속한 달부터 쓸 수 있습니다.</span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="grant-hours">
            부여 시간
          </label>
          <input
            id="grant-hours"
            className="input"
            type="number"
            min="0.5"
            step="0.5"
            value={grantHours}
            data-testid="grant-hours"
            onChange={(e) => setGrantHours(e.target.value)}
          />
          <span className="field__hint" data-testid="grant-hours-hint">
            {grantTargetHours === null ? (
              <>
                {grantTarget || '이 사람'}의 요일별 근무시간이 등록되어 있지 않아 자동으로 채우지
                못합니다. 직접 입력하세요.
              </>
            ) : (
              <>
                {WEEKDAY_LABELS_KO[dayOfWeek(grantDate)]}요일 {grantTarget} 기준{' '}
                <b>{grantTargetHours}시간</b>으로 채웠습니다. 반차처럼 다르게 줄 때만 고치세요.
              </>
            )}
          </span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="grant-reason">
            사유
          </label>
          <input
            id="grant-reason"
            className="input"
            type="text"
            placeholder="예: 특별 휴가"
            value={grantReason}
            data-testid="grant-reason"
            onChange={(e) => setGrantReason(e.target.value)}
          />
          <div className="segmented mt8">
            {REASON_PRESETS.map((r) => (
              <button
                key={r}
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setGrantReason(r)}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        <div className="btnRow mt8">
          <button
            type="button"
            className="btn btn--primary"
            data-testid="btn-grant-add"
            disabled={granting || !grantTarget || !grantReason.trim() || !(Number(grantHours) > 0)}
            onClick={() => {
              setGranting(true);
              void store
                .grantVacation({
                  dateKey: grantDate,
                  hours: Number(grantHours),
                  reason: grantReason.trim(),
                  targetEmployee: grantTarget,
                })
                .then((ok) => {
                  if (ok) setGrantReason('');
                })
                .finally(() => setGranting(false));
            }}
          >
            {granting ? '부여 중…' : '특별 휴가 부여'}
          </button>
        </div>

        <p className="field__hint mt12">
          사유는 반드시 남겨야 합니다. 부여 내역은 Notion 에 행으로 저장됩니다. 아래 목록과
          잔여 휴가는 <b>내게 부여된 것</b>만 세므로, 다른 사람에게 준 내역은 그 사람 화면과
          Notion 표에서 확인하세요.
        </p>
        </>
        )}

        <div className="mt12">
          {monthGrants.length === 0 ? (
            <EmptyState>이 달에 부여된 특별 휴가가 없습니다.</EmptyState>
          ) : (
            <div className="list" data-testid="grant-list">
              {monthGrants.map((g) => (
                <div className="listRow" key={g.id}>
                  <div className="listRow__main">
                    <div className="listRow__title">{g.reason || '(사유 없음)'}</div>
                    <div className="listRow__sub">{formatDateKeyKo(g.dateKey)}</div>
                  </div>
                  <div className="listRow__value">{formatDurationKo(g.ms)}</div>
                  {isGrantor && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => void store.revokeVacationGrant(g.id)}
                  >
                    부여 취소
                  </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
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
