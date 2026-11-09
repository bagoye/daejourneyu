import { describe, expect, it, vi } from "vitest";
import { createShutdown } from "./shutdown";

function fakeServer(closeDelayMs = 0, error?: Error) {
  return {
    close: vi.fn((cb: (err?: Error) => void) => {
      setTimeout(() => cb(error), closeDelayMs);
    }),
  };
}

describe("graceful shutdown", () => {
  it("수신을 멈추고(진행 중 요청 완료를 기다린 뒤) DB 연결을 닫고 0으로 끝낸다", async () => {
    const order: string[] = [];
    const server = fakeServer(20);
    server.close.mockImplementation((cb) => setTimeout(() => (order.push("server.close"), cb()), 20));
    const db = { $disconnect: vi.fn(async () => void order.push("db.disconnect")) };
    const exit = vi.fn();

    await createShutdown(server, db, { exit, log: () => {} })("SIGTERM");

    expect(order).toEqual(["server.close", "db.disconnect"]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("신호가 두 번 와도 한 번만 정리한다", async () => {
    const server = fakeServer();
    const db = { $disconnect: vi.fn(async () => {}) };
    const exit = vi.fn();
    const shutdown = createShutdown(server, db, { exit, log: () => {} });

    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(db.$disconnect).toHaveBeenCalledTimes(1);
  });

  it("제한 시간 안에 끝나지 않으면 강제로 1로 끝낸다", async () => {
    vi.useFakeTimers();
    const server = { close: vi.fn() }; // 콜백을 영영 안 부름(오래 걸리는 요청)
    const exit = vi.fn();

    void createShutdown(server, { $disconnect: async () => {} }, { timeoutMs: 1000, exit, log: () => {} })("SIGTERM");
    await vi.advanceTimersByTimeAsync(1000);

    expect(exit).toHaveBeenCalledWith(1);
    vi.useRealTimers();
  });

  it("정리 중 오류가 나면 1로 끝낸다", async () => {
    const exit = vi.fn();
    await createShutdown(fakeServer(0, new Error("boom")), { $disconnect: async () => {} }, { exit, log: () => {} })(
      "SIGTERM"
    );
    expect(exit).toHaveBeenCalledWith(1);
  });
});
