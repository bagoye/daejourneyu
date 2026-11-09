# 08. PgBouncer 실습 — 운영 설정(`?pgbouncer=true`, `DIRECT_URL`)이 왜 필요한지 재현으로 설명하기

> 실습일 2026-11-09 · 환경: `ops-lab/pgbouncer/`(PostgreSQL 16.15 `max_connections=100` + PgBouncer 1.18 트랜잭션 모드 `default_pool_size=20`)
> 운영(Supabase)과 무관 · 표기: **[측정]** 실제 실행 · **[추정]** 미검증

## 0. 배경

이 프로젝트의 운영 접속 설정(docs/deployment.md)은 이렇다:

```
DATABASE_URL = ...pooler.supabase.com:6543/postgres?pgbouncer=true   ← 앱 런타임: 트랜잭션 모드 풀러
DIRECT_URL   = ...pooler.supabase.com:5432/postgres                  ← 마이그레이션: 세션 풀러
```

"Supabase+Prisma 권장 패턴"이라고만 적혀 있던 이 두 줄이 **각각 무엇을 막는지**를 직접 재현했다.
PgBouncer 1.18(Debian 기본 패키지 — PGDG 저장소가 이 네트워크에서 막혀 있음)은 트랜잭션 모드에서 prepared statement를 지원하지 않는다(1.21부터 지원).

## 1. 실험 1 — 마이그레이션을 트랜잭션 모드 풀러로 돌리면 [측정]

| 단계 | 결과 |
|---|---|
| 풀러(6432) 경유 `prisma migrate deploy` | **성공**(마이그레이션 12개 적용, 약 1초) — 여기까지는 문제가 안 보인다 |
| 직후 `pg_locks` | Prisma Migrate의 advisory lock `72707369`이 풀러의 **idle 서버 연결**에 남아 있음 — **6/6회** |
| 다음 배포(직접 연결 54333) | **`P1002` 타임아웃(15~16초)으로 실패 — 5/6회** |
| 복구 | 잠금을 쥔 서버 연결 `pg_terminate_backend` → 재배포 성공, 남은 잠금 0 (매번) |

- Prisma Migrate는 동시 실행을 막으려고 **세션 단위 advisory lock**을 잡고 끝에 푼다. 트랜잭션 모드에서는 문장마다 다른 서버 연결로 갈 수 있어서
  "잠금"과 "해제"가 서로 다른 서버 연결에서 실행되고, 잠금은 풀에 보관된 서버 연결에 **세션이 끝날 때까지** 남는다.
- 그 결과 **풀러로 한 번 마이그레이션한 것만으로 이후 모든 배포가 막힌다**(직접 연결로 시도해도). 풀러의 서버 연결 수명(기본 1시간)이 지나거나 누군가 연결을 끊을 때까지.
- 예외 1회: 이미지 재빌드 직후 첫 실행에서는 잠금이 곧 사라져 다음 배포가 통과했다. 원인은 확정하지 못했다 [추정: 풀러가 해당 서버 연결을 정리].
- **→ `DIRECT_URL`(세션 단위가 보장되는 접속)로만 마이그레이션해야 하는 이유.** 처음엔 "풀러 경유 마이그레이션은 실패할 것"이라고 예상했는데 틀렸다 — 실패는 **다음 배포**에서 난다. 그래서 더 위험하다.

## 2. 실험 2 — `?pgbouncer=true` 없이 트랜잭션 모드 [측정]

실제 API(목록·검색·담기 트랜잭션), Prisma 풀 10 · 동시 32 · 8초.

| 접속 | 처리량 | p95 | 결과 |
|---|---|---|---|
| 풀러, `pgbouncer=true` **없음** | — | — | **요청 3,041건 중 2,913건(96%) 500** · `prepared statement "sN" does not exist` 6,424회 |
| 풀러, `pgbouncer=true` | 314 rps | 320ms | 오류 0 |
| 직접 연결(기준) | 317 rps | 318ms | 오류 0 |

- Prisma는 연결마다 문장을 미리 준비(prepare)해 두고 재사용한다. 트랜잭션 모드에서는 다음 실행이 **준비하지 않은 다른 서버 연결**로 간다.
  `pgbouncer=true`는 Prisma가 이름 있는 prepared statement를 쓰지 않게 한다.
- 풀러를 거치는 비용은 이 환경에서 처리량 약 1% 차이로 거의 없었다(같은 호스트).

## 3. 실험 3 — 연결 다중화 [측정]

앱 인스턴스 여러 대가 큰 풀을 잡는 상황: Prisma 풀 150 · 동시 200 · 10초, DB `max_connections = 100`.

| 접속 | 처리량 | p95 | 오류 | DB 쪽 연결 |
|---|---|---|---|---|
| 직접 연결 | 278 rps | 2,521ms | **`too many clients already` 204회 → 500 응답 68건** | 100(한도 도달) |
| PgBouncer(pool_size 20) | 234 rps | 2,336ms | **0** | **20** |

