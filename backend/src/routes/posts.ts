import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { optionalAuth } from "../middleware/optionalAuth";
import { asyncHandler } from "../lib/asyncHandler";

type PostStop = {
  placeId: string;
  name: string;
  category: string;
  district: string;
  condition: string;
  petFriendly: boolean;
  imageUrl?: string | null;
};

/** 프론트 src/types/feed.ts 의 FeedPost와 필드명을 맞춘다 — 화면에서 변환 없이 그대로 쓴다. */
type FeedPost = {
  id: string;
  authorName: string;
  authorEmoji: string;
  petTypeName: string;
  isMine: boolean;
  caption: string;
  text: string;
  stops: PostStop[];
  courseId?: string;
  tags: string[];
  likes: number;
  liked: boolean;
  saves: number;
  saved: boolean;
  /** ISO 문자열. 최신순 정렬을 서버가 하므로 화면은 표시용으로만 쓴다. */
  createdAt: string;
};

const postWithRelations = {
  stops: { orderBy: { order: "asc" as const } },
};

type PostRow = Prisma.PostGetPayload<{ include: typeof postWithRelations }>;

/**
 * 뷰어가 담아둔 글 id 집합. 목록 한 페이지마다 한 번만 조회해서 N+1을 피한다.
 * 비로그인은 담기 상태가 없으므로 빈 집합이다.
 */
async function loadSavedPostIds(
  viewerId: string | undefined,
  postIds: string[]
): Promise<Set<string>> {
  if (!viewerId || postIds.length === 0) return new Set();
  const rows = await prisma.postSave.findMany({
    where: { userId: viewerId, postId: { in: postIds } },
    select: { postId: true },
  });
  return new Set(rows.map((row) => row.postId));
}

function toFeedPost(
  row: PostRow,
  viewerId: string | undefined,
  savedPostIds: Set<string>
): FeedPost {
  return {
    id: row.id,
    authorName: row.authorName,
    authorEmoji: row.authorEmoji,
    petTypeName: row.petTypeName,
    isMine: viewerId !== undefined && row.userId === viewerId,
    caption: row.caption,
    text: row.text,
    stops: row.stops.map((s) => ({
      placeId: s.placeId,
      name: s.name,
      category: s.category,
      district: s.district,
      condition: s.condition,
      petFriendly: s.petFriendly,
      imageUrl: s.imageUrl,
    })),
    ...(row.courseId ? { courseId: row.courseId } : {}),
    tags: row.tags,
    likes: row.likes,
    // TODO(api): 좋아요는 아직 서버에 없어 항상 false로 내려간다(프론트가 로컬 상태로 덮어씀).
    liked: false,
    saves: row.saves,
    saved: savedPostIds.has(row.id),
    createdAt: row.createdAt.toISOString(),
  };
}

function isValidStop(s: unknown): s is PostStop {
  if (typeof s !== "object" || s === null) return false;
  const stop = s as PostStop;
  if (typeof stop.placeId !== "string") return false;
  if (typeof stop.name !== "string") return false;
  if (typeof stop.category !== "string") return false;
  if (typeof stop.district !== "string") return false;
  if (typeof stop.condition !== "string") return false;
  if (typeof stop.petFriendly !== "boolean") return false;
  if (stop.imageUrl !== undefined && stop.imageUrl !== null && typeof stop.imageUrl !== "string") return false;
  return true;
}

type PostCreateInput = {
  caption: string;
  text: string;
  stops: PostStop[];
  tags: string[];
  authorName: string;
  authorEmoji: string;
  petTypeName: string;
  courseId?: string;
};

function validatePostInput(body: unknown): body is PostCreateInput {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  if (typeof b.caption !== "string" || b.caption.trim().length === 0) return false;
  if (typeof b.text !== "string") return false;
  if (typeof b.authorName !== "string" || b.authorName.trim().length === 0) return false;
  if (typeof b.authorEmoji !== "string" || b.authorEmoji.length === 0) return false;
  if (typeof b.petTypeName !== "string") return false;
  if (b.courseId !== undefined && typeof b.courseId !== "string") return false;
  if (!Array.isArray(b.tags) || !b.tags.every((tag) => typeof tag === "string")) return false;
  // 방문 장소가 없는 글은 '코스 게시물'이 아니다 — 둘러보기 카드가 동선을 전제로 그려진다.
  return Array.isArray(b.stops) && b.stops.length > 0 && b.stops.every(isValidStop);
}

