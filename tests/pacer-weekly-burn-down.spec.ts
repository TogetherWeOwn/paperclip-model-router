import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BURN_DOWN_TARGET_HIGH,
  BURN_DOWN_TARGET_LOW,
  laneBurnDown,
  projectBurnDown,
} from "../packages/lane-capacity/src/burn-down.js";
import { evaluateLanePace, normalizeLaneDocument, type LanePaceVerdict } from "../packages/lane-capacity/src/pace.js";

// Weekly burn-down readout toward the 98-100% subscription target.
//
// Every account projects from a REAL pace evaluation of a RECORDED lane
// document (packages/lane-capacity/tests/data/tog2135, frozen observedAt) or
// from synthetic burn states driven through the real evaluator — never from
// hand-typed scores. The readout is read-only: pure arithmetic over
// utilization/elapsed, no config write, no host call, no admission change.
//
// Scope boundaries (owned elsewhere, not duplicated here):
// - per-decision allow/deny audit log: the admission audit slice;
// - the Muse-lane countdown: the countdown slice;
// - single-state admit/deny replay and burn-path calibration: the replay and
//   calibration slices;
// - offline dual-policy diff on recorded decisions: the shadow-diff slice;
// - pinned-vs-unpinned fleet mix: the drift snapshot slice.

const OBSERVED_AT = "2026-09-10T14:53:41.507882Z";

