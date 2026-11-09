import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma } = vi.hoisted(() => {
  const model = () => ({
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  });
  return { prisma: { post: model(), postSave: model(), course: model(), $transaction: vi.fn() } };
});

vi.mock("../lib/prisma", () => ({ prisma }));
vi.mock("../lib/auth", () => ({
  ACCESS_TOKEN_COOKIE: "daejourneyu_token",
  // 실제 JWT 대신 "valid:<userId>" 토큰만 통과시킨다 — JWT_SECRET 없이 로그인 상태를 흉내 낸다.
  verifyAccessToken: (token: string) =>
    token.startsWith("valid:") ? { userId: token.slice("valid:".length) } : null,
}));

import postsRouter from "./posts";

const AS_USER_1 = "daejourneyu_token=valid:user-1";
const INCLUDE = { stops: { orderBy: { order: "asc" } } };

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/posts", postsRouter);
  return app;
}

function stopRow(order: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `stop-${order}`,
    order,
    placeId: `place-${order}`,
    name: `장소 ${order}`,
    category: "산책",
    district: "서구",
    condition: "전 견종",
    petFriendly: true,
    imageUrl: null,
    postId: "post-1",
    ...overrides,
  };
}

function postRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "post-1",
    caption: "서구 산책 코스",
    text: "좋았어요",
    tags: ["당일치기", "서구"],
    authorName: "콩이네",
    authorEmoji: "🐶",
    petTypeName: "정겹게 달려가는 페스티벌맨",
    likes: 2,
    saves: 3,
    createdAt: new Date("2026-08-12T09:00:00.000Z"),
    userId: "author-1",
    courseId: null,
    stops: [stopRow(0), stopRow(1)],
    ...overrides,
  };
}

const app = createApp();

beforeEach(() => {
  vi.resetAllMocks();
  prisma.post.findMany.mockResolvedValue([]);
  prisma.post.count.mockResolvedValue(0);
  prisma.postSave.findMany.mockResolvedValue([]);
  // 트랜잭션 안의 tx도 같은 mock을 쓴다 — 무엇이 어떤 순서로 불렸는지만 확인하면 된다.
  prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma));
});