const router = Router();

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function parseLimit(raw: unknown): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function firstQueryValue(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return undefined;
}

/**
 * 검색 범위는 프론트가 쓰던 searchPosts와 맞춘다 — 코스 이름·한마디·작성자·태그·방문 장소명.
 * 태그만 부분일치가 아니라 정확일치인데, 태그 값이 "당일치기"·"자차"·"유성구"처럼 고정 어휘라
 * 부분일치가 필요한 자치구 검색은 stops.district가 대신 받는다(Postgres는 String[] 부분검색을 못 한다).
 */
function buildSearchWhere(keyword: string): Prisma.PostWhereInput {
  return {
    OR: [
      { caption: { contains: keyword, mode: "insensitive" } },
      { text: { contains: keyword, mode: "insensitive" } },
      { authorName: { contains: keyword, mode: "insensitive" } },
      { tags: { has: keyword } },
      { stops: { some: { name: { contains: keyword, mode: "insensitive" } } } },
      { stops: { some: { district: { contains: keyword, mode: "insensitive" } } } },
    ],
  };
}

/**
 * GET /api/posts — 둘러보기 목록. 비로그인도 볼 수 있고, 로그인했으면 내 글에 isMine이 붙는다.
 *
 * 검색·유형 필터·정렬을 전부 여기서 처리한다. 예전에는 전체를 내려주고 화면이 걸렀는데,
 * 글이 늘면 그대로 무너지는 구조라 서버로 옮겼다.
 *
 * 페이지네이션은 offset이 아니라 **커서**다 — 담긴순 목록은 순서가 계속 바뀌어서 offset을 쓰면
 * 스크롤 도중 같은 글이 두 번 나오거나 건너뛰어진다. 커서는 마지막 항목의 id이고,
 * 정렬 키에 항상 id를 섞어 순서를 확정한다(동점이어도 페이지 경계가 흔들리지 않게).
 */
