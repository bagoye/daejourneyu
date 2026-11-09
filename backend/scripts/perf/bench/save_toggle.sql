-- 담기 → 취소 한 쌍(데이터 순변화 0). PostSave 트리거가 Post.saves를 +1, -1 UPDATE 한다.
\set u random(1, 10000)
\set p random(1, 100000)
BEGIN;
INSERT INTO "PostSave" (id, "userId", "postId")
VALUES ('bench-' || :client_id || '-' || :u || '-' || :p, 'u' || lpad(:u::text, 8, '0'), 'p' || lpad(:p::text, 8, '0'))
ON CONFLICT DO NOTHING;
DELETE FROM "PostSave" WHERE id = 'bench-' || :client_id || '-' || :u || '-' || :p;
COMMIT;
