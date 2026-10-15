import { useQuery } from "@tanstack/react-query";
import { fetchReviewTagsApi } from "@/lib/api/reviews";
import { mockReviewTags } from "@/mocks";
import { queryKeys } from "@/lib/queryKeys";

/**
 * 후기 작성 화면의 태그 사전(GET /api/reviews/tags). root CLAUDE.md에 적혀 있듯 로컬 DB는
 * `npm run dev`에 딸려오지 않아 자주 꺼져 있으므로, usePlaces와 동일하게 실패 시 목데이터로
 * 대체해 작성 화면 자체는 항상 볼 수 있게 한다(실제 등록은 서버가 살아있어야 성공한다).
 */
export function useReviewTags() {
  return useQuery({
    queryKey: queryKeys.reviewTags.all,
    queryFn: async () => {
      try {
        return await fetchReviewTagsApi();
      } catch (error) {
        console.warn("[useReviewTags] 실 API 실패 — 목데이터로 대체합니다.", error);
        return mockReviewTags;
      }
    },
    staleTime: 30 * 60 * 1000,
  });
}
