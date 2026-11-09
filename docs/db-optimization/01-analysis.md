# 01. 기존 구조 및 문제 분석

> 분석 시점: 2026-11-09 · 대상 커밋: `cf2dae3` · 범위: `backend/` (Express 4 + Prisma 6 + PostgreSQL)
>
> 표기 규칙 — **[확인]** 코드 정독으로 확인 · **[재현]** 실제 PostgreSQL 16에서 재현 · **[추정]** 원리상 예측(미검증)

## 1. 데이터 모델 요약

```
users ─┬─< Pet
       ├─< Course ─┬─< CourseDay ─< CourseStop        (일차별 동선, 2차원 배열의 정규화)
       │           ├─< CourseSchedule ─< CourseScheduleFestival
       │           ├─< Post (courseId, SET NULL)
       │           └─< PostSave (courseId, SET NULL)  (담기로 만든 보관함 사본)
       ├─< Post ─┬─< PostStop                         (게시 시점 동선 스냅샷)
       │         └─< PostSave                          (Post.saves = 행 수, 비정규화)
       ├─< PostSave
       └─< Review ─< ReviewTag >─ ReviewTagOption
Place (FK 없음 — 프론트 목데이터와 id 체계가 달라 CourseStop/PostStop/Review.placeId는 문자열 스냅샷)
```

| 정합성 장치 | 위치 |
|---|---|
| `PostSave (userId, postId)` UNIQUE | 같은 글 중복 담기 방지 |
| `CourseDay (courseId, dayIndex)` UNIQUE | 일차 번호 중복 방지 |
| `CourseStop (courseDayId, order)` / `PostStop (postId, order)` UNIQUE | 방문 순서 중복 방지 |
| `ON DELETE CASCADE` | 사용자→모든 소유 데이터, 코스→일차→장소, 글→PostStop·PostSave |
| `ON DELETE SET NULL` | 코스 삭제 시 `Post.courseId`, `PostSave.courseId` (글·담기 기록은 남김) |
| interactive `$transaction` | 코스 PATCH, 담기, 담기 취소 (격리 수준 기본값 READ COMMITTED) |

인덱스: `Pet(userId)`, `Post(userId)`, `Post(courseId)`, `PostSave(postId)`, `CourseSchedule(courseId)`,
`Review(placeId, createdAt)`, `Review(authorId)`, `ReviewTag(tagId)`.
**없는 것**: `Course(userId)`(FK인데 인덱스 없음), 게시물 정렬용, 검색용 → 03에서 실행계획으로 판단.

마이그레이션 9개를 빈 DB에 적용한 결과와 `schema.prisma`의 diff는 **비어 있음**(드리프트 없음).

## 2. 발견한 문제와 우선순위

| # | 우선순위 | 문제 | 근거 | 상태 |
|---|---|---|---|---|
| P0-1 | 최상 | courses/posts/reviews/places의 async 핸들러가 예외를 처리하지 않음 → 요청 무응답 + Unhandled Rejection(Node 기본 동작상 프로세스 종료) | [재현] | **해결** (02 §1) |
| P1-2 | 상 | 담기·취소 동시 요청 시 패배한 요청이 P2002/P2025 예외, 취소↔코스 삭제 교착 | [재현] | **해결** (02 §2) |
| P1-3 | 상 | `Post.saves` 드리프트: 시드가 행 없이 값 기록, 사용자 CASCADE 삭제 시 미감소 | [확인]·[재현] | **해결** (02 §3) |
| P1-4 | 상 | 코스 PATCH 동시 수정 시 유니크 위반, PATCH↔DELETE 교착 | [재현] | **해결** (02 §4) |
| P1-5 | 중 | 후기 목록 페이지네이션 없음, 마이탭이 **전 사용자 후기**를 받아 클라이언트에서 거름, 목록에 base64 사진 포함 | [확인] | 다음 단계 |
| P2-6 | 중 | 게시물 커서 글이 삭제되면 목록이 끝난 것으로 처리(나머지 누락), 담기순은 커서 행 값 변동 시 경계 이동 | [확인]·[추정] | 다음 단계 |
| P2-7 | 중 | 정렬·검색·사용자별 코스 조회용 인덱스 부재 | [추정] | 03에서 측정 |
| P3 | 하 | `nights` 정수 미검증, `.env.example`에 `DIRECT_URL` 누락, 커넥션 풀·트랜잭션 timeout 미설정 | [확인] | `nights`만 해결, 나머지 04 |

## 3. 방식 A(전체 삭제 후 재생성) vs 방식 B(변경분만 갱신) — 코스 동선

| 관점 | A. 삭제 후 재생성 (현행) | B. 부분 UPDATE |
|---|---|---|
| 구현 복잡도 | 낮음 — 입력을 그대로 INSERT | 높음 — 기존 행과 매칭(placeId 중복 가능해 키가 모호), 추가/삭제/이동 분기 |
| 순서 재배치 | 문제 없음 | `order` UNIQUE가 DEFERRABLE이 아니어서 맞바꾸기에 임시 값 경유 2단계 UPDATE 필요 |
| ID 보존 | CourseDay/CourseStop id가 매번 바뀜 | 보존 |
| ID 변경의 영향 | **없음** — API 응답에 id 미노출(`toCourse`), 이 id를 참조하는 FK 없음 | — |
| 쓰기량 | 코스 1개 = 수십 행(일차 수 × 장소 수) | 변경분만 |
| 동시성 | Course 행 잠금 하나로 직렬화 가능 | 행 단위 경합이 더 잘게 쪼개져 추론이 어려움 |

**결론: A 유지.** ID 변경이 외부에 영향이 없고, 행 수가 작아 쓰기 비용 차이가 미미하며(정량 비교는 03에서),
B의 복잡도가 이득보다 크다. 대신 A에 빠져 있던 **행 잠금**을 추가했다(02 §4).

## 4. 테스트 기반 현황

- 기존: supertest + Prisma mock 단위 테스트 70개(통과). 쿼리 인자만 검증 → 잠금·제약·트리거·CASCADE는 검증 불가.
- 추가: `docker-compose.test.yml`(PostgreSQL 16) + `npm run test:int` 통합 테스트. 원격 호스트면 시작 전 중단.
- `prisma dev`(PGlite)는 단일 연결이라 동시 트랜잭션이 직렬화되어 동시성 재현에 부적합 → 별도 컨테이너 사용.
