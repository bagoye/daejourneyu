import { useQuery } from "@tanstack/react-query";
import type { PickablePlace } from "@/lib/petTourMapper";
import { apiUrl } from "@/lib/api/authFetch";
import { queryKeys } from "@/lib/queryKeys";

async function fetchPickablePlaces(): Promise<PickablePlace[]> {
  const res = await fetch(apiUrl("/api/places"));
  if (!res.ok) throw new Error("장소 정보를 불러오지 못했어요");
  return (await res.json()) as PickablePlace[];
}

/**
 * backend/scripts/syncPlaces.ts가 9개 공공데이터 소스(관광공사·대전관광공사·식약처·대전시·고캠핑)와
 * 문체부 반려동물 동반가능 시설 현황을 정규화·dedupe해 영속화한 Place 테이블 전체를 가져온다.
 * 예전엔 이 소스들을 개별 훅으로 하나씩 fetch해서 PlacePickerSheet에서 직접 병합했는데
 * (커밋 0b5c8ac), 그 병합이 DB 쪽(syncPlaces.ts)으로 옮겨가서 이제 호출 하나면 된다.
 * enabled: false로 두면 요청을 보내지 않는다 — 바텀시트가 열릴 때만 필요하다.
 */
export function usePickablePlaces(enabled = true) {
  return useQuery({
    queryKey: queryKeys.pickablePlaces.all,
    queryFn: fetchPickablePlaces,
    staleTime: 30 * 60 * 1000,
    retry: 1,
    enabled,
  });
}
