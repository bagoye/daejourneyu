# 02. 트랜잭션 · 동시성 검증

> 환경: PostgreSQL 16.15 (Docker, `postgres:16-alpine`), Prisma 6.19.3, Node 24, Windows 11 · 2026-11-09
> 재현 명령: `cd backend && npm run db:test:up && npm run test:int`

모든 "개선 전" 수치는 수정 전 코드에 **같은 통합 테스트**를 돌려 얻었다. "개선 후"는 같은 테스트를
**20회 연속** 실행한 결과다. 교착 횟수는 PostgreSQL 서버 로그(`deadlock detected`)에서 셌다.

## 0. "정상"의 정의 (테스트보다 먼저 정함)

| 상황 | 정상 |
|---|---|
| 같은 사용자 동시 담기 N건 | PostSave 1행, 보관함 사본 1개, saves +1, **모든 요청 200 + 같은 courseId** |
| 같은 사용자 동시 취소 N건 | 행 0, saves −1 한 번, 모든 요청 200 `saved:false` |
| 담기·취소 혼합 | 최종 상태가 어떤 직렬 순서의 결과와 같고 `saves = 실제 행 수` |
| 서로 다른 사용자 M명 담기 | saves +M (갱신 유실 없음) |
| 같은 코스 동시 PATCH N건 | 모두 200, 최종 동선은 보낸 것 중 **정확히 하나와 통째로 같음**(last-writer-wins) |
| PATCH ↔ DELETE | PATCH는 200 또는 404, 500 없음, 고아 행 없음 |
| 트랜잭션 중간 실패 | 요청 전 상태와 완전히 동일 |

"멱등 200"을 택한 이유: 프론트 계약(`savePostApi` 주석 "두 번 눌러도 사본은 하나다(서버가 멱등 처리)")과
일치하고, 클라이언트가 409를 별도로 처리할 필요가 없다.

## 1. async 예외 처리 (P0-1)

**기존 동작**: Express 4는 async 핸들러가 reject한 Promise를 잡지 않는다. `asyncHandler` 래퍼가 이미 있었지만
courses/posts/reviews/places 21개 핸들러에는 적용되지 않았다.

**재현** (`src/routes/asyncErrors.test.ts`, 수정 전):
```
× DB가 끊기면 요청을 붙잡아 두지 않고 500 JSON으로 응답한다   → Timeout of 2000ms exceeded
× 처리 도중 대상이 사라지면(P2025) 404로 응답한다            → Timeout
× 유니크 제약에 걸리면(P2002) 409로 응답한다                 → Timeout
× 깨진 JSON 본문은 500이 아니라 400으로 응답한다              → expected 500 to be 400
Unhandled Rejection: Error: connection refused / PrismaClientKnownRequestError P2025 / P2002
```
Node 15+의 기본값(`--unhandled-rejections=throw`)에서 Unhandled Rejection은 프로세스를 종료시킨다.
즉 아래 모든 동시성 충돌은 **데이터 오류보다 먼저 서버 다운으로** 나타나는 구조였다.

**해결**: 21개 핸들러에 기존 `asyncHandler` 적용 + `lib/errorHandler.ts`로 공통 에러 미들웨어 분리.
경합성 Prisma 오류만 4xx로 매핑(P2025→404, P2002/P2003/P2034→409), body-parser 4xx는 그대로, 나머지 500.

## 2. 담기 / 담기 취소 동시성 (P1-2)

### 개선 전 결과 (실제 측정)

| 시나리오 | 결과 |
|---|---|
| 같은 사용자 동시 담기 10건 | 1~2건 200, **나머지 8~9건 409** (P2002). DB 정합성은 유지(UNIQUE가 막음, 패배 측 사본은 롤백) |
| 같은 사용자 동시 취소 10건 | 1건 200, **9건 404** (P2025 — 두 번째 `delete`가 이미 지워진 행을 지우려 함) |
| 취소 ↔ 보관함 사본 직접 삭제 | **교착(40P01)** 발생, 500 — 전체 실행 중 간헐 재현(단독 15회 실행 시 0회) |
| 담기·취소 무작위 60건 | **24건이 비정상 응답**(409·404) |
| 서로 다른 사용자 20명 | 정상(saves 20) — 원자적 `saves = saves + 1`이 Post 행 잠금으로 직렬화 |

교착 로그:
```
ERROR:  deadlock detected
Process 108: DELETE FROM "Course" WHERE id = $1          ← 취소 트랜잭션 (PostSave 삭제 후 Course 삭제 대기)
Process 123: DELETE FROM "Course" WHERE id = $1          ← 코스 직접 삭제 (FK SET NULL로 PostSave 갱신 대기)
```