router.get("/", optionalAuth, asyncHandler(async (req, res) => {
  const keyword = firstQueryValue(req.query.q)?.trim();
  const sameTypeName = firstQueryValue(req.query.sameType)?.trim();
  const sort = firstQueryValue(req.query.sort) === "recent" ? "recent" : "saves";
  const mine = firstQueryValue(req.query.mine) === "true";
  const cursor = firstQueryValue(req.query.cursor);
  const limit = parseLimit(firstQueryValue(req.query.limit));

  if (mine && !req.userId) {
    return res.status(401).json({ error: "로그인이 필요해요" });
  }

  const filters: Prisma.PostWhereInput[] = [];
  if (mine) filters.push({ userId: req.userId! });
  if (keyword) filters.push(buildSearchWhere(keyword));
  // 검색 중에는 유형 필터를 무시한다 — 검색은 항상 전체 코스를 훑는다(프로토타입 동작 유지).
  if (!keyword && sameTypeName) filters.push({ petTypeName: sameTypeName });

  // 커서 글이 지워졌으면 Prisma가 던지므로, 조용히 목록의 끝으로 처리한다.
  if (cursor) {
    const alive = await prisma.post.findUnique({ where: { id: cursor }, select: { id: true } });
    if (!alive) return res.json({ items: [], nextCursor: null });
  }

  const where = filters.length > 0 ? { AND: filters } : undefined;

  const rows = await prisma.post.findMany({
    where,
    orderBy:
      sort === "recent"
        ? [{ createdAt: "desc" }, { id: "desc" }]
        : [{ saves: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    take: limit,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: postWithRelations,
  });

  // 마지막 페이지인지는 "요청한 만큼 채워 왔는가"로 판단한다. 딱 떨어지면 다음 요청이 빈 배열로 끝난다.
  const nextCursor = rows.length === limit ? rows[rows.length - 1]!.id : null;
  // 전체 건수는 첫 페이지에서만 센다 — 검색 결과 개수를 보여주는 용도라 이어 받을 때는 필요 없다.
  const total = cursor ? undefined : await prisma.post.count({ where });

  const savedPostIds = await loadSavedPostIds(req.userId, rows.map((row) => row.id));

  res.json({
    items: rows.map((row) => toFeedPost(row, req.userId, savedPostIds)),
    nextCursor,
    total,
  });
}));

/**
 * GET /api/posts/:id — 게시물 하나. 목록이 페이지 단위로 바뀌면서 상세 화면이 목록 캐시에서
 * 글을 못 찾는 경우가 생기므로(딥링크·뒤쪽 페이지) 단건 조회가 필요해졌다.
 */
router.get("/:id", optionalAuth, asyncHandler(async (req, res) => {
  const row = await prisma.post.findUnique({
    where: { id: req.params.id },
    include: postWithRelations,
  });
  if (!row) return res.status(404).json({ error: "게시물을 찾을 수 없어요" });
  res.json(toFeedPost(row, req.userId, await loadSavedPostIds(req.userId, [row.id])));
}));

// POST /api/posts — 코스 자랑하기. 로그인 필요.
router.post("/", requireAuth, asyncHandler(async (req, res) => {
  if (!validatePostInput(req.body)) {
    return res.status(400).json({ error: "게시물 형식이 올바르지 않아요" });
  }
  const input = req.body;

  if (input.courseId) {
    // 남의 코스를 내 글로 올릴 수 없다. 코스가 이미 지워졌으면 연결만 비우고 글은 그대로 올린다.
    const course = await prisma.course.findUnique({ where: { id: input.courseId } });
    if (course && course.userId !== req.userId) {
      return res.status(403).json({ error: "내 코스만 자랑할 수 있어요" });
    }
    if (!course) input.courseId = undefined;
  }

  const created = await prisma.post.create({
    data: {
      caption: input.caption,
      text: input.text,
      tags: input.tags,
      authorName: input.authorName,
      authorEmoji: input.authorEmoji,
      petTypeName: input.petTypeName,
      userId: req.userId!,
      courseId: input.courseId ?? null,
      stops: { create: input.stops.map((stop, order) => ({ ...stop, order })) },
    },
    include: postWithRelations,
  });

  res.status(201).json(toFeedPost(created, req.userId, new Set()));
}));

/**
 * 담긴 글을 내 보관함 코스로 옮겨 적는다.
 *
 * 동선은 **글에 박제된 stops를 정본으로** 쓴다 — 사용자가 화면에서 본 그대로여야 하기 때문이다.
 * 원본 코스는 일차 구분·이동수단처럼 글에 남지 않는 정보를 채우는 데만 참고하고,
 * 원본이 지워졌거나 그 사이 장소 수가 달라졌으면 참고를 포기하고 당일치기 한 일차로 접는다.
 */
function buildSavedCourseData(
  post: PostRow,
  origin: { emoji: string | null; transport: string; days: { stops: { order: number }[] }[] } | null
) {
  const dayLengths = origin?.days.map((day) => day.stops.length) ?? [];
  const originStopCount = dayLengths.reduce((sum, n) => sum + n, 0);
  const usable = origin !== null && originStopCount === post.stops.length;

  const days: PostRow["stops"][] = [];
  if (usable) {
    let cursor = 0;
    for (const length of dayLengths) {
      days.push(post.stops.slice(cursor, cursor + length));
      cursor += length;
    }
  } else {
    days.push(post.stops);
  }

  /*
   * 이동수단은 일차 구분과 달리 장소 수가 맞는지와 무관하므로, 원본 코스가 남아 있으면
   * 그대로 가져온다(usable이 false여도 마찬가지다 — 작성 후 원본을 손대면 흔히 그렇게 된다).
   * 태그 fallback은 이동수단 태그를 같이 달던 시절의 옛 글에만 걸린다 —
   * 지금 자랑하기가 붙이는 태그는 일정 길이와 자치구뿐이다(frontend src/lib/feed.ts).
   */
  const taggedTransport = post.tags.find((tag) => tag === "자차" || tag === "대중교통");

  return {
    label: post.caption,
    emoji: usable ? origin!.emoji : null,
    nights: days.length - 1,
    transport: origin?.transport ?? taggedTransport ?? "자차",
    source: "saved",
    shared: false,
    days: {
      create: days.map((stops, dayIndex) => ({
        dayIndex,
        stops: {
          create: stops.map((stop, order) => ({
            order,
            placeId: stop.placeId,
            name: stop.name,
            category: stop.category,
            district: stop.district,
            condition: stop.condition,
            petFriendly: stop.petFriendly,
            imageUrl: stop.imageUrl,
          })),
        },
      })),
    },
  };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/** 지금 DB에 확정된 담기 상태. 동시 요청에 진 쪽이 이긴 쪽의 결과를 그대로 돌려줄 때 쓴다. */
async function loadSaveState(postId: string, userId: string) {
  const [row, post] = await Promise.all([
    prisma.postSave.findUnique({
      where: { userId_postId: { userId, postId } },
      select: { courseId: true },
    }),
    prisma.post.findUnique({ where: { id: postId }, select: { saves: true } }),
  ]);
  const saves = post?.saves ?? 0;
  return row ? { saves, saved: true, courseId: row.courseId } : { saves, saved: false };
}

/**
 * POST /api/posts/:id/save — 담기. 남의 코스를 내 보관함에 사본으로 만든다. **멱등**이다.
 *
 * 같은 사용자의 중복 담기는 `PostSave(userId, postId)` 유니크 제약이 막는다. 애플리케이션의
 * "먼저 조회 → 없으면 생성"만으로는 동시 요청 둘이 모두 "없음"을 보고 통과하므로(READ COMMITTED),
 * 판정은 DB 제약에 맡기고 앱은 그 결과(P2002)를 해석만 한다:
 *  - 이긴 요청: 사본 + 기록이 한 트랜잭션으로 커밋된다.
 *  - 진 요청: INSERT가 이긴 쪽의 커밋을 기다렸다가 P2002로 실패 → 자기 사본까지 통째로 롤백되고,
 *    이긴 쪽이 만든 결과(같은 courseId)를 200으로 돌려받는다. 버튼 연타·재시도 모두 같은 응답이다.
 *
 * `Post.saves`는 앱이 건드리지 않는다 — PostSave INSERT/DELETE 트리거가 유지한다
 * (migrations/20261109000000_post_saves_counter_trigger). 사용자 삭제 CASCADE처럼 앱을 거치지 않는
 * 경로까지 덮기 위해서다.
 */
router.post("/:id/save", requireAuth, asyncHandler(async (req, res) => {
  const viewerId = req.userId!;
  const post = await prisma.post.findUnique({
    where: { id: req.params.id },
    include: postWithRelations,
  });
  if (!post) return res.status(404).json({ error: "게시물을 찾을 수 없어요" });
  if (post.userId === viewerId) {
    return res.status(400).json({ error: "내 코스는 담을 수 없어요" });
  }

  // 빠른 경로: 이미 담겨 있으면 트랜잭션 없이 끝낸다(순차 재전송의 대부분이 여기서 걸린다).
  // 정합성은 이 조회가 아니라 아래의 유니크 제약이 보장한다.
  const existing = await prisma.postSave.findUnique({
    where: { userId_postId: { userId: viewerId, postId: post.id } },
    select: { courseId: true },
  });
  if (existing) return res.json({ saves: post.saves, saved: true, courseId: existing.courseId });

  // 원본 코스는 참고용이라 없어도 담기는 그대로 진행된다.
  const origin = post.courseId
    ? await prisma.course.findUnique({
        where: { id: post.courseId },
        select: {
          emoji: true,
          transport: true,
          days: { orderBy: { dayIndex: "asc" }, select: { stops: { select: { order: true } } } },
        },
      })
    : null;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // 사본을 먼저 만들고 기록을 마지막에 넣는다. 기록 INSERT가 트리거로 Post 행을 잠그므로,
      // 순서를 이렇게 두면 인기 글의 Post 행 잠금이 트랜잭션 끝부분에만 짧게 잡힌다
      // (서로 다른 사용자의 동시 담기가 이 잠금에서 직렬화된다).
      const course = await tx.course.create({
        data: { ...buildSavedCourseData(post, origin), userId: viewerId },
        select: { id: true },
      });
      await tx.postSave.create({
        data: { userId: viewerId, postId: post.id, courseId: course.id },
      });
      // 트리거가 같은 트랜잭션 안에서 올린 값이 그대로 보인다.
      const { saves } = await tx.post.findUniqueOrThrow({
        where: { id: post.id },
        select: { saves: true },
      });
      return { saves, saved: true, courseId: course.id };
    });
    return res.json(result);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // 같은 사용자의 동시 요청이 먼저 담았다 — 이 요청의 사본은 이미 롤백됐고, 이긴 쪽 결과를 돌려준다.
    return res.json(await loadSaveState(post.id, viewerId));
  }
}));

