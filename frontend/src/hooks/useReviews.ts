import { useMemo } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryKey,
} from "@tanstack/react-query";
import type { Review } from "@/types";
import {
  createReviewApi,
  deleteReviewApi,
  fetchMyReviewsApi,
  fetchPlaceReviewsPageApi,
  type ReviewCreateInput,
  type ReviewPage,
} from "@/lib/api/reviews";
import { invalidateWhenIdle, restoreAt } from "@/lib/optimistic";
import { queryKeys } from "@/lib/queryKeys";
import { dedupeById } from "@/lib/dedupeById";
import { useAuthStore } from "@/stores/useAuthStore";

/**
 * 내가 쓴 후기 전체(GET /api/reviews?mine=true) — 마이탭 요약·뱃지·'내가 쓴 후기' 화면이 같은 캐시를 쓴다.
 * 로그인 전에는 요청하지 않는다(서버가 401을 준다).
 */
export function useMyReviews() {
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  return useQuery({
    queryKey: queryKeys.reviews.mine,
    queryFn: fetchMyReviewsApi,
    enabled: isLoggedIn,
  });
}

/**
 * 장소 상세 후기 — 최신순으로 PLACE_REVIEWS_PAGE_SIZE개씩 이어 받는다(사진이 data URL이라 한 번에 다 받지 않는다).
 * `reviews`는 받은 페이지를 이어 붙이고 id 중복을 걸러낸 목록이다.
 */
export function usePlaceReviews(placeId: string | undefined) {
  const query = useInfiniteQuery({
    queryKey: queryKeys.reviews.place(placeId ?? ""),
    queryFn: ({ pageParam }) => fetchPlaceReviewsPageApi(placeId!, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: Boolean(placeId),
  });

  const reviews = useMemo(
    () => dedupeById((query.data?.pages ?? []).flatMap((page) => page.items)),
    [query.data]
  );

  return { ...query, reviews };
}

/** 후기 작성 — 성공하면 목록 캐시를 통째로 무효화해 장소 상세·마이탭에 바로 반영한다. */
export function useCreateReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ReviewCreateInput) => createReviewApi(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.reviews.all }),
  });
}

/** 후기 캐시는 두 모양이다 — 내 후기(배열)와 장소 후기(무한 스크롤 페이지). */
type ReviewCache = Review[] | InfiniteData<ReviewPage, string | null>;

/** 낙관적으로 뺀 후기 하나가 어느 캐시의 어디(페이지·순서)에 있었는지. 실패하면 이 자리에 되살린다. */
interface RemovedReview {
  key: QueryKey;
  review: Review;
  /** 무한 스크롤 캐시의 페이지 번호. 배열 캐시면 null */
  page: number | null;
  index: number;
}

function locate(cache: ReviewCache, reviewId: string): { page: number | null; index: number; review: Review } | null {
  if (Array.isArray(cache)) {
    const index = cache.findIndex((review) => review.id === reviewId);
    return index >= 0 ? { page: null, index, review: cache[index]! } : null;
  }
  for (let page = 0; page < cache.pages.length; page++) {
    const items = cache.pages[page]!.items;
    const index = items.findIndex((review) => review.id === reviewId);
    if (index >= 0) return { page, index, review: items[index]! };
  }
  return null;
}

function without(cache: ReviewCache, reviewId: string): ReviewCache {
  if (Array.isArray(cache)) return cache.filter((review) => review.id !== reviewId);
  return {
    ...cache,
    pages: cache.pages.map((page) => ({ ...page, items: page.items.filter((review) => review.id !== reviewId) })),
  };
}

function restored(cache: ReviewCache | undefined, removed: RemovedReview): ReviewCache | undefined {
  if (!cache) return cache;
  if (Array.isArray(cache)) return restoreAt(cache, removed.review, removed.index);
  const { page } = removed;
  if (page === null || !cache.pages[page]) return cache;
  // 그 사이 다시 받아져 이미 들어 있으면 그대로 둔다(restoreAt과 같은 규칙)
  if (cache.pages.some((p) => p.items.some((review) => review.id === removed.review.id))) return cache;
  return {
    ...cache,
    pages: cache.pages.map((p, i) =>
      i === page ? { ...p, items: restoreAt(p.items, removed.review, removed.index) ?? p.items } : p
    ),
  };
}

/**
 * 내가 쓴 후기 삭제 — 확인을 누르는 즉시 목록에서 빼고(낙관적 업데이트), 실패하면 되돌린다.
 *
 * 같은 후기를 내 후기 목록 ["reviews", "mine"]과 장소 상세 ["reviews", "place", placeId]가 동시에 들고 있을
 * 수 있어서, 키 하나가 아니라 접두사 `queryKeys.reviews.all`로 후기 캐시 전부를 다룬다.
 *
 * 롤백은 스냅샷 통째로가 아니라 **지운 그 후기만** 원래 자리에 되살린다. 삭제 두 건이 겹쳤을 때 먼저 실패한
 * 쪽이 스냅샷을 통째로 덮으면, 그 사이 성공한 다른 삭제까지 화면에 되살아난다.
 *
 * onError는 되돌리기만 하고 에러를 삼키지 않는다 — 호출부(마이탭 '내가 쓴 후기')가 mutateAsync를
 * await하고 catch에서 실패 토스트를 띄운다.
 */
export function useDeleteReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.reviews.all,
    mutationFn: (reviewId: string) => deleteReviewApi(reviewId),

    onMutate: async (reviewId: string) => {
      // 삭제 직전에 보낸 조회 응답이 늦게 도착해 지운 후기를 다시 채워 넣지 않게 먼저 멈춘다.
      await queryClient.cancelQueries({ queryKey: queryKeys.reviews.all });

      const removed: RemovedReview[] = [];
      for (const [key, cache] of queryClient.getQueriesData<ReviewCache>({ queryKey: queryKeys.reviews.all })) {
        const found = cache ? locate(cache, reviewId) : null;
        if (found) removed.push({ key, ...found });
      }

      // 아직 한 번도 안 받은 캐시(old가 undefined)는 그대로 둔다.
      queryClient.setQueriesData<ReviewCache>({ queryKey: queryKeys.reviews.all }, (old) =>
        old ? without(old, reviewId) : old
      );

      return { removed };
    },

    onError: (_error, _reviewId, context) => {
      for (const entry of context?.removed ?? []) {
        queryClient.setQueryData<ReviewCache>(entry.key, (old) => restored(old, entry));
      }
    },

    // 성공·실패와 무관하게, 진행 중인 삭제가 다 끝나면 서버 목록으로 맞춘다.
    onSettled: () => invalidateWhenIdle(queryClient, queryKeys.reviews.all),
  });
}
