import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma } = vi.hoisted(() => {
  const model = () => ({
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  });
  return {
    prisma: { course: model(), courseDay: model(), $transaction: vi.fn(), $queryRaw: vi.fn() },
  };
});

vi.mock("../lib/prisma", () => ({ prisma }));
vi.mock("../lib/auth", () => ({
  ACCESS_TOKEN_COOKIE: "daejourneyu_token",
  verifyAccessToken: (token: string) =>
    token.startsWith("valid:") ? { userId: token.slice("valid:".length) } : null,
}));

import coursesRouter from "./courses";
import { errorHandler } from "../lib/errorHandler";

const AS_USER_1 = "daejourneyu_token=valid:user-1";

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/courses", coursesRouter);
app.use(errorHandler);

const stop = {
  placeId: "p1",
  name: "장소",
  category: "산책",
  district: "서구",
  condition: "전 견종",
  petFriendly: true,
};

function courseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "course-1",
    userId: "user-1",
    label: "코스",
    emoji: null,
    nights: 0,
    transport: "자차",
    source: "manual",
    shared: false,
    createdAt: new Date(),
    days: [{ id: "d1", dayIndex: 0, courseId: "course-1", stops: [{ ...stop, id: "s1", order: 0, imageUrl: null }] }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma));
});

describe("PATCH /api/courses/:id", () => {
  it("트랜잭션 첫 문장에서 소유자 조건으로 Course 행을 잠근 뒤 동선을 교체한다", async () => {
    prisma.course.findUnique.mockResolvedValue(courseRow());
    prisma.$queryRaw.mockResolvedValue([{ id: "course-1" }]);
    prisma.course.update.mockResolvedValue(courseRow());

    const res = await request(app).patch("/api/courses/course-1").set("Cookie", AS_USER_1).send({ days: [[stop]] });

    expect(res.status).toBe(200);
    const [strings, ...values] = prisma.$queryRaw.mock.calls[0];
    expect(strings.join("?")).toMatch(/FOR UPDATE/);
    expect(values).toEqual(["course-1", "user-1"]);
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.courseDay.deleteMany.mock.invocationCallOrder[0]
    );
  });

  it("사전 확인 뒤 그 사이 코스가 지워졌으면(잠금 0행) 아무것도 쓰지 않고 404", async () => {
    prisma.course.findUnique.mockResolvedValue(courseRow());
    prisma.$queryRaw.mockResolvedValue([]);

    const res = await request(app).patch("/api/courses/course-1").set("Cookie", AS_USER_1).send({ days: [[stop]] });

    expect(res.status).toBe(404);
    expect(prisma.courseDay.deleteMany).not.toHaveBeenCalled();
    expect(prisma.course.update).not.toHaveBeenCalled();
  });
});

describe("POST /api/courses", () => {
  it("nights가 정수가 아니면 DB까지 가지 않고 400", async () => {
    const res = await request(app)
      .post("/api/courses")
      .set("Cookie", AS_USER_1)
      .send({ label: "코스", nights: 1.5, transport: "자차", source: "manual", shared: false, days: [[stop]] });

    expect(res.status).toBe(400);
    expect(prisma.course.create).not.toHaveBeenCalled();
  });
});
