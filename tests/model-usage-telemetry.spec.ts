/**
 * Conformance suite for docs/contracts/model-usage-telemetry-v1.md.
 *
 * The acceptance criteria on TOG-975 map onto describe blocks below, one each:
 * fresh normalized records from representative live-shaped payloads; the
 * exhausted and reset-window cases; no credential or deployment identity in the
 * response or the logs; and outage distinguishable from a valid empty set.
 *
 * The sanitization assertions use `findIdentityLeaks` as an oracle rather than
 * checking for specific strings, so a NEW identity field added to the producer
 * later fails these tests without anyone remembering to extend them.
 */

import { describe, expect, it } from "vitest";

import { collectObservations, type CollectorFieldMap } from "../src/telemetry/collect.js";
import { isStale, normalizeUsage, unavailableSnapshot } from "../src/telemetry/normalize.js";
import { findIdentityLeaks, serializeBounded, serializeSnapshot } from "../src/telemetry/sanitize.js";
import { TELEMETRY_DEFAULTS, type UsageObservation } from "../src/telemetry/types.js";

const OBSERVED_AT = "2026-09-04T23:30:00.000Z";

/**
 * A payload shaped like what a deployment collector actually reads: records
 * keyed by connection, carrying account identity, credentials, and endpoints
 * alongside the usage numbers. Every one of those identity fields is here on
 * purpose — the sanitization tests are worthless against a payload that had
 * nothing to leak.
 */
const LIVE_SHAPED_PAYLOAD = {
  deploymentId: "d290f1ee-6c54-4b01-90e6-d701748f0851",
  plans: [
    {
      connectionId: "conn-7f3a91",
      provider: "teamclaude",
      accountEmail: "ops@togetherweown.invalid",
      subscriptionId: "sub_1P9xKzAbCdEf",
      apiKey: "sk-EXAMPLE-NOT-A-REAL-KEY-AAAA",
      baseUrl: "https://api.anthropic.com",
      comboId: "combo-primary",
      strategy: "round-robin",
      weight: 3,
      status: "active",
      models: ["oc/claude-opus-5", "oc/claude-sonnet-5"],
      fiveHourUtilization: 0.71,
      fiveHourResetsAt: "2026-09-05T00:00:00.000Z",
      weeklyUsed: 440,
      weeklyLimit: 1000,
      weeklyResetsAt: "2026-09-08T00:00:00.000Z",
    },
    {
      connectionId: "conn-b2c455",
      provider: "teamclaude",
      accountEmail: "backup@togetherweown.invalid",
      subscriptionId: "sub_2Q0yLaBcDeFg",
      apiKey: "sk-EXAMPLE-NOT-A-REAL-KEY-BBBB",
      baseUrl: "https://api.anthropic.com",
      comboId: "combo-primary",
      strategy: "round-robin",
      weight: 1,
      status: "active",
      models: ["oc/claude-opus-5"],
      fiveHourUtilization: 0.12,
      fiveHourResetsAt: "2026-09-05T00:30:00.000Z",
    },
    {
      connectionId: "conn-0d9e12",
      provider: "openai-compatible",
      accountEmail: "payg@togetherweown.invalid",
      apiKey: "sk-EXAMPLE-NOT-A-REAL-KEY-CCCC",
      baseUrl: "https://router.example.invalid/v1",
      status: "quota_exhausted",
      models: ["oc/gpt-5.6-sol"],
      fiveHourUtilization: 1.0,
      fiveHourResetsAt: "2026-09-05T06:00:00.000Z",
    },
  ],
};

const FIELD_MAP: CollectorFieldMap = {
  modelIdFields: ["models"],
  stateFields: ["status"],
  windows: [
    {
      window: "five-hour",
      utilizationFields: ["fiveHourUtilization"],
      resetFields: ["fiveHourResetsAt"],
    },
    {
      window: "weekly",
      utilizationFields: ["weeklyUtilization"],
      resetFields: ["weeklyResetsAt"],
      usedFields: ["weeklyUsed"],
      limitFields: ["weeklyLimit"],
    },
  ],
};

