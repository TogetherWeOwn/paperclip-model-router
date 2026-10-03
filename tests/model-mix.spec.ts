import { describe, expect, it } from "vitest";

// Pinned-vs-unpinned mix counting for the read-only fleet mix snapshot.
// Fixture mechanics: three issues (one pinned, one unpinned, one missing
// from the pin map) crossed with runs that carry, omit, or blank the
// reported model, all classified purely in memory.

// scripts/ is outside tsconfig's `include` and has no declarations, so
// resolve the module through a computed specifier (see ci-health.spec.ts).
interface MixInput {
  contextSnapshot?: { issueId?: string };
  usageJson?: { model?: string };
}
interface Mix {
  pinnedRuns: number;
  unpinnedRuns: number;
  unresolvableRuns: number;
  noModelRuns: number;
  issueBound: number;
  pinnedShareOfIssueBound: number | null;
  unpinnedShareOfIssueBound: number | null;
  pinnedIssues: number;
  unpinnedIssues: number;
  reportedModelCounts: Record<string, number>;
  unpinnedReportedModelCounts: Record<string, number>;
}
const specifier = new URL("../scripts/lib/model-mix.mjs", import.meta.url).href;
const { computeModelMix }: { computeModelMix: (rows: MixInput[], pins: Map<string, string | null>) => Mix } =
  await import(/* @vite-ignore */ specifier);

const pins = new Map<string, string | null>([
  ["issue-pinned", "model-a"],
  ["issue-unpinned", null],
]);

describe("model-mix counting on fixtures", () => {
  it("splits pinned, unpinned and unjoinable runs and counts distinct issues", () => {
    const rows: MixInput[] = [
      { contextSnapshot: { issueId: "issue-pinned" }, usageJson: { model: "model-a" } },
      { contextSnapshot: { issueId: "issue-pinned" }, usageJson: {} },
      { contextSnapshot: { issueId: "issue-unpinned" }, usageJson: { model: "model-b" } },
      { contextSnapshot: { issueId: "issue-unpinned" }, usageJson: { model: "model-b" } },
      { contextSnapshot: { issueId: "issue-unknown" }, usageJson: { model: "model-b" } },
      { usageJson: { model: "model-b" } },
    ];
    const mix = computeModelMix(rows, pins);
    expect(mix.pinnedRuns).toBe(2);
    expect(mix.unpinnedRuns).toBe(2);
    expect(mix.unresolvableRuns).toBe(2);
    expect(mix.noModelRuns).toBe(1);
    expect(mix.issueBound).toBe(4);
    expect(mix.pinnedShareOfIssueBound).toBeCloseTo(0.5);
    expect(mix.unpinnedShareOfIssueBound).toBeCloseTo(0.5);
    expect(mix.pinnedIssues).toBe(1);
    expect(mix.unpinnedIssues).toBe(1);
    expect(mix.reportedModelCounts).toEqual({ "model-b": 2, "model-a": 1 });
    expect(mix.unpinnedReportedModelCounts).toEqual({ "model-b": 2 });
  });

  it("ignores blank reported models and treats empty-string pins as unpinned", () => {
    const rows: MixInput[] = [
      { contextSnapshot: { issueId: "issue-pinned" }, usageJson: { model: "" } },
      { contextSnapshot: { issueId: "issue-unpinned" }, usageJson: {} },
    ];
    const mix = computeModelMix(rows, new Map([["issue-pinned", ""], ["issue-unpinned", null]]));
    expect(mix.pinnedRuns).toBe(0);
    expect(mix.unpinnedRuns).toBe(2);
    expect(mix.noModelRuns).toBe(2);
    expect(mix.reportedModelCounts).toEqual({});
    expect(mix.unpinnedReportedModelCounts).toEqual({});
  });
});
