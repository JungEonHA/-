#!/usr/bin/env bash
#
# 특별 휴가 부여 알림에 필요한 환경변수를 Vercel 에 넣는다.
#
# 왜 스크립트인가 — 웹훅 URL 은 그걸 아는 사람이면 누구나 그 채널에 글을 쓸 수 있는
# 열쇠다. 화면에 띄워 손으로 옮기면 터미널 기록·클립보드·스크롤백에 그대로 남는다.
# 여기서는 discord-os 의 .env 에서 읽어 파이프로 곧장 넘기므로 어디에도 남지 않는다.
#
# 쓰기 전에:
#   npx vercel login     (사람이 직접 — 자동화할 수 없다)
#   npx vercel link      (프로젝트 notion_work_timer_2 에 연결)
#
# 사용:
#   scripts/setup-discord-env.sh [discord-os 경로]
#
# 넣는 값 세 개:
#   WEBHOOK_WORKTIME_ID / WEBHOOK_WORKTIME_TOKEN  — ⏰-근무현황 채널 웹훅 (discord-os 산출물)
#   DISCORD_USER_IDS                              — 멘션용 이름→id 표
#
# 이미 있는 값은 Vercel 이 거부하므로, 바꿀 때는 먼저 지운다:
#   npx vercel env rm WEBHOOK_WORKTIME_ID production

set -euo pipefail

DISCORD_OS="${1:-$HOME/dongbaek/Dongbaek/discord-os}"
ENV_FILE="$DISCORD_OS/.env"
TARGET="${VERCEL_ENV_TARGET:-production}"

if [ ! -f "$ENV_FILE" ]; then
  echo "discord-os 의 .env 를 찾지 못했습니다: $ENV_FILE" >&2
  echo "경로를 인자로 넘기세요: $0 <discord-os 경로>" >&2
  exit 1
fi

# .env 를 통째로 source 하지 않는다 — 토큰 수십 개가 이 셸에 딸려 들어올 이유가 없다.
read_env() {
  grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r' | sed 's/^"//; s/"$//'
}

WEBHOOK_ID="$(read_env WEBHOOK_WORKTIME_ID)"
WEBHOOK_TOKEN="$(read_env WEBHOOK_WORKTIME_TOKEN)"

if [ -z "$WEBHOOK_ID" ] || [ -z "$WEBHOOK_TOKEN" ]; then
  echo "WEBHOOK_WORKTIME_ID / WEBHOOK_WORKTIME_TOKEN 이 $ENV_FILE 에 없습니다." >&2
  echo "discord-os 에서 'npm run worktime:setup' 을 먼저 실행하세요." >&2
  exit 1
fi

# 멘션 대상. 이름은 앱 설정의 '직원' 이름과 정확히 같아야 한다 — 다르면 멘션 대신
# 이름만 굵게 나온다(알림 자체는 그대로 간다).
CEO_ID="$(read_env DISCORD_CEO_USER_IDS)"
COFOUNDER_ID="$(read_env DISCORD_COFOUNDER_USER_ID)"
USER_IDS="${DISCORD_USER_IDS_OVERRIDE:-하정언:${CEO_ID},박진규:${COFOUNDER_ID}}"

echo "대상 환경 : $TARGET"
echo "웹훅      : ${WEBHOOK_ID:0:4}… (읽음)"
echo "멘션 표   : $USER_IDS"
echo

put() {
  printf '%s' "$2" | npx vercel env add "$1" "$TARGET"
}

put WEBHOOK_WORKTIME_ID "$WEBHOOK_ID"
put WEBHOOK_WORKTIME_TOKEN "$WEBHOOK_TOKEN"
put DISCORD_USER_IDS "$USER_IDS"

echo
echo "완료. 환경변수는 다음 배포부터 적용됩니다:"
echo "  npx vercel --prod"
echo "확인:  curl -s https://notionworktimer2.vercel.app/api/health"
