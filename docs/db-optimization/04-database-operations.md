# 04. DB 운영 안정성 — 커넥션·느린 SQL·백업/복구·권한

> 실습일 2026-11-09 · 모든 실습은 로컬 Docker PostgreSQL 16(`daejourneyu-test-pg`)의 성능 DB(게시물 10만 건 규모)에서 했다.
> 운영 Supabase에는 접속·변경하지 않았다. 표기: **[측정]** 실제 실행 · **[추정]** 미검증 · **[확인 필요]** 운영 콘솔에서 확인할 것

## 1. 커넥션 관리

### 현재 구성(코드·문서 확인)
- 런타임 `DATABASE_URL` = Supabase **트랜잭션 풀러(6543, `pgbouncer=true`)**, 마이그레이션 `DIRECT_URL` = 세션 풀러(5432).
- `connection_limit` 미지정 → Prisma 기본값(물리 코어 수 × 2 + 1). **배포 호스트 사양에 따라 연결 수가 달라진다.**
- `PrismaClient`는 싱글턴(개발 중 핫리로드 누수 방지). 종료 시 `$disconnect`가 없었다.

### 풀 크기 실험 — `scripts/ops/poolBench.ts` [측정]
실제 라우터에 32개 동시 요청(목록 70% · 검색 20% · 담기/취소 트랜잭션 10%), 각 10초.

| connection_limit | 처리량 | p50 | p95 | 오류 |
|---|---|---|---|---|
| 1 | 39 rps | 650ms | 1,970ms | 0 |
| 2 | 76 rps | 350ms | 894ms | 0 |
| 5 | 184 rps | 136ms | 370ms | 0 |
| 10 | 276 rps | 81ms | 297ms | 0 |
| 20 | 296 rps | 68ms | 306ms | 0 |

- 10을 넘으면 처리량이 +7%에 그친다 → 이 지점부터는 DB가 아니라 Node 단일 스레드(JSON 직렬화 등)가 병목 [추정].
- **권장**: 운영 URL에 `connection_limit`을 명시(예: 10)하고, `인스턴스 수 × connection_limit`이 Supabase 풀러 한도 안에 들게 한다.
  Supabase 플랜별 한도는 [확인 필요].

### 풀 고갈 재현과 대응 [측정]
`connection_limit=1, pool_timeout=1`, 동시 128 → 요청 808건 중 **490건이 500**. 로그는 Prisma 스택이 수백 건 쌓였다.
원인은 `P2024 Timed out fetching a new connection from the connection pool`.

- **수정**: `lib/errorHandler.ts`에서 P2024·P2028(트랜잭션 시작 대기·시간 초과)을 **503 + `Retry-After: 1`**로 응답하고, 로그는 한 줄 경고.
  같은 조건 재실행: 503 467건(이제 "일시적 과부하"로 구분됨), 서버 오류(500) 0건.

### 종료 처리(graceful shutdown)
- `lib/shutdown.ts`: SIGTERM/SIGINT → 새 연결 수신 중단 → 진행 중 요청 완료 → `prisma.$disconnect()` → 종료. 10초 안에 안 끝나면 강제 종료.
- 단위 테스트 4개로 순서·중복 신호·제한 시간·오류 경로 검증. Windows에서는 리눅스 신호 동작을 그대로 재현하기 어려워 **실제 SIGTERM 수신은 미검증** [미검증].

## 2. 느린 SQL 추적

### 앱 쪽 — 느린 쿼리 로그
`lib/prisma.ts`: Prisma 쿼리 이벤트 중 `SLOW_QUERY_MS`(기본 500ms, 0이면 끔)를 넘는 것만 경고. **파라미터 값은 남기지 않는다**
(이메일·검색어가 로그 저장소로 흘러가지 않게). 100ms로 낮춰 돌렸을 때 잡힌 것 [측정]:

```
[db] 느린 쿼리 107ms: SELECT COUNT(*) ... FROM "Post" WHERE "Post"."searchText" ILIKE $1 ...
[db] 느린 쿼리 357ms: SELECT "Review"... FROM "Review" ... (필터 없는 후기 전체 — 하위 호환 경로)
```

