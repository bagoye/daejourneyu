import { authFetch } from "./authFetch";
import type { Review, ReviewTagOption } from "@/types";

/**
 * GET /api/reviews?mine=true — 내가 쓴 후기 전체(로그인 필요).
 * 예전엔 전 사용자 후기를 받아 화면에서 isMine으로 걸렀다. 한 사용자 분량이라 끊지 않고 다 받는다
 * (뱃지 계산이 전체 개수를 쓴다).
 */
export async function fetchMyReviewsApi(): Promise<Review[]> {
  const res = await authFetch("/api/reviews?mine=true");
  if (!res.ok) throw new Error(`GET /api/reviews?mine=true → ${res.status}`);
  return res.json();
}

/** 장소 후기 한 페이지. nextCursor가 null이면 마지막 페이지다. */
export interface ReviewPage {
  items: Review[];
  nextCursor: string | null;
}

export const PLACE_REVIEWS_PAGE_SIZE = 10;

/** GET /api/reviews?placeId=&limit=&cursor= — 장소 상세 후기를 최신순으로 끊어서 받는다(사진이 data URL이라 무겁다). */
export async function fetchPlaceReviewsPageApi(placeId: string, cursor: string | null): Promise<ReviewPage> {
  const query = new URLSearchParams({ placeId, limit: String(PLACE_REVIEWS_PAGE_SIZE) });
  if (cursor) query.set("cursor", cursor);
  const res = await authFetch(`/api/reviews?${query}`);
  if (!res.ok) throw new Error(`GET /api/reviews → ${res.status}`);
  return res.json();
}

/** GET /api/reviews/tags — 후기 작성 화면이 고를 수 있는 태그 사전(분야별로 정렬돼 내려온다). */
export async function fetchReviewTagsApi(): Promise<ReviewTagOption[]> {
  const res = await authFetch("/api/reviews/tags");
  if (!res.ok) throw new Error(`GET /api/reviews/tags → ${res.status}`);
  return res.json();
}

/** 후기 작성 — 사진·본문은 선택, tagCodes는 1~5개(서버가 다시 검증한다). */
export type ReviewCreateInput = {
  placeId: string;
  placeName: string;
  text?: string;
  photoUrl?: string;
  tagCodes: string[];
};

export async function createReviewApi(input: ReviewCreateInput): Promise<Review> {
  const res = await authFetch("/api/reviews", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error("후기를 등록하지 못했어요");
  return res.json();
}

/** 내 후기 삭제 — 남의 후기면 서버가 404로 통일해 응답한다. */
export async function deleteReviewApi(id: string): Promise<void> {
  const res = await authFetch(`/api/reviews/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("후기를 삭제하지 못했어요");
}
