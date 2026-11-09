import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCreateReview, useDeleteReview, useMyReviews, usePlaceReviews } from "@/hooks/useReviews";
import {
  createReviewApi,
  deleteReviewApi,
  fetchMyReviewsApi,
  fetchPlaceReviewsPageApi,
} from "@/lib/api/reviews";
import { makeReview } from "@/test/fixtures";
import { createQueryWrapper, createTestQueryClient } from "@/test/query";
import { useAuthStore } from "@/stores/useAuthStore";

vi.mock("@/lib/api/reviews", () => ({
  fetchMyReviewsApi: vi.fn(),
  fetchPlaceReviewsPageApi: vi.fn(),
  createReviewApi: vi.fn(),
  deleteReviewApi: vi.fn(),
}));

function renderWithClient<T>(hook: () => T) {
  const client = createTestQueryClient();
  return { client, ...renderHook(hook, { wrapper: createQueryWrapper(client) }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ isLoggedIn: true, hydrated: true });
});

describe("useMyReviews", () => {
  it("내 후기를 받아 내 후기 캐시에 담는다", async () => {
    const reviews = [makeReview()];
    vi.mocked(fetchMyReviewsApi).mockResolvedValue(reviews);

    const { client, result } = renderWithClient(() => useMyReviews());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(reviews);
    expect(client.getQueryData(["reviews", "mine"])).toEqual(reviews);
  });

  it("로그인 전에는 요청하지 않는다(서버가 401을 준다)", () => {
    useAuthStore.setState({ isLoggedIn: false });

    const { result } = renderWithClient(() => useMyReviews());

    expect(result.current.fetchStatus).toBe("idle");
    expect(fetchMyReviewsApi).not.toHaveBeenCalled();
  });
});

describe("usePlaceReviews", () => {
  it("첫 페이지를 받고, 다음 페이지는 서버가 준 커서로 이어 받아 붙인다", async () => {
    vi.mocked(fetchPlaceReviewsPageApi)
      .mockResolvedValueOnce({ items: [makeReview({ id: "r1" }), makeReview({ id: "r2" })], nextCursor: "v1.next" })
      .mockResolvedValueOnce({ items: [makeReview({ id: "r3" })], nextCursor: null });

    const { result } = renderWithClient(() => usePlaceReviews("place-1"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchPlaceReviewsPageApi).toHaveBeenLastCalledWith("place-1", null);
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });

    expect(fetchPlaceReviewsPageApi).toHaveBeenLastCalledWith("place-1", "v1.next");
    await waitFor(() => expect(result.current.reviews.map((r) => r.id)).toEqual(["r1", "r2", "r3"]));
    expect(result.current.hasNextPage).toBe(false);
  });

  it("페이지 사이에 같은 후기가 다시 실려 와도 한 번만 보여준다", async () => {
    vi.mocked(fetchPlaceReviewsPageApi)
      .mockResolvedValueOnce({ items: [makeReview({ id: "r1" })], nextCursor: "v1.next" })
      .mockResolvedValueOnce({ items: [makeReview({ id: "r1" }), makeReview({ id: "r2" })], nextCursor: null });

    const { result } = renderWithClient(() => usePlaceReviews("place-1"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });

    await waitFor(() => expect(result.current.reviews.map((r) => r.id)).toEqual(["r1", "r2"]));
  });

  it("장소를 아직 모르면 요청하지 않는다", () => {
    renderWithClient(() => usePlaceReviews(undefined));
    expect(fetchPlaceReviewsPageApi).not.toHaveBeenCalled();
  });
});

describe("후기 작성·삭제", () => {
  it("작성하면 후기 캐시 전체를 무효화한다", async () => {
    vi.mocked(createReviewApi).mockResolvedValue(makeReview());
    const { client, result } = renderWithClient(() => useCreateReview());
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const input = { placeId: "place-1", placeName: "한밭수목원", tagCodes: ["LEASH_REQUIRED"] };

    await act(async () => {
      await result.current.mutateAsync(input);
    });

    expect(createReviewApi).toHaveBeenCalledWith(input);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["reviews"] });
  });

  it("삭제하면 후기 캐시 전체를 무효화한다", async () => {
    vi.mocked(deleteReviewApi).mockResolvedValue(undefined);
    const { client, result } = renderWithClient(() => useDeleteReview());
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await act(async () => {
      await result.current.mutateAsync("review-1");
    });

    expect(deleteReviewApi).toHaveBeenCalledWith("review-1");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["reviews"] });
  });
});

