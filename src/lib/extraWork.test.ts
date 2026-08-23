import { describe, expect, it } from 'vitest';
import { computeDay, resolveAddedRange, segmentsTotalMs, subtractSegments, type DayLog } from './events';
import { mergeDayLogs, parseDayLog, sameDayLog, serializeDayLog } from '../../shared/dayLog';
import { HOUR_MS, dateKeyToEpoch } from './time';

const D = '2026-08-23';
const base = dateKeyToEpoch(D);
const at = (h: number, m = 0) => base + h * HOUR_MS + m * 60000;

/** 09:00~12:00 근무하고 퇴근한 평범한 하루 (3시간) */
function workedThreeHours(): DayLog {
  return {
    date: D,
    events: [
      { type: 'clock_in', at: at(9) },
      { type: 'clock_out', at: at(12) },
    ],
    vacationMs: 0,
  };
}

describe('근무시간 추가', () => {
  it('찍힌 시간 위에 그대로 얹힌다', () => {
    const log: DayLog = { ...workedThreeHours(), extraAt: at(13), extra: { ms: 2 * HOUR_MS, reason: '노트북 작업' } };
    const t = computeDay(log, at(14));

    expect(t.actualMs).toBe(5 * HOUR_MS);
    expect(t.extraMs).toBe(2 * HOUR_MS);
    expect(t.extra?.reason).toBe('노트북 작업');
    expect(t.creditedMs).toBe(5 * HOUR_MS);
  });

  it('**근무 중인 날에 더해도 타이머가 멈추지 않는다** (정정과 결정적으로 다른 점)', () => {
    const log: DayLog = {
      date: D,
      events: [{ type: 'clock_in', at: at(9) }],
      vacationMs: 0,
      extraAt: at(10),
      extra: { ms: 2 * HOUR_MS, reason: '오전 외부 미팅' },
    };

    const t = computeDay(log, at(11));
    expect(t.status).toBe('working');
    expect(t.isLive).toBe(true);
    // 09:00~11:00 찍힘 + 2시간 추가
    expect(t.actualMs).toBe(4 * HOUR_MS);

    // 시간이 흐르면 찍힌 쪽만 늘어난다 (추가분은 고정)
    const later = computeDay(log, at(12));
    expect(later.actualMs).toBe(5 * HOUR_MS);
    expect(later.extraMs).toBe(2 * HOUR_MS);
  });

  it('이벤트가 하나도 없는 날에도 더할 수 있다 (타이머를 아예 안 켠 날)', () => {
    const log: DayLog = { date: D, events: [], vacationMs: 0, extraAt: at(20), extra: { ms: 3 * HOUR_MS, reason: '종일 외근' } };
    const t = computeDay(log, at(21));

    expect(t.actualMs).toBe(3 * HOUR_MS);
    expect(t.status).toBe('not_started'); // 상태는 찍힌 기록이 정한다 — 추가가 지어내지 않는다
    expect(t.isLive).toBe(false);
  });

  it('정정과 겹쳐 써도 서로를 먹지 않는다 (정정은 구간을 깎고, 추가는 그 위에 얹는다)', () => {
    const log: DayLog = {
      date: D,
      events: [
        { type: 'clock_in', at: at(9) },
        { type: 'clock_out', at: at(20) }, // 퇴근을 늦게 찍어 11시간으로 부풀어 있음
      ],
      vacationMs: 0,
      correctionAt: at(21),
      correction: {
        actualMs: 3 * HOUR_MS,
        beforeMs: 11 * HOUR_MS,
        reason: '퇴근 찍는 것을 잊음',
        segments: [{ start: at(9), end: at(12) }],
      },
      extraAt: at(21, 30),
      extra: { ms: 2 * HOUR_MS, reason: '저녁에 노트북 작업' },
    };

    const t = computeDay(log, at(22));
    // 정정으로 확정한 3시간 + 따로 더한 2시간
    expect(t.actualMs).toBe(5 * HOUR_MS);
    expect(t.corrected).toBe(true);
    expect(t.extraMs).toBe(2 * HOUR_MS);
  });

  it('추가가 없거나 0이면 아무 영향이 없다', () => {
    expect(computeDay(workedThreeHours(), at(13)).actualMs).toBe(3 * HOUR_MS);
    expect(computeDay(workedThreeHours(), at(13)).extraMs).toBe(0);
    expect(computeDay(workedThreeHours(), at(13)).extra).toBeNull();

    const zero: DayLog = { ...workedThreeHours(), extraAt: at(13), extra: { ms: 0, reason: 'x' } };
    expect(computeDay(zero, at(14)).actualMs).toBe(3 * HOUR_MS);
    expect(computeDay(zero, at(14)).extra).toBeNull();
  });
});

