/**
 * 논리 필드 정의 — 서버(api/)와 프론트엔드(src/)가 공유한다.
 *
 * 여기 있는 이름들은 **Notion Property 이름이 아니다.** 앱 내부의 논리적 필드일 뿐이며,
 * 실제 Notion Property 와의 연결은 사용자가 확정한 매핑(FieldMapping)으로만 이루어진다.
 * `candidates` 는 자동 매핑 "제안"에만 쓰이며, 확정은 항상 사용자가 한다.
 */

export type LogicalField =
  | 'title'
  | 'date'
  | 'employee'
  | 'clockIn'
  | 'clockOut'
  | 'actualWork'
  | 'awayTime'
  | 'vacation'
  | 'credited'
  | 'status'
  | 'todos'
  | 'eventLog';

/** 값의 성격. 어떤 Notion 타입에 어떻게 인코딩할지 결정한다. */
export type FieldKind =
  | 'dateOnly'
  | 'timestamp'
  | 'duration'
  | 'status'
  | 'employee'
  | 'eventLog'
  | 'todos'
  | 'text';

export interface FieldSpec {
  key: LogicalField;
  labelKo: string;
  kind: FieldKind;
  /** 이 필드를 쓸 수 있는 Notion property 타입 */
  acceptedTypes: string[];
  /** 자동 매핑 제안용 후보 이름 (소문자·구분자 제거 형태) */
  candidates: string[];
  /** 자동 생성 시 만들 Notion property 타입 */
  createAs: string;
  /**
   * 자동 생성 시 쓸 Property 이름. 생략하면 labelKo 를 쓴다.
   *
   * labelKo 는 앱 UI 용 문구라서 그대로 DB 컬럼명이 되면 어색하거나("실제 근무시간"),
   * 기존 컬럼과 뜻이 겹쳐 헷갈린다. DB 에 만들 이름은 따로 정한다.
   */
  createName?: string;
  /** 이 필드가 없으면 동기화 자체가 불가능한가 */
  required: boolean;
  descriptionKo: string;
}

