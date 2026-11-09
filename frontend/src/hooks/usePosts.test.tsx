import { act, renderHook, waitFor } from "@testing-library/react";
import type { InfiniteData } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useCreatePost,
  useDeletePost,
  useFeedPosts,
  useHottestPost,
  usePost,
  useToggleSave,
  useUpdatePost,
} from "@/hooks/usePosts";
import {
  createPostApi,
  deletePostApi,
  fetchPostApi,
  fetchPostsApi,
  savePostApi,
  unsavePostApi,
  updatePostApi,
  type ApiFeedPost,
  type PostCreateInput,
  type PostPage,
  type PostSaveResult,
} from "@/lib/api/posts";
import { usePetStore } from "@/stores/usePetStore";
import { makeApiPost, makePet, makeStop, PET_TYPE_NAME } from "@/test/fixtures";
import { createQueryWrapper, createTestQueryClient } from "@/test/query";

vi.mock("@/lib/api/posts", () => ({
  fetchPostsApi: vi.fn(),
  fetchPostApi: vi.fn(),
  savePostApi: vi.fn(),
  unsavePostApi: vi.fn(),
  createPostApi: vi.fn(),
  updatePostApi: vi.fn(),
  deletePostApi: vi.fn(),
}));

function renderWithClient<T>(hook: () => T) {
  const client = createTestQueryClient();
  const utils = renderHook(hook, { wrapper: createQueryWrapper(client) });
  return { client, ...utils };
}

beforeEach(() => {
  vi.clearAllMocks();
  usePetStore.setState({
    pets: [makePet({ mbti: { code: "ENFP", name: PET_TYPE_NAME, theme: "산책", traits: [] } })],
    activePetIndex: 0,
  });
});

describe("useFeedPosts", () => {
  it("첫 페이지를 받고 커서로 이어 받으며, 뷰어 유형과 같은 글에 표시를 붙인다", async () => {
    vi.mocked(fetchPostsApi)
      .mockResolvedValueOnce({
        items: [
          makeApiPost({ id: "a", petTypeName: PET_TYPE_NAME }),
          makeApiPost({ id: "b", petTypeName: "다른 유형" }),
        ],
        nextCursor: "b",
        total: 3,
      })
      .mockResolvedValueOnce({ items: [makeApiPost({ id: "c" })], nextCursor: null });

    const { result } = renderWithClient(() => useFeedPosts({ sameTypeOnly: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchPostsApi).toHaveBeenNthCalledWith(1, {
      keyword: undefined,
      sort: "saves",
      sameTypeName: PET_TYPE_NAME,
      limit: 10,
      cursor: null,
    });
    expect(result.current.data.map((post) => [post.id, post.sameTypeMatch])).toEqual([
      ["a", true],
      ["b", false],
    ]);
    expect(result.current.total).toBe(3);
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });

    await waitFor(() => expect(result.current.data).toHaveLength(3));
    expect(fetchPostsApi).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "b" }));
    expect(result.current.hasNextPage).toBe(false);
    // 전체 건수는 첫 페이지 값을 유지한다.
    expect(result.current.total).toBe(3);
  });

  it("담긴순에서 같은 글이 다음 페이지에 다시 실려 와도 한 번만 보여준다", async () => {
    // 첫 페이지를 받은 뒤 b의 담긴 수가 줄어 다음 페이지 범위로 내려간 상황
    vi.mocked(fetchPostsApi)
      .mockResolvedValueOnce({ items: [makeApiPost({ id: "a" }), makeApiPost({ id: "b" })], nextCursor: "v1.x", total: 3 })
      .mockResolvedValueOnce({ items: [makeApiPost({ id: "b" }), makeApiPost({ id: "c" })], nextCursor: null });

    const { result } = renderWithClient(() => useFeedPosts());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });

    await waitFor(() => expect(result.current.data.map((post) => post.id)).toEqual(["a", "b", "c"]));
  });

  it("검색 중에는 유형 필터를 켜도 유형을 보내지 않는다", async () => {
    vi.mocked(fetchPostsApi).mockResolvedValue({ items: [], nextCursor: null, total: 0 });

    const { result } = renderWithClient(() =>
      useFeedPosts({ keyword: "한빛탑", sort: "recent", sameTypeOnly: true })
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchPostsApi).toHaveBeenCalledWith({
      keyword: "한빛탑",
      sort: "recent",
      sameTypeName: null,
      limit: 10,
      cursor: null,
    });
  });

  it("내 글 탭은 검색·유형 없이 내 글만 요청한다", async () => {
    vi.mocked(fetchPostsApi).mockResolvedValue({ items: [], nextCursor: null, total: 0 });

    const { result } = renderWithClient(() => useFeedPosts({ mine: true, keyword: "무시됨" }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchPostsApi).toHaveBeenCalledWith({ mine: true, sort: "saves", limit: 10, cursor: null });
  });

  it("전체 건수가 오기 전에는 받은 개수로 대신한다", async () => {
    vi.mocked(fetchPostsApi).mockResolvedValue({ items: [makeApiPost()], nextCursor: null });

    const { result } = renderWithClient(() => useFeedPosts());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.total).toBe(1);
  });

  it("enabled가 false면 요청하지 않는다", () => {
    const { result } = renderWithClient(() => useFeedPosts({ enabled: false }));

    expect(fetchPostsApi).not.toHaveBeenCalled();
    expect(result.current.data).toEqual([]);
  });
});

