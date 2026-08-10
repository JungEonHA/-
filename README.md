# 근무시간 관리 (Notion Embed)

실시간 출퇴근 타이머 · 휴가 관리 · 주간/월간 집계 · Notion 자동 기록.
Notion 페이지에 그대로 Embed 할 수 있는 개인용 근무시간 관리 웹앱.

```
출근 → 자리 비움 → 복귀 → 퇴근 → Notion 근무시간 DB 에 자동 기록
```

---

## 설계 요점

### 1. 시간 계산 — 카운터를 쓰지 않는다

`setInterval` 로 숫자를 더해 나가는 방식은 탭이 백그라운드로 내려가거나(브라우저 throttling),
컴퓨터가 절전에 들어가거나, 새로고침하는 순간 값이 어긋난다.

이 앱은 **출근/자리비움/복귀/퇴근의 절대 시각(epoch ms)만 append-only 로 저장**하고,
화면을 그릴 때마다 그 타임스탬프로부터 경과시간을 다시 계산한다.
`setInterval` 은 오직 "다시 그릴 때가 됐다"고 알리는 용도이며 계산에 관여하지 않는다.

덕분에

- 백그라운드 탭에서 타이머가 1초에 한 번도 못 돌아도 값이 정확하다
- 절전에서 깨어나면 흐른 시간이 그대로 반영된다 (`visibilitychange` / `focus` 에서 즉시 재계산)
- 새로고침해도 이벤트만 복원하면 상태와 경과시간이 그대로다

시간대는 **Asia/Seoul 고정 오프셋(UTC+09:00)** 으로 계산한다. 한국은 1988년 이후 서머타임이
없으므로, 런타임 tz 데이터에 의존하는 대신 결정적인 고정 오프셋 산술을 쓴다.

### 2. 실제 근무 / 휴가 대체 / 인정 근무의 분리

| 값 | 의미 |
| --- | --- |
| 실제 근무시간 | 자리 비움을 제외하고 실제로 일한 시간 |
| 휴가 대체시간 | 해당 일자에 사용한 휴가 |
| 인정 근무시간 | 실제 근무시간 + 휴가 대체시간 |

### 3. 휴가 — 잔여를 저장하지 않는다

매월 8시간(설정 가능) 지급, 미사용분은 다음 달로 이월.

잔여량을 어딘가에 저장해 두고 더하고 빼면 언젠가 어긋난다. 대신 **항상
`지급 누계 − 사용 누계` 로 다시 계산**한다. 사용 내역은 근무 기록과 같은 곳
(`DayLog.vacationMs`)에 저장되므로 두 데이터가 따로 놀 수 없다.

```
1월 지급 8h, 1월 사용 3h  →  잔여 5h
2월 지급 8h              →  2월 사용 가능 13h
```

### 4. 데이터 안정성 — 로컬이 1차 진실

Notion 동기화는 로컬 기록 위에 얹힌 부가 작업이다.

- 동기화가 실패해도 로컬 기록은 **절대 지워지거나 되돌려지지 않는다**
- 실패한 항목은 outbox 에 남아 지수 백오프로 자동 재시도되고, 수동 재시도도 가능하다
- outbox 는 "어떤 날짜가 dirty 한가"만 담는다. 전송 페이로드는 보내기 직전에 최신
  로그로부터 다시 만들기 때문에, 재시도가 낡은 값을 덮어쓸 수 없다
- localStorage 를 쓸 수 없는 환경(iframe 차단/시크릿 모드)을 감지해 경고를 띄우고
  메모리 저장소로 대체한다
- 저장 슬롯이 손상되면 백업 슬롯에서 복구한다. JSON 내보내기/가져오기도 지원한다

### 5. Notion Property 를 하드코딩하지 않는다

앱은 실제 DB 의 Property 이름을 **추측하지 않는다.**

