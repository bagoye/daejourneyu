#!/usr/bin/env bash
# PITR(시점 복구) 훈련 — 베이스 백업 + WAL 재생으로 "사고 직전 시점"까지 되돌리고, 결과를 정합성 스냅샷과 비교한다.
# 로컬 실습실(ops-lab/docker-compose.yml) 전용.
#
#   docker compose -f ops-lab/docker-compose.yml up -d --wait   # 마이그레이션·시드는 문서 04/06 참고
#   bash ops-lab/scripts/pitr-drill.sh
#
# 시나리오
#   1) 베이스 백업(pg_basebackup)
#   2) 백업 "이후" 정상 쓰기(새 글·담기) — WAL 재생으로 살아나야 한다
#   3) 정상 시점 T 기록 + 정합성 스냅샷
#   4) 사고: WHERE 없는 UPDATE(모든 글 제목 덮어씀) + 사용자 1명 삭제(CASCADE)
#   5) 사고 "이후" 정상 쓰기 — 시점 복구의 대가로 사라진다(RPO)
#   6) 베이스 백업 복원 → recovery_target_time = T 까지 WAL 재생 → promote
#   7) 복구 결과 = 3의 스냅샷인지 diff, 복구 시간(RTO) 측정
set -euo pipefail
export MSYS_NO_PATHCONV=1
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$SCRIPT_DIR/.."
COMPOSE=(docker compose -f docker-compose.yml)
C=djy-lab-db
VERIFY=../backend/scripts/ops/verify-integrity.sql
OUT=${OUT_DIR:-./drill-output}
# 백업 이후 추가로 만들 쓰기량(라운드마다 글 전체의 likes를 1 올림) — 복구 시간이 WAL 양에 어떻게 비례하는지 측정용
WAL_ROUNDS=${WAL_ROUNDS:-0}
# 복구 목표: time(recovery_target_time — 서버 시계에 의존) | xid(pg_waldump로 찾은 사고 트랜잭션 직전 — 시계와 무관)
# 이 실습 환경(Docker Desktop VM)은 시계가 약 27초마다 3.7초씩 뒤로 가서 time 방식이 실제로 한 번 실패했다.
TARGET=${TARGET:-xid}
# 같은 DB에서 여러 번 돌릴 수 있게 실행마다 고유한 id를 쓴다
RUN=$(date +%s)
mkdir -p "$OUT"

ms() { date +%s%3N; }
sql() { docker exec -i -u postgres "$C" psql -d daejourneyu -v ON_ERROR_STOP=1 -Atq "$@"; }
verify() { docker exec -i -u postgres "$C" psql -d daejourneyu -At -F '|' < "$VERIFY" 2>&1; }
wait_ready() {
  for _ in $(seq 1 120); do
    if docker exec -u postgres "$C" pg_isready -d daejourneyu >/dev/null 2>&1 \
       && [[ $(sql -c "SELECT pg_is_in_recovery()" 2>/dev/null) == f ]]; then return 0; fi
    sleep 0.5
  done
  echo "DB가 준비되지 않았다" >&2; return 1
}
wait_archived() { # 현재 세그먼트를 닫고 보관소에 들어갈 때까지 기다린다
  local seg; seg=$(sql -c "SELECT pg_walfile_name(pg_switch_wal())")
  for _ in $(seq 1 60); do
    [[ $(sql -c "SELECT coalesce(last_archived_wal, '') >= '$seg' FROM pg_stat_archiver") == t ]] && return 0
    sleep 0.5
  done
  echo "WAL $seg 가 보관되지 않았다" >&2; return 1
}

echo "== 1) 베이스 백업"
LSN0=$(sql -c "SELECT pg_current_wal_lsn()")
# 보관 정책(최근 KEEP개 + 그 이후 WAL만 보관)까지 포함한 베이스 백업 — scripts/base-backup.sh
bash "$SCRIPT_DIR/base-backup.sh"
BASE=$(docker exec "$C" cat /backups/LATEST)
echo "   DB $(sql -c "SELECT pg_size_pretty(pg_database_size('daejourneyu'))")"

