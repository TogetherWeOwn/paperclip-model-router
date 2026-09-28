/**
 * TOG-7903 (Gap G2x): mutation-pin the pin-refusal guards in
 * `src/engine/select.ts` (the `if (pinnedId)` block: blocklist, the 0.7
 * weekly-utilization cap, and the enforce-usability term).
 *
 * The three guards are high-stakes (a honored pin parks work on a lane the
 * operator or telemetry ruled out) and mutant-fragile: each is one boolean
 * term in `honored`, so deleting or rescoping any one of them still compiles
 * and still serves. Every test below isolates exactly ONE guard as the
 * sole cause of the verdict (single-cause discipline: the other two guards
 * are held provably clear), and every test title names its guard, so a
 * reviewer weakening one guard gets a red suite naming it:
 *
 * - blocklist (`pinBlocklist.includes`): refused in shadow mode (test 1) and
 *   with capacity routing disabled (test 2). The existing enforce-mode
 *   blocklist test in `capacity.spec.ts` covers removal of the guard; these
 *   two kill a mutant that scopes the blocklist to enforce mode only (the
 *   config comment promises "whatever the mode or evidence"). Each carries
 *   its honored control, which also kills an "always refuse" mutant.
 * - weekly-utilization cap (`pinnedUtil > PIN_MAX_WEEKLY_UTILIZATION`):
 *   refused in shadow mode (test 3) although `usable()` passes — the cap is
 *   stricter than the capacity gate by design (TOG-3551 scope 3: "both
 *   shadow and enforce"). Kills cap removal (with the existing hot-lane and
 *   boundary tests) and an enforce-only rescope. The `>`-vs-`>=` boundary
 *   itself is pinned by "honors a pin exactly at the cap and refuses it just
 *   above" in `capacity.spec.ts`, not duplicated here.
 * - enforce-usability (`usable(pinned)` in enforce mode): refused under
 *   enforce+fail-open with the cap held clear via a null utilization (test
 *   4 — the existing exhausted-pin test is decided upstream by the
 *   fail-closed veto before the pin block runs, so deleting the usability
 *   term leaves it green; this test is the only kill), and still honored in
 *   shadow mode on identical evidence (test 5 — kills a mutant that applies
 *   the usability gate in every mode).
 */
import { describe, expect, it } from "vitest";

import type { CapacityEvidence } from "../src/capacity/types.js";
import { resolveConfig } from "../src/config/resolve.js";
import { selectModel } from "../src/engine/select.js";

function evidenceFor(
  modelId: string,
  patch: Partial<CapacityEvidence> = {},
): CapacityEvidence {
  return {
    modelId,
    source: "subscriptions",
    laneLabel: `${modelId}-lane`,
    health: "healthy",
    posture: "available",
    utilization: 0.2,
    remainingFraction: 0.8,
    resetsAt: null,
    resetInSeconds: null,
    windows: [],
    telemetryAvailable: true,
    reason: "healthy",
    ...patch,
  };
}

function baseConfig(mode: "shadow" | "enforce") {
  return resolveConfig({
    routing: { enabled: true, mode: "advise", stickyModelWithinIssue: false },
    capacityRouting: {
      enabled: true,
      mode,
      unknownTelemetry: "fail-closed",
      sources: [
        {
          id: "subscriptions",
          statusUrl: "https://capacity.example.test/status",
          apiKeySecretRef: null,
          modelIds: ["pinned-model", "spare-model"],
          healthFields: ["status"],
          windows: [{ name: "weekly", utilizationFields: ["used7d"], resetFields: [] }],
        },
      ],
    },
    models: [
      {
        id: "pinned-model",
        tier: "standard",
        quality: 80,
        costPerMTokIn: 0,
        costPerMTokOut: 0,
        contextWindow: 200000,
      },
      {
        id: "spare-model",
        tier: "standard",
        quality: 80,
        costPerMTokIn: 1,
        costPerMTokOut: 4,
        contextWindow: 200000,
      },
    ],
    taskClasses: [{ key: "implementation", qualityFloor: 70 }],
  });
}

const PINNED = {
  taskClass: "implementation",
  pinnedModelId: "pinned-model",
  pinReason: "mutation probe",
} as const;