describe("GET /api/posts", () => {
  it("비로그인도 담긴순 첫 페이지를 받고, 화면 필드 모양으로 내려준다", async () => {
    prisma.post.findMany.mockResolvedValue([postRow()]);
    prisma.post.count.mockResolvedValue(1);

    const res = await request(app).get("/api/posts");

    expect(res.status).toBe(200);
    expect(prisma.post.findMany).toHaveBeenCalledWith({
      where: undefined,
      orderBy: [{ saves: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: 10,
      include: INCLUDE,
    });
    expect(res.body).toEqual({
      items: [
        {
          id: "post-1",
          authorName: "콩이네",
          authorEmoji: "🐶",
          petTypeName: "정겹게 달려가는 페스티벌맨",
          isMine: false,
          caption: "서구 산책 코스",
          text: "좋았어요",
          stops: [0, 1].map((order) => ({
            placeId: `place-${order}`,
            name: `장소 ${order}`,
            category: "산책",
            district: "서구",
            condition: "전 견종",
            petFriendly: true,
            imageUrl: null,
          })),
          tags: ["당일치기", "서구"],
          likes: 2,
          liked: false,
          saves: 3,
          saved: false,
          createdAt: "2026-08-12T09:00:00.000Z",
        },
      ],
      nextCursor: null,
      total: 1,
    });
    // 비로그인은 담기 상태를 조회할 필요가 없다.
    expect(prisma.postSave.findMany).not.toHaveBeenCalled();
  });

  it("최신순 정렬과 개수 제한(최대 50, 이상한 값은 기본 10)을 지킨다", async () => {
    await request(app).get("/api/posts?sort=recent&limit=100");
    expect(prisma.post.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50 })
    );

    await request(app).get("/api/posts?limit=abc");
    expect(prisma.post.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 10 }));

    await request(app).get("/api/posts?limit=3.7");
    expect(prisma.post.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 3 }));
  });

  it("내 글은 로그인이 필요하다", async () => {
    const res = await request(app).get("/api/posts?mine=true");

    expect(res.status).toBe(401);
    expect(prisma.post.findMany).not.toHaveBeenCalled();
  });

  it("로그인하면 내 글만 거르고, 내 글·담은 글 표시를 붙인다", async () => {
    prisma.post.findMany.mockResolvedValue([
      postRow({ id: "mine", userId: "user-1" }),
      postRow({ id: "saved", userId: "author-2" }),
    ]);
    prisma.postSave.findMany.mockResolvedValue([{ postId: "saved" }]);

    const res = await request(app).get("/api/posts?mine=true").set("Cookie", AS_USER_1);

    expect(prisma.post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { AND: [{ userId: "user-1" }] } })
    );
    expect(prisma.postSave.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1", postId: { in: ["mine", "saved"] } },
      select: { postId: true },
    });
    expect(res.body.items.map((item: { id: string; isMine: boolean; saved: boolean }) => [item.id, item.isMine, item.saved])).toEqual([
      ["mine", true, false],
      ["saved", false, true],
    ]);
  });

  it("검색어가 있으면 유형 필터를 무시하고 제목·소개·작성자·태그·장소를 훑는다", async () => {
    await request(app).get("/api/posts?q=%20한빛탑%20&sameType=유형");

    const { where } = prisma.post.findMany.mock.calls[0][0];
    expect(where.AND).toHaveLength(1);
    expect(where.AND[0].OR).toEqual([
      { caption: { contains: "한빛탑", mode: "insensitive" } },
      { text: { contains: "한빛탑", mode: "insensitive" } },
      { authorName: { contains: "한빛탑", mode: "insensitive" } },
      { tags: { has: "한빛탑" } },
      { stops: { some: { name: { contains: "한빛탑", mode: "insensitive" } } } },
      { stops: { some: { district: { contains: "한빛탑", mode: "insensitive" } } } },
    ]);
  });

  it("검색어가 없으면 유형 필터를 건다", async () => {
    await request(app).get("/api/posts?sameType=유형");

    expect(prisma.post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { AND: [{ petTypeName: "유형" }] } })
    );
  });

  it("커서가 가리키는 글이 지워졌으면 목록의 끝으로 처리한다", async () => {
    prisma.post.findUnique.mockResolvedValue(null);

    const res = await request(app).get("/api/posts?cursor=gone");

    expect(res.body).toEqual({ items: [], nextCursor: null });
    expect(prisma.post.findMany).not.toHaveBeenCalled();
  });

  it("커서 다음부터 이어 받고, 이어 받을 때는 전체 건수를 세지 않는다", async () => {
    prisma.post.findUnique.mockResolvedValue({ id: "post-9" });

    const res = await request(app).get("/api/posts?cursor=post-9");

    expect(prisma.post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: "post-9" }, skip: 1 })
    );
    expect(prisma.post.count).not.toHaveBeenCalled();
    expect(res.body).not.toHaveProperty("total");
  });

  it("요청한 만큼 꽉 채워 왔으면 마지막 글 id를 다음 커서로 준다", async () => {
    prisma.post.findMany.mockResolvedValue([postRow({ id: "a" }), postRow({ id: "b" })]);

    const res = await request(app).get("/api/posts?limit=2");

    expect(res.body.nextCursor).toBe("b");
  });
});

describe("GET /api/posts/:id", () => {
  it("없으면 404", async () => {
    prisma.post.findUnique.mockResolvedValue(null);

    const res = await request(app).get("/api/posts/gone");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "게시물을 찾을 수 없어요" });
  });

  it("있으면 뷰어 기준 표시를 붙이고, 코스에서 올린 글엔 courseId를 싣는다", async () => {
    prisma.post.findUnique.mockResolvedValue(postRow({ userId: "user-1", courseId: "course-1" }));
    prisma.postSave.findMany.mockResolvedValue([]);

    const res = await request(app).get("/api/posts/post-1").set("Cookie", AS_USER_1);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "post-1", isMine: true, saved: false, courseId: "course-1" });
  });
});

