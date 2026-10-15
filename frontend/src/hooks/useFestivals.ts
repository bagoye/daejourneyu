import { useQuery } from "@tanstack/react-query";
import type { FestivalEvent } from "@/types";
import { apiUrl } from "@/lib/api/authFetch";
import { mockFestivals } from "@/mocks";
import { queryKeys } from "@/lib/queryKeys";

interface FestivalApiItem {
  id: string;
  title: string;
  date: string;
  endDate: string;
  place: string;
  address: string;
  lat: number | null;
  lng: number | null;
  imageUrl: string | null;
  tel: string | null;
  webUrl: string | null;
  venuePetFriendly: boolean;
  venuePlaceName: string | null;
}

function buildCondition(item: FestivalApiItem): string | undefined {
  if (!item.venuePetFriendly) return undefined;
  const place = item.venuePlaceName ? `${item.venuePlaceName}(반려동반 인증 장소)` : "반려동반 인증 장소";
  return `${place} 인근에서 열려요 · 행사 자체의 동반 규정은 주최 측에 별도로 확인해주세요`;
}

async function fetchGeneralFestivals(): Promise<FestivalEvent[]> {
  const res = await fetch(apiUrl("/api/festivals"));
  if (!res.ok) throw new Error("축제 정보를 불러오지 못했어요");
  const data = (await res.json()) as { festivals: FestivalApiItem[] };
  return data.festivals.map((item) => ({
    id: `festival-${item.id}`,
    date: item.date,
    endDate: item.endDate !== item.date ? item.endDate : undefined,
    title: item.title,
    place: item.place,
    petFriendly: false,
    petFriendlyUnknown: true,
    venuePetFriendly: item.venuePetFriendly,
    condition: buildCondition(item),
    webUrl: item.webUrl ?? undefined,
  }));
}

/**
 * 축제 캘린더용 데이터. 일반 축제는 한국관광공사 KorService2 searchFestival2(대전)로 실시간 연동한다.
 * TODO(api): 반려동물 동반가능 축제는 검증된 공공데이터가 없어 mock을 그대로 쓴다.
 */
export function useFestivals() {
  const petFriendlyMock = mockFestivals.filter((festival) => festival.petFriendly);
  const query = useQuery({
    queryKey: queryKeys.festivals.general,
    queryFn: fetchGeneralFestivals,
    staleTime: 60 * 60 * 1000,
    retry: 1,
  });

  return {
    ...query,
    data: [...petFriendlyMock, ...(query.data ?? [])],
  };
}