export const FIELD_SPECS: FieldSpec[] = [
  {
    key: 'title',
    labelKo: '제목',
    kind: 'text',
    acceptedTypes: ['title'],
    candidates: ['이름', '제목', 'name', 'title', '근무일', '기록'],
    createAs: 'title',
    required: false,
    descriptionKo: 'DB의 제목 속성. "2026-08-09 근무기록" 형태로 채웁니다.',
  },
  {
    key: 'date',
    labelKo: '날짜',
    kind: 'dateOnly',
    acceptedTypes: ['date', 'rich_text', 'title'],
    candidates: ['날짜', '근무일', '근무일자', '일자', 'date', 'workdate', 'day'],
    createAs: 'date',
    required: true,
    descriptionKo: '중복 기록 방지의 기준이 되는 필드입니다. 반드시 매핑해야 합니다.',
  },
  {
    key: 'employee',
    labelKo: '직원',
    kind: 'employee',
    acceptedTypes: ['select', 'status', 'multi_select', 'rich_text'],
    candidates: ['직원', '사원', '담당자', '작성자', '멤버', 'employee', 'member', 'person', 'staff', 'user'],
    createAs: 'select',
    createName: '직원',
    required: true,
    descriptionKo:
      '여러 명이 같은 DB를 쓸 때 누구의 기록인지 구분합니다. 날짜와 함께 중복 방지 기준이 됩니다.',
  },
  {
    key: 'clockIn',
    labelKo: '출근시간',
    kind: 'timestamp',
    acceptedTypes: ['date', 'rich_text', 'title'],
    candidates: [
      '출근시간', '출근', '출근시각', '시작', '시작시간', '시작시각',
      'checkin', 'clockin', 'starttime', 'start',
    ],
    createAs: 'rich_text',
    required: false,
    descriptionKo: 'date 타입이면 ISO 시각, 텍스트면 "09:00" 형태로 기록합니다.',
  },
  {
    key: 'clockOut',
    labelKo: '퇴근시간',
    kind: 'timestamp',
    acceptedTypes: ['date', 'rich_text', 'title'],
    candidates: [
      '퇴근시간', '퇴근', '퇴근시각', '종료', '종료시간', '종료시각',
      'checkout', 'clockout', 'endtime', 'end',
    ],
    createAs: 'rich_text',
    required: false,
    descriptionKo: 'date 타입이면 ISO 시각, 텍스트면 "18:00" 형태로 기록합니다.',
  },
  {
    key: 'actualWork',
    labelKo: '실제 근무시간',
    kind: 'duration',
    acceptedTypes: ['number', 'rich_text'],
    candidates: [
      '실제근무시간', '실근무시간', '실제근무', '근무시간',
      'actualwork', 'workhours', 'worktime', 'actualhours',
    ],
    createAs: 'number',
    createName: '실근무시간',
    required: false,
    descriptionKo:
      '자리 비움을 제외한 순수 근무시간. 숫자 Property 면 8.25, 텍스트 Property 면 "8시간 15분" 으로 기록합니다.',
  },
  {
    key: 'awayTime',
    labelKo: '자리 비움시간',
    kind: 'duration',
    acceptedTypes: ['number', 'rich_text'],
    candidates: [
      '자리비움시간', '자리비움', '비움시간', '휴게시간', '외출시간',
      'awaytime', 'away', 'breaktime', 'break',
    ],
    createAs: 'number',
    createName: '자리비움시간',
    required: false,
    descriptionKo:
      '근무시간에 포함되지 않은 자리 비움 누적시간. 텍스트 Property 면 "1시간 20분" 형태로 기록합니다.',
  },
  {
    key: 'vacation',
    labelKo: '휴가시간',
    kind: 'duration',
    acceptedTypes: ['number', 'rich_text'],
    candidates: ['휴가시간', '휴가', '연차시간', '휴가사용', 'vacation', 'leave', 'pto', 'timeoff'],
    createAs: 'number',
    createName: '휴가사용시간',
    required: false,
    descriptionKo:
      '해당 일자에 사용한 휴가시간. 텍스트 Property 면 "4시간" 형태로 기록합니다.',
  },
  {
    key: 'credited',
    labelKo: '인정 근무시간',
    kind: 'duration',
    acceptedTypes: ['number', 'rich_text'],
    candidates: [
      '인정근무시간', '인정근무', '인정시간', '총근무시간', '합계근무시간',
      'creditedwork', 'creditedhours', 'totalhours', 'recognizedhours',
    ],
    createAs: 'number',
    createName: '인정근무시간',
    required: false,
    descriptionKo:
      '실제 근무시간 + 휴가 대체시간. 텍스트 Property 면 "8시간" 형태로 기록합니다.',
  },
  {
    key: 'status',
    labelKo: '상태',
    kind: 'status',
    acceptedTypes: ['select', 'status', 'rich_text'],
    candidates: ['근무상태', '상태', 'status', 'state'],
    createAs: 'select',
    createName: '근무상태',
    required: false,
    descriptionKo: '퇴근 완료 / 근무 중 / 자리 비움 / 휴가 / 출근 전.',
  },
  {
    key: 'todos',
    labelKo: '업무 리스트',
    kind: 'todos',
    // 체크리스트를 줄바꿈으로 이어 붙인 텍스트라서 텍스트 칸에만 쓸 수 있다.
    acceptedTypes: ['rich_text'],
    candidates: [
      '업무리스트', '업무내용', '업무일지', '업무기록', '오늘할일', '할일', '할일목록',
      '작업내용', '작업목록', '체크리스트',
      'todo', 'todos', 'todolist', 'tasks', 'tasklist', 'checklist', 'worklog',
    ],
    createAs: 'rich_text',
    createName: '업무 리스트',
    required: false,
    descriptionKo:
      '앱의 “할 일” 탭에 적은 목록을 ☑/☐ 체크리스트로 그날 행에 기록합니다. 앱에서 지우면 Notion 값도 함께 비워집니다.',
  },
  {
    key: 'eventLog',
    labelKo: '기기 연동 로그',
    kind: 'eventLog',
    acceptedTypes: ['rich_text'],
    candidates: ['이벤트로그', '기기연동로그', '기기연동', '동기화로그', 'eventlog', 'synclog'],
    createAs: 'rich_text',
    createName: '이벤트로그',
    required: false,
    descriptionKo:
      '데스크탑·노트북을 오갈 때 기록을 합치는 데 쓰는 내부 값입니다. 사람이 읽을 필요는 없고, 매핑하지 않으면 기기별로 따로 기록됩니다.',
  },
];

