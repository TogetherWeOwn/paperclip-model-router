import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { CapacityEvidence } from "../src/capacity/types.js";
import { resolveConfig } from "../src/config/resolve.js";
import {
  buildDecisionDiff,
  emitDecisionDiff,
  type DecisionDiff,
  type DecisionDiffLogger,
} from "../src/decision-diff.js";
import { selectModel, type SelectInput } from "../src/engine/select.js";
import type { RoutingDecision, TaskDescriptor } from "../src/engine/types.js";

// TOG-14285: advise-vs-enforce agreement matrix over the flag-gated
// decision-diff emit verb (shipped in TOG-14189).
//
// Each row runs the REAL selector twice over the same in-memory fixtures —
// once in advise (`capacityRouting.mode: shadow`, static cost order serves)
// and once in enforce (usage-aware pool serves) — then diffs the two served
// lanes with `buildDecisionDiff`. The matrix asserts lane-by-lane agreement:
// rows that must agree read `changed: false`, and every flip lands on an
// explicitly allow-listed lane (the flip set is pinned exactly: no more, no
// fewer). Every diff row carries lane + verdict (source, lane label, model
// id, non-empty reason), and every emit stays behind the `enabled` flag.
//
// Fixture mechanics: three synthetic models with strictly ordered static
// costs (cheap-a < mid-b < pricey-c), so advise always serves cheap-a
// whenever it qualifies. Evidence is hand-built per row (healthy vs
// exhausted, covered vs uncovered) — no snapshot files, no pace verdicts.
// `routing.mode` stays `advise` throughout: the enforce side is an offline
// what-if through the same pure selector, never live routing state.
//
// Non-goals (owned elsewhere, not duplicated here): pace ordering
// (TOG-14235 dual-policy diff), the enforce cutover path itself
// (TOG-13479), staging smoke + runbook (TOG-13985/13986), and the verb's own
// shape/flag unit tests (TOG-14189).

interface MatrixExpect {
  advise: { modelId: string | null; source: string | null };
  enforce: { modelId: string | null; source: string | null };
  changed: boolean;
}

interface MatrixRow {
  id: string;
  title: string;
  descriptor: TaskDescriptor;
  evidence: CapacityEvidence[];
  budgetSpentFraction?: number;
  reason: string;
  expectPinRefusedBoth?: boolean;
  expect: MatrixExpect;
}

function lane(
  modelId: string,
  source: string,
  laneLabel: string,
  status: "healthy" | "exhausted",
  utilization: number,
): CapacityEvidence {
  return status === "healthy"
    ? {
        modelId, source, laneLabel, health: "healthy", posture: "available",
        utilization, remainingFraction: 1 - utilization,
        resetsAt: null, resetInSeconds: null, windows: [],
        telemetryAvailable: true, reason: "synthetic matrix: healthy",
      }
    : {
        modelId, source, laneLabel, health: "exhausted", posture: "unavailable",
        utilization, remainingFraction: 0,
        resetsAt: null, resetInSeconds: null, windows: [],
        telemetryAvailable: true, reason: "synthetic matrix: exhausted",
      };
}

const HEALTHY_ALL: CapacityEvidence[] = [
  lane("cheap-a", "sub-a", "label-a", "healthy", 0.1),
  lane("mid-b", "sub-b", "label-b", "healthy", 0.3),
  lane("pricey-c", "sub-c", "label-c", "healthy", 0.5),
];

const CHEAP_EXHAUSTED: CapacityEvidence[] = [
  lane("cheap-a", "sub-a", "label-a", "exhausted", 1),
  lane("mid-b", "sub-b", "label-b", "healthy", 0.1),
  lane("pricey-c", "sub-c", "label-c", "healthy", 0.5),
];

const CHEAP_UNCOVERED: CapacityEvidence[] = [
  lane("mid-b", "sub-b", "label-b", "healthy", 0.1),
  lane("pricey-c", "sub-c", "label-c", "healthy", 0.5),
];

const ALL_EXHAUSTED: CapacityEvidence[] = [
  lane("cheap-a", "sub-a", "label-a", "exhausted", 1),
  lane("mid-b", "sub-b", "label-b", "exhausted", 1),
  lane("pricey-c", "sub-c", "label-c", "exhausted", 1),
];

