interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

/** 해당 키를 바로 비운다(값이 바뀌는 쓰기 직후에 다음 읽기가 새로 계산하게). */
export function invalidateCached(key: string): void {
  store.delete(key);
}

/** 아주 단순한 인메모리 TTL 캐시 — 공공데이터포털 일일 트래픽 한도를 아끼기 위한 용도. */
export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const value = await load();
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}
