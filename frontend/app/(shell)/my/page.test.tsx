import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/useAuthStore";
import { usePetStore } from "@/stores/usePetStore";
import { useToastStore } from "@/stores/useToastStore";
import { makeBadge, makePet, makeReview, makeUser } from "@/test/fixtures";
import MyPage from "./page";

const nav = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => nav,
  usePathname: () => "/my",
}));

const hooks = vi.hoisted(() => ({ useReviews: vi.fn(), useMyBadges: vi.fn() }));
vi.mock("@/hooks/useReviews", () => ({ useReviews: hooks.useReviews }));
vi.mock("@/hooks/useMyBadges", () => ({ useMyBadges: hooks.useMyBadges }));

const LOGIN_DESCRIPTION = "로그인하면 반려동물 여권과 내 활동을 볼 수 있어요.";
const LOGOUT_DESCRIPTION = "다시 로그인하면 정보가 그대로 남아있어요";

function modalOpen(description: string): boolean {
  return screen.getByText(description).closest(".fixed")?.className.includes("opacity-100") ?? false;
}

function passport(): HTMLElement {
  return screen.getByText("반려동물 여권").closest("button") as HTMLElement;
}

const kongi = makePet({ id: "pet-1", name: "콩이", breed: "말티즈" });
const dubu = makePet({ id: "pet-2", name: "두부", breed: "시바견" });

beforeEach(() => {
  vi.clearAllMocks();
  hooks.useReviews.mockReturnValue({
    data: [makeReview({ id: "r1", isMine: true }), makeReview({ id: "r2", isMine: false })],
  });
  const badges = [
    makeBadge({ id: "first-owner", name: "첫 반려인", got: true, level: 1, current: 1, tileLabel: "가입 완료" }),
    makeBadge({ id: "dj-full-round", name: "대전 한바퀴", current: 4, target: 5, tileLabel: "4/5" }),
  ];
  hooks.useMyBadges.mockReturnValue({
    badges,
    got: [badges[0]],
    gotCount: 1,
    total: 2,
    nearest: makeBadge({ id: "dj-full-round", emoji: "🐾", href: "/map" }),
    nearestMessage: "중구만 가면 대전 한바퀴 완성",
  });

  useAuthStore.setState({ isLoggedIn: true, hydrated: true, user: makeUser() });
  usePetStore.setState({ pets: [kongi, dubu], activePetIndex: 0 });
  useToastStore.setState({ message: null, key: 0 });
});

