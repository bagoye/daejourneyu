import { useQuery } from "@tanstack/react-query";
import type { Article } from "@/types";
import { mockArticles } from "@/mocks";
import { queryKeys } from "@/lib/queryKeys";

// TODO(api): GET /api/articles 로 교체. 지금은 목데이터를 비동기 흉내만 내어 반환한다.
async function fetchArticles(): Promise<Article[]> {
  return mockArticles;
}

export function useArticles() {
  return useQuery({ queryKey: queryKeys.articles.all, queryFn: fetchArticles });
}

/** 아티클 상세 — 목록 캐시를 그대로 재사용하고 id로 골라낸다. */
export function useArticle(articleId: string) {
  const query = useArticles();
  return {
    ...query,
    data: query.data?.find((article) => article.id === articleId) ?? null,
  };
}