두 번째는 **예상하지 못한 발견**이다. 프론트가 더는 쓰지 않는 "limit 없는 후기 목록"이 남아 있어, 파라미터 없는 요청 하나로
전 사용자 후기 10만 건(133.6MB, 6.3초)을 받아 갈 수 있었다 → 응답 모양(배열)은 유지하되 **최신 100건 상한**(내 후기 제외).
재측정: 93.8KB · 약 15ms.

### DB 쪽 — `pg_stat_statements`
`shared_preload_libraries`에 올리고(로컬 compose에 반영) 실제 API 부하 15초 후 누적 실행 시간 상위 SQL [측정]:

| 순위 | DB 시간 비중 | 호출 | 평균 | SQL |
|---|---|---|---|---|
| 1 | 80.0% | 765 | 137ms | 검색 결과 건수 COUNT |
| 2 | **14.5%** | 2,840 | 6.7ms | 필터 없는 목록 전체 건수 COUNT |
| 3 | **4.5%** | 406 | **14.5ms** | `DELETE FROM "Course"` (담기 취소의 사본 삭제) |

- **3번 — 인덱스 없는 FK**: 행 하나 삭제에 14.5ms. `EXPLAIN ANALYZE`를 보니 13.0ms 중
  `Trigger for constraint PostSave_courseId_fkey: time=11.117`. Course를 지우면 `ON DELETE SET NULL`이 PostSave를
  `courseId`로 찾는데 그 컬럼에 인덱스가 없어 담기 30만 행을 매번 스캔했다.
  카탈로그 점검 쿼리(`scripts/ops/check-fk-indexes.sql`)로 같은 문제가 하나 더 있음을 확인(`CourseScheduleFestival.courseScheduleId`).
  → 마이그레이션 `20261109020000_fk_indexes` · 코스 삭제 **13.0 → 1.7ms**, FK 트리거 **11.1 → 0.13ms**. 점검 쿼리 재실행 결과 0행.
- **2번 — 매번 세는 전체 건수**: 목록 위 "총 N개"용. 화면을 바꾸지 않기 위해 건수는 유지하고, 필터 없는 전체 건수만
  **30초 메모리 캐시**(글 작성·삭제 시 즉시 무효화). 필터·검색·내 글 건수는 조건마다 달라 캐시하지 않는다.
- **재측정**: 2·3번이 상위 목록에서 사라지고 **검색 건수 COUNT가 DB 시간의 98.6%**. 남은 병목이 하나로 좁혀졌다.

### 남은 병목 — 2글자 검색의 건수 (권고, 미적용)
| 방식 | 흔한 2글자('갑천') | 드문 2글자('퓨마', 0건) |
|---|---|---|
| 현재(정확한 건수) | 146ms | 약 138ms |
| 건수 상한(최대 1,001까지만 셈) | **6.4ms** | 138ms (전체 스캔은 그대로) |

상한은 화면 표시가 "1,000개 이상"으로 바뀌는 **UX 변경**이라 적용하지 않고 권고로 남긴다. 2글자를 근본적으로 받으려면 bigram 인덱스(`pg_bigm`)가 필요하다 — Supabase 지원 여부 [확인 필요].

운영 Supabase는 대시보드 Query Performance가 `pg_stat_statements` 기반이다 — 활성 여부·권한 [확인 필요].

## 3. 백업과 복원

### 전체 백업·복원 [측정, 게시물 10만 건 · DB 473MB]
| 단계 | 결과 |
|---|---|
| `pg_dump -Fc`(custom, 압축) | 3.1초 · **21.8MB** |
| `pg_dump`(plain SQL) | 1.1초 · 211MB |
| `pg_restore -j 1` | 8.4초 |
| `pg_restore -j 4` | **2.6초**(병렬 3.3배) |

