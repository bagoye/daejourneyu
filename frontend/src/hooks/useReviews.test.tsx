import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCreateReview, useDeleteReview, useReviews } from "@/hooks/useReviews";
import { createReviewApi, deleteReviewApi, fetchReviewsApi } from "@/lib/api/reviews";
import { makeReview } from "@/test/fixtures";
import { createQueryWrapper, createTestQueryClient } from "@/test/query";

vi.mock("@/lib/api/reviews", () => ({
  fetchReviewsApi: vi.fn(),
  createReviewApi: vi.fn(),
  deleteReviewApi: vi.fn(),
}));

function renderWithClient<T>(hook: () => T) {
  const client = createTestQueryClient();
  return { client, ...renderHook(hook, { wrapper: createQueryWrapper(client) }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useReviews", () => {
  it("장소 없이 부르면 전체 후기를 받는다", async () => {
    const reviews = [makeReview(), makeReview({ id: "r2", isMine: false })];
    vi.mocked(fetchReviewsApi).mockResolvedValue(reviews);

    const { client, result } = renderWithClient(() => useReviews());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchReviewsApi).toHaveBeenCalledWith(undefined);
    expect(result.current.data).toEqual(reviews);
    expect(client.getQueryData(["reviews", null])).toEqual(reviews);
  });

  it("장소를 넘기면 그 장소 후기만 따로 캐시한다", async () => {
    vi.mocked(fetchReviewsApi).mockResolvedValue([]);

    const { client, result } = renderWithClient(() => useReviews("place-1"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchReviewsApi).toHaveBeenCalledWith("place-1");
    expect(client.getQueryData(["reviews", "place-1"])).toEqual([]);
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
  const ALL_KEY = ["reviews", null];
  const PLACE_KEY = ["reviews", "place-1"];

  function seed(client: ReturnType<typeof createTestQueryClient>) {
    client.setQueryData(ALL_KEY, [
      makeReview({ id: "r1", placeId: "place-1" }),
      makeReview({ id: "r2", placeId: "place-2" }),
    ]);
    client.setQueryData(PLACE_KEY, [makeReview({ id: "r1", placeId: "place-1" })]);
  }

  const ids = (client: ReturnType<typeof createTestQueryClient>, key: unknown[]) =>
    client.getQueryData<{ id: string }[]>(key)?.map((review) => review.id);

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
