import { afterEach, beforeEach, describe, it, vi } from "vitest";
import type { Course, CourseSchedule } from "@/types";
import { makeCourse, makeSchedule } from "@/test/fixtures";
import { api, http, HttpResponse } from "@/test/msw/handlers";
import { server } from "@/test/msw/server";
import { resetNavigation } from "@/test/navigation";
import { useAuthStore } from "@/stores/useAuthStore";
import { useToastStore } from "@/stores/useToastStore";

vi.mock("next/navigation", async () => (await import("@/test/navigation")).navigationMock);

/**
 * ✍️ 직접 작성할 화면 테스트 — 코스에 날짜를 붙여 일정으로 등록하는 화면.
 * 참고 구현: app/(shell)/my/reviews/page.test.tsx (같은 헬퍼·같은 패턴)
 *
 * 렌더: renderWithProviders(<CourseScheduleAddPage params={{ courseId: "c1" }} />)
 *       — import CourseScheduleAddPage from "./page";
 * 달력 날짜 버튼의 이름은 날짜 숫자다: screen.getByRole("button", { name: "20" })
 * 성공하면 화면이 캘린더로 이동한다: currentUrl() (from "@/test/navigation")로 확인
 */

/** 서버 DB 역할. */
let courses: Course[];
let schedules: CourseSchedule[];

beforeEach(() => {
  // "오늘"을 고정해야 달력이 매번 같은 달을 그린다. Date만 가짜로 — 타이머까지 가짜로 하면 userEvent가 멈춘다.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 15, 12)); // 2026-10-15

  resetNavigation("/schedule/course/c1/schedule");
  useAuthStore.setState({ isLoggedIn: true, hydrated: true });
  useToastStore.setState({ message: null, key: 0 });

  courses = [makeCourse({ id: "c1", label: "갑천 산책 코스" })];
  schedules = [makeSchedule({ id: "s1", courseId: "c1", date: "2026-10-18" })];

  server.use(
    http.get(api("/api/courses"), () => HttpResponse.json(courses)),
    http.get(api("/api/courses/schedules"), () => HttpResponse.json(schedules)),
    http.post(api("/api/courses/:courseId/schedule"), async ({ params, request }) => {
      const { date } = (await request.json()) as { date: string };
      const created = makeSchedule({ id: `s-${date}`, courseId: String(params.courseId), date });
      schedules = [...schedules, created];
      return HttpResponse.json(created);
    }),
    http.delete(api("/api/courses/schedule/:scheduleId"), ({ params }) => {
      schedules = schedules.filter((schedule) => schedule.id !== params.scheduleId);
      return new HttpResponse(null, { status: 204 });
    })
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("일정 추가 — 진입", () => {
  it.todo("로그인하지 않았으면 로그인 안내를 보여준다");
  it.todo("코스를 불러오는 동안 '불러오는 중…'을 보여주고, 도착하면 코스 이름과 등록된 일정(2026-10-18)을 보여준다");
  it.todo("코스 목록을 못 불러오면 에러 안내를 보여주고, 다시 시도하면 화면이 나온다");
  it.todo("없는 코스 id면 '코스를 찾을 수 없어요'를 보여준다");
});

describe("일정 추가 — 등록", () => {
  it.todo("달력에서 20일을 누르면 '선택한 날짜: 2026-10-20'으로 바뀐다");
  it.todo("일정 등록하기를 누르면 응답 전에 '등록된 일정'에 그 날짜가 먼저 보이고, 성공하면 캘린더(/schedule?tab=calendar&date=…)로 이동한다");
  it.todo("등록이 진행되는 동안 '일정 등록하기' 버튼이 비활성화된다");
  it.todo("등록에 실패하면 먼저 보였던 날짜가 사라지고 실패 토스트가 뜬다");
});

describe("일정 추가 — 취소", () => {
  it.todo("등록된 일정의 '취소'를 누르면 바로 사라지고 '일정을 취소했어요' 토스트가 뜬다");
  it.todo("취소에 실패하면 일정이 다시 나타나고 실패 토스트가 뜬다");
});
