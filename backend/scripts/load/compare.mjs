// 성능 게이트 판정 — perf-gate.sh가 남긴 {base,head}-{라운드}.json을 읽어 엔드포인트별 p95를 비교한다.
//   node scripts/load/compare.mjs perf-out
//
// 판정(실패 시 exit 1):
//  1) head 절대 기준: 실패율 1% 미만, k6 thresholds(엔드포인트별 p95 < SLO_MS) 통과 — 라운드 과반 기준
//  2) 회귀: head p95(라운드 중앙값)가 base보다 REL(기본 25%) **그리고** ABS_MS(기본 5ms) 넘게 느림
//     - 비율만 쓰면 2ms → 3ms 같은 의미 없는 차이(+50%)로 실패하고, 절댓값만 쓰면 느린 엔드포인트의 회귀를 놓친다.
//     - REL·ABS_MS는 A/A 실험(같은 코드끼리 비교)의 잡음 폭을 보고 정했다(docs/db-optimization/10).
//  3) 포화: head에서 요청 누락(dropped_iterations)이 생겼는데 base에서는 없었음
import { readdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "perf-out";
const REL = Number(process.env.REL ?? 0.25);
const ABS_MS = Number(process.env.ABS_MS ?? 5);

const runs = { base: [], head: [] };
for (const f of readdirSync(dir).sort()) {
  const m = /^(base|head)-(\d+)\.json$/.exec(f);
  if (m) runs[m[1]].push(JSON.parse(readFileSync(join(dir, f), "utf8")));
}
if (runs.head.length === 0) {
  console.error("head 결과가 없다 — k6 실행이 실패했다(perf-out/server-*.log 확인)");
  process.exit(1);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const k = Math.floor(s.length / 2);
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
};
const fmt = (x) => (x == null ? "—" : `${x.toFixed(1)}`);
const eps = [...new Set(runs.head.flatMap((r) => Object.keys(r.endpoints)))];
const stat = (side, ep, key) => {
  const xs = runs[side].map((r) => r.endpoints[ep]?.[key]).filter((x) => x != null);
  return xs.length ? { med: median(xs), min: Math.min(...xs), max: Math.max(...xs) } : null;
};

const failures = [];
const lines = [];
const hasBase = runs.base.length > 0;
lines.push(`### 성능 게이트 — ${hasBase ? `base vs head, ${runs.head.length}라운드 번갈아 측정` : `head 단독(${runs.head.length}라운드) · 비교 기준 없음`}`);
lines.push("");
lines.push(hasBase
  ? "| 엔드포인트 | base p95 (ms) | head p95 (ms) | 차이 | head 라운드 범위 | 판정 |\n|---|---:|---:|---:|---:|---|"
  : "| 엔드포인트 | head p95 (ms) | 라운드 범위 | head 중앙값 (ms) |\n|---|---:|---:|---:|");

for (const ep of eps) {
  const h = stat("head", ep, "p95");
  if (!hasBase) {
    lines.push(`| ${ep} | ${fmt(h.med)} | ${fmt(h.min)}–${fmt(h.max)} | ${fmt(stat("head", ep, "med")?.med)} |`);
    continue;
  }
  const b = stat("base", ep, "p95");
  if (!b) {
    lines.push(`| ${ep} | — | ${fmt(h.med)} | 신규 | ${fmt(h.min)}–${fmt(h.max)} | — |`);
    continue;
  }
  const diff = h.med - b.med;
  const rel = diff / b.med;
  const regressed = rel > REL && diff > ABS_MS;
  if (regressed) failures.push(`${ep}: p95 ${fmt(b.med)} → ${fmt(h.med)}ms (+${(rel * 100).toFixed(0)}%)`);
  const verdict = regressed ? "❌ 회귀" : rel < -REL && -diff > ABS_MS ? "✅ 개선" : "통과";
  lines.push(`| ${ep} | ${fmt(b.med)} | ${fmt(h.med)} | ${diff >= 0 ? "+" : ""}${(rel * 100).toFixed(0)}% | ${fmt(h.min)}–${fmt(h.max)} | ${verdict} |`);
}

const majority = (xs) => xs.filter(Boolean).length * 2 > xs.length;
const headFailRate = median(runs.head.map((r) => r.failedRate ?? 0));
if (headFailRate >= 0.01) failures.push(`head 실패율 ${(headFailRate * 100).toFixed(2)}%`);
if (!majority(runs.head.map((r) => r.thresholdsOk))) failures.push("head가 절대 기준(k6 thresholds: p95 < SLO_MS·실패율)을 라운드 과반에서 통과하지 못함");
const dropped = (side) => runs[side].reduce((a, r) => a + (r.droppedIterations ?? 0), 0);
if (hasBase && dropped("head") > 0 && dropped("base") === 0) failures.push(`head에서만 요청 누락 ${dropped("head")}건(포화)`);

lines.push("");
lines.push(`실패율(head 중앙값) ${(headFailRate * 100).toFixed(2)}% · 요청 누락 head ${dropped("head")}${hasBase ? ` / base ${dropped("base")}` : ""} · 회귀 기준: +${REL * 100}% 그리고 +${ABS_MS}ms 초과`);
lines.push("");
lines.push(failures.length ? `**실패**\n${failures.map((f) => `- ${f}`).join("\n")}` : "**통과**");

const md = lines.join("\n");
console.log(`\n${md}`);
writeFileSync(join(dir, "report.md"), md + "\n");
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
process.exit(failures.length ? 1 : 0);
