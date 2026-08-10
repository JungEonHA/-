import { describe, expect, it } from 'vitest';
import {
  BACKUP_KEY,
  STORAGE_KEY,
  createInitialState,
  loadState,
  normalizeState,
  saveState,
  type AppState,
  type KeyValueStore,
} from './storage';
import { HOUR_MS, dateKeyToEpoch } from './time';

export function memoryStore(initial: Record<string, string> = {}): KeyValueStore & {
  dump: () => Record<string, string>;
  failNextWrite: (msg?: string) => void;
} {
  const map = new Map(Object.entries(initial));
  let failure: string | null = null;
  return {
    persistent: true,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      if (failure) {
        const msg = failure;
        failure = null;
        throw new Error(msg);
      }
      map.set(k, v);
    },
    dump: () => Object.fromEntries(map),
    failNextWrite: (msg = 'QuotaExceededError') => {
      failure = msg;
    },
  };
}

const NOW = dateKeyToEpoch('2026-08-10') + 9 * HOUR_MS;

function sampleState(): AppState {
  const base = createInitialState(NOW);
  return {
    ...base,
    logs: {
      '2026-08-10': {
        date: '2026-08-10',
        vacationMs: 2 * HOUR_MS,
        events: [
          { type: 'clock_in', at: NOW },
          { type: 'clock_out', at: NOW + 8 * HOUR_MS },
        ],
      },
    },
  };
}

describe('저장 / 복원', () => {
  it('저장한 상태를 그대로 되읽는다 (새로고침 복구)', () => {
    const store = memoryStore();
    saveState(store, sampleState());

    const restored = loadState(store, NOW);
    expect(restored.logs['2026-08-10']?.events).toHaveLength(2);
    expect(restored.logs['2026-08-10']?.vacationMs).toBe(2 * HOUR_MS);
  });

  it('저장소가 비어 있으면 초기 상태를 준다', () => {
    expect(loadState(memoryStore(), NOW).logs).toEqual({});
  });

  it('주 슬롯이 깨졌으면 백업 슬롯으로 복구한다', () => {
    const store = memoryStore({
      [STORAGE_KEY]: '{{{ 깨진 JSON',
      [BACKUP_KEY]: JSON.stringify(sampleState()),
    });
    expect(Object.keys(loadState(store, NOW).logs)).toEqual(['2026-08-10']);
  });

  it('두 슬롯 다 깨졌으면 초기 상태로 시작하고 예외를 던지지 않는다', () => {
    const store = memoryStore({ [STORAGE_KEY]: 'x', [BACKUP_KEY]: 'y' });
    expect(() => loadState(store, NOW)).not.toThrow();
    expect(loadState(store, NOW).logs).toEqual({});
  });

  it('저장 성공 후에만 백업을 갱신한다', () => {
    const store = memoryStore();
    saveState(store, createInitialState(NOW)); // 1회차: 이전 값 없음
    expect(store.dump()[BACKUP_KEY]).toBeUndefined();

    saveState(store, sampleState()); // 2회차: 1회차 값이 백업으로
    const backup = JSON.parse(store.dump()[BACKUP_KEY]!);
    expect(backup.logs).toEqual({});
  });

  it('저장 실패를 예외 없이 보고한다', () => {
    const store = memoryStore();
    store.failNextWrite('QuotaExceededError');
    const result = saveState(store, sampleState());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Quota');
  });
});

describe('손상된 데이터 정규화', () => {
  it('알 수 없는 이벤트 타입과 NaN 시각을 버린다', () => {
    const state = normalizeState(
      {
        logs: {
          '2026-08-10': {
            date: '2026-08-10',
            vacationMs: 0,
            events: [
              { type: 'clock_in', at: NOW },
              { type: '점심', at: NOW + 1000 },
              { type: 'clock_out', at: 'oops' },
              { type: 'clock_out', at: NOW + 3600_000 },
            ],
          },
        },
      },
      NOW,
    );
    const events = state.logs['2026-08-10']!.events;
    expect(events.map((e) => e.type)).toEqual(['clock_in', 'clock_out']);
  });

  it('이벤트를 시간순으로 정렬해 저장한다', () => {
    const state = normalizeState(
      {
        logs: {
          '2026-08-10': {
            date: '2026-08-10',
            vacationMs: 0,
            events: [
              { type: 'clock_out', at: NOW + 1000 },
              { type: 'clock_in', at: NOW },
            ],
          },
        },
      },
      NOW,
    );
    expect(state.logs['2026-08-10']!.events[0]!.type).toBe('clock_in');
  });

  it('날짜 형식이 잘못된 키와 빈 로그는 제거한다', () => {
    const state = normalizeState(
      {
        logs: {
          '아무거나': { date: 'x', events: [{ type: 'clock_in', at: NOW }], vacationMs: 0 },
          '2026-08-10': { date: '2026-08-10', events: [], vacationMs: 0 },
        },
      },
      NOW,
    );
    expect(state.logs).toEqual({});
  });

  it('음수 휴가시간은 0으로 보정한다', () => {
    const state = normalizeState(
      {
        logs: {
          '2026-08-10': {
            date: '2026-08-10',
            events: [{ type: 'clock_in', at: NOW }],
            vacationMs: -100,
          },
        },
      },
      NOW,
    );
    expect(state.logs['2026-08-10']!.vacationMs).toBe(0);
  });

  it('휴가 설정이 없거나 이상하면 기본값으로 되돌린다', () => {
    const state = normalizeState({ vacation: { grantStartMonth: '엉망', monthlyGrantMs: -5 } }, NOW);
    expect(state.vacation.grantStartMonth).toBe('2026-08');
    expect(state.vacation.monthlyGrantMs).toBe(8 * HOUR_MS);
  });

  it('완전히 엉뚱한 입력도 초기 상태로 처리한다', () => {
    expect(normalizeState(null, NOW).version).toBe(1);
    expect(normalizeState('문자열', NOW).logs).toEqual({});
    expect(normalizeState(42, NOW).outbox).toEqual({});
  });
});