| | 1단계 잠금 | 2단계 대기 |
|---|---|---|
| 취소 | PostSave 행 (DELETE) | Course 행 (DELETE) |
| 코스 직접 삭제 | Course 행 (DELETE) | PostSave 행 (`ON DELETE SET NULL` → UPDATE) |

### 원인 분석

"조회 → 없으면 생성"은 READ COMMITTED에서 원자적이지 않다. 두 트랜잭션이 모두 "없음"을 본 뒤 INSERT하고,
늦은 쪽은 유니크 인덱스에서 앞선 쪽 커밋을 기다렸다가 P2002를 받는다. 정합성은 DB 제약이 지켰지만
앱이 그 결과를 해석하지 못했다. 취소 쪽은 `delete`(0행이면 예외)를 써서 같은 문제가 반대로 났다.

### 선택한 해결

| 대안 | 판단 |
|---|---|
| SERIALIZABLE 격리 | 기각 — 직렬화 실패(40001) 재시도 로직이 추가로 필요. UNIQUE + 원자적 UPDATE로 이미 충분 |
| `SELECT … FOR UPDATE`로 선조회 잠금 | 기각 — 아직 없는 행은 잠글 수 없음(담기는 INSERT) |
| Advisory lock (userId, postId) | 기각 — 동작은 하나 DB 제약이 이미 같은 일을 함. 잠금 해제 누락 위험 |
| **UNIQUE 제약을 판정자로, 앱은 P2002를 멱등 응답으로 해석** | **채택** |

- 담기: 빠른 경로(이미 담겼으면 트랜잭션 없이 반환) → 트랜잭션에서 사본 생성 → PostSave INSERT.
  P2002면 사본까지 롤백된 상태이므로 이긴 쪽 결과를 다시 읽어 200으로 반환.
- 사본을 먼저, 기록을 나중에 넣는 이유: 기록 INSERT가 트리거로 Post 행을 잠그므로, 인기 글의 Post 행 잠금 보유 시간을 트랜잭션 끝부분으로 줄인다. 대가로, 동시 중복 요청에서 진 쪽도 사본을 만들었다가 롤백한다(커밋되지 않으므로 외부에는 보이지 않음).
- 취소: **잠금 순서를 Course → PostSave로 통일**(코스 직접 삭제와 같은 순서) + 모든 삭제를 `deleteMany`로(0행이면 정상).
  코스 삭제에 `userId` 조건 추가(남의 코스 삭제 방지).

## 3. `Post.saves` 정합성 (P1-3)

### 개선 전 (실제 측정)
- 시드: 글 2개에 `saves` 12, 5를 기록했지만 PostSave 행은 0 → 시작부터 불일치 **[확인]**
- 담은 사용자 삭제(CASCADE): saves **2**, 실제 행 **1** **[재현]** — 앱 코드가 끼어들 수 없는 경로

### 대안 비교

| 대안 | 장점 | 단점 |
|---|---|---|
| (a) 앱에서 증감 + 주기적 보정 스크립트 | DB 로직 없음 | CASCADE·수동 삭제 시 보정 전까지 틀린 값 노출 |
| **(b) PostSave INSERT/DELETE 트리거** | 모든 경로를 덮음, 앱 코드 단순화 | 로직이 DB에 숨음(Prisma 스키마에 안 보임) → 마이그레이션·스키마 주석으로 명시 |
| (c) 비정규화 제거, 매번 COUNT | 항상 정확 | 담기순 정렬에 인덱스 사용 불가 → 목록 성능 저하 |

**(b) 채택** — `migrations/20261109000000_post_saves_counter_trigger`
1. 기존 드리프트 보정 `UPDATE … FROM (SELECT COUNT …)`
2. `AFTER INSERT OR DELETE ON "PostSave"` 트리거로 `saves ± 1`
3. `CHECK ("saves" >= 0)`

마이그레이션 검증(별도 DB에서 이전 9개 적용 → 드리프트 주입 → 새 마이그레이션 적용):

| 글 | 적용 전 saves | 실제 행 | 적용 후 | 이후 CASCADE 삭제 후 (saves/행) |
|---|---|---|---|---|
| p-inflated | 12 | 0 | 0 | 0 / 0 |
| p-ok | 2 | 2 | 2 | 1 / 1 |
| p-cascade | 2 | 1 | 1 | 0 / 0 |

