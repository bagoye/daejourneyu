import { describe, expect, it } from "vitest";
import { mapWithConcurrency, Queue, Semaphore } from "./concurrency";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 동시에 실행 중인 작업 수의 최댓값을 기록하는 헬퍼 */
function createTracker() {
  let active = 0;
  let max = 0;
  return {
    async track<T>(fn: () => Promise<T>): Promise<T> {
      active++;
      max = Math.max(max, active);
      try {
        return await fn();
      } finally {
        active--;
      }
    },
    get max() {
      return max;
    },
  };
}

describe("mapWithConcurrency", () => {
  it("완료 순서와 상관없이 입력 순서대로 결과를 돌려준다", async () => {
    const delays = [30, 5, 20, 1, 10];
    const results = await mapWithConcurrency(delays, 2, async (ms, index) => {
      await sleep(ms);
      return index;
    });
    expect(results).toEqual([0, 1, 2, 3, 4]);
  });

  it("동시 실행 개수가 limit을 넘지 않는다", async () => {
    const tracker = createTracker();
    await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, (n) =>
      tracker.track(() => sleep(5).then(() => n))
    );
    expect(tracker.max).toBe(3);
  });

  it("빈 배열이면 빈 결과를 돌려준다", async () => {
    await expect(mapWithConcurrency([], 5, async (n: number) => n)).resolves.toEqual([]);
  });
});

describe("Queue", () => {
  it("넣은 순서대로 꺼내고, 비어 있으면 undefined를 돌려준다", () => {
    const queue = new Queue<number>();
    expect(queue.dequeue()).toBeUndefined();

    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);
    expect(queue.dequeue()).toBe(1);
    expect(queue.dequeue()).toBe(2);
    expect(queue.dequeue()).toBe(3);
    expect(queue.dequeue()).toBeUndefined();
  });

  it("큐를 비운 뒤 다시 넣고 꺼내도 값이 정상적으로 나온다", () => {
    const queue = new Queue<string>();
    queue.enqueue("a");
    queue.enqueue("b");
    expect(queue.dequeue()).toBe("a");
    expect(queue.dequeue()).toBe("b");
    expect(queue.dequeue()).toBeUndefined();

    // 비워진 큐에 다시 넣으면 head·tail이 새 노드부터 다시 이어져야 한다
    queue.enqueue("c");
    queue.enqueue("d");
    expect(queue.dequeue()).toBe("c");
    expect(queue.dequeue()).toBe("d");
    expect(queue.dequeue()).toBeUndefined();
  });

  it("넣기와 꺼내기를 섞어도 FIFO 순서를 유지한다", () => {
    const queue = new Queue<number>();
    queue.enqueue(1);
    queue.enqueue(2);
    expect(queue.dequeue()).toBe(1);
    queue.enqueue(3);
    expect(queue.dequeue()).toBe(2);
    expect(queue.dequeue()).toBe(3);
    expect(queue.dequeue()).toBeUndefined();
  });
});

describe("Semaphore", () => {
  it("여러 호출부가 나눠 써도 전체 동시 실행 개수가 limit을 넘지 않는다", async () => {
    const semaphore = new Semaphore(2);
    const tracker = createTracker();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        semaphore.run(() => tracker.track(() => sleep(5).then(() => i * 10)))
      )
    );
    expect(results).toEqual([0, 10, 20, 30, 40, 50]);
    expect(tracker.max).toBe(2);
  });

  it("작업이 실패해도 슬롯을 반납해 다음 작업이 진행된다", async () => {
    const semaphore = new Semaphore(1);
    await expect(semaphore.run(() => Promise.reject(new Error("실패")))).rejects.toThrow("실패");
    await expect(semaphore.run(async () => "다음 작업")).resolves.toBe("다음 작업");
  });

  it("대기 중인 작업을 들어온 순서대로 실행한다", async () => {
    const semaphore = new Semaphore(1);
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        semaphore.run(async () => {
          await sleep(1);
          order.push(i);
        })
      )
    );
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it("대기열이 비었다가 다시 채워져도 모든 작업이 끝난다", async () => {
    const semaphore = new Semaphore(1);
    const tracker = createTracker();
    const runBatch = (offset: number) =>
      Promise.all(
        Array.from({ length: 3 }, (_, i) =>
          semaphore.run(() => tracker.track(() => sleep(1).then(() => offset + i)))
        )
      );

    // 1차: 1개 실행 + 2개 대기 → 전부 끝나면 대기열이 완전히 빈다
    await expect(runBatch(0)).resolves.toEqual([0, 1, 2]);
    // 2차: 비워진 대기열에 다시 대기자가 쌓여도 깨어나야 한다
    await expect(runBatch(10)).resolves.toEqual([10, 11, 12]);
    expect(tracker.max).toBe(1);
  }, 1000);
});
