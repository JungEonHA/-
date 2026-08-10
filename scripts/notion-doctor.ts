/**
 * Notion 연동 진단 도구 (로컬 PC 전용).
 *
 * 왜 필요한가:
 *   Notion API 는 CORS 를 허용하지 않고, 개발 컨테이너에서는 api.notion.com 이
 *   막혀 있을 수 있다. 그래서 "실제 DB 스키마 확인"은 사용자의 PC 에서 한 번
 *   실행해야 한다. 이 스크립트는 앱과 **똑같은** api/_notion.ts 코어를 사용하므로,
 *   여기서 통과한 것은 앱에서도 그대로 동작한다.
 *
 * 안전 원칙 (앱과 동일):
 *   - 기본 동작은 **읽기 전용**이다. 아무것도 만들지 않고 아무것도 고치지 않는다.
 *   - Property 이름을 추측하지 않는다. 실제 스키마를 읽어서 보여줄 뿐이다.
 *   - --write-test 를 줘도, 대상 날짜에 이미 행이 있으면 덮어쓰지 않고 중단한다.
 *   - 삭제/아카이브를 하는 코드 경로가 없다.
 *
 * 사용법:
 *   npm run notion:doctor              # 스키마 조회 + 매핑 제안 (읽기 전용)
 *   npm run notion:doctor -- --list    # integration 이 볼 수 있는 DB 목록
 *   npm run notion:doctor -- --db=<URL 또는 ID>
 *   npm run notion:doctor -- --write-test              # 오늘 날짜로 쓰기/중복방지 검증
 *   npm run notion:doctor -- --write-test --date=2026-01-01
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  DEFAULT_NOTION_VERSION,
  FIELD_SPECS,
  FIELD_SPEC_BY_KEY,
  NotionClient,
  NotionError,
  buildDateFilter,
  fetchDatabaseSchema,
  normalizeId,
  suggestMapping,
  upsertDayRecord,
  type DatabaseSchema,
  type DayRecordPayload,
  type FieldMapping,
  type LogicalField,
  type NotionPropertyInfo,
} from '../api/_notion';
import { toDateKey, toKstIso } from '../src/lib/time';

// ---------------------------------------------------------------------------
// 출력 유틸
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env['NO_COLOR'];
const c = {
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
};

const log = (s = '') => console.log(s);
const ok = (s: string) => log(`${c.green('✔')} ${s}`);
const warn = (s: string) => log(`${c.yellow('!')} ${s}`);
const fail = (s: string) => log(`${c.red('✖')} ${s}`);

function section(title: string): void {
  log();
  log(c.bold(`── ${title} ${'─'.repeat(Math.max(0, 60 - displayWidth(title)))}`));
}

/** 화면 폭 계산용. 한글/전각 문자는 두 칸을 차지한다. */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    w +=
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
        ? 2
        : 1;
  }
  return w;
}

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

// ---------------------------------------------------------------------------
// .env 로딩 (의존성 없이)
// ---------------------------------------------------------------------------

function loadDotEnv(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ['.env.local', '.env']) {
    const file = resolve(root, name);
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      // 먼저 읽은 파일(.env.local)이 우선한다.
      if (!(key in out)) out[key] = value;
    }
  }
  return out;
}

/** 토큰은 절대 그대로 출력하지 않는다. */
function maskToken(token: string): string {
  if (token.length <= 12) return '*'.repeat(token.length);
  return `${token.slice(0, 7)}…${token.slice(-4)} (${token.length}자)`;
}

// ---------------------------------------------------------------------------
// 인자 파싱
// ---------------------------------------------------------------------------

interface Args {
  list: boolean;
  writeTest: boolean;
  help: boolean;
  db?: string;
  date?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { list: false, writeTest: false, help: false };
  for (const a of argv) {
    if (a === '--list') args.list = true;
    else if (a === '--write-test') args.writeTest = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--db=')) args.db = a.slice(5);
    else if (a.startsWith('--date=')) args.date = a.slice(7);
  }
  return args;
}