1. 서버가 런타임에 `GET /v1/databases/{id}` 로 실제 스키마를 읽는다
2. 이름·타입이 호환되는 후보를 **제안**한다 (확정은 사용자가 설정 화면에서 한다)
3. 매핑되지 않았거나 타입이 안 맞는 필드는 조용히 **건너뛴다** — 억지로 쓰지 않는다
4. Property 추가는 명시적으로 버튼을 눌렀을 때만, **추가만** 한다

기존 데이터 보호:

- 페이지 갱신은 `PATCH`(부분 병합)이므로 매핑된 Property 외에는 건드리지 않는다
- 삭제/아카이브를 하는 코드 경로가 **존재하지 않는다**
- 같은 날짜의 행이 여러 개면 가장 오래된 것만 갱신하고 나머지는 그대로 둔 채 경고한다

### 6. 중복 기록 방지

퇴근할 때마다 행이 늘어나면 안 되므로:

1. 앱이 기억하는 `pageId` 가 있으면 바로 `PATCH` (없어졌으면 아래로 폴백)
2. 없으면 날짜 Property 로 조회 → 있으면 갱신, 없으면 생성

### 7. Secret 은 브라우저에 없다

`NOTION_TOKEN` 은 서버리스 함수에서만 읽힌다. 프론트엔드 번들에 들어가는 값은
`VITE_` 접두사가 붙은 것뿐이며, Notion 관련 값에는 그 접두사를 쓰지 않는다.
(애초에 Notion API 는 CORS 를 허용하지 않아 브라우저 직접 호출이 불가능하다.)

---

## 프로젝트 구조

```
shared/fields.ts        논리 필드 정의 (서버·클라이언트 공유)
api/
  _notion.ts            Notion 클라이언트, 스키마 탐색, 매핑, upsert
  _router.ts            프레임워크 비의존 API 라우터
  [...path].ts          Vercel 서버리스 진입점
src/lib/
  time.ts               KST 시간 유틸
  events.ts             근무 이벤트 엔진 (타임스탬프 → 경과시간)
  vacation.ts           휴가 원장 (지급·이월·검증)
  aggregate.ts          주간/월간 집계
  storage.ts            영속화 + 손상 복구
  store.ts              상태 저장소 + 동기화 outbox
  notionClient.ts       프론트 → 자체 백엔드
src/components/         UI
tests/                  Notion 연동 테스트 + 모의 Notion 서버
e2e/                    Playwright 종단 테스트
```

---

## 로컬 실행

```bash
npm install
cp .env.example .env      # NOTION_TOKEN / NOTION_DATABASE_ID 입력
npm run dev               # http://127.0.0.1:5173
```

개발 서버는 배포와 **동일한 API 라우터**를 미들웨어로 물려서 실행하므로,
로컬에서 통과한 동작이 배포에서도 그대로 동작한다.

```bash
npm test          # 단위/통합 테스트 (모의 Notion 서버 사용)
npm run e2e       # Playwright 종단 테스트 (실제 브라우저 + 가상 시계)
npm run build     # 타입체크 + 프로덕션 빌드
```

---

## 배포

### A. Vercel — Notion 동기화까지 쓰려면 이쪽 (권장)

정적 파일과 `/api/*` 서버리스 함수가 한 번에 배포된다.

1. https://vercel.com/new 에서 이 저장소를 import (프레임워크는 Vite 로 자동 인식)
2. **Environment Variables** 에 추가:

   | Key | Value |
   | --- | --- |
   | `NOTION_TOKEN` | `ntn_...` (아래 "Notion 준비" 참고) |
   | `NOTION_DATABASE_ID` | 근무시간 DB 의 32자리 ID |
   | `NOTION_ALLOW_WRITE` | `1` |
   | `APP_ACCESS_KEY` | (선택) 아무 문자열. 설정하면 앱 설정에 같은 값을 입력해야 동작 |

3. Deploy → `https://<프로젝트>.vercel.app`

### B. GitHub Pages — 서버 없이 바로 쓰는 정적 배포

`.github/workflows/deploy-pages.yml` 이 포함돼 있다.
저장소 **Settings → Pages → Source 를 "GitHub Actions"** 로 한 번만 바꾸면 이후 push 마다 배포된다.

