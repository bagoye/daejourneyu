-- 게시물 작성(Post 행만). 벤치 후 id LIKE 'bench-%'로 지운다.
\set u random(1, 10000)
INSERT INTO "Post" (id, caption, text, tags, "authorName", "authorEmoji", "petTypeName", "userId", "searchText")
VALUES ('bench-' || gen_random_uuid(), '갑천 벚꽃 코스', '산책하기 좋았어요', ARRAY['당일치기','서구'],
        '사용자' || :u, '🐶', '느긋한 산책가', 'u' || lpad(:u::text, 8, '0'),
        '갑천 벚꽃 코스 산책하기 좋았어요 사용자' || :u || ' 갑천 12 서구 한밭수목원 3 유성구');