function snapshotFromLivePayload() {
  const observations = collectObservations({ payload: LIVE_SHAPED_PAYLOAD, fieldMap: FIELD_MAP });
  return normalizeUsage({ observations, observedAt: OBSERVED_AT });
}

// ---------------------------------------------------------------------------
// §3 — representative live models produce fresh normalized records
// ---------------------------------------------------------------------------

describe("representative live models produce fresh normalized records", () => {
  it("keys records by exact opaque model id and never parses the id", () => {
    const snapshot = snapshotFromLivePayload();
    expect(Object.keys(snapshot.models).sort()).toEqual([
      "oc/claude-opus-5",
      "oc/claude-sonnet-5",
      "oc/gpt-5.6-sol",
    ]);
    // The `oc/` prefix survives untouched — it is part of the ID, not a
    // provider name to be stripped (§2.1).
    expect(snapshot.models["oc/claude-opus-5"]).toBeDefined();
  });

  it("reports observedAt, a freshness budget, and the current schema version", () => {
    const snapshot = snapshotFromLivePayload();
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.observedAt).toBe(OBSERVED_AT);
    expect(snapshot.staleAfterSeconds).toBe(TELEMETRY_DEFAULTS.staleAfterSeconds);
    expect(snapshot.telemetry).toBe("available");
    expect(snapshot.reasonCode).toBeNull();
  });

  it("derives remainingFraction and resetInSeconds from the same window", () => {
    const snapshot = snapshotFromLivePayload();
    // sonnet is served only by the first connection: 71% five-hour beats 44% weekly.
    const sonnet = snapshot.models["oc/claude-sonnet-5"];
    expect(sonnet?.utilization).toBeCloseTo(0.71, 10);
    expect(sonnet?.remainingFraction).toBeCloseTo(0.29, 10);
    expect(sonnet?.resetsAt).toBe("2026-09-05T00:00:00.000Z");
    expect(sonnet?.resetInSeconds).toBe(1800);
  });

  it("computes utilization from used/limit when no fraction is reported", () => {
    const snapshot = snapshotFromLivePayload();
    const weekly = snapshot.models["oc/claude-sonnet-5"]?.windows.find((w) => w.window === "weekly");
    expect(weekly?.utilization).toBeCloseTo(0.44, 10);
  });

  it("marks records measured when every contributing source reported numbers", () => {
    const snapshot = snapshotFromLivePayload();
    expect(snapshot.models["oc/claude-opus-5"]?.observationQuality).toBe("measured");
  });

  it("keeps utilization null rather than clamping an out-of-range report", () => {
    const snapshot = normalizeUsage({
      observations: [
        { modelIds: ["m"], reportedState: null, windows: [{ window: "daily", utilization: 1.7, resetsAt: null }] },
      ],
      observedAt: OBSERVED_AT,
    });
    // 1.7 clamped to 1.0 would read as a genuine exhaustion signal.
    expect(snapshot.models["m"]?.utilization).toBeNull();
    expect(snapshot.models["m"]?.state).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// §3.4 — the two reductions run in opposite directions
// ---------------------------------------------------------------------------

describe("aggregation across sources and windows", () => {
  it("within one source the most restrictive window governs", () => {
    const snapshot = normalizeUsage({
      observations: [
        {
          modelIds: ["m"],
          reportedState: null,
          windows: [
            { window: "weekly", utilization: 0.4, resetsAt: "2026-09-08T00:00:00.000Z" },
            { window: "five-hour", utilization: 0.99, resetsAt: "2026-09-05T04:00:00.000Z" },
          ],
        },
      ],
      observedAt: OBSERVED_AT,
    });
    expect(snapshot.models["m"]?.utilization).toBeCloseTo(0.99, 10);
    expect(snapshot.models["m"]?.state).toBe("degraded");
  });

  it("across sources the least restrictive posture governs", () => {
    const snapshot = snapshotFromLivePayload();
    // opus is served by a 71% connection and a 12% connection; the 12% lane
    // is what the deployment can actually deliver.
    const opus = snapshot.models["oc/claude-opus-5"];
    expect(opus?.state).toBe("available");
    expect(opus?.utilization).toBeCloseTo(0.12, 10);
    expect(opus?.serviceable).toBe(true);
  });

  it("pairs utilization with the state that won, not a spliced value", () => {
    const snapshot = normalizeUsage({
      observations: [
        { modelIds: ["m"], reportedState: null, windows: [{ window: "daily", utilization: 0.95, resetsAt: null }] },
        { modelIds: ["m"], reportedState: null, windows: [{ window: "daily", utilization: 0.20, resetsAt: null }] },
      ],
      observedAt: OBSERVED_AT,
    });
    expect(snapshot.models["m"]?.state).toBe("available");
    expect(snapshot.models["m"]?.utilization).toBeCloseTo(0.20, 10);
  });

  it("reports partial quality when only some sources measured anything", () => {
    const snapshot = normalizeUsage({
      observations: [
        { modelIds: ["m"], reportedState: null, windows: [{ window: "daily", utilization: 0.5, resetsAt: null }] },
        { modelIds: ["m"], reportedState: null, windows: [] },
      ],
      observedAt: OBSERVED_AT,
    });
    expect(snapshot.models["m"]?.observationQuality).toBe("partial");
  });

  it("uses the earliest reset across sources when nothing can serve", () => {
    const snapshot = normalizeUsage({
      observations: [
        {
          modelIds: ["m"],
          reportedState: null,
          windows: [{ window: "daily", utilization: 1, resetsAt: "2026-09-05T08:00:00.000Z" }],
        },
        {
          modelIds: ["m"],
          reportedState: null,
          windows: [{ window: "daily", utilization: 1, resetsAt: "2026-09-05T02:00:00.000Z" }],
        },
      ],
      observedAt: OBSERVED_AT,
    });
    expect(snapshot.models["m"]?.state).toBe("exhausted");
    // Capacity returns at the FIRST reset, not the winning source's own.
    expect(snapshot.models["m"]?.resetsAt).toBe("2026-09-05T02:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// §3.2 — unavailable / exhausted / reset-window cases
// ---------------------------------------------------------------------------

describe("exhausted, unavailable, and reset-window cases", () => {
  it("reports exhausted and not serviceable when a limit is reached with no imminent reset", () => {
    const snapshot = snapshotFromLivePayload();
    const sol = snapshot.models["oc/gpt-5.6-sol"];
    expect(sol?.state).toBe("exhausted");
    expect(sol?.serviceable).toBe(false);
    expect(sol?.resetsAt).toBe("2026-09-05T06:00:00.000Z");
    expect(sol?.resetInSeconds).toBe(23400);
  });

  it("downgrades exhausted to degraded when the window resets inside the grace period", () => {
    const snapshot = normalizeUsage({
      observations: [
        {
          modelIds: ["m"],
          reportedState: null,
          // 100% utilized, but it clears in 90 seconds.
          windows: [{ window: "five-hour", utilization: 1, resetsAt: "2026-09-04T23:31:30.000Z" }],
        },
      ],
      observedAt: OBSERVED_AT,
    });
    expect(snapshot.models["m"]?.resetInSeconds).toBe(90);
    expect(snapshot.models["m"]?.state).toBe("degraded");
    expect(snapshot.models["m"]?.serviceable).toBe(true);
  });

  it("honours an explicit unavailable over any utilization arithmetic", () => {
    const snapshot = normalizeUsage({
      observations: [
        {
          modelIds: ["m"],
          reportedState: "unavailable",
          windows: [{ window: "daily", utilization: 0.05, resetsAt: null }],
        },
      ],
      observedAt: OBSERVED_AT,
    });
    expect(snapshot.models["m"]?.state).toBe("unavailable");
    expect(snapshot.models["m"]?.serviceable).toBe(false);
  });

  it("keeps unknown serviceable so a blind producer cannot ground the fleet", () => {
    const snapshot = normalizeUsage({
      observations: [{ modelIds: ["m"], reportedState: "unknown", windows: [] }],
      observedAt: OBSERVED_AT,
    });
    expect(snapshot.models["m"]?.state).toBe("unknown");
    expect(snapshot.models["m"]?.serviceable).toBe(true);
  });

  it("never lets serviceable disagree with state on the wire", () => {
    const body = serializeSnapshot({
      schemaVersion: 1,
      observedAt: OBSERVED_AT,
      staleAfterSeconds: 300,
      telemetry: "available",
      reasonCode: null,
      models: {
        m: {
          // A caller hands us a contradictory record...
          serviceable: true,
          state: "exhausted",
          utilization: 1,
          remainingFraction: 0,
          resetsAt: null,
          resetInSeconds: null,
          windows: [],
          observationQuality: "measured",
        },
      },
    });
    // ...and the serializer re-derives rather than trusting it.
    const model = (body["models"] as Record<string, Record<string, unknown>>)["m"];
    expect(model?.["serviceable"]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §2 — no credential or deployment identity in the response or the logs
// ---------------------------------------------------------------------------

describe("the response carries no credential or deployment identity", () => {
  const modelIds = ["oc/claude-opus-5", "oc/claude-sonnet-5", "oc/gpt-5.6-sol"];

  it("emits no forbidden field anywhere in the serialized body", () => {
    const body = serializeSnapshot(snapshotFromLivePayload());
    expect(findIdentityLeaks(body, modelIds)).toEqual([]);
  });

  it("carries none of the identity strings that were present in the source", () => {
    const raw = JSON.stringify(serializeSnapshot(snapshotFromLivePayload()));
    for (const secret of [
      "conn-7f3a91",
      "teamclaude",
      "ops@togetherweown.invalid",
      "sub_1P9xKzAbCdEf",
      "sk-EXAMPLE-NOT-A-REAL-KEY-AAAA",
      "api.anthropic.com",
      "combo-primary",
      "round-robin",
      "openai-compatible",
      "d290f1ee-6c54-4b01-90e6-d701748f0851",
    ]) {
      expect(raw).not.toContain(secret);
    }
  });

  it("builds from an allowlist, so a polluted record cannot ride along", () => {
    // The allowlist only earns its keep when the record carries MORE than the
    // contract permits — a producer written in another language, or a future
    // edit that parks a debug field on the internal record. A serializer that
    // spread its input instead of naming fields would pass every other test in
    // this file, because `ModelUsageRecord` has nowhere to put an identity.
    const polluted = {
      serviceable: true,
      state: "available",
      utilization: 0.1,
      remainingFraction: 0.9,
      resetsAt: null,
      resetInSeconds: null,
      windows: [],
      observationQuality: "measured",
      provider: "teamclaude",
      connectionId: "conn-7f3a91",
      apiKey: "sk-EXAMPLE-NOT-A-REAL-KEY-AAAA",
      servedBy: "https://api.anthropic.com",
    } as unknown as import("../src/telemetry/types.js").ModelUsageRecord;

    const body = serializeSnapshot({
      schemaVersion: 1,
      observedAt: OBSERVED_AT,
      staleAfterSeconds: 300,
      telemetry: "available",
      reasonCode: null,
      models: { "oc/claude-opus-5": polluted },
    });

    const model = (body["models"] as Record<string, Record<string, unknown>>)["oc/claude-opus-5"];
    expect(Object.keys(model ?? {}).sort()).toEqual([
      "observationQuality",
      "remainingFraction",
      "resetInSeconds",
      "resetsAt",
      "serviceable",
      "state",
      "utilization",
      "windows",
    ]);
    expect(findIdentityLeaks(body, modelIds)).toEqual([]);
  });

  it("proves the oracle can actually fail", () => {
    // A detector that never fires proves nothing about the bodies it passed.
    const leaks = findIdentityLeaks(
      { models: { "oc/claude-opus-5": { provider: "teamclaude", note: "sk-abcdefgh12345678" } } },
      modelIds,
    );
    expect(leaks.length).toBeGreaterThanOrEqual(2);
    expect(leaks.map((leak) => leak.path)).toContain("models.oc/claude-opus-5.provider");
  });

  it("drops an unrecognized window name rather than passing the label through", () => {
    const body = serializeSnapshot({
      schemaVersion: 1,
      observedAt: OBSERVED_AT,
      staleAfterSeconds: 300,
      telemetry: "available",
      reasonCode: null,
      models: {
        m: {
          serviceable: true,
          state: "available",
          utilization: 0.1,
          remainingFraction: 0.9,
          resetsAt: null,
          resetInSeconds: null,
          // A vendor-naming window smuggled in.
          windows: [{ window: "anthropic-5h" as never, utilization: 0.1, resetsAt: null, resetInSeconds: null }],
          observationQuality: "measured",
        },
      },
    });
    const model = (body["models"] as Record<string, Record<string, unknown>>)["m"];
    expect(model?.["windows"]).toEqual([]);
  });

  it("keeps record cardinality independent of source cardinality", () => {
    // One model, seven accounts behind it. If a consumer could count lanes by
    // counting records or windows, deployment shape would have leaked (§2.3).
    const observations: UsageObservation[] = Array.from({ length: 7 }, (_unused, index) => ({
      modelIds: ["oc/claude-opus-5"],
      reportedState: null,
      windows: [{ window: "five-hour" as const, utilization: 0.1 * index, resetsAt: null }],
    }));
    const snapshot = normalizeUsage({ observations, observedAt: OBSERVED_AT });
    expect(Object.keys(snapshot.models)).toHaveLength(1);
    expect(snapshot.models["oc/claude-opus-5"]?.windows).toHaveLength(1);
  });

  it("reports an outage as a bounded reason code, not a propagated upstream message", () => {
    // The realistic leak: an upstream error string containing a URL and a key.
    const snapshot = unavailableSnapshot({
      observedAt: OBSERVED_AT,
      reasonCode: "upstream-rejected-credential",
    });
    const body = serializeSnapshot(snapshot);
    expect(body["reasonCode"]).toBe("upstream-rejected-credential");
    expect(findIdentityLeaks(body, modelIds)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §4 — a telemetry outage is distinguishable from a valid empty model set
// ---------------------------------------------------------------------------

describe("outage is distinguishable from a valid empty model set", () => {
  it("a healthy producer governing nothing reports available with an empty set", () => {
    const snapshot = normalizeUsage({ observations: [], observedAt: OBSERVED_AT });
    expect(snapshot.telemetry).toBe("available");
    expect(snapshot.reasonCode).toBeNull();
    expect(snapshot.models).toEqual({});
  });

  it("an outage reports unavailable with a reason code and an empty set", () => {
    const snapshot = unavailableSnapshot({ observedAt: OBSERVED_AT, reasonCode: "upstream-unreachable" });
    expect(snapshot.telemetry).toBe("unavailable");
    expect(snapshot.reasonCode).toBe("upstream-unreachable");
    expect(snapshot.models).toEqual({});
  });

  it("the two are not confusable by their model sets alone", () => {
    const healthy = normalizeUsage({ observations: [], observedAt: OBSERVED_AT });
    const outage = unavailableSnapshot({ observedAt: OBSERVED_AT, reasonCode: "upstream-error" });
    // Identical `models`. This is exactly why `telemetry` is a required
    // top-level field and not something inferred from emptiness.
    expect(healthy.models).toEqual(outage.models);
    expect(healthy.telemetry).not.toBe(outage.telemetry);
  });

  it("treats an undateable observation as an outage rather than a snapshot", () => {
    const snapshot = normalizeUsage({ observations: [], observedAt: "not-a-timestamp" });
    expect(snapshot.telemetry).toBe("unavailable");
    expect(snapshot.reasonCode).toBe("upstream-malformed");
  });
});

// ---------------------------------------------------------------------------
// §5 / §6 — bounded body and freshness
// ---------------------------------------------------------------------------

describe("bounded body and freshness semantics", () => {
  it("serializes within the cap unchanged", () => {
    const { body, withinLimit } = serializeBounded(snapshotFromLivePayload());
    expect(withinLimit).toBe(true);
    expect(JSON.parse(body).telemetry).toBe("available");
  });

  it("reports an oversized snapshot as an outage rather than a partial body", () => {
    const observations: UsageObservation[] = Array.from({ length: 400 }, (_unused, index) => ({
      modelIds: [`oc/model-${index}`],
      reportedState: null,
      windows: [{ window: "five-hour" as const, utilization: 0.5, resetsAt: "2026-09-05T00:00:00.000Z" }],
    }));
    const snapshot = normalizeUsage({ observations, observedAt: OBSERVED_AT });
    const { body, withinLimit } = serializeBounded(snapshot, 2048);
    expect(withinLimit).toBe(false);
    const parsed = JSON.parse(body);
    // A truncated body that still said `available` would look complete.
    expect(parsed.telemetry).toBe("unavailable");
    expect(parsed.reasonCode).toBe("upstream-malformed");
    expect(parsed.models).toEqual({});
  });

  it("refuses a model set larger than the record cap", () => {
    const observations: UsageObservation[] = Array.from({ length: 600 }, (_unused, index) => ({
      modelIds: [`oc/model-${index}`],
      reportedState: null,
      windows: [{ window: "daily" as const, utilization: 0.1, resetsAt: null }],
    }));
    const snapshot = normalizeUsage({ observations, observedAt: OBSERVED_AT });
    expect(snapshot.telemetry).toBe("unavailable");
    expect(snapshot.reasonCode).toBe("upstream-malformed");
  });

  it("goes stale once past its own freshness budget", () => {
    const snapshot = normalizeUsage({ observations: [], observedAt: OBSERVED_AT, staleAfterSeconds: 300 });
    expect(isStale(snapshot, "2026-09-04T23:34:00.000Z")).toBe(false);
    expect(isStale(snapshot, "2026-09-04T23:36:00.000Z")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The collection boundary
// ---------------------------------------------------------------------------

describe("the collector discards identity at the boundary", () => {
  it("produces observations that structurally cannot hold an identity", () => {
    const observations = collectObservations({ payload: LIVE_SHAPED_PAYLOAD, fieldMap: FIELD_MAP });
    expect(observations).toHaveLength(3);
    // `UsageObservation` has exactly three fields and none of them is an ID.
    for (const observation of observations) {
      expect(Object.keys(observation).sort()).toEqual(["modelIds", "reportedState", "windows"]);
    }
  });

  it("rescales a percentage but rejects a nonsensical figure", () => {
    const observations = collectObservations({
      payload: [
        { models: ["m"], status: "active", fiveHourUtilization: 85 },
        { models: ["n"], status: "active", fiveHourUtilization: 4200 },
      ],
      fieldMap: FIELD_MAP,
    });
    const snapshot = normalizeUsage({ observations, observedAt: OBSERVED_AT });
    expect(snapshot.models["m"]?.utilization).toBeCloseTo(0.85, 10);
    expect(snapshot.models["n"]?.utilization).toBeNull();
  });

  it("does not invent capacity from an unrecognized posture", () => {
    const observations = collectObservations({
      payload: [{ models: ["m"], status: "flibbertigibbet" }],
      fieldMap: FIELD_MAP,
    });
    // No windows and no recognizable posture means no observation at all,
    // which normalizes to a healthy empty set rather than a fake `available`.
    expect(observations).toHaveLength(0);
  });

  it("survives a self-referential payload", () => {
    const cyclic: Record<string, unknown> = { models: ["m"], status: "active", fiveHourUtilization: 0.3 };
    cyclic["self"] = cyclic;
    expect(() => collectObservations({ payload: cyclic, fieldMap: FIELD_MAP })).not.toThrow();
  });
});
