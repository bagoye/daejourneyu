# 09. 모니터링·알림 실습 — 장애를 일부러 일으켜 "알림이 실제로 울리는가"를 검증

> 실습일 2026-11-09 · 환경: `ops-lab/monitoring/`(PostgreSQL 16 primary+standby+WAL 아카이빙, postgres_exporter 0.15,
> Prometheus 2.53, Alertmanager 0.27, Grafana 11.1) · 운영(Supabase)과 무관 · 표기: **[측정]** · **[추정]**

## 1. 목표

대시보드를 띄우는 것으로 끝내지 않는다. 앞선 실습에서 **실제로 겪은 장애 6종**을 일부러 일으키고,
각 알림이 **울리는지, 몇 초 만에 울리는지, 복구하면 꺼지는지**를 측정한다. "정상"의 정의: 6/6 감지, Alertmanager 도착, 복구 후 해제.

## 2. 구성

```
primary ─(스트리밍 복제)─▶ standby        WAL ─▶ /wal-archive
   │                          │
exporter(pg_monitor 전용 계정)  exporter      ─▶ Prometheus(5초 수집·알림 규칙) ─▶ Alertmanager
                                                   └─▶ Grafana 대시보드(프로비저닝)
```

- exporter 계정은 **`pg_monitor` 역할만** 가진다(통계 뷰·설정 읽기 전용, 테이블 데이터 읽기 불가, 연결 5개 제한) — 모니터링 도구가 탈취돼도 데이터가 새지 않는다.
- 기본 지표에 없는 것은 커스텀 쿼리(`exporter-queries.yaml`)로: WAL 보관 실패 수, 복제 재생 지연 바이트, standby 재생 일시정지, 트랜잭션 나이.
- 대시보드(`grafana/dashboards/postgres.json`): 접속 가능 여부, 연결 사용률, 캐시 적중률, WAL 보관, TPS, 복제 지연, 연결 상태, 교착·최장 트랜잭션, pg_stat_statements 상위 쿼리.

| 알림 | 조건(실습값) | 대응하는 앞선 실습 |
|---|---|---|
| PostgresDown | `pg_up == 0 or up == 0`, 10초 | 07 장애 전환 |
| ConnectionsNearLimit | 연결 사용률 > 80%, 10초 | 08 실험 3(`too many clients`) |
| DeadlockDetected | 1분간 교착 증가 > 0 | 02 교착 재현·수정 |
| WalArchiveFailing | 1분간 보관 실패 증가 > 0 | 06 보관소 |
| ReplicationLagHigh | 재생 지연 > 8MB, 10초 | 07 비동기 유실 |
| LongRunningTransaction | 최장 트랜잭션 > 30초, 10초 | VACUUM 방해·잠금 대기 |

실습이라 수집·평가 5초, `for` 10초로 짧게 잡았다. 운영에서는 순간 튐에 울리지 않게 수집 15~30초, `for` 1~5분이 일반적이다.

## 3. 처음 돌렸을 때 — 6개 중 3개가 감지되지 않았다 [측정]

| 문제 | 증상 | 원인(증거) | 수정 |
|---|---|---|---|
| **오탐** | 장애가 없는데 LongRunningTransaction이 pending | exporter 내장 지표 `pg_long_running_transactions_oldest_timestamp_seconds`는 "경과 초"가 아니라 **유닉스 타임스탬프**(값 1794201505) | — (아래로 이어짐) |
| **미감지: 긴 트랜잭션** | 120초 방치해도 안 울림 | `time() - 지표`로 고쳐도 **실제 14초짜리 트랜잭션을 1.2초로 표시** — 내장 지표가 트랜잭션 나이를 재지 않음 | `pg_stat_activity.xact_start`로 직접 계산한 `pg_xact_oldest_seconds` |
| **미감지: WAL 보관 실패** | `failed_count` 0 — 장애가 주입되지 않음 | `archive_command`가 명령줄 `-c`로 지정돼 **`pg_settings.source = 'command line'` → `ALTER SYSTEM`이 무시됨** | 보관소 디렉터리 권한 제거(`chmod 000`)로 실제 `cp` 실패 |
| **미감지: DB 다운** | pending까지만 가고 firing 안 됨 | DB가 죽으면 exporter의 접속 시도가 **수집 제한 시간(5초)을 넘겨 수집 자체가 실패**(`up=0`, `scrape_duration ≈ 5.0s`) → `pg_up` 시계열이 끊겨 pending이 리셋 | exporter `connect_timeout=2` + 조건에 `up == 0` 포함 |

