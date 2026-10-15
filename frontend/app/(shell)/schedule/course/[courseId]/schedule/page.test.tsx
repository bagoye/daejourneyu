import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Course, CourseSchedule } from "@/types";
import { makeCourse, makeSchedule } from "@/test/fixtures";
import { api, holdResponse, http, HttpResponse, serverError } from "@/test/msw/handlers";
import { server } from "@/test/msw/server";
import { currentUrl, resetNavigation } from "@/test/navigation";
import { renderWithProviders } from "@/test/render";
import { useAuthStore } from "@/stores/useAuthStore";
import { useToastStore } from "@/stores/useToastStore";
import CourseScheduleAddPage from "./page";

vi.mock("next/navigation", async () => (await import("@/test/navigation")).navigationMock);

/**
 * 일정 추가 — 코스에 날짜를 붙여 일정으로 등록하는 화면.
 * 화면 → useCourses·useSchedules·useCreateSchedule·useDeleteSchedule → fetch → (MSW) 전 구간을 태운다.
 */

/** 서버 DB 역할. */
let courses: Course[];
let schedules: CourseSchedule[];

const renderPage = (courseId = "c1") => renderWithProviders(<CourseScheduleAddPage params={{ courseId }} />);

/** 응답을 기다리는 동안 버튼 이름이 "📅일정 등록하기"라 이모지를 빼고 찾는다. */
const saveButton = () => screen.getByRole("button", { name: /일정 등록하기/ });

/** 처음 목록은 바로 주고, 그 뒤(mutation이 끝나며 일어나는) 재조회 응답은 붙잡아 두는 GET 핸들러. */
function holdSchedulesRefetch() {
  let requests = 0;
  const refetch = holdResponse(() => HttpResponse.json(schedules));
  server.use(
    http.get(api("/api/courses/schedules"), () =>
      ++requests === 1 ? HttpResponse.json(schedules) : refetch.resolver()
    )
  );
  return { release: refetch.release, requests: () => requests };
}

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
  it("로그인하지 않았으면 로그인 안내를 보여준다", () => {
    useAuthStore.setState({ isLoggedIn: false });
    renderPage();

    expect(screen.getByText("일정을 등록하려면 로그인해주세요")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /일정 등록하기/ })).toBeNull();
  });

  it("코스를 불러오는 동안 '불러오는 중…'을 보여주고, 도착하면 코스 이름과 등록된 일정을 보여준다", async () => {
    renderPage();

    expect(screen.getByText("불러오는 중…")).toBeTruthy();
    expect(await screen.findByText("갑천 산책 코스")).toBeTruthy();
    expect(await screen.findByText("📅 2026-10-18")).toBeTruthy();
    // 로딩 중에 "찾을 수 없어요"로 단정하지 않는다.
    expect(screen.queryByText("코스를 찾을 수 없어요")).toBeNull();
  });

  it("코스 목록을 못 불러오면 에러 안내를 보여주고, 다시 시도하면 화면이 나온다", async () => {
    server.use(http.get(api("/api/courses"), serverError, { once: true }));
    const { user } = renderPage();

    expect((await screen.findByRole("alert")).textContent).toContain("코스를 불러오지 못했어요");
    expect(screen.queryByText("코스를 찾을 수 없어요")).toBeNull();

    await user.click(screen.getByRole("button", { name: "다시 시도" }));

    expect(await screen.findByText("갑천 산책 코스")).toBeTruthy();
  });

  it("없는 코스 id면 '코스를 찾을 수 없어요'를 보여준다", async () => {
    renderPage("없는-코스");

    expect(await screen.findByText("코스를 찾을 수 없어요")).toBeTruthy();
  });
});

