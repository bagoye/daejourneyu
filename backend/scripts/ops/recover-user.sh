#!/usr/bin/env bash
# 실수로 삭제된 사용자 1명의 데이터를 백업(복원해 둔 별도 DB)에서 골라 되살린다. **로컬 실습 전용**.
#
#   bash scripts/ops/recover-user.sh <userId> [대상DB] [백업DB]
#   예) bash scripts/ops/recover-user.sh u00000001 daejourneyu_perf daejourneyu_restore
#
# 왜 전체 복원이 아닌가: 전체 복원은 백업 이후 다른 사용자들이 만든 변경까지 되돌린다. 사고 범위가 한 사용자라면
# 그 사용자에게 딸린 행만 FK 순서대로 다시 넣는 편이 피해가 작다.
#
# 담긴 수(Post.saves) 처리: 담기 트리거가 PostSave INSERT마다 +1을 한다. 되살린 글은 백업 당시 saves 값을 들고
# 오므로 그대로 두면 담기 행을 넣을 때 두 번 세어진다 → 되살린 글의 saves를 0으로 두고 트리거가 다시 세게 한다.
# 이 사용자가 남의 글에 했던 담기는 삭제 때 트리거가 깎아 둔 상태라, 다시 넣으면 트리거가 원래대로 올린다.
set -euo pipefail
export MSYS_NO_PATHCONV=1
U=${1:?userId}
DST=${2:-daejourneyu_perf}
SRC=${3:-daejourneyu_restore}
C=daejourneyu-test-pg

# 사용자에게 딸린 행을 고르는 조건(테이블 → WHERE). FK 순서대로 넣어야 하므로 순서가 중요하다.
declare -a ORDER=(users pets Course CourseDay CourseStop CourseSchedule CourseScheduleFestival Post PostStop PostSave Review ReviewTag)
declare -A WHERE=(
  [users]="id = '$U'"
  [pets]="\"userId\" = '$U'"
  [Course]="\"userId\" = '$U'"
  [CourseDay]="\"courseId\" IN (SELECT id FROM \"Course\" WHERE \"userId\" = '$U')"
  [CourseStop]="\"courseDayId\" IN (SELECT d.id FROM \"CourseDay\" d JOIN \"Course\" c ON c.id = d.\"courseId\" WHERE c.\"userId\" = '$U')"
  [CourseSchedule]="\"courseId\" IN (SELECT id FROM \"Course\" WHERE \"userId\" = '$U')"
  [CourseScheduleFestival]="\"courseScheduleId\" IN (SELECT s.id FROM \"CourseSchedule\" s JOIN \"Course\" c ON c.id = s.\"courseId\" WHERE c.\"userId\" = '$U')"
  [Post]="\"userId\" = '$U'"
  [PostStop]="\"postId\" IN (SELECT id FROM \"Post\" WHERE \"userId\" = '$U')"
  [PostSave]="\"userId\" = '$U' OR \"postId\" IN (SELECT id FROM \"Post\" WHERE \"userId\" = '$U')"
  [Review]="\"authorId\" = '$U'"
  [ReviewTag]="\"reviewId\" IN (SELECT id FROM \"Review\" WHERE \"authorId\" = '$U')"
)
tbl() { [[ $1 == users || $1 == pets ]] && echo "$1" || echo "\"$1\""; }

echo "== 백업($SRC)에서 $U에게 딸린 행 수"
for t in "${ORDER[@]}"; do
  n=$(docker exec "$C" psql -U test -d "$SRC" -Atc "SELECT count(*) FROM $(tbl "$t") WHERE ${WHERE[$t]}")
  printf '  %-24s %s\n' "$t" "$n"
done

echo "== $DST에 존재 여부 확인(이미 있으면 중단)"
exists=$(docker exec "$C" psql -U test -d "$DST" -Atc "SELECT count(*) FROM users WHERE id = '$U'")
if [[ $exists != 0 ]]; then echo "  사용자가 이미 있다 — 복구할 필요 없음"; exit 1; fi

echo "== 복구(한 트랜잭션으로 묶지 못하는 \\copy 파이프라 테이블 단위로 넣는다 — 실패하면 FK 순서상 뒤 테이블이 안 들어간다)"
for t in "${ORDER[@]}"; do
  if [[ $t == PostSave ]]; then
    # 되살린 글의 saves를 0으로 — 아래 담기 INSERT에서 트리거가 다시 센다
    docker exec "$C" psql -U test -d "$DST" -v ON_ERROR_STOP=1 -qc "UPDATE \"Post\" SET saves = 0 WHERE \"userId\" = '$U'"
  fi
  docker exec "$C" psql -U test -d "$SRC" -v ON_ERROR_STOP=1 -qc "\\copy (SELECT * FROM $(tbl "$t") WHERE ${WHERE[$t]}) TO STDOUT" \
    | docker exec -i "$C" psql -U test -d "$DST" -v ON_ERROR_STOP=1 -qc "\\copy $(tbl "$t") FROM STDIN"
done
echo "== 완료"