const ROWS: MatrixRow[] = [
  {
    id: "all-healthy",
    title: "every lane available: enforce agrees with advise",
    descriptor: { taskClass: "implementation" },
    evidence: HEALTHY_ALL,
    reason: "steady state: every lane available, so enforce agrees with advise",
    expect: {
      advise: { modelId: "cheap-a", source: "sub-a" },
      enforce: { modelId: "cheap-a", source: "sub-a" },
      changed: false,
    },
  },
  {
    id: "cheapest-exhausted",
    title: "cheapest lane exhausted: enforce diverts to the allow-listed lane",
    descriptor: { taskClass: "implementation" },
    evidence: CHEAP_EXHAUSTED,
    reason: "enforce diverts: cheap-a lane unavailable (exhausted); advise serves the static cheapest",
    expect: {
      advise: { modelId: "cheap-a", source: "sub-a" },
      enforce: { modelId: "mid-b", source: "sub-b" },
      changed: true,
    },
  },
  {
    id: "cheapest-uncovered",
    title: "cheapest model without evidence: enforce prefers a covered lane",
    descriptor: { taskClass: "implementation" },
    evidence: CHEAP_UNCOVERED,
    reason: "enforce prefers a covered lane: cheap-a has no evidence; advise serves the static cheapest",
    expect: {
      advise: { modelId: "cheap-a", source: null },
      enforce: { modelId: "mid-b", source: "sub-b" },
      changed: true,
    },
  },
  {
    id: "all-exhausted",
    title: "every lane exhausted: enforce refuses while advise still serves",
    descriptor: { taskClass: "implementation" },
    evidence: ALL_EXHAUSTED,
    reason: "enforce refuses: every lane unavailable; advise still serves the static cheapest",
    expect: {
      advise: { modelId: "cheap-a", source: "sub-a" },
      enforce: { modelId: null, source: null },
      changed: true,
    },
  },
  {
    id: "pin-on-exhausted",
    title: "pin onto an exhausted lane: refused both sides, only enforce diverts",
    descriptor: { taskClass: "implementation", pinnedModelId: "cheap-a", pinReason: "incident override" },
    evidence: CHEAP_EXHAUSTED,
    reason: "pin refused under both policies (over weekly cap); advise serves the static cheapest, enforce diverts",
    expectPinRefusedBoth: true,
    expect: {
      advise: { modelId: "cheap-a", source: "sub-a" },
      enforce: { modelId: "mid-b", source: "sub-b" },
      changed: true,
    },
  },
  {
    id: "single-qualifier",
    title: "quality floor admits one model: both policies serve it",
    descriptor: { taskClass: "exacting" },
    evidence: HEALTHY_ALL,
    reason: "steady state: the quality floor admits only pricey-c under both policies",
    expect: {
      advise: { modelId: "pricey-c", source: "sub-c" },
      enforce: { modelId: "pricey-c", source: "sub-c" },
      changed: false,
    },
  },
  {
    id: "budget-halt",
    title: "budget halt: both policies refuse",
    descriptor: { taskClass: "implementation" },
    evidence: HEALTHY_ALL,
    budgetSpentFraction: 0.99,
    reason: "steady state: the budget halt refuses under both policies",
    expect: {
      advise: { modelId: null, source: null },
      enforce: { modelId: null, source: null },
      changed: false,
    },
  },
  {
    id: "no-telemetry",
    title: "no evidence at all: both policies serve the static cheapest",
    descriptor: { taskClass: "implementation" },
    evidence: [],
    reason: "steady state: no telemetry, so both policies serve the static cheapest",
    expect: {
      advise: { modelId: "cheap-a", source: null },
      enforce: { modelId: "cheap-a", source: null },
      changed: false,
    },
  },
];

/** Lanes enforce is allowed to flip onto, keyed by matrix row. Null = a refused decision. */
const FLIP_ALLOW_LIST: Record<string, { newSource: string | null; newModelId: string | null }> = {
  "cheapest-exhausted": { newSource: "sub-b", newModelId: "mid-b" },
  "cheapest-uncovered": { newSource: "sub-b", newModelId: "mid-b" },
  "all-exhausted": { newSource: null, newModelId: null },
  "pin-on-exhausted": { newSource: "sub-b", newModelId: "mid-b" },
};

