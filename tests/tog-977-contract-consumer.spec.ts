/**
 * TOG-977 acceptance suite: the consumer side of
 * `docs/contracts/model-usage-telemetry-v1.md` §6, proven against the REAL
 * producer (`normalizeUsage` / `unavailableSnapshot` in `src/telemetry/`)
 * rather than hand-typed contract-shaped fixtures. A producer/consumer test
 * pair that only agrees with itself proves nothing about the wire; this
 * suite runs `src/telemetry/`'s actual output through
 * `readCapacitySource` (`packages/lane-capacity/src/read.ts`), which is the
 * real dispatch a live deployment hits.
 *
 * One describe block per §6 obligation this issue exists to close:
 *
 *   §6.1  reject an unknown schemaVersion
 *   §6.2  a snapshot older than its own staleAfterSeconds reads unavailable
 *   §6.3  byte-key model lookup — no fan-out across a source's modelIds
 *   §6.5  healthy-empty (telemetry: "available", no models) is distinguishable
 *         from a producer outage
 */

import { describe, expect, it } from "vitest";

import { readCapacitySource } from "../src/capacity/read.js";
import type { CapacitySourceConfig } from "../src/capacity/types.js";
import { normalizeUsage, unavailableSnapshot } from "../src/telemetry/normalize.js";
import type { UsageObservation } from "../src/telemetry/types.js";

const OBSERVED_AT = "2026-09-05T00:00:00.000Z";
const FETCHED_AT = "2026-09-05T00:00:10.000Z"; // 10s after observation: fresh under any staleAfterSeconds used below.
const now = () => FETCHED_AT;

function sourceFor(modelIds: string[]): CapacitySourceConfig {
  return {
    id: "telemetry",
    statusUrl: "https://deployment.example.invalid/telemetry/model-usage",
    apiKeySecretRef: null,
    modelIds,
    healthFields: ["state"],
    requestTimeoutMs: 5000,
    maxResponseBytes: 262144,
    windows: [{ name: "five-hour", utilizationFields: ["utilization"], resetFields: ["resetsAt"] }],
  };
}

async function readWith(source: CapacitySourceConfig, body: unknown) {
  return readCapacitySource({
    source,
    http: { request: async () => ({ status: 200, contentType: "application/json", body, responseBytes: 64, redirected: false }) },
    apiKey: null,
    now,
  });
}

describe("§6.1: unknown schemaVersion is rejected, not best-effort parsed", () => {
  it("a real producer snapshot with its version bumped is refused, not read", async () => {
    const snapshot = normalizeUsage({
      observations: [{ modelIds: ["oc/claude-opus-5"], reportedState: null, windows: [{ window: "five-hour", utilization: 0.4, resetsAt: null }] }],
      observedAt: OBSERVED_AT,
    });
    const wire = { ...snapshot, schemaVersion: 2 };

    const result = await readWith(sourceFor(["oc/claude-opus-5"]), wire);

    expect(result.evidence).toEqual([]);
    expect(result.telemetry).toBe("unavailable");
    expect(result.reasonCode).toBe("capacity-schema-version-unsupported");
    // The rejection must not silently fall through to the legacy tree walk
    // and extract the (perfectly well-formed) utilization anyway.
    expect(result.error).not.toBeNull();
  });
});

describe("§6.2: staleness is judged against observedAt, not fetch time", () => {
  it("a snapshot older than its own staleAfterSeconds reads unavailable", async () => {
    const snapshot = normalizeUsage({
      observations: [{ modelIds: ["oc/claude-opus-5"], reportedState: null, windows: [{ window: "five-hour", utilization: 0.4, resetsAt: null }] }],
      observedAt: OBSERVED_AT,
      staleAfterSeconds: 5, // fetched 10s after observedAt above: past budget
    });

    const result = await readWith(sourceFor(["oc/claude-opus-5"]), snapshot);

    expect(result.telemetry).toBe("unavailable");
    expect(result.reasonCode).toBe("capacity-snapshot-stale");
    expect(result.evidence).toEqual([]);
  });

  it("the same snapshot within budget reads normally", async () => {
    const snapshot = normalizeUsage({
      observations: [{ modelIds: ["oc/claude-opus-5"], reportedState: null, windows: [{ window: "five-hour", utilization: 0.4, resetsAt: null }] }],
      observedAt: OBSERVED_AT,
      staleAfterSeconds: 300,
    });

    const result = await readWith(sourceFor(["oc/claude-opus-5"]), snapshot);

    expect(result.telemetry).toBe("available");
    expect(result.evidence).toHaveLength(1);
  });
});

