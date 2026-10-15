import { useQueries } from "@tanstack/react-query";
import { mapKakaoPlaceToPlace, type ApiKakaoPlace } from "@/lib/kakaoPlaceMapper";
import { apiUrl } from "@/lib/api/authFetch";
import type { PickablePlace } from "@/lib/petTourMapper";
import type { PlaceCategory } from "@/types";
import { queryKeys } from "@/lib/queryKeys";

async function fetchKakaoPlaces(query: string, category: PlaceCategory): Promise<PickablePlace[]> {
  const res = await fetch(apiUrl(`/api/kakao-places?query=${encodeURIComponent(query)}&size=10`));
  if (!res.ok) throw new Error("카카오맵 장소를 불러오지 못했어요");
  const data = (await res.json()) as { places: ApiKakaoPlace[] };
  return data.places
    .map((place) => mapKakaoPlaceToPlace(place, category))
    .filter((place): place is PickablePlace => place !== null);
}

export interface KakaoSearchTarget {
  category: PlaceCategory;
  query: string;
}

/**
 * 여러 카테고리 키워드를 병렬로 카카오맵에 검색한다(전체 카테고리 볼 때는 5개 동시 조회).
 * 정부 공공데이터가 빈약한 구역/카테고리 조합을 보완하는 실시간 소스.
 * targets가 비어있거나 enabled=false면 아무 요청도 안 보낸다.
 */
export function useKakaoPlacesMulti(targets: KakaoSearchTarget[], enabled: boolean) {
  const results = useQueries({
    queries: targets.map((target) => ({
      queryKey: queryKeys.kakaoPlaces.search(target.query, target.category),
      queryFn: () => fetchKakaoPlaces(target.query, target.category),
      enabled: enabled && target.query.trim().length > 0,
      staleTime: 30 * 60 * 1000,
      retry: 1,
    })),
  });

  // 카테고리를 5개 병렬로 검색하면 같은 업체가 여러 검색어(예: "공원"과 "관광명소")에 동시에 걸려
  // 중복으로 들어올 수 있다 — id 기준으로 한 번만 남긴다(먼저 매칭된 카테고리를 우선한다).
  const places: PickablePlace[] = [];
  const seenIds = new Set<string>();
  for (const result of results) {
    for (const place of result.data ?? []) {
      if (seenIds.has(place.id)) continue;
      seenIds.add(place.id);
      places.push(place);
    }
  }

  return {
    places,
    isLoading: results.some((result) => result.isLoading),
  };
}
