import { describe, expect, it } from "vitest";

import { normalizeCapacityPayload } from "../src/capacity/normalize.js";
import type { CapacitySourceConfig } from "../src/capacity/types.js";
import { normalizeHealth } from "../packages/lane-capacity/src/value-normalization.js";

/**
 * TOG-3551 scope 2: a lane reporting billing exhaustion (`payment_required`)
 * must ingest as a positive unavailable signal — not `unknown`, which
 * fail-open serves anyway (select.ts treats `unknown` as absence: ranked
 * last but still selectable).
 *
 * Exact-list matching only: no substring/regex matching, so near-miss
 * strings must stay unrecognized (see the "repaid" adverse case).
 */
describe("TOG-3551 payment-exhaustion health strings", () => {
  it.each([
    "payment_required",
    "payment-required",
    "payment required",
    "Payment Required",
    "  payment_required  ",
  ])("normalizeHealth(%j) reads unavailable", (value) => {
    expect(normalizeHealth(value)).toBe("unavailable");
  });

  it("does not substring-match near misses", () => {
    expect(normalizeHealth("repaid")).toBeNull();
    expect(normalizeHealth("payment")).toBeNull();
    expect(normalizeHealth("requires_payment_method")).toBeNull();
    expect(normalizeHealth("unrelated-string")).toBeNull();
  });

  it("a payment-blocked lane normalizes to posture unavailable with telemetry available", () => {
    const source: CapacitySourceConfig = {
      id: "telemetry-devin",
      statusUrl: "https://router.example.invalid/telemetry/model-usage/devin",
      apiKeySecretRef: null,
      modelIds: ["devin/swe-1-6-slow"],
      healthFields: ["state"],
      requestTimeoutMs: 5000,
      maxResponseBytes: 262144,
      windows: [
        { name: "five-hour", utilizationFields: ["fiveHourUtilization"], resetFields: ["fiveHourResetsAt"] },
      ],
    };
    const snapshot = normalizeCapacityPayload({
      payload: {
        schemaVersion: 1,
        observedAt: "2026-09-20T18:00:00.000Z",
        staleAfterSeconds: 300,
        state: "payment_required",
        fiveHourUtilization: 0.12,
        fiveHourResetsAt: "2026-09-20T23:00:00.000Z",
      },
      source,
      fetchedAt: "2026-09-20T18:00:00.000Z",
    });
    expect(snapshot.evidence.length).toBe(1);
    expect(snapshot.evidence[0]!.health).toBe("unavailable");
    expect(snapshot.evidence[0]!.posture).toBe("unavailable");
    expect(snapshot.evidence[0]!.telemetryAvailable).toBe(true);
  });

  it("explicit payment block overrides a low-utilization window", () => {
    const source: CapacitySourceConfig = {
      id: "telemetry-devin",
      statusUrl: "https://router.example.invalid/telemetry/model-usage/devin",
      apiKeySecretRef: null,
      modelIds: ["devin/swe-1-6-slow"],
      healthFields: ["state"],
      requestTimeoutMs: 5000,
      maxResponseBytes: 262144,
      windows: [
        { name: "five-hour", utilizationFields: ["fiveHourUtilization"], resetFields: ["fiveHourResetsAt"] },
      ],
    };
    // 12% utilized would read "available" from the window alone; the explicit
    // billing block must win via conservativeHealth.
    const snapshot = normalizeCapacityPayload({
      payload: {
        state: "payment_required",
        fiveHourUtilization: 0.12,
        fiveHourResetsAt: "2026-09-20T23:00:00.000Z",
      },
      source,
      fetchedAt: "2026-09-20T18:00:00.000Z",
    });
    expect(snapshot.evidence[0]!.health).toBe("unavailable");
    expect(snapshot.evidence[0]!.posture).toBe("unavailable");
  });
});
