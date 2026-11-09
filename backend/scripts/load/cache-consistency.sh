#!/usr/bin/env bash
# 인스턴스 2대의 건수 캐시 일관성 확인 — 서버 A에서 글을 쓴 직후 서버 B의 검색 건수가 바로 바뀌는가.
# 메모리 캐시(인스턴스마다 따로)와 Redis(공유 + 세대 무효화)를 비교한다. 로컬 테스트 DB·Redis 전용.
#
#   npm run db:test:up
#   KEEP=1 ROUNDS=1 WARMUP=1 DURATION=1 bash scripts/load/perf-gate.sh   # perf_gate_head DB 준비(합성 데이터)
#   bash scripts/load/cache-consistency.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
DB_URL=${DB_URL:-postgresql://test:test@127.0.0.1:54329/perf_gate_head}
REDIS_URL_LAB=${REDIS_URL_LAB:-redis://127.0.0.1:63799}
SECRET=perf-gate-secret
[[ $DB_URL =~ @(127\.0\.0\.1|localhost): ]] || { echo "로컬 DB만 허용" >&2; exit 2; }

TOKEN=$(JWT_SECRET=$SECRET node -e 'console.log(require("jsonwebtoken").sign({ userId: "u00000001" }, process.env.JWT_SECRET, { expiresIn: "10m" }))')
BODY='{"caption":"캐시 일관성 확인 카페","text":"","tags":[],"authorName":"실험","authorEmoji":"🐶","petTypeName":"유형","stops":[{"placeId":"place-1","name":"장소","category":"산책","district":"서구","condition":"전 견종","petFriendly":true}]}'
# Windows curl은 인자의 한글을 시스템 코드페이지로 바꿔 보낸다 — 본문은 UTF-8 파일로 보낸다
BODY_FILE=$(mktemp); printf '%s' "$BODY" > "$BODY_FILE"
PIDS=()
trap 'for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done' EXIT

start() { # 포트 [REDIS_URL]
  (exec env ${2:+REDIS_URL=$2} PORT=$1 DATABASE_URL="$DB_URL?pgbouncer=true" DIRECT_URL="$DB_URL" JWT_SECRET=$SECRET NODE_ENV=production \
    node dist/index.js >/dev/null 2>&1) &
  PIDS+=($!)
  until curl -sf "http://127.0.0.1:$1/api/health" >/dev/null; do sleep 0.3; done
}
total() { curl -s "http://127.0.0.1:$1/api/posts?limit=1&q=%EC%B9%B4%ED%8E%98" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).total))'; }
stop_all() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; PIDS=(); sleep 1; }

run() { # 이름 [REDIS_URL]
  echo "== $1"
  start 4201 "${2:-}"; start 4202 "${2:-}"
  local before; before=$(total 4202)          # B가 '카페' 건수를 캐시에 채움
  local id; id=$(curl -s -X POST "http://127.0.0.1:4201/api/posts" -H "Content-Type: application/json" \
    -H "Cookie: daejourneyu_token=$TOKEN" --data-binary "@$BODY_FILE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')
  echo "   B 건수: 글쓰기 전 $before → A에서 글쓰기 직후 $(total 4202) (A가 보는 값 $(total 4201))"
  curl -s -o /dev/null -X DELETE "http://127.0.0.1:4201/api/posts/$id" -H "Cookie: daejourneyu_token=$TOKEN"
  stop_all
}

[[ -d dist ]] || npm run build --silent
run "메모리 캐시(인스턴스마다 따로)"
run "Redis(공유 + 세대 무효화)" "$REDIS_URL_LAB"
