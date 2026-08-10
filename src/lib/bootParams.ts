/**
 * URL 로 넘어오는 부팅 설정.
 *
 * Notion Embed 블록은 "URL 하나 = 블록 하나"다. 사람마다 블록을 하나씩 두고
 * `?embed=1&employee=박진규` 를 붙여 두면 그 위젯은 언제나 그 사람의 기록으로
 * 동작한다 — 기기를 바꾸든 브라우저를 지우든 설정 화면을 거칠 일이 없다.
 *
 * 접근 키도 받는다. iframe 안의 localStorage 는 브라우저가 상위 사이트별로
 * 쪼개 두거나(스토리지 파티셔닝) 통째로 지울 수 있어서, 저장해 둔 키가 사라지면
 * 위젯이 조용히 멈춘다. URL 에 실려 있으면 새로고침만으로 되살아난다.
 *
 * 백엔드 주소는 일부러 받지 않는다. 그것까지 URL 로 바꿀 수 있으면 링크 하나로
 * 접근 키를 남의 서버에 보내게 만들 수 있다.
 */

export interface BootParams {
  /** 컴팩트 위젯으로 그릴지 여부 */
  widget: boolean;
  /** null 이면 "URL 이 지정하지 않음" — 저장된 값을 그대로 둔다 */
  employeeName: string | null;
  accessKey: string | null;
  /** Notion 의 테마가 OS 테마와 다를 때 강제하기 위한 값 */
  theme: 'light' | 'dark' | null;
}

/** `embed`/`widget`/`view` 값이 이것들이면 전체 화면을 뜻한다 */
const FULL_VIEW = new Set(['0', 'false', 'no', 'off', 'full', 'app']);

/** 주소에 남기면 안 되는 파라미터 (소문자 비교) */
const SECRET_PARAMS = new Set(['key', 'accesskey', 'access_key']);

function clean(value: string | null): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

export function parseBootParams(search: string): BootParams {
  const q = new URLSearchParams(search);
  const mode = q.get('embed') ?? q.get('widget') ?? q.get('view');
  const theme = clean(q.get('theme'))?.toLowerCase();

  return {
    widget: mode !== null && !FULL_VIEW.has(mode.trim().toLowerCase()),
    employeeName: clean(q.get('employee') ?? q.get('name')),
    accessKey: clean(q.get('key') ?? q.get('accessKey')),
    theme: theme === 'light' || theme === 'dark' ? theme : null,
  };
}

/**
 * 접근 키만 지운 주소. 없으면 null (바꿀 게 없다는 뜻).
 *
 * 위젯이 뜨는 즉시 히스토리를 갈아 끼워, 주소를 복사하거나 전체 화면으로 열 때
 * 키가 딸려 나가지 않게 한다. Notion 블록에 저장된 원래 URL 은 그대로이므로
 * 새로고침하면 키가 다시 적용된다.
 */
export function urlWithoutSecrets(href: string): string | null {
  const url = new URL(href);
  let touched = false;
  for (const name of [...url.searchParams.keys()]) {
    if (SECRET_PARAMS.has(name.toLowerCase())) {
      url.searchParams.delete(name);
      touched = true;
    }
  }
  return touched ? url.toString() : null;
}

/**
 * 위젯에서 "전체 화면으로 열기" 에 쓸 주소.
 * 직원 이름은 넘기고 접근 키는 넘기지 않는다 — 새 탭에서 한 번 입력하면 된다.
 */
export function fullViewUrl(origin: string, pathname: string, employeeName: string): string {
  const name = employeeName.trim();
  const query = name ? `?employee=${encodeURIComponent(name)}` : '';
  return `${origin}${pathname}${query}`;
}
