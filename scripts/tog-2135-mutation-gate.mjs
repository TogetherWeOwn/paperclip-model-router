#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const pace = join(root, "packages/lane-capacity/src/pace.ts");
const checker = join(root, "packages/lane-capacity/scripts/check_lane_docs.py");

function run(command, args) {
  return spawnSync(command, args, { cwd: root, encoding: "utf8" });
}

const mutations = [
  {
    name: "max aggregation",
    file: pace,
    from: "return roundHalfEven(values.reduce((sum, entry) => sum + entry.value * entry.weight, 0) / weight);",
    to: "return Math.max(...values.map((entry) => entry.value));",
    command: ["npx", "vitest", "run", "tests/lane-capacity-pace.spec.ts", "-t", "weighted mean|frozen Claude"],
  },
  {
    name: "unknown becomes behind",
    file: pace,
    from: "state: \"unknown\", serviceable: true, score: null, accounts, knownAccountCount: 0, knownWeight: 0, serviceableAccountCount, urgentResetAt: null, reason: \"no-computable-governing-window\"",
    to: "state: \"behind\", serviceable: true, score: null, accounts, knownAccountCount: 0, knownWeight: 0, serviceableAccountCount, urgentResetAt: null, reason: \"no-computable-governing-window\"",
    command: ["npx", "vitest", "run", "tests/lane-capacity-pace.spec.ts", "-t", "unknown fail-neutral"],
  },
  {
    name: "one exhausted account stops pool",
    file: pace,
    from: "if (serviceableAccountCount === 0) {",
    to: "if (serviceableAccountCount < internal.length) {",
    command: ["npx", "vitest", "run", "tests/lane-capacity-pace.spec.ts", "-t", "one five-hour-exhausted"],
  },
  {
    name: "missing weight becomes zero",
    file: pace,
    from: "? { weight: 1, source: \"default\" }",
    to: "? { weight: 0, source: \"default\" }",
    command: ["npx", "vitest", "run", "tests/lane-capacity-pace.spec.ts", "-t", "absent legacy weight"],
  },
  {
    name: "unserviceable account re-enters aggregation (TOG-2674)",
    file: pace,
    from: "entry.utilizationMilli !== null && entry.elapsedMilli !== null && entry.resetAtMs !== null && entry.verdict.serviceable",
    to: "entry.utilizationMilli !== null && entry.elapsedMilli !== null && entry.resetAtMs !== null",
    command: ["npx", "vitest", "run", "tests/lane-capacity-pace.spec.ts", "-t", "never lets a 1.00-utilization"],
  },
  {
    name: "null document passes",
    file: checker,
    from: "return [f\"{spec.document}: document must be a JSON object\"]",
    to: "return []",
    command: ["python3", "-m", "unittest", "discover", "-s", "packages/lane-capacity/tests", "-p", "test_*.py", "-v"],
  },
];

const baseline = run("npx", ["vitest", "run", "tests/lane-capacity-pace.spec.ts"]);
if (baseline.status !== 0) {
  process.stderr.write(baseline.stdout + baseline.stderr);
  throw new Error("pace baseline is red");
}
const pythonBaseline = run("python3", ["-m", "unittest", "discover", "-s", "packages/lane-capacity/tests", "-p", "test_*.py"]);
if (pythonBaseline.status !== 0) {
  process.stderr.write(pythonBaseline.stdout + pythonBaseline.stderr);
  throw new Error("checker baseline is red");
}

const originals = new Map();
for (const mutation of mutations) {
  const original = originals.get(mutation.file) ?? readFileSync(mutation.file, "utf8");
  originals.set(mutation.file, original);
  if (!original.includes(mutation.from)) throw new Error(`${mutation.name}: source anchor not found`);
  try {
    writeFileSync(mutation.file, original.replace(mutation.from, mutation.to));
    const [command, ...args] = mutation.command;
    const result = run(command, args);
    if (result.status === 0) throw new Error(`${mutation.name}: mutant survived`);
    console.log(`PASS: ${mutation.name} was killed`);
  } finally {
    writeFileSync(mutation.file, original);
  }
}
