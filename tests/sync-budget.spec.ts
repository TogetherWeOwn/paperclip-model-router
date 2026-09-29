import { describe, expect, it } from "vitest";

import {
  SYNC_BUDGET_CEILING_MS,
  SYNC_THROUGHPUT_CHAT_TOKENS_PER_MS,
  SYNC_THROUGHPUT_REASONING_TOKENS_PER_MS,
  SYNC_THROUGHPUT_TOKENS_PER_MS,
  syncThroughputTokensPerMs,
} from "../src/config/upstream-constraints.js";
import type { SyncThroughputClass } from "../src/engine/types.js";
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

describe("TOG-7896: per-class throughput baselines", () => {
  it("keeps the legacy alias on the measured chat row exactly", () => {
    expect(SYNC_THROUGHPUT_TOKENS_PER_MS).toBe(SYNC_THROUGHPUT_CHAT_TOKENS_PER_MS);
    expect(SYNC_THROUGHPUT_CHAT_TOKENS_PER_MS).toBe(1_200 / 28_000);
    expect(SYNC_THROUGHPUT_REASONING_TOKENS_PER_MS).toBe(600 / 28_000);
  });

  it("resolves chat for absent or unrecognized classes, reasoning only for the exact row", () => {
    expect(syncThroughputTokensPerMs(undefined)).toBe(SYNC_THROUGHPUT_CHAT_TOKENS_PER_MS);
    expect(syncThroughputTokensPerMs("chat")).toBe(SYNC_THROUGHPUT_CHAT_TOKENS_PER_MS);
    expect(syncThroughputTokensPerMs("reasoning")).toBe(SYNC_THROUGHPUT_REASONING_TOKENS_PER_MS);
    // A stored row can carry any string; junk must fall through to the
    // measured default, never to the uncalibrated estimate.
    expect(syncThroughputTokensPerMs("fast")).toBe(SYNC_THROUGHPUT_CHAT_TOKENS_PER_MS);
    expect(syncThroughputTokensPerMs("REASONING")).toBe(SYNC_THROUGHPUT_CHAT_TOKENS_PER_MS);
    expect(syncThroughputTokensPerMs(42)).toBe(SYNC_THROUGHPUT_CHAT_TOKENS_PER_MS);
  });

  it("derives the chat default identically to the pre-class ceiling for an unlabeled model", () => {
    const legacy = Math.floor(25_000 * SYNC_THROUGHPUT_TOKENS_PER_MS);
    expect(effectiveMaxSyncOutputTokens(25_000, undefined, undefined)).toBe(legacy);
    expect(effectiveMaxSyncOutputTokens(25_000, undefined, undefined, undefined)).toBe(legacy);
    expect(effectiveMaxSyncOutputTokens(25_000, undefined, undefined, "chat")).toBe(legacy);
    expect(effectiveMaxSyncOutputTokens(25_000, undefined, undefined, "fast" as SyncThroughputClass)).toBe(legacy);
  });

  it("halves the derived default for a reasoning-class model", () => {
    const expected = Math.floor(SYNC_BUDGET_CEILING_MS * SYNC_THROUGHPUT_REASONING_TOKENS_PER_MS);
    expect(effectiveMaxSyncOutputTokens(25_000, 300_000, undefined, "reasoning")).toBe(expected);
    expect(expected).toBe(Math.floor(Math.floor(SYNC_BUDGET_CEILING_MS * SYNC_THROUGHPUT_CHAT_TOKENS_PER_MS) / 2));
  });

  it("lets an explicit per-model override win over either class row", () => {
    expect(effectiveMaxSyncOutputTokens(25_000, undefined, 50, "reasoning")).toBe(50);
    expect(effectiveMaxSyncOutputTokens(25_000, undefined, 5_000, "chat")).toBe(5_000);
  });
});
