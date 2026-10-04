#!/usr/bin/env node
/**
 * Pacer policy replay (offline, fixtures only).
 *
 * Replays every synthetic capacity state in
 * tests/pacer-policy-replay.fixture.json through the admit/deny policy table
 * and asserts the replayed decision matches the table. No live capacity poll,
 * no pacing write, no network.
 *
 * The predicate below mirrors the usability gate in src/engine/select.ts:
 * a tripped serviceability window denies; evidence positively reporting
 * exhausted/unavailable denies under any policy; absent or unknown telemetry
 * denies only under fail-closed/exclude-lane; shadow mode never denies.
 * The vitest suite beside this script (tests/pacer-policy-replay.spec.ts)
 * proves the same fixture against the real selector; this script proves the
 * table is self-consistent and gives operators a dependency-free replay.
 *
 * Usage: node scripts/pacer-policy-replay.mjs [--report <path>]
 * Exit code is 1 when any state mismatches.
 *
 * The fixture lives beside the spec, not in tests/fixtures/: verify:host
 * validates every JSON file in tests/fixtures/ against instanceConfigSchema
 * and this synthetic policy table is not an instance config. Keep it out.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const reportIndex = args.indexOf("--report");
const reportPath = resolve(
  root,
  reportIndex === -1 ? "docs/operator/pacer-policy-replay-report.md" : args[reportIndex + 1],
);

const fixture = JSON.parse(
  readFileSync(resolve(root, "tests/pacer-policy-replay.fixture.json"), "utf8"),
);

/**
 * @param {typeof fixture.states[number]} state
 * @returns {{ decision: "admit" | "deny", detail: string }}
 */
function replay(state) {
  const mode = state.config?.mode ?? "enforce";
  const unknownTelemetry = state.config?.unknownTelemetry ?? "fail-open";
  const paceReason = state.pace?.reason ?? null;
  if (mode === "shadow") {
    return { decision: "admit", detail: "shadow mode serves the static pool; capacity never denies" };
  }
  if (paceReason === "serviceability-window-exhausted") {
    return { decision: "deny", detail: "tripped serviceability window denies despite healthy capacity" };
  }
  const evidence = state.evidence?.[0] ?? null;
  if (!evidence) {
    return unknownTelemetry === "fail-open"
      ? { decision: "admit", detail: "missing evidence admits under fail-open" }
      : { decision: "deny", detail: `missing evidence denies under ${unknownTelemetry}` };
  }
  if (evidence.health === "exhausted" || evidence.health === "unavailable") {
    return { decision: "deny", detail: `explicit ${evidence.health} health denies under any policy` };
  }
  if (!evidence.telemetryAvailable || evidence.health === "unknown") {
    return unknownTelemetry === "fail-open"
      ? { decision: "admit", detail: "unknown telemetry admits under fail-open" }
      : { decision: "deny", detail: `unknown telemetry denies under ${unknownTelemetry}` };
  }
  return { decision: "admit", detail: "usable lane admits (available, conserve and avoid postures are covered)" };
}

const rows = fixture.states.map((state) => {
  const replayed = replay(state);
  const match = replayed.decision === state.expect.decision;
  return { id: state.id, title: state.title, expected: state.expect.decision, replayed: replayed.decision, detail: replayed.detail, match };
});

const mismatches = rows.filter((row) => !row.match);

const lines = [
  "# Pacer policy replay report",
  "",
  `Fixture: tests/pacer-policy-replay.fixture.json (version ${fixture.version}, ${rows.length} synthetic states).`,
  "Replay: node scripts/pacer-policy-replay.mjs. Offline; no live capacity poll, no pacing write.",
  `Result: ${rows.length - mismatches.length}/${rows.length} states decide as the policy table says.`,
  "",
  "| State | Expected | Replayed | Match | Why |",
  "| --- | --- | --- | --- | --- |",
  ...rows.map((row) => `| ${row.id} | ${row.expected} | ${row.replayed} | ${row.match ? "yes" : "NO"} | ${row.detail} |`),
  "",
];
if (mismatches.length > 0) {
  lines.push(`Mismatches: ${mismatches.map((row) => row.id).join(", ")}.`, "");
}

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, lines.join("\n"));

for (const row of rows) {
  console.log(`${row.match ? "PASS" : "FAIL"} ${row.id}: expected ${row.expected}, replayed ${row.replayed} — ${row.detail}`);
}
if (mismatches.length > 0) {
  console.error(`${mismatches.length} mismatch(es); report written to ${reportPath}`);
  process.exit(1);
}
console.log(`All ${rows.length} synthetic states decide as the policy table says; report written to ${reportPath}`);