describe("POST /api/posts", () => {
  const validBody = {
    caption: "갑천 1박 코스",
    text: "좋았어요",
    tags: ["1박 2일", "유성구"],
    authorName: "콩이네",
    authorEmoji: "🐶",
    petTypeName: "유형",
    courseId: "course-1",
    stops: [
      { placeId: "a", name: "갑천", category: "산책", district: "유성구", condition: "전 견종", petFriendly: true },
      {
        placeId: "b",
        name: "카페",
        category: "맛집",
        district: "유성구",
        condition: "소형견",
        petFriendly: true,
        imageUrl: "https://example.com/b.jpg",
      },
    ],
  };

  it("로그인이 필요하다", async () => {
    const res = await request(app).post("/api/posts").send(validBody);
    expect(res.status).toBe(401);
  });

  it.each([
    ["방문 장소가 없는 글", { ...validBody, stops: [] }],
    ["형식이 틀린 장소", { ...validBody, stops: [{ ...validBody.stops[0], petFriendly: "yes" }] }],
    ["빈 코스 이름", { ...validBody, caption: "   " }],
    ["문자열이 아닌 태그", { ...validBody, tags: [1] }],
  ])("%s은 400", async (_label, body) => {
    const res = await request(app).post("/api/posts").set("Cookie", AS_USER_1).send(body);

    expect(res.status).toBe(400);
    expect(prisma.post.create).not.toHaveBeenCalled();
  });

  it("남의 코스로는 글을 올릴 수 없다", async () => {
    prisma.course.findUnique.mockResolvedValue({ id: "course-1", userId: "someone-else" });

    const res = await request(app).post("/api/posts").set("Cookie", AS_USER_1).send(validBody);

    expect(res.status).toBe(403);
    expect(prisma.post.create).not.toHaveBeenCalled();
  });

  it("코스가 이미 지워졌으면 연결만 비우고 올린다", async () => {
    prisma.course.findUnique.mockResolvedValue(null);
    prisma.post.create.mockResolvedValue(postRow({ userId: "user-1" }));

    const res = await request(app).post("/api/posts").set("Cookie", AS_USER_1).send(validBody);

    expect(res.status).toBe(201);
    expect(prisma.post.create.mock.calls[0][0].data.courseId).toBeNull();
  });

  it("장소 순서를 매겨 저장하고 201로 내 글을 돌려준다", async () => {
    prisma.course.findUnique.mockResolvedValue({ id: "course-1", userId: "user-1" });
    prisma.post.create.mockResolvedValue(postRow({ userId: "user-1", courseId: "course-1" }));

    const res = await request(app).post("/api/posts").set("Cookie", AS_USER_1).send(validBody);

    expect(res.status).toBe(201);
    expect(prisma.post.create).toHaveBeenCalledWith({
      data: {
        caption: "갑천 1박 코스",
        text: "좋았어요",
        tags: ["1박 2일", "유성구"],
        authorName: "콩이네",
        authorEmoji: "🐶",
        petTypeName: "유형",
        userId: "user-1",
        courseId: "course-1",
        stops: {
          create: [
            { ...validBody.stops[0], order: 0 },
            { ...validBody.stops[1], order: 1 },
          ],
        },
      },
      include: INCLUDE,
    });
    expect(res.body).toMatchObject({ isMine: true, saved: false, courseId: "course-1" });
  });
});

