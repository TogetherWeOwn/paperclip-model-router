import { describe, expect, it } from "vitest";

// Propose-only guard on the pinned-vs-unpinned fleet-mix snapshot.
// Fixture mechanics: hand-built pairs of consecutive daily mix snapshots
// (unpinned share + unpinned reported-model breakdown) evaluated purely in
// memory. The guard emits a proposal record only; it never routes.

// scripts/ is outside tsconfig's `include` and has no declarations, so
// resolve the module through a computed specifier (see ci-health.spec.ts).
interface Snapshot {
  unpinnedShareOfIssueBound: number | null;
  unpinnedReportedModelCounts: Record<string, number>;
}
interface GuardResult {
  triggered: boolean;
  reasons: string[];
  unpinnedShareDeltaPp: number | null;
  prevTopModel: string | null;
  currTopModel: string | null;
  prevTopFamily: string | null;
  currTopFamily: string | null;
  thresholdPp: number;
  proposal: string | null;
}
const specifier = new URL("../scripts/lib/model-mix-guard.mjs", import.meta.url).href;
const {
  evaluateMixGuard,
  modelFamily,
}: {
  evaluateMixGuard: (prev: Snapshot, curr: Snapshot, options?: { unpinnedShareMovePp?: number }) => GuardResult;
  modelFamily: (model: unknown) => string | null;
} = await import(/* @vite-ignore */ specifier);

const snap = (
  share: number | null,
  unpinned: Record<string, number>,
): Snapshot => ({ unpinnedShareOfIssueBound: share, unpinnedReportedModelCounts: unpinned });

describe("model-mix guard on fixture snapshots", () => {
  it("stays quiet on a stable pair", () => {
    const prev = snap(0.913, { "muse-spark(xhigh)": 1880, "muse-canary(xhigh)": 1656 });
    const curr = snap(0.921, { "muse-spark(xhigh)": 1905, "muse-canary(xhigh)": 1701 });
    const out = evaluateMixGuard(prev, curr);
    expect(out.triggered).toBe(false);
    expect(out.reasons).toEqual([]);
    expect(out.proposal).toBeNull();
  });

  it("proposes on an unpinned-share move beyond the threshold", () => {
    const prev = snap(0.85, { "muse-spark(xhigh)": 1800, "muse-canary(xhigh)": 1600 });
    const curr = snap(0.92, { "muse-spark(xhigh)": 1900, "muse-canary(xhigh)": 1700 });
    const out = evaluateMixGuard(prev, curr);
    expect(out.triggered).toBe(true);
    expect(out.reasons).toEqual(["unpinned-share-move"]);
    expect(out.unpinnedShareDeltaPp).toBeCloseTo(7);
    expect(out.proposal).toMatch(/no routing change/);
  });

  it("treats exactly the threshold as stable (strictly-greater rule)", () => {
    const prev = snap(0.87, { "muse-spark(xhigh)": 1800 });
    const curr = snap(0.92, { "muse-spark(xhigh)": 1900 });
    const out = evaluateMixGuard(prev, curr);
    expect(out.unpinnedShareDeltaPp).toBeCloseTo(5);
    expect(out.triggered).toBe(false);
    expect(out.reasons).toEqual([]);
  });

  it("proposes on a top-family flip with a stable share", () => {
    const prev = snap(0.913, { "muse-spark(xhigh)": 1880, "muse-canary(xhigh)": 1656 });
    const curr = snap(0.915, { "muse-canary(xhigh)": 1905, "muse-spark(xhigh)": 1701 });
    const out = evaluateMixGuard(prev, curr);
    expect(out.triggered).toBe(true);
    expect(out.reasons).toEqual(["top-family-flip"]);
    expect(out.prevTopFamily).toBe("muse-spark");
    expect(out.currTopFamily).toBe("muse-canary");
    expect(out.proposal).toMatch(/no routing change/);
  });

  it("reports both reasons when share moves and the top family flips", () => {
    const prev = snap(0.8, { "muse-spark(xhigh)": 1800 });
    const curr = snap(0.92, { "claude-sonnet-5-5": 1900 });
    const out = evaluateMixGuard(prev, curr);
    expect(out.triggered).toBe(true);
    expect(out.reasons).toEqual(["unpinned-share-move", "top-family-flip"]);
    expect(out.currTopFamily).toBe("claude-sonnet");
  });

  it("stays quiet on missing data instead of throwing", () => {
    const out = evaluateMixGuard(snap(null, {}), snap(null, {}));
    expect(out.triggered).toBe(false);
    expect(out.reasons).toEqual([]);
    expect(out.unpinnedShareDeltaPp).toBeNull();
    expect(out.proposal).toBeNull();
  });

  it("reads inputs without mutating them (frozen fixtures stay frozen)", () => {
    const prev = Object.freeze(snap(0.85, Object.freeze({ "muse-spark(xhigh)": 1 }) as Record<string, number>));
    const curr = Object.freeze(snap(0.92, Object.freeze({ "muse-spark(xhigh)": 2 }) as Record<string, number>));
    expect(() => evaluateMixGuard(prev, curr)).not.toThrow();
  });
});

describe("modelFamily", () => {
  it("reduces reported models to comparable families", () => {
    expect(modelFamily("muse-spark(xhigh)")).toBe("muse-spark");
    expect(modelFamily("muse-canary(xhigh)")).toBe("muse-canary");
    expect(modelFamily("claude-sonnet-5-5")).toBe("claude-sonnet");
    expect(modelFamily("")).toBeNull();
    expect(modelFamily(null)).toBeNull();
  });
});