- PgBouncer는 클라이언트 150개를 서버 연결 20개로 나눠 태웠다. DB 쪽 연결 수가 앱 인스턴스 수와 무관해진다.
- 처리량은 직접 연결이 약간 높았다 — 연결이 많을수록 병렬로 더 처리하지만, 한도를 넘는 순간 요청이 실패한다. 풀러는 **실패 대신 대기**를 택한다.
- 관찰: 직접 연결 실험 중 **필자의 모니터링 접속까지 실패**했다(DB 연결 최대치를 못 읽음). 앱이 superuser(`postgres`)로 붙어 관리자용 예약 슬롯
  (`superuser_reserved_connections`)까지 써버린 것으로 보인다 [추정]. 장애 중에 DBA가 접속조차 못 하는 상황 — 앱은 최소 권한 역할(04 §5)로 붙어야 하는 또 하나의 이유.

## 4. 실험 4 — 세션 상태 누수 [측정]

```
클라이언트 A: SET statement_timeout = '50ms'   (트랜잭션 밖) → 연결 종료     [서버 pid 2620]
클라이언트 B1: statement_timeout = 50ms                                       [서버 pid 2620]  ← A의 설정을 물려받음
              0.2초 쿼리 → A의 statement_timeout으로 취소
B2, B3: 같음(3/3)
[대조] 세션 모드: B의 statement_timeout = 0(기본값)
```

- 트랜잭션 모드에서는 트랜잭션 밖의 `SET`·세션 advisory lock·`LISTEN`·임시 테이블 같은 **세션 상태가 같은 서버 연결을 다음에 쓰는 다른 클라이언트에게 남는다.**
- 이 프로젝트는 세션 설정을 코드에서 바꾸지 않고, 역할 단위 설정(`ALTER ROLE app_rw SET statement_timeout`, 04 §5)을 쓰므로 안전하다.
  트랜잭션 안에서만 필요하면 `SET LOCAL`을 쓴다.

## 5. 실험 5 — 앱이 풀러 뒤에서도 맞게 동작하는가 [측정]

통합 테스트 31개(동시 담기·취소, 코스 PATCH 행 잠금, 교착 회귀, 롤백, CASCADE, 커서, 검색)를
**`TEST_DATABASE_URL` = PgBouncer 트랜잭션 모드 + `pgbouncer=true`, 마이그레이션만 `TEST_DIRECT_URL` = 직접** 구성으로 실행 → **31/31 통과**.

- Prisma interactive 트랜잭션(`$transaction(async tx => …)`)은 트랜잭션 동안 서버 연결 하나를 쥐므로 트랜잭션 모드에서도 정상 동작한다
  (`SELECT … FOR UPDATE` 행 잠금·유니크 경합 처리 포함).
- 이를 위해 통합 테스트 설정에 `TEST_DIRECT_URL`(선택)을 추가했다 — 운영과 같은 "런타임은 풀러, 마이그레이션은 직접" 구성을 재현.

## 6. 운영에 가져갈 것

| 규칙 | 근거(이 문서) |
|---|---|
| 마이그레이션은 **반드시 `DIRECT_URL`**(직접/세션 모드). 풀러로 돌렸다면 남은 advisory lock부터 확인 | 실험 1 |
| 트랜잭션 모드 풀러 + Prisma는 **`pgbouncer=true`** (PgBouncer 1.21+·Supavisor의 prepared statement 지원 여부는 버전 확인 후) | 실험 2 |
| 앱 인스턴스가 늘어도 DB 연결 수는 **풀러의 pool_size**로 고정 → `max_connections`·플랜 한도 계산이 단순해진다 | 실험 3 |
| 트랜잭션 밖 `SET`·세션 advisory lock 금지, 필요하면 `SET LOCAL` 또는 역할 단위 설정 | 실험 4 |
| 앱은 superuser가 아닌 최소 권한 역할로 — 연결 폭주 시에도 관리자 예약 슬롯이 남는다 | 실험 3 관찰 |

## 7. 재현 방법

```bash
docker compose -f ops-lab/pgbouncer/docker-compose.yml up -d --build --wait
bash ops-lab/scripts/pgbouncer-drill.sh                 # 실험 1~5
EXPS="1" bash ops-lab/scripts/pgbouncer-drill.sh        # 일부만
docker compose -f ops-lab/pgbouncer/docker-compose.yml down -v
```

## 8. 남은 한계
- PgBouncer 1.18만 실습했다. 1.21+의 트랜잭션 모드 prepared statement 지원(`max_prepared_statements`)과 Supabase Supavisor의 동작은 확인하지 못했다.
- 실험 1의 예외 1회(잠금이 곧 사라짐)의 원인은 확정하지 못했다.
- 모두 같은 호스트(네트워크 지연 ≈ 0)에서의 측정이다.
