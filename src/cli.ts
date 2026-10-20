#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { splitArgs } from "./index.js";

const HELP = `benchguard: fail CI when your code gets slower

  npx benchguard init          create a starter benchmark and a GitHub workflow
  npx benchguard               run every *.bench.* file in ./bench
  npx benchguard <files...>    run specific bench files

  --update            record a new baseline instead of checking
  --baseline <path>   where the baseline lives (default benchguard.baseline.json)
  --threshold <n>     how much slower is too slow, e.g. 0.25 for 25%
`;

const BENCH_FILE = /\.bench\.[cm]?[jt]s$/;

const EXAMPLE = `// A starter benchmark. Once you've seen it work, point it at a function from
// your own code: something that runs on every request, with realistic data.
import { bench, run } from "benchguard";

const users = Array.from({ length: 2000 }, (_, i) => ({ id: i, name: \`user \${i}\` }));
const wanted = Array.from({ length: 2000 }, (_, i) => (i * 7) % 2000);

// Try breaking it: swap the Map lookup for
//   wanted.map((id) => users.find((u) => u.id === id))
// then run \`npx benchguard\` again and watch it fail.
function findUsers() {
  const byId = new Map(users.map((u) => [u.id, u]));
  return wanted.map((id) => byId.get(id));
}

bench("find 2k users by id", findUsers);

await run();
`;

const WORKFLOW = `name: benchguard

on: [pull_request]

# Measures the base branch and this PR on the same machine, one after the other,
# so the only difference between the two numbers is your code.

jobs:
  perf:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Measure the base branch
        run: |
          git checkout --detach \${{ github.event.pull_request.base.sha }}
          npm ci
          if [ -e node_modules/benchguard ]; then
            npx benchguard --update --baseline "$RUNNER_TEMP/benchguard.json"
          else
            echo "benchguard isn't on the base branch yet, so there's nothing to compare against. Skipping."
          fi

      - name: Measure this PR
        run: |
          git checkout --detach \${{ github.event.pull_request.head.sha }}
          npm ci
          # 0.25 = fail when 25% slower. CI machines are noisy, so keep it loose.
          npx benchguard --baseline "$RUNNER_TEMP/benchguard.json" --threshold 0.25
`;

function create(path: string, content: string): void {
  if (existsSync(path)) {
    console.log(`  skip    ${path} (already exists)`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  console.log(`  create  ${path}`);
}

function init(): number {
  console.log("");
  create(join("bench", "example.bench.mjs"), EXAMPLE);
  create(join(".github", "workflows", "benchguard.yml"), WORKFLOW);
  console.log(`
Try it:
  npx benchguard --update    record how fast it is right now
  npx benchguard             check again (passes)

Then open bench/example.bench.mjs, swap the Map lookup for .find() like the
comment says, and run \`npx benchguard\` again. It fails. That's the point.
`);
  return 0;
}

function findBenchFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => BENCH_FILE.test(f) && !f.split(/[\\/]/).includes("node_modules"))
    .map((f) => join(dir, f))
    .sort();
}

function runAll(argv: string[]): number {
  const { files, flags } = splitArgs(argv);
  const targets = files.length ? files : findBenchFiles("bench");
  if (targets.length === 0) {
    console.log(
      "benchguard: no bench files found in ./bench (looking for *.bench.mjs, *.bench.mts, ...).\n" +
        "  Run `npx benchguard init` to create one.",
    );
    return 0;
  }
  let failed = false;
  // One file at a time, never in parallel: benchmarks fighting over the same
  // CPU would measure each other instead of your code.
  for (const file of targets) {
    console.log(`\n> ${file}`);
    const r = spawnSync(process.execPath, [file, ...flags], { stdio: "inherit" });
    if (r.status !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

const args = process.argv.slice(2);
if (args[0] === "--help" || args[0] === "-h") {
  console.log(HELP);
} else if (args[0] === "init") {
  process.exitCode = init();
} else {
  process.exitCode = runAll(args);
}
