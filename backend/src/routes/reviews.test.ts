import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    review: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), delete: vi.fn() },
    reviewTagOption: { findMany: vi.fn() },
  },
}));

vi.mock("../lib/prisma", () => ({ prisma }));
vi.mock("../lib/auth", () => ({
  ACCESS_TOKEN_COOKIE: "daejourneyu_token",
  // 실제 JWT 대신 "valid:<userId>" 토큰만 통과시킨다 — JWT_SECRET 없이 로그인 상태를 흉내 낸다.
  verifyAccessToken: (token: string) =>
    token.startsWith("valid:") ? { userId: token.slice("valid:".length) } : null,
}));

import reviewsRouter from "./reviews";

const AS_USER_1 = "daejourneyu_token=valid:user-1";
const INCLUDE = { author: { select: { nickname: true } }, tags: { include: { tag: true } } };
const NOW = new Date("2026-09-14T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function tagOption(code: string, sortOrder: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `tag-${code}`,
    code,
    label: `라벨 ${code}`,
    category: "PET_CONDITION",
    sortOrder,
    isActive: true,
    ...overrides,
  };
}

function reviewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "review-1",
    placeId: "place-1",
    placeName: "한밭수목원",
    text: "그늘이 많아요",
    photoUrl: null,
    likesCount: 3,
    createdAt: new Date(NOW.getTime() - 2 * DAY),
    updatedAt: NOW,
    authorId: "author-1",
    author: { nickname: "콩이네" },
    // 저장 순서와 상관없이 사전의 sortOrder대로 내려가야 한다.
    tags: [
      { reviewId: "review-1", tagId: "tag-B", tag: tagOption("B", 2) },
      { reviewId: "review-1", tagId: "tag-A", tag: tagOption("A", 1, { category: "CAUTION" }) },
    ],
    ...overrides,
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/reviews", reviewsRouter);
  return app;
}

const app = createApp();

beforeEach(() => {
  vi.resetAllMocks();
  prisma.review.findMany.mockResolvedValue([]);
  prisma.reviewTagOption.findMany.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/reviews", () => {
  it("비로그인도 최신순 전체를 받고, 화면 필드 모양으로 내려준다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    prisma.review.findMany.mockResolvedValue([reviewRow()]);

    const res = await request(app).get("/api/reviews");

    expect(res.status).toBe(200);
    expect(prisma.review.findMany).toHaveBeenCalledWith({
      where: undefined,
      // 같은 시각에 쓴 후기도 순서가 흔들리지 않게 id로 동점을 정리한다
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: INCLUDE,
    });
    expect(res.body).toEqual([
      {
        id: "review-1",
        placeId: "place-1",
        placeName: "한밭수목원",
        authorId: "author-1",
        authorName: "콩이네",
        isMine: false,
        text: "그늘이 많아요",
        tags: [
          { code: "A", label: "라벨 A", category: "CAUTION" },
          { code: "B", label: "라벨 B", category: "PET_CONDITION" },
        ],
        likes: 3,
        liked: false,
        createdAtLabel: "2일 전",
      },
    ]);
  });

  it("장소를 넘기면 그 장소만 거른다", async () => {
    await request(app).get("/api/reviews?placeId=place-7");

    expect(prisma.review.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { AND: [{ placeId: "place-7" }] } })
    );
  });

  it("mine=true면 DB에서 내 후기만 고른다(전체를 받아 화면에서 거르지 않는다)", async () => {
    await request(app).get("/api/reviews?mine=true").set("Cookie", AS_USER_1);

    expect(prisma.review.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { AND: [{ authorId: "user-1" }] } })
    );
  });

  it("mine=true는 로그인이 필요하다", async () => {
    expect((await request(app).get("/api/reviews?mine=true")).status).toBe(401);
    expect(prisma.review.findMany).not.toHaveBeenCalled();
  });

  it("limit을 보내면 끊어서 주고, 꽉 채웠으면 마지막 후기 위치를 다음 커서로 준다", async () => {
    prisma.review.findMany.mockResolvedValue([
      reviewRow({ id: "r1", createdAt: new Date("2026-09-10T00:00:00.000Z") }),
      reviewRow({ id: "r2", createdAt: new Date("2026-09-09T00:00:00.000Z") }),
    ]);

    const res = await request(app).get("/api/reviews?placeId=place-1&limit=2");

    expect(prisma.review.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }));
    expect(res.body.items.map((r: { id: string }) => r.id)).toEqual(["r1", "r2"]);
    expect(res.body.nextCursor).toEqual(expect.stringMatching(/^v1./));

    // 받은 커서로 이어 받으면 "그 시각·id보다 뒤" 조건이 붙는다
    prisma.review.findMany.mockResolvedValue([]);
    const next = await request(app).get(
      `/api/reviews?placeId=place-1&limit=2&cursor=${encodeURIComponent(res.body.nextCursor)}`
    );
    expect(next.body).toEqual({ items: [], nextCursor: null });
    const createdAt = new Date("2026-09-09T00:00:00.000Z");
    expect(prisma.review.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            { placeId: "place-1" },
            { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: "r2" } }] },
          ],
        },
      })
    );
  });

  it("해석할 수 없는 커서는 400", async () => {
    const res = await request(app).get("/api/reviews?limit=2&cursor=garbage");
    expect(res.status).toBe(400);
  });

  it("로그인하면 내 후기에 표시를 붙이고, 사진이 있으면 싣는다", async () => {
    prisma.review.findMany.mockResolvedValue([
      reviewRow({ id: "mine", authorId: "user-1", photoUrl: "data:image/png;base64,AAA" }),
      reviewRow({ id: "other" }),
    ]);

    const res = await request(app).get("/api/reviews").set("Cookie", AS_USER_1);

    expect(res.body[0]).toMatchObject({ id: "mine", isMine: true, photoUrl: "data:image/png;base64,AAA" });
    expect(res.body[1]).toMatchObject({ id: "other", isMine: false });
    expect(res.body[1]).not.toHaveProperty("photoUrl");
  });

  it("작성 시각을 오늘·N일 전·N주 전·N개월 전으로 줄인다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const ago = (ms: number) => reviewRow({ createdAt: new Date(NOW.getTime() - ms) });
    prisma.review.findMany.mockResolvedValue([
      ago(60 * 60 * 1000),
      ago(6 * DAY),
      ago(14 * DAY),
      ago(65 * DAY),
    ]);

    const res = await request(app).get("/api/reviews");

    expect(res.body.map((review: { createdAtLabel: string }) => review.createdAtLabel)).toEqual([
      "오늘",
      "6일 전",
      "2주 전",
      "2개월 전",
    ]);
  });
});

