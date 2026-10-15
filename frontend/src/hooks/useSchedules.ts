import { useQuery } from "@tanstack/react-query";
import { fetchSchedulesApi } from "@/lib/api/schedule";
import { useAuthStore } from "@/stores/useAuthStore";
import { queryKeys } from "@/lib/queryKeys";

export function useSchedules() {
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  return useQuery({ queryKey: queryKeys.schedules.all, queryFn: fetchSchedulesApi, enabled: isLoggedIn, staleTime: 30_000 });
}