describe("POST /api/posts/:id/save", () => {
  it("로그인이 필요하다", async () => {
    expect((await request(app).post("/api/posts/post-1/save")).status).toBe(401);
  });

  it("없는 글은 404, 내 글은 담을 수 없어 400", async () => {
    prisma.post.findUnique.mockResolvedValueOnce(null);
    expect((await request(app).post("/api/posts/gone/save").set("Cookie", AS_USER_1)).status).toBe(404);

    prisma.post.findUnique.mockResolvedValueOnce(postRow({ userId: "user-1" }));
    const own = await request(app).post("/api/posts/post-1/save").set("Cookie", AS_USER_1);
    expect(own.status).toBe(400);
    expect(own.body).toEqual({ error: "내 코스는 담을 수 없어요" });
  });

  it("이미 담은 글이면 사본을 또 만들지 않고 현재 상태만 돌려준다", async () => {
    prisma.post.findUnique.mockResolvedValue(postRow());
    prisma.postSave.findUnique.mockResolvedValue({ id: "save-1", courseId: "copy-1" });

    const res = await request(app).post("/api/posts/post-1/save").set("Cookie", AS_USER_1);

    expect(res.body).toEqual({ saves: 3, saved: true, courseId: "copy-1" });
    expect(prisma.course.create).not.toHaveBeenCalled();
    expect(prisma.post.update).not.toHaveBeenCalled();
  });

  it("원본 코스의 일차 구분·이모지·이동수단을 살려 보관함 사본을 만들고, 트리거가 올린 담긴 수를 돌려준다", async () => {
    prisma.post.findUnique.mockResolvedValue(
      postRow({ courseId: "origin-1", stops: [stopRow(0), stopRow(1), stopRow(2)] })
    );
    prisma.course.findUnique.mockResolvedValue({
      emoji: "🌲",
      transport: "대중교통",
      days: [{ stops: [{ order: 0 }, { order: 1 }] }, { stops: [{ order: 0 }] }],
    });
    prisma.postSave.findUnique.mockResolvedValue(null);
    prisma.course.create.mockResolvedValue({ id: "copy-1" });
    prisma.post.findUniqueOrThrow.mockResolvedValue({ saves: 4 });

    const res = await request(app).post("/api/posts/post-1/save").set("Cookie", AS_USER_1);

    expect(res.body).toEqual({ saves: 4, saved: true, courseId: "copy-1" });

    const { data } = prisma.course.create.mock.calls[0][0];
    expect(data).toMatchObject({
      label: "서구 산책 코스",
      emoji: "🌲",
      nights: 1,
      transport: "대중교통",
      source: "saved",
      shared: false,
      userId: "user-1",
    });
    expect(
      data.days.create.map((day: { dayIndex: number; stops: { create: { placeId: string; order: number }[] } }) => [
        day.dayIndex,
        day.stops.create.map((stop) => `${stop.order}:${stop.placeId}`),
      ])
    ).toEqual([
      [0, ["0:place-0", "1:place-1"]],
      [1, ["0:place-2"]],
    ]);
    expect(prisma.postSave.create).toHaveBeenCalledWith({
      data: { userId: "user-1", postId: "post-1", courseId: "copy-1" },
    });
    // 담긴 수는 PostSave 트리거가 유지한다 — 앱이 직접 올리면 이중으로 늘어난다.
    expect(prisma.post.update).not.toHaveBeenCalled();
  });

  it("동시 요청에 져서 유니크 제약(P2002)에 걸리면 이긴 요청의 결과를 200으로 돌려준다", async () => {
    prisma.post.findUnique
      .mockResolvedValueOnce(postRow())
      .mockResolvedValueOnce({ saves: 5 });
    // 빠른 경로에서는 아직 없었지만, 트랜잭션이 끝난 뒤에는 이긴 쪽 기록이 보인다
    prisma.postSave.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ courseId: "copy-winner" });
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" })
    );

    const res = await request(app).post("/api/posts/post-1/save").set("Cookie", AS_USER_1);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ saves: 5, saved: true, courseId: "copy-winner" });
  });

  it("유니크 제약 외의 오류는 삼키지 않는다", async () => {
    prisma.post.findUnique.mockResolvedValue(postRow());
    prisma.postSave.findUnique.mockResolvedValue(null);
    prisma.$transaction.mockRejectedValue(new Error("connection lost"));

    const res = await request(app).post("/api/posts/post-1/save").set("Cookie", AS_USER_1);

    expect(res.status).toBe(500);
  });

  it("원본과 장소 수가 달라졌으면 당일치기 한 일차로 접되 이동수단은 원본을 따른다", async () => {
    prisma.post.findUnique.mockResolvedValue(
      postRow({ courseId: "origin-1", stops: [stopRow(0), stopRow(1), stopRow(2)] })
    );
    prisma.course.findUnique.mockResolvedValue({
      emoji: "🌲",
      transport: "대중교통",
      days: [{ stops: [{ order: 0 }] }],
    });
    prisma.postSave.findUnique.mockResolvedValue(null);
    prisma.course.create.mockResolvedValue({ id: "copy-1" });
    prisma.post.findUniqueOrThrow.mockResolvedValue({ saves: 4 });

    await request(app).post("/api/posts/post-1/save").set("Cookie", AS_USER_1);

    const { data } = prisma.course.create.mock.calls[0][0];
    expect(data).toMatchObject({ emoji: null, nights: 0, transport: "대중교통" });
    expect(data.days.create).toHaveLength(1);
    expect(data.days.create[0].stops.create).toHaveLength(3);
  });

  it("원본 코스가 없으면 옛 글의 이동수단 태그를, 그것도 없으면 자차를 쓴다", async () => {
    prisma.postSave.findUnique.mockResolvedValue(null);
    prisma.course.create.mockResolvedValue({ id: "copy-1" });
    prisma.post.findUniqueOrThrow.mockResolvedValue({ saves: 4 });

    prisma.post.findUnique.mockResolvedValueOnce(postRow({ tags: ["당일치기", "대중교통"] }));
    await request(app).post("/api/posts/post-1/save").set("Cookie", AS_USER_1);

    prisma.post.findUnique.mockResolvedValueOnce(postRow({ tags: ["당일치기"] }));
    await request(app).post("/api/posts/post-1/save").set("Cookie", AS_USER_1);

    expect(prisma.course.findUnique).not.toHaveBeenCalled();
    expect(prisma.course.create.mock.calls.map(([args]) => args.data.transport)).toEqual(["대중교통", "자차"]);
  });
});

