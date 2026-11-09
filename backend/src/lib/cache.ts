import Redis from "ioredis";

/**
 * TTL 캐시. 기본은 프로세스 메모리, `REDIS_URL`이 있으면 Redis(인스턴스 간 공유)를 쓴다.
 *
 * - **Redis가 죽어도 요청은 실패하지 않는다**: 명령이 실패·지연(CACHE_TIMEOUT_MS)되면 그 요청은 원본(DB·외부 API)을
 *   직접 읽는다. 캐시는 성능 장치이지 정합성의 근거가 아니므로, 캐시 장애가 서비스 장애가 되면 안 된다.
 * - **같은 키 동시 미스는 한 번만 계산한다**(single-flight, 프로세스 단위): 만료 순간 몰린 요청이 DB를 한꺼번에 때리지 않게.
 * - **TTL에 ±10% 지터**: 같은 시각에 채워진 키들이 같은 시각에 만료돼 한꺼번에 다시 계산되지 않게.
 * - 값은 JSON으로 직렬화한다 — Date는 문자열이 된다(현재 캐시하는 값은 숫자·평범한 객체뿐).
 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const memory = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const TIMEOUT_MS = Number(process.env.CACHE_TIMEOUT_MS ?? 50);
const PREFIX = "djy:";

let redis: Redis | null = null;
let lastErrorLog = 0;

function getRedis(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (!redis) {
    redis = new Redis(url, {
      // 끊긴 동안 명령을 쌓아 두지 않고 바로 실패시킨다 → 요청은 원본으로 넘어간다
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 1000,
      // 재연결은 계속 시도한다(최대 2초 간격) — Redis가 돌아오면 자동으로 캐시가 다시 쓰인다
      retryStrategy: (times) => Math.min(times * 200, 2000),
      lazyConnect: false,
    });
    redis.on("error", (err) => logCacheError(err));
  }
  return redis;
}

function logCacheError(err: unknown) {
  // 장애 중 요청마다 찍으면 로그가 폭주한다 — 10초에 한 번만
  if (Date.now() - lastErrorLog < 10_000) return;
  lastErrorLog = Date.now();
  console.warn(`[cache] Redis 사용 불가 — 원본을 직접 읽는다: ${err instanceof Error ? err.message : String(err)}`);
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

const jitter = (ttlMs: number) => Math.max(1, Math.round(ttlMs * (0.9 + Math.random() * 0.2)));

/** 키의 값을 읽는다. 없거나 Redis 장애면 undefined. */
async function read<T>(key: string): Promise<T | undefined> {
  const r = getRedis();
  if (!r) {
    const hit = memory.get(key);
    return hit && hit.expiresAt > Date.now() ? (hit.value as T) : undefined;
  }
  try {
    const raw = await withTimeout(r.get(PREFIX + key));
    return raw == null ? undefined : (JSON.parse(raw) as T);
  } catch (err) {
    logCacheError(err);
    return undefined;
  }
}

async function write(key: string, value: unknown, ttlMs: number): Promise<void> {
  const r = getRedis();
  if (!r) {
    memory.set(key, { value, expiresAt: Date.now() + ttlMs });
    return;
  }
  try {
    await withTimeout(r.set(PREFIX + key, JSON.stringify(value), "PX", jitter(ttlMs)));
  } catch (err) {
    logCacheError(err);
  }
}

/** 해당 키를 바로 비운다(값이 바뀌는 쓰기 직후에 다음 읽기가 새로 계산하게). */
export async function invalidateCached(key: string): Promise<void> {
  memory.delete(key);
  const r = getRedis();
  if (!r) return;
  try {
    await withTimeout(r.del(PREFIX + key));
  } catch (err) {
    logCacheError(err);
  }
}

/**
 * 세대(generation) 번호 — 여러 키를 한 번에 무효화할 때 쓴다. 키 이름에 세대를 넣고, 무효화는 세대를 올린다.
 * 예: 검색어별 건수 키가 수천 개여도 글 하나를 쓰면 INCR 한 번으로 전부 옛 세대가 된다(옛 키는 TTL로 사라짐).
 * Redis 장애 중에는 null — 호출자는 캐시를 건너뛴다(어느 세대인지 모르면 옛 값을 줄 수 있어서).
 */
export async function getGeneration(name: string): Promise<number | null> {
  const r = getRedis();
  if (!r) return Number(memory.get(`gen:${name}`)?.value ?? 0);
  try {
    return Number((await withTimeout(r.get(`${PREFIX}gen:${name}`))) ?? 0);
  } catch (err) {
    logCacheError(err);
    return null;
  }
}

export async function bumpGeneration(name: string): Promise<void> {
  const r = getRedis();
  if (!r) {
    memory.set(`gen:${name}`, { value: Number(memory.get(`gen:${name}`)?.value ?? 0) + 1, expiresAt: Infinity });
    return;
  }
  try {
    await withTimeout(r.incr(`${PREFIX}gen:${name}`));
  } catch (err) {
    // 세대를 못 올리면 다른 인스턴스가 최대 TTL 동안 옛 건수를 볼 수 있다 — 캐시 대상은 그 정도 지연을 허용하는 값만 둔다
    logCacheError(err);
  }
}

/** 캐시에 있으면 그 값, 없으면 load()로 계산해 ttlMs 동안 저장한다. */
export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = await read<T>(key);
  if (hit !== undefined) return hit;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = (async () => {
    try {
      const value = await load();
      await write(key, value, ttlMs);
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** 테스트·종료용 */
export async function closeCache(): Promise<void> {
  memory.clear();
  if (redis) {
    const r = redis;
    redis = null;
    await r.quit().catch(() => r.disconnect());
  }
}
