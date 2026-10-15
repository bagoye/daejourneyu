import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import type { Review } from "@/types";
import {
  createReviewApi,
  deleteReviewApi,
  fetchReviewsApi,
  type ReviewCreateInput,
} from "@/lib/api/reviews";
import { invalidateWhenIdle, restoreAt } from "@/lib/optimistic";
import { queryKeys } from "@/lib/queryKeys";

/** GET /api/reviews — placeId를 넘기면 장소 상세용으로 필터링, 안 넘기면 전체(마이탭이 isMine으로 걸러 씀). */
export function useReviews(placeId?: string) {
  return useQuery({
    queryKey: queryKeys.reviews.list(placeId),
    queryFn: () => fetchReviewsApi(placeId),
  });
}

/** 후기 작성 — 성공하면 목록 캐시를 통째로 무효화해 장소 상세·마이탭에 바로 반영한다. */
export function useCreateReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ReviewCreateInput) => createReviewApi(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.reviews.all }),
  });
}

/** 낙관적으로 뺀 후기 하나가 어느 캐시의 몇 번째에 있었는지. 실패하면 이 자리에 되살린다. */
interface RemovedReview {
  key: QueryKey;
  review: Review;
  index: number;
}

/**
 * 내가 쓴 후기 삭제 — 확인을 누르는 즉시 목록에서 빼고(낙관적 업데이트), 실패하면 되돌린다.
 *
 * 같은 후기를 마이탭 전체 목록 ["reviews", null]과 장소 상세 ["reviews", placeId]가 동시에 들고 있을 수
 * 있어서, 키 하나가 아니라 접두사 `queryKeys.reviews.all`로 후기 캐시 전부를 다룬다.
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
      for (const [key, reviews] of queryClient.getQueriesData<Review[]>({ queryKey: queryKeys.reviews.all })) {
        const index = reviews?.findIndex((review) => review.id === reviewId) ?? -1;
        if (reviews && index >= 0) removed.push({ key, review: reviews[index], index });
      }

      // 아직 한 번도 안 받은 캐시(old가 undefined)는 그대로 둔다.
      queryClient.setQueriesData<Review[]>({ queryKey: queryKeys.reviews.all }, (old) =>
        old?.filter((review) => review.id !== reviewId)
      );

      return { removed };
    },

    onError: (_error, _reviewId, context) => {
      for (const { key, review, index } of context?.removed ?? []) {
        queryClient.setQueryData<Review[]>(key, (old) => restoreAt(old, review, index));
      }
    },

    // 성공·실패와 무관하게, 진행 중인 삭제가 다 끝나면 서버 목록으로 맞춘다.
    onSettled: () => invalidateWhenIdle(queryClient, queryKeys.reviews.all),
  });
}
