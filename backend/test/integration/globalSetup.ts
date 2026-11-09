import { execSync } from "node:child_process";
import { config as loadEnv } from "dotenv";

/**
 * 통합 테스트 시작 전 1회: 접속 대상이 로컬 DB인지 확인하고, 저장소의 마이그레이션을 그대로 적용한다.
 * 테스트가 테이블을 TRUNCATE하므로 원격 DB(Supabase 등)를 가리키면 시작 자체를 막는다.
 */
export default function setup() {
  loadEnv({ path: ".env.test" });
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_URL이 없습니다 — .env.test.example을 복사해 .env.test를 만드세요");
  }
  // 앱은 풀러(PgBouncer 트랜잭션 모드)를 거치고 마이그레이션은 직접 붙는 운영 구성을 재현할 때만 따로 준다.
  // 마이그레이션을 트랜잭션 모드 풀러로 돌리면 Prisma의 advisory lock이 풀러의 서버 연결에 남아 다음 배포를 막는다
  // (ops-lab에서 재현 — docs/db-optimization/08-pgbouncer-lab.md).
  const direct = process.env.TEST_DIRECT_URL ?? url;
  assertLocalDatabase(url);
  assertLocalDatabase(direct);

  // 기존 마이그레이션 파일을 수정 없이 그대로 적용한다(스키마 = 운영과 동일).
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: direct, DIRECT_URL: direct },
  });
}

export function assertLocalDatabase(url: string) {
  const host = new URL(url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`통합 테스트는 로컬 DB에서만 실행합니다(현재 호스트: ${host})`);
  }
}