Prisma diff(`migrate diff --from-url … --to-schema-datamodel`)는 적용 후에도 비어 있다(트리거·CHECK는 Prisma가 관리하지 않음).

> ⚠️ 운영 반영 시: 보정 UPDATE가 스테이징 DB의 시드 글 saves(12, 5)를 실제 행 수(0)로 되돌린다. 의도된 동작이다.

## 4. 코스 PATCH 동시성 (P1-4)

### 개선 전 (실제 측정)

| 시나리오 | 결과 |
|---|---|
| 같은 코스 동시 PATCH 8건 | **7건 실패** — `CourseDay_courseId_dayIndex_key` 유니크 위반(409) |
| PATCH ↔ DELETE | **교착(40P01)**, DELETE가 500 |

동시 PATCH 원인: 뒤 트랜잭션의 `DELETE FROM CourseDay`는 앞 트랜잭션이 지우는 행에서 기다렸다가, 앞 트랜잭션 커밋 후
**문장 시작 시점 스냅샷**으로 재평가하므로 앞 트랜잭션이 새로 넣은 일차를 보지 못한다 → 지울 게 없음 → 자기 일차 INSERT 시 충돌.
UNIQUE 제약 덕분에 일차가 섞이지는 않았다(데이터는 안전, 응답이 실패).

교착 로그:
```
Process 2873: DELETE FROM "Course" WHERE id = $1                 ← DELETE: Course 잠금 → CASCADE로 CourseDay 대기
Process 2872: INSERT INTO "CourseDay" ("id","dayIndex","courseId") ← PATCH: 기존 CourseDay 삭제(잠금) → FK 검사로 Course 대기
```

### 해결
트랜잭션 첫 문장에서 `SELECT id FROM "Course" WHERE id = $1 AND "userId" = $2 FOR UPDATE`.
- 동시 PATCH가 Course 행에서 줄을 서고, 각자 최신 상태를 지우고 다시 쓰므로 last-writer-wins.
- PATCH와 DELETE 모두 Course를 먼저 잡게 되어 잠금 순서가 일치 → 교착 제거.
- 소유자 조건을 잠금 쿼리에 포함 → 사전 확인과 쓰기 사이에 삭제되면 0행 → 404.
- 방식 A(삭제 후 재생성)는 유지 — 근거는 01 §3.

부수 수정: `nights`가 정수가 아니면 400(이전엔 Prisma 오류 → 무응답).

## 5. 개선 후 결과 (20회 연속 실행)

| 지표 | 개선 전 | 개선 후 |
|---|---|---|
| 통합 테스트 16개 | 담기 5개 + 코스 2개 실패 | **20회 × 16개 전부 통과** |
| 교착(40P01) | 재현됨(담기 취소, 코스 PATCH) | **0회** (20회 실행 동안 서버 로그 기준) |
| 동시 중복 담기 10건의 비-200 응답 | 8~9건 | 0건 |
| 동시 취소 10건의 비-200 응답 | 9건 | 0건 |
| 동시 코스 PATCH 8건의 실패 | 7건 | 0건 |
| saves 드리프트(CASCADE) | 1 | 0 |
| 단위 테스트 | 70개 | 79개 |

20회 실행 동안 서버 로그의 `duplicate key … PostSave_userId_postId_key` 656건은 **의도된 경합 패배**이며
전부 멱등 200으로 변환되었다. `injected failure` 60건은 롤백 테스트의 장애 주입이다.

## 6. 남은 한계

- 담기 동시성의 정확성은 UNIQUE 제약에 의존한다 — 제약을 지우는 마이그레이션이 생기면 깨진다(통합 테스트가 감지).
- 인기 글에 서로 다른 사용자의 담기가 몰리면 Post 행 잠금에서 직렬화된다. 처리량 한계는 미측정 **[추정: 담기 트랜잭션 길이에 비례]**.
- 코스 PATCH는 last-writer-wins라 **갱신 유실**(A의 편집을 B가 모르고 덮어씀)은 막지 않는다. 막으려면 `version` 컬럼 + 클라이언트가 버전을 보내는 낙관적 잠금이 필요(API 계약 변경).
- 교착 0회는 이 테스트 시나리오 범위에서의 결과다. 다른 쓰기 경로가 추가되면 잠금 순서(Course → 하위 테이블)를 지켜야 한다.
- 트리거는 PostSave 행 단위로 동작한다. 대량 일괄 삭제 시 행마다 UPDATE가 발생한다(현재 일괄 삭제 경로 없음).
