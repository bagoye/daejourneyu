import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMyBadges } from "@/hooks/useMyBadges";
import { useAuthStore } from "@/stores/useAuthStore";
import { useCourseStore } from "@/stores/useCourseStore";
import { usePetStore } from "@/stores/usePetStore";
import { makeCourse, makePet, makeReview, makeSchedule, makeStop } from "@/test/fixtures";

const hooks = vi.hoisted(() => ({
  useReviews: vi.fn(),
  useMyPosts: vi.fn(),
  usePlaces: vi.fn(),
  useSyncCoursesFromApi: vi.fn(),
  useCourses: vi.fn(),
}));

vi.mock("@/hooks/useReviews", () => ({ useReviews: hooks.useReviews }));
vi.mock("@/hooks/usePosts", () => ({ useMyPosts: hooks.useMyPosts }));
vi.mock("@/hooks/usePlaces", () => ({ usePlaces: hooks.usePlaces }));
vi.mock("@/hooks/useSyncCoursesFromApi", () => ({
  useSyncCoursesFromApi: hooks.useSyncCoursesFromApi,
}));
vi.mock("@/hooks/useCourses", () => ({ NO_COURSES: [], useCourses: hooks.useCourses }));

const reviews = [makeReview({ id: "mine", isMine: true }), makeReview({ id: "other", isMine: false })];

beforeEach(() => {
  vi.clearAllMocks();
  // 일정이 '다녀온' 것인지는 오늘 날짜로 가르므로 날짜만 고정한다.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 14, 12));

  hooks.useReviews.mockReturnValue({ data: reviews });
  hooks.useMyPosts.mockReturnValue({ data: [] });
  hooks.usePlaces.mockReturnValue({ data: [] });

  const course = makeCourse({
    id: "c1",
    days: [
      [
        makeStop({ placeId: "a", district: "유성구" }),
        makeStop({ placeId: "b", district: "동구" }),
        makeStop({ placeId: "c", district: "대덕구" }),
        makeStop({ placeId: "d", district: "서구" }),
      ],
    ],
  });
  hooks.useCourses.mockReturnValue({ data: [course] });
  useCourseStore.setState({
    schedules: [makeSchedule({ courseId: "c1", date: "2026-08-01" })],
  });
  usePetStore.setState({ pets: [makePet()], activePetIndex: 0 });
  useAuthStore.setState({ isLoggedIn: true, hydrated: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useMyBadges", () => {
  it("스토어·훅 데이터를 모아 뱃지를 계산하고 코앞인 뱃지와 문장을 고른다", () => {
    const { result } = renderHook(() => useMyBadges());

    expect(hooks.useMyPosts).toHaveBeenCalledWith("recent", true);
    expect(hooks.useSyncCoursesFromApi).toHaveBeenCalled();

    const { badges, got, gotCount, total, nearest, nearestMessage } = result.current;
    expect(total).toBe(badges.length);
    expect(gotCount).toBe(got.length);
    expect(got.map((badge) => badge.id)).toEqual(
      expect.arrayContaining(["first-owner", "review-king", "first-journey", "pet-profile", "one-day-expedition"])
    );
    // 4개 구를 밟았고 중구 하나만 남았다.
    expect(nearest?.id).toBe("dj-full-round");
    expect(nearestMessage).toBe("중구만 가면 대전 한바퀴 완성");
  });

  it("비로그인이면 내 글을 요청하지 않고 첫 반려인 뱃지도 없다", () => {
    useAuthStore.setState({ isLoggedIn: false });

    const { result } = renderHook(() => useMyBadges());

    expect(hooks.useMyPosts).toHaveBeenCalledWith("recent", false);
    expect(result.current.got.some((badge) => badge.id === "first-owner")).toBe(false);
  });

  it("코앞인 뱃지가 없으면 문장도 비운다", () => {
    hooks.useCourses.mockReturnValue({ data: [] });
    useCourseStore.setState({ schedules: [] });
    usePetStore.setState({ pets: [], activePetIndex: 0 });
    hooks.useReviews.mockReturnValue({ data: [] });

    const { result } = renderHook(() => useMyBadges());

    expect(result.current.nearest).toBeNull();
    expect(result.current.nearestMessage).toBe("");
  });
});
