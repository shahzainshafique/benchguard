import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface MeasureOptions {
  /** Total time to spend sampling one benchmark (ms). Default 500. */
  timeBudgetMs?: number;
  /** Minimum samples to collect regardless of budget. Default 10. */
  minSamples?: number;
  /** Hard cap on samples. Default 200. */
  maxSamples?: number;
  /** Time to run the fn untimed before sampling, to let the JIT warm up (ms). Default 100. */
  warmupMs?: number;
  /** Minimum nanoseconds per timed batch. Bigger = less timer-resolution error. Default 1e6 (1ms). */
  minBatchNs?: number;
}

export interface Stats {
  /** Median time per operation, in nanoseconds. This is the value we compare. */
  median: number;
  mean: number;
  min: number;
  /** Sample standard deviation (n-1). */
  stddev: number;
  /** 95% margin of error on the mean, in ns. */
  moe: number;
  /** Relative margin of error, as a percent of the mean. The "how noisy is this" number. */
  rme: number;
  /** Number of sample batches collected. */
  samples: number;
  /** Operations per timed batch. */
  batch: number;
}

export type BenchFn = () => unknown | Promise<unknown>;

interface Benchmark {
  name: string;
  fn: BenchFn;
}

const registry: Benchmark[] = [];

/** Register a benchmark. Sync or async functions both work. */
export function bench(name: string, fn: BenchFn): void {
  if (registry.some((b) => b.name === name)) {
    throw new Error(`benchguard: duplicate benchmark name "${name}"`);
  }
  registry.push({ name, fn });
}

/** Clear the registry. Mainly for tests. */
export function reset(): void {
  registry.length = 0;
}

/** Ceiling on operations per timed batch. Hitting it means the fn is too fast to time. */
const MAX_BATCH = 1e8;

// Assigned inside the hot loop so V8 can't dead-code-eliminate the benchmark body.
let _sink: unknown;

async function detectAsync(fn: BenchFn): Promise<boolean> {
  const r = fn();
  if (r && typeof (r as PromiseLike<unknown>).then === "function") {
    await r;
    return true;
  }
  return false;
}

async function timeBatch(fn: BenchFn, batch: number, isAsync: boolean): Promise<number> {
  if (isAsync) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < batch; i++) _sink = await fn();
    return Number(process.hrtime.bigint() - t0);
  }
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < batch; i++) _sink = fn();
  return Number(process.hrtime.bigint() - t0);
}

export function computeStats(perOp: number[], batch: number): Stats {
  const n = perOp.length;
  if (n === 0) throw new Error("computeStats: no samples");
  const sorted = [...perOp].sort((a, b) => a - b);
  const mean = sorted.reduce((s, x) => s + x, 0) / n;
  const median =
    n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const min = sorted[0];
  const variance =
    n > 1 ? sorted.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
  const stddev = Math.sqrt(variance);
  // 1.96 = ~95% z-score. ponytail: z-approximation, swap for a t-table if minSamples drops below ~10.
  const moe = n > 1 ? (1.96 * stddev) / Math.sqrt(n) : 0;
  const rme = mean > 0 ? (moe / mean) * 100 : 0;
  return { median, mean, min, stddev, moe, rme, samples: n, batch };
}

/** Measure one function and return its timing statistics. */
export async function measure(fn: BenchFn, opts: MeasureOptions = {}): Promise<Stats> {
  const timeBudgetNs = (opts.timeBudgetMs ?? 500) * 1e6;
  const minSamples = opts.minSamples ?? 10;
  const maxSamples = opts.maxSamples ?? 200;
  const warmupNs = BigInt(Math.round((opts.warmupMs ?? 100) * 1e6));
  const minBatchNs = opts.minBatchNs ?? 1e6;

  const isAsync = await detectAsync(fn);

  // Warmup: run untimed until warmupNs elapses.
  {
    const t0 = process.hrtime.bigint();
    do {
      if (isAsync) await fn();
      else fn();
    } while (process.hrtime.bigint() - t0 < warmupNs);
  }

  // Calibrate batch size so each timed batch takes at least minBatchNs.
  let batch = 1;
  while (batch < MAX_BATCH) {
    const t = await timeBatch(fn, batch, isAsync);
    if (t >= minBatchNs) break;
    const grow = Math.ceil((batch * minBatchNs) / Math.max(t, 1));
    batch = Math.min(MAX_BATCH, Math.max(batch * 2, grow));
  }

  // Collect samples until we hit minSamples and the time budget (or maxSamples).
  const perOp: number[] = [];
  const start = process.hrtime.bigint();
  while (
    perOp.length < maxSamples &&
    (perOp.length < minSamples ||
      process.hrtime.bigint() - start < BigInt(Math.round(timeBudgetNs)))
  ) {
    const t = await timeBatch(fn, batch, isAsync);
    perOp.push(t / batch);
  }

  return computeStats(perOp, batch);
}

