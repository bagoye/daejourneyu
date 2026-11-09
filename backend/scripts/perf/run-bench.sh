#!/usr/bin/env bash
# 인덱스 구성별 쓰기·읽기 처리량 측정(pgbench). 로컬 성능 DB(daejourneyu_perf) 전용.
#   bash scripts/perf/run-bench.sh > bench-result.txt
set -euo pipefail
export MSYS_NO_PATHCONV=1
C=daejourneyu-test-pg
DB=daejourneyu_perf
DUR=${DUR:-20}
CLIENTS=${CLIENTS:-8}
psqlc() { docker exec -i "$C" psql -U test -d "$DB" -v ON_ERROR_STOP=1 -Atq "$@" 2>&1 | grep -v NOTICE || true; }

IDX_RECENT='CREATE INDEX IF NOT EXISTS exp_post_recent ON "Post" ("createdAt", id)'
IDX_COURSE='CREATE INDEX IF NOT EXISTS exp_course_user ON "Course" ("userId", "createdAt")'
IDX_SAVES='CREATE INDEX IF NOT EXISTS exp_post_saves ON "Post" (saves, "createdAt", id)'
IDX_TRGM='CREATE INDEX IF NOT EXISTS exp_post_search_trgm ON "Post" USING gin ("searchText" gin_trgm_ops)'
IDX_TAGS='CREATE INDEX IF NOT EXISTS exp_post_tags_gin ON "Post" USING gin (tags)'

drop_all() {
  psqlc -c 'DROP INDEX IF EXISTS exp_post_recent, exp_course_user, exp_post_saves, exp_post_search_trgm, exp_post_tags_gin'
}

bench() { # $1=label $2=script
  docker exec "$C" pgbench -U test -n -c "$CLIENTS" -j "$CLIENTS" -T "$DUR" -f "/bench/$2" "$DB" 2>/dev/null \
    | awk -v l="$1" -v s="$2" '/^tps/ {tps=$3} /latency average/ {lat=$4} END {printf "%-22s %-16s tps=%8.1f  latency_avg=%6.2f ms\n", l, s, tps, lat}'
}

run_config() { # $1=label, 나머지=인덱스 DDL
  local label=$1; shift
  drop_all
  for ddl in "$@"; do psqlc -c "$ddl"; done
  psqlc -c 'VACUUM ANALYZE "Post"' -c 'VACUUM ANALYZE "Course"' -c 'CHECKPOINT'
  local idx; idx=$(psqlc -c "SELECT pg_size_pretty(pg_indexes_size('\"Post\"'))")

  local before; before=$(psqlc -c "SELECT n_tup_upd || ' ' || n_tup_hot_upd FROM pg_stat_user_tables WHERE relname = 'Post'")
  bench "$label" save_toggle.sql
  sleep 2
  local after; after=$(psqlc -c "SELECT n_tup_upd || ' ' || n_tup_hot_upd FROM pg_stat_user_tables WHERE relname = 'Post'")
  read -r u0 h0 <<<"$before"; read -r u1 h1 <<<"$after"
  awk -v l="$label" -v du=$((u1-u0)) -v dh=$((h1-h0)) -v idx="$idx" \
    'BEGIN {printf "%-22s %-16s Post UPDATE=%d HOT=%d (%.1f%%)  Post 인덱스 합계=%s\n", l, "  hot", du, dh, du ? 100*dh/du : 0, idx}'

  bench "$label" post_insert.sql
  psqlc -c "DELETE FROM \"Post\" WHERE id LIKE 'bench-%'" -c 'VACUUM ANALYZE "Post"'
  bench "$label" read_mix.sql
}

echo "pgbench: clients=$CLIENTS duration=${DUR}s  ($(date -u +%FT%TZ))"
# 순서 효과(첫 실행 워밍업)를 확인할 수 있게 실행 순서를 CONFIGS로 바꿀 수 있다. 예: CONFIGS="4 3 2 1 0"
for n in ${CONFIGS:-0 1 2 3 4}; do
  case $n in
    0) run_config "0.기준(추가 인덱스 없음)" ;;
    1) run_config "1.정렬(최신)+코스" "$IDX_RECENT" "$IDX_COURSE" ;;
    2) run_config "2.+담기순(saves)" "$IDX_RECENT" "$IDX_COURSE" "$IDX_SAVES" ;;
    3) run_config "3.+검색(trgm,tags)" "$IDX_RECENT" "$IDX_COURSE" "$IDX_TRGM" "$IDX_TAGS" ;;
    4) run_config "4.전부" "$IDX_RECENT" "$IDX_COURSE" "$IDX_SAVES" "$IDX_TRGM" "$IDX_TAGS" ;;
  esac
done
drop_all
echo "saves 드리프트(0이어야 함): $(psqlc -c 'SELECT count(*) FROM (SELECT p.id FROM "Post" p LEFT JOIN "PostSave" s ON s."postId" = p.id GROUP BY p.id HAVING p.saves <> count(s.id)) d')"
