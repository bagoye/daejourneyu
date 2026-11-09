# 03. SQL 실행계획 및 성능 비교

> 측정일 2026-11-09 · 표기: **[측정]** 실제 실행 결과 · **[추정]** 원리상 예측(미검증)

## 1. 실험 환경

| 항목 | 값 |
|---|---|
| DB | PostgreSQL 16.15 (`postgres:16-alpine`, Docker, 24 vCPU / 32GB 호스트) |
| 설정 | **기본값 그대로** — `shared_buffers=128MB`, `work_mem=4MB`, `random_page_cost=4`, `jit=on`, `max_parallel_workers_per_gather=2` |
| DB 분리 | 통합 테스트 DB(`daejourneyu_test`)와 별도인 `daejourneyu_perf`. 운영(Supabase)과 무관 |
| 스키마 | 저장소 마이그레이션을 `prisma migrate deploy`로 그대로 적용 |

튜닝하지 않은 기본 설정을 쓴 이유: 인덱스·쿼리 모양의 효과만 분리해서 보기 위해서다. 운영(Supabase)의 설정은 다를 수 있다(특히 JIT — §4).

## 2. 테스트 데이터 — `backend/scripts/perf/seed-large.sql`

```bash
docker exec -i daejourneyu-test-pg psql -U test -d daejourneyu_perf -v scale=1 < scripts/perf/seed-large.sql
```

| 테이블 | 행 수 (scale=1) | 분포 |
|---|---|---|
| users | 10,000 | |
| Course / CourseDay / CourseStop | 50,000 / 100,088 / 300,226 | 작성자 `random()^2` 쏠림(헤비 유저 최대 504개) |
| Post / PostStop | 100,000 / 301,274 | 작성자 쏠림, 제목은 어휘 30개 조합 |
| PostSave | 297,605 | 대상 글 `random()^3` 쏠림 → saves 최대 4,771 · 평균 2.98 |
| Review / ReviewTag | 100,000 / 194,437 | 장소 2,000곳에 `random()^3` 쏠림(인기 장소 7,950건), 5%에 약 19KB 사진 |

- **재현성**: `setseed(0.42)` 고정. 두 번 생성해 Post 전체 체크섬(md5) 일치 확인 **[측정]**.
- **소요**: 약 35초, DB 크기 385MB **[측정]**.
- **정합성**: 대량 적재 중 담기 트리거를 끄고 마지막에 한 번 보정(행마다 UPDATE 30만 번 회피) → saves 드리프트 0 확인.
- 겪은 함정: 바깥 행을 참조하지 않는 `LATERAL (SELECT random() ...)`은 PostgreSQL이 한 번만 계산해 **게시물 10만 개 작성자가 전부 한 명**이 됐다. 모든 LATERAL에 바깥 행 참조를 넣어 해결.
- 한계: 어휘가 30개뿐이라 검색어 하나가 글의 약 17%에 걸린다(실제보다 선택도가 높음 → 인덱스 효과가 **과소** 측정될 가능성 [추정]).

## 3. 측정 방법

1. **실제 SQL 수집**: 성능 DB에 `log_min_duration_statement = 0`을 걸고, 실제 라우터를 호출하는
   `scripts/perf/captureQueries.ts`를 실행 → Prisma가 보낸 SQL·파라미터·소요 시간을 서버 로그에서 추출.
2. **실행계획**: 수집한 SQL을 리터럴로 바꿔 `EXPLAIN (ANALYZE, BUFFERS)` — `scripts/perf/explain.sql`(개선 전),
   `explain-after.sql`(개선 후). 캐시 영향을 줄이려 한 번 돌린 뒤 두 번째 결과를 쓴다.
3. **반복 부하**: `pgbench`(8 클라이언트 × 20초) — `scripts/perf/run-bench.sh`, `bench/*.sql`.
4. **API 단위**: 같은 `captureQueries.ts`로 응답 크기·소요 시간.

Prisma는 prepared statement를 쓰므로 운영에서는 generic plan이 쓰일 수 있다. 여기 실행계획은 리터럴(custom plan) 기준이다.

## 4. 개선 전 실행계획 [측정]

