import { describe, expect, it } from "vitest";
import { normalizeCapacityPayload } from "../src/capacity/normalize.js";
import type { CapacitySourceConfig } from "../src/capacity/types.js";

/**
 * Interop between the TOG-975 producer contract and the v0.4.0 consumer that
 * actually ships in `src/capacity/`.
 *
 * The consumer does not key on model ID. `collectEvidenceRecords` walks the
 * whole payload tree collecting EVERY object that carries a configured
 * utilization field, then attributes each one to EVERY id in
 * `source.modelIds`. That is fine for the flat vendor payloads it was written
 * against, and wrong for the contract's nested `models` map — see the
 * "shape the consumer cannot read" block below, which pins the defect.
 *
 * So the wire projection is flat and per-model: one source entry, one endpoint,
 * one model, window utilizations as distinct top-level keys. The nested
 * contract shape stays the internal producer model; this is its serialization.
 */

// Variant C: per-model endpoint serving a FLAT projection. Window utilizations
// are distinct top-level keys, so exactly one record in the tree carries them.
function flat(opts: {
  state: string;
  fiveHourUtilization: number | null;
  fiveHourResetsAt: string | null;
  weeklyUtilization?: number | null;
  weeklyResetsAt?: string | null;
}) {
  return {
    schemaVersion: 1,
    observedAt: "2026-09-05T02:00:00.000Z",
    staleAfterSeconds: 300,
    telemetry: "available",
    reasonCode: null,
    serviceable: opts.state !== "unavailable" && opts.state !== "exhausted",
    state: opts.state,
    observationQuality: opts.fiveHourUtilization === null ? "absent" : "measured",
    fiveHourUtilization: opts.fiveHourUtilization,
    fiveHourResetsAt: opts.fiveHourResetsAt,
    weeklyUtilization: opts.weeklyUtilization ?? null,
    weeklyResetsAt: opts.weeklyResetsAt ?? null,
  };
}

const WINDOWS = [
  { name: "five-hour", utilizationFields: ["fiveHourUtilization"], resetFields: ["fiveHourResetsAt"] },
  { name: "weekly", utilizationFields: ["weeklyUtilization"], resetFields: ["weeklyResetsAt"] },
];

function sourceFor(modelId: string, slug: string): CapacitySourceConfig {
  return {
    id: `telemetry-${slug}`,
    statusUrl: `https://router.example.invalid/telemetry/model-usage/${slug}`,
    apiKeySecretRef: null,
    modelIds: [modelId],
    healthFields: ["state"],
    requestTimeoutMs: 5000,
    maxResponseBytes: 262144,
    windows: WINDOWS,
  };
}

function run(modelId: string, slug: string, payload: unknown) {
  return normalizeCapacityPayload({ payload, source: sourceFor(modelId, slug), fetchedAt: "2026-09-05T02:00:00.000Z" });
}

describe("Variant C: flat per-model projection", () => {
  const opus = run("oc/claude-opus-5", "opus-5", flat({
    state: "degraded", fiveHourUtilization: 0.71, fiveHourResetsAt: "2026-09-05T04:00:00.000Z",
    weeklyUtilization: 0.44, weeklyResetsAt: "2026-09-08T00:00:00.000Z",
  }));
  const sonnet = run("oc/claude-sonnet-5", "sonnet-5", flat({
    state: "available", fiveHourUtilization: 0.1, fiveHourResetsAt: null,
  }));

  it("DIAGNOSTIC", () => {
    for (const s of [opus, sonnet]) {
      console.log(`source=${s.source} rows=${s.evidence.length} error=${s.error}`);
      for (const e of s.evidence) {
        console.log(`   ${e.modelId} health=${e.health} posture=${e.posture} util=${e.utilization} resets=${e.resetsAt} windows=${e.windows.map((w) => `${w.name}:${w.utilization}`).join(",")} telemetryAvailable=${e.telemetryAvailable}`);
      }
    }
    expect(true).toBe(true);
  });

  it("emits exactly one evidence row per model, correctly attributed", () => {
    expect(opus.evidence.map((e) => [e.modelId, e.utilization])).toEqual([["oc/claude-opus-5", 0.71]]);
    expect(sonnet.evidence.map((e) => [e.modelId, e.utilization])).toEqual([["oc/claude-sonnet-5", 0.1]]);
  });

  it("keeps both windows on the single row and picks the most restrictive", () => {
    expect(opus.evidence[0]!.windows.map((w) => w.name).sort()).toEqual(["five-hour", "weekly"]);
    expect(opus.evidence[0]!.utilization).toBe(0.71);
  });
});