function printUsage(): void {
  log();
  log(c.bold('Notion 연동 진단'));
  log();
  log('  npm run notion:doctor                      스키마 조회 + 매핑 제안 (읽기 전용)');
  log('  npm run notion:doctor -- --list            접근 가능한 DB 목록 보기');
  log('  npm run notion:doctor -- --db=<URL|ID>     .env 대신 DB 를 직접 지정');
  log('  npm run notion:doctor -- --write-test      실제 저장 + 중복 방지 검증');
  log('  npm run notion:doctor -- --write-test --date=YYYY-MM-DD');
  log();
  log(c.dim('  읽기 전용이 기본이며, 기존 데이터를 수정하거나 삭제하지 않습니다.'));
  log(c.dim('  --write-test 도 대상 날짜에 행이 이미 있으면 덮어쓰지 않고 중단합니다.'));
  log();
}

// ---------------------------------------------------------------------------
// 진단 단계
// ---------------------------------------------------------------------------

async function checkToken(client: NotionClient): Promise<string> {
  const me = await client.request<any>('GET', '/users/me');
  const name = me?.name ?? me?.bot?.owner?.user?.name ?? '(이름 없음)';
  const workspace = me?.bot?.workspace_name ?? '(워크스페이스 이름 없음)';
  ok(`토큰 유효 — integration "${name}" / 워크스페이스 "${workspace}"`);
  return String(workspace);
}

interface FoundDatabase {
  id: string;
  title: string;
  url?: string;
}

async function listDatabases(client: NotionClient): Promise<FoundDatabase[]> {
  const res = await client.request<any>('POST', '/search', {
    filter: { property: 'object', value: 'database' },
    page_size: 100,
  });
  return (res?.results ?? []).map((db: any) => ({
    id: String(db.id ?? ''),
    title:
      (Array.isArray(db.title) ? db.title : [])
        .map((t: any) => t?.plain_text ?? '')
        .join('') || '(제목 없음)',
    url: db.url,
  }));
}

function printProperties(schema: DatabaseSchema): void {
  const nameW = Math.max(12, ...schema.properties.map((p) => displayWidth(p.name)));
  const typeW = Math.max(8, ...schema.properties.map((p) => p.type.length));

  log(c.dim(`  ${pad('Property 이름', nameW)}  ${pad('타입', typeW)}  선택지`));
  log(c.dim(`  ${'─'.repeat(nameW)}  ${'─'.repeat(typeW)}  ${'─'.repeat(20)}`));
  for (const p of schema.properties) {
    const options = p.options?.length ? p.options.join(', ') : '';
    log(`  ${pad(p.name, nameW)}  ${pad(p.type, typeW)}  ${c.dim(options)}`);
  }
}

function printMapping(schema: DatabaseSchema, mapping: FieldMapping, unmatched: LogicalField[]): void {
  const labelW = Math.max(...FIELD_SPECS.map((s) => displayWidth(s.labelKo))) + 2;

  for (const spec of FIELD_SPECS) {
    const chosen = mapping[spec.key];
    if (chosen) {
      const prop = schema.properties.find((p) => p.name === chosen);
      log(`  ${pad(spec.labelKo, labelW)} → ${c.cyan(chosen)} ${c.dim(`(${prop?.type ?? '?'})`)}`);
    } else {
      const compatible = schema.properties.filter((p) => spec.acceptedTypes.includes(p.type));
      const hint = compatible.length
        ? c.dim(`후보: ${compatible.map((p) => p.name).join(', ')}`)
        : c.dim(`호환 타입 없음 (필요 타입: ${spec.acceptedTypes.join('/')})`);
      const mark = spec.required ? c.red('(필수 — 반드시 지정)') : c.dim('(미지정 = 기록 안 함)');
      log(`  ${pad(spec.labelKo, labelW)} → ${mark} ${hint}`);
    }
  }

  if (unmatched.length > 0) {
    log();
    warn(
      `자동 제안 실패: ${unmatched.map((k) => FIELD_SPEC_BY_KEY[k].labelKo).join(', ')} ` +
        `— 이름이 예상과 달라서일 뿐, 위 "후보" 중에서 앱 설정 화면에서 직접 고르면 됩니다.`,
    );
  }
}