| # | 쿼리 | 실행계획 | 실행 시간 |
|---|---|---|---|
| Q1a/b | 최신순 첫 페이지 / 51페이지 | Post **Parallel Seq Scan 10만 행** + top-N heapsort | 11.3 / 12.0ms |
| Q2a/b | 담기순 첫 페이지 / 51페이지 | 동일 | 11.4 / 12.1ms |
| Q2c | 전체 건수 | 가장 작은 인덱스(`Post_courseId_idx`) Index Only Scan | 8.1ms |
| **Q3a/b** | **검색 목록 / 건수 ('갑천')** | Post Seq Scan + **PostStop Seq Scan 2회**(EXISTS 2개) | **421 / 382ms** |
| Q4 | 사용자별 코스(헤비/일반) | Course **Seq Scan 5만 행** | 3.7 / 3.0ms |
| Q5a | 장소별 후기 첫 페이지 | 기존 `(placeId, createdAt)` 역방향 Index Scan | 0.07ms |
| Q5b | 내 후기 | `Review_authorId_idx` Bitmap Scan | 1.6ms |
| Q6 | 담기 여부(한 페이지) | 유니크 인덱스 `(userId, postId)` | 0.04ms |

### 검색이 느린 진짜 이유 — JIT

```
Seq Scan on "Post"  (cost=0.00..2759633.61 rows=77574) (actual time=183.568..271.947 rows=18785)
  Filter: (caption ~~* '%갑천%' OR text ~~* ... OR (hashed SubPlan 2) OR (hashed SubPlan 4))
JIT:
  Timing: Generation 1.995 ms, Inlining 87.512 ms, Optimization 127.565 ms, Emission 99.079 ms, Total 316.151 ms
Execution Time: 420.989 ms
```

- 플래너가 EXISTS 서브플랜 비용을 **276만**으로 과대 추정 → `jit_above_cost`(10만)·`jit_inline_above_cost`·
  `jit_optimize_above_cost`(50만)를 모두 넘어 **인라이닝·최적화까지 켜진 JIT 컴파일이 실행 시간의 75%(316ms)**.
- `SET jit = off` 비교(각 3회): 380~431ms → **205~211ms**. 그래도 남는 200ms는 10만 행 × 여러 컬럼 ILIKE + PostStop 스캔.
- 즉 원인은 둘이다: ① OR 안의 EXISTS 때문에 **인덱스를 결합(BitmapOr)할 수 없는 쿼리 모양**, ② 그 모양이 만든 비용 과대 추정이 JIT를 유발.

## 5. 개선안 실험과 판단

### 5.1 검색 [측정, jit=off에서 비교]

| 방식 | '갑천'(2글자) | '한밭수목원'·'오월드'(3글자+) |
|---|---|---|
| 기존 쿼리 | 206ms | (기존과 같은 모양) |
| (A) EXISTS 2개 → 1개로 합침 | 141ms | — |
| **(B) 검색 문서 컬럼 `searchText` + pg_trgm GIN + tags GIN** | **42ms** (Seq Scan — trigram 사용 불가) | **23ms** (BitmapOr) |

- **결과 동일성**: 키워드 6종(갑천·한밭수목원·오월드·유성구·카페·사용자12)에서 기존 조건과 (B)의 건수가 **완전히 일치**.
- **2글자 한계**: pg_trgm은 3글자 미만 패턴에서 추출할 trigram이 없어 인덱스로 거르지 못한다 → Seq Scan. 그래도 단일 컬럼이라 기존보다 빠르다.
  한국어 2글자 검색을 인덱스로 받으려면 bigram(`pg_bigm`)이 필요하다 — Supabase 지원 여부 확인 필요 [미확인].
- **채택: (B)**. 필드 사이를 줄바꿈으로 이어 "두 필드에 걸친 매칭"이 생기지 않게 했다(통합 테스트로 확인).
  단, 위 실험은 태그를 정확일치(배열 GIN)로 둔 초기 형태다. 드문 검색어에서 문제가 드러나 **최종적으로는 태그도 검색 문서에 넣었다** — §5.5.
  (그 결과 태그의 일부만 쳐도 걸리게 되어, 위 건수 일치는 "태그 일부 문자열" 검색어에 대해서는 더 이상 성립하지 않는다 — 의도된 변경.)
