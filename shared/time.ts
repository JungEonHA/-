/**
 * KST(Asia/Seoul) 시간 유틸리티.
 *
 * 한국 표준시는 1988년 이후 서머타임을 시행하지 않으며 항상 UTC+09:00 고정이다.
 * 따라서 Intl 왕복 파싱 대신 고정 오프셋 산술을 사용한다 —
 * 결정적(deterministic)이고, 런타임 tz 데이터에 의존하지 않으며, 테스트가 쉽다.
 *
 * 규칙: 내부 저장은 항상 epoch milliseconds(UTC 기준 절대시각).
 *       "YYYY-MM-DD" 형태의 dateKey 는 항상 KST 벽시계 날짜를 의미한다.
 */

export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** epoch ms -> KST 벽시계 기준으로 "시프트된" Date (getUTC* 로 읽어야 함) */
function kstShifted(epochMs: number): Date {
  return new Date(epochMs + KST_OFFSET_MS);
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** epoch ms -> "YYYY-MM-DD" (KST) */
export function toDateKey(epochMs: number): string {
  const d = kstShifted(epochMs);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** epoch ms -> "YYYY-MM" (KST) */
export function toMonthKey(epochMs: number): string {
  return toDateKey(epochMs).slice(0, 7);
}

/** "YYYY-MM-DD" -> 해당 KST 날짜 00:00:00 의 epoch ms */
export function dateKeyToEpoch(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  if (!y || !m || !d) throw new Error(`잘못된 dateKey: ${dateKey}`);
  return Date.UTC(y, m - 1, d) - KST_OFFSET_MS;
}

/** monthKey("YYYY-MM") 에 개월수를 더한 monthKey */
export function addMonths(monthKey: string, months: number): string {
  const [y, m] = monthKey.split('-').map(Number);
  if (!y || !m) throw new Error(`잘못된 monthKey: ${monthKey}`);
  const total = y * 12 + (m - 1) + months;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${pad2((total % 12) + 1)}`;
}

/** a, b 사이의 개월 수 (b - a). 같은 달이면 0 */
export function monthDiff(a: string, b: string): number {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  if (!ay || !am || !by || !bm) throw new Error(`잘못된 monthKey: ${a} / ${b}`);
  return by * 12 + (bm - 1) - (ay * 12 + (am - 1));
}

/** KST 기준 요일. 0=일 … 6=토 */
export function dayOfWeek(dateKey: string): number {
  return kstShifted(dateKeyToEpoch(dateKey)).getUTCDay();
}

export const WEEKDAY_LABELS_KO = ['일', '월', '화', '수', '목', '금', '토'] as const;

/** 해당 날짜가 속한 주(월요일 시작)의 월요일 dateKey */
export function startOfWeek(dateKey: string): string {
  const dow = dayOfWeek(dateKey);
  const backToMonday = (dow + 6) % 7; // 일요일(0) -> 6일 전
  return shiftDateKey(dateKey, -backToMonday);
}

/** 월요일 시작 기준 그 주의 7개 dateKey */
export function weekDateKeys(dateKey: string): string[] {
  const monday = startOfWeek(dateKey);
  return Array.from({ length: 7 }, (_, i) => shiftDateKey(monday, i));
}

/** dateKey 에서 n일 이동 (음수 가능). DST 없는 고정 오프셋이라 안전 */
export function shiftDateKey(dateKey: string, days: number): string {
  return toDateKey(dateKeyToEpoch(dateKey) + days * DAY_MS);
}

/** 해당 월의 모든 dateKey */
export function monthDateKeys(monthKey: string): string[] {
  const first = `${monthKey}-01`;
  const keys: string[] = [];
  let cur = first;
  while (cur.startsWith(monthKey)) {
    keys.push(cur);
    cur = shiftDateKey(cur, 1);
  }
  return keys;
}

/** epoch ms -> "HH:mm" (KST) */
export function formatClock(epochMs: number): string {
  const d = kstShifted(epochMs);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** epoch ms -> "HH:mm:ss" (KST) */
export function formatClockSeconds(epochMs: number): string {
  const d = kstShifted(epochMs);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/**
 * 소요시간(ms) -> "HH:MM:SS".
 * 24시간을 넘으면 시(hour) 자리가 계속 늘어난다 (예: "26:03:11").
 */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

/** 소요시간(ms) -> "8시간 30분" / "30분" / "0분" (요약 표시용) */
export function formatDurationKo(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / MINUTE_MS));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}분`;
  if (m === 0) return `${h}시간`;
  return `${h}시간 ${m}분`;
}

/** 소요시간(ms) -> 소수 시간 (Notion number 속성용). 소수점 2자리 반올림 */
export function msToHours(ms: number): number {
  return Math.round((ms / HOUR_MS) * 100) / 100;
}

/** "2026-08-09" -> "8월 9일(일)" */
export function formatDateKeyKo(dateKey: string): string {
  const [, m, d] = dateKey.split('-').map(Number);
  return `${m}월 ${d}일(${WEEKDAY_LABELS_KO[dayOfWeek(dateKey)]})`;
}

/** "2026-08" -> "2026년 8월" */
export function formatMonthKeyKo(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  return `${y}년 ${m}월`;
}

/** ISO8601 with KST offset — Notion date 속성에 넘길 때 사용 */
export function toKstIso(epochMs: number): string {
  const d = kstShifted(epochMs);
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}+09:00`
  );
}
