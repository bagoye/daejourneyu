#!/usr/bin/env bash
# 스트리밍 복제·장애 전환 훈련. 로컬 실습실(ops-lab/replication) 전용.
#
#   bash ops-lab/scripts/replication-drill.sh            # 1부 성능·지연 + 2부 장애 전환(모드별 REPS회)
#   REPS=3 bash ops-lab/scripts/replication-drill.sh
#
# 1부 — 복제 모드별(비동기 / 동기 on / 동기 remote_apply): 쓰기 처리량·지연, 복제 지연, standby의 옛 값 읽기
# 2부 — 쓰기 도중 primary를 SIGKILL → standby 승격 → "클라이언트가 커밋 성공 응답을 받았는데 새 primary에 없는 쓰기" 집계
set -euo pipefail
export MSYS_NO_PATHCONV=1
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
# Git Bash(Windows)에서는 /d/... 경로를 Windows 프로그램(docker, node)이 못 읽는다 — 경로 변환을 끈 대신 직접 바꿔 넘긴다
if command -v cygpath >/dev/null 2>&1; then ROOT=$(cygpath -m "$ROOT"); fi
COMPOSE=(docker compose -f "$ROOT/ops-lab/replication/docker-compose.yml")
P=djy-rep-primary
S=djy-rep-standby
REPS=${REPS:-3}
OUT=${OUT_DIR:-$ROOT/ops-lab/drill-output/replication}
mkdir -p "$OUT"
# node의 require가 상대 경로를 모듈 이름으로 해석하지 않게 절대 경로로
OUT=$(cd "$OUT" && pwd)
if command -v cygpath >/dev/null 2>&1; then OUT=$(cygpath -m "$OUT"); fi

ms() { date +%s%3N; }
psql_on() { local c=$1; shift; docker exec -i -u postgres "$c" psql -d daejourneyu -v ON_ERROR_STOP=1 -Atq "$@"; }
probe() { (cd "$ROOT/backend" && NODE_PATH="$ROOT/backend/node_modules" npx tsx "$ROOT/ops-lab/scripts/replicationProbe.ts" "$@"); }

reset_cluster() {
  "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
  "${COMPOSE[@]}" up -d --wait >/dev/null 2>&1
  psql_on "$P" <<'SQL'
CREATE TABLE failover_probe (worker int, seq int, at timestamptz DEFAULT clock_timestamp(), PRIMARY KEY (worker, seq));
CREATE TABLE replica_read_check (id int PRIMARY KEY, v int);
SQL
  # standby가 테이블을 받을 때까지
  for _ in $(seq 1 50); do
    [[ $(psql_on "$S" -c "SELECT count(*) FROM pg_tables WHERE tablename = 'replica_read_check'" 2>/dev/null) == 1 ]] && return 0
    sleep 0.2
  done
}

set_mode() { # async | sync_on | sync_apply
  case $1 in
    async)      psql_on "$P" -c "ALTER SYSTEM SET synchronous_standby_names = ''" -c "ALTER SYSTEM SET synchronous_commit = 'on'" ;;
    sync_on)    psql_on "$P" -c "ALTER SYSTEM SET synchronous_standby_names = '*'" -c "ALTER SYSTEM SET synchronous_commit = 'on'" ;;
    sync_apply) psql_on "$P" -c "ALTER SYSTEM SET synchronous_standby_names = '*'" -c "ALTER SYSTEM SET synchronous_commit = 'remote_apply'" ;;
  esac
  psql_on "$P" -c "SELECT pg_reload_conf()" >/dev/null
  sleep 1
  echo "   모드 $1: $(psql_on "$P" -c "SELECT application_name || ' ' || state || ' ' || sync_state FROM pg_stat_replication")"
}

# primary의 pg_stat_replication을 0.2초마다 기록(바이트 지연, replay_lag)
sample_lag() { # $1=초 $2=파일
  docker exec -u postgres "$P" bash -c "timeout $1 psql -d daejourneyu -Atq -F ' ' <<'SQL'
SELECT pg_wal_lsn_diff(sent_lsn, replay_lsn), coalesce(extract(epoch FROM replay_lag) * 1000, 0) FROM pg_stat_replication
\watch 0.2
SQL" > "$2" 2>/dev/null || true
}

PARTS=${PARTS:-"1 2"}
FAILOVER_MODES=${FAILOVER_MODES:-"async sync_on"}

