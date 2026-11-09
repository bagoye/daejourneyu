#!/usr/bin/env bash
# 베이스 백업 + 보관 정책. 로컬 실습실(ops-lab) 전용.
#
#   KEEP=2 bash ops-lab/scripts/base-backup.sh
#
# - /backups/base-<시각>에 pg_basebackup을 받고 /backups/LATEST에 이름을 적는다.
# - 최근 KEEP개만 남기고 오래된 베이스 백업을 지운다.
# - 남은 것 중 가장 오래된 백업의 시작 WAL보다 앞선 WAL을 pg_archivecleanup으로 지운다.
#   → 복구 가능 구간 = "가장 오래된 보관 백업의 시작 시점 ~ 마지막으로 보관된 WAL".
#
# 정리하지 않으면 WAL 보관소가 끝없이 자란다(훈련 5회에 5.6GB). 보관소 디스크가 차면 archive_command가 실패하고,
# 실패한 WAL은 pg_wal에 쌓여 결국 DB 디스크까지 가득 찬다 — 백업 장치가 서비스 장애의 원인이 된다.
set -euo pipefail
export MSYS_NO_PATHCONV=1
C=${C:-djy-lab-db}
KEEP=${KEEP:-2}

ts=$(date +%Y%m%d-%H%M%S)
s=$(date +%s%3N)
docker exec -u postgres "$C" pg_basebackup -d "dbname=daejourneyu" -D "/backups/base-$ts" -Fp -X stream -c fast -l "base-$ts"
e=$(date +%s%3N)
docker exec -u postgres "$C" sh -c "echo base-$ts > /backups/LATEST"
echo "   베이스 백업 base-$ts: $((e - s)) ms · $(docker exec "$C" du -sh "/backups/base-$ts" | cut -f1)"

docker exec -i -u postgres -e KEEP="$KEEP" "$C" sh -s <<'SH'
set -e
cd /backups
# 오래된 베이스 백업 정리(이름이 시각 순이라 정렬하면 오래된 것이 앞)
ls -d base-* | sort | head -n -"$KEEP" | while read -r old; do rm -rf "$old"; echo "   오래된 베이스 백업 삭제: $old"; done
oldest=$(ls -d base-* | sort | head -n 1)
# backup_label의 "START WAL LOCATION: ... (file 000000...)"에서 시작 WAL 파일명
start_wal=$(sed -n 's/^START WAL LOCATION: .*(file \([0-9A-F]*\)).*/\1/p' "$oldest/backup_label")
before=$(du -sh /wal-archive | cut -f1); n_before=$(ls /wal-archive | wc -l)
pg_archivecleanup /wal-archive "$start_wal"
echo "   WAL 정리: 기준 $oldest 의 시작 WAL $start_wal 이전 삭제 · $before($n_before개) → $(du -sh /wal-archive | cut -f1)($(ls /wal-archive | wc -l)개)"
SH
