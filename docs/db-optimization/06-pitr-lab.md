# 06. PITR(시점 복구) 실습 — WAL 아카이빙 · 베이스 백업 · 사고 트랜잭션 직전 복구

> 실습일 2026-11-09 · 환경: `ops-lab/docker-compose.yml`(PostgreSQL 16.15, Docker Desktop on Windows) · 운영(Supabase)과 무관
> 표기: **[측정]** 실제 실행 결과 · **[추정]** 미검증

## 1. 목표와 "정상"의 정의

**목표**: 사람이 낸 사고(WHERE 없는 UPDATE, 잘못된 삭제)를 **사고 직전 상태로** 되돌린다. `pg_dump` 같은 논리 백업은
백업 시점으로만 돌아갈 수 있어 그 이후 쓰기가 전부 사라진다(04 §3). PITR은 베이스 백업에 WAL을 재생해 **임의 시점**까지 간다.

**정상의 정의**
- 복구 결과가 사고 직전에 떠 둔 정합성 스냅샷(`backend/scripts/ops/verify-integrity.sql`, 행 수·체크섬·규칙 위반·스키마 객체 43줄)과 **한 줄도 다르지 않다.**
- 베이스 백업 **이후·사고 이전** 쓰기는 살아 있다(WAL 재생).
- 사고와 그 **이후** 쓰기는 없다(시점 복구의 대가 — §6).

## 2. 구성 — PostgreSQL 기본 기능만

```
쓰기 ─▶ WAL ─(archive_command: 세그먼트가 닫힐 때마다 복사)─▶ /wal-archive
                                       pg_basebackup ─▶ /backups/base-<시각>
복구: 베이스 백업 복사 + recovery.signal + restore_command(보관소에서 WAL 가져오기)
      + recovery_target_xid(또는 _time) + recovery_target_action=promote
```

| 설정 | 값 | 이유 |
|---|---|---|
| `wal_level` | replica | 아카이빙·복제에 필요한 WAL 기록 |
| `archive_command` | `test ! -f /wal-archive/%f && cp %p /wal-archive/%f` | 같은 이름이 있으면 실패 → 보관된 WAL을 덮어쓰지 않음(PostgreSQL 문서 기본 예) |
| `archive_timeout` | 60s | 쓰기가 적어도 60초마다 세그먼트를 넘겨 보관 → 서버를 통째로 잃을 때의 최대 손실 상한 |

처음엔 pgBackRest로 시작했지만, 이 네트워크에서 PGDG 저장소(`apt.postgresql.org`)에 연결되지 않아(호스트·컨테이너 모두 타임아웃)
Debian 기본 패키지인 pgBackRest 2.45가 설치됐고, 이 버전은 PostgreSQL 16을 지원하지 않았다(`VersionNotSupportedError`).
그래서 **기본 기능으로 직접 구현**했다 — 외부 다운로드가 없어 누구나 재현할 수 있고, 도구가 자동화하는 원리를 그대로 보여준다.

## 3. 훈련 시나리오 — `ops-lab/scripts/pitr-drill.sh`

1. 베이스 백업(`base-backup.sh` — 보관 정책 포함, §5)
2. 백업 **이후** 정상 쓰기: 새 글 + 방문 장소 + 담기(트리거로 saves +1)
3. 정상 시점 T 기록 + 정합성 스냅샷
4. **사고**: `UPDATE "Post" SET caption = '(실수로 덮어씀)'`(WHERE 누락, 2만 건) + `DELETE FROM users WHERE id = 'u00000002'`(CASCADE로 코스·글·후기 등 수천 행)
5. 사고 **이후** 정상 쓰기: 새 글 1건
6. 사고 조사(`pg_waldump`) → 복구 → promote
7. 검증

## 4. 결과

### 4.1 시각 기반 복구(`recovery_target_time`) [측정]

| 베이스 백업 이후 WAL | 복구 시간(RTO) | DB 크기 | 결과 |
|---|---|---|---|
| 31MB | 3.1초 | 111MB | 완전 일치 |
| 474MB | 8.3초 | 119MB | 완전 일치 |
| 1,513MB | 14.5초 | 217MB | 완전 일치 |
| 3,005MB | 37.8초 | 482MB | 완전 일치 |

