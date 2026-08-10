/**
 * 근무 이벤트 엔진은 서버(api/)도 써야 한다 — 여러 기기의 이벤트를 Notion 에서 합친 뒤
 * 근무시간을 다시 계산하는 주체가 서버이기 때문이다. 실제 구현은 shared/events.ts 에 있고,
 * 이 파일은 기존 import 경로를 유지하기 위한 재수출 창구다.
 */
export * from '../../shared/events';
