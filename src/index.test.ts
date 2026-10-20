import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bench,
  run,
  reset,
  computeStats,
  compareOne,
  measure,
  trustWarnings,
  argValue,
  parseThreshold,
  splitArgs,
  summaryMarkdown,
  type Comparison,
  type Stats,
} from "./index.js";

test("computeStats: median, mean, min, stddev (odd count)", () => {
  const s = computeStats([10, 20, 30, 40, 50], 1);
  assert.equal(s.median, 30);
  assert.equal(s.mean, 30);
  assert.equal(s.min, 10);
  // variance (n-1) = (400+100+0+100+400)/4 = 250 -> sqrt ≈ 15.8114
  assert.ok(Math.abs(s.stddev - 15.8114) < 1e-3, `stddev=${s.stddev}`);
});

test("computeStats: median with even count averages the middle two", () => {
  assert.equal(computeStats([10, 20, 30, 40], 1).median, 25);
});

test("computeStats: unsorted input is handled", () => {
  const s = computeStats([50, 10, 30, 20, 40], 1);
  assert.equal(s.median, 30);
  assert.equal(s.min, 10);
});

// compareOne decision logic: build Stats directly so we control the noise.
const mk = (median: number, rme: number): Stats => ({
  median, mean: median, min: median, stddev: 0, moe: 0, rme, samples: 10, batch: 1,
});

test("regression above threshold and above noise -> regressed", () => {
  // +20% change, ~2% combined noise
  assert.equal(compareOne("x", mk(100, 1), mk(120, 1), 0.1).status, "regressed");
});

test("regression above threshold but within noise -> ok (no false alarm)", () => {
  // +20% change but 30% combined noise -> untrustworthy, must not flag
  assert.equal(compareOne("x", mk(100, 15), mk(120, 15), 0.1).status, "ok");
});

test("improvement below negative threshold and above noise -> improved", () => {
  assert.equal(compareOne("x", mk(100, 1), mk(80, 1), 0.1).status, "improved");
});

test("small change under threshold -> ok", () => {
  assert.equal(compareOne("x", mk(100, 1), mk(105, 1), 0.1).status, "ok");
});

test("missing baseline -> new", () => {
  const c = compareOne("x", undefined, mk(100, 1), 0.1);
  assert.equal(c.status, "new");
  assert.equal(c.baseline, null);
  assert.equal(c.delta, null);
});

test("measure: returns positive median and honors minSamples", async () => {
  const s = await measure(
    () => { let x = 0; for (let i = 0; i < 100; i++) x += i; return x; },
    { timeBudgetMs: 50, minSamples: 5, warmupMs: 5 },
  );
  assert.ok(s.median > 0, "median should be positive");
  assert.ok(s.samples >= 5, `samples=${s.samples}`);
  assert.ok(s.batch >= 1, `batch=${s.batch}`);
});

test("measure: supports async functions", async () => {
  const s = await measure(async () => { await Promise.resolve(1); }, {
    timeBudgetMs: 50, minSamples: 5, warmupMs: 5,
  });
  assert.ok(s.median > 0);
});

// --- trust warnings: catch benchmarks that quietly measure nothing ---

const healthy: Stats = {
  median: 5000, mean: 5000, min: 4900, stddev: 50, moe: 30, rme: 2,
  samples: 120, batch: 500,
};

test("trustWarnings: a healthy measurement warns about nothing", () => {
  assert.deepEqual(trustWarnings(healthy), []);
});

test("trustWarnings: flags a noisy result", () => {
  const w = trustWarnings({ ...healthy, rme: 18 });
  assert.equal(w.length, 1);
  assert.match(w[0], /very noisy/);
});

test("trustWarnings: flags too few samples", () => {
  assert.match(trustWarnings({ ...healthy, samples: 3 })[0], /sample\(s\) collected/);
});

test("trustWarnings: flags a body that looks optimized away", () => {
  assert.match(trustWarnings({ ...healthy, median: 0.2 })[0], /optimized away/);
});

test("trustWarnings: flags batch size hitting its ceiling", () => {
  assert.match(trustWarnings({ ...healthy, batch: 1e8 })[0], /too fast to time/);
});

test("trustWarnings: reports several problems at once", () => {
  assert.equal(trustWarnings({ ...healthy, rme: 30, samples: 2 }).length, 2);
});