export const FIELD_SPEC_BY_KEY: Record<LogicalField, FieldSpec> = Object.fromEntries(
  FIELD_SPECS.map((s) => [s.key, s]),
) as Record<LogicalField, FieldSpec>;

/** 논리 필드 -> 실제 Notion property 이름. 값이 없으면 "이 필드는 쓰지 않음". */
export type FieldMapping = Partial<Record<LogicalField, string>>;

// ---------------------------------------------------------------------------
// 매핑 제안
// ---------------------------------------------------------------------------

/** 매핑 제안에 필요한 최소한의 Property 정보 (서버/클라이언트 공통) */
export interface PropertyLike {
  name: string;
  type: string;
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[\s_\-()[\]/·.]/g, '');
}

/**
 * 실제 스키마를 보고 매핑을 **제안**한다. 확정은 사용자가 UI 에서 한다.
 * 이름이 정확히/부분적으로 일치하고 타입까지 호환될 때만 제안한다.
 *
 * 서버(스키마 조회 응답)와 클라이언트(캐시된 스키마로 빈 칸 보정)가 같은 규칙을
 * 써야 하므로 여기 공유 모듈에 둔다.
 */
export function suggestMapping(properties: PropertyLike[]): {
  mapping: FieldMapping;
  unmatched: LogicalField[];
} {
  const mapping: FieldMapping = {};
  const unmatched: LogicalField[] = [];
  const taken = new Set<string>();

  // title 타입은 DB 당 하나뿐이므로 먼저 확정한다.
  const titleProp = properties.find((p) => p.type === 'title');
  if (titleProp) {
    mapping.title = titleProp.name;
    taken.add(titleProp.name);
  }

  for (const spec of FIELD_SPECS) {
    if (spec.key === 'title') continue;

    const compatible = properties.filter(
      (p) => spec.acceptedTypes.includes(p.type) && !taken.has(p.name),
    );
    if (compatible.length === 0) {
      unmatched.push(spec.key);
      continue;
    }

    const exact = compatible.find((p) => spec.candidates.includes(normalizeName(p.name)));
    const partial = compatible.find((p) => {
      const n = normalizeName(p.name);
      return spec.candidates.some((c) => n.includes(c) || c.includes(n));
    });

    const chosen = exact ?? partial;
    if (chosen) {
      mapping[spec.key] = chosen.name;
      taken.add(chosen.name);
    } else {
      unmatched.push(spec.key);
    }
  }

  return { mapping, unmatched };
}

/**
 * 소수 시간(8.25)을 사람이 읽는 형태("8시간 15분")로 바꾼다.
 *
 * Notion 의 숫자 Property 에는 "시간:분" 표시 형식이 없어서 8.25 처럼만 보인다.
 * 그래서 텍스트 Property 에 기록할 때는 이 형식을 쓴다.
 * (숫자 Property 에는 계속 소수를 넣는다 — Notion 에서 합계·평균을 내려면 숫자여야 한다.)
 */
export function formatHoursKo(hours: number): string {
  // 분 단위로 먼저 반올림한다. 0.9999 시간이 "0시간 60분" 이 되면 안 된다.
  const totalMinutes = Math.round(Math.max(0, hours) * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;

  if (h === 0 && m === 0) return '0분';
  if (m === 0) return `${h}시간`;
  if (h === 0) return `${m}분`;
  return `${h}시간 ${m}분`;
}