function laneDocument(name: string): unknown {
  const path = fileURLToPath(new URL(`../packages/lane-capacity/tests/data/tog2135/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

function laneVerdict(
  doc: string,
  windows: Array<{
    name: string;
    role: "serviceability" | "allowance";
    utilizationFields: string[];
    resetFields: string[];
  }>,
): LanePaceVerdict {
  return evaluateLanePace({
    observation: normalizeLaneDocument({
      document: laneDocument(doc),
      definition: {
        laneId: doc,
        healthFields: ["health"],
        windows,
      },
    }),
    asOf: OBSERVED_AT,
  });
}

const ALLOWANCE = (
  name: string,
): Array<{
  name: string;
  role: "serviceability" | "allowance";
  utilizationFields: string[];
  resetFields: string[];
}> => [{ name, role: "allowance", utilizationFields: [`${name}_utilization`], resetFields: [`${name}_resets_at`] }];

function syntheticVerdict(utilization: number, elapsed: number): LanePaceVerdict {
  return {
    laneId: "synthetic",
    observedAt: OBSERVED_AT,
    state: "on",
    serviceable: true,
    score: { utilization, elapsed, deviation: utilization - elapsed },
    accounts: [
      {
        accountKey: "record-1",
        health: "healthy",
        weight: 1,
        weightSource: "default",
        governingWindow: "weekly",
        governingResetAt: "2026-09-17T14:53:41.507882Z",
        serviceable: true,
        state: "on",
        score: { utilization, elapsed, deviation: utilization - elapsed },
      },
    ],
    knownAccountCount: 1,
    knownWeight: 1,
    serviceableAccountCount: 1,
    urgentResetAt: null,
    reason: "ok",
  };
}

describe("pacer weekly burn-down projection (read-only)", () => {
  it("targets the 98-100% end-of-window band", () => {
    expect(BURN_DOWN_TARGET_LOW).toBe(0.98);
    expect(BURN_DOWN_TARGET_HIGH).toBe(1.0);
  });

  it("classifies recorded fixture accounts through the real pace evaluator", () => {
    const cases: Array<{ doc: string; account: string; projected: number; verdict: string; reason: string }> = [
      // Behind-pace account burning cool: lands well short of the band.
      { doc: "claude", account: "record-1", projected: 0.612245, verdict: "under-use", reason: "below-target-band" },
      // Exhausted account pinned at full burn: overshoots the band.
      { doc: "claude", account: "record-2", projected: 1.345895, verdict: "over-burn", reason: "above-target-band" },
      // Ahead-pace accounts burning hot: overshoot by ~1.5-4.5x.
      { doc: "codex", account: "record-1", projected: 3.185185, verdict: "over-burn", reason: "above-target-band" },
      { doc: "codex", account: "record-2", projected: 4.504505, verdict: "over-burn", reason: "above-target-band" },
      { doc: "kimi", account: "record-1", projected: 1.508621, verdict: "over-burn", reason: "above-target-band" },
      { doc: "zai", account: "record-1", projected: 2.051429, verdict: "over-burn", reason: "above-target-band" },
    ];
    for (const entry of cases) {
      const verdict = laneVerdict(
        entry.doc,
        entry.doc === "claude"
          ? ALLOWANCE("seven_day")
          : entry.doc === "opencode-go"
            ? ALLOWANCE("monthly")
            : ALLOWANCE("weekly"),
      );
      const readout = laneBurnDown(verdict);
      const account = readout.accounts.find((row) => row.accountKey === entry.account)!;
      expect(account).toBeDefined();
      expect(account.projected).toBeCloseTo(entry.projected, 5);
      expect(account.verdict).toBe(entry.verdict);
      expect(account.reason).toBe(entry.reason);
    }
  });

  it("projects the monthly allowance for opencode-go without weekly assumptions", () => {
    const readout = laneBurnDown(laneVerdict("opencode-go", ALLOWANCE("monthly")));
    expect(readout.accounts).toHaveLength(1);
    expect(readout.accounts[0]!.projected).toBeCloseTo(1.869159, 5);
    expect(readout.accounts[0]!.verdict).toBe("over-burn");
  });

  it("covers on-track vs over-burn vs under-use through the real evaluator path", () => {
    const vectors: Array<{ utilization: number; verdict: string; reason: string }> = [
      { utilization: 0.45, verdict: "under-use", reason: "below-target-band" },
      { utilization: 0.495, verdict: "on-track", reason: "within-target-band" },
      { utilization: 0.55, verdict: "over-burn", reason: "above-target-band" },
    ];
    for (const vector of vectors) {
      const projected = laneBurnDown(syntheticVerdict(vector.utilization, 0.5));
      expect(projected.accounts[0]!.verdict).toBe(vector.verdict);
      expect(projected.accounts[0]!.reason).toBe(vector.reason);
    }
  });

  it("holds the band edges inclusive: 0.98 and 1.00 project on-track", () => {
    expect(projectBurnDown({ utilization: 0.49, elapsed: 0.5 }).verdict).toBe("on-track");
    expect(projectBurnDown({ utilization: 0.5, elapsed: 0.5 }).verdict).toBe("on-track");
    expect(projectBurnDown({ utilization: 0.489, elapsed: 0.5 }).verdict).toBe("under-use");
    expect(projectBurnDown({ utilization: 0.501, elapsed: 0.5 }).verdict).toBe("over-burn");
  });

  it("never projects without a computable window: no history, no guess", () => {
    for (const elapsed of [0, -0.1]) {
      const readout = projectBurnDown({ utilization: 0.2, elapsed });
      expect(readout.projected).toBeNull();
      expect(readout.verdict).toBe("unknown");
      expect(readout.reason).toBe("no-burn-history");
    }
    const beyond = projectBurnDown({ utilization: 0.9, elapsed: 1.2 });
    expect(beyond.projected).toBeNull();
    expect(beyond.verdict).toBe("unknown");
    expect(beyond.reason).toBe("window-already-elapsed");
    for (const missing of [
      { utilization: null, elapsed: 0.5 },
      { utilization: 0.5, elapsed: null },
      { utilization: null, elapsed: null },
    ]) {
      const readout = projectBurnDown(missing);
      expect(readout.projected).toBeNull();
      expect(readout.verdict).toBe("unknown");
      expect(readout.reason).toBe("no-computable-window");
    }
    // Non-finite inputs are not projections either.
    for (const dirty of [
      { utilization: Number.NaN, elapsed: 0.5 },
      { utilization: 0.5, elapsed: Number.POSITIVE_INFINITY },
    ]) {
      const readout = projectBurnDown(dirty);
      expect(readout.projected).toBeNull();
      expect(readout.verdict).toBe("unknown");
    }
  });

  it("reports lane identity alongside every account without mutating the verdict", () => {
    const verdict = laneVerdict("codex", ALLOWANCE("weekly"));
    const frozen = structuredClone(verdict);
    const readout = laneBurnDown(verdict);
    expect(readout.laneId).toBe("codex");
    expect(readout.observedAt).toBe(verdict.observedAt);
    expect(readout.state).toBe(verdict.state);
    expect(readout.serviceable).toBe(verdict.serviceable);
    expect(readout.reason).toBe(verdict.reason);
    expect(readout.accounts).toHaveLength(verdict.accounts.length);
    expect(verdict).toEqual(frozen);
    // The uncomputable account (no governing window) reports unknown, never a guess.
    const zen = laneBurnDown(laneVerdict("zen-free", ALLOWANCE("weekly")));
    expect(zen.accounts).toHaveLength(1);
    expect(zen.accounts[0]!.projected).toBeNull();
    expect(zen.accounts[0]!.verdict).toBe("unknown");
    expect(zen.accounts[0]!.reason).toBe("no-computable-window");
  });

  it("honors an explicit policy band without moving the default", () => {
    const custom = { targetLow: 0.9, targetHigh: 1.1 };
    expect(projectBurnDown({ utilization: 0.46, elapsed: 0.5, policy: custom }).verdict).toBe("on-track");
    // The module default still pins 98-100% for the same input.
    expect(projectBurnDown({ utilization: 0.46, elapsed: 0.5 }).verdict).toBe("under-use");
  });
});
