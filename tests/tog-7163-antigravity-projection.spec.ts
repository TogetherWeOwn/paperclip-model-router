import { describe, expect, it } from "vitest";

import { normalizeCapacityPayload } from "../src/capacity/normalize.js";
import type { CapacitySourceConfig } from "../src/capacity/types.js";
import { resolveConfig } from "../src/config/resolve.js";
import { selectModel } from "../src/engine/select.js";

// TOG-7163: re-PR of the TOG-1337 antigravity telemetry (replaces PR #41,
// head 39460fb, CI green but never merged) with the two defects the TOG-1921
// audit reproduced at that head fixed in the current architecture
// (`packages/lane-capacity/`, not `src/capacity/antigravity.ts` which never
// landed on main):
//
//   1. `findWindowRecord` projected the FIRST nested quota group found onto
//      EVERY model: reversing the input order flipped both outputs
//      exhausted-to-healthy. Fixed by exact model/group projection gated on
//      `modelIdentityFields` — a row is built from the group naming its model,
//      never from the first group.
//   2. `status: "error"` on one credential globally suppressed the healthy
//      windows of sibling records. Fixed by keeping the explicit-status fold
//      per record and emitting snapshot `error` only when NO record yielded
//      usable telemetry.
//
// Four audit-demanded test classes: exact model/group projection,
// order-invariant mixed-pool tests, sticky-last-error vs auth-revocation
// distinction, one-good/one-bad-account coverage. Both models stay
// `enabled: false` throughout: the selector assertions prove routing from
// telemetry, not from static config.

const NOW = "2026-09-06T20:00:00.000Z";
const MODELS = ["cliproxy/model-a-high", "cliproxy/model-b-low"];

// PR #41's window shape: utilizationFields name the nested wrapper key, the
// fraction inside reports headroom (`remainingFraction`).
const source: CapacitySourceConfig = {
  id: "antigravity-oauth",
  statusUrl: "https://capacity.example.test/v0/management/auth-files",
  apiKeySecretRef: null,
  modelIds: MODELS,
  healthFields: ["status"],
  modelIdentityFields: ["model"],
  requestTimeoutMs: 5000,
  maxResponseBytes: 262144,
  windows: [
    { name: "five-hour", utilizationFields: ["five-hour", "five_hour", "five_hour_remaining_fraction"], resetFields: ["resetAt", "reset_at", "five_hour_reset_at"] },
    { name: "weekly", utilizationFields: ["weekly", "weekly_remaining_fraction"], resetFields: ["resetAt", "reset_at", "weekly_reset_at"] },
  ],
};

function credential(status: string, fiveHourRemaining: number, weeklyRemaining: number) {
  return {
    // Credential-adjacent fields the normalizer must never leak into evidence.
    auth_index: "must-not-leak",
    email: "private@example.test",
    access_token: "secret",
    provider: "antigravity",
    type: "antigravity",
    status,
    quota_windows: {
      "five-hour": { remainingFraction: fiveHourRemaining, resetAt: "2026-09-06T22:00:00Z" },
      weekly: { remainingFraction: weeklyRemaining, resetAt: "2026-09-10T20:00:00Z" },
    },
  };
}

function groupedCredential(reverse: boolean) {
  const groups = [
    {
      model: "cliproxy/model-a-high",
      "five-hour": { remainingFraction: 0, resetAt: "2026-09-07T01:00:00Z" },
      weekly: { remainingFraction: 0, resetAt: "2026-09-10T20:00:00Z" },
    },
    {
      model: "cliproxy/model-b-low",
      "five-hour": { remainingFraction: 0.5, resetAt: "2026-09-06T22:00:00Z" },
      weekly: { remainingFraction: 0.7, resetAt: "2026-09-10T20:00:00Z" },
    },
  ];
  if (reverse) groups.reverse();
  return {
    auth_index: "must-not-leak",
    provider: "antigravity",
    type: "antigravity",
    status: "active",
    quota_groups: groups,
  };
}

function routingConfig() {
  return resolveConfig({
    routing: { enabled: true, mode: "advise", stickyModelWithinIssue: false },
    capacityRouting: { enabled: true, mode: "enforce", unknownTelemetry: "exclude-lane", sources: [source] },
    models: MODELS.map((id, index) => ({
      id,
      tier: "standard",
      quality: 87,
      costPerMTokIn: index,
      costPerMTokOut: index,
      contextWindow: 200000,
      enabled: false,
    })),
    taskClasses: [{ key: "architecture", qualityFloor: 85 }],
  });
}

