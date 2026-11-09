import { afterEach, describe, expect, it, vi } from "vitest";
import { bumpGeneration, cached, closeCache, getGeneration } from "./cache";

afterEach(async () => {
  delete process.env.REDIS_URL;
  await closeCache();
  vi.restoreAllMocks();
});

describe("cached (메모리)", () => {
  it("TTL 안에서는 다시 계산하지 않는다", async () => {
    const load = vi.fn().mockResolvedValue(1);
    await cached("k", 1000, load);
    await cached("k", 1000, load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("같은 키 동시 미스는 한 번만 계산한다(single-flight)", async () => {
    let resolve!: (v: number) => void;
    const load = vi.fn(() => new Promise<number>((r) => (resolve = r)));
    const all = Promise.all([cached("sf", 1000, load), cached("sf", 1000, load), cached("sf", 1000, load)]);
    await new Promise((r) => setTimeout(r, 0));
    resolve(7);
    expect(await all).toEqual([7, 7, 7]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("계산이 실패하면 저장하지 않고, 다음 요청이 다시 계산한다", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("db")).mockResolvedValue(2);
    await expect(cached("f", 1000, load)).rejects.toThrow("db");
    expect(await cached("f", 1000, load)).toBe(2);
  });

  it("세대를 올리면 번호가 바뀐다", async () => {
    expect(await getGeneration("g")).toBe(0);
    await bumpGeneration("g");
    expect(await getGeneration("g")).toBe(1);
  });
});

describe("cached (Redis 장애)", () => {
  it("Redis에 붙을 수 없어도 요청은 실패하지 않고 원본을 읽는다 — 세대는 null(캐시 건너뜀)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.REDIS_URL = "redis://127.0.0.1:1"; // 아무도 듣지 않는 포트
    const load = vi.fn().mockResolvedValue(3);
    const t0 = Date.now();
    expect(await cached("down", 1000, load)).toBe(3);
    expect(await cached("down", 1000, load)).toBe(3);
    expect(load).toHaveBeenCalledTimes(2); // 저장할 곳이 없으니 매번 원본
    expect(await getGeneration("g")).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
