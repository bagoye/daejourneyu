#!/usr/bin/env bash
# 장애 주입 → 알림 감지 시간 측정. 로컬 실습실(ops-lab/monitoring) 전용.
#
#   docker compose -f ops-lab/monitoring/docker-compose.yml up -d --wait
#   bash ops-lab/scripts/monitoring-drill.sh
#
# 각 장애마다: 주입 → 알림 pending(조건 충족)·firing(발송)까지 걸린 시간 → Alertmanager 도착 확인 → 복구 → 해제 확인.
# 수집 5초·평가 5초·for 10초(실습값)라 감지 시간의 바닥은 약 10~20초다.
set -euo pipefail
export MSYS_NO_PATHCONV=1
P=djy-mon-primary
S=djy-mon-standby
PROM=http://127.0.0.1:9090
AM=http://127.0.0.1:9093
ONLY=${ONLY:-"conn deadlock archive lag longtx down"}
RESULTS=$(mktemp)

psql_p() { docker exec -i -u postgres "$P" psql -d daejourneyu -Atq "$@"; }
psql_s() { docker exec -i -u postgres "$S" psql -d daejourneyu -Atq "$@"; }
now() { date +%s; }
alert_state() { # 알림 이름 → inactive | pending | firing
  curl -s "$PROM/api/v1/alerts" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const a = JSON.parse(s).data.alerts.filter((x) => x.labels.alertname === process.argv[1]);
      console.log(a.some((x) => x.state === "firing") ? "firing" : a.some((x) => x.state === "pending") ? "pending" : "inactive");
    });' "$1"
}
in_alertmanager() {
  curl -s "$AM/api/v2/alerts" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      console.log(JSON.parse(s).some((x) => x.labels.alertname === process.argv[1]) ? "도착" : "없음");
    });' "$1"
}
watch_alert() { # 이름 시작시각 제한초 → "pending초 firing초"
  local name=$1 t0=$2 limit=$3 pend=- fire=- st
  while (( $(now) - t0 < limit )); do
    st=$(alert_state "$name")
    [[ $st != inactive && $pend == - ]] && pend=$(( $(now) - t0 ))
    if [[ $st == firing ]]; then fire=$(( $(now) - t0 )); break; fi
    sleep 1
  done
  echo "$pend $fire"
}
wait_resolved() { # 이름 시작시각 제한초 → 해제까지 초
  local name=$1 t0=$2 limit=$3
  while (( $(now) - t0 < limit )); do
    [[ $(alert_state "$name") == inactive ]] && { echo $(( $(now) - t0 )); return; }
    sleep 1
  done
  echo "-"
}
record() { # 장애 알림 pending firing AM 해제
  printf '%s|%s|%s|%s|%s|%s\n' "$@" >> "$RESULTS"
  echo "   → $2: pending ${3}s · firing ${4}s · Alertmanager $5 · 복구 후 해제 ${6}s"
}
has() { [[ " $ONLY " == *" $1 "* ]]; }

if has conn; then
  echo "== 1) 연결 폭주: 85개 세션이 연결을 붙잡음 (max_connections=100, 기준 80%)"
  docker exec -d -u postgres "$P" bash -c 'for i in $(seq 1 85); do psql -d daejourneyu -qc "SELECT pg_sleep(120)" & done; wait'
  t0=$(now); read -r pend fire < <(watch_alert ConnectionsNearLimit "$t0" 90)
  am=$(in_alertmanager ConnectionsNearLimit)
  psql_p -c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE query = 'SELECT pg_sleep(120)'" >/dev/null
  t1=$(now); res=$(wait_resolved ConnectionsNearLimit "$t1" 90)
  record "연결 폭주" ConnectionsNearLimit "$pend" "$fire" "$am" "$res"
fi

if has deadlock; then
  echo "== 2) 교착: 두 트랜잭션이 서로 반대 순서로 같은 행을 잠금"
  t0=$(now)
  docker exec -d -u postgres "$P" psql -d daejourneyu -qc "BEGIN; UPDATE incident_probe SET v = v + 1 WHERE id = 1; SELECT pg_sleep(1); UPDATE incident_probe SET v = v + 1 WHERE id = 2; COMMIT;"
  docker exec -d -u postgres "$P" psql -d daejourneyu -qc "BEGIN; UPDATE incident_probe SET v = v + 1 WHERE id = 2; SELECT pg_sleep(1); UPDATE incident_probe SET v = v + 1 WHERE id = 1; COMMIT;"
  read -r pend fire < <(watch_alert DeadlockDetected "$t0" 60)
  am=$(in_alertmanager DeadlockDetected)
  echo "   서버 로그: $(docker logs "$P" 2>&1 | grep -c 'deadlock detected')건 'deadlock detected'"
  t1=$(now); res=$(wait_resolved DeadlockDetected "$t1" 120)   # increase(...[1m]) 창이 지나야 해제
  record "교착" DeadlockDetected "$pend" "$fire" "$am" "$res"
