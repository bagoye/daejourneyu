#!/usr/bin/env bash
# PgBouncer(트랜잭션 모드) 실습 — 이 프로젝트의 운영 설정(?pgbouncer=true, DIRECT_URL)이 왜 필요한지 재현한다.
# 로컬 실습실(ops-lab/pgbouncer) 전용.
#
#   docker compose -f ops-lab/pgbouncer/docker-compose.yml up -d --build --wait
#   bash ops-lab/scripts/pgbouncer-drill.sh
#
# 실험 1 — 마이그레이션을 풀러로: Prisma Migrate의 advisory lock이 풀러의 서버 연결에 남아 다음 배포를 막는가
# 실험 2 — ?pgbouncer=true 없이 트랜잭션 모드: prepared statement 오류
# 실험 3 — 연결 다중화: 클라이언트 연결이 max_connections를 넘을 때 직접 vs 풀러
# 실험 4 — 세션 상태 누수: 트랜잭션 밖의 SET이 다른 클라이언트에게 새는가
# 실험 5 — 앱 정합성: 통합 테스트 31개를 풀러 뒤에서(마이그레이션만 직접)
set -euo pipefail
export MSYS_NO_PATHCONV=1
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
if command -v cygpath >/dev/null 2>&1; then ROOT=$(cygpath -m "$ROOT"); fi
DB=djy-pgb-db
DIRECT="postgresql://postgres:lab@127.0.0.1:54333/daejourneyu"
POOLER="postgresql://postgres:lab@127.0.0.1:6432/daejourneyu"
EXPS=${EXPS:-"1 2 3 4 5"}

