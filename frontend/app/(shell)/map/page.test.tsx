import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Place } from "@/types";
import { mockPlaces } from "@/mocks";
import { makePlace } from "@/test/fixtures";
import { api, http, HttpResponse, serverError } from "@/test/msw/handlers";
import { server } from "@/test/msw/server";
import { currentUrl, resetNavigation } from "@/test/navigation";
import { renderWithProviders } from "@/test/render";
import MapPage from "./page";

vi.mock("next/navigation", async () => (await import("@/test/navigation")).navigationMock);

/**
 * 댕댕지도 장소 목록 — 구·카테고리는 URL(?district=&category=)에, 검색어는 화면 state에 있다.
 * 메모리 라우터라 카테고리를 누르면 주소가 실제로 바뀌고 화면도 다시 그려진다.
 * 주소는 currentUrl()로, 서버가 받은 필터는 `requested`로, 목록은 화면 글자로 확인한다.
 */

/** 서버 DB 역할. 유성구 장소들. */
let places: Place[];
/** 서버가 받은 쿼리스트링 기록. 예: [{ district: "유성구", category: "산책" }] */
let requested: Record<string, string>[];

beforeEach(() => {
  resetNavigation("/map?district=유성구");
  requested = [];
  places = [
    makePlace({ id: "p1", name: "갑천 산책로", district: "유성구", category: "산책" }),
    makePlace({ id: "p2", name: "댕댕 놀이터", district: "유성구", category: "놀이터" }),
    makePlace({ id: "p3", name: "멍멍 식당", district: "유성구", category: "맛집" }),
  ];

  server.use(
    http.get(api("/api/places"), ({ request }) => {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      requested.push(query);
      return HttpResponse.json(places.filter((place) => !query.category || place.category === query.category));
    })
  );
});

describe("댕댕지도 — 목록", () => {
  it("불러오는 동안 안내를 보여주고, 도착하면 유성구 장소들을 보여준다", async () => {
    renderWithProviders(<MapPage />);

    expect(screen.getByText("불러오는 중…")).toBeTruthy();
    expect(await screen.findByText("갑천 산책로")).toBeTruthy();
    expect(screen.getByText("댕댕 놀이터")).toBeTruthy();
    expect(screen.getByText("멍멍 식당")).toBeTruthy();
    expect(requested).toEqual([{ district: "유성구" }]);
  });

  it("서버가 실패해도 에러 화면 대신 목데이터의 유성구 장소를 보여준다", async () => {
    // usePlaces가 실패를 콘솔에 남기고 목데이터로 대체한다 — 의도된 경고라 테스트 출력에서는 감춘다.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    server.use(http.get(api("/api/places"), serverError));
    const fallback = mockPlaces.find((place) => place.district === "유성구");
    expect(fallback).toBeDefined();
    renderWithProviders(<MapPage />);

    expect(await screen.findByText(fallback!.name)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    warn.mockRestore();
  });

  it("장소가 하나도 없으면 아직 없다고 안내한다", async () => {
    places = [];
    renderWithProviders(<MapPage />);

    expect(await screen.findByText("유성구에 조건에 맞는 장소가 아직 없어요.")).toBeTruthy();
  });
});

describe("댕댕지도 — 필터·검색", () => {
  it("'산책' 태그를 누르면 주소와 서버 요청에 카테고리가 실리고, 산책 장소만 남는다", async () => {
    const { user } = renderWithProviders(<MapPage />);
    await screen.findByText("댕댕 놀이터");

    await user.click(screen.getByRole("button", { name: "산책" }));

    expect(currentUrl()).toBe("/map?district=유성구&category=산책");
    await waitFor(() => expect(screen.queryByText("댕댕 놀이터")).toBeNull());
    expect(screen.getByText("갑천 산책로")).toBeTruthy();
    expect(requested.at(-1)).toEqual({ district: "유성구", category: "산책" });
  });

  it("'전체'를 누르면 카테고리 필터가 풀리고 다시 모든 장소가 보인다", async () => {
    resetNavigation("/map?district=유성구&category=산책");
    const { user } = renderWithProviders(<MapPage />);
    await screen.findByText("갑천 산책로");
    expect(screen.queryByText("멍멍 식당")).toBeNull();

    await user.click(screen.getByRole("button", { name: "전체" }));

    expect(currentUrl()).toBe("/map?district=유성구");
    expect(await screen.findByText("멍멍 식당")).toBeTruthy();
    expect(screen.getByText("댕댕 놀이터")).toBeTruthy();
  });

  it("검색어를 입력하면 이름·조건에 맞는 장소만 남는다", async () => {
    const { user } = renderWithProviders(<MapPage />);
    await screen.findByText("갑천 산책로");

    await user.type(screen.getByRole("searchbox"), "놀이터");

    expect(screen.getByText("댕댕 놀이터")).toBeTruthy();
    expect(screen.queryByText("갑천 산책로")).toBeNull();
    // 검색은 받아 둔 목록을 화면에서 거르는 것이라 서버에 다시 묻지 않는다.
    expect(requested).toHaveLength(1);
  });

  it("검색 결과가 없으면 그렇다고 안내한다", async () => {
    const { user } = renderWithProviders(<MapPage />);
    await screen.findByText("갑천 산책로");

    await user.type(screen.getByRole("searchbox"), "없는장소");

    expect(screen.getByText("‘없는장소’ 검색 결과가 없어요.")).toBeTruthy();
  });

  it("21곳 이상이면 20곳만 먼저 보여주고, '더 보기'로 나머지를 보여준다", async () => {
    places = Array.from({ length: 25 }, (_, i) =>
      makePlace({ id: `p${i + 1}`, name: `장소 ${i + 1}`, district: "유성구" })
    );
    const { user } = renderWithProviders(<MapPage />);
    await screen.findByText("장소 1");
    expect(screen.getByText("장소 20")).toBeTruthy();
    expect(screen.queryByText("장소 21")).toBeNull();

    await user.click(screen.getByRole("button", { name: "더 보기 · 5곳 남음" }));

    expect(screen.getByText("장소 25")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /더 보기/ })).toBeNull();
  });
});
