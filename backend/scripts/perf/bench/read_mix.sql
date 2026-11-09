-- 읽기 혼합: 목록 첫 페이지(최신·담기순) + 사용자 코스 + 장소 후기
\set u random(1, 10000)
\set pl random(1, 2000)
SELECT id FROM "Post" ORDER BY "createdAt" DESC, id DESC LIMIT 10;
SELECT id FROM "Post" ORDER BY saves DESC, "createdAt" DESC, id DESC LIMIT 10;
SELECT id FROM "Course" WHERE "userId" = 'u' || lpad(:u::text, 8, '0') ORDER BY "createdAt";
SELECT id FROM "Review" WHERE "placeId" = 'place-' || :pl ORDER BY "createdAt" DESC, id DESC LIMIT 10;
