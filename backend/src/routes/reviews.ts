import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { optionalAuth } from "../middleware/optionalAuth";
import { asyncHandler } from "../lib/asyncHandler";
import { cursorDate, decodeCursor, encodeCursor, InvalidCursorError } from "../lib/cursor";

/** 프론트 src/types/review.ts의 ReviewTagOption과 필드명을 맞춘다. */
type ReviewTagOption = {
  code: string;
  label: string;
  category: string;
};

type Review = {
  id: string;
  placeId: string;
  placeName: string;
  authorId: string;
  authorName: string;
  isMine: boolean;
  text: string;
  tags: ReviewTagOption[];
  photoUrl?: string;
  likes: number;
  liked: boolean;
  createdAtLabel: string;
};

const reviewWithRelations = {
  author: { select: { nickname: true } },
  tags: { include: { tag: true } },
};

type ReviewRow = Prisma.ReviewGetPayload<{ include: typeof reviewWithRelations }>;

/** "2일 전" 같은 상대시간 라벨. 목데이터(mocks/reviews.ts)가 쓰던 표기를 그대로 따른다. */
function toRelativeLabel(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return "오늘";
  if (diffDays < 7) return `${diffDays}일 전`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}주 전`;
  return `${Math.floor(diffDays / 30)}개월 전`;
}

function toReview(row: ReviewRow, viewerId: string | undefined): Review {
  return {
    id: row.id,
    placeId: row.placeId,
    placeName: row.placeName,
    authorId: row.authorId,
    authorName: row.author.nickname,
    isMine: viewerId !== undefined && row.authorId === viewerId,
    text: row.text,
    tags: row.tags
      .map((t) => t.tag)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((tag) => ({ code: tag.code, label: tag.label, category: tag.category })),
    ...(row.photoUrl ? { photoUrl: row.photoUrl } : {}),
    likes: row.likesCount,
    // TODO(api): 좋아요 토글이 서버로 넘어오기 전까지는 항상 false로 내려간다(Post.liked와 동일한 임시 처리).
    liked: false,
    createdAtLabel: toRelativeLabel(row.createdAt),
  };
}

const MIN_TAGS = 1;
const MAX_TAGS = 5;

type ReviewCreateInput = {
  placeId: string;
  placeName: string;
  text?: string;
  photoUrl?: string;
  tagCodes: string[];
};

function validateReviewInput(body: unknown): body is ReviewCreateInput {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  if (typeof b.placeId !== "string" || b.placeId.trim().length === 0) return false;
  if (typeof b.placeName !== "string" || b.placeName.trim().length === 0) return false;
  if (b.text !== undefined && typeof b.text !== "string") return false;
  if (b.photoUrl !== undefined && typeof b.photoUrl !== "string") return false;
  if (!Array.isArray(b.tagCodes) || !b.tagCodes.every((code) => typeof code === "string")) return false;
  // 사진·본문은 선택이지만 태그는 최소 1개~최대 5개가 유일한 필수값이다.
  return b.tagCodes.length >= MIN_TAGS && b.tagCodes.length <= MAX_TAGS;
}

const router = Router();

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
/** limit 없는 예전 형식 요청의 상한(내 후기 제외). */
const LEGACY_LIST_CAP = 100;
const REVIEW_CURSOR_SHAPE: ("string" | "number")[] = ["string", "string"]; // createdAt(ISO), id

function firstQueryValue(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return undefined;
}

/**
 * GET /api/reviews — 후기 목록. 비로그인도 볼 수 있고, 로그인했으면 isMine이 붙는다.
 *
 *  - `placeId=xxx`: 장소 상세용.
 *  - `mine=true`: 내가 쓴 후기만(로그인 필요). 예전엔 마이탭이 **전 사용자 후기 전체**를 받아 화면에서
 *    isMine으로 걸렀다 — 후기 수에 비례해 응답이 커지고, 목록에 data URL 사진까지 실려 있었다.
 *  - `limit`(+`cursor`): 보내면 `{ items, nextCursor }`로 끊어서 준다. 보내지 않으면 예전처럼 배열
 *    (하위 호환, 최신 100건 상한). 내 후기는 사용자 한 명 분량이라 뱃지 계산이 전체를 쓰고, 장소 후기는 사진 때문에 끊는다.
 *
 * 정렬은 createdAt 내림차순 + id(동시각 동점 정리). 커서는 lib/cursor.ts의 값 기반 커서다.
 */
router.get("/", optionalAuth, asyncHandler(async (req, res) => {
  const placeId = firstQueryValue(req.query.placeId);
  const mine = firstQueryValue(req.query.mine) === "true";
  const rawLimit = firstQueryValue(req.query.limit);
  const rawCursor = firstQueryValue(req.query.cursor);

  if (mine && !req.userId) {
    return res.status(401).json({ error: "로그인이 필요해요" });
  }

  const filters: Prisma.ReviewWhereInput[] = [];
  if (placeId) filters.push({ placeId });
  if (mine) filters.push({ authorId: req.userId! });
  const orderBy: Prisma.ReviewOrderByWithRelationInput[] = [{ createdAt: "desc" }, { id: "desc" }];

  // 하위 호환: limit이 없으면 예전 응답 모양(배열). 단 내 후기가 아니면 최신 LEGACY_LIST_CAP건까지만 준다 —
  // 상한이 없으면 파라미터 없는 요청 하나가 전 사용자 후기를 통째로 받아 간다(10만 건 기준 133MB · 6.3초,
  // 느린 쿼리 로그로 발견). 지금 프론트는 이 형식을 쓰지 않고, 캐시된 옛 PWA 클라이언트만 여기로 온다.
  if (rawLimit === undefined) {
    const rows = await prisma.review.findMany({
      where: filters.length > 0 ? { AND: filters } : undefined,
      orderBy,
      include: reviewWithRelations,
      ...(mine ? {} : { take: LEGACY_LIST_CAP }),
    });
    return res.json(rows.map((row) => toReview(row, req.userId)));
  }

  const parsed = Number(rawLimit);
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), MAX_LIMIT) : DEFAULT_LIMIT;

  if (rawCursor) {
    let values;
    try {
      values = decodeCursor(rawCursor, REVIEW_CURSOR_SHAPE);
      if (!values) throw new InvalidCursorError();
      const createdAt = cursorDate(values[0]!);
      const id = String(values[1]);
      filters.push({ OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }] });
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        return res.status(400).json({ error: "목록 위치 정보가 올바르지 않아요" });
      }
      throw err;
    }
  }

  const rows = await prisma.review.findMany({
    where: filters.length > 0 ? { AND: filters } : undefined,
    orderBy,
    take: limit,
    include: reviewWithRelations,
  });
  const last = rows[rows.length - 1];
  res.json({
    items: rows.map((row) => toReview(row, req.userId)),
    nextCursor: rows.length === limit && last ? encodeCursor([last.createdAt.toISOString(), last.id]) : null,
  });
}));

// GET /api/reviews/tags — 후기 작성 화면이 쓰는 태그 사전(분야별로 이미 정렬해 내려준다).
// 자유 문자열 태그를 막기 위한 유일한 출처이므로, 여기 없는 code는 POST에서 전부 거부된다.
router.get("/tags", asyncHandler(async (_req, res) => {
  const tags = await prisma.reviewTagOption.findMany({
    where: { isActive: true },
    orderBy: [{ category: "asc" }, { sortOrder: "asc" }],
  });
  res.json(tags.map((t) => ({ code: t.code, label: t.label, category: t.category })));
}));

// POST /api/reviews — 후기 작성. 사진·본문은 선택, 태그는 1~5개 필수(사전에 없는 code는 거부).
router.post("/", requireAuth, asyncHandler(async (req, res) => {
  if (!validateReviewInput(req.body)) {
    return res.status(400).json({ error: "태그는 1~5개, 형식에 맞게 보내주세요" });
  }
  const input = req.body;

  const activeTags = await prisma.reviewTagOption.findMany({
    where: { code: { in: input.tagCodes }, isActive: true },
  });
  if (activeTags.length !== new Set(input.tagCodes).size) {
    return res.status(400).json({ error: "선택할 수 없는 태그가 포함돼 있어요" });
  }

  const created = await prisma.review.create({
    data: {
      placeId: input.placeId,
      placeName: input.placeName,
      text: input.text ?? "",
      photoUrl: input.photoUrl ?? null,
      authorId: req.userId!,
      tags: { create: activeTags.map((tag) => ({ tagId: tag.id })) },
    },
    include: reviewWithRelations,
  });

  res.status(201).json(toReview(created, req.userId));
}));

// DELETE /api/reviews/:id — 내 후기 삭제. 남의 후기면 존재 여부도 알리지 않고 404로 통일한다.
router.delete("/:id", requireAuth, asyncHandler(async (req, res) => {
  const existing = await prisma.review.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.authorId !== req.userId) {
    return res.status(404).json({ error: "후기를 찾을 수 없어요" });
  }

  await prisma.review.delete({ where: { id: req.params.id } });
  res.status(204).send();
}));

export default router;