- 대안 비교: 전문 검색(tsvector)은 한국어 형태소 사전이 없어 부분일치 요구를 못 맞춤 · raw SQL UNION은 인덱스를 쓰지만 Prisma 밖으로 나가 필터 조합(유형·내 글) 유지보수가 어려움.

### 5.2 목록 정렬·커서 [측정, 9만 번째 글 이후 페이지]

| 커서 조건 모양 | 최신순 | 담기순 |
|---|---|---|
| 기존(OR만) + 정렬 인덱스 | 5.7ms — 인덱스로 **9만 행 읽고 필터로 버림** | 6.9ms |
| **OR + 선행 범위 조건 `a <= a0`** | **0.03ms** (Index Cond로 시작 위치) | **0.85ms** (saves=0 동점 그룹 안 필터) |
| row-value `(a,b,c) < (…)` | 0.03ms | 0.04ms |

- 정렬 인덱스 없이: 첫 페이지도 깊은 페이지도 매번 10만 행 정렬(11~12ms).
- **채택: 정렬 인덱스 + 선행 범위 조건**. row-value가 가장 좋지만 Prisma 쿼리 빌더로 표현할 수 없다.

### 5.3 사용자별 코스 [측정]
`(userId, createdAt)` 인덱스: 헤비 유저 3.7 → **0.57ms**, 일반 유저 3.0 → **0.05ms**. FK라 사용자 삭제 CASCADE에도 쓰인다. **채택**.

### 5.4 유지한 인덱스
`Review(placeId, createdAt)`(0.07ms), `Review(authorId)`(1.6ms), `PostSave(userId, postId)`(0.04ms)는 이미 최적 — 손대지 않음.
후기 정렬에 추가한 id 동점 정리는 기존 인덱스의 역방향 스캔 + Incremental Sort로 처리된다(0.07ms).

### 5.5 실험 중 발견한 함정 — 태그 조건이 만든 "결과 없는 검색" 158ms

(B)를 처음에는 `searchText ILIKE … OR tags @> '{…}'`(태그는 정확일치 유지)로 적용했다. 흔한 검색어는 0.1ms였지만
**드문 검색어(9건)는 165ms, 결과 없는 검색어는 158ms**였다 [측정]:

```
Index Scan Backward using "Post_saves_createdAt_id_idx" on "Post" (rows=510 추정) (actual rows=9)
  Rows Removed by Filter: 99991
```

- 조건별로 나눠 보니 `searchText` 추정은 정확(10행)하고, **`tags @> '{없는값}'`이 500행(0.5%)으로 추정**됐다. PostgreSQL은
  배열 통계(most_common_elems)에 없는 원소에 하한 선택도(0.5%)를 쓴다.
- 510행이면 "담기순 인덱스를 거꾸로 읽다 보면 10건이 금방 찬다"고 판단 → 실제로는 10만 행을 다 읽고 끝났다.
  `ORDER BY … LIMIT`에서 매칭 수를 과대 추정하면 생기는 전형적인 문제다. 결과 없는 검색은 흔한 경우라 방치할 수 없었다.
- 태그 존재 여부를 먼저 확인하는 방법도 같은 500행 추정 때문에 Seq Scan(23ms)이 되어 기각.
- **해결: 태그도 검색 문서에 넣고 태그 조건을 없앴다.** git 기록을 보니 서버 검색 이전 프론트의 `searchPosts`는 태그를
  부분일치로 검색했고, 서버의 정확일치는 "Postgres는 String[] 부분검색을 못 한다"는 우회책이었다. 즉 **원래 제품 동작이 복원**되고,
  태그 GIN 인덱스(568kB)도 필요 없어졌다.
- 결과: 드문 검색어 165 → **0.94ms**, 결과 없음 158 → **0.03ms**(trigram Bitmap Index Scan).

## 6. 쓰기 비용 — pgbench [측정]

