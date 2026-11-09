import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { optionalAuth } from "../middleware/optionalAuth";
import { asyncHandler } from "../lib/asyncHandler";

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

// GET /api/reviews?placeId=xxx — 장소 상세의 후기 목록. 비로그인도 볼 수 있고, 로그인했으면 isMine이 붙는다.
router.get("/", optionalAuth, asyncHandler(async (req, res) => {
  const { placeId } = req.query;
  const rows = await prisma.review.findMany({
    where: typeof placeId === "string" ? { placeId } : undefined,
    orderBy: { createdAt: "desc" },
    include: reviewWithRelations,
  });
  res.json(rows.map((row) => toReview(row, req.userId)));
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