- RTO = DB 정지 → 베이스 백업 복사 → WAL 재생 → promote → 접속 가능까지.
- **복구 시간은 베이스 백업 이후 WAL 양에 따라 늘어난다** → 목표 RTO 안에 재생할 수 있는 WAL 양을 넘기 전에 새 베이스 백업을 받아야 한다
  (= 베이스 백업 주기의 근거). 단, 이 실험은 반복 UPDATE로 DB도 함께 커져 베이스 백업 복사 시간이 섞여 있다.

### 4.2 그런데 한 번은 실패했다 — 원인: 시계 역행 [측정]

같은 절차가 한 번은 **사고를 되돌리지 못했다**(제목 덮어쓰기·사용자 삭제가 복구 결과에 남음). PostgreSQL 로그:

```
recovery stopping before abort of transaction 1073, time 04:28:23.519308+00
last completed transaction was at log time 04:28:22.318494+00     ← T(04:28:22.457)보다 앞
```

- `recovery_target_time`은 **각 커밋 레코드에 찍힌 서버 시계 시각**으로 멈출 위치를 정한다.
- 가설: 사고 직후 시계가 뒤로 가서 사고 트랜잭션의 커밋 시각이 T보다 *앞*으로 기록됐다 → 복구가 사고를 "T 이전"으로 보고 재생.
- 검증: 컨테이너 시계를 90초간 0.1초 간격으로 읽었더니 **약 27초마다 3.67초씩 역행**(4회, 최대 3,677ms). Docker Desktop VM의 시간 동기화로 보인다 [추정].
  앞서 종료 처리 실험에서 경과 시간이 음수(-2,385ms)로 찍힌 것도 같은 현상.
- 즉 앞의 성공들은 T~사고 사이에 역행이 없었던 **운**이었다. 운영에서도 NTP 보정·VM 일시정지로 같은 일이 생길 수 있다.

### 4.3 시계와 무관한 복구 — `pg_waldump`로 사고 트랜잭션을 찾아 그 직전까지 [측정]

실제 장애 대응처럼, 앱 로그로 "대략 이때부터"(LSN)를 알고 WAL을 직접 읽어 사고 트랜잭션을 찾는다:

```
후보(상위 5): Heap 레코드 수 · 그중 Post 테이블 · xid · 커밋 시각(서버 시계)
  36401 36401 877 2026-11-09 04:35:16.437909 UTC   ← WHERE 없는 UPDATE
   2841   246 878 2026-11-09 04:35:16.686416 UTC   ← 사용자 삭제 CASCADE
      2     1 879 2026-11-09 04:35:16.892110 UTC   ← 사고 이후 정상 글
→ recovery_target_xid = '877', recovery_target_inclusive = false
LOG:  recovery stopping before commit of transaction 877
```

| 방식 | 연속 실행 | 결과 | RTO |
|---|---|---|---|
| `recovery_target_xid`(사고 직전, exclusive) | 6회(첫 실행 + 5회 연속) | **6/6 완전 일치** | 3.3~5.6초 |

- 사고 트랜잭션 **하나만** 빼는 게 아니라 그 **커밋 시점 이후 전부**를 되돌린다(사용자 삭제·사고 이후 글도 함께 사라짐 — §6).
- 자동 선택 기준(Post 변경이 가장 많은 트랜잭션)은 훈련용이다. 실제로는 DBA가 후보 표의 테이블·행 수·시각을 보고 판단한다.

## 5. WAL 보관 정책 — `ops-lab/scripts/base-backup.sh`

- 정리하지 않으면 보관소가 끝없이 자란다: 훈련 5회 만에 **5.6GB**. 보관소 디스크가 차면 `archive_command`가 실패하고,
  보관되지 못한 WAL이 `pg_wal`에 쌓여 **DB 디스크까지 가득 찬다** — 백업 장치가 서비스 장애의 원인이 된다.
- 정책: 베이스 백업 최근 **KEEP=2**개만 보관, 그중 가장 오래된 것의 시작 WAL(`backup_label`) 이전은 `pg_archivecleanup`으로 삭제.
  → 복구 가능 구간 = "가장 오래된 보관 백업 시작 ~ 마지막 보관 WAL".
