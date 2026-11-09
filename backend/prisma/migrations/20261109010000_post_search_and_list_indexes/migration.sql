-- 둘러보기 목록·검색, 내 코스 보관함 인덱스. 모든 인덱스는 실행계획과 pgbench 측정으로 채택 여부를 정했다
-- (docs/db-optimization/03-query-performance.md). 측정 환경: 사용자 1만·코스 5만·게시물 10만·담기 30만.

-- 1) 검색용 trigram 확장(Supabase 지원 확장). 이미 있으면 그대로 둔다.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2) 검색 문서 컬럼 + 기존 글 백필. 형식은 routes/posts.ts buildSearchText와 같다:
--    caption \n text \n authorName \n (태그)* \n (장소명 \n 자치구)* — 필드 사이를 줄바꿈으로 이어
--    한 줄짜리 검색어가 두 필드에 걸쳐 매칭되지 않게 한다.
--    태그도 부분일치로 넣는다: 서버 검색 이전 프론트(searchPosts)의 동작이 태그 부분일치였고, 정확일치(tags @>)는
--    배열 부분검색이 안 돼서 생긴 우회책이었다. 또 tags @> 조건은 통계에 없는 값을 0.5%(500행)로 과대 추정해
--    "결과 없는 검색"에서 플래너가 담기순 인덱스를 끝까지 훑게 만들었다(158ms).
ALTER TABLE "Post" ADD COLUMN "searchText" TEXT NOT NULL DEFAULT '';

UPDATE "Post" AS p
SET "searchText" = concat_ws(E'\n', p."caption", p."text", p."authorName",
  NULLIF(array_to_string(p."tags", E'\n'), ''),
  (SELECT string_agg(t."name" || E'\n' || t."district", E'\n' ORDER BY t."order")
   FROM "PostStop" t WHERE t."postId" = p."id"));

-- 3) 내 코스 보관함: WHERE userId = ? ORDER BY createdAt. (Seq Scan 4.2ms → 0.46ms, 헤비 유저 기준)
CREATE INDEX "Course_userId_createdAt_idx" ON "Course"("userId", "createdAt");

-- 4) 둘러보기 최신순 / 담기순 + 값 커서. (Seq Scan + top-N 정렬 13~14ms → 인덱스 역방향 스캔 0.04~0.09ms)
--    saves 인덱스는 담기 트리거의 UPDATE를 HOT 불가로 만든다(HOT 99% → 0%, 담기 처리량 중앙값 약 -17%) —
--    기본 정렬이 담기순이라 읽기 이득(읽기 혼합 약 37배)이 커서 채택했다.
CREATE INDEX "Post_createdAt_id_idx" ON "Post"("createdAt", "id");
CREATE INDEX "Post_saves_createdAt_id_idx" ON "Post"("saves", "createdAt", "id");

-- 5) 검색: 검색 문서 하나에 trigram GIN. (Post·PostStop 전체 스캔 + JIT 약 0.4초 → 수 ms)
--    3글자 미만 검색어는 trigram을 쓸 수 없어 Seq Scan이 된다(그래도 단일 컬럼이라 기존보다 빠르다).
CREATE INDEX "Post_searchText_idx" ON "Post" USING GIN ("searchText" gin_trgm_ops);

-- 운영 반영 메모: 위 CREATE INDEX는 테이블 쓰기를 잠근다. 현재 운영 데이터는 작아 문제없지만, 대량 데이터에
-- 적용할 때는 마이그레이션 밖에서 CREATE INDEX CONCURRENTLY로 먼저 만들고 이 파일을 resolve 처리한다.
-- (게시물 10만 건 기준 이 파일 전체 약 2.8초: 백필 1.0초, trigram GIN 1.5초)