function configFor(mode: "shadow" | "enforce") {
  return resolveConfig({
    routing: { enabled: true, mode: "advise", fallbackModelId: null, stickyModelWithinIssue: false, maxOutputTokens: 16384 },
    capacityRouting: { enabled: true, mode, unknownTelemetry: "fail-open", paceOrdering: false, sources: [] },
    models: [
      { id: "cheap-a", tier: "standard", quality: 80, costPerMTokIn: 0.5, costPerMTokOut: 2, contextWindow: 200000 },
      { id: "mid-b", tier: "standard", quality: 80, costPerMTokIn: 1, costPerMTokOut: 4, contextWindow: 200000 },
      { id: "pricey-c", tier: "standard", quality: 90, costPerMTokIn: 3, costPerMTokOut: 12, contextWindow: 200000 },
    ],
    taskClasses: [
      { key: "implementation", qualityFloor: 60 },
      { key: "exacting", qualityFloor: 85 },
    ],
    tiering: {
      signalWeights: {},
      thresholds: { small: 0, standard: 30, strong: 60, frontier: 85 },
      defaultTier: "standard",
    },
  });
}

function signalsFor(row: MatrixRow): SelectInput["signals"] {
  return {
    ...(row.evidence.length > 0
      ? { capacityEvidence: row.evidence.map((entry) => ({ ...entry })), capacityTelemetry: "available" as const }
      : { capacityEvidence: [] as CapacityEvidence[] }),
    ...(row.budgetSpentFraction !== undefined ? { budgetSpentFraction: row.budgetSpentFraction } : {}),
  };
}

function runRow(row: MatrixRow): { advise: RoutingDecision; enforce: RoutingDecision; diff: DecisionDiff } {
  const advise = selectModel({
    descriptor: { ...row.descriptor },
    config: configFor("shadow"),
    signals: signalsFor(row),
  });
  const enforce = selectModel({
    descriptor: { ...row.descriptor },
    config: configFor("enforce"),
    signals: signalsFor(row),
  });
  const diff = buildDecisionDiff(
    { source: advise.capacity.selectedSource, laneLabel: advise.capacity.selectedLaneLabel, modelId: advise.modelId },
    { source: enforce.capacity.selectedSource, laneLabel: enforce.capacity.selectedLaneLabel, modelId: enforce.modelId },
    row.reason,
  );
  return { advise, enforce, diff };
}