describe("마이 — 세션 복구 전", () => {
  beforeEach(() => {
    useAuthStore.setState({ isLoggedIn: false, hydrated: false, user: null });
  });

  it("여권을 불러오는 중으로 두고, 눌러도 로그인으로 보내지 않는다", async () => {
    render(<MyPage />);

    expect(screen.getByText("불러오는 중…")).toBeTruthy();
    await userEvent.setup().click(passport());

    expect(modalOpen(LOGIN_DESCRIPTION)).toBe(false);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("로그인·로그아웃 메뉴를 아직 띄우지 않는다", () => {
    render(<MyPage />);

    expect(screen.queryByText("로그인 / 회원가입")).toBeNull();
    // 닫힌 로그아웃 모달은 aria-hidden이라 버튼으로 잡히지 않는다 — 메뉴의 로그아웃도 없어야 한다.
    expect(screen.queryAllByRole("button", { name: "로그아웃" })).toHaveLength(0);
  });
});

describe("마이 — 비로그인", () => {
  beforeEach(() => {
    useAuthStore.setState({ isLoggedIn: false, hydrated: true, user: null });
    usePetStore.setState({ pets: [], activePetIndex: 0 });
  });

  it("여권·후기 메뉴는 로그인 모달을 띄우고, 뱃지와 반려동물 전환은 감춘다", async () => {
    const user = userEvent.setup();
    render(<MyPage />);

    expect(screen.queryByRole("button", { name: "전체 보기 ›" })).toBeNull();
    expect(screen.queryByRole("button", { name: "+ 반려동물 추가" })).toBeNull();
    expect(modalOpen(LOGIN_DESCRIPTION)).toBe(false);

    await user.click(passport());
    expect(modalOpen(LOGIN_DESCRIPTION)).toBe(true);

    await user.click(screen.getByRole("button", { name: "닫기" }));
    await user.click(screen.getByText("내가 쓴 후기"));
    expect(modalOpen(LOGIN_DESCRIPTION)).toBe(true);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("후기 수 대신 화살표만, 하단에는 로그인 / 회원가입 메뉴를 둔다", async () => {
    render(<MyPage />);

    expect(screen.queryByText("1개 ›")).toBeNull();
    await userEvent.setup().click(screen.getByText("로그인 / 회원가입"));
    expect(modalOpen(LOGIN_DESCRIPTION)).toBe(true);
  });
});

describe("마이 — 로그인", () => {
  it("활성 반려동물 여권을 누르면 수정 폼으로 보낸다", async () => {
    render(<MyPage />);

    expect(screen.getByText("말티즈")).toBeTruthy();
    await userEvent.setup().click(passport());

    expect(nav.push).toHaveBeenCalledWith("/onboarding/pet-register?mode=edit&petId=pet-1&from=my");
  });

  it("반려동물이 없으면 여권은 등록 폼으로 보내고 전환 칩은 감춘다", async () => {
    usePetStore.setState({ pets: [], activePetIndex: 0 });
    render(<MyPage />);

    expect(screen.getByText("반려동물 미등록")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "+ 반려동물 추가" })).toBeNull();
    await userEvent.setup().click(passport());

    expect(nav.push).toHaveBeenCalledWith("/onboarding/pet-register?from=my");
  });

  it("전환 칩으로 활성 반려동물을 바꾸고, 추가 칩은 등록 폼으로 보낸다", async () => {
    const user = userEvent.setup();
    render(<MyPage />);

    await user.click(screen.getByRole("button", { name: "두부" }));
    expect(usePetStore.getState().activePetIndex).toBe(1);
    expect(screen.getByText("시바견")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "+ 반려동물 추가" }));
    expect(nav.push).toHaveBeenCalledWith("/onboarding/pet-register?from=my");
  });

  it("뱃지 요약과 남은 거리 줄을 보여주고 각각의 화면으로 보낸다", async () => {
    const user = userEvent.setup();
    render(<MyPage />);

    expect(screen.getByText("콩이의 여행 뱃지")).toBeTruthy();
    expect(screen.getByText("첫 반려인")).toBeTruthy();
    expect(screen.getByText("중구만 가면 대전 한바퀴 완성")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "보러 가기 ›" }));
    expect(nav.push).toHaveBeenLastCalledWith("/map");

    await user.click(screen.getByRole("button", { name: "전체 보기 ›" }));
    expect(nav.push).toHaveBeenLastCalledWith("/my/badges");
  });

  it("내가 쓴 후기 수는 내 후기만 세고, 누르면 후기 목록으로 보낸다", async () => {
    render(<MyPage />);

    expect(screen.getByText("1개 ›")).toBeTruthy();
    await userEvent.setup().click(screen.getByText("내가 쓴 후기"));

    expect(nav.push).toHaveBeenCalledWith("/my/reviews");
  });

  it("알림 설정은 준비 중 토스트를 띄운다", async () => {
    render(<MyPage />);

    await userEvent.setup().click(screen.getByText("알림 설정 · 준비 중"));

    expect(useToastStore.getState().message).toBe("알림 설정은 준비 중이에요");
  });

  it("로그아웃 메뉴는 확인 모달을 연다", async () => {
    render(<MyPage />);
    expect(screen.queryByText("로그인 / 회원가입")).toBeNull();
    expect(modalOpen(LOGOUT_DESCRIPTION)).toBe(false);

    // 메뉴 버튼이 모달 안의 로그아웃 버튼보다 DOM에서 앞에 있다.
    await userEvent.setup().click(screen.getAllByRole("button", { name: "로그아웃" })[0]);

    expect(modalOpen(LOGOUT_DESCRIPTION)).toBe(true);
  });
});
