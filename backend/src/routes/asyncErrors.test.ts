import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 회귀 테스트: DB 계층이 예외를 던졌을 때 라우터가 요청을 멈춘 채 두거나(Express 4는 async 핸들러의
 * reject를 잡지 않는다) 프로세스를 죽이지 않고, 공통 에러 미들웨어로 넘겨 JSON 에러로 응답하는지 본다.
 */

const { prisma } = vi.hoisted(() => {
  const model = () => ({
    findMany: vi.fn(),
    findUnique: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  });
  return {
    prisma: {
      post: model(),
      postSave: model(),
      course: model(),
      courseSchedule: model(),
      review: model(),
      reviewTagOption: model(),
      $transaction: vi.fn(),
    },
  };
});

vi.mock("../lib/prisma", () => ({ prisma }));
// /api/places는 DB가 아니라 공공데이터 집계 캐시를 거친다 — 외부 호출 대신 실패를 흉내 낸다.
const { cached } = vi.hoisted(() => ({ cached: vi.fn() }));
vi.mock("../lib/cache", () => ({ cached }));
vi.mock("../lib/auth", () => ({
  ACCESS_TOKEN_COOKIE: "daejourneyu_token",
  verifyAccessToken: (token: string) =>
    token.startsWith("valid:") ? { userId: token.slice("valid:".length) } : null,
}));

import postsRouter from "./posts";
import coursesRouter from "./courses";
import reviewsRouter from "./reviews";
import placesRouter from "./places";
import { errorHandler } from "../lib/errorHandler";

const AS_USER_1 = "daejourneyu_token=valid:user-1";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/posts", postsRouter);
  app.use("/api/courses", coursesRouter);
  app.use("/api/reviews", reviewsRouter);
  app.use("/api/places", placesRouter);
  app.use(errorHandler);
  return app;
}

const app = createApp();

function knownError(code: string) {
  return new Prisma.PrismaClientKnownRequestError("테스트용 Prisma 오류", {
    code,
    clientVersion: "test",
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("라우터 async 예외 처리", () => {
  it("DB가 끊기면 요청을 붙잡아 두지 않고 500 JSON으로 응답한다", async () => {
    prisma.post.findMany.mockRejectedValue(new Error("connection refused"));
    prisma.course.findMany.mockRejectedValue(new Error("connection refused"));
    prisma.review.findMany.mockRejectedValue(new Error("connection refused"));
    cached.mockRejectedValue(new Error("upstream timeout"));

    for (const [path, cookie] of [
      ["/api/posts", undefined],
      ["/api/courses", AS_USER_1],
      ["/api/reviews", undefined],
      ["/api/places", undefined],
    ] as const) {
      const req = request(app).get(path).timeout(2000);
      const res = await (cookie ? req.set("Cookie", cookie) : req);
      expect(res.status, path).toBe(500);
      expect(res.body.error, path).toEqual(expect.any(String));
    }
  });

  it("처리 도중 대상이 사라지면(P2025) 404로 응답한다", async () => {
    // 소유권 확인은 통과했지만 그 사이 다른 요청이 코스를 지운 상황
    prisma.course.findUnique.mockResolvedValue({ id: "course-1", userId: "user-1" });
    prisma.course.delete.mockRejectedValue(knownError("P2025"));

    const res = await request(app)
      .delete("/api/courses/course-1")
      .set("Cookie", AS_USER_1)
      .timeout(2000);

    expect(res.status).toBe(404);
    expect(res.body.error).toEqual(expect.any(String));
  });

  it("유니크 제약에 걸리면(P2002) 409로 응답한다", async () => {
    prisma.reviewTagOption.findMany.mockResolvedValue([{ id: "tag-1", code: "LEASH_REQUIRED" }]);
    prisma.review.create.mockRejectedValue(knownError("P2002"));

    const res = await request(app)
      .post("/api/reviews")
      .set("Cookie", AS_USER_1)
      .send({ placeId: "p1", placeName: "장소", tagCodes: ["LEASH_REQUIRED"] })
      .timeout(2000);

    expect(res.status).toBe(409);
  });

  it("커넥션 풀 고갈(P2024)·트랜잭션 대기 초과(P2028)는 503 + Retry-After로 응답한다", async () => {
    for (const code of ["P2024", "P2028"]) {
      prisma.post.findMany.mockRejectedValueOnce(knownError(code));
      const res = await request(app).get("/api/posts").timeout(2000);
      expect(res.status, code).toBe(503);
      expect(res.headers["retry-after"]).toBe("1");
    }
  });

  it("깨진 JSON 본문은 500이 아니라 400으로 응답한다", async () => {
    const res = await request(app)
      .post("/api/reviews")
      .set("Cookie", AS_USER_1)
      .set("Content-Type", "application/json")
      .send("{broken")
      .timeout(2000);

    expect(res.status).toBe(400);
    expect(res.body.error).toEqual(expect.any(String));
  });
});
