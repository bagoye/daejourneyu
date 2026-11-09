-- [개선 후] 쿼리 모양: 검색은 searchText 한 컬럼(태그 포함), 커서는 선행 범위 조건 포함. 인덱스는
-- migrations/20261109010000_post_search_and_list_indexes 적용 상태에서 실행한다. 비교 대상은 explain.sql(개선 전).
--
-- 성능 분석 대상 쿼리의 실행계획. 쿼리 본문은 API 호출 시 Prisma가 실제로 보낸 SQL을
-- PostgreSQL 로그(log_min_duration_statement=0)에서 그대로 옮기고, 파라미터만 리터럴로 바꿨다.
-- 컬럼 목록이 길어 SELECT 절만 줄였다(실행계획에 영향 없음 — 정렬·필터·조인 조건은 원문 그대로).
--
--   docker exec -i daejourneyu-test-pg psql -U test -d daejourneyu_perf < scripts/perf/explain.sql
--
-- 주의: Prisma는 prepared statement로 보내므로 운영에서는 generic plan이 쓰일 수 있다.
-- 여기서는 리터럴(custom plan) 기준이며, 차이가 의심되는 쿼리는 문서에 따로 적는다.

\pset pager off
SET max_parallel_workers_per_gather = 2;  -- 기본값 명시(측정 조건 고정)

\echo '=== Q1a 최신순 첫 페이지 ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT "Post"."id", "Post"."caption", "Post"."saves", "Post"."createdAt"
FROM "Post" WHERE 1=1
ORDER BY "Post"."createdAt" DESC, "Post"."id" DESC LIMIT 10 OFFSET 0;

\echo '=== Q1b 최신순 51페이지(값 커서) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT "Post"."id", "Post"."caption", "Post"."saves", "Post"."createdAt"
FROM "Post"
WHERE ("Post"."createdAt" <= '2026-11-07 06:21:21.653' AND ("Post"."createdAt" < '2026-11-07 06:21:21.653' OR ("Post"."createdAt" = '2026-11-07 06:21:21.653' AND "Post"."id" < 'p00086518')))
ORDER BY "Post"."createdAt" DESC, "Post"."id" DESC LIMIT 10 OFFSET 0;

\echo '=== Q2a 담기순 첫 페이지 ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT "Post"."id", "Post"."caption", "Post"."saves", "Post"."createdAt"
FROM "Post" WHERE 1=1
ORDER BY "Post"."saves" DESC, "Post"."createdAt" DESC, "Post"."id" DESC LIMIT 10 OFFSET 0;

\echo '=== Q2b 담기순 51페이지(값 커서) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT "Post"."id", "Post"."caption", "Post"."saves", "Post"."createdAt"
FROM "Post"
WHERE ("Post"."saves" <= 35 AND ("Post"."saves" < 35 OR ("Post"."saves" = 35 AND "Post"."createdAt" < '2026-05-22 09:42:08.448')
       OR ("Post"."saves" = 35 AND "Post"."createdAt" = '2026-05-22 09:42:08.448' AND "Post"."id" < 'p00000420')))
ORDER BY "Post"."saves" DESC, "Post"."createdAt" DESC, "Post"."id" DESC LIMIT 10 OFFSET 0;

\echo '=== Q2c 첫 페이지 전체 건수 ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT COUNT(*) AS "_count$_all" FROM (SELECT "Post"."id" FROM "Post" WHERE 1=1 OFFSET 0) AS "sub";

\echo '=== Q3a 검색 목록 (갑천) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT "Post"."id", "Post"."caption", "Post"."saves", "Post"."createdAt"
FROM "Post"
WHERE ("Post"."searchText" ILIKE '%갑천%')
ORDER BY "Post"."saves" DESC, "Post"."createdAt" DESC, "Post"."id" DESC LIMIT 10 OFFSET 0;

\echo '=== Q3b 검색 건수 (갑천) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT COUNT(*) AS "_count$_all" FROM (SELECT "Post"."id" FROM "Post"
WHERE ("Post"."searchText" ILIKE '%갑천%')
OFFSET 0) AS "sub";

\echo '=== Q3c 검색 목록 (한밭수목원, 3글자 이상) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT "Post"."id", "Post"."caption", "Post"."saves", "Post"."createdAt"
FROM "Post" WHERE ("Post"."searchText" ILIKE '%한밭수목원%')
ORDER BY "Post"."saves" DESC, "Post"."createdAt" DESC, "Post"."id" DESC LIMIT 10 OFFSET 0;

\echo '=== Q3d 검색 건수 (한밭수목원) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT COUNT(*) AS "_count$_all" FROM (SELECT "Post"."id" FROM "Post"
WHERE ("Post"."searchText" ILIKE '%한밭수목원%') OFFSET 0) AS "sub";

\echo '=== Q3e 검색 목록 (드문 검색어 사용자9871, 9건) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT "Post"."id", "Post"."caption", "Post"."saves", "Post"."createdAt"
FROM "Post" WHERE ("Post"."searchText" ILIKE '%사용자9871%')
ORDER BY "Post"."saves" DESC, "Post"."createdAt" DESC, "Post"."id" DESC LIMIT 10 OFFSET 0;

\echo '=== Q3f 검색 목록 (결과 없음) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT "Post"."id", "Post"."caption", "Post"."saves", "Post"."createdAt"
FROM "Post" WHERE ("Post"."searchText" ILIKE '%없는검색어%')
ORDER BY "Post"."saves" DESC, "Post"."createdAt" DESC, "Post"."id" DESC LIMIT 10 OFFSET 0;

\echo '=== Q4 사용자별 코스 목록 (헤비 유저 u00000001) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT "Course"."id", "Course"."label", "Course"."createdAt"
FROM "Course" WHERE "Course"."userId" = 'u00000001'
ORDER BY "Course"."createdAt" ASC OFFSET 0;

\echo '=== Q4c 사용자별 코스 목록 (일반 유저 u00005000) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT "Course"."id", "Course"."label", "Course"."createdAt"
FROM "Course" WHERE "Course"."userId" = 'u00005000'
ORDER BY "Course"."createdAt" ASC OFFSET 0;

\echo '=== Q5a 장소별 후기 첫 페이지 (인기 장소 place-1) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT "Review"."id", "Review"."createdAt", "Review"."authorId"
FROM "Review" WHERE "Review"."placeId" = 'place-1'
ORDER BY "Review"."createdAt" DESC, "Review"."id" DESC LIMIT 10 OFFSET 0;

\echo '=== Q5b 내 후기 (u00000001) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT "Review"."id", "Review"."createdAt"
FROM "Review" WHERE "Review"."authorId" = 'u00000001'
ORDER BY "Review"."createdAt" DESC, "Review"."id" DESC OFFSET 0;

\echo '=== Q6 사용자별 담기 여부 (목록 한 페이지) ==='
EXPLAIN (ANALYZE, BUFFERS)
SELECT "PostSave"."id", "PostSave"."postId" FROM "PostSave"
WHERE ("PostSave"."userId" = 'u00000001'
       AND "PostSave"."postId" IN ('p00000001','p00000002','p00000003','p00000004','p00000005','p00000006','p00000007','p00000009','p00000008','p00000010'))
OFFSET 0;