// --- CLI overrides, so one bench file works locally and in CI ---

test("argValue: reads --flag value", () => {
  assert.equal(argValue("--baseline", ["node", "x", "--baseline", "/tmp/b.json"]), "/tmp/b.json");
});

test("argValue: reads --flag=value", () => {
  assert.equal(argValue("--baseline", ["node", "x", "--baseline=/tmp/b.json"]), "/tmp/b.json");
});

test("argValue: absent flag is undefined", () => {
  assert.equal(argValue("--baseline", ["node", "x", "--update"]), undefined);
});

test("argValue: does not swallow the next flag as a value", () => {
  assert.equal(argValue("--baseline", ["node", "x", "--baseline", "--update"]), undefined);
});

test("parseThreshold: falls back when nothing is passed", () => {
  assert.equal(parseThreshold(undefined, 0.1), 0.1);
});

test("parseThreshold: parses a valid number", () => {
  assert.equal(parseThreshold("0.25", 0.1), 0.25);
});

test("parseThreshold: rejects junk instead of silently disabling the guard", () => {
  // Number("abc") is NaN, and every comparison against NaN is false, which would
  // quietly pass every build forever. It must throw.
  assert.throws(() => parseThreshold("abc", 0.1), /invalid threshold/);
  assert.throws(() => parseThreshold("-1", 0.1), /invalid threshold/);
});

// --- multiple bench files sharing one baseline ---

test("run --update merges into the baseline instead of replacing it", async () => {
  // Regression test: recording a second bench file used to wipe the first
  // file's numbers, so its benchmarks came back as "new" and passed no matter
  // how slow they got. Two run() calls here stand in for two bench files.
  const path = join(mkdtempSync(join(tmpdir(), "benchguard-")), "baseline.json");
  const fast = { baseline: path, update: true, timeBudgetMs: 20, minSamples: 3, warmupMs: 1, globalWarmupMs: 0 };

  reset();
  bench("from file A", () => Math.sqrt(2));
  await run(fast);

  reset();
  bench("from file B", () => Math.sqrt(3));
  await run(fast);
  reset();

  const saved = JSON.parse(readFileSync(path, "utf8")).benchmarks;
  assert.deepEqual(Object.keys(saved).sort(), ["from file A", "from file B"]);
});

// --- CLI argument splitting ---

test("splitArgs: separates bench files from flags", () => {
  assert.deepEqual(splitArgs(["bench/a.bench.mjs", "--update", "bench/b.bench.mjs"]), {
    files: ["bench/a.bench.mjs", "bench/b.bench.mjs"],
    flags: ["--update"],
  });
});

test("splitArgs: a flag's value is never mistaken for a bench file", () => {
  assert.deepEqual(splitArgs(["--baseline", "out.json", "--threshold", "0.25"]), {
    files: [],
    flags: ["--baseline", "out.json", "--threshold", "0.25"],
  });
});

// --- GitHub summary ---

const row = (status: Comparison["status"], baseline: number | null, current: number): Comparison => ({
  name: "priceCart",
  baseline,
  current,
  delta: baseline === null ? null : (current - baseline) / baseline,
  noiseFloor: 0.05,
  status,
});

test("summaryMarkdown: a regression gets a red headline and a table row", () => {
  const md = summaryMarkdown([row("regressed", 100_000, 1_100_000)], 0.25, "bench/cart.bench.mjs");
  assert.match(md, /### 🔴 benchguard: bench\/cart\.bench\.mjs/);
  assert.match(md, /1 benchmark\(s\) got more than 25% slower/);
  assert.match(md, /\| priceCart \| 100\.00 µs \| 1\.10 ms \| \+1000\.0% \| 🔴 slower \|/);
});

test("summaryMarkdown: no regressions gets a green headline", () => {
  const md = summaryMarkdown([row("ok", 100_000, 102_000)], 0.25, "x");
  assert.match(md, /### ✅ benchguard/);
  assert.match(md, /Nothing got more than 25% slower/);
});

test("summaryMarkdown: a pipe in a benchmark name can't break the table", () => {
  const md = summaryMarkdown([{ ...row("ok", 1, 1), name: "a | b" }], 0.1, "x");
  assert.match(md, /\| a \\| b \|/);
});
