import { useQuery } from "@tanstack/react-query";
import { fetchCourses } from "@/lib/api/courses";
import { useAuthStore } from "@/stores/useAuthStore";
import { queryKeys } from "@/lib/queryKeys";

export function useCourses() {
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  // SCHEDULE 탭 안에서 페이지를 옮겨 다닐 때마다(홈·보관함·코스 상세 등 전부 useSyncCoursesFromApi를 부름)
  // 매번 GET을 다시 쏘면 방금 저장한 코스가 아직 반영 안 된 응답과 경합하기 쉬워진다.
  // staleTime 동안은 캐시를 그대로 쓰고, 코스 생성/수정/삭제 시점에 store가 직접 갱신하므로
  // 실시간성을 잃지 않는다.
  return useQuery({ queryKey: queryKeys.courses.all, queryFn: fetchCourses, enabled: isLoggedIn, staleTime: 30_000 });
}
