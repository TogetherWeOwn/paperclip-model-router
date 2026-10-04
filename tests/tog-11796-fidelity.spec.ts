import { describe, expect, it } from "vitest";

import { computeFidelity, FIDELITY_CAVEAT, type FidelityPin, type FidelityRunRow } from "../src/fidelity/metrics.js";
import { modelsMatch, normalizeModelName, stripEffortSuffix } from "../src/fidelity/normalize.js";

// TOG-11796: routing-fidelity normalization + metrics (design TOG-11780 §8).
//
// The property under test is direction-sensitive: known runtime variants map
// to their canonical roster ID, but UNKNOWN ids are never coerced. Deleting an
// alias row must fail the alias test for that row (no fuzzy fallback), and an
// unrecognized id must survive unchanged so its comparison can only match on
// exact raw equality — guessing a canonical id would launder a misreport into
// a plausible match.

describe("stripEffortSuffix", () => {
  it("strips a trailing effort marker", () => {
    expect(stripEffortSuffix("muse-spark-1.3-contributor(xhigh)")).toBe("muse-spark-1.3-contributor");
  });

  it("leaves a bare name alone", () => {
    expect(stripEffortSuffix("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
  });

  it("keeps a bare empty paren pair — it is not an effort marker", () => {
    expect(stripEffortSuffix("model()")).toBe("model()");
  });

  it("strips only one suffix", () => {
    expect(stripEffortSuffix("m(xhigh) (low)")).toBe("m(xhigh)");
  });
});

describe("normalizeModelName", () => {
  it("maps each known runtime variant to its roster id", () => {
    expect(normalizeModelName("claude-sonnet-5-5")).toBe("claude-sonnet-5");
    expect(normalizeModelName("muse-spark-1.3-contributor")).toBe("muse-spark-1.3-contributor-free");
    expect(normalizeModelName("gpt-6.1-sol")).toBe("gpt-5.6-sol");
  });

  it("strips the effort suffix before alias lookup", () => {
    expect(normalizeModelName("muse-spark-1.3-contributor(xhigh)")).toBe("muse-spark-1.3-contributor-free");
  });

  it("passes roster ids through unchanged", () => {
    expect(normalizeModelName("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(normalizeModelName("glm-5.3-flash")).toBe("glm-5.3-flash");
  });

  it("never coerces an unknown id", () => {
    // A new deploy variant must NOT be guessed onto a roster id.
    expect(normalizeModelName("claude-sonnet-5-6")).toBe("claude-sonnet-5-6");
    expect(normalizeModelName("gpt-7-ultra")).toBe("gpt-7-ultra");
  });

  it("returns null for empty input", () => {
    expect(normalizeModelName(null)).toBeNull();
    expect(normalizeModelName("")).toBeNull();
    expect(normalizeModelName("   ")).toBeNull();
  });
});

describe("modelsMatch", () => {
  it("matches across the alias boundary", () => {
    expect(modelsMatch("claude-sonnet-5-5", "claude-sonnet-5")).toBe(true);
    expect(modelsMatch("muse-spark-1.3-contributor(xhigh)", "muse-spark-1.3-contributor-free")).toBe(true);
  });

  it("rejects a near-miss the table does not cover", () => {
    // claude-sonnet-5-6 is unknown: it survives unchanged and cannot equal sonnet-5.
    expect(modelsMatch("claude-sonnet-5-6", "claude-sonnet-5")).toBe(false);
  });

  it("null on either side never matches", () => {
    expect(modelsMatch(null, "claude-sonnet-5")).toBe(false);
    expect(modelsMatch("claude-sonnet-5-5", null)).toBe(false);
    expect(modelsMatch(null, null)).toBe(false);
  });
});

const row = (issueId: string, reportedModel: string | null, wakeReason = "issue_monitor_due", errorCode: string | null = null): FidelityRunRow => ({
  issueId,
  wakeReason,
  reportedModel,
  errorCode,
});

const pin = (model: string | null, hasSecretRefEnv = false): FidelityPin => ({ model, hasSecretRefEnv });

describe("computeFidelity", () => {
  it("computes routed share, fidelity and first-run coverage on a mixed window", () => {
    const rows = [
      row("a", "claude-sonnet-5-5", "issue_assigned"), // pinned to sonnet-5: match (covered first run)
      row("a", "gpt-6.1-sol", "issue_monitor_due"), // pinned to sonnet-5: mismatch
      row("b", "claude-sonnet-5-5"), // unpinned: unrouted
      row("c", null, "issue_assigned"), // pinned, no model: routed but excluded from fidelity
      row("d", null), // unpinned, no model: excluded everywhere
    ];
    const pins = new Map([
      ["a", pin("claude-sonnet-5")],
      ["c", pin("glm-5.3-flash")],
    ]);
    const report = computeFidelity(rows, pins);

    expect(report.totalRuns).toBe(5);
    expect(report.routedRuns).toBe(3);
    expect(report.routedShare).toBeCloseTo(3 / 5);
    expect(report.noModelRuns).toBe(2);
    expect(report.fidelityMatches).toBe(1);
    expect(report.fidelityDenominator).toBe(2);
    expect(report.fidelity).toBeCloseTo(1 / 2);
    expect(report.fidelityNoModelRuns).toBe(1);
    expect(report.firstRunTotal).toBe(2);
    expect(report.firstRunDecided).toBe(2);
    expect(report.caveat).toBe(FIDELITY_CAVEAT);
  });

  it("counts unpinned first runs as uncovered", () => {
    const report = computeFidelity([row("a", "claude-sonnet-5-5", "issue_assigned")], new Map());
    expect(report.firstRunTotal).toBe(1);
    expect(report.firstRunDecided).toBe(0);
    expect(report.firstRunCoverage).toBe(0);
    expect(report.routedRuns).toBe(0);
  });

  it("counts configuration_incomplete runs as escapes", () => {
    const report = computeFidelity(
      [
        row("a", null, "issue_assigned", "configuration_incomplete"),
        row("a", null, "issue_monitor_due", "configuration_incomplete"),
        row("b", "x", "issue_monitor_due", "adapter_failed"),
      ],
      new Map([["a", pin("claude-sonnet-5", true)]]),
    );
    expect(report.escapedRuns).toBe(2);
    expect(report.escapedIssueIds).toEqual(["a"]);
    expect(report.pinsTotal).toBe(1);
    expect(report.staleSecretPins).toBe(1);
  });

  it("is empty-safe", () => {
    const report = computeFidelity([], new Map());
    expect(report.totalRuns).toBe(0);
    expect(report.routedShare).toBe(0);
    expect(report.fidelity).toBe(0);
    expect(report.firstRunCoverage).toBe(0);
  });
});