describe("Variant C: exhausted and unavailable", () => {
  it("exhausted -> posture unavailable", () => {
    const s = run("oc/claude-opus-5", "opus-5", flat({ state: "exhausted", fiveHourUtilization: 0.999, fiveHourResetsAt: "2026-09-05T09:00:00.000Z" }));
    console.log("exhausted:", JSON.stringify(s.evidence.map((e) => ({ h: e.health, p: e.posture, u: e.utilization }))));
    expect(s.evidence[0]!.posture).toBe("unavailable");
  });

  it("reset-grace: >=0.995 clearing within 300s reads degraded, not exhausted", () => {
    const s = run("oc/claude-opus-5", "opus-5", flat({ state: "degraded", fiveHourUtilization: 0.999, fiveHourResetsAt: "2026-09-05T02:02:00.000Z" }));
    console.log("reset-grace:", JSON.stringify(s.evidence.map((e) => ({ h: e.health, p: e.posture }))));
    expect(s.evidence[0]!.health).toBe("degraded");
  });

  it("unavailable with null utilization -> telemetryAvailable false, one row", () => {
    const s = run("oc/claude-opus-5", "opus-5", flat({ state: "unavailable", fiveHourUtilization: null, fiveHourResetsAt: null }));
    console.log("unavailable:", JSON.stringify(s.evidence.map((e) => ({ h: e.health, p: e.posture, t: e.telemetryAvailable })), null, 0));
    expect(s.evidence.length).toBe(1);
    expect(s.evidence[0]!.health).toBe("unavailable");
  });
});

describe("Variant C: producer outage", () => {
  it("DIAGNOSTIC: outage payload omitting the utilization keys yields zero rows + error", () => {
    const s = run("oc/claude-opus-5", "opus-5", {
      schemaVersion: 1, observedAt: "2026-09-05T02:00:00.000Z", staleAfterSeconds: 300,
      telemetry: "unavailable", reasonCode: "upstream-unreachable",
    });
    console.log("outage:", JSON.stringify({ rows: s.evidence.length, error: s.error }));
    expect(s.evidence.length).toBe(0);
    expect(s.error).toBeTruthy();
  });
});

/**
 * The defect this projection exists to route around. If a future consumer
 * change makes the nested contract shape parse correctly, these tests fail —
 * which is the signal to simplify the projection back to one endpoint.
 */
describe("nested `models` map: the shape the v0.4.0 consumer cannot read", () => {
  const nested = {
    schemaVersion: 1,
    observedAt: "2026-09-05T02:00:00.000Z",
    staleAfterSeconds: 300,
    telemetry: "available",
    reasonCode: null,
    models: {
      "oc/claude-opus-5": {
        serviceable: true, state: "degraded", utilization: 0.71, remainingFraction: 0.29,
        resetsAt: "2026-09-05T04:00:00.000Z", resetInSeconds: 7200, observationQuality: "measured",
        windows: [{ window: "five-hour", utilization: 0.71, resetsAt: "2026-09-05T04:00:00.000Z", resetInSeconds: 7200 }],
      },
      "oc/claude-sonnet-5": {
        serviceable: true, state: "available", utilization: 0.1, remainingFraction: 0.9,
        resetsAt: null, resetInSeconds: null, observationQuality: "measured",
        windows: [{ window: "five-hour", utilization: 0.1, resetsAt: null, resetInSeconds: null }],
      },
    },
  };
  const source: CapacitySourceConfig = {
    id: "nested", statusUrl: "https://router.example.invalid/telemetry/model-usage",
    apiKeySecretRef: null, modelIds: ["oc/claude-opus-5", "oc/claude-sonnet-5"],
    healthFields: ["state"], requestTimeoutMs: 5000, maxResponseBytes: 262144,
    windows: [{ name: "five-hour", utilizationFields: ["utilization"], resetFields: ["resetsAt"] }],
  };
  const snapshot = normalizeCapacityPayload({ payload: nested, source, fetchedAt: "2026-09-05T02:00:00.000Z" });

  it("fans out records across every configured model id", () => {
    // 4 utilization-bearing objects (2 model records + their 2 nested window
    // entries) x 2 configured model ids. The correct answer is 2.
    expect(snapshot.evidence.length).toBe(8);
  });

  it("cross-contaminates: sonnet inherits opus's utilization", () => {
    const sonnet = snapshot.evidence.filter((e) => e.modelId === "oc/claude-sonnet-5");
    expect(sonnet.some((e) => e.utilization === 0.71)).toBe(true);
  });

  it("cannot distinguish a producer outage from a valid empty model set", () => {
    const base = { schemaVersion: 1, observedAt: "2026-09-05T02:00:00.000Z", staleAfterSeconds: 300, models: {} };
    const outage = normalizeCapacityPayload({ payload: { ...base, telemetry: "unavailable", reasonCode: "upstream-unreachable" }, source, fetchedAt: "2026-09-05T02:00:00.000Z" });
    const empty = normalizeCapacityPayload({ payload: { ...base, telemetry: "available", reasonCode: null }, source, fetchedAt: "2026-09-05T02:00:00.000Z" });
    expect(outage.error).toEqual(empty.error);
  });
});
