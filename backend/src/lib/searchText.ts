/**
 * 게시물 검색 문서(Post.searchText). 필드 사이를 줄바꿈으로 이어, 한 줄짜리 검색어가 두 필드에 걸쳐
 * 매칭되지 않게 한다(필드별로 따로 부분일치하던 예전 결과와 같다).
 *
 * 글을 쓰는 모든 경로(라우터의 작성·수정, prisma/seed.ts)가 이 함수 하나를 쓴다 — 경로마다 따로 만들면
 * 한 곳이 빠졌을 때 그 글만 검색에 안 걸린다(시드에서 실제로 빠졌던 적이 있어 공용으로 뺐다).
 * 형식은 migrations/20261109010000_post_search_and_list_indexes의 백필 SQL과 같다.
 */
export function buildSearchText(
  post: { caption: string; text: string; authorName: string; tags: string[] },
  stops: { name: string; district: string }[]
): string {
  return [
    post.caption,
    post.text,
    post.authorName,
    ...post.tags,
    ...stops.flatMap((s) => [s.name, s.district]),
  ].join("\n");
}
