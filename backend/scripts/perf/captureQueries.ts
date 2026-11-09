/**
 * 성능 분석 대상 API를 실제 라우터로 호출해, (1) Prisma가 실제로 보내는 SQL을 PostgreSQL 로그에 남기고
 * (2) 응답 크기·소요 시간을 출력한다. **로컬 성능 DB 전용**.
 *
 *   PERF_DATABASE_URL=postgresql://test:test@127.0.0.1:54329/daejourneyu_perf npx tsx scripts/perf/captureQueries.ts
 *
 * SQL 수집: 실행 전 `ALTER DATABASE daejourneyu_perf SET log_min_duration_statement = 0` → docker logs로 확인.
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.test" });
const url = process.env.PERF_DATABASE_URL ?? "postgresql://test:test@127.0.0.1:54329/daejourneyu_perf";
const host = new URL(url).hostname;
if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`로컬 DB에서만 실행합니다(현재: ${host})`);
process.env.DATABASE_URL = url;
process.env.JWT_SECRET = "perf-secret";

async function main() {
  // 환경변수를 정한 뒤에 불러와야 PrismaClient가 성능 DB로 붙는다.
  const { default: request } = await import("supertest");
  const { createApp, authCookie, prisma } = await import("../../test/integration/helpers");
  const app = createApp();

  // 헤비 유저(코스·후기가 가장 많은 사용자)와 후기가 가장 많은 장소를 고른다
  const [heavy] = await prisma.$queryRaw<{ userId: string; n: bigint }[]>`
    SELECT "userId", count(*) AS n FROM "Course" GROUP BY "userId" ORDER BY n DESC LIMIT 1`;
  const [topPlace] = await prisma.$queryRaw<{ placeId: string; n: bigint }[]>`
    SELECT "placeId", count(*) AS n FROM "Review" GROUP BY "placeId" ORDER BY n DESC LIMIT 1`;
  const [reviewer] = await prisma.$queryRaw<{ authorId: string; n: bigint }[]>`
    SELECT "authorId", count(*) AS n FROM "Review" GROUP BY "authorId" ORDER BY n DESC LIMIT 1`;
  console.log(`heavy user=${heavy!.userId}(코스 ${heavy!.n}) top place=${topPlace!.placeId}(후기 ${topPlace!.n}) reviewer=${reviewer!.authorId}(후기 ${reviewer!.n})`);

  const cases: [string, string, string | null][] = [
    ["Q1 최신순 첫 페이지", "/api/posts?sort=recent&limit=10", null],
    ["Q2 담기순 첫 페이지", "/api/posts?sort=saves&limit=10", null],
    ["Q2 담기순 첫 페이지(로그인 — 담기 여부 조회 포함)", "/api/posts?sort=saves&limit=10", reviewer!.authorId],
    ["Q3 검색 '갑천'", `/api/posts?q=${encodeURIComponent("갑천")}&limit=10`, null],
    ["Q3 검색 '벚꽃 피크닉'(드문 조합)", `/api/posts?q=${encodeURIComponent("벚꽃 피크닉")}&limit=10`, null],
    ["Q4 내 코스 목록(헤비 유저)", "/api/courses", heavy!.userId],
    ["Q5 장소 후기 전체(예전 방식)", `/api/reviews?placeId=${topPlace!.placeId}`, null],
    ["Q5 장소 후기 첫 페이지(limit=10)", `/api/reviews?placeId=${topPlace!.placeId}&limit=10`, null],
    ["Q5' 후기 전체 — 예전 마이탭 방식(필터 없음)", "/api/reviews", reviewer!.authorId],
    ["Q5' 내 후기(mine=true)", "/api/reviews?mine=true", reviewer!.authorId],
  ];

  for (const [label, path, userId] of cases) {
    const started = performance.now();
    const req = request(app).get(path);
    const res = await (userId ? req.set("Cookie", authCookie(userId)) : req);
    const ms = performance.now() - started;
    const bytes = Buffer.byteLength(res.text ?? "");
    const count = Array.isArray(res.body) ? res.body.length : res.body?.items?.length;
    console.log(`${label.padEnd(40)} status=${res.status} items=${count} bytes=${bytes.toLocaleString()} ${ms.toFixed(1)}ms`);

    // 커서로 깊은 페이지까지(Q1·Q2) — 50페이지째 요청의 SQL을 남긴다
    if (path.startsWith("/api/posts?sort=") && !userId) {
      let cursor: string | null = res.body.nextCursor;
      for (let i = 0; i < 49 && cursor; i++) {
        const next = await request(app).get(`${path}&cursor=${encodeURIComponent(cursor)}`);
        cursor = next.body.nextCursor;
      }
      if (cursor) {
        const t = performance.now();
        const deep = await request(app).get(`${path}&cursor=${encodeURIComponent(cursor)}`);
        console.log(`${(label + " — 51페이지").padEnd(40)} status=${deep.status} ${(performance.now() - t).toFixed(1)}ms cursor=${cursor}`);
      }
    }
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
