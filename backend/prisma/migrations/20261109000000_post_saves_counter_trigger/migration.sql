-- Post.saves(비정규화 카운터)를 PostSave 행의 INSERT/DELETE에 맞춰 DB가 직접 유지한다.
--
-- 왜 트리거인가: 앱 코드의 increment/decrement는 API를 거친 담기·취소만 반영한다. 담은 사용자가 삭제되면
-- PostSave가 ON DELETE CASCADE로 함께 지워지는데, 이 경로에는 앱 코드가 끼어들 수 없어 saves가 실제 행
-- 수보다 커진 채 남는다(통합 테스트로 재현: saves=2, 실제 1). 행이 바뀌는 모든 경로를 덮을 수 있는
-- 곳은 DB뿐이다. Prisma 스키마는 트리거를 표현하지 못하므로 이 SQL이 정본이다.

-- 1) 기존 데이터 보정: 트리거는 "지금 값이 맞다"는 전제에서 증감만 하므로 먼저 실제 행 수로 맞춘다.
UPDATE "Post" AS p
SET "saves" = c.actual
FROM (
  SELECT p2."id", COUNT(s."id")::int AS actual
  FROM "Post" p2
  LEFT JOIN "PostSave" s ON s."postId" = p2."id"
  GROUP BY p2."id"
) AS c
WHERE p."id" = c."id" AND p."saves" <> c.actual;

-- 2) 카운터 유지 트리거. UPDATE "Post" ... SET saves = saves ± 1 은 원자적이라 동시 담기에서도 갱신이
--    유실되지 않는다(Post 행 잠금으로 직렬화).
CREATE OR REPLACE FUNCTION "post_saves_counter"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE "Post" SET "saves" = "saves" + 1 WHERE "id" = NEW."postId";
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    -- 글 자체가 지워지며 CASCADE로 들어온 경우엔 대상 행이 이미 없어 0행 갱신으로 끝난다.
    UPDATE "Post" SET "saves" = "saves" - 1 WHERE "id" = OLD."postId";
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "PostSave_saves_counter"
AFTER INSERT OR DELETE ON "PostSave"
FOR EACH ROW EXECUTE FUNCTION "post_saves_counter"();

-- 3) 방어선: 어떤 버그가 있어도 음수 카운트는 저장되지 않는다.
ALTER TABLE "Post" ADD CONSTRAINT "Post_saves_nonnegative" CHECK ("saves" >= 0);