describe("DELETE /api/posts/:id/save", () => {
  beforeEach(() => {
    prisma.post.findUnique.mockResolvedValue({ id: "post-1", saves: 3 });
  });

  it("없는 글은 404", async () => {
    prisma.post.findUnique.mockResolvedValue(null);
    expect((await request(app).delete("/api/posts/gone/save").set("Cookie", AS_USER_1)).status).toBe(404);
  });

  it("담은 적이 없으면 아무것도 지우지 않고 현재 담긴 수를 돌려준다", async () => {
    prisma.postSave.findUnique.mockResolvedValue(null);

    const res = await request(app).delete("/api/posts/post-1/save").set("Cookie", AS_USER_1);

    expect(res.body).toEqual({ saves: 3, saved: false });
    expect(prisma.course.deleteMany).not.toHaveBeenCalled();
    expect(prisma.post.update).not.toHaveBeenCalled();
  });

  it("보관함 사본(Course)을 먼저, 기록(PostSave)을 나중에 지운다 — 코스 직접 삭제와 잠금 순서를 맞춘다", async () => {
    prisma.post.findUnique
      .mockResolvedValueOnce({ id: "post-1" })
      .mockResolvedValueOnce({ saves: 2 });
    prisma.postSave.findUnique.mockResolvedValue({ courseId: "copy-1" });

    const res = await request(app).delete("/api/posts/post-1/save").set("Cookie", AS_USER_1);

    expect(res.body).toEqual({ saves: 2, saved: false });
    // 남의 코스는 지우지 않도록 소유자 조건을 함께 건다
    expect(prisma.course.deleteMany).toHaveBeenCalledWith({ where: { id: "copy-1", userId: "user-1" } });
    expect(prisma.postSave.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1", postId: "post-1" } });
    expect(prisma.course.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.postSave.deleteMany.mock.invocationCallOrder[0]
    );
    // 담긴 수는 트리거가 내린다
    expect(prisma.post.update).not.toHaveBeenCalled();
  });

  it("사용자가 보관함에서 사본을 먼저 지웠으면 기록만 걷어낸다", async () => {
    prisma.postSave.findUnique.mockResolvedValue({ courseId: null });

    await request(app).delete("/api/posts/post-1/save").set("Cookie", AS_USER_1);

    expect(prisma.postSave.deleteMany).toHaveBeenCalled();
    expect(prisma.course.deleteMany).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/posts/:id", () => {
  it.each([
    ["고칠 값이 없는 요청", {}],
    ["빈 코스 이름", { caption: "  " }],
    ["문자열이 아닌 소개", { text: 3 }],
  ])("%s은 400", async (_label, body) => {
    const res = await request(app).patch("/api/posts/post-1").set("Cookie", AS_USER_1).send(body);

    expect(res.status).toBe(400);
    expect(prisma.post.update).not.toHaveBeenCalled();
  });

  it("남의 글은 존재 여부도 알리지 않고 404", async () => {
    prisma.post.findUnique.mockResolvedValue({ id: "post-1", userId: "someone-else" });

    const res = await request(app).patch("/api/posts/post-1").set("Cookie", AS_USER_1).send({ text: "x" });

    expect(res.status).toBe(404);
    expect(prisma.post.update).not.toHaveBeenCalled();
  });

  it("코스 이름은 앞뒤 공백을 걷어 저장한다", async () => {
    prisma.post.findUnique.mockResolvedValue({ id: "post-1", userId: "user-1" });
    prisma.post.update.mockResolvedValue(postRow({ userId: "user-1", caption: "새 이름" }));

    const res = await request(app)
      .patch("/api/posts/post-1")
      .set("Cookie", AS_USER_1)
      .send({ caption: "  새 이름 ", text: "새 소개" });

    expect(res.status).toBe(200);
    expect(prisma.post.update).toHaveBeenCalledWith({
      where: { id: "post-1" },
      data: { caption: "새 이름", text: "새 소개" },
      include: INCLUDE,
    });
    expect(res.body).toMatchObject({ caption: "새 이름", isMine: true });
  });
});

describe("DELETE /api/posts/:id", () => {
  it("로그인이 필요하다", async () => {
    expect((await request(app).delete("/api/posts/post-1")).status).toBe(401);
  });

  it("남의 글은 404", async () => {
    prisma.post.findUnique.mockResolvedValue({ id: "post-1", userId: "someone-else" });

    const res = await request(app).delete("/api/posts/post-1").set("Cookie", AS_USER_1);

    expect(res.status).toBe(404);
    expect(prisma.post.delete).not.toHaveBeenCalled();
  });

  it("내 글은 지우고 204", async () => {
    prisma.post.findUnique.mockResolvedValue({ id: "post-1", userId: "user-1" });

    const res = await request(app).delete("/api/posts/post-1").set("Cookie", AS_USER_1);

    expect(res.status).toBe(204);
    expect(prisma.post.delete).toHaveBeenCalledWith({ where: { id: "post-1" } });
  });
});