/** 쓰기 검증. 대상 날짜에 이미 행이 있으면 덮어쓰지 않고 중단한다. */
async function runWriteTest(
  client: NotionClient,
  databaseId: string,
  schema: DatabaseSchema,
  mapping: FieldMapping,
  dateKey: string,
): Promise<void> {
  const dateName = mapping.date;
  if (!dateName) {
    fail('날짜 필드가 매핑되지 않아 쓰기 검증을 할 수 없습니다 (중복 방지의 기준입니다).');
    return;
  }
  const dateProp = schema.properties.find((p) => p.name === dateName);
  if (!dateProp) {
    fail(`매핑된 날짜 Property "${dateName}" 를 스키마에서 찾지 못했습니다.`);
    return;
  }

  const countRows = async (): Promise<number> => {
    const filter = buildDateFilter(dateProp, dateKey);
    if (!filter) return -1;
    const res = await client.request<any>('POST', `/databases/${normalizeId(databaseId)}/query`, {
      filter,
      page_size: 20,
    });
    return (res?.results ?? []).filter((p: any) => p && p.archived !== true).length;
  };

  const before = await countRows();
  if (before === -1) {
    fail(`날짜 Property 타입(${dateProp.type})으로는 조회 필터를 만들 수 없습니다.`);
    return;
  }
  if (before > 0) {
    warn(
      `${dateKey} 에 이미 행이 ${before}개 있습니다. 기존 데이터를 덮어쓰지 않기 위해 ` +
        `쓰기 검증을 건너뜁니다.`,
    );
    log(c.dim(`  비어 있는 날짜로 검증하려면: npm run notion:doctor -- --write-test --date=YYYY-MM-DD`));
    return;
  }

  const noonKst = new Date(`${dateKey}T12:00:00+09:00`).getTime();
  const record: DayRecordPayload = {
    date: dateKey,
    employeeName: null,
    eventLogText: null,
    clockInIso: toKstIso(noonKst),
    clockOutIso: toKstIso(noonKst + 60_000),
    clockInText: '12:00',
    clockOutText: '12:01',
    actualHours: 0.0167,
    awayHours: 0,
    vacationHours: 0,
    creditedHours: 0.0167,
    statusText: '연동 테스트',
  };

  log(c.dim(`  ${dateKey} 로 테스트 행을 만들고, 같은 날짜로 한 번 더 저장해 중복이 생기는지 봅니다.`));

  const first = await upsertDayRecord({ client, databaseId, schema, mapping, record });
  ok(`1차 저장: ${first.action === 'created' ? '새 행 생성' : '기존 행 갱신'}`);
  if (first.skipped.length) {
    log(
      c.dim(
        `  건너뛴 필드: ${first.skipped
          .map((s) => `${FIELD_SPEC_BY_KEY[s.field].labelKo}(${s.reason})`)
          .join(', ')}`,
      ),
    );
  }

  // knownPageId 를 일부러 주지 않는다 — 날짜 조회 기반 중복 방지가 실제로 되는지 봐야 한다.
  const second = await upsertDayRecord({ client, databaseId, schema, mapping, record });
  const after = await countRows();

  if (after === 1 && second.action === 'updated') {
    ok(`중복 방지 확인 — 두 번 저장했지만 ${dateKey} 행은 1개입니다.`);
  } else {
    fail(`중복 방지 실패 — ${dateKey} 행이 ${after}개입니다 (2차 동작: ${second.action}).`);
  }
  if (second.duplicateWarning) warn(second.duplicateWarning);
  if (first.url) log(c.dim(`  테스트 행: ${first.url}`));
  log(c.dim('  이 행은 자동으로 지우지 않습니다. 필요 없으면 Notion 에서 직접 삭제하세요.'));
}

// ---------------------------------------------------------------------------
// 오류 해설
// ---------------------------------------------------------------------------

