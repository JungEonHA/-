import { describe, expect, it } from 'vitest';
import { isStaleBuild } from './build';

describe('낡은 화면 판정', () => {
  it('서버가 다른 커밋을 내려주면 이 화면은 낡은 것이다', () => {
    expect(isStaleBuild('9f2c1a04', 'e497da49')).toBe(true);
  });

  it('같은 커밋이면 낡지 않았다', () => {
    expect(isStaleBuild('e497da49', 'e497da49')).toBe(false);
  });

  it('로컬 개발 화면은 절대 낡았다고 하지 않는다 (서버 값과 같아질 수 없다)', () => {
    expect(isStaleBuild('e497da49', 'dev')).toBe(false);
  });

  it('build 를 안 내려주는 배포에서는 판정하지 않는다', () => {
    expect(isStaleBuild(null, 'e497da49')).toBe(false);
    expect(isStaleBuild(undefined, 'e497da49')).toBe(false);
    expect(isStaleBuild('', 'e497da49')).toBe(false);
  });
});
