import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildRoutingMisfire,
  emitRoutingMisfire,
  ROUTING_MISFIRE_CHANNEL,
  ROUTING_MISFIRE_DETAIL_MAX_LENGTH,
  ROUTING_MISFIRE_FIELD_MAX_LENGTH,
  type RoutingMisfireLogger,
  type RoutingMisfireRecord,
} from "../src/routing-misfire.js";

// Flag-gated routing-misfire log verb: builds one channel-shaped record (the
// issue id plus tier label, the model that actually ran, what went wrong) and
// emits it to logs only behind an explicit flag (default off). Propose-only:
// no re-pinning, no routing-state reads or writes, no capacity coupling.
//
// Fixture mechanics: small in-memory misfire inputs run through the pure
// builder. Flag-off tests prove the emit stays silent, and the import test
// proves there is no live call path to stay silent through in the first place.

const MISFIRE = {
  issueId: "TOG-1234",
  tier: "T2",
  modelId: "lane-a",
  symptom: "dropped tool calls",
  detail: "two tool calls dropped before the redo",
} as const;

function spyLogger(): RoutingMisfireLogger & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    info(message: string, fields?: Record<string, unknown>): void {
      calls.push([message, fields]);
    },
  };
}

function record(): RoutingMisfireRecord {
  const built = buildRoutingMisfire({ ...MISFIRE }, { now: "2026-10-04T08:00:00.000Z" });
  if (!built) throw new Error("fixture misfire must build");
  return built;
}

describe("routing-misfire record shape on fixtures", () => {
  it("carries the channel fields through with sink name and timestamp", () => {
    expect(record()).toEqual({
      channel: ROUTING_MISFIRE_CHANNEL,
      issueId: "TOG-1234",
      tier: "T2",
      modelId: "lane-a",
      symptom: "dropped tool calls",
      detail: "two tool calls dropped before the redo",
      observedAt: "2026-10-04T08:00:00.000Z",
    });
    expect(ROUTING_MISFIRE_CHANNEL).toBe("routing-misfire");
  });

  it("reads absent tier and detail as null, never as empty strings", () => {
    const built = buildRoutingMisfire({
      issueId: "TOG-1234",
      modelId: "lane-a",
      symptom: "thrashing",
    });
    expect(built).toMatchObject({ tier: null, detail: null });
  });

  it("returns null when a required field is missing or blank", () => {
    expect(buildRoutingMisfire({ issueId: "  ", modelId: "lane-a", symptom: "thrashing" })).toBeNull();
    expect(buildRoutingMisfire({ issueId: "TOG-1234", modelId: "", symptom: "thrashing" })).toBeNull();
    expect(buildRoutingMisfire({ issueId: "TOG-1234", modelId: "lane-a", symptom: "   " })).toBeNull();
    expect(buildRoutingMisfire(null as unknown as typeof MISFIRE)).toBeNull();
  });

  it("trims fields and caps long symptom and detail values", () => {
    expect(ROUTING_MISFIRE_FIELD_MAX_LENGTH).toBe(512);
    expect(ROUTING_MISFIRE_DETAIL_MAX_LENGTH).toBe(2000);
    const built = buildRoutingMisfire({
      issueId: "  TOG-1234  ",
      tier: "  T2  ",
      modelId: "lane-a",
      symptom: "s".repeat(600),
      detail: "d".repeat(2500),
    });
    expect(built).toMatchObject({ issueId: "TOG-1234", tier: "T2" });
    expect(built?.symptom).toHaveLength(512);
    expect(built?.detail).toHaveLength(2000);
  });

  it("falls back to the current time on an unparseable now", () => {
    const before = Date.now();
    const built = buildRoutingMisfire({ ...MISFIRE }, { now: "not-a-time" });
    const after = Date.now();
    expect(built).not.toBeNull();
    const observed = Date.parse(built?.observedAt ?? "");
    expect(Number.isFinite(observed)).toBe(true);
    expect(observed).toBeGreaterThanOrEqual(before);
    expect(observed).toBeLessThanOrEqual(after);
  });

  it("never mutates the input object", () => {
    const input = { ...MISFIRE };
    const snapshot = structuredClone(input);
    buildRoutingMisfire(input);
    expect(input).toEqual(snapshot);
  });
});

describe("routing-misfire flag gating (flag-off unchanged)", () => {
  it("flag absent (default off) never calls the logger", () => {
    const logger = spyLogger();
    expect(emitRoutingMisfire(logger, record())).toBe(false);
    expect(logger.calls).toHaveLength(0);
  });

  it("flag explicitly off never calls the logger", () => {
    const logger = spyLogger();
    expect(emitRoutingMisfire(logger, record(), { enabled: false })).toBe(false);
    expect(logger.calls).toHaveLength(0);
  });

  it("flag on emits exactly one log line in the channel shape", () => {
    const logger = spyLogger();
    const built = record();
    expect(emitRoutingMisfire(logger, built, { enabled: true })).toBe(true);
    expect(logger.calls).toHaveLength(1);
    const [message, fields] = logger.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain("TOG-1234");
    expect(message).toContain("lane-a");
    expect(message).toContain("dropped tool calls");
    expect(fields).toEqual({
      channel: ROUTING_MISFIRE_CHANNEL,
      issueId: "TOG-1234",
      tier: "T2",
      modelId: "lane-a",
      symptom: "dropped tool calls",
      detail: "two tool calls dropped before the redo",
      observedAt: "2026-10-04T08:00:00.000Z",
    });
  });

  it("flag on with a null record emits nothing", () => {
    const logger = spyLogger();
    expect(emitRoutingMisfire(logger, null, { enabled: true })).toBe(false);
    expect(logger.calls).toHaveLength(0);
  });

  it("a throwing logger reads as not emitted, never as a throw", () => {
    const logger: RoutingMisfireLogger = {
      info(): void {
        throw new Error("log sink down");
      },
    };
    expect(() => emitRoutingMisfire(logger, record(), { enabled: true })).not.toThrow();
    expect(emitRoutingMisfire(logger, record(), { enabled: true })).toBe(false);
  });
});

describe("routing-misfire propose-only boundary (no live mutation)", () => {
  it("the verb module imports no live plugin surface and stays flag-gated", () => {
    // The builder is pure and the emit takes an injected logger. If this
    // module ever gains an import reaching the worker, config, plugin SDK, or
    // any routing/capacity surface, a live call path exists and this test must
    // fail. Only import lines are inspected, so the doc comment may name the
    // forbidden surfaces without tripping the guard.
    const source = readFileSync(
      path.join(path.resolve(import.meta.dirname, ".."), "src", "routing-misfire.ts"),
      "utf8",
    );
    const imports = source
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import"))
      .join("\n");
    expect(imports).not.toMatch(/worker|config|plugin-sdk|capacity|inference|health|telemetry|fidelity/i);
    expect(imports).not.toMatch(/state|db|http|secrets|select|sticky|enforce/i);
    // No live plugin call can exist without reaching through a context object.
    expect(source).not.toMatch(/ctx\.(state|db|http|secrets|activity|config)/);
    // The suite's only sink is the injected spy: flag-off silence above is
    // silence of the only output the verb can reach.
    expect(source).toContain("options?.enabled !== true");
  });
});
