import { describe, expect, it } from 'vitest';
import {
  applyAction,
  computeDay,
  emptyDayLog,
  isStaleSession,
  resolveActiveDate,
  type ActionKind,
  type DayLog,
} from './events';
import { HOUR_MS, MINUTE_MS, dateKeyToEpoch } from './time';

/** KST 기준 "HH:mm" 을 2026-08-10 의 epoch 로 */
function at(hhmm: string, dateKey = '2026-08-10'): number {
  const [h, m] = hhmm.split(':').map(Number);
  return dateKeyToEpoch(dateKey) + (h ?? 0) * HOUR_MS + (m ?? 0) * MINUTE_MS;
}

function run(actions: Array<[ActionKind, string]>, dateKey = '2026-08-10'): DayLog {
  let log = emptyDayLog(dateKey);
  for (const [action, hhmm] of actions) {
    const res = applyAction(log, action, at(hhmm, dateKey));
    if (!res.ok) throw new Error(res.reason);
    log = res.log;
  }
  return log;
}

describe('근무시간 계산', () => {
  it('사양 예시: 09:00 출근 / 12:00 자리비움 / 13:00 복귀 / 18:00 퇴근 = 8시간', () => {
    const log = run([
      ['clock_in', '09:00'],
      ['away_start', '12:00'],
      ['away_end', '13:00'],
      ['clock_out', '18:00'],
    ]);
    const totals = computeDay(log, at('23:00'));

    expect(totals.actualMs).toBe(8 * HOUR_MS);
    expect(totals.awayMs).toBe(1 * HOUR_MS);
    expect(totals.creditedMs).toBe(8 * HOUR_MS);
    expect(totals.status).toBe('finished');
    expect(totals.awayCount).toBe(1);
    expect(totals.isLive).toBe(false);
  });

  it('자리 비움이 여러 번이어도 각각 제외된다', () => {
    const log = run([
      ['clock_in', '09:00'],
      ['away_start', '11:00'],
      ['away_end', '11:30'],
      ['away_start', '12:00'],
      ['away_end', '13:00'],
      ['clock_out', '18:00'],
    ]);
    const t = computeDay(log, at('20:00'));
    expect(t.actualMs).toBe(7 * HOUR_MS + 30 * MINUTE_MS);
    expect(t.awayMs).toBe(90 * MINUTE_MS);
    expect(t.awayCount).toBe(2);
  });

  it('근무 중에는 now 까지 실시간으로 늘어난다', () => {
    const log = run([['clock_in', '09:00']]);
    expect(computeDay(log, at('09:00')).actualMs).toBe(0);
    expect(computeDay(log, at('12:34')).actualMs).toBe(3 * HOUR_MS + 34 * MINUTE_MS);
    expect(computeDay(log, at('12:34')).status).toBe('working');
    expect(computeDay(log, at('12:34')).isLive).toBe(true);
  });

  it('자리 비움 중에는 근무시간이 멈추고 자리비움만 늘어난다', () => {
    const log = run([
      ['clock_in', '09:00'],
      ['away_start', '12:00'],
    ]);

    const t1 = computeDay(log, at('13:00'));
    const t2 = computeDay(log, at('15:00'));

    expect(t1.actualMs).toBe(3 * HOUR_MS);
    expect(t2.actualMs).toBe(3 * HOUR_MS); // 멈춰 있다
    expect(t1.awayMs).toBe(1 * HOUR_MS);
    expect(t2.awayMs).toBe(3 * HOUR_MS); // 자리비움만 증가
    expect(t2.status).toBe('away');
  });

  it('자리 비움 상태에서 바로 퇴근하면 그 구간은 전부 자리비움이다', () => {
    const log = run([
      ['clock_in', '09:00'],
      ['away_start', '12:00'],
      ['clock_out', '14:00'],
    ]);
    const t = computeDay(log, at('20:00'));
    expect(t.actualMs).toBe(3 * HOUR_MS);
    expect(t.awayMs).toBe(2 * HOUR_MS);
    expect(t.status).toBe('finished');
  });

  it('휴가는 실제 근무와 분리되고 인정 근무에 합산된다', () => {
    const log = run([
      ['clock_in', '09:00'],
      ['clock_out', '13:00'],
    ]);
    const withVacation: DayLog = { ...log, vacationMs: 4 * HOUR_MS };
    const t = computeDay(withVacation, at('20:00'));

    expect(t.actualMs).toBe(4 * HOUR_MS);
    expect(t.vacationMs).toBe(4 * HOUR_MS);
    expect(t.creditedMs).toBe(8 * HOUR_MS);
  });
});

