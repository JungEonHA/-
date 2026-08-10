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
  | 'clockIn'
  | 'clockOut'
  | 'actualWork'
  | 'awayTime'
  | 'vacation'
  | 'credited'
  | 'status';

/** 값의 성격. 어떤 Notion 타입에 어떻게 인코딩할지 결정한다. */
export type FieldKind = 'dateOnly' | 'timestamp' | 'duration' | 'status' | 'text';

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
    key: 'clockIn',
    labelKo: '출근시간',
    kind: 'timestamp',
    acceptedTypes: ['date', 'rich_text', 'title'],
    candidates: ['출근시간', '출근', '출근시각', 'checkin', 'clockin', 'starttime', 'start'],
    createAs: 'rich_text',
    required: false,
    descriptionKo: 'date 타입이면 ISO 시각, 텍스트면 "09:00" 형태로 기록합니다.',
  },
  {
    key: 'clockOut',
    labelKo: '퇴근시간',
    kind: 'timestamp',
    acceptedTypes: ['date', 'rich_text', 'title'],
    candidates: ['퇴근시간', '퇴근', '퇴근시각', 'checkout', 'clockout', 'endtime', 'end'],
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
    required: false,
    descriptionKo: '자리 비움을 제외한 순수 근무시간 (숫자면 시간 단위 소수).',
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
    required: false,
    descriptionKo: '근무시간에 포함되지 않은 자리 비움 누적시간.',
  },
  {
    key: 'vacation',
    labelKo: '휴가시간',
    kind: 'duration',
    acceptedTypes: ['number', 'rich_text'],
    candidates: ['휴가시간', '휴가', '연차시간', '휴가사용', 'vacation', 'leave', 'pto', 'timeoff'],
    createAs: 'number',
    required: false,
    descriptionKo: '해당 일자에 사용한 휴가시간.',
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
    required: false,
    descriptionKo: '실제 근무시간 + 휴가 대체시간.',
  },
  {
    key: 'status',
    labelKo: '상태',
    kind: 'status',
    acceptedTypes: ['select', 'status', 'rich_text'],
    candidates: ['상태', '근무상태', '구분', 'status', 'state', 'type'],
    createAs: 'select',
    required: false,
    descriptionKo: '퇴근 완료 / 근무 중 / 자리 비움 / 휴가 / 출근 전.',
  },
];

export const FIELD_SPEC_BY_KEY: Record<LogicalField, FieldSpec> = Object.fromEntries(
  FIELD_SPECS.map((s) => [s.key, s]),
) as Record<LogicalField, FieldSpec>;

/** 논리 필드 -> 실제 Notion property 이름. 값이 없으면 "이 필드는 쓰지 않음". */
export type FieldMapping = Partial<Record<LogicalField, string>>;
