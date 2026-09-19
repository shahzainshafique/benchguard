import test from "node:test";
import assert from "node:assert/strict";
import { computeStats, compareOne, measure, type Stats } from "./index.js";

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

// compareOne decision logic — build Stats directly so we control the noise.
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