function explain(err: unknown): void {
  if (!(err instanceof NotionError)) {
    fail(`예상치 못한 오류: ${(err as Error)?.message ?? String(err)}`);
    return;
  }

  fail(`${err.message} ${c.dim(`[${err.code} / HTTP ${err.status}]`)}`);
  log();

  switch (err.code) {
    case 'unauthorized':
      log('  → NOTION_TOKEN 이 틀렸거나 만료됐습니다.');
      log('    https://www.notion.so/my-integrations 에서 Secret 을 다시 복사하세요.');
      log('    (Secret 은 "ntn_" 또는 예전 형식이면 "secret_" 으로 시작합니다)');
      break;
    case 'object_not_found':
      log('  → 가장 흔한 원인: DB 를 integration 에 연결하지 않았습니다.');
      log('    Notion 에서 그 DB 를 전체 페이지로 연 뒤,');
      log('    우측 상단 ··· → 연결(Connections) → 만든 integration 을 추가하세요.');
      log('    연결 전에는 API 에서 DB 가 아예 존재하지 않는 것처럼 보입니다.');
      log();
      log(`    연결된 DB 목록을 보려면: ${c.cyan('npm run notion:doctor -- --list')}`);
      break;
    case 'invalid_id':
      log('  → NOTION_DATABASE_ID 형식이 올바르지 않습니다.');
      log('    DB 를 전체 페이지로 열었을 때 주소창의 32자리 부분입니다:');
      log(c.dim('    https://www.notion.so/<workspace>/<32자리ID>?v=<viewId>'));
      log('    URL 전체를 --db= 에 그대로 넣어도 됩니다.');
      break;
    case 'validation_error':
      log('  → 요청 형식 문제입니다. 페이지 ID 를 DB ID 로 착각한 경우가 많습니다.');
      log(`    ${c.cyan('npm run notion:doctor -- --list')} 로 실제 DB ID 를 확인하세요.`);
      break;
    case 'restricted_resource':
      log('  → integration 에 이 리소스 권한이 없습니다. 연결과 권한(읽기/쓰기)을 확인하세요.');
      break;
    case 'network_error':
      log('  → 네트워크에서 api.notion.com 에 닿지 못했습니다.');
      log('    회사 방화벽/VPN/프록시 환경이면 해제하고 다시 시도하세요.');
      break;
    default:
      log('  → 위 메시지를 그대로 공유해 주시면 원인을 좁힐 수 있습니다.');
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return 0;
  }

  const root = resolve(import.meta.dirname, '..');
  const fileEnv = loadDotEnv(root);
  const env = (k: string): string => (process.env[k] ?? fileEnv[k] ?? '').trim();

  log();
  log(c.bold('Notion 연동 진단'));
  log(c.dim('기본 동작은 읽기 전용입니다. 기존 데이터를 수정하거나 삭제하지 않습니다.'));

  // --- 1. 환경변수 -----------------------------------------------------------
  section('1. 환경변수');

  const token = env('NOTION_TOKEN');
  const rawDb = args.db || env('NOTION_DATABASE_ID');
  const version = env('NOTION_VERSION') || DEFAULT_NOTION_VERSION;

  if (!token) {
    fail('NOTION_TOKEN 이 없습니다.');
    log();
    log('  1) cp .env.example .env');
    log('  2) https://www.notion.so/my-integrations → New integration → Internal');
    log('  3) Secret 을 복사해 .env 의 NOTION_TOKEN= 뒤에 붙여넣기');
    return 1;
  }
  ok(`NOTION_TOKEN — ${maskToken(token)}`);
  log(c.dim(`  Notion-Version: ${version}`));
  if (!/^(ntn_|secret_)/.test(token)) {
    warn('토큰이 "ntn_" 또는 "secret_" 으로 시작하지 않습니다. 다른 값을 붙여넣지 않았는지 확인하세요.');
  }

  // NOTION_BASE_URL 은 이 스크립트 자체를 검증할 때만 쓰는 탈출구다 (모의 서버 지정).
  // 평소에는 설정하지 않는다 — 비어 있으면 실제 api.notion.com 을 쓴다.
  const baseUrl = env('NOTION_BASE_URL');
  if (baseUrl) warn(`NOTION_BASE_URL 이 설정되어 있습니다: ${baseUrl} (실제 Notion 이 아닙니다)`);

  const client = new NotionClient({
    token,
    notionVersion: version,
    ...(baseUrl ? { baseUrl } : {}),
  });

  // --- 2. 토큰 검증 ----------------------------------------------------------
  section('2. 토큰 검증');
  try {
    await checkToken(client);
  } catch (err) {
    explain(err);
    return 1;
  }

  // --- 3. DB 목록 ------------------------------------------------------------
  if (args.list || !rawDb) {
    section('3. integration 이 접근할 수 있는 DB');
    let databases: FoundDatabase[] = [];
    try {
      databases = await listDatabases(client);
    } catch (err) {
      explain(err);
      return 1;
    }

    if (databases.length === 0) {
      warn('접근 가능한 DB 가 하나도 없습니다.');
      log();
      log('  근무시간 DB 를 전체 페이지로 연 뒤 ··· → 연결 → integration 추가를 해주세요.');
      log('  연결하지 않으면 API 에서는 보이지 않습니다.');
      return 1;
    }

    for (const db of databases) {
      log(`  ${c.cyan(db.title)}`);
      log(c.dim(`    id : ${normalizeId(db.id)}`));
      if (db.url) log(c.dim(`    url: ${db.url}`));
    }
    log();
    log('  위에서 근무시간 DB 의 id 를 골라 .env 의 NOTION_DATABASE_ID 에 넣거나,');
    log(`  ${c.cyan('npm run notion:doctor -- --db=<id>')} 로 바로 확인하세요.`);

    if (!rawDb) return databases.length > 0 ? 0 : 1;
  }

  // --- 4. 스키마 -------------------------------------------------------------
  section('4. DB 스키마');

  let normalized: string;
  try {
    normalized = normalizeId(rawDb);
  } catch (err) {
    explain(err);
    return 1;
  }
  log(c.dim(`  database id: ${normalized}`));

  let schema: DatabaseSchema;
  try {
    schema = await fetchDatabaseSchema(client, normalized);
  } catch (err) {
    explain(err);
    return 1;
  }

  ok(`"${schema.title}" — Property ${schema.properties.length}개`);
  if (schema.url) log(c.dim(`  ${schema.url}`));
  log();
  printProperties(schema);

  // --- 5. 매핑 제안 ----------------------------------------------------------
  section('5. 자동 매핑 제안');
  log(c.dim('  제안일 뿐입니다. 확정은 앱 설정 화면에서 직접 고릅니다.'));
  log();
  const { mapping, unmatched } = suggestMapping(schema.properties);
  printMapping(schema, mapping, unmatched);

  const dateOk = Boolean(mapping.date);
  log();
  if (dateOk) {
    ok('필수 필드(날짜)가 매핑되었습니다. 이대로 동기화할 수 있습니다.');
  } else {
    warn('필수 필드(날짜)를 자동으로 찾지 못했습니다. 앱 설정에서 직접 지정해야 합니다.');
  }

  const untouched = schema.properties.filter(
    (p) => !Object.values(mapping).includes(p.name),
  );
  if (untouched.length > 0) {
    log(
      c.dim(
        `  앱이 건드리지 않는 Property (${untouched.length}개): ${untouched
          .map((p) => p.name)
          .join(', ')}`,
      ),
    );
  }

  // --- 6. 쓰기 검증 ----------------------------------------------------------
  if (args.writeTest) {
    section('6. 쓰기 · 중복 방지 검증');
    const dateKey = args.date || toDateKey(Date.now());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      fail(`--date 형식이 올바르지 않습니다: "${dateKey}" (YYYY-MM-DD)`);
      return 1;
    }
    try {
      await runWriteTest(client, normalized, schema, mapping, dateKey);
    } catch (err) {
      explain(err);
      return 1;
    }
  } else {
    section('6. 쓰기 검증 (건너뜀)');
    log(c.dim('  실제 저장까지 확인하려면:'));
    log(`  ${c.cyan('npm run notion:doctor -- --write-test')}`);
    log(c.dim('  대상 날짜에 이미 행이 있으면 덮어쓰지 않고 중단합니다.'));
  }

  // --- 7. 요약 (붙여넣기용) ---------------------------------------------------
  section('7. 요약 — 아래 블록을 그대로 복사해서 공유하세요');
  log(c.dim('  (토큰·개인정보는 포함되지 않습니다)'));
  log();
  log(
    JSON.stringify(
      {
        database: { title: schema.title, propertyCount: schema.properties.length },
        properties: schema.properties.map((p: NotionPropertyInfo) => ({
          name: p.name,
          type: p.type,
          ...(p.options ? { options: p.options } : {}),
        })),
        suggestedMapping: mapping,
        unmatched,
        requiredDateMapped: dateOk,
      },
      null,
      2,
    ),
  );

  log();
  return dateOk ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    log();
    explain(err);
    process.exitCode = 1;
  });