describe("useHottestPost", () => {
  it("전체에서 가장 많이 담긴 한 건만 받아온다", async () => {
    vi.mocked(fetchPostsApi).mockResolvedValue({
      items: [makeApiPost({ id: "hot", petTypeName: PET_TYPE_NAME })],
      nextCursor: "hot",
    });

    const { result } = renderWithClient(() => useHottestPost(true));
    await waitFor(() => expect(result.current.data).not.toBeNull());

    expect(fetchPostsApi).toHaveBeenCalledWith({ sort: "saves", limit: 1 });
    expect(result.current.data).toMatchObject({ id: "hot", sameTypeMatch: true });
  });

  it("글이 하나도 없으면 null", async () => {
    vi.mocked(fetchPostsApi).mockResolvedValue({ items: [], nextCursor: null });

    const { result } = renderWithClient(() => useHottestPost(true));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toBeNull();
  });
});

describe("usePost", () => {
  it("id가 비어 있으면 요청하지 않는다", () => {
    const { result } = renderWithClient(() => usePost(""));

    expect(fetchPostApi).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();
  });

  it("단건을 받아 유형 표시를 붙이고, 없는 글이면 null", async () => {
    vi.mocked(fetchPostApi).mockResolvedValueOnce(makeApiPost({ id: "p1", petTypeName: "다른 유형" }));
    const found = renderWithClient(() => usePost("p1"));
    await waitFor(() => expect(found.result.current.data).not.toBeNull());
    expect(found.result.current.data).toMatchObject({ id: "p1", sameTypeMatch: false });

    vi.mocked(fetchPostApi).mockResolvedValueOnce(null);
    const missing = renderWithClient(() => usePost("gone"));
    await waitFor(() => expect(missing.result.current.isSuccess).toBe(true));
    expect(missing.result.current.data).toBeNull();
  });
});

