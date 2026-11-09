import { defineConfig } from "vitest/config";
import { config as loadEnv } from "dotenv";

// PostgreSQL 통합 테스트 설정(npm run test:int). 기본 `npm test`(Prisma mock 단위 테스트)와 분리한다.
// 실제 DB에 TRUNCATE·동시 요청을 쏘므로 파일을 직렬로 돌린다.
loadEnv({ path: ".env.test" });

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? "";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/integration/**/*.int.test.ts"],
    globalSetup: ["test/integration/globalSetup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      // lib/prisma의 PrismaClient가 이 값으로 접속한다 — 앱 코드는 테스트 DB를 따로 알 필요가 없다.
      DATABASE_URL: testDatabaseUrl,
      DIRECT_URL: testDatabaseUrl,
      // 실제 JWT 서명·검증 경로를 그대로 태운다(테스트 전용 값).
      JWT_SECRET: "integration-test-secret",
      NODE_ENV: "test",
    },
  },
});