describe("GET /api/reviews/tags", () => {
  it("활성 태그만 분야·순서대로 받아 code·label·category만 내려준다", async () => {
    prisma.reviewTagOption.findMany.mockResolvedValue([tagOption("A", 1), tagOption("B", 2)]);

    const res = await request(app).get("/api/reviews/tags");

    expect(prisma.reviewTagOption.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: [{ category: "asc" }, { sortOrder: "asc" }],
    });
    expect(res.body).toEqual([
      { code: "A", label: "라벨 A", category: "PET_CONDITION" },
      { code: "B", label: "라벨 B", category: "PET_CONDITION" },
    ]);
  });
});

describe("POST /api/reviews", () => {
  const validBody = { placeId: "place-1", placeName: "한밭수목원", tagCodes: ["A", "B"] };

  it("로그인이 필요하다", async () => {
    expect((await request(app).post("/api/reviews").send(validBody)).status).toBe(401);
  });

  it.each([
    ["태그 0개", { ...validBody, tagCodes: [] }],
    ["태그 6개", { ...validBody, tagCodes: ["A", "B", "C", "D", "E", "F"] }],
    ["빈 장소 이름", { ...validBody, placeName: " " }],
    ["문자열이 아닌 본문", { ...validBody, text: 3 }],
    ["문자열이 아닌 태그", { ...validBody, tagCodes: [1] }],
  ])("%s은 400", async (_label, body) => {
    const res = await request(app).post("/api/reviews").set("Cookie", AS_USER_1).send(body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "태그는 1~5개, 형식에 맞게 보내주세요" });
    expect(prisma.review.create).not.toHaveBeenCalled();
  });

  it("사전에 없거나 비활성인 태그가 섞이면 400", async () => {
    prisma.reviewTagOption.findMany.mockResolvedValue([tagOption("A", 1)]);

    const res = await request(app).post("/api/reviews").set("Cookie", AS_USER_1).send(validBody);

    expect(prisma.reviewTagOption.findMany).toHaveBeenCalledWith({
      where: { code: { in: ["A", "B"] }, isActive: true },
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "선택할 수 없는 태그가 포함돼 있어요" });
    expect(prisma.review.create).not.toHaveBeenCalled();
  });

  it("같은 태그를 두 번 보내도 한 번으로 친다", async () => {
    prisma.reviewTagOption.findMany.mockResolvedValue([tagOption("A", 1)]);
    prisma.review.create.mockResolvedValue(reviewRow({ authorId: "user-1" }));

    const res = await request(app)
      .post("/api/reviews")
      .set("Cookie", AS_USER_1)
      .send({ ...validBody, tagCodes: ["A", "A"] });

    expect(res.status).toBe(201);
  });

  it("본문·사진은 비워도 되고, 태그를 연결해 201로 내 후기를 돌려준다", async () => {
    prisma.reviewTagOption.findMany.mockResolvedValue([tagOption("A", 1), tagOption("B", 2)]);
    prisma.review.create.mockResolvedValue(reviewRow({ authorId: "user-1" }));

    const res = await request(app).post("/api/reviews").set("Cookie", AS_USER_1).send(validBody);

    expect(res.status).toBe(201);
    expect(prisma.review.create).toHaveBeenCalledWith({
      data: {
        placeId: "place-1",
        placeName: "한밭수목원",
        text: "",
        photoUrl: null,
        authorId: "user-1",
        tags: { create: [{ tagId: "tag-A" }, { tagId: "tag-B" }] },
      },
      include: INCLUDE,
    });
    expect(res.body).toMatchObject({ id: "review-1", isMine: true });
  });
});

describe("DELETE /api/reviews/:id", () => {
  it("로그인이 필요하다", async () => {
    expect((await request(app).delete("/api/reviews/review-1")).status).toBe(401);
  });

  it("없거나 남의 후기면 404로 통일한다", async () => {
    prisma.review.findUnique.mockResolvedValueOnce(null);
    expect((await request(app).delete("/api/reviews/gone").set("Cookie", AS_USER_1)).status).toBe(404);

    prisma.review.findUnique.mockResolvedValueOnce({ id: "review-1", authorId: "someone-else" });
    const res = await request(app).delete("/api/reviews/review-1").set("Cookie", AS_USER_1);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "후기를 찾을 수 없어요" });

    expect(prisma.review.delete).not.toHaveBeenCalled();
  });

  it("내 후기는 지우고 204", async () => {
    prisma.review.findUnique.mockResolvedValue({ id: "review-1", authorId: "user-1" });

    const res = await request(app).delete("/api/reviews/review-1").set("Cookie", AS_USER_1);

    expect(res.status).toBe(204);
    expect(prisma.review.delete).toHaveBeenCalledWith({ where: { id: "review-1" } });
  });
});