`scripts/perf/run-bench.sh` · 8 클라이언트 × 20초. 담기 토글 = 담기 INSERT + 취소 DELETE 한 쌍(트리거가 `Post.saves`를 ±1, 데이터 순변화 0).

| 구성 | 담기 토글 TPS | Post UPDATE 중 HOT | 게시물 작성 TPS | 읽기 혼합 TPS |
|---|---|---|---|---|
| 0. 추가 인덱스 없음 | 4,756 ~ 4,813 | 94.6 ~ 99.5% | 7,995 ~ 8,836 | 180 ~ 184 |
| 3. 정렬(최신)·코스·검색, **saves 없음** | 4,540 ~ 5,946 (중앙값 5,712, n=5) | **99.2 ~ 99.9%** | 6,263 ~ 8,377 | 330 ~ 384 |
| 4. 전부(**saves 포함**) | 3,310 ~ 5,009 (중앙값 4,735, n=5) | **0%** | 7,187 ~ 8,767 | 13,361 ~ 14,720 |

- **saves 인덱스의 대가**: 담기 트리거가 바꾸는 컬럼에 인덱스가 생기면 그 UPDATE는 HOT(같은 페이지 내 갱신, 인덱스 미수정)가
  될 수 없다 → HOT 99% → 0%, 매 담기마다 Post의 모든 인덱스(trigram GIN 포함)에 새 항목. 담기 처리량 중앙값 **약 -17%**
  (짝지은 3회 비교에서 -12%, -16%, -44%; -44%는 이상치로 판단).
- **saves 인덱스의 이득**: 기본 정렬이 담기순이라 읽기 혼합 처리량 **약 37배**(330~384 → 13,361~14,720 TPS).
- 둘러보기는 담기보다 조회가 압도적으로 많으므로 **채택**. 담기 처리량이 병목이 되는 규모가 오면 saves를 별도 집계 테이블로 분리하는
  방안을 검토한다 [추정].
- 게시물 작성 TPS는 측정 편차(6,263~8,837) 안에 묻혀 인덱스 구성 간 차이를 구분할 수 없었다.
- 측정 편차: Docker on Windows 환경이라 같은 구성도 실행마다 ±20% 이상 흔들렸다. 그래서 핵심 비교(3 vs 4)는 번갈아 3회 반복했다.
  측정 중 통합 테스트를 같은 컨테이너에서 돌린 회차(1번 구성 역순 측정, 3,398 TPS)는 오염된 것으로 보고 제외했다.

## 7. 적용 — `migrations/20261109010000_post_search_and_list_indexes`

| 인덱스 | 대상 쿼리 | 크기(10만 행) |
|---|---|---|
| `Post(createdAt, id)` | 최신순 목록·커서 | 5.5MB |
| `Post(saves, createdAt, id)` | 담기순 목록·커서, 검색 목록 정렬 | 6.4MB |
| `Post USING GIN (searchText gin_trgm_ops)` | 검색 | 12MB |
| `Course(userId, createdAt)` | 내 코스 보관함 | 2.0MB |

- 마이그레이션 소요(게시물 10만 건, 단계별 측정 후 ROLLBACK): 백필 1.0초 + trigram GIN 1.5초 + 나머지 각 0.1초 미만 = **약 2.8초**.
  운영 데이터는 작아 그대로 적용 가능. 대량 데이터라면 `CREATE INDEX CONCURRENTLY`로 미리 만들고 resolve.
- 코드: 검색 조건 `searchText contains`(LIKE 와일드카드 이스케이프 포함), 작성·수정 때 `buildSearchText`로 검색 문서 갱신,
  커서 조건에 선행 범위 조건.

## 8. 개선 전후 비교 [측정 — 같은 데이터(체크섬 동일), 각 2회 실행 중 두 번째]

### 8.1 SQL 실행 시간 (`EXPLAIN ANALYZE`)

