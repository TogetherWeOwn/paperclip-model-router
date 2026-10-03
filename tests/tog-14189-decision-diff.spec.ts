import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildDecisionDiff,
  emitDecisionDiff,
  type DecisionDiffLogger,
} from "../src/decision-diff.js";

// TOG-14189: flag-gated decision-diff emit verb (old lane -> new lane +
// reason) that only emits to logs on fixtures; never mutates live routing.
//
// Fixture mechanics: two lane snapshots (cheap lane-a vs quality lane-b, the
// same miniature as the degraded-flag truth table) diffed purely in memory.
// The emit half takes an injected spy logger — never a plugin context — so
// the flag-off tests prove silence and the import test proves there is no
// live call path to silence in the first place.

function spyLogger(): DecisionDiffLogger & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    info(message: string, fields?: Record<string, unknown>): void {
      calls.push([message, fields]);
    },
  };
}

const laneA = { source: "subscriptions", laneLabel: "lane-a-lane", modelId: "lane-a" };
const laneB = { source: "subscriptions", laneLabel: "lane-b-lane", modelId: "lane-b" };

describe("TOG-14189: decision-diff shape on fixtures", () => {
  it("reports a lane move with the reason carried through", () => {
    expect(buildDecisionDiff(laneA, laneB, "lane-a exhausted")).toEqual({
      oldSource: "subscriptions",
      oldLaneLabel: "lane-a-lane",
      oldModelId: "lane-a",
      newSource: "subscriptions",
      newLaneLabel: "lane-b-lane",
      newModelId: "lane-b",
      reason: "lane-a exhausted",
      changed: true,
    });
  });

  it("reports unchanged when both sides serve the same lane", () => {
    const diff = buildDecisionDiff(laneA, { ...laneA }, "steady state");
    expect(diff.changed).toBe(false);
    expect(diff.oldModelId).toBe("lane-a");
    expect(diff.newModelId).toBe("lane-a");
  });

  it("reads null lanes as unknown without crashing", () => {
    const diff = buildDecisionDiff(null, laneB, "first decision");
    expect(diff).toMatchObject({
      oldSource: null,
      oldLaneLabel: null,
      oldModelId: null,
      newSource: "subscriptions",
      newModelId: "lane-b",
      changed: true,
    });
  });

  it("falls back to unspecified on an empty reason and caps a long one", () => {
    expect(buildDecisionDiff(laneA, laneB, "   ").reason).toBe("unspecified");
    const long = buildDecisionDiff(laneA, laneB, "r".repeat(600));
    expect(long.reason).toHaveLength(512);
  });
});

describe("TOG-14189: flag-gated emit", () => {
  it("flag absent (default off) never calls the logger", () => {
    const logger = spyLogger();
    const emitted = emitDecisionDiff(logger, buildDecisionDiff(laneA, laneB, "lane-a exhausted"));
    expect(emitted).toBe(false);
    expect(logger.calls).toHaveLength(0);
  });

  it("flag explicitly off never calls the logger", () => {
    const logger = spyLogger();
    const emitted = emitDecisionDiff(
      logger,
      buildDecisionDiff(laneA, laneB, "lane-a exhausted"),
      { enabled: false },
    );
    expect(emitted).toBe(false);
    expect(logger.calls).toHaveLength(0);
  });

  it("flag on emits exactly one log line matching the expected shape", () => {
    const logger = spyLogger();
    const emitted = emitDecisionDiff(
      logger,
      buildDecisionDiff(laneA, laneB, "lane-a exhausted"),
      { enabled: true },
    );
    expect(emitted).toBe(true);
    expect(logger.calls).toHaveLength(1);
    const [message, fields] = logger.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain("subscriptions -> subscriptions");
    expect(message).toContain("lane-a exhausted");
    expect(fields).toEqual({
      oldSource: "subscriptions",
      oldLaneLabel: "lane-a-lane",
      oldModelId: "lane-a",
      newSource: "subscriptions",
      newLaneLabel: "lane-b-lane",
      newModelId: "lane-b",
      reason: "lane-a exhausted",
      changed: true,
    });
  });

  it("a throwing logger reads as not emitted, never as a throw", () => {
    const logger: DecisionDiffLogger = {
      info(): void {
        throw new Error("log sink down");
      },
    };
    expect(() =>
      emitDecisionDiff(logger, buildDecisionDiff(laneA, laneB, "lane-a exhausted"), { enabled: true }),
    ).not.toThrow();
    expect(
      emitDecisionDiff(logger, buildDecisionDiff(laneA, laneB, "lane-a exhausted"), { enabled: true }),
    ).toBe(false);
  });
});

describe("TOG-14189: no live call path", () => {
  it("the verb module imports no live plugin surface", () => {
    // The emit takes an injected logger and the diff is pure. If this module
    // ever gains an import reaching the worker, config, plugin SDK, or any
    // state/db/http/secrets/capacity surface, a live call path exists and
    // this test must fail. Only import lines are inspected, so the doc
    // comment may name the forbidden surfaces without tripping the guard.
    const source = readFileSync(
      path.join(path.resolve(import.meta.dirname, ".."), "src", "decision-diff.ts"),
      "utf8",
    );
    const imports = source
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import"))
      .join("\n");
    expect(imports).not.toMatch(/worker|config|plugin-sdk|capacity|inference|health|telemetry|fidelity/i);
    expect(imports).not.toMatch(/state|db|http|secrets/i);
    // The suite's only logger is the injected spy: flag-off silence above is
    // silence of the only sink the verb can reach.
    expect(source).toContain("options?.enabled !== true");
  });
});