/**
 * Sanity-check a measurement and report anything that makes it untrustworthy.
 * A benchmark that quietly measures nothing is worse than no benchmark at all:
 * it reports a confident "ok" forever while production gets slower.
 */
export function trustWarnings(s: Stats): string[] {
  const w: string[] = [];
  if (s.rme > 10) {
    w.push(
      `very noisy (±${s.rme.toFixed(1)}%): any regression smaller than that is invisible. ` +
        `Raise timeBudgetMs, or close whatever else is running.`,
    );
  }
  if (s.samples < 10) {
    w.push(
      `only ${s.samples} sample(s) collected: the median is shaky. Raise timeBudgetMs.`,
    );
  }
  if (s.median < 1) {
    w.push(
      `${s.median.toFixed(2)}ns per op is suspiciously close to zero: the body may have been ` +
        `optimized away. Make the benchmark return a value that depends on the work.`,
    );
  }
  if (s.batch >= MAX_BATCH) {
    w.push(
      `batch size hit its ceiling: this function is too fast to time on its own. ` +
        `Benchmark a bigger unit of work.`,
    );
  }
  return w;
}

/** Read `--flag value` or `--flag=value` from argv. Returns undefined if absent. */
export function argValue(flag: string, argv: string[] = process.argv): string | undefined {
  const i = argv.indexOf(flag);
  if (i !== -1) {
    const next = argv[i + 1];
    // Guard against `--baseline --update` swallowing the next flag as a value.
    if (next !== undefined && !next.startsWith("--")) return next;
  }
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
}

/**
 * Parse a threshold, rejecting junk. A NaN threshold would silently disable the
 * guard entirely (every comparison against NaN is false), so bad input must throw
 * rather than quietly pass every build.
 */
export function parseThreshold(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `benchguard: invalid threshold ${JSON.stringify(raw)}. Expected a number >= 0, e.g. 0.15 for 15%.`,
    );
  }
  return n;
}

export type Status = "ok" | "regressed" | "improved" | "new";

export interface Comparison {
  name: string;
  /** Baseline median ns, or null if this benchmark is new. */
  baseline: number | null;
  /** Current median ns. */
  current: number;
  /** Relative change as a fraction (+0.2 = 20% slower), or null if new. */
  delta: number | null;
  /** Combined relative measurement noise as a fraction. A change smaller than this is untrustworthy. */
  noiseFloor: number | null;
  status: Status;
}

/**
 * Compare one current measurement against its baseline.
 * A regression is flagged only when the slowdown clears BOTH the threshold
 * AND the combined measurement noise. This is what stops flaky CI failures.
 */
export function compareOne(
  name: string,
  base: Stats | undefined,
  cur: Stats,
  threshold: number,
): Comparison {
  if (!base) {
    return { name, baseline: null, current: cur.median, delta: null, noiseFloor: null, status: "new" };
  }
  const delta = (cur.median - base.median) / base.median;
  const noiseFloor = (base.rme + cur.rme) / 100;
  let status: Status = "ok";
  if (delta > threshold && delta > noiseFloor) status = "regressed";
  else if (delta < -threshold && -delta > noiseFloor) status = "improved";
  return { name, baseline: base.median, current: cur.median, delta, noiseFloor, status };
}

export interface RunOptions extends MeasureOptions {
  /** Baseline file path. Default "benchguard.baseline.json". */
  baseline?: string;
  /** Fail threshold as a fraction. Default 0.1 (10% slower). */
  threshold?: number;
  /** Write/overwrite the baseline instead of comparing. Defaults to true when process args include --update. */
  update?: boolean;
  /**
   * CPU busy-spin before the first measurement (ms). Ramps CPU turbo/frequency
   * so the first benchmark isn't penalized by cold-start, the single biggest
   * source of phantom regressions between --update and compare. Default 300.
   */
  globalWarmupMs?: number;
}

interface BaselineFile {
  version: 1;
  createdAt: string;
  benchmarks: Record<string, Stats>;
}