주소: `https://<username>.github.io/<repo>/`

이 모드에서는 `/api` 가 없으므로 Notion 저장만 비활성화되고, 타이머·휴가·집계는 전부 정상
동작한다. 나중에 Vercel 백엔드를 붙이고 싶으면 앱 **설정 → 백엔드 주소** 에
Vercel 주소를 입력하면 된다.

---

## Notion 준비

1. https://www.notion.so/my-integrations → **New integration** → Internal
   → Secret(`ntn_...`) 복사 → `NOTION_TOKEN`
2. 근무시간 DB 를 전체 페이지로 열고 우측 상단 `···` → **Connections → 방금 만든 integration 추가**
   (이걸 하지 않으면 API 가 DB 를 찾지 못한다)
3. DB URL 에서 ID 를 복사 → `NOTION_DATABASE_ID`

   ```
   https://www.notion.so/<workspace>/<32자리 DATABASE_ID>?v=<viewId>
                                     ^^^^^^^^^^^^^^^^^^^
   ```

4. 배포된 앱 → **설정 → 연결 확인 → 스키마 다시 읽기**
5. **Property 매핑** 에서 실제 Property 를 고른다.
   `날짜` 는 중복 방지 기준이므로 반드시 지정한다. 나머지는 필요한 것만 고르면 되고,
   고르지 않은 필드는 기록에서 제외될 뿐 오류가 나지 않는다.

앱이 다루는 논리 필드: 날짜 · 출근시간 · 퇴근시간 · 실제 근무시간 · 자리 비움시간 ·
휴가시간 · 인정 근무시간 · 상태

---

## Notion 페이지에 Embed

1. 배포 URL 복사
2. Notion 페이지 최하단에서 `/embed` 입력 → **Embed** 선택
3. URL 붙여넣기 → **Embed link**
4. 블록 아래 가장자리를 드래그해 높이를 늘린다 (**900px 이상 권장**)

> 브라우저가 서드파티 저장소를 차단하는 설정(Safari 기본값 등)에서는 iframe 안의
> localStorage 가 막힐 수 있다. 앱이 이를 감지해 설정 화면에 경고를 띄우며,
> 그런 경우 Embed 블록 우측 상단의 **원본 열기**로 새 탭에서 사용하면 된다.

---

## 검증한 항목

단위·통합 140건 + 종단 40건(데스크톱/모바일 각 20건).

| 항목 | 방법 |
| --- | --- |
| 출근 → 타이머 작동 | 단위 + E2E |
| 자리 비움 → 시간 정지 | 단위 + E2E |
| 복귀 → 시간 재개 | 단위 + E2E |
| 퇴근 → 최종 시간 계산 (09-12-13-18 = 8h) | 단위 + E2E |
| 새로고침 후 상태 복구 | 단위 + E2E (`page.reload`) |
| 브라우저 백그라운드 | E2E (`clock.fastForward` + visibilitychange) |
| 컴퓨터 절전 후 복귀 | E2E (`clock.setSystemTime` 으로 타이머 미실행 점프) |
| 자정을 넘긴 근무 | 단위 (출근한 날짜에 귀속) |
| 시계 역행 / 이벤트 순서 뒤섞임 | 단위 |
| 휴가 사용 / 취소 / 한도 초과 거부 | 단위 + E2E |
| 휴가 이월 (1월 8h·3h사용 → 2월 13h) | 단위 + E2E |
| 주간 / 월간 집계 | 단위 + E2E |
| Notion 기록 | 모의 Notion 서버 |
| Notion 중복 기록 방지 | 모의 Notion 서버 (3회 저장 → 행 1개) |
| Notion API 오류 처리 (429/5xx/네트워크/401) | 모의 Notion 서버 |
| 동기화 실패 시 데이터 보존 + 재시도 | 모의 Notion 서버 |
| 매핑 밖 기존 Property 보존 | 모의 Notion 서버 |
| 반응형 (360 / 768 / 1280px) | E2E |
