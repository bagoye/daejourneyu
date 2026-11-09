-- 성능 실험용 대량 데이터 생성 — **로컬 성능 DB(daejourneyu_perf) 전용**. 운영·스테이징에서 절대 실행하지 않는다.
--
--   docker exec -i daejourneyu-test-pg psql -U test -d daejourneyu_perf -v scale=1 < scripts/perf/seed-large.sql
--
-- scale=1 기준 목표 규모: 사용자 1만 · 코스 5만 · 코스 일차 약 10만 · 방문 장소 약 30만 · 게시물 10만 ·
-- 게시물 장소 약 30만 · 담기 약 30만 · 후기 10만 · 후기 태그 약 20만. scale=0.1이면 1/10.
--
-- 재현성: setseed()로 random()의 시퀀스를 고정한다. 같은 scale이면 같은 데이터가 나온다
-- (단일 세션에서 순서대로 실행해야 하므로 psql로 파일 전체를 한 번에 흘려 넣는다).
--
-- 주의: LATERAL 서브쿼리가 바깥 행을 참조하지 않으면 PostgreSQL은 그 안의 random()을 한 번만 계산한다
-- (상관 서브쿼리가 아니라고 보고 재사용). 그래서 모든 LATERAL에 바깥 행 참조(WHERE x IS NOT NULL)를 넣었다 —
-- 이게 없으면 게시물 10만 개의 작성자가 전부 한 명이 된다(실제로 겪음).
--
-- 분포는 균등하지 않게 만든다 — 실제 서비스처럼 인기 글·인기 장소·헤비 유저에 쏠리게 해야
-- 실행계획이 "평균"이 아니라 현실적인 선택도를 보고 결정된다.
--   - 코스·게시물 작성자: random()^2 로 앞번호 사용자에 쏠림
--   - 담기 대상 글: random()^3 로 소수 인기 글에 쏠림 → saves 롱테일
--   - 후기 장소: 2,000곳 중 random()^3 로 인기 장소에 쏠림

\if :{?scale}
\else
  \set scale 1
\endif

\timing on
SET client_min_messages = warning;
SELECT setseed(0.42);

-- 이전 데이터 제거(마이그레이션 기록은 유지)
TRUNCATE "ReviewTag", "Review", "ReviewTagOption", "PostSave", "PostStop", "Post",
         "CourseScheduleFestival", "CourseSchedule", "CourseStop", "CourseDay", "Course",
         "pets", "users", "Place" RESTART IDENTITY CASCADE;

-- 규모 계산
CREATE TEMP TABLE cfg AS SELECT
  greatest(1, round(10000  * :scale))::int AS n_users,
  greatest(1, round(50000  * :scale))::int AS n_courses,
  greatest(1, round(100000 * :scale))::int AS n_posts,
  greatest(1, round(300000 * :scale))::int AS n_saves,
  greatest(1, round(100000 * :scale))::int AS n_reviews,
  2000                                      AS n_places;

-- 어휘 사전(검색 선택도를 현실적으로 만들기 위함). 배열로 두고 v.words[1 + floor(random() * n)]처럼
-- 행마다 한 번만 고른다(사전 테이블을 WHERE i = random()으로 고르면 random()이 사전 행마다 다시 평가된다).
CREATE TEMP TABLE v AS SELECT
  ARRAY['유성구','중구','동구','대덕구','서구'] AS districts,
  ARRAY[
  '한밭수목원','유림공원','갑천','대청호','엑스포','보문산','계족산','장태산','성심당','은행동',
  '노은','둔산','도안','관평','신탄진','식장산','뿌리공원','오월드','카페','베이커리',
  '산책','피크닉','야경','벚꽃','단풍','호수','숲길','놀이터','맛집','브런치'] AS words,
  ARRAY[
  '정겹게 달려가는 페스티벌러','여기저기 뛰어다니는 모험견','느긋한 산책가','호기심 많은 탐험가',
  '사교적인 파티견','조용한 집순이','용감한 리더','다정한 껌딱지',
  '활발한 운동선수','신중한 관찰자','장난꾸러기 개구쟁이','차분한 명상가',
  '먹보 미식가','부지런한 아침형','낭만적인 여행가','씩씩한 보디가드'] AS types;

-- 1) 사용자
INSERT INTO users (id, email, nickname, provider, "createdAt", "updatedAt")
SELECT 'u' || lpad(g::text, 8, '0'), 'user' || g || '@perf.local', '사용자' || g, 'local',
       now() - (random() * interval '730 days'), now()
FROM generate_series(1, (SELECT n_users FROM cfg)) g;

