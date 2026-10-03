#!/usr/bin/env node
/**
 * Pacer shadow-mode dual-policy diff (offline, recorded decisions only).
 *
 * Reads tests/pacer-shadow-diff.fixture.json — twelve decision inputs built
 * from RECORDED evidence (tog2135 lane documents evaluated to pace verdicts,
 * first-record values from the tog1076 live snapshot) — and diffs the two
 * embedded policy decisions per case: the recorded serving policy (shadow
 * mode, paceOrdering off) against the promotion candidate (enforce mode,
 * paceOrdering on). Writes the diff report (agree/disagree counts plus every
 * disagreeing case with its lane move and reason) to
 * docs/operator/pacer-shadow-diff-report.md.
 *
 * No live capacity poll, no pacing write, no network, no selector import:
 * the per-case winners are embedded in the fixture, and the sibling vitest
 * suite (tests/pacer-shadow-diff.spec.ts) proves each embedded winner against
 * the real selector. This script proves the table is self-consistent (tallies
 * match, every disagreement carries a reason and a real lane move) and gives
 * operators a dependency-free report regeneration.
 *
 * Non-goals (owned elsewhere): TOG-14188 synthetic-state replay,
 * TOG-14079 audit-log append path.
 *
 * Usage: node scripts/pacer-shadow-diff.mjs [--report <path>]
 * Exit code is 1 when any tally or lane move mismatches.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const reportIndex = args.indexOf("--report");
const reportPath = resolve(
  root,
  reportIndex === -1 ? "docs/operator/pacer-shadow-diff-report.md" : args[reportIndex + 1],
);

const fixture = JSON.parse(
  readFileSync(resolve(root, "tests/pacer-shadow-diff.fixture.json"), "utf8"),
);

const failures = [];

/**
 * Lane move for one case, mirroring buildDecisionDiff (src/decision-diff.ts):
 * changed when source, lane label, or model id differs. Lane labels are
 * "record-1" wherever recorded evidence covers the model, else null.
 */
function diffOf(c) {
  const laneOf = (side) => ({
    source: side.lane,
    laneLabel: side.lane === null ? null : "record-1",
    modelId: side.modelId,
  });
  const oldLane = laneOf(c.expect.baseline);
  const newLane = laneOf(c.expect.candidate);
  const changed =
    oldLane.source !== newLane.source ||
    oldLane.laneLabel !== newLane.laneLabel ||
    oldLane.modelId !== newLane.modelId;
  return { oldLane, newLane, changed };
}

let agree = 0;
const disagreements = [];
for (const c of fixture.cases) {
  const { oldLane, newLane, changed } = diffOf(c);
  if (!changed) {
    agree += 1;
    continue;
  }
  if (!c.reason || c.reason.trim().length === 0) {
    failures.push(`${c.id}: disagreeing case carries no reason`);
    continue;
  }
  disagreements.push({ c, oldLane, newLane });
}

if (agree !== fixture.agree) {
  failures.push(`agree tally: fixture pins ${fixture.agree}, recomputed ${agree}`);
}
if (disagreements.length !== fixture.disagree) {
  failures.push(`disagree tally: fixture pins ${fixture.disagree}, recomputed ${disagreements.length}`);
}
if (fixture.cases.length !== fixture.agree + fixture.disagree) {
  failures.push(`corpus size ${fixture.cases.length} != agree ${fixture.agree} + disagree ${fixture.disagree}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`MISMATCH: ${failure}`);
  process.exit(1);
}

const laneName = (lane) =>
  lane.modelId === null ? "(refused: no eligible model)" : `${lane.modelId} on ${lane.source ?? "unknown lane"}`;

const lines = [];
lines.push("# Pacer shadow-mode dual-policy diff (offline, recorded decisions)");
lines.push("");
lines.push(`Baseline (recorded serving policy): ${fixture.baseline}.`);
lines.push("");
lines.push(`Candidate (promotion): ${fixture.candidate}.`);
lines.push("");
lines.push("Inputs (all recorded, none synthesized):");
lines.push(`- pace verdicts: real evaluations of ${["claude", "codex", "kimi", "opencode-go"].map((lane) => fixture.inputs.laneDocuments[lane]).join(", ")}`);
lines.push(`  at ${fixture.inputs.laneDocuments.observedAt}: claude behind (deviation -0.130); codex, kimi and`);
lines.push("  opencode-go ahead (deviations +0.537, +0.118, +0.279). Pinned by tests/pacer-shadow-diff.spec.ts.");
lines.push(`- capacity evidence: ${fixture.inputs.snapshot}.`);
lines.push("- model table, task classes and per-case roster/descriptor variations: replay harness scaffolding,");
lines.push("  cited per case below. No policy applied, nothing re-admitted.");
lines.push("");
lines.push(`Result: ${agree} agree / ${disagreements.length} disagree across ${fixture.cases.length} recorded decision inputs.`);
lines.push("");
lines.push("## Agreeing cases");
lines.push("");
for (const c of fixture.cases) {
  if (disagreements.some((d) => d.c.id === c.id)) continue;
  const served = c.expect.baseline.modelId === null
    ? "both policies refuse (no eligible model)"
    : `both serve ${c.expect.baseline.modelId}`;
  lines.push(`- ${c.id} (${c.title}): ${served}. ${c.note}`);
}
lines.push("");
lines.push("## Disagreeing cases (recorded lane -> candidate lane)");
lines.push("");
for (const { c, oldLane, newLane } of disagreements) {
  lines.push(`### ${c.id}: ${c.title}`);
  lines.push("");
  lines.push(`- Recorded: ${laneName(oldLane)}.`);
  lines.push(`- Candidate: ${laneName(newLane)}.`);
  lines.push(`- Why it moves: ${c.reason}.`);
  lines.push(`- Context: ${c.note}`);
  lines.push("");
}
lines.push("## Reading the split");
lines.push("");
lines.push("- The candidate diverts exactly where pace or the enforce gate has a real signal: the behind-pace");
lines.push("  claude lane wins full-roster and reduced-roster cases (d01, d02, d03); the stale-pace fallback");
lines.push("  follows utilization, not cost (d09); the exhausted-lane pin is refused-then-diverted (d11).");
lines.push("- The candidate never promotes across quality, capability, halt, or stickiness gates (d05, d06, d07,");
lines.push("  d10, d12) and never invents a winner when pace is stale but utilization agrees with cost (d08).");
lines.push("- Watch item: d11 logs the pin refusal under BOTH policies but only enforce acts on it — shadow");
lines.push("  keeps serving a pin it just refused. That is the sharpest shadow-vs-enforce behavioral gap found.");
lines.push("");

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${lines.join("\n")}`);
console.log(`pacer-shadow-diff: ${agree} agree / ${disagreements.length} disagree across ${fixture.cases.length} cases -> ${reportPath}`);