dbsql() { docker exec -i -u postgres "$DB" psql -d daejourneyu -Atq "$@"; }
bouncer() { docker exec -i -e PGPASSWORD=lab djy-pgb-bouncer psql -h 127.0.0.1 -p 6432 -U postgres -Atq "$@"; }
migrate() { (cd "$ROOT/backend" && DATABASE_URL="$1" DIRECT_URL="$1" timeout 90 npx prisma migrate deploy 2>&1 | grep -E "No pending|successfully applied|Error|P1002" | head -2); }
bench() { # url pool conc → 요약 한 줄 + DB 서버 연결 최대치
  (cd "$ROOT/backend" && PERF_DATABASE_URL="$1" POOL=$2 CONCURRENCY=$3 DURATION_MS=${4:-8000} npx tsx scripts/ops/poolBench.ts > /tmp/pgb-bench.txt 2>&1) &
  local pid=$! peak=0 n
  while kill -0 $pid 2>/dev/null; do
    n=$(dbsql -c "SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()" 2>/dev/null || echo 0)
    (( ${n:-0} > peak )) && peak=$n
    sleep 0.5
  done
  wait $pid || true
  echo "   $(grep -E '^pool=' /tmp/pgb-bench.txt | sed -E 's/"(5[0-9]{2}):[^"]*"/"\1"/g') · DB 서버 연결 최대 ${peak}개"
  grep -oE "too many clients already|remaining connection slots are reserved[^\"]*|prepared statement \\\\\"s[0-9]+\\\\\" (does not exist|already exists)|Timed out fetching a new connection" /tmp/pgb-bench.txt \
    | sed -E 's/s[0-9]+/sN/' | sort | uniq -c | sed 's/^/      오류: /' || true
}
has() { [[ " $EXPS " == *" $1 "* ]]; }

if has 1; then
  echo "######## 실험 1 — 마이그레이션을 트랜잭션 모드 풀러로 돌리면"
  # 빈 DB에서 시작(마이그레이션을 처음부터 적용하게)
  docker exec -u postgres "$DB" psql -d postgres -qc "DROP DATABASE IF EXISTS daejourneyu WITH (FORCE)" -c "CREATE DATABASE daejourneyu"
  bouncer -d pgbouncer -c "RECONNECT daejourneyu" >/dev/null 2>&1 || true
  echo "   풀러 경유 migrate deploy: $(migrate "$POOLER")"
  echo "   남은 advisory lock: $(dbsql -c "SELECT coalesce(string_agg(objid || '(pid ' || pid || ', ' || (SELECT state FROM pg_stat_activity a WHERE a.pid = l.pid) || ')', ', '), '없음') FROM pg_locks l WHERE locktype = 'advisory'")"
  s=$(date +%s)
  echo "   다음 배포(직접 연결) migrate deploy: $(migrate "$DIRECT") ($(( $(date +%s) - s ))초)"
  echo "   복구: 잠금을 쥔 서버 연결 종료 → $(dbsql -c "SELECT count(pg_terminate_backend(pid)) FROM pg_locks WHERE locktype = 'advisory'")개"
  echo "   재시도(직접 연결): $(migrate "$DIRECT") · 남은 advisory lock $(dbsql -c "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory'")개"
  docker exec -i -u postgres "$DB" psql -d daejourneyu -v scale=0.2 -q < "$ROOT/backend/scripts/perf/seed-large.sql" >/dev/null 2>&1
  echo "   (실습 데이터 재적재 완료)"
fi

if has 2; then
  echo "######## 실험 2 — ?pgbouncer=true 없이 트랜잭션 모드(풀 10, 동시 32)"
  echo "   [pgbouncer=true 없음]"; bench "$POOLER" 10 32
  echo "   [pgbouncer=true]";      bench "$POOLER?pgbouncer=true" 10 32
  echo "   [직접 연결 — 기준]";    bench "$DIRECT" 10 32
fi

if has 3; then
  echo "######## 실험 3 — 연결 다중화: 앱 풀 150 · 동시 200, DB max_connections=$(dbsql -c 'SHOW max_connections')"
  echo "   [직접 연결]";                  bench "$DIRECT" 150 200 10000
  echo "   [PgBouncer, pool_size 20]";   bench "$POOLER?pgbouncer=true" 150 200 10000
  echo "   PgBouncer 풀 상태: $(bouncer -d pgbouncer -F ' ' -c 'SHOW POOLS' | awk '$1=="daejourneyu" {print "cl_active=" $3 " cl_waiting=" $4 " sv_active=" $6 " sv_idle=" $7}')"
fi

if has 4; then
  echo "######## 실험 4 — 세션 상태 누수: 트랜잭션 밖 SET이 다른 클라이언트에게 새는가"
  bouncer -d pgbouncer -c "RECONNECT daejourneyu" >/dev/null 2>&1 || true
  sleep 1
  # 클라이언트 A: 트랜잭션 밖에서 SET 후 연결 종료. 트랜잭션 모드에서는 서버 연결이 그대로 풀로 돌아간다.
  bouncer -d daejourneyu -c "SET statement_timeout = '50ms'" -c "SELECT 'A: ' || current_setting('statement_timeout') || ' (서버 pid ' || pg_backend_pid() || ')'"
  # 클라이언트 B: 다른 연결. 아무 설정도 안 했는데 A의 설정을 물려받는가
  for i in 1 2 3; do
    bouncer -d daejourneyu -c "SELECT 'B$i: statement_timeout=' || current_setting('statement_timeout') || ' (서버 pid ' || pg_backend_pid() || ')'" 2>&1
    bouncer -d daejourneyu -c "SELECT pg_sleep(0.2)" >/dev/null 2>&1 && echo "   B$i: 0.2초 쿼리 성공" || echo "   B$i: 0.2초 쿼리가 A의 statement_timeout(50ms)으로 취소됨"
  done
  echo "   [대조] 세션 모드(daejourneyu_session):"
  bouncer -d daejourneyu_session -c "SET statement_timeout = '50ms'" -c "SELECT 1" >/dev/null
  bouncer -d daejourneyu_session -c "SELECT '   B(세션 모드): statement_timeout=' || current_setting('statement_timeout')"
  bouncer -d pgbouncer -c "RECONNECT daejourneyu" >/dev/null 2>&1 || true
fi

if has 5; then
  echo "######## 실험 5 — 통합 테스트 31개를 PgBouncer 트랜잭션 모드 뒤에서(마이그레이션만 직접)"
  docker exec -u postgres "$DB" psql -d postgres -qc "DROP DATABASE IF EXISTS daejourneyu_it WITH (FORCE)" -c "CREATE DATABASE daejourneyu_it"
  (cd "$ROOT/backend" \
    && TEST_DATABASE_URL="postgresql://postgres:lab@127.0.0.1:6432/daejourneyu_it?pgbouncer=true" \
       TEST_DIRECT_URL="postgresql://postgres:lab@127.0.0.1:54333/daejourneyu_it" \
       npx vitest run --config vitest.integration.config.mts 2>&1 | grep -E "Test Files|Tests |FAIL|×" | sed 's/\x1b\[[0-9;]*m//g; s/^/   /')
fi