describe("useToggleSave", () => {
  const LIST_KEY = ["posts", "list", { sort: "saves" }];
  const MY_KEY = ["posts", "list", { mine: true }];
  const DETAIL_KEY = ["posts", "detail", "p1"];

  function seedCaches(client: ReturnType<typeof createTestQueryClient>) {
    client.setQueryData<InfiniteData<PostPage>>(LIST_KEY, {
      pages: [
        {
          items: [makeApiPost({ id: "p1", saves: 3, saved: false }), makeApiPost({ id: "p2", saves: 1 })],
          nextCursor: null,
        },
      ],
      pageParams: [null],
    });
    client.setQueryData<PostPage>(MY_KEY, {
      items: [makeApiPost({ id: "p1", saves: 3, saved: false })],
      nextCursor: null,
    });
    client.setQueryData<ApiFeedPost>(DETAIL_KEY, makeApiPost({ id: "p1", saves: 3, saved: false }));
  }

  function snapshot(client: ReturnType<typeof createTestQueryClient>) {
    return {
      list: client.getQueryData<InfiniteData<PostPage>>(LIST_KEY)?.pages[0].items,
      mine: client.getQueryData<PostPage>(MY_KEY)?.items[0],
      detail: client.getQueryData<ApiFeedPost>(DETAIL_KEY),
    };
  }

  it("누르는 즉시 모든 캐시의 담기 수를 바꾸고, 성공하면 서버 값으로 맞춘 뒤 보관함을 새로 받는다", async () => {
    let resolveSave: (value: PostSaveResult) => void = () => {};
    vi.mocked(savePostApi).mockImplementation(
      () => new Promise<PostSaveResult>((resolve) => (resolveSave = resolve))
    );

    const { client, result } = renderWithClient(() => useToggleSave());
    seedCaches(client);
    const invalidate = vi.spyOn(client, "invalidateQueries");

    act(() => {
      result.current.mutate({ postId: "p1", next: true });
    });

    await waitFor(() => expect(snapshot(client).detail).toMatchObject({ saved: true, saves: 4 }));
    expect(snapshot(client).list?.[0]).toMatchObject({ saved: true, saves: 4 });
    expect(snapshot(client).list?.[1]).toMatchObject({ id: "p2", saves: 1, saved: false });
    expect(snapshot(client).mine).toMatchObject({ saved: true, saves: 4 });

    await act(async () => {
      resolveSave({ saves: 10, saved: true, courseId: "copy-1" });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(savePostApi).toHaveBeenCalledWith("p1");
    expect(snapshot(client).detail).toMatchObject({ saved: true, saves: 10 });
    expect(snapshot(client).list?.[0]).toMatchObject({ saved: true, saves: 10 });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["courses"] });
  });

  it("실패하면 누르기 전 값으로 되돌린다", async () => {
    vi.mocked(savePostApi).mockRejectedValue(new Error("코스를 담지 못했어요"));

    const { client, result } = renderWithClient(() => useToggleSave());
    seedCaches(client);

    act(() => {
      result.current.mutate({ postId: "p1", next: true });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(snapshot(client).detail).toMatchObject({ saved: false, saves: 3 });
    expect(snapshot(client).list?.[0]).toMatchObject({ saved: false, saves: 3 });
    expect(snapshot(client).mine).toMatchObject({ saved: false, saves: 3 });
  });

  it("담기 취소는 취소 API를 부르고 수를 하나 줄여 보여준다", async () => {
    vi.mocked(unsavePostApi).mockImplementation(() => new Promise<PostSaveResult>(() => {}));

    const { client, result } = renderWithClient(() => useToggleSave());
    seedCaches(client);

    act(() => {
      result.current.mutate({ postId: "p1", next: false });
    });

    await waitFor(() => expect(snapshot(client).detail).toMatchObject({ saved: false, saves: 2 }));
    expect(unsavePostApi).toHaveBeenCalledWith("p1");
    expect(savePostApi).not.toHaveBeenCalled();
  });
});

describe("작성·수정·삭제 mutation", () => {
  const input: PostCreateInput = {
    caption: "갑천 코스",
    text: "",
    stops: [makeStop()],
    tags: ["당일치기"],
    authorName: "콩이네",
    authorEmoji: "🐶",
    petTypeName: PET_TYPE_NAME,
  };

  it("작성하면 게시물 캐시 전체를 무효화한다", async () => {
    vi.mocked(createPostApi).mockResolvedValue(makeApiPost({ id: "new" }));
    const { client, result } = renderWithClient(() => useCreatePost());
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await act(async () => {
      await result.current.mutateAsync(input);
    });

    expect(createPostApi).toHaveBeenCalledWith(input);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["posts"] });
  });

  it("수정은 글 id와 고칠 값을 넘기고 캐시를 무효화한다", async () => {
    vi.mocked(updatePostApi).mockResolvedValue(makeApiPost({ caption: "새 이름" }));
    const { client, result } = renderWithClient(() => useUpdatePost());
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await act(async () => {
      await result.current.mutateAsync({ postId: "p1", input: { caption: "새 이름" } });
    });

    expect(updatePostApi).toHaveBeenCalledWith("p1", { caption: "새 이름" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["posts"] });
  });

  it("삭제하면 캐시를 무효화한다", async () => {
    vi.mocked(deletePostApi).mockResolvedValue(undefined);
    const { client, result } = renderWithClient(() => useDeletePost());
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await act(async () => {
      await result.current.mutateAsync("p1");
    });

    expect(deletePostApi).toHaveBeenCalledWith("p1");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["posts"] });
  });
});
