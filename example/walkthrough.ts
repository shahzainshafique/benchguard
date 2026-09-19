/**
 * A narrated walkthrough of what benchguard actually does.
 * Run it:  npm run demo      (or: node example/walkthrough.ts)
 *
 * The whole tool is three moves: MEASURE a baseline, MEASURE a change,
 * then COMPARE them through a gate that ignores noise. This script does all
 * three in one process so you can watch the logic decide.
 */
import { measure, compareOne, formatTime, type Comparison } from "../src/index.ts";

const data = Array.from({ length: 2000 }, () => Math.random());

// The workload, in three versions:
const original = () => [...data].sort((a, b) => a - b); // our baseline
const regressed = () => {                                // oops: sorts 3x now
  let r;
  for (let i = 0; i < 3; i++) r = [...data].sort((a, b) => a - b);
  return r;
};
const unchanged = () => [...data].sort((a, b) => a - b); // identical to original

// Print a comparison and, crucially, SHOW the two-part gate that made the call.
function explain(c: Comparison) {
  const pct = (c.delta! * 100).toFixed(1);
  const noise = (c.noiseFloor! * 100).toFixed(1);
  const beatThreshold = Math.abs(c.delta!) > 0.1;
  const beatNoise = Math.abs(c.delta!) > c.noiseFloor!;
  console.log(`    change vs baseline : ${c.delta! >= 0 ? "+" : ""}${pct}%`);
  console.log(`    measurement noise  : ±${noise}%   (how much these numbers wobble)`);
  console.log(`    gate ─ condition 1 : |${pct}%| > 10% threshold ?  ${beatThreshold ? "YES" : "no"}`);
  console.log(`    gate ─ condition 2 : |${pct}%| > ${noise}% noise  ?  ${beatNoise ? "YES" : "no"}`);
  console.log(`    verdict            : ${c.status.toUpperCase()}  ${
    c.status === "regressed" ? "→ build fails (exit 1)" : "→ build passes"
  }`);
}

console.log("STEP 1 ── Measure the current code and remember it as the baseline.");
const base = await measure(original, { timeBudgetMs: 300 });
console.log(`    ${formatTime(base.median)} per call   (median of ${base.samples} samples, ±${base.rme.toFixed(1)}%)\n`);

console.log("STEP 2 ── A teammate ships a change. Measure the new code.");
const afterChange = await measure(regressed, { timeBudgetMs: 300 });
console.log(`    ${formatTime(afterChange.median)} per call\n`);

console.log("STEP 3 ── Compare. This slowdown is real and big:");
explain(compareOne("sort", base, afterChange, 0.1));

console.log("\n────────────────────────────────────────────────────────────");
console.log("Now the part that makes benchguard trustworthy: run the SAME");
console.log("unchanged code and compare it to the baseline. Timings never");
console.log("match exactly, and the gate must NOT cry wolf over that wobble.\n");

const rerun = await measure(unchanged, { timeBudgetMs: 300 });
console.log("STEP 4 ── Compare identical code against the baseline:");
explain(compareOne("sort", base, rerun, 0.1));

console.log(
  "\nTakeaway: a slowdown fails the build only when it clears BOTH the",
);
console.log("threshold you set AND the measurement noise. That's the whole idea.");
