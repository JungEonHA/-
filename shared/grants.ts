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
 * 행 모양: 제목 `YYYY-MM-DD <이름> 특별부여` · 구분 `특별부여` · 부여시간(number) · 사유(text)
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

export function grantTitle(dateKey: string, employeeName: string | null): string {
  return `${dateKey}${employeeName ? ` ${employeeName}` : ''} ${GRANT_KIND}`;
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
