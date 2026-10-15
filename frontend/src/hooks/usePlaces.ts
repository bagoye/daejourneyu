import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { DaejeonDistrict, Place, PlaceCategory } from "@/types";
import { mockPlaces } from "@/mocks";
import { filterPlaces } from "@/lib/placeFilters";
import { apiUrl } from "@/lib/api/authFetch";
import { queryKeys } from "@/lib/queryKeys";

export interface PlacesFilter {
  district?: DaejeonDistrict | null;
  category?: PlaceCategory | null;
  /** syncPlaces.ts가 붙이는 출처 태그(예: "petacp"=문체부 반려동물 동반가능 시설 현황). 특정
   * 소스 하나만 골라야 하는 화면(홈 혼잡도 랜덤 추천 등)에서만 넘긴다. */
  source?: string | null;
}

/**
 * GET /api/places — backend/scripts/syncPlaces.ts로 채운 Place 테이블을 읽는다. 응답에는
 * imageUrl·source·sourceTier가 더 붙지만 화면이 쓰는 필드는 src/types/place.ts와 일치한다.
 * district·category·source를 넘기면 서버 쿼리스트링으로 필터링한다.
 *
 * 홈·지도의 장소 목록은 곧 가는 일정 유무와 무관하게 항상 채워져 있어야 하므로, 백엔드/DB가 안
 * 떠 있어 요청이 실패하면 mockPlaces를 같은 조건으로 걸러 대체한다(에러로 목록을 비우지 않는다).
 * 단, mockPlaces에는 source 구분이 없어 그 조건은 폴백 시 무시된다 — 백엔드가 살아있을 때만
 * 정확히 걸러진다.
 */
async function fetchPlaces(filter: PlacesFilter): Promise<Place[]> {
  const search = new URLSearchParams();
  if (filter.district) search.set("district", filter.district);
  if (filter.category) search.set("category", filter.category);
  if (filter.source) search.set("source", filter.source);
  const query = search.toString();

  try {
    const res = await fetch(apiUrl(`/api/places${query ? `?${query}` : ""}`));
    if (!res.ok) throw new Error(`GET /api/places → ${res.status}`);
    return (await res.json()) as Place[];
  } catch (error) {
    console.warn("[usePlaces] 실 API 실패 — 목데이터로 대체합니다.", error);
    return filterPlaces({ places: mockPlaces, district: filter.district, category: filter.category });
  }
}

export function usePlaces(filter: PlacesFilter = {}) {
  return useQuery({
    queryKey: queryKeys.places.list(filter),
    queryFn: () => fetchPlaces(filter),
    staleTime: 30 * 60 * 1000,
    // 필터를 바꿔 새로 요청하는 동안 직전 목록을 유지해 "불러오는 중…"이 깜빡이지 않게 한다.
    placeholderData: keepPreviousData,
  });
}
