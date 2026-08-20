import { describe, expect, it } from 'vitest';
import { buildGrantMessage, mentionFor, notifyGrant, parseUserIds } from '../api/_discord';

const IDS = '하정언:996435919865401474,박진규:615060326127239171';
const WEBHOOK = { WEBHOOK_WORKTIME_ID: '123', WEBHOOK_WORKTIME_TOKEN: 'tok', DISCORD_USER_IDS: IDS };

const NOTICE = {
  employeeName: '박진규',
  dateKey: '2026-08-20',
  hours: 3,
  reason: '개인 일정',
  grantedBy: '하정언',
};

/** 웹훅 호출을 가로채 본문을 들여다보는 목 */
function spyFetch(res: Partial<Response> = { ok: true }) {
  const calls: Array<{ url: string; body: any }> = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
    return { ok: true, status: 200, text: async () => '', ...res } as Response;
  };
  return { calls, impl };
}

describe('이름 → 디스코드 id', () => {
  it('쉼표로 나열한 표를 읽는다', () => {
    const map = parseUserIds(IDS);
    expect(map.get('하정언')).toBe('996435919865401474');
    expect(map.get('박진규')).toBe('615060326127239171');
  });

  it('형식이 깨진 항목만 버리고 나머지는 살린다', () => {
    const map = parseUserIds('하정언:996435919865401474, 이상한사람, 박진규:없는id');
    expect(map.get('하정언')).toBe('996435919865401474');
    expect(map.has('박진규')).toBe(false);
    expect(map.size).toBe(1);
  });

  it('id 를 아는 사람은 멘션, 모르는 사람은 이름만 (알림 자체는 나가야 한다)', () => {
    const map = parseUserIds(IDS);
    expect(mentionFor('하정언', map)).toBe('<@996435919865401474>');
    expect(mentionFor('김아무개', map)).toBe('**김아무개**');
  });
});

describe('부여 알림 문구', () => {
  it('대상·시간·기준일·사유가 모두 담긴다', () => {
    const text = buildGrantMessage(NOTICE, parseUserIds(IDS));
    expect(text).toContain('<@615060326127239171>');
    expect(text).toContain('**3시간**');
    expect(text).toContain('8월 20일(목)');
    expect(text).toContain('개인 일정');
    expect(text).toContain('2026년 8월부터 쓸 수 있습니다');
  });

  it('소수 시간도 읽히게 적는다', () => {
    expect(buildGrantMessage({ ...NOTICE, hours: 1.5 }, new Map())).toContain('**1.5시간**');
  });

  it('사유의 줄바꿈·마크다운은 한 줄로 눌러서 레이아웃을 지킨다', () => {
    const text = buildGrantMessage({ ...NOTICE, reason: '집안\n**사정**' }, new Map());
    expect(text).toContain('사유 **집안 사정**');
    expect(text.split('\n')).toHaveLength(4);
  });
});

describe('전송', () => {
  it('웹훅이 없으면 보내지 않고 그 사실을 돌려준다 (부여는 그대로 성공해야 한다)', async () => {
    const { calls, impl } = spyFetch();
    const res = await notifyGrant({}, NOTICE, impl);
    expect(res).toEqual({ sent: false, reason: 'not_configured' });
    expect(calls).toHaveLength(0);
  });

  it('부여 대상 한 명만 멘션 대상으로 넘긴다', async () => {
    const { calls, impl } = spyFetch();
    await notifyGrant(WEBHOOK, NOTICE, impl);

    expect(calls[0]!.url).toBe('https://discord.com/api/webhooks/123/tok');
    expect(calls[0]!.body.allowed_mentions).toEqual({
      parse: [],
      users: ['615060326127239171'],
    });
  });

  it('사유에 @everyone 을 적어도 전체 알림이 가지 않는다', async () => {
    const { calls, impl } = spyFetch();
    await notifyGrant(WEBHOOK, { ...NOTICE, reason: '@everyone 다들 보세요' }, impl);

    // 두 겹으로 막는다 — 글자를 바꾸고, 멘션 파싱도 끈다.
    expect(calls[0]!.body.content).not.toContain('@everyone');
    expect(calls[0]!.body.allowed_mentions.parse).toEqual([]);
  });

  it('디스코드가 거절해도 던지지 않고 실패만 알린다', async () => {
    const impl = async () => ({ ok: false, status: 404, text: async () => 'unknown webhook' }) as Response;
    const res = await notifyGrant(WEBHOOK, NOTICE, impl);
    expect(res.sent).toBe(false);
    expect(res).toMatchObject({ reason: 'failed' });
  });

  it('네트워크가 끊겨도 던지지 않는다', async () => {
    const impl = async () => {
      throw new Error('fetch failed');
    };
    const res = await notifyGrant(WEBHOOK, NOTICE, impl);
    expect(res).toEqual({ sent: false, reason: 'failed', detail: 'fetch failed' });
  });
});