세 번째가 가장 중요하다: **DB가 완전히 죽었을 때 정작 DB 다운 알림이 울리지 않는** 구성이었다. `pg_up == 0`은 흔히 쓰는 규칙이지만,
"exporter가 그 값을 보고할 수 있을 때"만 동작한다. 감시 대상이 죽는 상황에서 감시 장치가 함께 침묵하지 않는지 확인해야 한다.

## 4. 수정 후 결과 — 6/6 감지 [측정]

장애 6종을 처음부터 끝까지 한 번에 실행한 결과:

| 장애(주입 방법) | 알림 | pending | **firing** | Alertmanager | 복구 후 해제 |
|---|---|---|---|---|---|
| 연결 폭주(세션 85개가 연결 점유) | ConnectionsNearLimit | 4초 | **14초** | 도착 | 5초 |
| 교착(두 트랜잭션이 반대 순서로 잠금) | DeadlockDetected | 14초 | **14초** | 도착 | 54초 |
| WAL 보관 실패(보관소 쓰기 권한 제거) | WalArchiveFailing | 9초 | **9초** | 도착 | 49초 |
| 복제 지연(standby 재생 일시정지 + 31MB 쓰기) | ReplicationLagHigh | 8초 | **18초** | 도착 | 3초 |
| 긴 트랜잭션(트랜잭션 열어 둔 채 방치) | LongRunningTransaction | 42초 | **51초** | 도착 | 4초 |
| primary 다운(`docker stop`) | PostgresDown | 5초 | **18초** | 도착 | 8초 |

- 감지 시간 ≈ 조건 충족까지(긴 트랜잭션은 기준 30초) + `for` 10초 + 수집·평가 간격(최대 5초씩).
- 교착·보관 실패는 `increase(...[1m])` 규칙이라 해제까지 약 1분이 걸린다 — 정상 동작이다.
- 부수 관찰: 보관소 권한 장애 동안 실패한 WAL(`.ready`)은 PostgreSQL이 **자동으로 재시도**해, 권한을 되돌리자 밀린 세그먼트가 보관됐다(실패 3회 → 이후 정상).
  복제 지연은 재생 재개 후 31MB를 약 0.4초에 따라잡았다. primary 재시작 후 standby는 자동으로 재연결됐다.

## 5. 운영에 가져갈 것
1. **알림은 장애를 주입해 검증한다.** 규칙이 "로드됨"이어도 6개 중 3개가 실제로는 울리지 않았다.
2. **감시 대상이 죽었을 때 감시 지표도 사라진다** — `up == 0`(수집 실패)·`absent()`를 함께 건다. exporter의 접속 타임아웃 < 수집 제한 시간.
3. **exporter 내장 지표의 의미를 값으로 확인한다.** 이름만 보고 쓴 지표가 오탐·미감지를 모두 일으켰다.
4. **장애 주입 방법이 실제로 장애를 만들었는지 확인한다.** 설정 출처(`pg_settings.source`)가 `command line`이면 `ALTER SYSTEM`이 먹지 않는다.
5. 모니터링 계정은 `pg_monitor`만, 연결 수 제한 — 연결 폭주 장애 때도 모니터링이 슬롯을 다 먹지 않게(08 §3 관찰과 연결).

## 6. 재현 방법
```bash
docker compose -f ops-lab/monitoring/docker-compose.yml up -d --wait
bash ops-lab/scripts/monitoring-drill.sh                       # 6종 전체(약 6분)
ONLY="archive down" bash ops-lab/scripts/monitoring-drill.sh   # 일부
# Grafana http://127.0.0.1:3001 (admin/lab) · Prometheus :9090 · Alertmanager :9093
docker compose -f ops-lab/monitoring/docker-compose.yml down -v
```

## 7. 남은 한계
- 알림을 외부(Slack·메일)로 보내지 않았다(Alertmanager까지 도착만 확인).
- 대시보드는 API로 프로비저닝·데이터소스 정상만 확인했고, 화면 캡처는 남기지 않았다.
- 디스크 사용량·autovacuum 지연·테이블 팽창(bloat) 알림은 다루지 않았다.
- 장애 주입 1회 측정(첫 실행 + 수정 후 3종 재실행 + 전체 1회).