/**
 * DELETE /api/posts/:id/save — 담기 취소. 보관함 사본도 함께 지운다. **멱등**이다.
 *
 * 사본을 남겨두면 "담기를 껐는데 보관함에는 그대로"인 상태가 되어 되돌릴 방법이 없어진다.
 * 사용자가 보관함에서 먼저 지웠다면 courseId가 null이라(SetNull) 기록만 걷어낸다.
 *
 * 잠금 순서가 핵심이다: **Course → PostSave**. 코스 직접 삭제(DELETE /api/courses/:id)는 Course 행을
 * 지운 뒤 FK의 ON DELETE SET NULL로 PostSave 행을 갱신하므로 이 순서로 잠근다. 예전처럼 PostSave를
 * 먼저 지우고 Course를 지우면 두 요청이 서로의 잠금을 기다리는 교착(40P01)이 실제로 발생했다.
 *
 * 삭제는 전부 deleteMany(0행이어도 예외 없음)로 한다 — 동시 취소에서 진 쪽이 "이미 없음"을
 * P2025 예외가 아니라 정상 결과(saved:false)로 받게 하기 위해서다. saves는 트리거가 내린다.
 */
router.delete("/:id/save", requireAuth, asyncHandler(async (req, res) => {
  const viewerId = req.userId!;
  const post = await prisma.post.findUnique({
    where: { id: req.params.id },
    select: { id: true },
  });
  if (!post) return res.status(404).json({ error: "게시물을 찾을 수 없어요" });

  const result = await prisma.$transaction(async (tx) => {
    // 잠그지 않는 조회 — 어떤 사본을 지울지만 알아낸다.
    const existing = await tx.postSave.findUnique({
      where: { userId_postId: { userId: viewerId, postId: post.id } },
      select: { courseId: true },
    });
    if (existing?.courseId) {
      // 1) Course 행 잠금·삭제. 소유자 조건을 같이 걸어 남의 코스는 절대 지우지 않는다.
      await tx.course.deleteMany({ where: { id: existing.courseId, userId: viewerId } });
    }
    // 2) PostSave 행 삭제. 동시 취소 중 실제로 지운 요청만 count=1을 얻고 트리거가 saves를 1 내린다.
    await tx.postSave.deleteMany({ where: { userId: viewerId, postId: post.id } });

    const fresh = await tx.post.findUnique({ where: { id: post.id }, select: { saves: true } });
    return { saves: fresh?.saves ?? 0, saved: false };
  });

  res.json(result);
}));