function spyLogger(): DecisionDiffLogger & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    info(message: string, fields?: Record<string, unknown>): void {
      calls.push([message, fields]);
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("TOG-14285: advise-vs-enforce agreement lane by lane", () => {
  it.each(ROWS)("row $id: $title", (row) => {
    const { advise, enforce, diff } = runRow(row);
    expect({ modelId: advise.modelId, source: advise.capacity.selectedSource }).toEqual(row.expect.advise);
    expect({ modelId: enforce.modelId, source: enforce.capacity.selectedSource }).toEqual(row.expect.enforce);
    // The diff mirrors the two served lanes exactly: lane + model on both sides.
    expect(diff).toMatchObject({
      oldSource: advise.capacity.selectedSource,
      oldLaneLabel: advise.capacity.selectedLaneLabel,
      oldModelId: advise.modelId,
      newSource: enforce.capacity.selectedSource,
      newLaneLabel: enforce.capacity.selectedLaneLabel,
      newModelId: enforce.modelId,
    });
    expect(diff.changed).toBe(row.expect.changed);
    // Every row carries its verdict as a non-empty reason.
    expect(diff.reason).toBe(row.reason);
    expect(diff.reason.length).toBeGreaterThan(0);
    if (row.expectPinRefusedBoth) {
      expect(advise.pin).toMatchObject({ modelId: "cheap-a", honored: false });
      expect(enforce.pin).toMatchObject({ modelId: "cheap-a", honored: false });
    }
  });
});

describe("TOG-14285: enforce flips only allow-listed lanes", () => {
  it("the flip set is exactly the allow-list: no more, no fewer, no other target", () => {
    const changed = ROWS.filter((row) => runRow(row).diff.changed).map((row) => row.id);
    expect(changed.sort()).toEqual(Object.keys(FLIP_ALLOW_LIST).sort());
    for (const [id, target] of Object.entries(FLIP_ALLOW_LIST)) {
      const row = ROWS.find((entry) => entry.id === id);
      if (!row) throw new Error(`allow-list names an unknown matrix row: ${id}`);
      const { diff } = runRow(row);
      expect({ newSource: diff.newSource, newModelId: diff.newModelId }).toEqual(target);
    }
  });

  it("every other row agrees: advise and enforce serve the same lane", () => {
    const agreeIds = ROWS.map((row) => row.id).filter((id) => !(id in FLIP_ALLOW_LIST));
    expect(agreeIds).toHaveLength(ROWS.length - Object.keys(FLIP_ALLOW_LIST).length);
    for (const id of agreeIds) {
      const row = ROWS.find((entry) => entry.id === id);
      if (!row) throw new Error(`matrix row went missing: ${id}`);
      const { advise, enforce, diff } = runRow(row);
      expect(diff.changed).toBe(false);
      expect(enforce.modelId).toBe(advise.modelId);
      expect(enforce.capacity.selectedSource).toBe(advise.capacity.selectedSource);
    }
  });
});

describe("TOG-14285: diff rows carry lane + verdict behind the flag", () => {
  it("flag absent or off stays silent on every matrix row", () => {
    for (const row of ROWS) {
      const { diff } = runRow(row);
      for (const options of [undefined, { enabled: false }] as const) {
        const logger = spyLogger();
        expect(emitDecisionDiff(logger, diff, options)).toBe(false);
        expect(logger.calls).toHaveLength(0);
      }
    }
  });

  it.each(ROWS)("row $id: flag on emits exactly one lane + verdict row", (row) => {
    const { diff } = runRow(row);
    const logger = spyLogger();
    expect(emitDecisionDiff(logger, diff, { enabled: true })).toBe(true);
    expect(logger.calls).toHaveLength(1);
    const [message, fields] = logger.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain(diff.reason);
    // The verb renders the both-unknown direction as "lane unknown" (see
    // emitDecisionDiff); every other direction reads "old -> new".
    const direction =
      diff.oldSource === null && diff.newSource === null
        ? "lane unknown"
        : `${diff.oldSource ?? "unknown"} -> ${diff.newSource ?? "unknown"}`;
    expect(message).toContain(direction);
    // The emitted row carries the full lane on both sides plus the verdict.
    expect(fields).toEqual({
      oldSource: diff.oldSource,
      oldLaneLabel: diff.oldLaneLabel,
      oldModelId: diff.oldModelId,
      newSource: diff.newSource,
      newLaneLabel: diff.newLaneLabel,
      newModelId: diff.newModelId,
      reason: diff.reason,
      changed: diff.changed,
    });
    expect(typeof fields.oldModelId === "string" || fields.oldModelId === null).toBe(true);
    expect(typeof fields.newModelId === "string" || fields.newModelId === null).toBe(true);
    expect(String(fields.reason).length).toBeGreaterThan(0);
    expect(String(fields.reason)).toMatch(/steady state|available|unavailable|exhausted|no evidence|refus|halt|static|covered|pin/i);
  });
});

describe("TOG-14285: advise-mode only, no live mutation", () => {
  it("the served side is advise: shadow serving with routing mode advise", () => {
    expect(configFor("shadow").routing.mode).toBe("advise");
    expect(configFor("shadow").capacityRouting.mode).toBe("shadow");
    expect(configFor("enforce").capacityRouting.mode).toBe("enforce");
  });

  it("frozen fixtures survive both policies: the selector mutates no caller input", () => {
    for (const row of ROWS) {
      const live = runRow(row);
      const frozenDescriptor = deepFreeze({ ...row.descriptor });
      const frozenSignals = deepFreeze(signalsFor(row));
      const shadowConfig = deepFreeze(configFor("shadow"));
      const enforceConfig = deepFreeze(configFor("enforce"));
      let advise: RoutingDecision;
      let enforce: RoutingDecision;
      expect(() => {
        advise = selectModel({ descriptor: frozenDescriptor, config: shadowConfig, signals: frozenSignals });
      }).not.toThrow();
      expect(() => {
        enforce = selectModel({
          descriptor: frozenDescriptor,
          config: enforceConfig,
          signals: frozenSignals,
        });
      }).not.toThrow();
      expect(advise!.modelId).toBe(live.advise.modelId);
      expect(enforce!.modelId).toBe(live.enforce.modelId);
    }
  });

  it("the matrix imports no live plugin surface", () => {
    // The matrix runs the pure selector over in-memory fixtures. If this spec
    // ever gains an import reaching the worker, the plugin SDK, live capacity
    // fetch, secrets, or the transport, a live call path exists and this test
    // must fail. Only import lines are inspected, so comments may name the
    // forbidden surfaces without tripping the guard.
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const imports = source
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import"))
      .join("\n");
    expect(imports).not.toMatch(/worker|plugin-sdk|capacity\/read|secrets|inference\/transport|spend-ledger|metrics|activity/i);
  });
});
