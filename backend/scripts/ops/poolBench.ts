/**
 * Prisma 커넥션 풀 크기(connection_limit)에 따른 API 처리량·지연·오류 측정. **로컬 성능 DB 전용**.
 *
 *   POOL=5 CONCURRENCY=32 DURATION_MS=10000 npx tsx scripts/ops/poolBench.ts
 *
 * 실제 라우터(createApp)에 동시 요청을 보낸다. 작업 비율: 목록 70% · 검색 20% · 담기/취소(트랜잭션) 10%.
 * 풀은 프로세스당 하나라 풀 크기마다 프로세스를 새로 띄워 측정한다.
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.test" });
const base = process.env.PERF_DATABASE_URL ?? "postgresql://test:test@127.0.0.1:54329/daejourneyu_perf";
const host = new URL(base).hostname;
if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`로컬 DB에서만 실행합니다(현재: ${host})`);

const POOL = Number(process.env.POOL ?? 5);
const POOL_TIMEOUT = Number(process.env.POOL_TIMEOUT ?? 10); // Prisma 기본값 10초
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 32);
const DURATION_MS = Number(process.env.DURATION_MS ?? 10_000);

const url = new URL(base);
url.searchParams.set("connection_limit", String(POOL));
url.searchParams.set("pool_timeout", String(POOL_TIMEOUT));
process.env.DATABASE_URL = url.toString();
process.env.JWT_SECRET = "perf-secret";

// 고정 시드 의사난수(실행마다 같은 요청 순서)
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;

async function main() {
  const { default: request } = await import("supertest");
  const { createApp, authCookie, prisma } = await import("../../test/integration/helpers");
  const app = createApp();
  const keywords = ["갑천", "한밭수목원", "벚꽃", "카페", "오월드", "없는검색어"];
  const pad = (n: number, w: number) => String(n).padStart(w, "0");

  // 연결을 미리 열어 첫 요청의 연결 비용을 측정에서 뺀다
  await prisma.$queryRaw`SELECT 1`;

  const latencies: number[] = [];
  const statuses = new Map<string, number>();
  const deadline = Date.now() + DURATION_MS;

  async function worker() {
    while (Date.now() < deadline) {
      const r = rand();
      const started = performance.now();
      let res;
      if (r < 0.7) {
        res = await request(app).get(`/api/posts?sort=${pick(["saves", "recent"])}&limit=10`);
      } else if (r < 0.9) {
        res = await request(app).get(`/api/posts?q=${encodeURIComponent(pick(keywords))}&limit=10`);
      } else {
        const user = `u${pad(1 + Math.floor(rand() * 10000), 8)}`;
        const post = `/api/posts/p${pad(1 + Math.floor(rand() * 100000), 8)}/save`;
        const cookie = authCookie(user);
        res = await request(app).post(post).set("Cookie", cookie);
        await request(app).delete(post).set("Cookie", cookie); // 순변화 0
      }
      latencies.push(performance.now() - started);
      const key = res.status >= 500 ? `${res.status}:${res.body?.error ?? ""}` : String(res.status);
      statuses.set(key, (statuses.get(key) ?? 0) + 1);
    }
  }

  const started = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsed = (Date.now() - started) / 1000;

  latencies.sort((a, b) => a - b);
  const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]!;
  const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND usename = current_user`;
  console.log(
    `pool=${String(POOL).padStart(2)} conc=${CONCURRENCY} ` +
      `rps=${(latencies.length / elapsed).toFixed(0).padStart(5)} ` +
      `p50=${pct(50).toFixed(1)}ms p95=${pct(95).toFixed(1)}ms p99=${pct(99).toFixed(1)}ms ` +
      `db_conns=${count} statuses=${JSON.stringify(Object.fromEntries(statuses))}`
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