- 결과 [측정]: 673MB(50개) → 81MB(13개). 이후 6회 훈련 내내 베이스 백업 2개 · 보관소 약 150~180MB에서 유지되며 매번 복구 성공
  (= 정리가 필요한 WAL을 지우지 않았다는 증거).
- **실수 기록**: 처음 작성한 정리 단계는 `docker exec`에 `-i`가 빠져 스크립트가 표준입력을 받지 못해 **아무 일도 하지 않고 조용히 끝났다**
  (베이스 백업 3개가 쌓인 것을 보고 발견). 백업 스크립트는 "실행됐다"가 아니라 "결과(남은 개수·크기)"를 출력하고 확인해야 한다.

## 6. RPO·RTO 정리

| 장애 유형 | 되돌릴 수 있는 지점 | 잃는 것(RPO) | RTO(이 환경) |
|---|---|---|---|
| 사람의 실수(잘못된 UPDATE·DELETE) | 사고 트랜잭션 직전 | 사고 **이후**의 정상 쓰기(이번 훈련: 글 1건) | 3~6초(WAL 30MB대) |
| DB 서버·디스크 통째 유실 | 마지막으로 보관된 WAL | 최대 `archive_timeout`(60초) + 보관 안 된 현재 세그먼트 | 베이스 백업 복사 + WAL 재생 |

- 사고 이후의 정상 쓰기를 살리려면, **복구 전에** 사고 난 DB에서 그 변경을 추출해 두었다가 복구 후 다시 적용한다
  (예: 사고 시각 이후 `createdAt`인 글을 `\copy`) — 이번 훈련은 자동화하지 않았다.
- 서버 유실 RPO를 줄이려면 `archive_timeout`을 줄이거나(보관 파일 증가와 교환), 스트리밍 복제(다음 실습)로 WAL을 실시간 전송한다.

## 7. 운영에 가져갈 것

1. **시각보다 xid/LSN/복구 지점**: 위험한 작업(대량 수정·마이그레이션) 전에 `SELECT pg_create_restore_point('before-<작업>')` →
   `recovery_target_name`으로 정확히 돌아갈 수 있다. 사고는 `pg_waldump`로 트랜잭션을 특정해 `recovery_target_xid`.
2. **서버 시계 감시**: NTP 동기화, 시계 역행 모니터링. 시각 기반 복구·로그 상관 분석이 모두 시계에 기대고 있다.
3. **보관소는 DB와 다른 장비/저장소**(S3 등)에 두고, 보관 정책과 "보관 실패 알림"(`pg_stat_archiver.failed_count`)을 함께 운영.
4. **복구 훈련을 정기적으로**: 이번처럼 "한 번 성공"은 증거가 아니다 — 반복과 검증 diff가 있어야 한다.

## 8. 재현 방법

```bash
docker compose -f ops-lab/docker-compose.yml up -d --wait
cd backend
DATABASE_URL=postgresql://postgres:lab@127.0.0.1:54330/daejourneyu DIRECT_URL=$DATABASE_URL npx prisma migrate deploy
docker exec -i -u postgres djy-lab-db psql -d daejourneyu -v scale=0.2 < scripts/perf/seed-large.sql
cd ..
TARGET=xid bash ops-lab/scripts/pitr-drill.sh          # 기본값 xid
TARGET=time WAL_ROUNDS=40 bash ops-lab/scripts/pitr-drill.sh   # 시각 기반 + WAL 양 늘리기
docker compose -f ops-lab/docker-compose.yml down -v   # 정리
```

## 9. 남은 한계
- 보관소·베이스 백업이 DB와 같은 Docker 호스트에 있다(외부 저장소 미구성). 서버 유실 시나리오는 실습하지 않았다.
- pgBackRest·WAL-G(증분 백업·병렬 복원·보관 검증 자동화)와의 비교는 네트워크 문제로 하지 못했다.
- 사고 이후 정상 쓰기의 재적용은 절차만 적었다.
- 시계 역행의 정확한 원인(Docker Desktop/WSL2 시간 동기화)은 확인하지 않았다 [추정].
