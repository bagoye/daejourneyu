import { create } from "zustand";
import type { CourseSchedule } from "@/types";
import { createScheduleApi, deleteScheduleApi } from "@/lib/api/schedule";

// 코스 목록은 서버가 정본이라 TanStack Query 캐시(useCourses)가 들고 있다. 여기에는 일정만 남아 있다.
interface CourseState {
  /** 코스별 일정(CourseSchedule). 코스와 별개 개념이라 배열도 따로 둔다(루트 CLAUDE.md 도메인 용어). */
  schedules: CourseSchedule[];
  setSchedules: (schedules: CourseSchedule[]) => void;
  /** 코스에 날짜를 붙여 새 일정으로 등록한다(같은 코스도 여러 날짜에 등록 가능). */
  addSchedule: (courseId: string, date: string) => Promise<void>;
  /** 일정 하나를 취소한다(일정 id 기준). */
  removeSchedule: (scheduleId: string) => Promise<void>;
  /** 코스가 지워지면 백엔드에서도 CASCADE로 일정이 같이 지워진다 — 로컬 상태도 맞춘다. */
  removeSchedulesOfCourse: (courseId: string) => void;
}

export const useCourseStore = create<CourseState>((set, get) => ({
  schedules: [],
  // useSchedules()의 react-query 캐시(staleTime 30초)가 저장 이전 스냅샷을 들고 있으면, 저장 직후 다른
  // 화면으로 이동했을 때 이 stale 응답이 방금 addSchedule로 추가한 항목을 통째로 덮어써 지워버린다.
  // 서버 목록에 없는 로컬 항목(막 추가되어 아직 이 캐시엔 안 잡힌 것)은 지우지 않고 같이 들고 있는다.
  setSchedules: (schedules) =>
    set((state) => ({
      schedules: [
        ...schedules,
        ...state.schedules.filter((s) => !schedules.some((server) => server.id === s.id)),
      ],
    })),
  addSchedule: async (courseId, date) => {
    const schedule = await createScheduleApi(courseId, date);
    set({ schedules: [...get().schedules, schedule] });
  },
  removeSchedule: async (scheduleId) => {
    await deleteScheduleApi(scheduleId);
    set({ schedules: get().schedules.filter((s) => s.id !== scheduleId) });
  },
  removeSchedulesOfCourse: (courseId) =>
    set((state) => ({ schedules: state.schedules.filter((schedule) => schedule.courseId !== courseId) })),
}));
