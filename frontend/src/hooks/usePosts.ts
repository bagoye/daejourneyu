import { useMemo } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { FeedPost } from "@/types";
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
  type PostListParams,
  type PostUpdateInput,
} from "@/lib/api/posts";
import { usePetStore } from "@/stores/usePetStore";
import { queryKeys } from "@/lib/queryKeys";

/** 무한 스크롤 한 번에 받아오는 개수. 카드가 커서 한 화면에 3~4장이라 10장이면 두 화면 남짓. */
const PAGE_SIZE = 10;

/** 내 글 탭은 서버 페이지네이션 없이 한 번에 받는다 — 본인이 쓴 글이라 애초에 몇 개 안 된다. */
const MY_POSTS_LIMIT = 50;

/**
 * 목록을 "신선한 것"으로 볼 시간.
 *
 * 무한 쿼리는 다시 받을 때 **불러온 페이지를 전부** 다시 받는다 — 5페이지까지 스크롤한 뒤
 * 탭을 옮겼다 돌아오면 요청 5건이 한꺼번에 나간다. 전역 QueryClient가 기본값(staleTime 0)이라
 * 화면을 다시 볼 때마다 그게 반복됐다.
 *
 * 글이 초 단위로 바뀌는 화면이 아니고, 새 글·삭제는 mutation이 캐시를 무효화해 바로 반영되므로
 * 시간 기반 재조회는 넉넉하게 잡는다.
 */
const LIST_STALE_MS = 60_000;

/** 인기 배너는 전체 최다 담김이라 더 천천히 바뀐다. */
const HOTTEST_STALE_MS = 5 * 60_000;

/**
 * 뷰어의 반려동물 유형을 붙인다.
 * `sameTypeMatch`는 같은 글이라도 누가 보느냐에 따라 달라지는 값이라 서버가 아니라 여기서 계산한다 —
 * 서버는 "같은 유형만 보기" 필터에만 유형 이름을 쓰고, 표시용 뱃지 판단은 화면 몫이다.
 */
function useSameTypeDecorator() {
  const activePet = usePetStore((state) => state.activePet());
  const myTypeName = activePet?.mbti?.name ?? null;

  return useMemo(
    () => ({
      myTypeName,
      decorate: (post: ApiFeedPost): FeedPost => ({
        ...post,
        sameTypeMatch: myTypeName !== null && post.petTypeName === myTypeName,
      }),
    }),
    [myTypeName]
  );
}

export interface FeedListOptions {
  keyword?: string;
  sort?: PostListParams["sort"];
  /** 같은 유형만 보기 토글. 뷰어에게 유형이 없으면 무시된다. */
  sameTypeOnly?: boolean;
  /** 둘러보기 '내 글' 탭. 코스 탭과 같은 카드·무한 스크롤을 쓰되 내 글만 받는다(검색·유형 필터 없음). */
  mine?: boolean;
  enabled?: boolean;
}

/**
 * 둘러보기 코스 탭 목록. 검색·유형 필터·정렬을 **서버가** 처리하고 커서로 이어 받는다.
 *
 * 예전에는 전체를 한 번에 받아 화면에서 걸렀는데, 글이 늘면 그대로 무너지는 구조였다.
 * 검색어·정렬·필터가 쿼리키에 들어가므로 조건이 바뀌면 첫 페이지부터 다시 받는다.
 */