describe("TOG-7903: pin-refusal guards fail one at a time", () => {
  it("blocklist guard: refuses a blocklisted pin in shadow mode, honors it off the list", () => {
    const evidence = [evidenceFor("pinned-model"), evidenceFor("spare-model")];

    const base = baseConfig("shadow");
    const blockedConfig = {
      ...base,
      routing: { ...base.routing, pinBlocklist: ["pinned-model"] },
    };
    const refused = selectModel({
      config: blockedConfig,
      descriptor: { ...PINNED },
      signals: { capacityEvidence: evidence },
    });
    expect(refused.pin).toMatchObject({ modelId: "pinned-model", honored: false });
    expect(refused.trace.join(" ")).toContain("pin refused: pinned-model is on the pin blocklist");

    const allowed = selectModel({
      config: baseConfig("shadow"),
      descriptor: { ...PINNED },
      signals: { capacityEvidence: evidence },
    });
    expect(allowed).toMatchObject({ outcome: "selected", modelId: "pinned-model", pin: { honored: true } });
  });

  it("blocklist guard: refuses a blocklisted pin with capacity routing disabled", () => {
    // No evidence at all: the cap cannot fire (null utilization) and the
    // usability term is vacuous when disabled, so only the blocklist refuses.
    const base = baseConfig("shadow");
    const disabled = resolveConfig({
      ...base,
      capacityRouting: { ...base.capacityRouting, enabled: false },
      routing: { ...base.routing, pinBlocklist: ["pinned-model"] },
    });
    const decision = selectModel({ config: disabled, descriptor: { ...PINNED }, signals: {} });
    expect(decision.pin).toMatchObject({ modelId: "pinned-model", honored: false });
    expect(decision.trace.join(" ")).toContain("pin refused: pinned-model is on the pin blocklist");

    // Honored control: same disabled config, pin off the list.
    const unblocked = resolveConfig({
      ...base,
      capacityRouting: { ...base.capacityRouting, enabled: false },
    });
    const allowed = selectModel({ config: unblocked, descriptor: { ...PINNED }, signals: {} });
    expect(allowed).toMatchObject({ outcome: "selected", modelId: "pinned-model", pin: { honored: true } });
  });

  it("weekly-utilization-cap guard: refuses a hot-but-usable pin in shadow mode", () => {
    const hot = [
      evidenceFor("pinned-model", { utilization: 0.85, remainingFraction: 0.15 }),
      evidenceFor("spare-model"),
    ];
    const refused = selectModel({
      config: baseConfig("shadow"),
      descriptor: { ...PINNED },
      signals: { capacityEvidence: hot },
    });
    expect(refused.pin).toMatchObject({ modelId: "pinned-model", honored: false });
    expect(refused.trace.join(" ")).toContain(
      "pin refused: pinned-model over weekly utilization cap 0.7 (utilization 0.85)",
    );

    const cool = [
      evidenceFor("pinned-model", { utilization: 0.2, remainingFraction: 0.8 }),
      evidenceFor("spare-model"),
    ];
    const allowed = selectModel({
      config: baseConfig("shadow"),
      descriptor: { ...PINNED },
      signals: { capacityEvidence: cool },
    });
    expect(allowed).toMatchObject({ outcome: "selected", modelId: "pinned-model", pin: { honored: true } });
  });

  it("enforce-usability guard: refuses an exhausted pin under enforce+fail-open and serves the spare", () => {
    // Null utilization holds the cap clear; fail-open skips the fail-closed
    // veto, so the usability term is the sole refuser. TOG-1062: an explicit
    // exhausted health is a positive signal with or without a number.
    const exhausted = [
      evidenceFor("pinned-model", {
        health: "exhausted",
        posture: "unavailable",
        utilization: null,
        remainingFraction: null,
        reason: "exhausted",
      }),
      evidenceFor("spare-model"),
    ];
    const base = baseConfig("enforce");
    const failOpen = resolveConfig({
      ...base,
      capacityRouting: { ...base.capacityRouting, unknownTelemetry: "fail-open" },
    });
    const refused = selectModel({
      config: failOpen,
      descriptor: { ...PINNED },
      signals: { capacityEvidence: exhausted },
    });
    expect(refused.pin).toMatchObject({ modelId: "pinned-model", honored: false });
    expect(refused.trace.join(" ")).toContain("pin refused: pinned-model");
    expect(refused.rejections).toContainEqual(
      expect.objectContaining({ modelId: "pinned-model", stage: "capacity" }),
    );
    expect(refused).toMatchObject({ outcome: "selected", modelId: "spare-model" });

    const healthy = [evidenceFor("pinned-model"), evidenceFor("spare-model")];
    const allowed = selectModel({
      config: failOpen,
      descriptor: { ...PINNED },
      signals: { capacityEvidence: healthy },
    });
    expect(allowed).toMatchObject({ outcome: "selected", modelId: "pinned-model", pin: { honored: true } });
  });

  it("enforce-usability guard: still honors an exhausted pin in shadow mode", () => {
    // Identical evidence to the enforce refusal above: shadow mode never
    // consults usable() for pins, so the pin is honored. Kills a mutant that
    // applies the usability gate in every mode.
    const exhausted = [
      evidenceFor("pinned-model", {
        health: "exhausted",
        posture: "unavailable",
        utilization: null,
        remainingFraction: null,
        reason: "exhausted",
      }),
      evidenceFor("spare-model"),
    ];
    const decision = selectModel({
      config: baseConfig("shadow"),
      descriptor: { ...PINNED },
      signals: { capacityEvidence: exhausted },
    });
    expect(decision).toMatchObject({ outcome: "selected", modelId: "pinned-model", pin: { honored: true } });
  });
});