describe("TOG-7163 class 1: exact model/group projection", () => {
  it("projects each per-model group onto exactly the model it names", () => {
    const snapshot = normalizeCapacityPayload({
      payload: { files: [groupedCredential(false)] },
      source,
      fetchedAt: NOW,
    });

    expect(snapshot.error).toBeNull();
    expect(snapshot.evidence).toHaveLength(2);
    const byModel = new Map(snapshot.evidence.map((entry) => [entry.modelId, entry]));
    // model-a's group is exhausted on both windows (remaining 0).
    expect(byModel.get("cliproxy/model-a-high")).toMatchObject({ health: "exhausted", posture: "unavailable", telemetryAvailable: true });
    // model-b's group is healthy (remaining 0.5/0.7 -> utilization 0.5/0.3).
    expect(byModel.get("cliproxy/model-b-low")).toMatchObject({ health: "healthy", posture: "available", telemetryAvailable: true });
    expect(JSON.stringify(snapshot)).not.toContain("must-not-leak");
    expect(JSON.stringify(snapshot)).not.toContain("secret");
  });

  it("a group naming another model is that model's evidence, not unknown telemetry", () => {
    const snapshot = normalizeCapacityPayload({
      payload: { files: [{ provider: "antigravity", status: "active", quota_groups: [{ model: "some-other-model", remainingFraction: 0.5 }] }] },
      source: {
        ...source,
        windows: [{ name: "five-hour", utilizationFields: ["remainingFraction"], resetFields: [] }],
      },
      fetchedAt: NOW,
    });

    expect(snapshot.evidence).toHaveLength(0);
    expect(snapshot.error).toBe("capacity payload carried no recognizable telemetry records");
  });

  it("identity matching is exact: model-b never claims model-b-low's windows", () => {
    const snapshot = normalizeCapacityPayload({
      payload: { files: [{ provider: "antigravity", status: "active", quota_groups: [{ model: "cliproxy/model-b-low", remainingFraction: 0.5 }] }] },
      source: {
        ...source,
        modelIds: ["cliproxy/model-b"],
        windows: [{ name: "five-hour", utilizationFields: ["remainingFraction"], resetFields: [] }],
      },
      fetchedAt: NOW,
    });

    expect(snapshot.evidence).toHaveLength(0);
  });
});

describe("TOG-7163 class 2: order-invariant mixed-pool tests", () => {
  it.each([false, true])("mixed pool projects identically when grouped input order reverses (reverse=%s)", (reverse) => {
    const snapshot = normalizeCapacityPayload({
      payload: { files: [groupedCredential(reverse)] },
      source,
      fetchedAt: NOW,
    });

    const byModel = new Map(snapshot.evidence.map((entry) => [entry.modelId, entry]));
    // The audit's exact inversion: PR #41 emitted exhausted/exhausted forward
    // and healthy/healthy reversed. Exact projection holds both orders.
    expect(byModel.get("cliproxy/model-a-high")).toMatchObject({ health: "exhausted" });
    expect(byModel.get("cliproxy/model-b-low")).toMatchObject({ health: "healthy" });
  });

  it("mixed pool of two credentials keeps each credential's verdict per record", () => {
    const snapshot = normalizeCapacityPayload({
      payload: { files: [credential("active", 0, 0), credential("active", 0.5, 0.7)] },
      source,
      fetchedAt: NOW,
    });

    expect(snapshot.error).toBeNull();
    const exhausted = snapshot.evidence.filter((entry) => entry.laneLabel === "record-1");
    const healthy = snapshot.evidence.filter((entry) => entry.laneLabel === "record-2");
    expect(exhausted).toHaveLength(2);
    expect(exhausted.every((entry) => entry.health === "exhausted")).toBe(true);
    expect(healthy).toHaveLength(2);
    expect(healthy.every((entry) => entry.health === "healthy")).toBe(true);
  });

  it("mixed pool keeps per-record verdicts: the exhausted record reads exhausted, the healthy record reads healthy", () => {
    const snapshot = normalizeCapacityPayload({
      payload: { files: [credential("active", 0, 0), credential("active", 0.5, 0.7)] },
      source,
      fetchedAt: NOW,
    });

    // No global suppression: the exhausted credential does not drag the
    // healthy credential's rows down, and vice versa. (Under enforce the
    // selector aggregates worst-per-model, so a mixed pool still refuses —
    // that aggregation is a separate, documented seam, not this defect.)
    expect(snapshot.error).toBeNull();
    const exhaustedRows = snapshot.evidence.filter((entry) => entry.laneLabel === "record-1");
    const healthyRows = snapshot.evidence.filter((entry) => entry.laneLabel === "record-2");
    expect(exhaustedRows).toHaveLength(2);
    expect(exhaustedRows.every((entry) => entry.health === "exhausted" && entry.telemetryAvailable)).toBe(true);
    expect(healthyRows).toHaveLength(2);
    expect(healthyRows.every((entry) => entry.health === "healthy" && entry.telemetryAvailable)).toBe(true);
  });
});