describe('백그라운드 / 절전 / 새로고침 내성', () => {
  it('now 를 크게 건너뛰어도(절전) 실제 경과시간이 그대로 반영된다', () => {
    const log = run([['clock_in', '09:00']]);

    // 절전으로 인터벌이 한 번도 돌지 않은 채 6시간이 지난 상황
    const afterSleep = computeDay(log, at('15:00'));
    expect(afterSleep.actualMs).toBe(6 * HOUR_MS);

    // 중간 값을 한 번도 계산하지 않았어도 결과는 동일하다 (누적 카운터가 아님)
    const stepwise = [at('10:00'), at('11:00'), at('12:00')].map((t) => computeDay(log, t).actualMs);
    expect(stepwise).toEqual([HOUR_MS, 2 * HOUR_MS, 3 * HOUR_MS]);
    expect(computeDay(log, at('15:00')).actualMs).toBe(6 * HOUR_MS);
  });

  it('같은 이벤트 로그는 몇 번을 다시 계산해도 같은 값을 준다 (멱등)', () => {
    const log = run([
      ['clock_in', '09:00'],
      ['away_start', '12:00'],
      ['away_end', '13:00'],
      ['clock_out', '18:00'],
    ]);
    const results = Array.from({ length: 5 }, () => computeDay(log, at('19:00')).actualMs);
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe(8 * HOUR_MS);
  });

  it('시계가 뒤로 가도 음수 시간이 생기지 않는다', () => {
    const log = run([['clock_in', '09:00']]);
    const t = computeDay(log, at('08:00')); // now 가 출근보다 이전
    expect(t.actualMs).toBe(0);
  });

  it('이벤트 순서가 뒤섞여 저장돼도 시간순으로 정렬해 계산한다', () => {
    const scrambled: DayLog = {
      date: '2026-08-10',
      vacationMs: 0,
      events: [
        { type: 'clock_out', at: at('18:00') },
        { type: 'clock_in', at: at('09:00') },
        { type: 'away_end', at: at('13:00') },
        { type: 'away_start', at: at('12:00') },
      ],
    };
    expect(computeDay(scrambled, at('20:00')).actualMs).toBe(8 * HOUR_MS);
  });
});

describe('상태 전이 검증', () => {
  it('출근 전에는 자리비움/복귀/퇴근을 할 수 없다', () => {
    const log = emptyDayLog('2026-08-10');
    for (const action of ['away_start', 'away_end', 'clock_out'] as ActionKind[]) {
      const res = applyAction(log, action, at('09:00'));
      expect(res.ok).toBe(false);
    }
  });

  it('중복 출근은 거부된다', () => {
    const log = run([['clock_in', '09:00']]);
    expect(applyAction(log, 'clock_in', at('10:00')).ok).toBe(false);
  });

  it('근무 중에 복귀는 거부된다', () => {
    const log = run([['clock_in', '09:00']]);
    expect(applyAction(log, 'away_end', at('10:00')).ok).toBe(false);
  });

  it('자리 비움 중에 자리 비움은 거부된다', () => {
    const log = run([
      ['clock_in', '09:00'],
      ['away_start', '12:00'],
    ]);
    expect(applyAction(log, 'away_start', at('12:30')).ok).toBe(false);
  });

  it('퇴근 후에는 어떤 동작도 할 수 없다', () => {
    const log = run([
      ['clock_in', '09:00'],
      ['clock_out', '18:00'],
    ]);
    for (const action of ['clock_in', 'away_start', 'away_end', 'clock_out'] as ActionKind[]) {
      expect(applyAction(log, action, at('19:00')).ok).toBe(false);
    }
  });

  it('시계 역행 시에도 이벤트 시각의 단조성이 유지된다', () => {
    const log = run([['clock_in', '12:00']]);
    const res = applyAction(log, 'away_start', at('11:00')); // 과거 시각
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.log.events[1]!.at).toBe(at('12:00')); // 앞 이벤트 시각으로 clamp
      expect(computeDay(res.log, at('13:00')).actualMs).toBe(0);
    }
  });

  it('원본 로그를 변경하지 않는다', () => {
    const log = run([['clock_in', '09:00']]);
    const before = log.events.length;
    applyAction(log, 'clock_out', at('18:00'));
    expect(log.events.length).toBe(before);
  });
});

describe('활성 근무일 / 장시간 세션', () => {
  it('자정을 넘겨 근무 중이면 출근한 날짜가 활성 근무일이다', () => {
    const log = run([['clock_in', '22:00']], '2026-08-10');
    const logs = { '2026-08-10': log };
    const nextDay2am = at('02:00', '2026-08-11');

    expect(resolveActiveDate(logs, nextDay2am)).toBe('2026-08-10');
    expect(computeDay(log, nextDay2am).actualMs).toBe(4 * HOUR_MS);
  });

  it('열린 세션이 없으면 오늘이 활성 근무일이다', () => {
    const log = run([
      ['clock_in', '09:00'],
      ['clock_out', '18:00'],
    ]);
    expect(resolveActiveDate({ '2026-08-10': log }, at('10:00', '2026-08-11'))).toBe('2026-08-11');
  });

  it('20시간을 넘긴 열린 세션은 경고 대상이다', () => {
    const log = run([['clock_in', '09:00']]);
    expect(isStaleSession(computeDay(log, at('20:00')), at('20:00'))).toBe(false);
    const late = at('09:00', '2026-08-11');
    expect(isStaleSession(computeDay(log, late), late)).toBe(true);
  });
});
