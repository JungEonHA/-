import { describe, expect, it } from 'vitest';
import { dailyTargetHours } from '../../shared/dailyTargets';

/** 2026-08-17(월) ~ 2026-08-23(일) 한 주 */
const 월 = '2026-08-17';
const 화 = '2026-08-18';
const 수 = '2026-08-19';
const 목 = '2026-08-20';
const 금 = '2026-08-21';
const 토 = '2026-08-22';
const 일 = '2026-08-23';

describe('요일별 최소 근무시간', () => {
  it('하정언은 평일 6시간, 주말 8시간', () => {
    expect([월, 화, 수, 목, 금].map((d) => dailyTargetHours('하정언', d))).toEqual([6, 6, 6, 6, 6]);
    expect([토, 일].map((d) => dailyTargetHours('하정언', d))).toEqual([8, 8]);
  });

  it('박진규는 월/수/금 1시간, 화/목 3시간, 주말 6시간', () => {
    expect([월, 수, 금].map((d) => dailyTargetHours('박진규', d))).toEqual([1, 1, 1]);
    expect([화, 목].map((d) => dailyTargetHours('박진규', d))).toEqual([3, 3]);
    expect([토, 일].map((d) => dailyTargetHours('박진규', d))).toEqual([6, 6]);
  });

  it('실제 부여 사례와 합계가 맞는다 (2026-08-13 박진규 16시간: 목3+금1+토6+일6)', () => {
    const days = ['2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16'];
    const total = days.reduce((sum, d) => sum + (dailyTargetHours('박진규', d) ?? 0), 0);
    expect(total).toBe(16);
  });

  it('앞뒤 공백은 무시한다 (설정 화면에서 붙여넣기로 들어오는 일이 흔하다)', () => {
    expect(dailyTargetHours('  하정언 ', 목)).toBe(6);
  });

  it('표에 없는 사람은 null — 부여를 막지 않고 손입력으로 물러난다', () => {
    expect(dailyTargetHours('김아무개', 목)).toBeNull();
    expect(dailyTargetHours('', 목)).toBeNull();
    expect(dailyTargetHours(null, 목)).toBeNull();
    expect(dailyTargetHours(undefined, 목)).toBeNull();
  });
});
