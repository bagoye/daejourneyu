import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CourseSchedule } from "@/types";
import { createScheduleApi, deleteScheduleApi, fetchSchedulesApi } from "@/lib/api/schedule";
import { invalidateWhenIdle, restoreAt } from "@/lib/optimistic";
import { queryKeys } from "@/lib/queryKeys";
import { useAuthStore } from "@/stores/useAuthStore";

const SCHEDULES_KEY = queryKeys.schedules.all;

/** 서버 응답 전까지 붙이는 임시 id 접두사. */
const TEMP_ID_PREFIX = "optimistic-schedule-";

/** `const { data = [] }`가 렌더마다 새 배열을 만들지 않도록 쓰는 고정 빈 배열(NO_COURSES와 같은 이유). */
export const NO_SCHEDULES: CourseSchedule[] = [];

/** GET /api/courses/schedules — 내 코스들에 등록된 일정 전체. 로그인 전에는 요청하지 않는다. */
export function useSchedules() {
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  return useQuery({ queryKey: SCHEDULES_KEY, queryFn: fetchSchedulesApi, enabled: isLoggedIn });
}

/**
 * 일정 등록. 캘린더에 바로 찍히도록 임시 id로 먼저 넣고, 응답이 오면 서버 일정으로 바꿔 끼운다.
 * 실패하면 그 항목만 빼고 에러를 그대로 던진다 — 호출부가 mutateAsync를 기다리며 토스트를 띄운다.
 */
export function useCreateSchedule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: SCHEDULES_KEY,
    mutationFn: ({ courseId, date }: { courseId: string; date: string }) => createScheduleApi(courseId, date),

    onMutate: async ({ courseId, date }) => {
      await queryClient.cancelQueries({ queryKey: SCHEDULES_KEY });
      const tempId = `${TEMP_ID_PREFIX}${Date.now()}`;
      queryClient.setQueryData<CourseSchedule[]>(SCHEDULES_KEY, (old) =>
        old ? [...old, { id: tempId, courseId, date, festivalTitles: [] }] : old
      );
      return { tempId };
    },

    onSuccess: (schedule, _variables, context) => {
      queryClient.setQueryData<CourseSchedule[]>(SCHEDULES_KEY, (old) =>
        old?.map((item) => (item.id === context.tempId ? schedule : item))
      );
    },

    onError: (_error, _variables, context) => {
      if (!context) return;
      queryClient.setQueryData<CourseSchedule[]>(SCHEDULES_KEY, (old) =>
        old?.filter((item) => item.id !== context.tempId)
      );
    },

    onSettled: () => invalidateWhenIdle(queryClient, SCHEDULES_KEY),
  });
}

/** 일정 취소. 목록에서 바로 빼고, 실패하면 원래 자리에 되살린 뒤 에러를 호출부로 넘긴다. */
export function useDeleteSchedule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: SCHEDULES_KEY,
    mutationFn: (scheduleId: string) => deleteScheduleApi(scheduleId),

    onMutate: async (scheduleId) => {
      await queryClient.cancelQueries({ queryKey: SCHEDULES_KEY });
      const schedules = queryClient.getQueryData<CourseSchedule[]>(SCHEDULES_KEY);
      const index = schedules?.findIndex((item) => item.id === scheduleId) ?? -1;
      const previous = index >= 0 ? schedules?.[index] : undefined;
      queryClient.setQueryData<CourseSchedule[]>(SCHEDULES_KEY, (old) => old?.filter((item) => item.id !== scheduleId));
      return { previous, index };
    },

    onError: (_error, _scheduleId, context) => {
      if (!context?.previous) return;
      const { previous, index } = context;
      queryClient.setQueryData<CourseSchedule[]>(SCHEDULES_KEY, (old) => restoreAt(old, previous, index));
    },

    onSettled: () => invalidateWhenIdle(queryClient, SCHEDULES_KEY),
  });
}
