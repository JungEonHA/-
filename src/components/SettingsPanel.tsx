import { useEffect, useMemo, useRef, useState } from 'react';
import { FIELD_SPECS, type LogicalField } from '../../shared/fields';
import { useSnapshot, useStore } from '../hooks/useAppStore';
import { HOUR_MS, formatClockSeconds, formatDateKeyKo } from '../lib/time';
import { MAX_AUTO_ATTEMPTS } from '../lib/store';
import { Banner, Card, EmptyState } from './ui';

export function SettingsPanel() {
  const store = useStore();
  const { state, runtime } = useSnapshot();
  const notion = state.notion;

  useEffect(() => {
    // 패널을 처음 열 때 한 번 백엔드 상태를 확인한다.
    if (runtime.backend === 'checking') void store.checkBackend();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const outbox = useMemo(
    () => Object.values(state.outbox).sort((a, b) => a.queuedAt - b.queuedAt),
    [state.outbox],
  );

  const schema = notion.schema;
  const mappedDate = Boolean(notion.mapping.date);

  return (
    <div className="stack">
      <EmployeeCard />
      <ConnectionCard />

      <Card
        title="Property 매핑"
        hint={schema ? `DB: ${schema.title}` : '스키마 미조회'}
        action={
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            data-testid="btn-refresh-schema"
            onClick={() => void store.refreshSchema()}
            disabled={runtime.backend !== 'ready'}
          >
            스키마 다시 읽기
          </button>
        }
      >
        {!schema ? (
          <EmptyState>
            Notion DB의 실제 Property 목록을 아직 읽지 않았습니다.
            <br />
            백엔드를 연결한 뒤 “스키마 다시 읽기”를 눌러 주세요.
          </EmptyState>
        ) : (
          <>
            {!mappedDate && (
              <div style={{ marginBottom: 12 }}>
                <Banner kind="danger">
                  <b>날짜</b> 필드가 매핑되지 않았습니다. 이 필드는 같은 날짜에 행이 중복
                  생성되는 것을 막는 기준이므로 반드시 지정해야 동기화가 동작합니다.
                </Banner>
              </div>
            )}

            {FIELD_SPECS.map((spec) => {
              const compatible = schema.properties.filter((p) =>
                spec.acceptedTypes.includes(p.type),
              );
              const value = notion.mapping[spec.key] ?? '';
              return (
                <div className="field" key={spec.key}>
                  <label className="field__label" htmlFor={`map-${spec.key}`}>
                    {spec.labelKo}
                    {spec.required && <span style={{ color: 'var(--danger)' }}> *</span>}
                  </label>
                  <select
                    id={`map-${spec.key}`}
                    className="select"
                    value={value}
                    data-testid={`map-${spec.key}`}
                    onChange={(e) => store.setMappingField(spec.key, e.target.value || null)}
                  >
                    <option value="">— 사용 안 함 —</option>
                    {compatible.map((p) => (
                      <option key={p.id} value={p.name}>
                        {p.name} ({p.type})
                      </option>
                    ))}
                  </select>
                  <span className="field__hint">
                    {spec.descriptionKo}
                    {compatible.length === 0 &&
                      ` · 호환 타입(${spec.acceptedTypes.join(', ')})의 Property가 DB에 없습니다.`}
                  </span>
                </div>
              );
            })}

            <MissingPropertiesAction />
          </>
        )}
      </Card>

      <Card
        title={runtime.backend === 'ready' ? '동기화 대기열' : '기록 보관함'}
        hint={
          state.lastSyncAt
            ? `마지막 성공 ${formatClockSeconds(state.lastSyncAt)}`
            : '아직 동기화한 적 없음'
        }
        action={
          <button
            type="button"
            className="btn btn--primary btn--sm"
            data-testid="btn-sync-now"
            disabled={runtime.syncing}
            onClick={() => void store.drainOutbox({ force: true })}
          >
            {runtime.syncing ? '동기화 중…' : '지금 동기화'}
          </button>
        }
      >
        {runtime.syncBlocked && (
          <div style={{ marginBottom: 12 }}>
            <Banner kind="danger">{runtime.syncBlocked}</Banner>
          </div>
        )}

        {runtime.backend !== 'ready' && outbox.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <Banner kind="info">
              Notion을 아직 연결하지 않아 {outbox.length}일치 기록이 이 기기에 보관돼 있습니다.
              나중에 연결하면 <b>한 번에 모두 기록</b>됩니다. 지금 당장 할 일은 없습니다.
            </Banner>
          </div>
        )}

        <LastSyncSummary />

        {outbox.length === 0 ? (
          <EmptyState>
            {runtime.backend === 'ready'
              ? '대기 중인 항목이 없습니다. 모든 기록이 Notion에 반영되었습니다.'
              : '아직 확정된 근무 기록이 없습니다. 퇴근 처리를 하면 여기에 쌓입니다.'}
          </EmptyState>
        ) : (
          <div className="list" data-testid="outbox-list">
            {outbox.map((entry) => (
              <div className="listRow" key={entry.dateKey}>
                <div className="listRow__main">
                  <div className="listRow__title">{formatDateKeyKo(entry.dateKey)}</div>
                  <div className="listRow__sub">
                    {entry.lastError
                      ? `실패 ${entry.attempts}회 · ${entry.lastError}`
                      : '전송 대기 중'}
                    {entry.attempts >= MAX_AUTO_ATTEMPTS && ' · 자동 재시도 중단됨'}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => store.enqueue(entry.dateKey, { auto: true })}
                >
                  재시도
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="btnRow mt12">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            data-testid="btn-resync-today"
            disabled={runtime.syncing || runtime.backend !== 'ready'}
            onClick={() => store.resync(store.activeDate)}
          >
            오늘 기록 다시 보내기
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            data-testid="btn-pull-today"
            disabled={runtime.backend !== 'ready'}
            onClick={() => void store.pullDay(store.activeDate, { notify: true })}
          >
            다른 기기 기록 가져오기
          </button>
        </div>

        <p className="field__hint mt12">
          동기화가 실패해도 근무 기록은 이 기기에 그대로 남아 있습니다. 네트워크가 복구되면
          자동으로 다시 시도하며, 같은 날짜·같은 직원은 항상 하나의 행으로 갱신됩니다. 매핑을 바꾼
          뒤에는 “다시 보내기”로 그 날짜를 새 매핑에 맞춰 다시 기록할 수 있습니다.
        </p>
      </Card>

      <VacationConfigCard />
      <DataCard />
    </div>
  );
}

/**
 * 이 기기를 쓰는 직원을 정하는 카드.
 *
 * 근무 기록은 브라우저마다 따로 쌓이므로 "한 기기 = 한 사람"이 전제다.
 * 선택지는 Notion `직원` Property 의 실제 옵션에서 그대로 가져온다 — 앱에 사람 이름을
 * 하드코딩하면 직원이 바뀔 때마다 배포를 다시 해야 한다.
 */
function EmployeeCard() {
  const store = useStore();
  const { state } = useSnapshot();
  const { employeeName, mapping, schema } = state.notion;
  const [custom, setCustom] = useState(employeeName);

  const employeeProp = mapping.employee
    ? schema?.properties.find((p) => p.name === mapping.employee)
    : undefined;
  const options = employeeProp?.options ?? [];
  const known = options.includes(employeeName);

  return (
    <Card title="직원" hint={employeeName || '미설정'}>
      {!mapping.eventLog && (
        <div style={{ marginBottom: 12 }}>
          <Banner kind="warn">
            <b>기기 연동 로그</b>가 매핑되지 않았습니다. 지금은 데스크탑과 노트북 기록이 따로
            쌓이며, 나중에 저장한 기기가 앞선 기록을 덮어씁니다. 아래 “Property 매핑”에서
            지정하거나 “누락된 Property를 Notion에 추가”를 눌러 주세요.
          </Banner>
        </div>
      )}

      {!mapping.employee ? (
        <Banner kind="warn">
          <b>직원</b> 필드가 매핑되지 않았습니다. 아래 “Property 매핑”에서 Notion의 직원 Property를
          지정하면, 여러 명이 같은 DB를 써도 서로의 기록을 덮어쓰지 않습니다.
        </Banner>
      ) : !employeeName ? (
        <Banner kind="danger">
          이 기기를 쓰는 사람을 선택해야 Notion에 기록됩니다. 누구의 기록인지 정하지 않으면 다른
          직원 행과 섞일 수 있어 동기화를 멈춰 둡니다.
        </Banner>
      ) : (
        <Banner kind="success">
          이 기기의 기록은 <b>{employeeName}</b> 님의 것으로 저장됩니다.
        </Banner>
      )}

      {options.length > 0 && (
        <div className="field mt16">
          <label className="field__label" htmlFor="employee-select">
            직원 선택
          </label>
          <select
            id="employee-select"
            className="select"
            data-testid="select-employee"
            value={known ? employeeName : ''}
            onChange={(e) => {
              store.setEmployeeName(e.target.value);
              setCustom(e.target.value);
            }}
          >
            <option value="">— 선택 안 함 —</option>
            {options.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <span className="field__hint">
            Notion “{employeeProp?.name}” Property의 선택지입니다. 사람을 추가하려면 Notion에서 옵션을
            먼저 만든 뒤 “스키마 다시 읽기”를 누르세요.
          </span>
        </div>
      )}

      <div className="field">
        <label className="field__label" htmlFor="employee-name">
          직접 입력
        </label>
        <input
          id="employee-name"
          className="input"
          value={custom}
          data-testid="input-employee"
          placeholder="예: 정어리"
          onChange={(e) => setCustom(e.target.value)}
          onBlur={() => store.setEmployeeName(custom)}
        />
        <span className="field__hint">
          기기를 다른 사람에게 넘길 때 이 값을 바꾸세요. 바꾸면 이전 사람의 Notion 행은 더 이상
          갱신하지 않습니다.
        </span>
      </div>
    </Card>
  );
}

function ConnectionCard() {
  const store = useStore();
  const { state, runtime } = useSnapshot();
  const [apiBase, setApiBase] = useState(state.notion.apiBase);
  const [accessKey, setAccessKey] = useState(state.notion.accessKey);

  const statusBanner =
    runtime.backend === 'ready' ? (
      <Banner kind="success">
        백엔드 연결됨 · Notion API {runtime.backendInfo?.notionVersion}
        {runtime.backendInfo?.writeAllowed === false && ' · 쓰기 비활성(NOTION_ALLOW_WRITE≠1)'}
      </Banner>
    ) : runtime.backend === 'checking' ? (
      <Banner kind="info">백엔드 상태를 확인하는 중…</Banner>
    ) : runtime.backend === 'unavailable' ? (
      <Banner kind="warn">
        이 주소에는 Notion 연동 백엔드가 없습니다(정적 배포). 근무 기록·휴가·집계는 모두
        정상 동작하며, Notion 저장만 비활성화됩니다. 백엔드 URL을 입력하면 연결됩니다.
      </Banner>
    ) : (
      <Banner kind="danger">{runtime.backendError ?? '백엔드 오류'}</Banner>
    );

  return (
    <Card
      title="Notion 연결"
      action={
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          data-testid="btn-check-backend"
          onClick={() => void store.checkBackend({ force: true })}
        >
          연결 확인
        </button>
      }
    >
      {statusBanner}

      <div className="field mt16">
        <label className="field__label" htmlFor="api-base">
          백엔드 주소
        </label>
        <input
          id="api-base"
          className="input"
          placeholder="비워두면 현재 도메인의 /api 사용"
          value={apiBase}
          data-testid="input-api-base"
          onChange={(e) => setApiBase(e.target.value)}
          onBlur={() => {
            store.updateNotionSettings({ apiBase: apiBase.trim().replace(/\/+$/, '') });
            void store.checkBackend({ force: true });
          }}
        />
        <span className="field__hint">
          예: https://my-worktime.vercel.app — 정적 호스팅(GitHub Pages)에서 별도 백엔드를 쓸 때만
          입력하세요.
        </span>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="access-key">
          접근 키 (선택)
        </label>
        <input
          id="access-key"
          className="input"
          type="password"
          value={accessKey}
          autoComplete="off"
          onChange={(e) => setAccessKey(e.target.value)}
          onBlur={() => store.updateNotionSettings({ accessKey })}
        />
        <span className="field__hint">
          서버에 APP_ACCESS_KEY를 설정했을 때만 입력합니다. Notion Secret 이 아니며, Notion
          Secret 은 브라우저에 절대 저장되지 않습니다.
        </span>
      </div>

      <div className="switchRow">
        <div>
          <div className="strong" style={{ fontSize: 13.5 }}>
            자동 동기화
          </div>
          <div className="field__hint">
            출근 · 자리 비움 · 복귀 · 퇴근 · 업무 복귀 · 휴가 변경 때마다 Notion에 자동 기록
          </div>
        </div>
        <input
          type="checkbox"
          checked={state.notion.autoSync}
          data-testid="toggle-autosync"
          onChange={(e) => store.updateNotionSettings({ autoSync: e.target.checked })}
        />
      </div>
    </Card>
  );
}

/**
 * 마지막 동기화가 "무엇을" 했는지 보여준다.
 *
 * 시각만 남기면 사용자는 Notion을 직접 열어 보기 전까지 진짜 갔는지 알 수 없다.
 * 어느 날짜·누구 기록을, 새로 만들었는지 갱신했는지, 그리고 그 행으로 가는 링크까지 남긴다.
 */
function LastSyncSummary() {
  const { state } = useSnapshot();
  const last = state.lastSync;
  if (!last) return null;

  return (
    <div className="mt12" data-testid="last-sync">
      <Banner kind={last.warning ? 'warn' : 'success'}>
        {formatClockSeconds(last.at)} · {formatDateKeyKo(last.dateKey)}
        {last.employeeName ? ` · ${last.employeeName}` : ''} 기록을{' '}
        {last.action === 'created' ? '새로 만들었습니다' : '갱신했습니다'}.
        {last.pageUrl && (
          <>
            {' '}
            <a href={last.pageUrl} target="_blank" rel="noreferrer">
              Notion에서 열기
            </a>
          </>
        )}
        {last.warning && (
          <>
            <br />
            {last.warning}
          </>
        )}
      </Banner>
    </div>
  );
}

function MissingPropertiesAction() {
  const store = useStore();
  const { state } = useSnapshot();
  const missing = FIELD_SPECS.filter((s) => s.key !== 'title' && !state.notion.mapping[s.key]).map(
    (s) => s.key as LogicalField,
  );

  if (missing.length === 0) return null;

  return (
    <div className="mt12">
      <Banner kind="info">
        매핑되지 않은 필드: {missing.length}개. 기존 DB를 건드리고 싶지 않다면 그대로 두세요 —
        해당 값은 기록에서 제외될 뿐 오류가 나지 않습니다.
      </Banner>
      <button
        type="button"
        className="btn btn--ghost btn--sm mt8"
        onClick={() => {
          if (
            window.confirm(
              `Notion DB에 Property ${missing.length}개를 새로 추가합니다.\n` +
                '기존 Property와 데이터는 변경되지 않습니다. 계속할까요?',
            )
          ) {
            void store.addMissingProperties(missing);
          }
        }}
      >
        누락된 Property를 Notion에 추가
      </button>
    </div>
  );
}

function VacationConfigCard() {
  const store = useStore();
  const { state } = useSnapshot();
  const v = state.vacation;

  return (
    <Card title="휴가 설정">
      <div className="field">
        <label className="field__label" htmlFor="grant-start">
          지급 시작 월
        </label>
        <input
          id="grant-start"
          className="input"
          type="month"
          value={v.grantStartMonth}
          data-testid="input-grant-start"
          onChange={(e) =>
            e.target.value && store.updateVacationConfig({ grantStartMonth: e.target.value })
          }
        />
        <span className="field__hint">
          이 달부터 매월 휴가가 지급된 것으로 계산합니다. 이월 잔여량이 이 값에 따라 달라집니다.
        </span>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="grant-hours">
          월 지급 시간
        </label>
        <input
          id="grant-hours"
          className="input"
          type="number"
          min={0}
          max={200}
          step={1}
          value={v.monthlyGrantMs / HOUR_MS}
          data-testid="input-grant-hours"
          onChange={(e) => {
            const h = Number(e.target.value);
            if (Number.isFinite(h) && h >= 0) {
              store.updateVacationConfig({ monthlyGrantMs: h * HOUR_MS });
            }
          }}
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="daily-cap">
          하루 최대 사용 시간
        </label>
        <input
          id="daily-cap"
          className="input"
          type="number"
          min={1}
          max={24}
          step={1}
          value={v.dailyCapMs / HOUR_MS}
          onChange={(e) => {
            const h = Number(e.target.value);
            if (Number.isFinite(h) && h > 0) store.updateVacationConfig({ dailyCapMs: h * HOUR_MS });
          }}
        />
      </div>
    </Card>
  );
}

function DataCard() {
  const store = useStore();
  const { runtime } = useSnapshot();
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <Card title="데이터 백업">
      {!runtime.storagePersistent && (
        <div style={{ marginBottom: 12 }}>
          <Banner kind="danger">
            이 브라우저에서 로컬 저장소를 쓸 수 없습니다(iframe 차단 또는 시크릿 모드). 탭을 닫으면
            기록이 사라집니다. Notion 동기화를 켜거나, 새 탭에서 앱을 직접 열어 사용하세요.
          </Banner>
        </div>
      )}
      {runtime.saveError && (
        <div style={{ marginBottom: 12 }}>
          <Banner kind="danger">저장 실패: {runtime.saveError}</Banner>
        </div>
      )}

      <div className="btnRow">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => {
            const blob = new Blob([store.exportJson()], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `worktime-backup-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          JSON 내보내기
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => fileRef.current?.click()}
        >
          JSON 가져오기
        </button>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="application/json"
        className="sr-only"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          store.importJson(await file.text());
          e.target.value = '';
        }}
      />

      <p className="field__hint mt12">
        브라우저 데이터를 지우기 전이나 기기를 옮길 때 내보내기를 사용하세요. Notion에 이미
        기록된 내용은 이 작업과 무관하게 그대로 유지됩니다.
      </p>
    </Card>
  );
}