describe("일정 추가 — 등록", () => {
  it("달력에서 20일을 누르면 선택한 날짜가 바뀐다", async () => {
    const { user } = renderPage();
    await screen.findByText("갑천 산책 코스");
    expect(screen.getByText("📅 선택한 날짜: 2026-10-15")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "20" }));

    expect(screen.getByText("📅 선택한 날짜: 2026-10-20")).toBeTruthy();
  });

  it("등록하면 응답 전에 '등록된 일정'에 먼저 보이고, 성공하면 캘린더로 이동한다", async () => {
    const hold = holdResponse(() => {
      const created = makeSchedule({ id: "s-new", courseId: "c1", date: "2026-10-20" });
      schedules = [...schedules, created];
      return HttpResponse.json(created);
    });
    server.use(http.post(api("/api/courses/:courseId/schedule"), hold.resolver));
    const { user } = renderPage();
    await screen.findByText("📅 2026-10-18");

    await user.click(screen.getByRole("button", { name: "20" }));
    await user.click(saveButton());

    // 낙관적 업데이트: 서버가 아직 답하지 않았는데 목록에 이미 있다.
    expect(await screen.findByText("📅 2026-10-20")).toBeTruthy();
    expect(currentUrl()).toBe("/schedule/course/c1/schedule");

    hold.release();

    await waitFor(() => expect(currentUrl()).toBe("/schedule?tab=calendar&date=2026-10-20"));
    expect(screen.getByRole("status").textContent).toBe("일정을 등록했어요");
  });

  it("등록이 진행되는 동안 등록 버튼이 비활성화된다", async () => {
    const hold = holdResponse(() => HttpResponse.json(makeSchedule({ id: "s-new", courseId: "c1" })));
    server.use(http.post(api("/api/courses/:courseId/schedule"), hold.resolver));
    const { user } = renderPage();
    await screen.findByText("갑천 산책 코스");

    await user.click(saveButton());

    // 중복 클릭으로 같은 일정이 두 번 등록되지 않게 막는다.
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    hold.release();
    await waitFor(() => expect(currentUrl()).toContain("/schedule?tab=calendar"));
  });

  it("등록에 실패하면 먼저 보였던 날짜가 사라지고 실패 토스트가 뜬다", async () => {
    const post = holdResponse(() => serverError());
    server.use(http.post(api("/api/courses/:courseId/schedule"), post.resolver));
    const refetch = holdSchedulesRefetch();
    const { user } = renderPage();
    await screen.findByText("📅 2026-10-18");

    await user.click(screen.getByRole("button", { name: "20" }));
    await user.click(saveButton());
    expect(await screen.findByText("📅 2026-10-20")).toBeTruthy();

    post.release();

    // 롤백만으로 사라진다 — 재조회 응답은 아직 붙잡혀 있다.
    await waitFor(() => expect(screen.queryByText("📅 2026-10-20")).toBeNull());
    expect(screen.getByText("📅 2026-10-18")).toBeTruthy();
    expect(refetch.requests()).toBe(2);

    refetch.release();
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("일정 등록에 실패했어요. 잠시 후 다시 시도해주세요")
    );
    // 실패하면 이 화면에 그대로 남는다.
    expect(currentUrl()).toBe("/schedule/course/c1/schedule");
  });
});

describe("일정 추가 — 취소", () => {
  it("등록된 일정의 '취소'를 누르면 바로 사라지고 취소를 알려준다", async () => {
    const { user } = renderPage();
    await screen.findByText("📅 2026-10-18");

    await user.click(screen.getByRole("button", { name: "취소" }));

    await waitFor(() => expect(screen.queryByText("📅 2026-10-18")).toBeNull());
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("일정을 취소했어요"));
    expect(screen.queryByText("등록된 일정")).toBeNull();
  });

  it("취소에 실패하면 일정이 다시 나타나고 실패 토스트가 뜬다", async () => {
    const remove = holdResponse(() => serverError());
    server.use(http.delete(api("/api/courses/schedule/:scheduleId"), remove.resolver));
    const refetch = holdSchedulesRefetch();
    const { user } = renderPage();
    await screen.findByText("📅 2026-10-18");

    await user.click(screen.getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByText("📅 2026-10-18")).toBeNull());

    remove.release();

    // 재조회 없이 롤백만으로 다시 나타난다.
    expect(await screen.findByText("📅 2026-10-18")).toBeTruthy();
    expect(refetch.requests()).toBe(2);

    refetch.release();
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("일정 취소에 실패했어요. 잠시 후 다시 시도해주세요")
    );
  });
});