-- 2) 장소(후기·코스가 참조하는 placeId 풀)
INSERT INTO "Place" (id, name, category, district, condition, "petFriendly", lat, lng, source, "sourceTier", "updatedAt")
SELECT 'place-' || g,
       (SELECT words FROM v)[1 + g % 30] || ' ' || g,
       (ARRAY['산책','카페','맛집','숙소','놀이터'])[1 + g % 5],
       (SELECT districts FROM v)[1 + g % 5],
       '전 견종 · 목줄 필수', true, 36.3 + random() * 0.1, 127.3 + random() * 0.15, 'perf', 1, now()
FROM generate_series(1, (SELECT n_places FROM cfg)) g;

-- 3) 코스 → 일차(1~3) → 방문 장소(일차당 1~5)
INSERT INTO "Course" (id, label, emoji, nights, transport, source, shared, "createdAt", "userId")
SELECT 'c' || lpad(g::text, 8, '0'),
       (SELECT words FROM v)[1 + (g * 7) % 30] || ' 코스',
       '🐾', 0, (ARRAY['자차','대중교통'])[1 + (random() < 0.3)::int],
       (ARRAY['ai','manual','saved'])[1 + floor(random() * 3)::int], random() < 0.2,
       now() - (random() * interval '365 days'),
       'u' || lpad((1 + floor(power(random(), 2) * (SELECT n_users FROM cfg)))::text, 8, '0')
FROM generate_series(1, (SELECT n_courses FROM cfg)) g;

INSERT INTO "CourseDay" (id, "dayIndex", "courseId")
SELECT c.id || '-d' || d, d, c.id
FROM "Course" c
CROSS JOIN LATERAL (SELECT floor(random() * 3)::int AS n WHERE c.id IS NOT NULL) k
CROSS JOIN LATERAL generate_series(0, k.n) d;

UPDATE "Course" c SET nights = sub.n - 1
FROM (SELECT "courseId", count(*) AS n FROM "CourseDay" GROUP BY "courseId") sub
WHERE sub."courseId" = c.id;

INSERT INTO "CourseStop" (id, "order", "placeId", name, category, district, condition, "petFriendly", "courseDayId")
SELECT d.id || '-s' || s, s, 'place-' || p, '장소 ' || p, '산책',
       (SELECT districts FROM v)[1 + p % 5], '전 견종', true, d.id
FROM "CourseDay" d
CROSS JOIN LATERAL (SELECT floor(random() * 5)::int AS n WHERE d.id IS NOT NULL) k
CROSS JOIN LATERAL generate_series(0, k.n) s
CROSS JOIN LATERAL (SELECT 1 + floor(power(random(), 2) * 2000)::int AS p WHERE s IS NOT NULL) pp;

-- 4) 게시물 → 게시물 장소(1~5)
INSERT INTO "Post" (id, caption, text, tags, "authorName", "authorEmoji", "petTypeName", likes, saves, "createdAt", "userId", "courseId")
SELECT 'p' || lpad(g::text, 8, '0'),
       (SELECT words FROM v)[1 + floor(random() * 30)::int] || ' ' ||
         (SELECT words FROM v)[1 + floor(random() * 30)::int] || ' 코스',
       CASE WHEN random() < 0.6
            THEN (SELECT words FROM v)[1 + floor(random() * 30)::int] || '에서 즐거운 시간을 보냈어요'
            ELSE '' END,
       ARRAY[(ARRAY['당일치기','1박 2일','2박 3일'])[1 + floor(random() * 3)::int],
             (SELECT districts FROM v)[1 + floor(random() * 5)::int]],
       '사용자' || u.k, '🐶',
       (SELECT types FROM v)[1 + floor(random() * 16)::int],
       floor(random() * 50)::int, 0,
       now() - (random() * interval '365 days'),
       'u' || lpad(u.k::text, 8, '0'),
       NULL
FROM generate_series(1, (SELECT n_posts FROM cfg)) g
CROSS JOIN LATERAL (SELECT 1 + floor(power(random(), 2) * (SELECT n_users FROM cfg))::int AS k WHERE g IS NOT NULL) u;

INSERT INTO "PostStop" (id, "order", "placeId", name, category, district, condition, "petFriendly", "postId")
SELECT p.id || '-s' || s, s, 'place-' || pp.n,
       (SELECT words FROM v)[1 + pp.n % 30] || ' ' || pp.n, '산책',
       (SELECT districts FROM v)[1 + pp.n % 5], '전 견종', true, p.id
FROM "Post" p
CROSS JOIN LATERAL (SELECT floor(random() * 5)::int AS n WHERE p.id IS NOT NULL) k
CROSS JOIN LATERAL generate_series(0, k.n) s
CROSS JOIN LATERAL (SELECT 1 + floor(power(random(), 2) * 2000)::int AS n WHERE s IS NOT NULL) pp;

