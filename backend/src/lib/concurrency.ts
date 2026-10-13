/**
 * items를 최대 limit개씩 동시에 처리한다. 카카오 지오코딩·이미지검색을 소스마다 수십~백여 건씩
 * 무제한 Promise.all로 쏘면 레이트리밋(429)에 걸려 대부분 실패하는 문제가 있어서(실제로 발생),
 * 모든 카카오 호출 루프는 이 함수를 거치게 한다.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/** 연결 리스트의 한 칸. next가 null이면 마지막 노드다. */
class Node<T> {
  next: Node<T> | null = null;

  constructor(readonly value: T) {}
}

/**
 * head·tail 포인터만 들고 있는 단일 연결 리스트 FIFO 큐. 배열 shift()는 남은 요소를 전부 한 칸씩
 * 당기느라 O(n)이라서, 대기자가 많이 쌓이는 Semaphore 대기열용으로 enqueue·dequeue를 둘 다 O(1)로
 * 맞췄다. 꺼내는 쪽이 head, 넣는 쪽이 tail이다.
 */
export class Queue<T> {
  private head: Node<T> | null = null;
  private tail: Node<T> | null = null;

  enqueue(value: T): void {
    const node = new Node(value);
    if (this.tail) {
      this.tail.next = node;
    } else {
      // 빈 큐면 새 노드가 head이자 tail이다
      this.head = node;
    }
    this.tail = node;
  }

  /** 가장 먼저 넣은 값을 꺼낸다. 비어 있으면 undefined. */
  dequeue(): T | undefined {
    const node = this.head;
    if (!node) return undefined;

    this.head = node.next;
    // 마지막 노드를 꺼냈으면 tail도 비운다. 안 비우면 tail이 이미 꺼낸 노드를 계속 가리켜서,
    // 다음 enqueue가 그 뒤에 노드를 붙이고 head는 null로 남아 값이 유실된다.
    if (!this.head) this.tail = null;
    return node.value;
  }
}

/**
 * 여러 호출부(요청 여러 개, 소스 여러 개)가 동시에 나눠 써도 프로세스 전체에서 동시 실행 개수가
 * limit을 절대 넘지 않게 막는 전역 세마포어. mapWithConcurrency는 "이 호출 하나" 안에서만 동시성을
 * 제한하기 때문에, "전체" 카테고리로 5개 소스가 동시에 각자 병렬 요청을 쏘면 프로세스 전체 동시
 * 요청 수는 여전히 5배로 불어난다 — 카카오 API 호출은 전부 이 세마포어를 거치게 해서 실제로 막는다.
 */
export class Semaphore {
  private active = 0;
  private readonly queue = new Queue<() => void>();

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.enqueue(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.dequeue();
      if (next) next();
    }
  }
}