fi

if has archive; then
  echo "== 3) WAL 보관 실패: 보관소 디렉터리 쓰기 권한을 없앰(보관소 디스크·권한 장애와 같음)"
  # 처음엔 ALTER SYSTEM으로 archive_command를 /bin/false로 바꿨지만, 이 설정이 명령줄(-c)로 지정돼 있어
  # (pg_settings.source = 'command line') ALTER SYSTEM이 무시되고 장애가 주입되지 않았다. 실제 장애처럼 cp를 실패시킨다.
  docker exec -u root "$P" chmod 000 /wal-archive
  t0=$(now)
  psql_p -c "INSERT INTO incident_probe SELECT g, 0 FROM generate_series(1000, 1100) g ON CONFLICT DO NOTHING" -c "SELECT pg_switch_wal()" >/dev/null
  read -r pend fire < <(watch_alert WalArchiveFailing "$t0" 90)
  am=$(in_alertmanager WalArchiveFailing)
  echo "   보관 대기 중인 WAL(pg_wal/archive_status/*.ready): $(docker exec -u postgres "$P" sh -c 'ls /var/lib/postgresql/data/pg_wal/archive_status/ | grep -c ready')개"
  docker exec -u root "$P" chmod 700 /wal-archive
  # 실패한 세그먼트는 PostgreSQL이 자동으로 재시도한다 — 밀린 것이 보관될 때까지 잠시 기다린다
  sleep 8
  echo "   복구 후 보관 상태: $(psql_p -c "SELECT 'archived=' || archived_count || ' failed=' || failed_count || ' last=' || last_archived_wal FROM pg_stat_archiver")"
  t1=$(now); res=$(wait_resolved WalArchiveFailing "$t1" 120)
  record "WAL 보관 실패" WalArchiveFailing "$pend" "$fire" "$am" "$res"
fi

if has lag; then
  echo "== 4) 복제 지연: standby WAL 재생 일시정지 + primary 대량 쓰기"
  psql_s -c "SELECT pg_wal_replay_pause()" >/dev/null
  psql_p -c "CREATE TABLE IF NOT EXISTS lag_fill (id int, pad text)" >/dev/null
  t0=$(now)
  psql_p -c "INSERT INTO lag_fill SELECT g, repeat('x', 1000) FROM generate_series(1, 30000) g" >/dev/null
  echo "   primary 쪽 지연: $(psql_p -c "SELECT pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)) FROM pg_stat_replication")"
  read -r pend fire < <(watch_alert ReplicationLagHigh "$t0" 90)
  am=$(in_alertmanager ReplicationLagHigh)
  r0=$(date +%s%3N)
  psql_s -c "SELECT pg_wal_replay_resume()" >/dev/null
  until [[ $(psql_p -c "SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) < 1048576 FROM pg_stat_replication") == t ]]; do sleep 0.2; done
  echo "   재생 재개 후 따라잡기: $(( $(date +%s%3N) - r0 )) ms"
  psql_p -c "DROP TABLE lag_fill" >/dev/null
  t1=$(now); res=$(wait_resolved ReplicationLagHigh "$t1" 90)
  record "복제 지연" ReplicationLagHigh "$pend" "$fire" "$am" "$res"
fi

if has longtx; then
  echo "== 5) 긴 트랜잭션: 트랜잭션을 열어 둔 채 방치(기준 30초)"
  docker exec -d -u postgres "$P" psql -d daejourneyu -qc "BEGIN; SELECT txid_current(); SELECT pg_sleep(120); COMMIT;"
  t0=$(now); read -r pend fire < <(watch_alert LongRunningTransaction "$t0" 120)
  am=$(in_alertmanager LongRunningTransaction)
  psql_p -c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE query LIKE 'BEGIN; SELECT txid_current()%'" >/dev/null
  t1=$(now); res=$(wait_resolved LongRunningTransaction "$t1" 90)
  record "긴 트랜잭션" LongRunningTransaction "$pend" "$fire" "$am" "$res"
fi

if has down; then
  echo "== 6) primary 다운"
  t0=$(now)
  docker stop "$P" >/dev/null
  read -r pend fire < <(watch_alert PostgresDown "$t0" 90)
  am=$(in_alertmanager PostgresDown)
  docker start "$P" >/dev/null
  until docker exec -u postgres "$P" pg_isready -d daejourneyu >/dev/null 2>&1; do sleep 0.5; done
  t1=$(now); res=$(wait_resolved PostgresDown "$t1" 90)
  echo "   standby 재연결: $(psql_p -c "SELECT coalesce(string_agg(application_name || ' ' || state, ', '), '없음') FROM pg_stat_replication")"
  record "primary 다운" PostgresDown "$pend" "$fire" "$am" "$res"
fi

echo
echo "장애|알림|pending(초)|firing(초)|Alertmanager|복구 후 해제(초)"
cat "$RESULTS"
rm -f "$RESULTS"
