import { describe, expect, it } from "vitest";

import { SYNC_BUDGET_CEILING_MS, SYNC_THROUGHPUT_TOKENS_PER_MS } from "../src/config/upstream-constraints.js";
import { effectiveMaxSyncOutputTokens } from "../src/inference/sync-budget.js";

describe("effectiveMaxSyncOutputTokens", () => {
  it("honours an explicit per-model override regardless of timeouts", () => {
    expect(effectiveMaxSyncOutputTokens(25_000, 300_000, 50)).toBe(50);
    expect(effectiveMaxSyncOutputTokens(1_000, undefined, 5_000)).toBe(5_000);
  });

  it("derives a default from the effective request timeout when no override is set", () => {
    // upstream 25_000ms, no model override -> budget is 25_000ms (below the sync ceiling).
    const expected = Math.floor(25_000 * SYNC_THROUGHPUT_TOKENS_PER_MS);
    expect(effectiveMaxSyncOutputTokens(25_000, undefined, undefined)).toBe(expected);
  });

  it("clamps the derived default to the sync budget ceiling even when the model's own timeout is much longer", () => {
    // A model configured with a 300s ceiling (for the async path) must not get
    // a 300s-sized sync token budget: /invoke stays capped at SYNC_BUDGET_CEILING_MS.
    const expected = Math.floor(SYNC_BUDGET_CEILING_MS * SYNC_THROUGHPUT_TOKENS_PER_MS);
    expect(effectiveMaxSyncOutputTokens(25_000, 300_000, undefined)).toBe(expected);
  });

  it("prefers the model's own requestTimeoutMs over the upstream default", () => {
    const expected = Math.floor(10_000 * SYNC_THROUGHPUT_TOKENS_PER_MS);
    expect(effectiveMaxSyncOutputTokens(25_000, 10_000, undefined)).toBe(expected);
  });

  it("never derives a budget below one token", () => {
    expect(effectiveMaxSyncOutputTokens(1_000, undefined, undefined)).toBeGreaterThanOrEqual(1);
  });
});
