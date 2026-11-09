// API 부하 시나리오(k6). 성능 게이트(perf-gate.sh)가 base·head 각각에 같은 부하를 걸어 비교한다.
// **로컬·CI의 합성 데이터 DB 전용** — 운영 URL을 가리키지 않는다(아래 BASE_URL 검사).
//
//   k6 run -e BASE_URL=http://127.0.0.1:4102 -e JWT_SECRET=... -e OUT=out/head-1.json scripts/load/api.k6.js
//
// 설계:
// - **도착률 고정(open model, constant-arrival-rate)**: 서버가 느려져도 요청은 정해진 속도로 계속 들어온다.
//   VU 수를 고정하는 closed model은 응답이 늦어지면 요청 자체가 줄어 지연이 가려진다(coordinated omission).
//   VU가 모자라 요청을 못 보낸 횟수는 dropped_iterations로 따로 보고한다 — 포화의 신호다.
// - 앞 WARMUP초는 phase=warmup 태그로 분리해 집계에서 뺀다(JIT·커넥션 풀·버퍼 캐시 데우기).
// - 엔드포인트마다 ep 태그를 붙이고 thresholds에 등록해 엔드포인트별 p95가 요약에 남게 한다.
// - 담기 요청은 시드된 사용자 이름으로 JWT를 직접 서명한다(합성 사용자라 비밀번호가 없다).
import http from "k6/http";
import { check } from "k6";
import exec from "k6/execution";
import crypto from "k6/crypto";
import encoding from "k6/encoding";

const BASE_URL = __ENV.BASE_URL || "http://127.0.0.1:4102";
const JWT_SECRET = __ENV.JWT_SECRET || "perf-gate-secret";
const WARMUP = Number(__ENV.WARMUP || 10); // 초
const DURATION = Number(__ENV.DURATION || 30); // 초 — 측정 구간
const SCALE = Number(__ENV.SCALE || 0.1); // seed-large.sql의 scale과 맞춘다
const RATE = Number(__ENV.RATE_MULT || 1); // 도착률 배수
const SLO_MS = Number(__ENV.SLO_MS || 800); // 절대 상한(회귀 비교와 별개로, 이것을 넘으면 즉시 실패)
const N_USERS = Math.max(1, Math.round(10000 * SCALE));
const N_POSTS = Math.max(1, Math.round(100000 * SCALE));
const N_PLACES = 2000;

if (!/^https?:\/\/(127\.0\.0\.1|localhost|host\.docker\.internal)(:\d+)?$/.test(BASE_URL)) {
  throw new Error(`BASE_URL은 로컬만 허용한다: ${BASE_URL}`);
}

// 검색은 실행계획이 다른 두 부류로 나눠 따로 집계한다. 한 엔드포인트 p95에 섞으면 한쪽만 느려지는 회귀가 묻힌다
// (실제로 trigram 인덱스를 지워도 합친 p95는 +16%로 통과했다 — docs/db-optimization/10 §4).
// - 흔한 검색어(seed-large.sql 어휘 사전): 결과가 많아 count가 순차 스캔 — 인덱스와 무관하게 느리다
// - 드문 검색어(오타·없는 말): 결과가 거의 없어 trigram 인덱스가 있으면 즉시, 없으면 전체를 훑는다
const COMMON_KEYWORDS = ["한밭수목원", "카페", "대청호", "산책", "성심당", "야경", "벚꽃", "브런치", "갑천", "숲길"];
const RARE_KEYWORDS = ["한밭수묵원", "성심담", "대청효", "없는검색어", "반려묘호텔"];
const ENDPOINTS = ["feed_popular", "feed_recent", "feed_page2", "search_common", "search_rare", "post_detail", "place_reviews", "save", "unsave"];

const total = WARMUP + DURATION;
function scenario(fn, rate) {
  return {
    executor: "constant-arrival-rate",
    exec: fn,
    rate: Math.max(1, Math.round(rate * RATE)),
    timeUnit: "1s",
    duration: `${total}s`,
    preAllocatedVUs: 10,
    maxVUs: 100,
  };
}

const thresholds = { "http_req_failed{phase:measure}": ["rate<0.01"], "checks{phase:measure}": ["rate>0.99"] };
for (const ep of ENDPOINTS) thresholds[`http_req_duration{ep:${ep},phase:measure}`] = [`p(95)<${SLO_MS}`];

export const options = {
  scenarios: {
    feed: scenario("feed", 20), // 둘러보기 첫 화면(인기순·최신순 반반) + 최신순은 다음 페이지까지
    search: scenario("search", 8),
    detail: scenario("detail", 10),
    reviews: scenario("reviews", 10),
    save: scenario("saveToggle", 4), // 담기 → 취소(쓰기 경로: 트랜잭션·트리거·잠금 순서)
  },
  thresholds,
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "max", "count"],
  discardResponseBodies: false,
  noConnectionReuse: false,
};

function phase() {
  return exec.instance.currentTestRunDuration < WARMUP * 1000 ? "warmup" : "measure";
}
function params(ep, extra = {}) {
  return { tags: { ep, phase: phase() }, ...extra };
}
function pick(n, skew = 1) {
  // skew>1이면 앞번호(인기 글·인기 장소)에 쏠린다 — seed-large.sql의 분포와 같은 방식
  return 1 + Math.floor(Math.pow(Math.random(), skew) * n);
}
const pad = (n) => String(n).padStart(8, "0");