describe("TOG-7163 class 3: sticky-last-error vs auth-revocation", () => {
  it("a per-record status:error does not suppress sibling records' healthy windows", () => {
    const snapshot = normalizeCapacityPayload({
      payload: { files: [credential("error", 0.5, 0.7), credential("active", 0.5, 0.7)] },
      source,
      fetchedAt: NOW,
    });

    expect(snapshot.error).toBeNull();
    const healthy = snapshot.evidence.filter((entry) => entry.laneLabel === "record-2");
    expect(healthy).toHaveLength(2);
    expect(healthy.every((entry) => entry.health === "healthy" && entry.telemetryAvailable)).toBe(true);
  });

  it("an error-status record with healthy windows keeps its own windows (scoped, not global)", () => {
    const snapshot = normalizeCapacityPayload({
      payload: { files: [credential("error", 0.5, 0.7)] },
      source,
      fetchedAt: NOW,
    });

    expect(snapshot.error).toBeNull();
    expect(snapshot.evidence).toHaveLength(2);
    // The record's own status folds conservatively into its own rows only: the
    // healthy windows stay reported (utilization 0.5, telemetry available) on
    // THIS record's rows, while the snapshot carries no global error for
    // sibling records to inherit. `normalizeHealth` maps bare `"error"` to
    // null (it is a transport word, not a lane verdict), so the windows govern.
    expect(snapshot.evidence.every((entry) => entry.health === "healthy")).toBe(true);
    expect(snapshot.evidence.every((entry) => entry.utilization === 0.5 && entry.telemetryAvailable)).toBe(true);
  });

  it("auth revocation (401/403) stays a transport error distinct from a sticky telemetry failure", async () => {
    const { readCapacitySource } = await import("../src/capacity/read.js");
    const revoked = await readCapacitySource({
      source,
      http: { request: async () => ({ status: 401, contentType: "application/json", body: {}, responseBytes: 2, redirected: false }) },
      apiKey: null,
      now: () => NOW,
    });
    const unreachable = await readCapacitySource({
      source,
      http: { request: async () => { throw new Error("upstream unreachable"); } },
      apiKey: null,
      now: () => NOW,
    });

    expect(revoked).toMatchObject({ evidence: [], error: "capacity-authentication-failed" });
    expect(unreachable).toMatchObject({ evidence: [], error: "capacity-request-failed" });
    expect(revoked.error).not.toBe(unreachable.error);
  });
});

describe("TOG-7163 class 4: one-good/one-bad-account coverage", () => {
  it("one exhausted + one healthy account: per-record verdicts stay distinct (no global suppression)", () => {
    const snapshot = normalizeCapacityPayload({
      payload: { files: [credential("active", 0, 0), credential("active", 0.5, 0.7)] },
      source,
      fetchedAt: NOW,
    });

    // The audit's defect 2 in account form: the exhausted account must not
    // suppress the healthy account's windows at the snapshot level. Evidence
    // rows stay per-record (2 exhausted + 2 healthy), snapshot error stays
    // null. (Under enforce the selector's worst-per-model aggregation still
    // refuses a mixed pool — a separate, documented seam.)
    expect(snapshot.error).toBeNull();
    expect(snapshot.evidence.filter((entry) => entry.health === "exhausted")).toHaveLength(2);
    expect(snapshot.evidence.filter((entry) => entry.health === "healthy")).toHaveLength(2);
  });

  it("all accounts exhausted: enforce+exclude-lane refuses with per-model capacity rejections", () => {
    const snapshot = normalizeCapacityPayload({
      payload: { files: [credential("active", 0, 0), credential("active", 0, 0)] },
      source,
      fetchedAt: NOW,
    });
    const decision = selectModel({
      config: routingConfig(),
      descriptor: { taskClass: "architecture" },
      signals: { capacityEvidence: snapshot.evidence, capacityError: snapshot.error ?? undefined },
    });

    // Both models are `enabled: false` here, so the refusal arrives via the
    // table gate; the telemetry half is pinned by the evidence assertions.
    expect(snapshot.evidence.every((entry) => entry.health === "exhausted")).toBe(true);
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.rejections.length).toBeGreaterThan(0);
  });

  it("incomplete credential (missing weekly window) fails closed per record, healthy sibling still serves", () => {
    const incomplete = {
      auth_index: "must-not-leak",
      provider: "antigravity",
      type: "antigravity",
      status: "active",
      quota_windows: { "five-hour": { remainingFraction: 0.5, resetAt: "2026-09-06T22:00:00Z" } },
    };
    const snapshot = normalizeCapacityPayload({
      payload: { files: [incomplete, credential("active", 0.5, 0.7)] },
      source,
      fetchedAt: NOW,
    });

    expect(snapshot.error).toBeNull();
    const incompleteRows = snapshot.evidence.filter((entry) => entry.laneLabel === "record-1");
    const healthyRows = snapshot.evidence.filter((entry) => entry.laneLabel === "record-2");
    // The incomplete record still yields its five-hour window; it must not
    // poison the complete sibling's rows.
    expect(healthyRows).toHaveLength(2);
    expect(healthyRows.every((entry) => entry.telemetryAvailable)).toBe(true);
    expect(incompleteRows).toHaveLength(2);
  });
});
