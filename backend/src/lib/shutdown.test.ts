import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createShutdown, drainingMiddleware, isDraining, resetDrainingForTest } from "./shutdown";

function fakeServer(closeDelayMs = 0, error?: Error) {
  return {
    close: vi.fn((cb: (err?: Error) => void) => {
      setTimeout(() => cb(error), closeDelayMs);
    }),
    closeIdleConnections: vi.fn(),
  };
}

afterEach(() => {
  resetDrainingForTest();
  vi.useRealTimers();
});

describe("graceful shutdown", () => {
  it("수신을 멈추고(진행 중 요청 완료를 기다린 뒤) DB 연결을 닫고 0으로 끝낸다", async () => {
    const order: string[] = [];
    const server = fakeServer();
    server.close.mockImplementation((cb) => setTimeout(() => (order.push("server.close"), cb()), 20));
    const db = { $disconnect: vi.fn(async () => void order.push("db.disconnect")) };
    const exit = vi.fn();

    await createShutdown(server, db, { drainMs: 0, exit, log: () => {} })("SIGTERM");

    expect(order).toEqual(["server.close", "db.disconnect"]);
    expect(server.closeIdleConnections).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("drainMs 동안은 리스너를 닫지 않고 기다린다(그동안 draining 표시)", async () => {
    vi.useFakeTimers();
    const server = fakeServer();
    const exit = vi.fn();

    void createShutdown(server, { $disconnect: async () => {} }, { drainMs: 3000, exit, log: () => {} })("SIGTERM");
    await vi.advanceTimersByTimeAsync(2999);
    expect(isDraining()).toBe(true);
    expect(server.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(server.close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("신호가 두 번 와도 한 번만 정리한다", async () => {
    const server = fakeServer();
    const db = { $disconnect: vi.fn(async () => {}) };
    const exit = vi.fn();
    const shutdown = createShutdown(server, db, { drainMs: 0, exit, log: () => {} });

    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(db.$disconnect).toHaveBeenCalledTimes(1);
  });

  it("제한 시간 안에 끝나지 않으면 강제로 1로 끝낸다", async () => {
    vi.useFakeTimers();
    const server = { close: vi.fn() }; // 콜백을 영영 안 부름(오래 걸리는 요청)
    const exit = vi.fn();

    void createShutdown(server, { $disconnect: async () => {} }, { timeoutMs: 1000, drainMs: 0, exit, log: () => {} })(
      "SIGTERM"
    );
    await vi.advanceTimersByTimeAsync(1000);

    expect(exit).toHaveBeenCalledWith(1);
  });

  it("정리 중 오류가 나면 1로 끝낸다", async () => {
    const exit = vi.fn();
    await createShutdown(fakeServer(0, new Error("boom")), { $disconnect: async () => {} }, {
      drainMs: 0,
      exit,
      log: () => {},
    })("SIGTERM");
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("drainingMiddleware", () => {
  function run() {
    const setHeader = vi.fn();
    const next = vi.fn();
    drainingMiddleware({} as express.Request, { setHeader } as unknown as express.Response, next);
    return { setHeader, next };
  }

  it("평소에는 헤더를 건드리지 않고, 정리가 시작되면 Connection: close를 붙인다(요청은 계속 처리)", () => {
    const normal = run();
    expect(normal.setHeader).not.toHaveBeenCalled();
    expect(normal.next).toHaveBeenCalled();

    void createShutdown(fakeServer(10_000), { $disconnect: async () => {} }, {
      drainMs: 60_000,
      exit: () => {},
      log: () => {},
    })("SIGTERM");

    const draining = run();
    expect(draining.setHeader).toHaveBeenCalledWith("Connection", "close");
    expect(draining.next).toHaveBeenCalled(); // 이미 들어온 요청은 처리한다
  });

  it("실제 앱에서도 정리 중 응답은 200으로 처리된다", async () => {
    const app = express();
    app.use(drainingMiddleware);
    app.get("/x", (_req, res) => res.json({ ok: true }));
    void createShutdown(fakeServer(10_000), { $disconnect: async () => {} }, {
      drainMs: 60_000,
      exit: () => {},
      log: () => {},
    })("SIGTERM");

    const res = await request(app).get("/x");
    expect(res.status).toBe(200);
    expect(res.headers.connection).toBe("close");
  });
});
