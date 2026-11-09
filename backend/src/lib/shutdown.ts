import type { NextFunction, Request, Response } from "express";
import type { Server } from "node:http";

/** 종료 정리 중인지. 헬스체크와 응답 헤더가 이 값을 본다. */
let draining = false;

export function isDraining(): boolean {
  return draining;
}

/**
 * 정리가 시작된 뒤의 응답에는 `Connection: close`를 붙인다.
 *
 * `server.close()`는 새 *연결*만 막는다. keep-alive로 이미 열린 연결로는 요청이 계속 들어오고(리눅스 컨테이너에서
 * SIGTERM 이후 새 요청이 200으로 처리되는 것을 확인), 클라이언트·프록시는 죽어가는 프로세스의 연결을 계속 재사용한다.
 * 응답마다 연결을 닫게 하면 다음 요청은 새 연결로 — 즉 새 인스턴스로 — 간다.
 */
export function drainingMiddleware(_req: Request, res: Response, next: NextFunction) {
  if (draining) res.setHeader("Connection", "close");
  next();
}

/**
 * 종료 신호(SIGTERM·SIGINT)를 받으면 새 연결을 그만 받고, 처리 중인 요청이 끝나길 기다린 뒤 DB 연결을 닫는다.
 *
 * Railway는 재배포·스케일 다운 때 SIGTERM을 보내고 잠시 뒤 강제 종료한다. 정리 없이 죽으면 처리 중이던
 * 트랜잭션이 클라이언트에게 연결 끊김으로 보이고, DB 쪽 연결은 서버가 타임아웃으로 정리할 때까지 남는다
 * (Supabase 풀러의 연결 수를 잠깐 더 차지한다). 그래서 순서를 지킨다:
 *
 *   1) draining 표시 — 헬스체크 503, 응답에 Connection: close
 *   2) drainMs만큼 계속 요청을 받으며 기다림 — 앞단(로드밸런서)이 이 인스턴스를 빼는 동안 들어오는 연결을 끊지 않으려고.
 *      리스너를 바로 닫으면 커널 대기열(backlog)에 막 도착한 연결이 ECONNRESET으로 끊긴다(리눅스에서 재현).
 *   3) 리스너 닫기 + 놀고 있는 keep-alive 연결 정리 → 진행 중 요청 완료 대기
 *   4) $disconnect
 *
 * timeoutMs 안에 안 끝나면 강제로 끝낸다(오래 걸리는 요청 하나 때문에 배포가 막히지 않게).
 */
export function createShutdown(
  server: Pick<Server, "close"> & Partial<Pick<Server, "closeIdleConnections">>,
  db: { $disconnect: () => Promise<void> },
  {
    timeoutMs = 10_000,
    drainMs = Number(process.env.SHUTDOWN_DRAIN_MS ?? 0),
    exit = (code: number) => process.exit(code),
    log = console.log,
  } = {}
) {
  let shuttingDown = false;

  return async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return; // 신호가 두 번 와도 한 번만 정리
    shuttingDown = true;
    draining = true;
    log(`[server] ${signal} 수신 — 정리를 시작합니다(대기 ${drainMs}ms 후 수신 중단)`);

    const timer = setTimeout(() => {
      log(`[server] ${timeoutMs}ms 안에 정리되지 않아 강제 종료합니다`);
      exit(1);
    }, timeoutMs);
    timer.unref?.();

    try {
      if (drainMs > 0) await new Promise((resolve) => setTimeout(resolve, drainMs));
      const closed = new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      // Node 19+는 close()가 알아서 하지만, 그 이전 버전에서도 놀고 있는 keep-alive 연결이 종료를 붙잡지 않게
      server.closeIdleConnections?.();
      await closed;
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

/** 테스트용: 모듈 상태 초기화 */
export function resetDrainingForTest() {
  draining = false;
}