- 덤프가 DB보다 훨씬 작은 이유: 인덱스는 정의만 담기고(복원 때 재생성), custom 형식은 압축된다.
- 복원 시간의 대부분은 인덱스 재생성이라 `-j`로 병렬화하면 크게 준다.

### 복원 검증 — `scripts/ops/verify-integrity.sql`
원본과 복원본에 같은 점검을 돌려 출력을 diff 한다(43줄):
1. 테이블별 행 수 · 2. 내용 체크섬(기본키 순 md5) · 3. 업무 규칙 위반 7종(saves 드리프트, 음수 saves, 빈 검색 문서,
일차 없는 코스, nights 불일치, 장소 없는 게시물, 태그 없는 후기) · 4. 스키마 객체(검증된 FK 15, CHECK 1, 인덱스, 무효 인덱스 0,
트리거, 비활성 트리거 0, pg_trgm, 적용된 마이그레이션) · 5. **기능 점검**: 담기 INSERT 시 트리거가 saves를 +1 하는지(ROLLBACK).

결과 [측정]: **diff 0줄**(완전 일치), 규칙 위반 전부 0, 트리거 동작 +1.
처음 실행 때는 UNION 결과에 ORDER BY가 없어 출력 순서만 달랐다 — 값은 같았지만 자동 비교가 가능하도록 정렬을 추가했다.

### 장애 시나리오 — "운영자가 사용자 1명을 실수로 삭제" [측정]
| 단계 | 결과 |
|---|---|
| 사고 | `DELETE FROM users WHERE id = 'u00000001'` 391ms → CASCADE로 **9개 테이블 14,474행** 삭제(코스 504, 일차 971, 장소 2,923, 글 1,002, 글 장소 3,057, 담기 3,144, 후기 977, 후기 태그 1,895), 다른 사람 글 38개의 담기 수도 트리거로 감소 |
| 영향 확인 | 정합성 점검 diff로 영향 테이블·행 수를 즉시 파악 |
| 선택 복구 | `scripts/ops/recover-user.sh`: 백업을 별도 DB에 복원 → 그 사용자에게 딸린 행만 FK 순서대로 `\copy` · **5.3초** |
| 검증 | 복구 후 원본 vs 백업 점검 diff **0줄**(체크섬·saves 드리프트 포함 완전 일치) |

- **전체 복원을 택하지 않은 이유**: 전체 복원은 백업 이후 다른 사용자들의 변경까지 되돌린다.
- **담긴 수 처리**: 되살린 글은 백업 당시 saves를 들고 와서 담기 행을 넣을 때 트리거가 두 번 센다 → 되살린 글의 saves를 0으로 두고 트리거가 다시 세게 했다.
  이 사용자가 남의 글에 했던 담기는 삭제 때 트리거가 깎아 둔 상태라, 다시 넣으면 원래대로 올라간다. **카운터를 트리거로 옮긴 결정(02 §3)이 복구를 단순하게 만들었다.**
- 한계: 백업 이후 그 사용자가 새로 만든 데이터는 되살릴 수 없다(손실 범위 = 마지막 백업 이후). `\copy` 파이프는 테이블 단위라 하나의 트랜잭션이 아니다.

### 운영 백업 정책 [확인 필요]
Supabase는 플랜에 따라 일일 백업·PITR(시점 복구)을 제공한다. 현재 플랜(Free)의 백업 보관 기간·PITR 가능 여부를 콘솔에서 확인하고,
불충분하면 위 `pg_dump -Fc`를 주기적으로 외부 저장소에 보관하는 방안을 권장한다. 복원 리허설은 이 문서의 절차를 따른다.

## 4. 환경 분리

