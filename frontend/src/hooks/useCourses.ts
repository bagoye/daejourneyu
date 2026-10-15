import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Course } from "@/types";
import {
  createCourseApi,
  deleteCourseApi,
  fetchCourses,
  updateCourseApi,
  type CourseUpdateInput,
} from "@/lib/api/courses";
import { queryKeys } from "@/lib/queryKeys";
import { useAuthStore } from "@/stores/useAuthStore";
import { useCourseStore } from "@/stores/useCourseStore";
import { useToastStore } from "@/stores/useToastStore";

export type CourseInput = Omit<Course, "id">;

/** 서버 응답 전까지 붙이는 임시 id 접두사. 서버 id·목데이터 id와 겹치지 않아야 한다. */
const TEMP_ID_PREFIX = "optimistic-";

const COURSES_KEY = queryKeys.courses.all;

/**
 * 아직 목록이 없을 때 쓰는 빈 배열. `const { data = [] }`처럼 쓰면 렌더마다 새 배열이 생겨 이걸 의존하는
 * useMemo·useEffect가 매번 다시 돈다 — 참조가 고정된 상수를 기본값으로 쓴다.
 */
export const NO_COURSES: Course[] = [];

/**
 * GET /api/courses — 내 코스 보관함. 로그인 전에는 요청하지 않는다.
 *
 * `data === undefined`는 "아직 서버 목록을 한 번도 못 받았다"는 뜻이다. 화면은 이 동안 "불러오는 중…"을
 * 띄워서, 있는 코스를 "찾을 수 없어요"로 오판하지 않는다.
 */
export function useCourses() {
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  return useQuery({ queryKey: COURSES_KEY, queryFn: fetchCourses, enabled: isLoggedIn });
}

/**
 * 코스 mutation이 모두 끝났을 때만 목록을 다시 받는다.
 *
 * 저장 두 개가 동시에 진행 중일 때 먼저 끝난 쪽이 바로 재조회하면, 아직 응답 안 온 나머지 하나의
 * 낙관적 항목이 서버 목록으로 덮여 잠깐 사라졌다가 다시 나타난다. 마지막 하나가 끝날 때 한 번만 받는다.
 */
function invalidateWhenIdle(queryClient: QueryClient) {
  if (queryClient.isMutating({ mutationKey: COURSES_KEY }) === 1) {
    return queryClient.invalidateQueries({ queryKey: COURSES_KEY });
  }
}

/** 실패한 낙관적 변경을 되돌린 뒤 이유를 알린다. 화면이 이미 다른 곳으로 넘어갔어도 보여야 해서 훅에서 띄운다. */
function notifyFailure(message: string) {
  useToastStore.getState().show(`${message}. 잠시 후 다시 시도해주세요`);
}

/**
 * 코스 저장(위저드·챗봇). 누르자마자 보관함에 보이도록 임시 id로 캐시에 먼저 넣고, 응답이 오면
 * 서버 id로 바꿔 끼운다. 실패하면 그 임시 항목만 걷어낸다.
 *
 * `createCourse`는 기존 스토어의 addCourse처럼 **임시 코스를 즉시 돌려준다** — 호출부가 응답을
 * 기다리지 않고 바로 다음 화면으로 넘어가는 흐름을 그대로 유지하기 위해서다.
 */