function jwtFor(userId) {
  const now = Math.floor(Date.now() / 1000);
  const head = encoding.b64encode(JSON.stringify({ alg: "HS256", typ: "JWT" }), "rawurl");
  const body = encoding.b64encode(JSON.stringify({ userId, iat: now, exp: now + 3600 }), "rawurl");
  const sig = crypto.hmac("sha256", JWT_SECRET, `${head}.${body}`, "base64rawurl");
  return `${head}.${body}.${sig}`;
}

export function feed() {
  if (Math.random() < 0.5) {
    const r = http.get(`${BASE_URL}/api/posts?limit=10`, params("feed_popular"));
    check(r, { "feed_popular 200": (x) => x.status === 200 });
    return;
  }
  const r = http.get(`${BASE_URL}/api/posts?limit=10&sort=recent`, params("feed_recent"));
  check(r, { "feed_recent 200": (x) => x.status === 200 });
  const cursor = r.status === 200 ? r.json("nextCursor") : null;
  if (cursor) {
    const r2 = http.get(`${BASE_URL}/api/posts?limit=10&sort=recent&cursor=${encodeURIComponent(cursor)}`, params("feed_page2"));
    check(r2, { "feed_page2 200": (x) => x.status === 200 });
  }
}

export function search() {
  const rare = Math.random() < 0.3;
  const words = rare ? RARE_KEYWORDS : COMMON_KEYWORDS;
  const q = words[Math.floor(Math.random() * words.length)];
  const ep = rare ? "search_rare" : "search_common";
  const r = http.get(`${BASE_URL}/api/posts?limit=10&q=${encodeURIComponent(q)}`, params(ep));
  check(r, { "search 200": (x) => x.status === 200 });
}

export function detail() {
  const r = http.get(`${BASE_URL}/api/posts/p${pad(pick(N_POSTS, 2))}`, params("post_detail"));
  check(r, { "post_detail 200": (x) => x.status === 200 });
}

export function reviews() {
  const r = http.get(`${BASE_URL}/api/reviews?placeId=place-${pick(N_PLACES, 3)}&limit=10`, params("place_reviews"));
  check(r, { "place_reviews 200": (x) => x.status === 200 });
}

// 자기 글을 담으면 400(정상 거절)이다. 헤비 유저가 글을 많이 쓰도록 시드돼 있어 드물게 걸린다 — 실패로 세지 않는다.
const saveOk = http.expectedStatuses({ min: 200, max: 299 }, 400);
export function saveToggle() {
  const userId = `u${pad(pick(N_USERS))}`;
  const postId = `p${pad(pick(N_POSTS, 3))}`; // 인기 글에 몰려 같은 글 동시 담기 경합이 생긴다
  const headers = { Cookie: `daejourneyu_token=${jwtFor(userId)}` };
  const r = http.post(`${BASE_URL}/api/posts/${postId}/save`, null, params("save", { headers, responseCallback: saveOk }));
  check(r, { "save 2xx/400": (x) => (x.status >= 200 && x.status < 300) || x.status === 400 });
  if (r.status === 200) {
    const r2 = http.del(`${BASE_URL}/api/posts/${postId}/save`, null, params("unsave", { headers }));
    check(r2, { "unsave 200": (x) => x.status === 200 });
  }
}

// 게이트가 비교할 최소한의 수치만 JSON으로 남긴다(엔드포인트별 지연·건수, 실패율, 누락 요청).
export function handleSummary(data) {
  const m = data.metrics;
  const out = { endpoints: {}, failedRate: null, droppedIterations: 0, reqs: 0 };
  for (const ep of ENDPOINTS) {
    const v = m[`http_req_duration{ep:${ep},phase:measure}`]?.values;
    if (v && v.count > 0) out.endpoints[ep] = { count: v.count, med: v.med, p95: v["p(95)"], p99: v["p(99)"], max: v.max };
  }
  out.failedRate = m["http_req_failed{phase:measure}"]?.values.rate ?? null;
  out.droppedIterations = m.dropped_iterations?.values.count ?? 0;
  out.reqs = m.http_reqs?.values.count ?? 0;
  out.thresholdsOk = Object.values(m).every((x) => !x.thresholds || Object.values(x.thresholds).every((t) => t.ok));
  const res = { stdout: summaryText(out) };
  if (__ENV.OUT) res[__ENV.OUT] = JSON.stringify(out, null, 2);
  return res;
}

function summaryText(o) {
  const rows = Object.entries(o.endpoints).map(
    ([ep, v]) => `  ${ep.padEnd(14)} n=${String(v.count).padStart(5)}  med=${v.med.toFixed(1).padStart(7)}ms  p95=${v.p95.toFixed(1).padStart(7)}ms  p99=${v.p99.toFixed(1).padStart(7)}ms`,
  );
  return `\n${rows.join("\n")}\n  실패율=${((o.failedRate ?? 0) * 100).toFixed(2)}%  누락 요청(dropped)=${o.droppedIterations}  thresholds=${o.thresholdsOk ? "통과" : "실패"}\n`;
}
