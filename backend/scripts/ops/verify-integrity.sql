-- 데이터 정합성 점검 — 백업 복원 직후, 마이그레이션 적용 후, 장애 복구 후에 돌린다. 읽기 전용(마지막 기능 점검만
-- 트랜잭션 안에서 쓰고 ROLLBACK).
--
--   docker exec -i daejourneyu-test-pg psql -U test -d <DB> -At -F '|' < scripts/ops/verify-integrity.sql
--
-- 같은 DB 두 개(원본·복원본)의 출력을 diff 해서 한 줄도 다르지 않으면 통과다. 위반 항목은 0이어야 한다.

\pset footer off

\echo '## 1. 테이블별 행 수'
SELECT 'users', count(*) FROM users UNION ALL
SELECT 'pets', count(*) FROM pets UNION ALL
SELECT 'Course', count(*) FROM "Course" UNION ALL
SELECT 'CourseDay', count(*) FROM "CourseDay" UNION ALL
SELECT 'CourseStop', count(*) FROM "CourseStop" UNION ALL
SELECT 'CourseSchedule', count(*) FROM "CourseSchedule" UNION ALL
SELECT 'Post', count(*) FROM "Post" UNION ALL
SELECT 'PostStop', count(*) FROM "PostStop" UNION ALL
SELECT 'PostSave', count(*) FROM "PostSave" UNION ALL
SELECT 'Review', count(*) FROM "Review" UNION ALL
SELECT 'ReviewTag', count(*) FROM "ReviewTag" UNION ALL
SELECT 'ReviewTagOption', count(*) FROM "ReviewTagOption"
ORDER BY 1;

\echo '## 2. 내용 체크섬(기본키 순) — 값이 하나라도 다르면 바뀐다'
SELECT 'users', md5(string_agg(id || coalesce(email, '') || nickname, ',' ORDER BY id)) FROM users UNION ALL
SELECT 'Course', md5(string_agg(id || "userId" || label || nights, ',' ORDER BY id)) FROM "Course" UNION ALL
SELECT 'CourseStop', md5(string_agg(id || "placeId" || "order", ',' ORDER BY id)) FROM "CourseStop" UNION ALL
SELECT 'Post', md5(string_agg(id || "userId" || saves || "searchText", ',' ORDER BY id)) FROM "Post" UNION ALL
SELECT 'PostSave', md5(string_agg(id || "userId" || "postId", ',' ORDER BY id)) FROM "PostSave" UNION ALL
SELECT 'Review', md5(string_agg(id || "placeId" || "authorId" || coalesce(md5("photoUrl"), ''), ',' ORDER BY id)) FROM "Review"
ORDER BY 1;

\echo '## 3. 업무 규칙 위반(전부 0이어야 함)'
SELECT 'saves 드리프트(Post.saves <> 실제 담기 수)', count(*) FROM (
  SELECT p.id FROM "Post" p LEFT JOIN "PostSave" s ON s."postId" = p.id
  GROUP BY p.id HAVING p.saves <> count(s.id)) d
UNION ALL
SELECT '음수 saves', count(*) FROM "Post" WHERE saves < 0
UNION ALL
SELECT '검색 문서가 빈 글', count(*) FROM "Post" WHERE "searchText" = ''
UNION ALL
SELECT '일차가 없는 코스', count(*) FROM "Course" c WHERE NOT EXISTS (SELECT 1 FROM "CourseDay" d WHERE d."courseId" = c.id)
UNION ALL
SELECT 'nights <> 일차 수 - 1', count(*) FROM "Course" c
  WHERE c.nights <> (SELECT count(*) - 1 FROM "CourseDay" d WHERE d."courseId" = c.id)
UNION ALL
SELECT '방문 장소가 없는 게시물', count(*) FROM "Post" p WHERE NOT EXISTS (SELECT 1 FROM "PostStop" s WHERE s."postId" = p.id)
UNION ALL
SELECT '태그가 없는 후기', count(*) FROM "Review" r WHERE NOT EXISTS (SELECT 1 FROM "ReviewTag" t WHERE t."reviewId" = r.id)
ORDER BY 1;

\echo '## 4. 스키마 객체(복원 누락 확인)'
SELECT 'FK 제약(검증됨)', count(*) FROM pg_constraint WHERE contype = 'f' AND convalidated AND connamespace = 'public'::regnamespace
UNION ALL
SELECT 'FK 제약(미검증)', count(*) FROM pg_constraint WHERE contype = 'f' AND NOT convalidated AND connamespace = 'public'::regnamespace
UNION ALL
SELECT 'CHECK 제약', count(*) FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace
UNION ALL
SELECT '인덱스', count(*) FROM pg_indexes WHERE schemaname = 'public'
UNION ALL
SELECT '유효하지 않은 인덱스', count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
  WHERE NOT i.indisvalid AND c.relnamespace = 'public'::regnamespace
UNION ALL
SELECT '트리거(사용자 정의)', count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace
UNION ALL
SELECT '비활성 트리거', count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  WHERE NOT t.tgisinternal AND t.tgenabled = 'D' AND c.relnamespace = 'public'::regnamespace
UNION ALL
SELECT '확장 pg_trgm', count(*) FROM pg_extension WHERE extname = 'pg_trgm'
UNION ALL
SELECT '적용된 마이그레이션', count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
ORDER BY 1;

\echo '## 5. 기능 점검 — 담기 트리거가 실제로 카운터를 움직이는가(ROLLBACK)'
BEGIN;
SELECT saves AS before FROM "Post" WHERE id = (SELECT min(id) FROM "Post") \gset
INSERT INTO "PostSave" (id, "userId", "postId")
SELECT 'verify-' || gen_random_uuid(), u.id, (SELECT min(id) FROM "Post")
FROM users u
WHERE NOT EXISTS (SELECT 1 FROM "PostSave" s WHERE s."userId" = u.id AND s."postId" = (SELECT min(id) FROM "Post"))
LIMIT 1;
SELECT '트리거 동작(+1이면 정상)', saves - :before FROM "Post" WHERE id = (SELECT min(id) FROM "Post");
ROLLBACK;