/** 글에서 고칠 수 있는 건 소개 글귀뿐이다 — 동선(stops)은 보관함 코스에서 박제된 값이라 건드리지 않는다. */
type PostUpdateInput = { caption?: string; text?: string };

function validatePostUpdateInput(body: unknown): body is PostUpdateInput {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  if (b.caption !== undefined && (typeof b.caption !== "string" || b.caption.trim().length === 0)) {
    return false;
  }
  if (b.text !== undefined && typeof b.text !== "string") return false;
  // 둘 다 안 온 요청은 고칠 게 없다 — 조용히 200을 주면 저장된 줄 알고 넘어간다.
  return b.caption !== undefined || b.text !== undefined;
}

// PATCH /api/posts/:id — 내 글 수정. 남의 글이면 삭제와 마찬가지로 존재 여부도 알리지 않고 404.
router.patch("/:id", requireAuth, asyncHandler(async (req, res) => {
  if (!validatePostUpdateInput(req.body)) {
    return res.status(400).json({ error: "수정할 내용이 올바르지 않아요" });
  }
  const input = req.body;

  const existing = await prisma.post.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.userId !== req.userId) {
    return res.status(404).json({ error: "게시물을 찾을 수 없어요" });
  }

  const updated = await prisma.post.update({
    where: { id: existing.id },
    data: { caption: input.caption?.trim(), text: input.text },
    include: postWithRelations,
  });

  res.json(toFeedPost(updated, req.userId, await loadSavedPostIds(req.userId, [updated.id])));
}));

// DELETE /api/posts/:id — 내 글 삭제. 남의 글이면 존재 여부도 알리지 않고 404로 통일한다.
router.delete("/:id", requireAuth, asyncHandler(async (req, res) => {
  const existing = await prisma.post.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.userId !== req.userId) {
    return res.status(404).json({ error: "게시물을 찾을 수 없어요" });
  }

  await prisma.post.delete({ where: { id: req.params.id } });
  res.status(204).send();
}));

export default router;
