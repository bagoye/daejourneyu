import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Review } from "@/types";
import { makeReview } from "@/test/fixtures";
import { api, holdResponse, http, HttpResponse, serverError } from "@/test/msw/handlers";
import { server } from "@/test/msw/server";
import { resetNavigation } from "@/test/navigation";
import { useToastStore } from "@/stores/useToastStore";
import { renderWithProviders } from "@/test/render";
import MyReviewsPage from "./page";

vi.mock("next/navigation", async () => (await import("@/test/navigation")).navigationMock);

/**
 * 내가 쓴 후기 — 화면 → useReviews → fetch → (MSW) 전 구간을 그대로 태운다.
 * 훅·API 클라이언트를 mock하지 않으므로, 쿼리키·무효화·낙관적 업데이트가 실제로 맞물려야 통과한다.
 */

const MY_PLACES = ["한밭수목원", "유림공원", "갑천 산책로", "대청호 오백리길", "엑스포 과학공원"];

/** 서버 DB 역할. GET은 이 배열을 돌려주고, DELETE 성공 시 여기서 지운다. */
let db: Review[];

/** "서버가 정상 동작하는" 기본 상태. 실패 시나리오는 테스트 안에서 server.use로 덮어쓴다. */
function useHealthyServer() {
  server.use(
    http.get(api("/api/reviews"), () => HttpResponse.json(db)),
    http.delete(api("/api/reviews/:id"), ({ params }) => {
      db = db.filter((review) => review.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    })
  );
}

beforeEach(() => {
  resetNavigation("/my/reviews");
  // 토스트 스토어는 모듈 전역 상태라 앞 테스트의 문구가 남는다 — 매번 비운다.
  useToastStore.setState({ message: null, key: 0 });
  db = [
    ...MY_PLACES.map((placeName, i) => makeReview({ id: `mine-${i}`, placeName, isMine: true })),
    makeReview({ id: "others", placeName: "남의 단골 카페", isMine: false }),
  ];
  useHealthyServer();
});

describe("내가 쓴 후기 — 목록", () => {
  it("불러오는 동안 안내를 보여주고, 도착하면 내 후기만 보여준다", async () => {
    renderWithProviders(<MyReviewsPage />);

    expect(screen.getByText("불러오는 중…")).toBeTruthy();
    // findBy*는 나타날 때까지 기다린다 — 응답이 오기 전과 후를 사용자가 보는 순서대로 확인한다.
    expect(await screen.findByText("한밭수목원")).toBeTruthy();
    expect(screen.queryByText("불러오는 중…")).toBeNull();
    expect(screen.queryByText("남의 단골 카페")).toBeNull();
  });

  it("처음 불러오기에 실패하면 에러 안내를 보여주고, 다시 시도하면 목록이 나온다", async () => {
    // once: 첫 요청만 500. 다시 시도한 두 번째 요청은 beforeEach의 정상 핸들러가 받는다.
    server.use(http.get(api("/api/reviews"), serverError, { once: true }));
    const { user } = renderWithProviders(<MyReviewsPage />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("후기를 불러오지 못했어요");
    // 실패를 "후기가 없다"로 보여주지 않는다.
    expect(screen.queryByText(/아직 작성한 후기가 없어요/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "다시 시도" }));

    expect(await screen.findByText("한밭수목원")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("내 후기가 없으면 작성 안내를 보여준다", async () => {
    db = [makeReview({ id: "others", isMine: false })];
    renderWithProviders(<MyReviewsPage />);

    expect(await screen.findByText(/아직 작성한 후기가 없어요/)).toBeTruthy();
  });

  it("한 페이지에 4개씩 보여주고, 다음 페이지로 넘길 수 있다", async () => {
    const { user } = renderWithProviders(<MyReviewsPage />);
    await screen.findByText("한밭수목원");
    expect(screen.queryByText("엑스포 과학공원")).toBeNull();

    await user.click(screen.getByRole("button", { name: "다음 페이지" }));

    expect(screen.getByText("엑스포 과학공원")).toBeTruthy();
    expect(screen.queryByText("한밭수목원")).toBeNull();
  });
});

describe("내가 쓴 후기 — 삭제", () => {
  it("확인 창에서 취소하면 아무것도 지우지 않는다", async () => {
    let deleteRequests = 0;
    server.use(
      http.delete(api("/api/reviews/:id"), () => {
        deleteRequests++;
        return new HttpResponse(null, { status: 204 });
      })
    );
    const { user } = renderWithProviders(<MyReviewsPage />);

    await user.click(await screen.findByRole("button", { name: "한밭수목원 후기 삭제" }));
    // 모달은 닫혀 있어도 DOM에 남아 있지만, aria-hidden이라 열렸을 때만 dialog로 잡힌다.
    const dialog = screen.getByRole("dialog", { name: "이 후기를 삭제할까요?" });
    expect(dialog).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "취소" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("한밭수목원")).toBeTruthy();
    expect(deleteRequests).toBe(0);
  });

  it("삭제하기를 누르면 응답 전에 바로 목록에서 빠지고, 성공하면 알려준다", async () => {
    // 응답을 붙잡아 둬서 "서버가 아직 답하지 않은 순간"의 화면을 확인한다.
    const hold = holdResponse(() => {
      db = db.filter((review) => review.id !== "mine-0");
      return new HttpResponse(null, { status: 204 });
    });
    server.use(http.delete(api("/api/reviews/:id"), hold.resolver));
    const { user } = renderWithProviders(<MyReviewsPage />);

    await user.click(await screen.findByRole("button", { name: "한밭수목원 후기 삭제" }));
    await user.click(screen.getByRole("button", { name: "삭제하기" }));

    // 낙관적 업데이트: 서버 응답 전인데도 이미 사라져 있다.
    await waitFor(() => expect(screen.queryByText("한밭수목원")).toBeNull());
    expect(screen.getByRole("status").textContent).toBe("");

    hold.release();

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("후기를 삭제했어요"));
    // 재조회 뒤에도(서버에서도 지워졌으니) 다시 나타나지 않는다.
    expect(screen.queryByText("한밭수목원")).toBeNull();
    expect(screen.getByText("유림공원")).toBeTruthy();
  });

  it("삭제에 실패하면 지웠던 후기가 다시 나타나고 실패를 알려준다", async () => {
    const hold = holdResponse(() => serverError());
    // 실패 뒤 onSettled가 목록을 다시 받는데, 그 응답은 끝까지 붙잡아 둔다. 그래야 후기가 "재조회 덕분"이
    // 아니라 롤백만으로 되살아나는지 확인된다(이걸 안 하면 롤백 코드를 지워도 이 테스트가 통과한다).
    let listRequests = 0;
    const refetch = holdResponse(() => HttpResponse.json(db));
    server.use(
      http.get(api("/api/reviews"), () => (++listRequests === 1 ? HttpResponse.json(db) : refetch.resolver())),
      http.delete(api("/api/reviews/:id"), hold.resolver)
    );
    const { user } = renderWithProviders(<MyReviewsPage />);

    await user.click(await screen.findByRole("button", { name: "한밭수목원 후기 삭제" }));
    await user.click(screen.getByRole("button", { name: "삭제하기" }));
    await waitFor(() => expect(screen.queryByText("한밭수목원")).toBeNull());

    hold.release();

    // 롤백: 원래 자리(첫 번째 카드)로 돌아온다.
    expect(await screen.findByText("한밭수목원")).toBeTruthy();
    const names = screen.getAllByRole("button", { name: /후기 삭제$/ }).map((button) => button.getAttribute("aria-label"));
    expect(names[0]).toBe("한밭수목원 후기 삭제");
    // 재조회 응답은 아직 오지 않았다 — 위 화면은 롤백만으로 만들어진 것이다.
    expect(listRequests).toBe(2);

    // onSettled가 재조회를 기다리게 돼 있어서, 실패 토스트는 재조회가 끝난 뒤에 뜬다.
    refetch.release();
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("삭제하지 못했어요. 잠시 후 다시 시도해주세요")
    );
  });
});