| 항목 | 이전 | 조치 |
|---|---|---|
| `prisma/seed.ts` | 어떤 DB든 목데이터를 넣음. 배포 문서가 `backend/.env`에 Supabase 주소를 넣으라고 안내 → 습관적 `db:seed`가 운영에 목데이터 삽입 가능 | DATABASE_URL이 로컬이 아니면 **중단**(`ALLOW_REMOTE_SEED=true`일 때만 허용). 원격·로컬 각각 실행해 동작 확인 |
| 시드 글 검색 문서 | 2차 작업 후 시드가 `searchText`를 안 채워 **시드 글이 검색에 안 걸림**(정합성 점검으로 발견) | 검색 문서 생성을 `lib/searchText.ts`로 모아 라우터·시드가 같은 함수를 쓰게 함 |
| `.env.example` | `DIRECT_URL` 누락(스키마가 참조 → migrate 실패), 풀 파라미터 안내 없음 | `DIRECT_URL`, `connection_limit`/`pool_timeout` 권장값과 근거, `SLOW_QUERY_MS` 추가 |
| 통합 테스트·성능 스크립트 | — | 접속 호스트가 localhost가 아니면 시작 전 중단 |
| `backend/CLAUDE.md` | "DB·dotenv·에러 핸들러 없음, CORS 하드코딩, SQLite" 등 사실과 다른 서술 | 현재 구조·동시성 규칙·FK 인덱스 규칙으로 갱신 |

## 5. DB 권한 최소화

### 현재
앱 런타임이 `postgres` 계정(DDL까지 가능한 관리자)으로 붙는다. 앱 코드나 의존성이 탈취되면 테이블 삭제·스키마 변경까지 가능하다.

### 최소 권한 역할 — `scripts/ops/create-app-role.sql` [측정]
`app_rw`: 스키마 USAGE + 테이블 SELECT/INSERT/UPDATE/DELETE, 마이그레이션 기록은 읽기만, `statement_timeout=5s`,
`idle_in_transaction_session_timeout=10s`, 이후 마이그레이션이 만드는 테이블에도 자동으로 같은 권한(DEFAULT PRIVILEGES).

| 검증 | 결과 |
|---|---|
| 앱 기능(app_rw로 접속): 목록·검색·내 코스·후기·담기 트랜잭션 | **전부 200** |
| `CREATE TABLE` | permission denied for schema public |
| `DROP TABLE "Post"` / `ALTER TABLE` | must be owner |
| `TRUNCATE "PostSave"` | permission denied |
| `DELETE FROM "_prisma_migrations"` | permission denied |
| `CREATE ROLE` | permission denied |
| 6초짜리 쿼리 | statement timeout으로 취소 |

- **권장 구성**: `DATABASE_URL` = app_rw(런타임), `DIRECT_URL` = 소유자(마이그레이션 전용, 배포 파이프라인에서만).
- 담기 카운터 트리거는 호출자 권한으로 실행되는데, app_rw가 Post UPDATE 권한을 가져 정상 동작(위 담기 트랜잭션으로 확인).
- Supabase 적용 시 풀러 사용자명 형식(`app_rw.<project-ref>`)과 적용 절차 [확인 필요]. **운영에는 적용하지 않았다.**

### Supabase Data API(PostgREST) [확인 필요]
배포 문서는 Data API를 "꺼도 된다"고만 안내한다. 켜져 있고 RLS가 꺼져 있으면 public 스키마 테이블이 REST로 노출될 수 있다.
이 서비스는 supabase-js를 쓰지 않으므로 **Data API를 끄거나 모든 테이블에 RLS를 켜는 것**을 권장한다(백엔드는 소유자/전용 역할로 붙어 RLS 영향 없음).

## 6. 남은 한계
- 2글자 검색 건수(약 140ms)는 해결하지 못했다(§2 권고).
- 커넥션 풀·종료 처리는 로컬 단일 인스턴스에서만 측정했다. Railway의 실제 vCPU·인스턴스 수, Supabase 풀러 한도는 [확인 필요].
- 백업은 논리 백업(`pg_dump`)만 실습했다. PITR(WAL 기반)은 로컬에서 실습하지 않았다.
- 선택 복구 스크립트는 현재 스키마의 FK 관계를 손으로 적은 것이다 — 테이블이 늘면 같이 고쳐야 한다(복구 후 diff 점검이 누락을 잡는다).
