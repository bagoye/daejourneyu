#!/usr/bin/env bash
# 성능 회귀 게이트 — base(비교 기준)와 head(변경본) 백엔드를 **같은 머신에서 번갈아** 부하 측정해 p95를 비교한다.
# 로컬과 CI(.github/workflows/perf.yml)가 이 스크립트 하나를 같이 쓴다. **로컬·CI의 일회용 DB 전용.**
#
#   # head 단독(절대 SLO만 검사)
#   bash scripts/load/perf-gate.sh
#   # base와 비교(예: main을 별도 작업 트리로 꺼내 둔 경우)
#   BASE_DIR=/path/to/base/backend bash scripts/load/perf-gate.sh
#
# 왜 "같은 머신·번갈아"인가: 공용 CI 러너는 실행마다 성능이 다르다. 어제 저장한 기준값과 비교하면 러너 차이가
# 회귀처럼 보인다. 같은 러너에서 base·head를 B H H B B H … 순서로 번갈아 돌리고 라운드별 중앙값을 비교하면
# 러너 편차와 순서 효과(먼저 돈 쪽이 캐시를 데워 주는 등)가 양쪽에 고르게 들어간다.
#
# 환경변수: ROUNDS(3) SCALE(0.1) WARMUP(10) DURATION(30) RATE_MULT(1) REL(0.25) ABS_MS(5) KEEP=1(DB·로그 보존)
#           PG_URL(postgresql://test:test@127.0.0.1:54329) PG_CONTAINER(psql이 없을 때 docker exec 대상)
#           DB_PARAMS(앱 접속 URL 쿼리, 기본 pgbouncer=true — 운영(트랜잭션 풀러)과 같은 statement 방식)
#           BASE_DB_PARAMS·HEAD_DB_PARAMS(쪽별 덮어쓰기) · BASE_DB_SQL·HEAD_DB_SQL(시드 후 그 DB에 실행할 설정 SQL)
#           BASE_APP_ENV·HEAD_APP_ENV(서버에 줄 추가 환경변수, 예: "REDIS_URL=redis://127.0.0.1:63799")
#           → 같은 코드에서 접속 설정만 바꾼 A/B 실험에 쓴다(docs/db-optimization/10 §5)
set -euo pipefail
export MSYS_NO_PATHCONV=1

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
HEAD_DIR=${HEAD_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}
BASE_DIR=${BASE_DIR:-}
PG_URL=${PG_URL:-postgresql://test:test@127.0.0.1:54329}
PG_CONTAINER=${PG_CONTAINER:-daejourneyu-test-pg}
ROUNDS=${ROUNDS:-3}
SCALE=${SCALE:-0.1}
OUT_DIR=${OUT_DIR:-$HEAD_DIR/perf-out}
JWT_SECRET=perf-gate-secret   # 일회용 서버끼리만 쓰는 값(운영 시크릿 아님)
K6_IMAGE=grafana/k6:0.54.0
DB_PARAMS=${DB_PARAMS-pgbouncer=true}
export WARMUP=${WARMUP:-10} DURATION=${DURATION:-30} RATE_MULT=${RATE_MULT:-1}

# 안전장치: 이 스크립트는 DB를 DROP/CREATE한다 — 로컬 호스트가 아니면 시작하지 않는다.
if [[ ! $PG_URL =~ ^postgresql://[^@]+@(127\.0\.0\.1|localhost)(:[0-9]+)?$ ]]; then
  echo "PG_URL은 로컬 호스트만 허용한다(DB를 DROP한다): $PG_URL" >&2; exit 2
fi

abspath() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
mkdir -p "$OUT_DIR"; rm -f "$OUT_DIR"/*.json "$OUT_DIR"/*.log
OUT_DIR=$(cd "$OUT_DIR" && pwd)

# psql: 러너(ubuntu)에는 클라이언트가 있고, Windows 개발 PC에는 없어서 테스트 컨테이너 안의 psql을 쓴다.
psql_db() { # DB이름 [psql 인자...] (stdin 가능)
  local db=$1; shift
  if command -v psql >/dev/null; then psql "$PG_URL/$db" -v ON_ERROR_STOP=1 -Atq "$@"
  else docker exec -i "$PG_CONTAINER" psql -U "$(sed -E 's#postgresql://([^:]+):.*#\1#' <<<"$PG_URL")" -d "$db" -v ON_ERROR_STOP=1 -Atq "$@"; fi
}
k6_run() { # 대상URL 결과파일
  local url=$1 out=$2
  if command -v k6 >/dev/null; then
    k6 run -q -e BASE_URL="$url" -e JWT_SECRET="$JWT_SECRET" -e SCALE="$SCALE" -e OUT="$out" \
      -e WARMUP="$WARMUP" -e DURATION="$DURATION" -e RATE_MULT="$RATE_MULT" "$SCRIPT_DIR/api.k6.js"
  else # 컨테이너에서 호스트의 서버로 붙는다
    docker run --rm -i -v "$(abspath "$SCRIPT_DIR"):/scripts:ro" -v "$(abspath "$OUT_DIR"):/out" \
      "$K6_IMAGE" run -q -e BASE_URL="${url/127.0.0.1/host.docker.internal}" -e JWT_SECRET="$JWT_SECRET" -e SCALE="$SCALE" \
      -e OUT="/out/$(basename "$out")" -e WARMUP="$WARMUP" -e DURATION="$DURATION" -e RATE_MULT="$RATE_MULT" /scripts/api.k6.js
  fi
}

PIDS=()
BUILT=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [[ -n $p ]] && kill "$p" 2>/dev/null || true; done
  if [[ ${KEEP:-0} != 1 ]]; then
    for s in base head; do psql_db postgres -c "DROP DATABASE IF EXISTS perf_gate_$s WITH (FORCE)" >/dev/null 2>&1 || true; done
  fi
}
trap cleanup EXIT

prepare() { # 이름 백엔드디렉터리 포트
  local side=$1 dir=$2 port=$3 db=perf_gate_$1
  local url="$PG_URL/$db"
  echo "== [$side] DB 준비($db, scale=$SCALE) ← $dir"
  psql_db postgres -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" -c "CREATE DATABASE $db" >/dev/null 2>&1
  # 각 쪽은 **자기 커밋의** 마이그레이션·시드로 만든다(base에 없는 인덱스는 base에 없어야 비교가 된다)
  (cd "$dir" && DATABASE_URL=$url DIRECT_URL=$url npx prisma migrate deploy >/dev/null 2>&1)
  local t0=$SECONDS
  psql_db "$db" -v scale="$SCALE" < "$dir/scripts/perf/seed-large.sql" >/dev/null
  psql_db "$db" -c "VACUUM ANALYZE" >/dev/null
  echo "   시드 $((SECONDS - t0))초 · 게시물 $(psql_db "$db" -c 'SELECT count(*) FROM "Post"')건"
  local pvar=${side^^}_DB_PARAMS svar=${side^^}_DB_SQL
  local evar=${side^^}_APP_ENV
  local params=${!pvar-$DB_PARAMS} extra_sql=${!svar:-} app_env=${!evar:-}
  [[ -n $app_env ]] && echo "   앱 환경: $app_env"
  [[ -n $extra_sql ]] && { psql_db "$db" -c "$extra_sql" >/dev/null; echo "   DB 설정: $extra_sql"; }
  local app_url=$url${params:+?$params}
  echo "   앱 접속: $db${params:+?$params}"
  # 같은 디렉터리는 한 번만 빌드한다(A/A 실험). Windows에서는 떠 있는 서버가 Prisma 엔진 파일을 잠가 두 번째 generate가 실패한다.
  if [[ " ${BUILT[*]:-} " != *" $dir "* ]]; then
    (cd "$dir" && npx prisma generate > "$OUT_DIR/build-$side.log" 2>&1 && npm run build --silent >> "$OUT_DIR/build-$side.log" 2>&1) \
      || { echo "[$side] 빌드 실패:" >&2; tail -20 "$OUT_DIR/build-$side.log" >&2; exit 1; }
    BUILT+=("$dir")
  fi
  # shellcheck disable=SC2086  # app_env는 KEY=VAL 목록이라 단어 분리가 의도다
  (cd "$dir" && exec env $app_env PORT=$port DATABASE_URL=$app_url DIRECT_URL=$url JWT_SECRET=$JWT_SECRET SLOW_QUERY_MS=0 NODE_ENV=production \
    node dist/index.js > "$OUT_DIR/server-$side.log" 2>&1) &
  PIDS+=($!)
  for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$port/api/health" >/dev/null && return; sleep 0.5; done
  echo "[$side] 서버가 뜨지 않았다:" >&2; cat "$OUT_DIR/server-$side.log" >&2; exit 1
}

SIDES=(head)
prepare head "$HEAD_DIR" 4102
if [[ -n $BASE_DIR ]]; then
  if [[ ! -f $BASE_DIR/scripts/perf/seed-large.sql ]]; then
    echo "base에 부하 측정 도구(seed-large.sql)가 없어 비교를 건너뛴다 — head 절대 SLO만 검사한다."
  else
    prepare base "$BASE_DIR" 4101
    SIDES=(base head)
  fi
fi

port_of() { [[ $1 == base ]] && echo 4101 || echo 4102; }
for r in $(seq 1 "$ROUNDS"); do
  # 순서를 라운드마다 뒤집는다: B H / H B / B H …
  if (( r % 2 == 1 )); then order=("${SIDES[@]}"); else order=(); for ((i=${#SIDES[@]}-1; i>=0; i--)); do order+=("${SIDES[i]}"); done; fi
  for s in "${order[@]}"; do
    echo "== 라운드 $r/$ROUNDS · $s"
    k6_run "http://127.0.0.1:$(port_of "$s")" "$OUT_DIR/$s-$r.json" || true   # 판정은 compare가 한다
  done
done

node "$(abspath "$SCRIPT_DIR/compare.mjs")" "$(abspath "$OUT_DIR")"