if [[ " $PARTS " == *" 1 "* ]]; then
echo "######## 1부 — 복제 모드별 쓰기 성능 · 복제 지연 · standby 옛 값 읽기"
reset_cluster
printf '%s\n' "모드|tps|p50_ms|p95_ms|p99_ms|최대지연_bytes|최대replay_lag_ms|옛값_비율|옛값_대기_최대_ms" > "$OUT/part1.txt"
for mode in async sync_on sync_apply; do
  set_mode "$mode"
  psql_on "$P" -c "TRUNCATE failover_probe" >/dev/null
  sample_lag 14 "$OUT/lag-$mode.txt" &
  lagpid=$!
  DURATION_MS=15000 probe load "$OUT/load-$mode.json" &
  loadpid=$!
  sleep 3
  STALE_N=300 probe stale "$OUT/stale-$mode.json"
  wait $loadpid
  wait $lagpid || true
  read -r maxb maxl < <(awk 'NF==2 { if ($1 > b) b = $1; if ($2 > l) l = $2 } END { printf "%d %.1f\n", b, l }' "$OUT/lag-$mode.txt")
  node -e '
    const l = require(process.argv[1]), s = require(process.argv[2]);
    console.log([process.argv[3], l.tps, l.p50, l.p95, l.p99, process.argv[4], process.argv[5], (100 * s.staleReads / s.n).toFixed(1) + "%", s.waitMax].join("|"));
  ' "$OUT/load-$mode.json" "$OUT/stale-$mode.json" "$mode" "$maxb" "$maxl" >> "$OUT/part1.txt"
done
echo; column -t -s '|' "$OUT/part1.txt" 2>/dev/null || cat "$OUT/part1.txt"
fi

if [[ " $PARTS " == *" 2 "* ]]; then
echo
echo "######## 2부 — 장애 전환: 쓰기 도중 primary SIGKILL → standby 승격 (모드별 ${REPS}회)"
printf '%s\n' "모드|회차|커밋응답|유실(응답O·새primary에X)|응답없이반영|승격까지_ms|쓰기가능까지_ms" > "$OUT/part2.txt"
for mode in $FAILOVER_MODES; do
  for rep in $(seq 1 "$REPS"); do
    reset_cluster
    set_mode "$mode" >/dev/null
    DURATION_MS=60000 STOP_AFTER_FAIL_MS=2000 probe load "$OUT/failover-$mode-$rep.json" > /dev/null &
    loadpid=$!
    sleep 5
    t0=$(ms)
    docker kill -s KILL "$P" >/dev/null                       # primary 즉사(전원 차단과 같음)
    psql_on "$S" -c "SELECT pg_promote(true, 60)" >/dev/null   # 수동 승격(자동화는 Patroni 등)
    t1=$(ms)
    until psql_on "$S" -c "INSERT INTO replica_read_check VALUES (999, 1) ON CONFLICT DO NOTHING" >/dev/null 2>&1; do sleep 0.1; done
    t2=$(ms)
    wait $loadpid || true
    # 새 primary(구 standby)에 남은 행과 클라이언트가 받은 커밋 응답 비교
    stats=$(node -e '
      const r = require(process.argv[1]);
      const rows = process.argv[2].trim().split("\n").filter(Boolean).map((l) => l.split("|").map(Number));
      const have = new Map(rows.map(([w, max, cnt]) => [w, { max, cnt }]));
      let lost = 0, extra = 0;
      r.acked.forEach((a, w) => {
        const h = have.get(w) ?? { max: 0, cnt: 0 };
        const ackedCount = a - r.startSeq[w];
        const presentUpToAcked = Math.min(h.cnt, ackedCount);
        lost += ackedCount - presentUpToAcked;
        extra += Math.max(0, h.max - a);
      });
      console.log([r.ackedTotal, lost, extra].join("|"));
    ' "$OUT/failover-$mode-$rep.json" "$(psql_on "$S" -F '|' -c "SELECT worker, max(seq), count(*) FROM failover_probe GROUP BY worker")")
    echo "$mode|$rep|$stats|$((t1 - t0))|$((t2 - t0))" >> "$OUT/part2.txt"
    echo "   $mode #$rep: $(tail -1 "$OUT/part2.txt")"
  done
done
echo; column -t -s '|' "$OUT/part2.txt" 2>/dev/null || cat "$OUT/part2.txt"
fi
reset_cluster