echo "== 2) 백업 이후 정상 쓰기(새 글 1 + 장소 1 + 담기 1)"
sql <<SQL
INSERT INTO "Post" (id, caption, text, tags, "authorName", "authorEmoji", "petTypeName", "userId", "searchText")
VALUES ('drill-after-backup-$RUN', '백업 이후에 쓴 글', '', '{}', '사용자1', '🐶', '유형', 'u00000001', E'백업 이후에 쓴 글\n\n사용자1');
INSERT INTO "PostStop" (id, "order", "placeId", name, category, district, condition, "petFriendly", "postId")
VALUES ('drill-after-backup-$RUN-s0', 0, 'place-1', '장소 1', '산책', '서구', '전 견종', true, 'drill-after-backup-$RUN');
INSERT INTO "PostSave" (id, "userId", "postId") VALUES ('drill-save-$RUN', 'u00000003', 'drill-after-backup-$RUN');
SQL

if (( WAL_ROUNDS > 0 )); then
  s=$(ms)
  for _ in $(seq 1 "$WAL_ROUNDS"); do sql -c 'UPDATE "Post" SET likes = likes + 1'; done
  echo "   추가 쓰기 $WAL_ROUNDS 라운드(글 전체 UPDATE) $(( $(ms) - s )) ms"
fi
WAL_BYTES=$(sql -c "SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), '$LSN0')")
echo "   베이스 백업 이후 생성된 WAL: $(sql -c "SELECT pg_size_pretty($WAL_BYTES::bigint)")"

echo "== 3) 정상 시점 T 기록 + 정합성 스냅샷"
verify > "$OUT/1-good.txt"
T_GOOD=$(sql -c "SELECT clock_timestamp()")
# 사고 조사 시작 위치(앱 로그로 "대략 이때부터"를 안다고 가정). 시각이 아니라 LSN이라 시계와 무관하다.
LSN_T=$(sql -c "SELECT pg_current_wal_lsn()")
echo "   T = $T_GOOD (LSN $LSN_T)"
sleep 1

echo "== 4) 사고"
victim_rows=$(sql -c "SELECT (SELECT count(*) FROM \"Course\" WHERE \"userId\" = 'u00000002') + (SELECT count(*) FROM \"Post\" WHERE \"userId\" = 'u00000002') + (SELECT count(*) FROM \"Review\" WHERE \"authorId\" = 'u00000002')")
updated=$(sql -c "WITH u AS (UPDATE \"Post\" SET caption = '(실수로 덮어씀)' RETURNING 1) SELECT count(*) FROM u")
sql -c "DELETE FROM users WHERE id = 'u00000002'"
echo "   WHERE 없는 UPDATE: 글 ${updated}건 제목 덮어씀 · 사용자 u00000002 삭제(코스·글·후기 ${victim_rows}건 + 딸린 행 CASCADE)"

echo "== 5) 사고 이후 정상 쓰기(복구하면 사라져야 한다)"
sql -c "INSERT INTO \"Post\" (id, caption, text, tags, \"authorName\", \"authorEmoji\", \"petTypeName\", \"userId\", \"searchText\") VALUES ('drill-after-disaster-$RUN', '사고 이후에 쓴 글', '', '{}', '사용자1', '🐶', '유형', 'u00000001', '사고 이후에 쓴 글')"
wait_archived
verify > "$OUT/2-after-disaster.txt"
echo "   사고 후 스냅샷 vs 정상 스냅샷: $(diff "$OUT/1-good.txt" "$OUT/2-after-disaster.txt" | grep -c '^[<>]') 줄 다름"

if [[ $TARGET == xid ]]; then
  echo "== 5-1) 사고 조사: pg_waldump로 T(LSN) 이후 WAL에서 행을 많이 바꾼 트랜잭션 찾기"
  TLI=$(sql -c "SELECT timeline_id FROM pg_control_checkpoint()")
  REL="$(sql -c "SELECT oid FROM pg_database WHERE datname = 'daejourneyu'")/$(sql -c "SELECT pg_relation_filenode('\"Post\"')")"
  # 보관소의 WAL을 읽는다(DB 서버 시계와 무관 — 커밋 시각은 참고로만 출력)
  docker exec -u postgres "$C" pg_waldump -p /wal-archive --timeline="$TLI" --start="$LSN_T" 2>/dev/null > "$OUT/waldump.txt" || true
  awk -v rel="$REL" '
    /rmgr: Heap / { if (match($0, /tx: +[0-9]+/)) { tx = substr($0, RSTART + 4, RLENGTH - 4) + 0; heap[tx]++;
                    if (index($0, "rel 1663/" rel " ")) post[tx]++ } }
    /rmgr: Transaction .*desc: COMMIT/ { if (match($0, /tx: +[0-9]+/)) { tx = substr($0, RSTART + 4, RLENGTH - 4) + 0;
                    c = $0; sub(/.*desc: COMMIT /, "", c); sub(/;.*/, "", c); commit[tx] = c } }
    END { for (t in heap) printf "%d %d %d %s\n", heap[t], post[t] + 0, t, (t in commit ? commit[t] : "(커밋 없음)") }
  ' "$OUT/waldump.txt" | sort -k1,1nr | head -5 > "$OUT/candidates.txt"
  echo "   후보(상위 5): Heap 레코드 수 · 그중 Post 테이블 · xid · 커밋 시각(서버 시계)"
  sed 's/^/     /' "$OUT/candidates.txt"
  # Post 테이블을 가장 많이 바꾼 트랜잭션을 사고로 판단(실제 장애에서는 DBA가 이 표를 보고 고른다)
  BAD_XID=$(sort -k2,2nr "$OUT/candidates.txt" | head -1 | awk '{print $3}')
  echo "   → 사고 트랜잭션 xid $BAD_XID (Post 대량 변경). 이 트랜잭션 '직전'까지 복구한다"
