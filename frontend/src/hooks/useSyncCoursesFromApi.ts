import { useEffect } from "react";
import { useCourseStore } from "@/stores/useCourseStore";
import { useSchedules } from "./useSchedules";

/**
 * 스토어의 일정 목록을 백엔드 목록으로 동기화한다. SCHEDULE 탭 안의 진입점(탭 루트/상세/보관함)마다
 * 호출해서, '/schedule'을 거치지 않고 바로 딥링크해도(캘린더·카카오톡 공유 링크 등) 일정이 비어 보이지
 * 않게 한다. 코스 목록은 useCourses()가 캐시에서 바로 읽으므로 여기서 다루지 않는다.
 */
export function useSyncCoursesFromApi() {
  const setSchedules = useCourseStore((state) => state.setSchedules);
  const { data: apiSchedules } = useSchedules();

  useEffect(() => {
    if (apiSchedules) setSchedules(apiSchedules);
  }, [apiSchedules, setSchedules]);
}