export function formatTime(ns: number): string {
  if (ns < 1e3) return `${ns.toFixed(1)} ns`;
  if (ns < 1e6) return `${(ns / 1e3).toFixed(2)} µs`;
  if (ns < 1e9) return `${(ns / 1e6).toFixed(2)} ms`;
  return `${(ns / 1e9).toFixed(2)} s`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function printTable(rows: Comparison[]): void {
  const cols = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    base: 12,
    cur: 12,
    delta: 9,
  };
  const head =
    pad("name", cols.name) + "  " + pad("baseline", cols.base) + "  " +
    pad("current", cols.cur) + "  " + pad("delta", cols.delta) + "  status";
  console.log("\n" + head);
  console.log("-".repeat(head.length));
  for (const r of rows) {
    const delta =
      r.delta === null ? "-" : `${r.delta >= 0 ? "+" : ""}${(r.delta * 100).toFixed(1)}%`;
    const mark =
      r.status === "regressed" ? "✗ SLOWER" :
      r.status === "improved" ? "✓ faster" :
      r.status === "new" ? "＋ new" : "ok";
    console.log(
      pad(r.name, cols.name) + "  " +
      pad(r.baseline === null ? "-" : formatTime(r.baseline), cols.base) + "  " +
      pad(formatTime(r.current), cols.cur) + "  " +
      pad(delta, cols.delta) + "  " + mark,
    );
  }
}

/**
 * Run all registered benchmarks. Compares against the baseline and sets a
 * non-zero exit code on regression, or writes the baseline when update is set.
 */
export async function run(opts: RunOptions = {}): Promise<Comparison[] | undefined> {
  // CLI flag beats env var beats the value hardcoded in the script. This is what
  // lets one benchmark file serve both local runs and CI without being edited.
  const path =
    argValue("--baseline") ??
    process.env.BENCHGUARD_BASELINE ??
    opts.baseline ??
    "benchguard.baseline.json";
  const threshold = parseThreshold(
    argValue("--threshold") ?? process.env.BENCHGUARD_THRESHOLD,
    opts.threshold ?? 0.1,
  );
  const update = opts.update ?? process.argv.includes("--update");

  if (registry.length === 0) {
    console.error("benchguard: no benchmarks registered (call bench() before run())");
    process.exitCode = 1;
    return;
  }

  // Spin the CPU to a steady clock before the first real measurement.
  // ponytail: one warm-up spin handles cold-start; for steady-state run-to-run
  // drift, run each benchmark in its own process invocation (see roadmap).
  {
    const spinNs = BigInt(Math.round((opts.globalWarmupMs ?? 300) * 1e6));
    const t0 = process.hrtime.bigint();
    let x = 0;
    while (process.hrtime.bigint() - t0 < spinNs) x += Math.sqrt(x + 1);
    _sink = x;
  }

  const current: Record<string, Stats> = {};
  for (const b of registry) {
    process.stdout.write(`  measuring ${b.name} ... `);
    const s = await measure(b.fn, opts);
    current[b.name] = s;
    console.log(`${formatTime(s.median)}/op  ±${s.rme.toFixed(1)}%`);
    for (const w of trustWarnings(s)) console.log(`      ! ${w}`);
  }

  if (update) {
    const file: BaselineFile = {
      version: 1,
      createdAt: new Date().toISOString(),
      benchmarks: current,
    };
    writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
    console.log(`\nBaseline written to ${path} (${registry.length} benchmarks)`);
    return;
  }

  if (!existsSync(path)) {
    console.log(`\nNo baseline at ${path}. Run with --update to create one.`);
    return;
  }

  let baseline: Record<string, Stats>;
  try {
    baseline = (JSON.parse(readFileSync(path, "utf8")) as BaselineFile).benchmarks;
  } catch (e) {
    console.error(`benchguard: could not read baseline ${path}: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const comparisons = registry.map((b) =>
    compareOne(b.name, baseline[b.name], current[b.name], threshold),
  );
  printTable(comparisons);

  const regressed = comparisons.filter((c) => c.status === "regressed");
  const gone = Object.keys(baseline).filter((n) => !(n in current));
  if (gone.length) console.log(`\nnote: ${gone.length} baseline benchmark(s) no longer present: ${gone.join(", ")}`);

  if (regressed.length) {
    console.error(`\n✗ ${regressed.length} regression(s) over ${(threshold * 100).toFixed(0)}% threshold`);
    process.exitCode = 1;
  } else {
    console.log("\n✓ no regressions");
  }
  return comparisons;
}