fi

echo "== 6) 복구: 베이스 백업 복원 → 목표 지점까지 WAL 재생 → promote (TARGET=$TARGET)"
if [[ $TARGET == xid ]]; then TV=$BAD_XID; else TV=$T_GOOD; fi
s=$(ms)
"${COMPOSE[@]}" stop db >/dev/null
"${COMPOSE[@]}" run -T --rm --no-deps -u postgres -e TARGET="$TARGET" -e TV="$TV" -e BASE="$BASE" --entrypoint sh db -s <<'SH'
set -e
D=/var/lib/postgresql/data
find "$D" -mindepth 1 -delete
cp -a "/backups/$BASE/." "$D"/
touch "$D/recovery.signal"
{
  echo "restore_command = 'cp /wal-archive/%f %p'"
  if [ "$TARGET" = xid ]; then
    # 사고 트랜잭션의 커밋 '직전'에서 멈춘다 — 서버 시계와 무관
    echo "recovery_target_xid = '$TV'"
    echo "recovery_target_inclusive = false"
  else
    echo "recovery_target_time = '$TV'"
  fi
  echo "recovery_target_action = 'promote'"
} >> "$D/postgresql.auto.conf"
SH
"${COMPOSE[@]}" start db >/dev/null
wait_ready
e=$(ms)
RTO=$((e - s))
# 복구용 설정은 정리한다(남아 있어도 recovery.signal이 없으면 쓰이지 않지만 헷갈리지 않게)
sql -c "ALTER SYSTEM RESET restore_command" -c "ALTER SYSTEM RESET recovery_target_time" -c "ALTER SYSTEM RESET recovery_target_xid" \
    -c "ALTER SYSTEM RESET recovery_target_inclusive" -c "ALTER SYSTEM RESET recovery_target_action" -c "SELECT pg_reload_conf()" >/dev/null
echo "   복구 소요(RTO, 정지→복원→재생→promote→접속 가능) $RTO ms · 타임라인 $(sql -c "SELECT timeline_id FROM pg_control_checkpoint()")"
docker logs "$C" 2>&1 | grep -E "recovery stopping|archive recovery complete|selected new timeline" | tail -3 | sed 's/^/   [log] /'

echo "== 7) 검증"
verify > "$OUT/3-restored.txt"
if diff "$OUT/1-good.txt" "$OUT/3-restored.txt" >/dev/null; then
  echo "   정상 시점 스냅샷 vs 복구 결과: 차이 없음(완전 일치)"
else
  echo "   정상 시점 스냅샷 vs 복구 결과: 다름!"; diff "$OUT/1-good.txt" "$OUT/3-restored.txt" || true
fi
echo "   덮어쓴 제목 남아 있음: $(sql -c "SELECT count(*) FROM \"Post\" WHERE caption = '(실수로 덮어씀)'")건 (0이어야 함)"
echo "   삭제된 사용자 복구: $(sql -c "SELECT count(*) FROM users WHERE id = 'u00000002'")명 (1이어야 함)"
echo "   백업 이후·사고 이전 글: $(sql -c "SELECT count(*) FROM \"Post\" WHERE id = 'drill-after-backup-$RUN'")건 (1이어야 함 — WAL 재생으로 복구)"
echo "   사고 이후 글: $(sql -c "SELECT count(*) FROM \"Post\" WHERE id = 'drill-after-disaster-$RUN'")건 (0 — T 이후 변경은 되돌려진다)"
