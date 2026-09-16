#!/usr/bin/env node
/**
 * TOG-2922 install gate: does the PREREQUISITE refresh actually carry usable
 * pace verdicts?
 *
 * Counting the four lane keys is not enough. A lane whose `utilizationFields`
 * no longer match what its collector publishes still appears as a key, with
 * `state: "unknown"` and a null score. The keys-only assertion shipped in the
 * v0.4.4 runbook would have passed that broken prerequisite (TOG-2993), and
 * the later one-key enable in TOG-2921 would then steer on a lane it cannot
 * actually measure.
 *
 * So: the three measurable lanes must each be non-`unknown` AND carry a score,
 * and Kimi must be exactly `unknown` -- its block is deliberately
 * `windows: []` because it publishes no utilization/reset pair, and a
 * computable Kimi verdict means the lane document changed underneath us.
 *
 * Usage: node tog-2922-prerequisite-refresh-gate.mjs <refresh-result.json>
 *        node tog-2922-prerequisite-refresh-gate.mjs -   # read stdin
 */
import { readFileSync } from "node:fs";

export const MEASURABLE_LANES = ["cliproxy-claude", "cliproxy-codex", "cliproxy-opencode-go"];
export const UNKNOWN_LANES = ["cliproxy-kimi"];
export const EXPECTED_LANES = [...MEASURABLE_LANES, ...UNKNOWN_LANES].sort();

/**
 * @param {unknown} result Parsed refresh-result document.
 * @returns {{ok: boolean, failures: string[]}}
 */
export function checkPrerequisiteRefresh(result) {
  const failures = [];
  const verdicts = result?.data?.paceVerdicts;
  if (verdicts === null || typeof verdicts !== "object" || Array.isArray(verdicts)) {
    return { ok: false, failures: ["data.paceVerdicts is missing or not an object"] };
  }

  const actual = Object.keys(verdicts).sort();
  if (actual.length !== EXPECTED_LANES.length || actual.some((id, i) => id !== EXPECTED_LANES[i])) {
    failures.push(`lane set is [${actual.join(", ")}], expected [${EXPECTED_LANES.join(", ")}]`);
  }

  for (const laneId of MEASURABLE_LANES) {
    const verdict = verdicts[laneId];
    if (!verdict) {
      failures.push(`${laneId}: no verdict`);
      continue;
    }
    // `?? "unknown"` on purpose: an absent state is a broken lane, not a pass.
    const state = verdict.state ?? "unknown";
    if (state === "unknown") {
      failures.push(`${laneId}: state is "unknown" -- its pace block does not match the lane document`);
    }
    if (verdict.score === null || verdict.score === undefined) {
      failures.push(`${laneId}: score is null -- no computable governing window`);
    }
  }

  for (const laneId of UNKNOWN_LANES) {
    const verdict = verdicts[laneId];
    if (!verdict) {
      failures.push(`${laneId}: no verdict`);
      continue;
    }
    if (verdict.state !== "unknown") {
      failures.push(`${laneId}: state is "${verdict.state}", expected "unknown" -- the lane document changed and the pace blocks need re-deriving`);
    }
  }

  return { ok: failures.length === 0, failures };
}

function main(argv) {
  const source = argv[2];
  if (!source) {
    console.error("usage: tog-2922-prerequisite-refresh-gate.mjs <refresh-result.json|->");
    return 2;
  }
  const raw = readFileSync(source === "-" ? 0 : source, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(`FAIL: ${source} is not valid JSON: ${error.message}`);
    return 1;
  }
  const { ok, failures } = checkPrerequisiteRefresh(parsed);
  if (!ok) {
    console.error("FAIL: the prerequisite refresh did not produce usable pace verdicts.");
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error("Do not continue to the one-key enable. Re-derive the pace blocks first.");
    return 1;
  }
  console.log(`OK: ${MEASURABLE_LANES.length} measurable pace verdicts, ${UNKNOWN_LANES.length} expected-unknown.`);
  return 0;
}

if (import.meta.filename === process.argv[1]) process.exit(main(process.argv));
