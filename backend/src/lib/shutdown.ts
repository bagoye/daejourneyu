import type { Server } from "node:http";

/**
 * 종료 신호(SIGTERM·SIGINT)를 받으면 새 연결을 그만 받고, 처리 중인 요청이 끝나길 기다린 뒤 DB 연결을 닫는다.
 *
 * Railway는 재배포·스케일 다운 때 SIGTERM을 보내고 잠시 뒤 강제 종료한다. 정리 없이 죽으면 처리 중이던
 * 트랜잭션이 클라이언트에게 연결 끊김으로 보이고, DB 쪽 연결은 서버가 타임아웃으로 정리할 때까지 남는다
 * (Supabase 풀러의 연결 수를 잠깐 더 차지한다). 그래서 순서를 지킨다: 수신 중단 → 진행 중 요청 완료 → $disconnect.
 * timeoutMs 안에 안 끝나면 강제로 끝낸다(오래 걸리는 요청 하나 때문에 배포가 막히지 않게).
 */
export function createShutdown(
  server: Pick<Server, "close">,
  db: { $disconnect: () => Promise<void> },
  { timeoutMs = 10_000, exit = (code: number) => process.exit(code), log = console.log } = {}
) {
  let shuttingDown = false;

  return async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return; // 신호가 두 번 와도 한 번만 정리
    shuttingDown = true;
    log(`[server] ${signal} 수신 — 새 요청을 받지 않고 정리합니다`);

    const timer = setTimeout(() => {
      log(`[server] ${timeoutMs}ms 안에 정리되지 않아 강제 종료합니다`);
      exit(1);
    }, timeoutMs);
    timer.unref?.();

    try {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await db.$disconnect();
      clearTimeout(timer);
      log("[server] 정리 완료");
      exit(0);
    } catch (err) {
      clearTimeout(timer);
      log(`[server] 정리 중 오류: ${String(err)}`);
      exit(1);
    }
  };
}