describe("useDeleteReview — 낙관적 삭제", () => {
  // 내 후기(배열 캐시)와 장소 후기(무한 스크롤 캐시)가 같은 후기를 동시에 들고 있는 상황
  const ALL_KEY = ["reviews", "mine"];
  const PLACE_KEY = ["reviews", "place", "place-1"];

  function seed(client: ReturnType<typeof createTestQueryClient>) {
    client.setQueryData(ALL_KEY, [
      makeReview({ id: "r1", placeId: "place-1" }),
      makeReview({ id: "r2", placeId: "place-2" }),
    ]);
    client.setQueryData(PLACE_KEY, {
      pages: [{ items: [makeReview({ id: "r1", placeId: "place-1" })], nextCursor: null }],
      pageParams: [null],
    });
  }

  type Cache = { id: string }[] | { pages: { items: { id: string }[] }[] };
  const ids = (client: ReturnType<typeof createTestQueryClient>, key: unknown[]) => {
    const cache = client.getQueryData<Cache>(key);
    if (!cache) return undefined;
    const list = Array.isArray(cache) ? cache : cache.pages.flatMap((page) => page.items);
    return list.map((review) => review.id);
  };

  it("응답을 기다리지 않고 마이탭·장소 상세 캐시 양쪽에서 바로 뺀다", async () => {
    vi.mocked(deleteReviewApi).mockReturnValue(new Promise(() => {}));
    const { client, result } = renderWithClient(() => useDeleteReview());
    seed(client);

    act(() => {
      result.current.mutate("r1");
    });

    await waitFor(() => expect(ids(client, ALL_KEY)).toEqual(["r2"]));
    expect(ids(client, PLACE_KEY)).toEqual([]);
  });

  it("실패하면 두 캐시 모두 삭제 전으로 되돌리고, 에러는 호출부로 넘긴다", async () => {
    vi.mocked(deleteReviewApi).mockRejectedValue(new Error("삭제하지 못했어요"));
    const { client, result } = renderWithClient(() => useDeleteReview());
    seed(client);

    await act(async () => {
      await expect(result.current.mutateAsync("r1")).rejects.toThrow("삭제하지 못했어요");
    });

    expect(ids(client, ALL_KEY)).toEqual(["r1", "r2"]);
    expect(ids(client, PLACE_KEY)).toEqual(["r1"]);
  });

  it("삭제 두 건이 겹쳐도, 실패한 쪽은 자기 후기만 되살린다", async () => {
    let rejectFirst: (error: Error) => void = () => {};
    vi.mocked(deleteReviewApi)
      .mockReturnValueOnce(new Promise<void>((_, reject) => (rejectFirst = reject)))
      .mockResolvedValueOnce(undefined);
    const { client, result } = renderWithClient(() => useDeleteReview());
    seed(client);

    let first: Promise<void> | undefined;
    act(() => {
      first = result.current.mutateAsync("r1");
    });
    await waitFor(() => expect(ids(client, ALL_KEY)).toEqual(["r2"]));
    await act(async () => {
      await result.current.mutateAsync("r2");
    });
    expect(ids(client, ALL_KEY)).toEqual([]);

    // 스냅샷을 통째로 되돌리면 이미 지워진 r2까지 다시 나타난다.
    await act(async () => {
      rejectFirst(new Error("삭제하지 못했어요"));
      await expect(first).rejects.toThrow("삭제하지 못했어요");
    });
    expect(ids(client, ALL_KEY)).toEqual(["r1"]);
    expect(ids(client, PLACE_KEY)).toEqual(["r1"]);
  });
});