describe("§6.3: byte-key model lookup, no fan-out across a source's modelIds", () => {
  it("a producer reporting one model informs only that model, not every configured id", async () => {
    const snapshot = normalizeUsage({
      observations: [{ modelIds: ["oc/claude-opus-5"], reportedState: null, windows: [{ window: "five-hour", utilization: 0.71, resetsAt: null }] }],
      observedAt: OBSERVED_AT,
    });

    // This source is configured to inform TWO models; the producer only knows
    // about one of them. The legacy tree walk (`normalizeCapacityPayload`)
    // would fan the single record across both ids -- that is the exact TOG-977
    // defect. The contract path must not.
    const result = await readWith(sourceFor(["oc/claude-opus-5", "oc/claude-sonnet-5"]), snapshot);

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.modelId).toBe("oc/claude-opus-5");
    expect(result.evidence[0]?.utilization).toBe(0.71);
    expect(result.evidence.some((e) => e.modelId === "oc/claude-sonnet-5")).toBe(false);
  });

  it("a model id absent from the producer's map is absent from evidence, not fabricated", async () => {
    const snapshot = normalizeUsage({
      observations: [{ modelIds: ["oc/claude-opus-5"], reportedState: null, windows: [{ window: "five-hour", utilization: 0.2, resetsAt: null }] }],
      observedAt: OBSERVED_AT,
    });

    const result = await readWith(sourceFor(["oc/claude-sonnet-5"]), snapshot);

    expect(result.evidence).toEqual([]);
    // Absence is not an error: the producer is healthy, it simply does not govern this id.
    expect(result.telemetry).toBe("available");
    expect(result.error).toBeNull();
  });
});

describe("§6.5: healthy-empty is distinguishable from a producer outage", () => {
  it("an empty models map with telemetry: available is trustworthy, not an outage", async () => {
    const snapshot = normalizeUsage({ observations: [], observedAt: OBSERVED_AT });

    const result = await readWith(sourceFor(["oc/claude-opus-5"]), snapshot);

    expect(result.evidence).toEqual([]);
    expect(result.telemetry).toBe("available");
    expect(result.reasonCode).toBeNull();
    expect(result.error).toBeNull();
  });

  it("a real producer outage reads unavailable with a bounded reason code, never as unlimited capacity", async () => {
    const snapshot = unavailableSnapshot({ observedAt: OBSERVED_AT, reasonCode: "upstream-unreachable" });

    const result = await readWith(sourceFor(["oc/claude-opus-5"]), snapshot);

    expect(result.evidence).toEqual([]);
    expect(result.telemetry).toBe("unavailable");
    expect(result.reasonCode).toBe("capacity-producer-unavailable");
    expect(result.error).not.toBeNull();
  });
});

describe("round trip: multiple real observations reduce and project correctly", () => {
  it("least-restrictive-wins across sources, then byte-key projects per model", async () => {
    const observations: UsageObservation[] = [
      { modelIds: ["oc/claude-opus-5"], reportedState: null, windows: [{ window: "five-hour", utilization: 0.95, resetsAt: null }] },
      { modelIds: ["oc/claude-opus-5"], reportedState: null, windows: [{ window: "five-hour", utilization: 0.1, resetsAt: null }] },
      { modelIds: ["oc/claude-sonnet-5"], reportedState: null, windows: [{ window: "five-hour", utilization: 0.5, resetsAt: null }] },
    ];
    const snapshot = normalizeUsage({ observations, observedAt: OBSERVED_AT });

    const result = await readWith(sourceFor(["oc/claude-opus-5", "oc/claude-sonnet-5"]), snapshot);

    expect(result.evidence).toHaveLength(2);
    const opus = result.evidence.find((e) => e.modelId === "oc/claude-opus-5");
    const sonnet = result.evidence.find((e) => e.modelId === "oc/claude-sonnet-5");
    // The healthier account (0.1) wins for opus -- cross-source reduction is least-restrictive.
    expect(opus?.utilization).toBe(0.1);
    expect(sonnet?.utilization).toBe(0.5);
  });
});
