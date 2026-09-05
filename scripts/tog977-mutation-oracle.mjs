#!/usr/bin/env node
/**
 * TOG-977 mutation oracle.
 *
 * A green suite proves nothing on its own. Each mutation below breaks exactly
 * one contract §6 obligation in the consumer; the run FAILS unless the TOG-977
 * acceptance tests go red for every one of them. That is the difference between
 * "the tests pass" and "the tests would notice".
 *
 * Mutations come in three kinds, because a fix can rot in three ways:
 *   remove   — delete the check entirely
 *   weaken   — keep the check but make it permissive
 *   rescope  — keep the check, apply it where it cannot bite
 *
 * Usage: node scripts/tog977-mutation-oracle.mjs
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT = join(ROOT, "src/capacity/contract.ts");
const SELECT = join(ROOT, "src/engine/select.ts");

/** @type {Array<{name: string, kind: string, obligation: string, file: string, find: string, replace: string}>} */
const MUTATIONS = [
  {
    name: "schema-version-check-removed",
    kind: "remove",
    obligation: "§6.1 reject an unknown schemaVersion",
    file: CONTRACT,
    find: "if (record.schemaVersion !== TELEMETRY_SCHEMA_VERSION) {\n    return { ok: false, reasonCode: \"capacity-schema-version-unsupported\" };\n  }",
    replace: "",
  },
  {
    name: "schema-version-check-weakened-to-presence",
    kind: "weaken",
    obligation: "§6.1 reject an unknown schemaVersion",
    file: CONTRACT,
    find: "if (record.schemaVersion !== TELEMETRY_SCHEMA_VERSION) {",
    replace: "if (typeof record.schemaVersion !== \"number\") {",
  },
  {
    name: "staleness-check-removed",
    kind: "remove",
    obligation: "§6.2 a stale snapshot is unavailable",
    file: CONTRACT,
    find: "if (fetchedAtMs - observedAtMs > snapshot.staleAfterSeconds * 1000) {\n    return unavailable(input.source, input.fetchedAt, \"capacity-snapshot-stale\");\n  }",
    replace: "",
  },
  {
    name: "staleness-rescoped-to-fetch-time",
    kind: "rescope",
    obligation: "§6.2 staleness is judged against observedAt, not serve time",
    file: CONTRACT,
    // The check survives and still rejects a clock skew, but measuring
    // fetchedAt against itself can never be stale — a cached body reads fresh.
    find: "if (fetchedAtMs - observedAtMs > snapshot.staleAfterSeconds * 1000) {",
    replace: "if (fetchedAtMs - fetchedAtMs > snapshot.staleAfterSeconds * 1000) {",
  },
  {
    name: "outage-collapsed-into-healthy-empty",
    kind: "remove",
    obligation: "§4 outage is not emptiness",
    file: CONTRACT,
    find: "if (snapshot.telemetry === \"unavailable\") {\n    return unavailable(input.source, input.fetchedAt, \"capacity-producer-unavailable\");\n  }",
    replace: "",
  },
  {
    name: "model-key-lookup-fanned-across-ids",
    kind: "rescope",
    obligation: "§2.3/§6.3 one record per model id, keyed byte-for-byte",
    file: CONTRACT,
    // Reintroduces exactly the v0.4.0 defect: take whatever record exists and
    // attribute it to every configured id.
    find: "const record = snapshot.models[modelId];",
    replace: "const record = snapshot.models[modelId] ?? Object.values(snapshot.models)[0];",
  },
  {
    name: "serviceable-state-agreement-not-enforced",
    kind: "remove",
    obligation: "§3.2 serviceable is derived from state",
    file: CONTRACT,
    find: "if (record.serviceable !== serviceableForState(record.state)) return null;",
    replace: "",
  },
  {
    name: "producer-health-inferred-from-row-count",
    kind: "rescope",
    obligation: "§4 asserted by CONSUMER BEHAVIOUR in selectModel",
    file: SELECT,
    // The pre-TOG-977 behaviour. This is the mutation that matters most: it
    // leaves every field intact and only changes what selectModel BELIEVES,
    // so a test asserting on snapshot fields alone would not catch it.
    find: "const producerHealthy = runtime.capacityTelemetry !== undefined\n    ? runtime.capacityTelemetry === \"available\"\n    : evidence.length > 0;",
    replace: "const producerHealthy = evidence.length > 0;",
  },
];

const TEST_ARGS = ["vitest", "run", "tests/capacity.spec.ts", "--reporter=basic"];

function runTests() {
  try {
    execFileSync("npx", TEST_ARGS, { cwd: ROOT, stdio: "pipe", encoding: "utf8" });
    return { green: true, output: "" };
  } catch (error) {
    return { green: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

function failedTestNames(output) {
  return [...output.matchAll(/(?:×|✗|FAIL)\s+(.+)/g)].map((match) => match[1].trim());
}

// Baseline. If the suite is not green to begin with, nothing below means anything.
const baseline = runTests();
if (!baseline.green) {
  console.error("BASELINE IS RED — the oracle cannot measure anything.");
  console.error(baseline.output.slice(-4000));
  process.exit(1);
}
console.log("baseline: GREEN\n");

const results = [];
for (const mutation of MUTATIONS) {
  const original = readFileSync(mutation.file, "utf8");
  if (!original.includes(mutation.find)) {
    results.push({ ...mutation, verdict: "NOT-APPLIED", detail: "anchor text not found — the mutation is stale" });
    continue;
  }
  writeFileSync(mutation.file, original.replace(mutation.find, mutation.replace));
  try {
    const mutated = runTests();
    const caught = !mutated.green;
    results.push({
      ...mutation,
      verdict: caught ? "CAUGHT" : "SURVIVED",
      detail: caught ? failedTestNames(mutated.output).slice(0, 3).join(" | ") : "suite stayed green",
    });
  } finally {
    writeFileSync(mutation.file, original);
  }
}

// Restore-check: the tree must be byte-identical to where we started.
const restored = runTests();
console.log(`${"mutation".padEnd(46)} ${"kind".padEnd(8)} verdict`);
console.log("-".repeat(78));
for (const result of results) {
  console.log(`${result.name.padEnd(46)} ${result.kind.padEnd(8)} ${result.verdict}`);
  console.log(`    obligation: ${result.obligation}`);
  if (result.detail) console.log(`    ${result.detail}`);
}
console.log("-".repeat(78));
console.log(`restored tree: ${restored.green ? "GREEN" : "RED"}`);

const bad = results.filter((result) => result.verdict !== "CAUGHT");
if (bad.length > 0 || !restored.green) {
  console.error(`\nFAIL: ${bad.length} mutation(s) not caught${restored.green ? "" : "; tree not restored"}`);
  process.exit(1);
}
console.log(`\nPASS: ${results.length}/${results.length} mutations caught, tree restored.`);
