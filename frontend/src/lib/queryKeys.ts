import type { PostListParams } from "@/lib/api/posts";

/**
 * TanStack Query 키를 한곳에 모은 팩토리.
 *
 * 규칙
 * - 첫 칸은 **도메인 이름**이고, 곧 무효화 단위다. `invalidateQueries({ queryKey: queryKeys.posts.all })`
 *   한 번이면 그 도메인의 목록·상세가 전부 다시 받아진다(키는 접두사로 매칭된다).
 * - 둘째 칸부터는 응답을 가르는 값(필터·id)만 넣는다. 화면 상태(모달 열림 등)는 넣지 않는다.
 * - 같은 데이터를 다른 모양으로 받는 쿼리는 도메인 안에서 `"list"`·`"detail"`로 갈라 둔다.
 * - 훅·컴포넌트에서는 키를 문자열 배열로 직접 쓰지 않는다 — 오타 하나로 무효화가 조용히 빗나간다.
 *   (훅 테스트는 반대로 리터럴로 단언한다. 팩토리가 실수로 키 모양을 바꾸면 거기서 걸리게.)
 */
export const queryKeys = {
  courses: {
    all: ["courses"] as const,
  },
  schedules: {
    all: ["schedules"] as const,
  },
  posts: {
    all: ["posts"] as const,
    list: (params: PostListParams) => ["posts", "list", params] as const,
    detail: (postId: string) => ["posts", "detail", postId] as const,
  },
  reviews: {
    all: ["reviews"] as const,
    /** placeId가 없으면 전체 목록(마이탭이 isMine으로 거른다). */
    list: (placeId?: string) => ["reviews", placeId ?? null] as const,
  },
  reviewTags: {
    all: ["review-tags"] as const,
  },
  places: {
    all: ["places"] as const,
    list: (filter: { district?: string | null; category?: string | null; source?: string | null }) =>
      ["places", filter.district ?? null, filter.category ?? null, filter.source ?? null] as const,
  },
  /** 같은 /api/places지만 응답 타입(PickablePlace)이 달라 캐시를 따로 둔다. */
  pickablePlaces: {
    all: ["pickable-places"] as const,
  },
  kakaoPlaces: {
    search: (query: string, category: string) => ["kakao-places", query, category] as const,
  },
  articles: {
    all: ["articles"] as const,
  },
  festivals: {
    general: ["festivals", "general"] as const,
  },
  weather: {
    current: ["weather"] as const,
  },
};
