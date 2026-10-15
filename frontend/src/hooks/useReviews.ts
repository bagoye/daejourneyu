import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createReviewApi,
  deleteReviewApi,
  fetchReviewsApi,
  type ReviewCreateInput,
} from "@/lib/api/reviews";
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

/** 내가 쓴 후기 삭제 — 성공하면 목록 캐시를 통째로 무효화해 마이탭·장소 상세에 바로 반영한다. */
export function useDeleteReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reviewId: string) => deleteReviewApi(reviewId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.reviews.all }),
  });
}