describe('기기 간 동기화', () => {
  it('노션 텍스트로 나갔다 돌아와도 그대로다', () => {
    const log: DayLog = {
      ...workedThreeHours(),
      updatedAt: at(13),
      extraAt: at(13),
      extra: {
        ms: 2.5 * HOUR_MS,
        reason: '외부 미팅 · 이동',
        segments: [{ start: at(13), end: at(15, 30) }],
      },
    };
    const back = parseDayLog(D, serializeDayLog(log))!;

    expect(back.extra).toEqual({
      ms: 2.5 * HOUR_MS,
      reason: '외부 미팅 · 이동',
      segments: [{ start: at(13), end: at(15, 30) }],
    });
    expect(back.extraAt).toBe(at(13));
    expect(sameDayLog(log, back)).toBe(true);
  });

  it('취소한 사실도 실려 나간다 — 그래야 다른 기기의 옛 추가를 이긴다', () => {
    const cleared: DayLog = { ...workedThreeHours(), extraAt: at(15) };
    const back = parseDayLog(D, serializeDayLog(cleared))!;

    expect(back.extraAt).toBe(at(15));
    expect(back.extra).toBeUndefined();
  });

  it('병합은 나중에 손댄 쪽을 따른다 — **더하지 않는다**', () => {
    const early: DayLog = { ...workedThreeHours(), extraAt: at(13), extra: { ms: 2 * HOUR_MS, reason: '먼저' } };
    const late: DayLog = { ...workedThreeHours(), extraAt: at(14), extra: { ms: 3 * HOUR_MS, reason: '나중' } };

    // 양쪽 값을 더하면 한 기기가 두 번 동기화되기만 해도 시간이 불어난다.
    expect(mergeDayLogs(early, late)!.extra).toEqual({ ms: 3 * HOUR_MS, reason: '나중' });
    expect(mergeDayLogs(late, early)!.extra).toEqual({ ms: 3 * HOUR_MS, reason: '나중' });
  });

  it('나중에 취소했으면 취소가 이긴다', () => {
    const added: DayLog = { ...workedThreeHours(), extraAt: at(13), extra: { ms: 2 * HOUR_MS, reason: '추가' } };
    const cleared: DayLog = { ...workedThreeHours(), extraAt: at(15) };

    expect(mergeDayLogs(added, cleared)!.extra).toBeUndefined();
    expect(mergeDayLogs(cleared, added)!.extra).toBeUndefined();
  });

  it('추가만 다른 로그는 "달라진 것"으로 본다 (안 그러면 받아 놓고 저장하지 않는다)', () => {
    const a = workedThreeHours();
    const b: DayLog = { ...a, extraAt: at(13), extra: { ms: HOUR_MS, reason: '추가' } };
    expect(sameDayLog(a, b)).toBe(false);
  });
});

describe('구간 해석', () => {
  it('"11:00~17:00" 은 그날 6시간이다', () => {
    const r = resolveAddedRange(D, '11:00', '17:00')!;
    expect(r).toEqual({ start: at(11), end: at(17) });
    expect(r.end - r.start).toBe(6 * HOUR_MS);
  });

  it('끝이 앞서면 자정을 넘긴 것으로 본다', () => {
    const r = resolveAddedRange(D, '22:00', '02:00')!;
    expect(r.end - r.start).toBe(4 * HOUR_MS);
    expect(r.end).toBe(at(26)); // 다음날 02:00
  });

  it('같은 시각은 길이 0이지 24시간이 아니다 (오타가 하루를 만들어 내면 안 된다)', () => {
    expect(resolveAddedRange(D, '11:00', '11:00')).toBeNull();
  });

  it('형식이 아니면 null', () => {
    expect(resolveAddedRange(D, '25:00', '17:00')).toBeNull();
    expect(resolveAddedRange(D, '11:70', '17:00')).toBeNull();
    expect(resolveAddedRange(D, '', '17:00')).toBeNull();
    expect(resolveAddedRange(D, '아침', '저녁')).toBeNull();
  });
});

describe('겹치는 구간 빼기', () => {
  const range = { start: at(11), end: at(17) };

  it('가운데가 겹치면 앞뒤 두 조각이 남는다', () => {
    const left = subtractSegments(range, [{ start: at(13), end: at(14) }]);
    expect(left).toEqual([
      { start: at(11), end: at(13) },
      { start: at(14), end: at(17) },
    ]);
    expect(segmentsTotalMs(left)).toBe(5 * HOUR_MS);
  });

  it('앞이 겹치면 뒤만 남는다', () => {
    expect(subtractSegments(range, [{ start: at(9), end: at(12) }])).toEqual([
      { start: at(12), end: at(17) },
    ]);
  });

  it('통째로 덮이면 아무것도 안 남는다', () => {
    expect(subtractSegments(range, [{ start: at(9), end: at(18) }])).toEqual([]);
  });

  it('안 겹치면 그대로다', () => {
    expect(subtractSegments(range, [{ start: at(18), end: at(20) }])).toEqual([range]);
  });

  it('겹치는 구간이 여러 개여도 순서와 무관하게 맞는다', () => {
    const busy = [
      { start: at(15), end: at(16) },
      { start: at(12), end: at(13) },
    ];
    expect(segmentsTotalMs(subtractSegments(range, busy))).toBe(4 * HOUR_MS);
  });
});
