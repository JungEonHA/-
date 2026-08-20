/**
 * 이 화면이 돌리고 있는 코드의 신원.
 *
 * 노션에 임베드한 위젯은 iframe 이라 노션 페이지를 닫기 전에는 다시 로드되지 않는다.
 * 그래서 버그를 고쳐 배포해도 위젯은 며칠 전 번들을 그대로 돌리고, 사용자에게는
 * "고쳤다는데 그대로"로 보인다. 2026-08-20 에 정정한 날의 '업무 복귀'가 먹지 않는다는
 * 문의가 정확히 그 상황이었다 — 고친 코드는 이미 배포돼 있었고 화면만 옛 번들이었다.
 * 밖에서도 안에서도 어느 코드가 도는지 볼 방법이 없었던 것이 진짜 문제였다.
 */

/** vite.config.ts 의 define 으로 주입된다. 배포 커밋 앞 8자, 로컬은 'dev'. */
export const BUILD_ID: string = __BUILD_ID__;

/**
 * 서버에 배포된 코드가 이 화면의 코드보다 새것인가.
 *
 * 판정하지 않는 경우가 둘 있고, 둘 다 "모르면 조용히 있는다"는 같은 이유다.
 * 새로고침 배너는 한 번 뜨면 사용자가 누를 때까지 사라지지 않으므로, 확신이 없을 때
 * 띄우면 영영 지워지지 않는 거짓 경고가 된다.
 *  - 로컬 개발('dev')은 서버 값과 절대 같아질 수 없다.
 *  - build 를 안 내려주는 옛 배포/정적 배포는 비교할 대상 자체가 없다.
 */
export function isStaleBuild(serverBuild: string | null | undefined, local = BUILD_ID): boolean {
  if (!serverBuild || local === 'dev') return false;
  return serverBuild !== local;
}