export function useFeedPosts({
  keyword,
  sort = "saves",
  sameTypeOnly = false,
  mine = false,
  enabled = true,
}: FeedListOptions = {}) {
  const { myTypeName, decorate } = useSameTypeDecorator();
  // 검색 중에는 서버도 유형 필터를 무시하지만, 쿼리키가 갈라지지 않도록 여기서도 비워 보낸다.
  const sameTypeName = !keyword && sameTypeOnly ? myTypeName : null;
  const params: PostListParams = mine
    ? { mine: true, sort, limit: PAGE_SIZE }
    : { keyword, sort, sameTypeName, limit: PAGE_SIZE };

  const query = useInfiniteQuery({
    queryKey: queryKeys.posts.list(params),
    queryFn: ({ pageParam }) => fetchPostsApi({ ...params, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled,
    staleTime: LIST_STALE_MS,
    // 포커스가 돌아올 때마다 스크롤해둔 페이지를 전부 다시 받는 걸 막는다.
    refetchOnWindowFocus: false,
  });

  const data = useMemo<FeedPost[]>(
    () => (query.data?.pages ?? []).flatMap((page) => page.items).map(decorate),
    [query.data, decorate]
  );

  // 전체 건수는 첫 페이지에만 실려 온다. 아직 안 왔으면 지금까지 받은 개수로 대신한다.
  const total = query.data?.pages[0]?.total ?? data.length;

  return { ...query, data, total };
}

/** 내 글. 개수가 적어 한 번에 받고, 페이지 나누기는 기존대로 화면에서 한다. */
export function useMyPosts(sort: PostListParams["sort"] = "recent", enabled = true) {
  const { decorate } = useSameTypeDecorator();
  const params: PostListParams = { mine: true, sort, limit: MY_POSTS_LIMIT };

  const query = useQuery({
    queryKey: queryKeys.posts.list(params),
    queryFn: () => fetchPostsApi(params),
    enabled,
    staleTime: LIST_STALE_MS,
  });

  const data = useMemo<FeedPost[]>(
    () => (query.data?.items ?? []).map(decorate),
    [query.data, decorate]
  );

  return { ...query, data };
}

/**
 * 인기 배너용 한 건. 검색·필터와 무관하게 **전체에서** 가장 많이 담긴 코스라
 * 목록 페이지에서 뽑을 수 없다(첫 페이지 안에 그 글이 없을 수 있다).
 */
export function useHottestPost(enabled: boolean) {
  const { decorate } = useSameTypeDecorator();
  const params: PostListParams = { sort: "saves", limit: 1 };

  const query = useQuery({
    queryKey: queryKeys.posts.list(params),
    queryFn: () => fetchPostsApi(params),
    enabled,
    staleTime: HOTTEST_STALE_MS,
  });

  const first = query.data?.items[0];
  const data = useMemo<FeedPost | null>(
    () => (first ? decorate(first) : null),
    [first, decorate]
  );

  return { ...query, data };
}

/** 게시물 상세 — 목록 페이지에 없을 수 있으므로(딥링크·뒤쪽 페이지) 단건으로 조회한다. */
export function usePost(postId: string) {
  const { decorate } = useSameTypeDecorator();

  const query = useQuery({
    queryKey: queryKeys.posts.detail(postId),
    queryFn: () => fetchPostApi(postId),
    enabled: postId.length > 0,
    staleTime: LIST_STALE_MS,
  });

  const data = useMemo<FeedPost | null>(
    () => (query.data ? decorate(query.data) : null),
    [query.data, decorate]
  );

  return { ...query, data };
}

/** 담기 상태가 바뀐 게시물 하나를, 캐시에 들어 있는 모양이 뭐든 찾아서 갈아끼운다. */
function patchPost<T>(data: T, postId: string, saved: boolean, saves: number): T {
  const apply = (post: ApiFeedPost): ApiFeedPost =>
    post.id === postId ? { ...post, saved, saves } : post;

  if (!data || typeof data !== "object") return data;

  // 무한 쿼리(둘러보기 목록)
  if ("pages" in data) {
    const infinite = data as { pages: { items: ApiFeedPost[] }[] };
    return {
      ...data,
      pages: infinite.pages.map((page) => ({ ...page, items: page.items.map(apply) })),
    };
  }
  // 단일 페이지 쿼리(내 글·인기 배너)
  if ("items" in data) {
    const page = data as { items: ApiFeedPost[] };
    return { ...data, items: page.items.map(apply) };
  }
  // 상세 단건
  if ("id" in data) return apply(data as unknown as ApiFeedPost) as T;

  return data;
}

/**
 * 담기 토글. 남의 코스를 내 보관함에 담고, 취소하면 사본까지 걷어낸다.
 *
 * 버튼을 누른 즉시 화면을 바꾸고(낙관적 업데이트) 실패하면 되돌린다 — 담긴 수가 카드마다
 * 보이는 값이라 왕복을 기다리면 눌렀는지 안 눌렸는지 알기 어렵다.
 * 성공하면 서버가 알려준 값으로 다시 맞추고, 보관함 캐시도 무효화해 내 여정 탭에 바로 나타나게 한다.
 */
export function useToggleSave() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ postId, next }: { postId: string; next: boolean }) =>
      next ? savePostApi(postId) : unsavePostApi(postId),

    onMutate: async ({ postId, next }) => {
      // 진행 중인 조회가 낙관적 값을 덮어쓰지 않게 먼저 멈춘다.
      await queryClient.cancelQueries({ queryKey: queryKeys.posts.all });
      const snapshot = queryClient.getQueriesData({ queryKey: queryKeys.posts.all });

      for (const [key, data] of snapshot) {
        const current = findPostInCache(data, postId);
        if (!current) continue;
        queryClient.setQueryData(key, patchPost(data, postId, next, current.saves + (next ? 1 : -1)));
      }

      return { snapshot };
    },

    onError: (_error, _variables, context) => {
      for (const [key, data] of context?.snapshot ?? []) queryClient.setQueryData(key, data);
    },

    onSuccess: (result, { postId }) => {
      for (const [key, data] of queryClient.getQueriesData({ queryKey: queryKeys.posts.all })) {
        queryClient.setQueryData(key, patchPost(data, postId, result.saved, result.saves));
      }
      // 보관함에 사본이 생기거나 사라졌으므로 코스 목록을 다시 받는다.
      queryClient.invalidateQueries({ queryKey: queryKeys.courses.all });
    },
  });
}

/** 낙관적 업데이트에 필요한 "지금 담긴 수"를 캐시에서 찾는다. */
function findPostInCache(data: unknown, postId: string): ApiFeedPost | undefined {
  if (!data || typeof data !== "object") return undefined;
  if ("pages" in data) {
    const infinite = data as { pages: { items: ApiFeedPost[] }[] };
    return infinite.pages.flatMap((page) => page.items).find((post) => post.id === postId);
  }
  if ("items" in data) {
    return (data as { items: ApiFeedPost[] }).items.find((post) => post.id === postId);
  }
  if ("id" in data) {
    const post = data as unknown as ApiFeedPost;
    return post.id === postId ? post : undefined;
  }
  return undefined;
}

/** 코스 자랑하기 — 성공하면 목록 캐시를 무효화해 둘러보기에 바로 반영된다. */
export function useCreatePost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PostCreateInput) => createPostApi(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.posts.all }),
  });
}

/** 내 글 수정 — 코스 이름·소개만 고친다. 목록 카드에도 같은 값이 나가므로 전체를 무효화한다. */
export function useUpdatePost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ postId, input }: { postId: string; input: PostUpdateInput }) =>
      updatePostApi(postId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.posts.all }),
  });
}

/** 내 글 삭제. */
export function useDeletePost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (postId: string) => deletePostApi(postId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.posts.all }),
  });
}
