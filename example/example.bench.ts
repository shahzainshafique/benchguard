import { bench, run } from "../src/index.js";

const data = Array.from({ length: 1000 }, () => Math.random());

bench("spread + sort", () => [...data].sort((a, b) => a - b));

bench("slice + sort", () => {
  const c = data.slice();
  c.sort((a, b) => a - b);
  return c;
});

bench("JSON round-trip", () => JSON.parse(JSON.stringify(data)));

// Run normally to compare against the baseline; pass --update to (re)write it.
await run({ threshold: 0.1, baseline: "example/baseline.json" });