-- 4-1) 검색 문서(20261109010000 마이그레이션 이후 스키마에만 있다). 형식은 그 마이그레이션의 백필과 같다.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Post' AND column_name = 'searchText') THEN
    UPDATE "Post" AS p
    SET "searchText" = concat_ws(E'\n', p."caption", p."text", p."authorName",
      NULLIF(array_to_string(p."tags", E'\n'), ''),
      (SELECT string_agg(t."name" || E'\n' || t."district", E'\n' ORDER BY t."order")
       FROM "PostStop" t WHERE t."postId" = p."id"));
  END IF;
END $$;

-- 5) 담기 — 대량 적재 중에는 카운터 트리거를 끄고, 끝난 뒤 한 번에 보정한다(행마다 UPDATE 30만 번을 피함).
--    보정 SQL은 20261109000000 마이그레이션의 1단계와 같다. 아래 검증 쿼리로 드리프트 0을 확인한다.
ALTER TABLE "PostSave" DISABLE TRIGGER "PostSave_saves_counter";
INSERT INTO "PostSave" (id, "userId", "postId", "createdAt")
SELECT 's' || lpad(g::text, 9, '0'),
       'u' || lpad((1 + floor(random() * (SELECT n_users FROM cfg)))::text, 8, '0'),
       'p' || lpad((1 + floor(power(random(), 3) * (SELECT n_posts FROM cfg)))::text, 8, '0'),
       now() - (random() * interval '365 days')
FROM generate_series(1, (SELECT n_saves FROM cfg)) g
ON CONFLICT ("userId", "postId") DO NOTHING;
ALTER TABLE "PostSave" ENABLE TRIGGER "PostSave_saves_counter";

UPDATE "Post" AS p SET saves = c.actual
FROM (SELECT "postId", count(*)::int AS actual FROM "PostSave" GROUP BY "postId") c
WHERE p.id = c."postId";

-- 6) 후기 태그 사전 · 후기 · 후기 태그(1~3)
INSERT INTO "ReviewTagOption" (id, code, label, category, "sortOrder")
SELECT 'tag-' || g, 'TAG_' || g, '태그 ' || g,
       (ARRAY['PET_CONDITION','ENVIRONMENT','AMENITY','SERVICE','CAUTION'])[1 + g % 5], g
FROM generate_series(1, 25) g;

-- 사진: 5%만 첨부, 약 19KB의 압축이 잘 안 되는 문자열(md5 이어 붙임) — 실제 data URL 응답 크기를 흉내 낸다.
INSERT INTO "Review" (id, "placeId", "placeName", text, "photoUrl", "likesCount", "createdAt", "updatedAt", "authorId")
SELECT 'r' || lpad(g::text, 8, '0'),
       'place-' || pl.n, '장소 ' || pl.n,
       CASE WHEN random() < 0.7 THEN '강아지랑 다녀왔는데 좋았어요. 그늘도 있고 물그릇도 있어요.' ELSE '' END,
       CASE WHEN random() < 0.05
            THEN 'data:image/jpeg;base64,' || (SELECT string_agg(md5(random()::text || x), '') FROM generate_series(1, 600) x)
            ELSE NULL END,
       floor(random() * 20)::int,
       now() - (random() * interval '365 days'), now(),
       'u' || lpad((1 + floor(power(random(), 2) * (SELECT n_users FROM cfg)))::text, 8, '0')
FROM generate_series(1, (SELECT n_reviews FROM cfg)) g
CROSS JOIN LATERAL (SELECT 1 + floor(power(random(), 3) * 2000)::int AS n WHERE g IS NOT NULL) pl;

INSERT INTO "ReviewTag" ("reviewId", "tagId")
SELECT DISTINCT r.id, 'tag-' || (1 + floor(random() * 25)::int)
FROM "Review" r
CROSS JOIN LATERAL (SELECT floor(random() * 3)::int AS n WHERE r.id IS NOT NULL) k
CROSS JOIN LATERAL generate_series(0, k.n) t
ON CONFLICT DO NOTHING;

-- 통계 갱신(실행계획이 실제 분포를 보게)
VACUUM ANALYZE;

-- 결과 요약
SELECT 'users' AS t, count(*) FROM users UNION ALL
SELECT 'Course', count(*) FROM "Course" UNION ALL
SELECT 'CourseDay', count(*) FROM "CourseDay" UNION ALL
SELECT 'CourseStop', count(*) FROM "CourseStop" UNION ALL
SELECT 'Post', count(*) FROM "Post" UNION ALL
SELECT 'PostStop', count(*) FROM "PostStop" UNION ALL
SELECT 'PostSave', count(*) FROM "PostSave" UNION ALL
SELECT 'Review', count(*) FROM "Review" UNION ALL
SELECT 'ReviewTag', count(*) FROM "ReviewTag";

-- 정합성 검증: saves 드리프트가 0이어야 한다
SELECT count(*) AS saves_drift FROM (
  SELECT p.id FROM "Post" p LEFT JOIN "PostSave" s ON s."postId" = p.id
  GROUP BY p.id HAVING p.saves <> count(s.id)) d;

SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size;
