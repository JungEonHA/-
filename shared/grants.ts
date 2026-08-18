/**
 * 특별 휴가 부여(grant).
 *
 * 왜 필요한가 — 지금까지 휴가는 "매월 정해진 시간이 자동 지급"되는 것뿐이었다.
 * 그런데 전시 참가·천재지변·집안 사정처럼 **그때그때 사유를 달아 추가로 얹어 줘야 하는**
 * 휴가가 생긴다. 월 지급량을 올리면 그 달만이 아니라 앞으로 매달 늘어나 버리므로,
 * 일회성 부여는 별도 개념이어야 한다.
 *
 * 어디에 저장하는가 — **Notion 행**이다. 로컬(localStorage)에만 두면 부여한 사람의
 * 기기에서만 보이고 정작 휴가를 쓰는 사람 기기에서는 잔량이 그대로다. 이 앱의 기기 간
 * 공유 수단은 Notion 뿐이므로 부여도 거기 둔다.
 *
 * 행 모양: 제목 `특별 휴가 부여 (N시간)` · 구분 `특별부여` · 부여시간(number) · 사유(text)
 * `근무일` 은 "언제부터 쓸 수 있는가"를 정한다 — 그 달부터 잔량에 더해진다.
 */

/** 노션 표에서 부여 행에 붙여 두는 `구분` 값 (사람이 보는 용도). */
export const GRANT_KIND = '특별부여';

/**
 * 부여 전용 Notion Property 이름. 이 두 개는 앱이 직접 만들고 직접 읽는다.
 * 특히 `부여시간` 은 **부여 행을 알아보는 유일한 기준**이다 (사용자 매핑을 타지 않는다).
 */
export const GRANT_HOURS_PROP = '부여시간';
export const GRANT_REASON_PROP = '사유';

/** 노션 표에서 사람이 알아보라고 적어 두는 보조 표시 칸. 읽을 때는 쓰지 않는다. */
export const GRANT_KIND_PROP = '구분';

/**
 * 특별 휴가를 부여할 수 있는 사람 (2026-08-18 CEO 지시).
 *
 * 부여는 원래 "부여를 누른 기기의 이름"으로 들어갔다. 그래서 각자 자기 자신에게
 * 얼마든지 얹을 수 있었다. 부여 권한은 대표에게만 있어야 하므로 이름으로 가른다.
 *
 * 한계를 분명히 해 둔다 — 이건 **화면 단의 가드**다. 서버는 요청자가 누구인지 알 수
 * 없고(두 사람이 같은 `APP_ACCESS_KEY` 를 쓴다) 이름은 앱 설정에서 바꿀 수 있는 값이다.
 * 실수로 자기에게 부여하는 것을 막는 용도이지, 작정하고 우회하는 것은 못 막는다.
 * 진짜로 막아야 한다면 사람별 접근 키를 따로 두는 수밖에 없다.
 */
export const GRANTOR_NAME = '하정언';

export function canGrantVacation(employeeName: string | null | undefined): boolean {
  return (employeeName ?? '').trim() === GRANTOR_NAME;
}

export interface VacationGrant {
  /** Notion 페이지 id */
  id: string;
  /** 부여 기준일 YYYY-MM-DD — 이 날이 속한 달부터 쓸 수 있다 */
  dateKey: string;
  /** 부여량 (ms) */
  ms: number;
  /** 사유 (예: BIC 전시 참가, 천재지변, 집안 사정) */
  reason: string;
}

/**
 * 부여 행의 제목.
 *
 * 매월 자동 지급 행이 `월 8시간 휴가 부여` 로 적히므로 특별 부여도 같은 어투로 맞춘다
 * (2026-08-18 CEO 요청). 날짜와 이름은 제목에 넣지 않는다 — `근무일`·`직원` 칸에 이미 있고,
 * 자동 지급 행도 넣지 않기 때문이다.
 *
 * 주의: 일일 근무 행은 `appRowTitle` 로만 소유권을 판별하므로 이 제목과 절대 겹치지 않는다.
 * 부여 행을 알아보는 기준은 여전히 제목이 아니라 `부여시간` Property 다.
 */
export function grantTitle(hours: number): string {
  const n = Number.isInteger(hours) ? String(hours) : String(Math.round(hours * 100) / 100);
  return `특별 휴가 부여 (${n}시간)`;
}

/** `monthKey`(YYYY-MM) 까지 부여된 누계(ms). 미래에 부여된 건은 아직 세지 않는다. */
export function grantedExtraThrough(grants: VacationGrant[], monthKey: string): number {
  let total = 0;
  for (const g of grants) {
    if (g.dateKey.slice(0, 7) <= monthKey) total += Math.max(0, g.ms);
  }
  return total;
}

/** 그 달에 부여된 것만 (화면에서 "이번 달 특별 부여" 로 보여 준다) */
export function grantedExtraIn(grants: VacationGrant[], monthKey: string): number {
  let total = 0;
  for (const g of grants) {
    if (g.dateKey.slice(0, 7) === monthKey) total += Math.max(0, g.ms);
  }
  return total;
}
