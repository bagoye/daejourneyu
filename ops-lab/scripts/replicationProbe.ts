/**
 * 복제 실습용 부하·측정 도구(backend의 Prisma를 그대로 쓴다 — 새 패키지 없음). backend 디렉터리에서 실행:
 *
 *   npx tsx ../ops-lab/scripts/replicationProbe.ts load  <결과.json>   # 쓰기 부하 + "커밋 응답 받은" 쓰기 기록
 *   npx tsx ../ops-lab/scripts/replicationProbe.ts stale <결과.json>   # primary에 쓰고 곧바로 standby에서 읽기
 *
 * 환경변수: PRIMARY_URL, STANDBY_URL, WORKERS(기본 8), DURATION_MS(기본 15000), STOP_AFTER_FAIL_MS(기본 3000)
 *
 * load: 워커마다 (worker, seq)를 1건씩 커밋한다. 성공 응답을 받은 seq만 "acked"로 기록한다. primary가 죽어
 * 실패가 STOP_AFTER_FAIL_MS 동안 이어지면 끝낸다. 장애 전환 후 새 primary에 acked 행이 모두 있는지 비교하면
 * "클라이언트에게 성공이라고 답했는데 사라진 쓰기"(비동기 복제의 RPO)를 정확히 셀 수 있다.
 */
import { writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const mode = process.argv[2];
const out = process.argv[3] ?? "/dev/null";
const PRIMARY_URL = process.env.PRIMARY_URL ?? "postgresql://postgres:lab@127.0.0.1:54331/daejourneyu";
const STANDBY_URL = process.env.STANDBY_URL ?? "postgresql://postgres:lab@127.0.0.1:54332/daejourneyu";
const WORKERS = Number(process.env.WORKERS ?? 8);
const DURATION_MS = Number(process.env.DURATION_MS ?? 15_000);
const STOP_AFTER_FAIL_MS = Number(process.env.STOP_AFTER_FAIL_MS ?? 3_000);

for (const u of [PRIMARY_URL, STANDBY_URL]) {
  const host = new URL(u).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`로컬 실습 DB에서만 실행합니다(현재: ${host})`);
}

function client(url: string, pool: number) {
  const u = new URL(url);
  u.searchParams.set("connection_limit", String(pool));
  u.searchParams.set("connect_timeout", "2");
  u.searchParams.set("pool_timeout", "2");
  return new PrismaClient({ datasourceUrl: u.toString() });
}

function pct(xs: number[], p: number) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

async function load() {
  const db = client(PRIMARY_URL, WORKERS);
  await db.$queryRaw`SELECT 1`;
  const acked: number[] = Array(WORKERS).fill(0);
  const latencies: number[] = [];
  let failures = 0;
  let firstFailAt: number | null = null;
  const started = Date.now();
  const deadline = started + DURATION_MS;

  const startSeq: number[] = Array(WORKERS).fill(0);

  async function worker(w: number) {
    // 테이블에 이미 있는 번호 다음부터(여러 번 돌려도 키가 겹치지 않게)
    const [{ max }] = await db.$queryRaw<{ max: number }[]>`SELECT coalesce(max(seq), 0)::int AS max FROM failover_probe WHERE worker = ${w}`;
    let seq = max;
    startSeq[w] = max;
    acked[w] = max;
    let failingSince: number | null = null;
    while (Date.now() < deadline) {
      const next = seq + 1;
      const t = performance.now();
      try {
        await db.$executeRaw`INSERT INTO failover_probe (worker, seq) VALUES (${w}, ${next})`;
        latencies.push(performance.now() - t);
        seq = next;
        acked[w] = seq; // 커밋 성공 응답을 받은 것만 기록
        failingSince = null;
      } catch (err) {
        if (failures === 0) console.log(`  첫 실패: ${String(err).split("\n").filter(Boolean).slice(-1)[0]}`);
        failures++;
        firstFailAt ??= Date.now();
        failingSince ??= Date.now();
        if (Date.now() - failingSince > STOP_AFTER_FAIL_MS) return; // primary가 죽었다고 보고 종료
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  await Promise.all(Array.from({ length: WORKERS }, (_, w) => worker(w)));
  const okMs = (firstFailAt ?? Date.now()) - started;
  const result = {
    startSeq,
    acked,
    ackedTotal: acked.reduce((a, b, i) => a + (b - startSeq[i]!), 0),
    failures,
    tps: Math.round((latencies.length / okMs) * 1000),
    p50: Number(pct(latencies, 50).toFixed(2)),
    p95: Number(pct(latencies, 95).toFixed(2)),
    p99: Number(pct(latencies, 99).toFixed(2)),
  };
  writeFileSync(out, JSON.stringify(result));
  console.log(`  load: 커밋 응답 ${result.ackedTotal}건 · ${result.tps} tps · p50 ${result.p50}ms · p95 ${result.p95}ms · p99 ${result.p99}ms · 실패 ${failures}`);
  await db.$disconnect().catch(() => {});
}

async function stale() {
  // primary에 값을 쓰고(커밋 응답 받음) 곧바로 standby에서 같은 행을 읽는다. 옛 값이면 stale read.
  const p = client(PRIMARY_URL, 1);
  const s = client(STANDBY_URL, 1);
  await p.$executeRaw`INSERT INTO replica_read_check (id, v) VALUES (1, 0) ON CONFLICT (id) DO UPDATE SET v = 0`;
  await new Promise((r) => setTimeout(r, 500));
  let staleReads = 0;
  const waits: number[] = []; // 옛 값이었을 때 새 값이 보일 때까지 걸린 시간
  const N = Number(process.env.STALE_N ?? 300);
  for (let i = 1; i <= N; i++) {
    await p.$executeRaw`UPDATE replica_read_check SET v = ${i} WHERE id = 1`;
    const t = performance.now();
    let [row] = await s.$queryRaw<{ v: number }[]>`SELECT v FROM replica_read_check WHERE id = 1`;
    if (row!.v !== i) {
      staleReads++;
      while (row!.v !== i) [row] = await s.$queryRaw<{ v: number }[]>`SELECT v FROM replica_read_check WHERE id = 1`;
      waits.push(performance.now() - t);
    }
  }
  const result = { n: N, staleReads, waitP50: Number(pct(waits, 50).toFixed(2)), waitMax: Number(Math.max(0, ...waits).toFixed(2)) };
  writeFileSync(out, JSON.stringify(result));
  console.log(`  stale: ${N}회 중 ${staleReads}회 옛 값(${((100 * staleReads) / N).toFixed(1)}%) · 새 값이 보일 때까지 p50 ${result.waitP50}ms · 최대 ${result.waitMax}ms`);
  await Promise.all([p.$disconnect(), s.$disconnect()]);
}

(mode === "load" ? load() : mode === "stale" ? stale() : Promise.reject(new Error("mode: load | stale"))).catch((err) => {
  console.error(err);
  process.exit(1);
});
