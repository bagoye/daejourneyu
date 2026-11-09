import { PrismaClient } from "@prisma/client";

/**
 * PrismaClient 싱글턴. tsx watch가 파일을 저장할 때마다 모듈을 다시 평가하므로
 * 전역에 캐시해두지 않으면 커넥션이 계속 쌓인다.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * 느린 쿼리 로그 기준(ms). 기본 500ms, 0이면 끈다.
 * 쿼리 문장(파라미터 자리표시자 $1…)과 소요 시간만 남기고 **파라미터 값은 남기지 않는다** — 이메일·검색어 같은
 * 사용자 입력이 로그 저장소로 흘러가지 않게. DB 쪽 누적 통계는 pg_stat_statements로 본다
 * (docs/db-optimization/04-database-operations.md).
 */
const SLOW_QUERY_MS = Number(process.env.SLOW_QUERY_MS ?? 500);

function createClient(): PrismaClient {
  if (!(SLOW_QUERY_MS > 0)) return new PrismaClient();

  const client = new PrismaClient({
    log: [
      { emit: "event", level: "query" },
      { emit: "stdout", level: "warn" },
      { emit: "stdout", level: "error" },
    ],
  });
  client.$on("query", (event) => {
    if (event.duration >= SLOW_QUERY_MS) {
      console.warn(`[db] 느린 쿼리 ${event.duration}ms: ${event.query.replace(/\s+/g, " ").slice(0, 500)}`);
    }
  });
  return client as unknown as PrismaClient;
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
