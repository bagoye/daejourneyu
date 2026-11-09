import express from "express";
import cookieParser from "cookie-parser";
import { prisma } from "../../src/lib/prisma";
import { signAccessToken, ACCESS_TOKEN_COOKIE } from "../../src/lib/auth";
import { errorHandler } from "../../src/lib/errorHandler";
import postsRouter from "../../src/routes/posts";
import coursesRouter from "../../src/routes/courses";
import reviewsRouter from "../../src/routes/reviews";

export { prisma };

/** 실제 라우터·인증·에러 미들웨어를 index.ts와 같은 순서로 붙인 앱. mock은 하나도 없다. */
export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/courses", coursesRouter);
  app.use("/api/posts", postsRouter);
  app.use("/api/reviews", reviewsRouter);
  app.use(errorHandler);
  return app;
}

/** 실제 JWT를 서명해 그 사용자로 로그인한 쿠키를 만든다. */
export function authCookie(userId: string): string {
  return `${ACCESS_TOKEN_COOKIE}=${signAccessToken({ userId })}`;
}

/** 마이그레이션 기록만 남기고 모든 테이블을 비운다. */
export async function resetDb() {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length === 0) return;
  const tables = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}

let seq = 0;

export async function createUser(nickname = `user-${++seq}`) {
  return prisma.user.create({
    data: { nickname, email: `${nickname}-${Date.now()}-${seq}@test.local` },
  });
}

export function stop(n: number) {
  return {
    placeId: `place-${n}`,
    name: `장소 ${n}`,
    category: "산책",
    district: "서구",
    condition: "전 견종",
    petFriendly: true,
    imageUrl: null,
  };
}

/** 일차별 장소 수 배열로 코스를 만든다. 예: [2, 1] → 1일차 2곳, 2일차 1곳 */
export async function createCourse(userId: string, dayLengths: number[] = [2]) {
  let n = 0;
  return prisma.course.create({
    data: {
      userId,
      label: "테스트 코스",
      emoji: "🐾",
      nights: dayLengths.length - 1,
      transport: "자차",
      source: "manual",
      shared: true,
      days: {
        create: dayLengths.map((len, dayIndex) => ({
          dayIndex,
          stops: { create: Array.from({ length: len }, (_, order) => ({ ...stop(n++), order })) },
        })),
      },
    },
  });
}

export async function createPost(userId: string, courseId: string | null, stopCount = 2) {
  return prisma.post.create({
    data: {
      userId,
      courseId,
      caption: "자랑 코스",
      text: "",
      tags: ["당일치기"],
      authorName: "작성자",
      authorEmoji: "🐶",
      petTypeName: "유형",
      stops: { create: Array.from({ length: stopCount }, (_, order) => ({ ...stop(order), order })) },
    },
  });
}

/**
 * 담기 정합성 불변식. 위반한 글 목록을 돌려준다(비어 있으면 정상).
 *  1) Post.saves = 실제 PostSave 행 수
 */
export async function findSaveCountDrift() {
  return prisma.$queryRaw<{ id: string; saves: number; actual: bigint }[]>`
    SELECT p.id, p.saves, COUNT(s.id) AS actual
    FROM "Post" p LEFT JOIN "PostSave" s ON s."postId" = p.id
    GROUP BY p.id
    HAVING p.saves <> COUNT(s.id)`;
}

/** 담기로 만들어졌지만 어떤 PostSave에도 연결되지 않은 보관함 사본(고아) 수 */
export async function countOrphanSavedCourses() {
  const [row] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*) AS count FROM "Course" c
    WHERE c.source = 'saved'
      AND NOT EXISTS (SELECT 1 FROM "PostSave" s WHERE s."courseId" = c.id)`;
  return Number(row!.count);
}
