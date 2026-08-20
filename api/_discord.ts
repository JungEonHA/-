/**
 * 특별 휴가 부여를 디스코드 `⏰-근무현황` 채널에 알린다.
 *
 * 왜 서버에서 보내는가 — 웹훅 URL 은 그걸 아는 사람이면 누구나 채널에 글을 쓸 수 있는
 * 열쇠다. 브라우저에서 보내면 번들에 박혀 그대로 새어 나간다. 부여는 이미 서버를
 * 거쳐 노션에 쓰이므로, 알림도 같은 자리에서 보낸다.
 *
 * 왜 실패해도 부여는 성공시키는가 — 휴가가 실제로 부여됐다는 사실은 노션 행이 정한다.
 * 디스코드가 잠깐 죽었다고 그 행을 되돌리면, 사람은 "부여가 안 됐다"고 믿는데 잔량은
 * 늘어 있는 최악의 상태가 된다. 알림은 부가물이므로 결과만 함께 돌려주고 넘어간다.
 *
 * 웹훅은 discord-os 가 이미 만들어 둔 근무현황 채널 웹훅을 그대로 쓴다
 * (`WEBHOOK_WORKTIME_ID` / `WEBHOOK_WORKTIME_TOKEN`, `npm run worktime:setup` 산출물).
 */

import { formatDateKeyKo, formatMonthKeyKo } from '../shared/time.js';
import type { FetchLike } from './_notion.js';

export interface DiscordEnv {
  WEBHOOK_WORKTIME_ID?: string;
  WEBHOOK_WORKTIME_TOKEN?: string;
  /** `하정언:996435919865401474,박진규:615060326127239171` 형태 */
  DISCORD_USER_IDS?: string;
}

export interface GrantNotice {
  employeeName: string | null;
  dateKey: string;
  hours: number;
  reason: string;
  /** 부여한 사람 (대표). 없으면 문장에서 뺀다. */
  grantedBy?: string | null;
}

/** 알림 결과. 부여 자체의 성패와는 무관하다. */
export type NoticeResult =
  | { sent: true }
  | { sent: false; reason: 'not_configured' | 'failed'; detail?: string };

/**
 * 이름 → 디스코드 사용자 id.
 *
 * 코드에 박지 않는 이유: 사람이 늘거나 계정을 바꾸면 배포를 다시 해야 한다.
 * 형식이 깨진 항목은 조용히 버린다 — 한 사람 id 를 잘못 적었다고 알림 전체가
 * 멈추는 것보다, 그 사람만 이름으로 표시되는 편이 낫다.
 */
export function parseUserIds(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of String(raw ?? '').split(',')) {
    const at = pair.indexOf(':');
    if (at < 0) continue;
    const name = pair.slice(0, at).trim();
    const id = pair.slice(at + 1).trim();
    // 디스코드 id 는 숫자만으로 된 snowflake 다. 그게 아니면 멘션이 그냥 깨진 글자로 뜬다.
    if (!name || !/^\d{5,}$/.test(id)) continue;
    map.set(name, id);
  }
  return map;
}

/**
 * 그 사람을 부르는 표기. id 를 알면 실제 멘션(알림이 울린다), 모르면 이름만 굵게.
 *
 * 이름만 남기더라도 알림은 반드시 보낸다 — 태그가 안 되는 것과 소식이 아예 안 가는
 * 것은 전혀 다른 문제다.
 */
export function mentionFor(name: string | null, ids: Map<string, string>): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '**(이름 미지정)**';
  const id = ids.get(trimmed);
  return id ? `<@${id}>` : `**${trimmed}**`;
}

/**
 * 사람이 적은 자유 문장을 한 줄짜리 안전한 텍스트로 만든다.
 *
 * 줄바꿈이 들어오면 레이아웃이 무너지고, 백틱·별표는 굵게/코드로 새어 나간다.
 * `@everyone` 같은 것은 아래 allowed_mentions 로도 막지만, 글자 자체를 남겨 두면
 * 채널에 그대로 보이므로 여기서 지운다.
 */
function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim().replace(/[`*_~|]/g, '').replace(/@/g, '＠');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 소수 시간을 "6시간" / "1.5시간" 으로. */
function hoursText(hours: number): string {
  return Number.isInteger(hours) ? `${hours}시간` : `${Math.round(hours * 100) / 100}시간`;
}

export function buildGrantMessage(notice: GrantNotice, ids: Map<string, string>): string {
  const who = mentionFor(notice.employeeName, ids);
  const by = notice.grantedBy?.trim();
  const lines = [
    '## 🌴 특별 휴가 부여',
    `${who} 님에게 **${hoursText(notice.hours)}**이 부여되었습니다.`,
    `기준일 **${formatDateKeyKo(notice.dateKey)}** · 사유 **${oneLine(notice.reason)}**`,
    `_${formatMonthKeyKo(notice.dateKey.slice(0, 7))}부터 쓸 수 있습니다._${by ? ` _(부여: ${oneLine(by, 20)})_` : ''}`,
  ];
  return lines.join('\n');
}

function webhookUrl(env: DiscordEnv): string | null {
  const id = env.WEBHOOK_WORKTIME_ID?.trim();
  const token = env.WEBHOOK_WORKTIME_TOKEN?.trim();
  return id && token ? `https://discord.com/api/webhooks/${id}/${token}` : null;
}

/**
 * 근무현황 채널에 부여 알림을 보낸다. 던지지 않는다 — 결과만 돌려준다.
 */
export async function notifyGrant(
  env: DiscordEnv,
  notice: GrantNotice,
  fetchImpl: FetchLike = fetch,
): Promise<NoticeResult> {
  const url = webhookUrl(env);
  if (!url) return { sent: false, reason: 'not_configured' };

  const ids = parseUserIds(env.DISCORD_USER_IDS);
  const content = buildGrantMessage(notice, ids);
  const mentioned = ids.get((notice.employeeName ?? '').trim());

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: '근무 기록',
        content: content.length > 1990 ? `${content.slice(0, 1985)}\n…` : content,
        // 부여 대상 한 명만 울린다. 사유에 `@everyone` 을 적어도 전체 알림이 가지 않는다 —
        // 목록을 명시하면 디스코드가 본문 파싱을 아예 하지 않기 때문이다.
        allowed_mentions: { parse: [], users: mentioned ? [mentioned] : [] },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { sent: false, reason: 'failed', detail: `${res.status} ${text.slice(0, 200)}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: 'failed', detail: (err as Error).message };
  }
}
