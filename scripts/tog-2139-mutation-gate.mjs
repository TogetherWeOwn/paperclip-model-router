#!/usr/bin/env node
// TOG-2139 (slice 6) mutation gate. The acceptance names these mutants; each
// must FAIL the suite when applied (a mutant that survives means the tests
// cannot tell the difference — the gate is the deliverable, not the flag).
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const select = join(root, "src/engine/select.ts");

function run(command, args) {
  return spawnSync(command, args, { cwd: root, encoding: "utf8" });
}

const mutations = [
  {
    // MUTANT 1 — the acceptance's named mutant: pace applied to the full
    // qualified pool BEFORE survivor filtering, letting an ineligible model
    // surface in candidates/win on a favorable pace verdict (the shadow-pool
    // ordering also changes, which is what the shadow test observes).
    name: "pace reorders across qualityFloor/capability eligibility",
    file: select,
    from: "  const ranked = withCapacity\n    .filter((entry) => survivorIds.has(entry.model.id))\n    .map((entry): Ranked => ({ ...entry, pace: paceFor(entry.model.id) }))\n    .sort(baselineOrder);",
    to: "  const ranked = withCapacity\n    .map((entry): Ranked => ({ ...entry, pace: paceFor(entry.model.id) }))\n    .sort(paceOrder(baselineOrder));",
    command: ["npx", "vitest", "run", "tests/pace-ordering.spec.ts"],
  },
  {
    // MUTANT 2 — the pace comparator discards the capacity-ordering fallback,
    // so same-pace ties resolve by input order instead of evidence rank and
    // utilization.
    name: "pace tie-break drops the capacity ordering",
    file: select,
    from: "  const usageAware = ranked.filter(usable).sort(paceActive ? paceOrder(capacityOrder) : capacityOrder);",
    to: "  const usageAware = ranked.filter(usable).sort(paceActive ? paceOrder(() => 0) : capacityOrder);",
    command: ["npx", "vitest", "run", "tests/pace-ordering.spec.ts", "-t", "same-pace ties"],
  },
  {
    // MUTANT 3 — unknown verdict treated as behind: a stale/unknown snapshot
    // would outrank every known lane instead of ranking last (fail-neutral).
    name: "unknown pace verdict ranks as behind",
    file: select,
    from: "  unknown: 6,",
    to: "  unknown: 0,",
    command: ["npx", "vitest", "run", "tests/pace-ordering.spec.ts", "-t", "fail-neutral"],
  },
];

let failed = 0;
for (const mutation of mutations) {
  const original = readFileSync(mutation.file, "utf8");
  if (!original.includes(mutation.from)) {
    console.error(`GATE BROKEN (anchor not found for "${mutation.name}") — update the mutation to match the source.`);
    failed += 1;
    continue;
  }
  writeFileSync(mutation.file, original.replace(mutation.from, mutation.to));
  try {
    const result = run(mutation.command[0], mutation.command.slice(1));
    const survived = result.status === 0;
    console.log(`${survived ? "SURVIVED ✗" : "killed ✓"} — ${mutation.name} (vitest exit ${result.status})`);
    if (survived) failed += 1;
  } finally {
    writeFileSync(mutation.file, original);
  }
}

if (failed > 0) {
  console.error(`\n${failed} mutant(s) survived — TOG-2139 acceptance NOT met.`);
  process.exit(1);
}
console.log("\nall named mutants killed — TOG-2139 acceptance met.");
