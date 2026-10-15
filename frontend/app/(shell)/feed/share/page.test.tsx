import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/useAuthStore";
import { usePetStore } from "@/stores/usePetStore";
import { useToastStore } from "@/stores/useToastStore";
import {
  makeApiPost,
  makeCourse,
  makePet,
  makePost,
  makeStop,
  makeUser,
  PET_TYPE_NAME,
} from "@/test/fixtures";
import CourseShareToFeedPage from "./page";

const nav = vi.hoisted(() => ({ replace: vi.fn(), back: vi.fn(), courseId: "course-1" as string | null }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, back: nav.back, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.courseId ? `courseId=${nav.courseId}` : ""),
}));

const hooks = vi.hoisted(() => ({
  useMyPosts: vi.fn(),
  useCreatePost: vi.fn(),
  mutateAsync: vi.fn(),
  useCourses: vi.fn(),
}));
vi.mock("@/hooks/usePosts", () => ({
  useMyPosts: hooks.useMyPosts,
  useCreatePost: hooks.useCreatePost,
}));
vi.mock("@/hooks/useCourses", () => ({ useCourses: hooks.useCourses }));

const course = makeCourse({
  id: "course-1",
  label: "갑천 1박 코스",
  nights: 1,
  days: [
    [makeStop({ placeId: "a", district: "유성구" })],
    [makeStop({ placeId: "b", district: "서구" })],
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  nav.courseId = "course-1";
  hooks.useMyPosts.mockReturnValue({ data: [] });
  hooks.useCreatePost.mockReturnValue({ mutateAsync: hooks.mutateAsync, isPending: false });

  useAuthStore.setState({ isLoggedIn: true, hydrated: true, user: makeUser({ nickname: "콩이 보호자" }) });
  usePetStore.setState({
    pets: [makePet({ emoji: "🐶", mbti: { code: "ENFP", name: PET_TYPE_NAME, theme: "산책", traits: [] } })],
    activePetIndex: 0,
  });
  hooks.useCourses.mockReturnValue({ data: [course] });
  useToastStore.setState({ message: null, key: 0 });
});

describe("코스 자랑하기 — 진입 조건", () => {
  it("세션 복구 전에는 불러오는 중으로 둔다", () => {
    useAuthStore.setState({ hydrated: false });
    render(<CourseShareToFeedPage />);

    expect(screen.getByText("불러오는 중…")).toBeTruthy();
  });

  it("비로그인이면 로그인으로 보낸다", () => {
    useAuthStore.setState({ isLoggedIn: false, user: null });
    render(<CourseShareToFeedPage />);

    expect(screen.getByText("로그인이 필요해요")).toBeTruthy();
    expect(screen.getByText("로그인하러 가기").closest("a")?.getAttribute("href")).toBe(
      "/onboarding/login?next=/schedule/vault"
    );
    expect(hooks.useMyPosts).toHaveBeenCalledWith("recent", false);
  });

  it("주소의 코스를 못 찾으면 보관함으로 안내한다", () => {
    nav.courseId = "no-such-course";
    render(<CourseShareToFeedPage />);

    expect(screen.getByText("자랑할 코스를 찾지 못했어요")).toBeTruthy();
    expect(screen.getByText("코스 보관함 열기").closest("a")?.getAttribute("href")).toBe("/schedule/vault");
  });

  it("이미 자랑한 코스면 다시 올리지 못하게 하고 올린 글로 보낸다", () => {
    hooks.useMyPosts.mockReturnValue({ data: [makePost({ id: "post-9", courseId: "course-1" })] });
    render(<CourseShareToFeedPage />);

    expect(screen.getByText("이미 자랑한 코스예요")).toBeTruthy();
    expect(screen.getByText("올린 글 보러 가기").closest("a")?.getAttribute("href")).toBe("/feed/post/post-9");
    expect(screen.queryByRole("button", { name: "둘러보기에 올리기" })).toBeNull();
  });
});

describe("코스 자랑하기 — 올리기", () => {
  it("코스를 확인시키고, 한마디와 함께 올리면 새 글로 갈아끼워 이동한다", async () => {
    hooks.mutateAsync.mockResolvedValue(makeApiPost({ id: "new-post" }));
    const user = userEvent.setup();
    render(<CourseShareToFeedPage />);

    expect(screen.getByText("갑천 1박 코스")).toBeTruthy();

    await user.type(screen.getByRole("textbox"), "  마당이 넓어요  ");
    await user.click(screen.getByRole("button", { name: "둘러보기에 올리기" }));

    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/feed/post/new-post"));
    expect(hooks.mutateAsync).toHaveBeenCalledWith({
      caption: "갑천 1박 코스",
      text: "마당이 넓어요",
      stops: course.days.flat(),
      tags: ["1박 2일", "유성구", "서구"],
      authorName: "콩이 보호자",
      authorEmoji: "🐶",
      petTypeName: PET_TYPE_NAME,
      courseId: "course-1",
    });
    expect(useToastStore.getState().message).toBe("둘러보기에 코스를 자랑했어요");
  });

  it("닉네임·반려동물이 없으면 기본 작성자 정보로 올린다", async () => {
    useAuthStore.setState({ user: null });
    usePetStore.setState({ pets: [] });
    hooks.mutateAsync.mockResolvedValue(makeApiPost({ id: "new-post" }));
    render(<CourseShareToFeedPage />);

    await userEvent.setup().click(screen.getByRole("button", { name: "둘러보기에 올리기" }));

    await waitFor(() => expect(hooks.mutateAsync).toHaveBeenCalled());
    expect(hooks.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ authorName: "나", authorEmoji: "🐾", petTypeName: "여행 유형 미검사" })
    );
  });

  it("실패하면 토스트로 알리고 화면에 머문다", async () => {
    hooks.mutateAsync.mockRejectedValue(new Error("fail"));
    render(<CourseShareToFeedPage />);

    await userEvent.setup().click(screen.getByRole("button", { name: "둘러보기에 올리기" }));

    await waitFor(() =>
      expect(useToastStore.getState().message).toBe("올리지 못했어요. 잠시 후 다시 시도해주세요")
    );
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("올리는 중에는 버튼을 막는다", () => {
    hooks.useCreatePost.mockReturnValue({ mutateAsync: hooks.mutateAsync, isPending: true });
    render(<CourseShareToFeedPage />);

    expect((screen.getByRole("button", { name: "올리는 중…" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