export function useCreateCourse() {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationKey: COURSES_KEY,
    mutationFn: ({ input }: { tempId: string; input: CourseInput }) => createCourseApi(input),

    onMutate: async ({ tempId, input }) => {
      // 진행 중인 조회가 끝나면서 낙관적 항목을 덮어쓰지 않게 먼저 멈춘다.
      await queryClient.cancelQueries({ queryKey: COURSES_KEY });
      // 목록을 아직 한 번도 안 받았으면 건드리지 않는다. 새 코스 하나만 든 배열을 넣으면 화면이
      // "보관함에 코스가 1개뿐"이라고 믿어버린다 — 어차피 진입하면 서버 목록을 새로 받는다.
      queryClient.setQueryData<Course[]>(COURSES_KEY, (old) => (old ? [...old, { ...input, id: tempId }] : old));
    },

    onSuccess: (serverCourse, { tempId }) => {
      queryClient.setQueryData<Course[]>(COURSES_KEY, (old) =>
        old?.map((course) => (course.id === tempId ? serverCourse : course))
      );
    },

    onError: (_error, { tempId }) => {
      // 스냅샷 전체를 되돌리면 그 사이 끝난 다른 저장까지 지워진다 — 내가 넣은 항목만 뺀다.
      queryClient.setQueryData<Course[]>(COURSES_KEY, (old) => old?.filter((course) => course.id !== tempId));
      notifyFailure("코스 저장에 실패했어요");
    },

    onSettled: () => invalidateWhenIdle(queryClient),
  });

  const { mutate } = mutation;
  const createCourse = useCallback(
    (input: CourseInput): Course => {
      const tempId = `${TEMP_ID_PREFIX}${Date.now()}`;
      mutate({ tempId, input });
      return { ...input, id: tempId };
    },
    [mutate]
  );

  return { ...mutation, createCourse };
}

/** 코스 편집(이름·이모지·장소). 저장을 누르면 바로 반영하고, 실패하면 그 코스만 편집 전으로 되돌린다. */
export function useUpdateCourse() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: COURSES_KEY,
    mutationFn: ({ courseId, patch }: { courseId: string; patch: CourseUpdateInput }) =>
      updateCourseApi(courseId, patch),

    onMutate: async ({ courseId, patch }) => {
      await queryClient.cancelQueries({ queryKey: COURSES_KEY });
      const previous = queryClient.getQueryData<Course[]>(COURSES_KEY)?.find((course) => course.id === courseId);
      queryClient.setQueryData<Course[]>(COURSES_KEY, (old) =>
        old?.map((course) => (course.id === courseId ? { ...course, ...patch } : course))
      );
      // 롤백에 쓸 값은 onMutate가 돌려준 context로 onError에 전달된다.
      return { previous };
    },

    onError: (_error, { courseId }, context) => {
      const previous = context?.previous;
      if (previous) {
        queryClient.setQueryData<Course[]>(COURSES_KEY, (old) =>
          old?.map((course) => (course.id === courseId ? previous : course))
        );
      }
      notifyFailure("코스 수정에 실패했어요");
    },

    onSettled: () => invalidateWhenIdle(queryClient),
  });
}

/**
 * 코스 삭제. 보관함에서 바로 빼고, 실패하면 원래 자리에 다시 끼운다.
 * 서버에서는 코스가 지워질 때 일정도 CASCADE로 같이 지워지므로 로컬 일정도 맞춘다.
 */
export function useDeleteCourse() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: COURSES_KEY,
    mutationFn: (courseId: string) => deleteCourseApi(courseId),

    onMutate: async (courseId) => {
      await queryClient.cancelQueries({ queryKey: COURSES_KEY });
      const courses = queryClient.getQueryData<Course[]>(COURSES_KEY);
      const index = courses?.findIndex((course) => course.id === courseId) ?? -1;
      const previous = index >= 0 ? courses?.[index] : undefined;

      queryClient.setQueryData<Course[]>(COURSES_KEY, (old) => old?.filter((course) => course.id !== courseId));
      useCourseStore.getState().removeSchedulesOfCourse(courseId);
      return { previous, index };
    },

    onError: (_error, courseId, context) => {
      const previous = context?.previous;
      if (previous) {
        queryClient.setQueryData<Course[]>(COURSES_KEY, (old) => {
          if (!old || old.some((course) => course.id === courseId)) return old;
          const next = [...old];
          next.splice(Math.min(context.index, next.length), 0, previous);
          return next;
        });
      }
      // 같이 걷어낸 일정은 서버 목록을 다시 받아 되살린다.
      void queryClient.invalidateQueries({ queryKey: queryKeys.schedules.all });
      notifyFailure("코스 삭제에 실패했어요");
    },

    onSettled: () => invalidateWhenIdle(queryClient),
  });
}