| # | 쿼리 | 개선 전 | 개선 후 | 개선 후 실행계획 |
|---|---|---|---|---|
| Q1a | 최신순 첫 페이지 | 14.1ms | **0.05ms** | Index Scan Backward |
| Q1b | 최신순 51페이지 | 14.5ms | **0.04ms** | Index Scan Backward + Index Cond |
| Q2a | 담기순 첫 페이지 | 13.7ms | **0.03ms** | Index Scan Backward |
| Q2b | 담기순 51페이지 | 13.5ms | **0.05ms** | Index Scan Backward |
| Q2c | 전체 건수 | 8.6ms | 8.1ms | 변화 없음(유지) |
| Q3a | 검색 목록 '갑천'(2글자) | 480.6ms | **0.13ms** | 담기순 인덱스 + 필터(흔한 검색어) |
| Q3b | 검색 건수 '갑천'(2글자) | 424.2ms | **116.2ms** | Seq Scan(trigram 불가) |
| Q3c | 검색 목록 '한밭수목원' | 415.4ms | **0.10ms** | |
| Q3d | 검색 건수 '한밭수목원' | 414.5ms | **24.5ms** | trigram Bitmap Index Scan |
| Q3e | 검색 목록 드문 검색어(9건) | (개선 전 모양과 동일 비용대) | **0.94ms** | trigram Bitmap Index Scan |
| Q3f | 검색 목록 결과 없음 | — | **0.03ms** | trigram Bitmap Index Scan |
| Q4 | 내 코스(헤비/일반) | 4.2 / 3.4ms | **0.44 / 0.05ms** | Bitmap Index Scan |
| Q5a·Q5b·Q6 | 후기·담기 여부 | 0.05 / 1.1 / 0.03ms | 0.05 / 1.3 / 0.06ms | 변화 없음(유지) |

개선 후 JIT가 켜진 쿼리: **0개**(개선 전 4개 — 검색 목록·건수).

### 8.2 API 응답 (`captureQueries.ts` — 개선 전 1회, 개선 후 3회 범위)

| API | 개선 전 | 개선 후 |
|---|---|---|
| 검색 '갑천' (목록+건수) | 719ms | **107 ~ 112ms** |
| 검색 '벚꽃 피크닉' | 648ms | **16 ~ 21ms** |
| 담기순 첫 페이지 | 16.1ms | **8.3 ~ 8.5ms** |
| 담기순 51페이지 | 12.2ms | **3.3 ~ 4.9ms** |
| 최신순 51페이지 | 12.2ms | **3.3 ~ 4.4ms** |
| 마이탭 후기(1차 개선: 전체 → mine) | 133.6MB · 6.3초 | **1.47MB · 55~60ms** |
| 장소 후기(1차 개선: 전체 → 10개) | 10.5MB · 495ms | **3.9KB · 7.7~8.4ms** |

## 9. 남은 한계

- **2글자 검색의 건수 쿼리**(116ms): trigram은 3글자 미만에 인덱스를 못 쓴다. 한국어는 2글자 검색어가 흔하다.
  대안: `pg_bigm`(Supabase 지원 여부 미확인), 또는 첫 페이지의 정확한 전체 건수 대신 "N건 이상" 표시 [추정].
- **흔한 검색어의 목록 0.1ms는 데이터 분포 덕**: 검색어가 글의 17%에 걸려 담기순 인덱스를 몇십 행만 읽고 10건을 채운다.
  선택도가 중간쯤(예: 0.1%)이고 추정이 크게 틀리면 다시 인덱스를 오래 훑을 수 있다 — 추정이 정확한 지금은 플래너가
  드문 검색어에 trigram을 고른다.
- **검색 문서는 앱이 유지**한다(작성·수정 2곳). 다른 경로로 Post를 쓰면 빈 문자열('')이 되어 검색에 안 걸린다 — 통합 테스트가 두 경로를 지킨다.
- **내 코스 보관함**은 SQL이 1ms 미만이지만 헤비 유저(504개)는 응답 494KB · 약 60ms — 페이지네이션이 없다.
- 운영 Supabase의 JIT·통계 설정은 확인하지 않았다. 기본값(jit=on)이면 개선 전 검색은 운영에서도 같은 JIT 비용을 냈을 것이다 [추정].
- prepared statement의 generic plan은 측정하지 않았다(5회 실행 뒤 generic plan으로 바뀔 수 있음) [미검증].
