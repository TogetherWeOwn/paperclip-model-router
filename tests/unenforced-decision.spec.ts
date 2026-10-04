import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  detectUnenforcedDecisions,
  emitUnenforcedDecisions,
  UNENFORCED_DECISION_DEFAULT_AFTER_MS,
  type AdviseDecisionRow,
  type UnenforcedDecisionLogger,
} from "../src/unenforced-decision.js";

// Propose-only watchdog stale-proposal detector: advise (shadow) decisions
// older than the shadow window with no enforce comparison yield proposal
// records only — never an alert, never a mutation.
//
// Fixture mechanics: synthetic decision snapshots (snapshots, not live rows)
// with fixed ISO timestamps around a fixed `now`, so the stale / fresh /
// compared boundary is pinned without clocks or network. The emit half takes
// an injected spy logger — never a plugin context — so the flag-off tests
// prove silence (no alert route mutation) and the import test proves there is
// no live call path for an alert or mutation to travel.

const NOW = "2026-10-04T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function row(overrides: Partial<AdviseDecisionRow> & { id: string }): AdviseDecisionRow {
  return {
    capacityMode: "shadow",
    decidedAt: iso(NOW_MS - 60 * MIN),
    ...overrides,
  };
}

function spyLogger(): UnenforcedDecisionLogger & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    info(message: string, fields?: Record<string, unknown>): void {
      calls.push([message, fields]);
    },
  };
}

describe("unenforced-decision: stale vs fresh vs compared", () => {
  it("flags 2+ synthetic stale decisions with age + lane carried through", () => {
    const proposals = detectUnenforcedDecisions(
      [
        row({
          id: "dec-stale-a",
          decidedAt: iso(NOW_MS - 30 * MIN),
          lane: "sub-a",
          laneLabel: "label-a",
          modelId: "cheap-a",
        }),
        row({
          id: "dec-stale-b",
          decidedAt: iso(NOW_MS - 90 * MIN),
          lane: "sub-b",
          laneLabel: "label-b",
          modelId: "mid-b",
        }),
      ],
      { now: NOW },
    );
    expect(proposals).toHaveLength(2);
    expect(proposals[0]).toEqual({
      decisionId: "dec-stale-a",
      ageMs: 30 * MIN,
      lane: "sub-a",
      laneLabel: "label-a",
      modelId: "cheap-a",
      detectedAt: NOW,
    });
    expect(proposals[1]).toMatchObject({
      decisionId: "dec-stale-b",
      ageMs: 90 * MIN,
      lane: "sub-b",
    });
  });

  it("ignores fresh advise decisions inside the shadow window", () => {
    const proposals = detectUnenforcedDecisions(
      [
        row({ id: "dec-fresh", decidedAt: iso(NOW_MS - 1 * MIN) }),
        row({ id: "dec-fresh-edge", decidedAt: iso(NOW_MS - (5 * MIN - 1)) }),
      ],
      { now: NOW },
    );
    expect(proposals).toHaveLength(0);
  });

  it("never flags a decision that already reached enforce comparison", () => {
    const proposals = detectUnenforcedDecisions(
      [
        row({ id: "dec-compared", decidedAt: iso(NOW_MS - 180 * MIN), comparedToEnforce: true }),
      ],
      { now: NOW },
    );
    expect(proposals).toHaveLength(0);
  });

  it("never flags non-shadow rows no matter how old", () => {
    for (const capacityMode of ["enforce", "off", "unknown", ""]) {
      const proposals = detectUnenforcedDecisions(
        [row({ id: `dec-${capacityMode || "empty"}`, capacityMode, decidedAt: iso(NOW_MS - 180 * MIN) })],
        { now: NOW },
      );
      expect(proposals, capacityMode).toHaveLength(0);
    }
  });

  it("proposes at exactly the threshold and honors a custom one", () => {
    const at = detectUnenforcedDecisions(
      [row({ id: "dec-at", decidedAt: iso(NOW_MS - 5 * MIN) })],
      { now: NOW },
    );
    expect(at).toHaveLength(1);

    const custom = detectUnenforcedDecisions(
      [row({ id: "dec-custom", decidedAt: iso(NOW_MS - 10 * MIN) })],
      { now: NOW, staleAfterMs: 5 * MIN },
    );
    expect(custom).toHaveLength(1);
    expect(
      detectUnenforcedDecisions([row({ id: "dec-custom", decidedAt: iso(NOW_MS - 10 * MIN) })], {
        now: NOW,
        staleAfterMs: 15 * MIN,
      }),
    ).toHaveLength(0);
  });

  it("skips rows with no usable timestamp, future decisions, or no id", () => {
    const proposals = detectUnenforcedDecisions(
      [
        row({ id: "dec-bad-time", decidedAt: "not-a-time" }),
        row({ id: "dec-future", decidedAt: iso(NOW_MS + 5 * MIN) }),
        { capacityMode: "shadow", decidedAt: iso(NOW_MS - 60 * MIN) } as AdviseDecisionRow,
      ],
      { now: NOW },
    );
    expect(proposals).toHaveLength(0);
  });

  it("proposes nothing on a bad threshold or bad now", () => {
    const stale = [row({ id: "dec-x", decidedAt: iso(NOW_MS - 90 * MIN) })];
    expect(detectUnenforcedDecisions(stale, { now: NOW, staleAfterMs: 0 })).toHaveLength(0);
    expect(detectUnenforcedDecisions(stale, { now: NOW, staleAfterMs: -1 })).toHaveLength(0);
    expect(detectUnenforcedDecisions(stale, { now: "not-a-time" })).toHaveLength(0);
  });

  it("defaults to the 5-minute shadow-window horizon", () => {
    expect(UNENFORCED_DECISION_DEFAULT_AFTER_MS).toBe(5 * 60 * 1_000);
  });

  it("carries unknown lane fields as null, never as undefined", () => {
    const proposals = detectUnenforcedDecisions(
      [row({ id: "dec-bare", decidedAt: iso(NOW_MS - 30 * MIN) })],
      { now: NOW },
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ lane: null, laneLabel: null, modelId: null });
  });

  it("is pure: repeated calls agree and the input rows are untouched", () => {
    const input = [
      row({ id: "dec-a", decidedAt: iso(NOW_MS - 60 * MIN) }),
      row({ id: "dec-b", decidedAt: iso(NOW_MS - 2 * MIN) }),
    ];
    const frozen = structuredClone(input);
    const first = detectUnenforcedDecisions(input, { now: NOW });
    const second = detectUnenforcedDecisions(input, { now: NOW });
    expect(second).toEqual(first);
    expect(first).toHaveLength(1);
    expect(input).toEqual(frozen);
  });
});

describe("unenforced-decision: proposals only, flag-gated emit, no alert mutation", () => {
  const stale = () =>
    detectUnenforcedDecisions([row({ id: "dec-s", decidedAt: iso(NOW_MS - 60 * MIN) })], {
      now: NOW,
    });

  it("flag absent (default off) never calls the logger", () => {
    const logger = spyLogger();
    expect(emitUnenforcedDecisions(logger, stale())).toBe(false);
    expect(logger.calls).toHaveLength(0);
  });

  it("flag explicitly off never calls the logger", () => {
    const logger = spyLogger();
    expect(emitUnenforcedDecisions(logger, stale(), { enabled: false })).toBe(false);
    expect(logger.calls).toHaveLength(0);
  });

  it("flag on emits exactly one log line carrying age + lane rows", () => {
    const logger = spyLogger();
    expect(emitUnenforcedDecisions(logger, stale(), { enabled: true })).toBe(true);
    expect(logger.calls).toHaveLength(1);
    const [message, fields] = logger.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain("1 advise decision(s)");
    expect(message).toContain("propose-only");
    expect(fields).toEqual({ proposals: stale() });
  });

  it("flag on with no proposals stays silent", () => {
    const logger = spyLogger();
    expect(emitUnenforcedDecisions(logger, [], { enabled: true })).toBe(false);
    expect(logger.calls).toHaveLength(0);
  });

  it("a throwing logger reads as not emitted, never as a throw", () => {
    const logger: UnenforcedDecisionLogger = {
      info(): void {
        throw new Error("log sink down");
      },
    };
    expect(() => emitUnenforcedDecisions(logger, stale(), { enabled: true })).not.toThrow();
    expect(emitUnenforcedDecisions(logger, stale(), { enabled: true })).toBe(false);
  });
});

describe("unenforced-decision: no live call path", () => {
  it("the detector module imports no live plugin surface", () => {
    // Detection is pure data in, proposal records out; the emit takes an
    // injected logger. If this module ever gains an import reaching the
    // worker, config, plugin SDK, or any state/db/http/capacity/alert surface,
    // a live call path exists and this test must fail. Only import lines are
    // inspected, so the doc comment may name the forbidden surfaces without
    // tripping the guard.
    const source = readFileSync(
      path.join(path.resolve(import.meta.dirname, ".."), "src", "unenforced-decision.ts"),
      "utf8",
    );
    const imports = source
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import"))
      .join("\n");
    expect(imports).not.toMatch(/worker|config|plugin-sdk|capacity|inference|health|telemetry|fidelity/i);
    expect(imports).not.toMatch(/state|db|http|secrets|action|job|route|alert/i);
    // The suite's only sink is the injected spy: flag-off silence above is
    // silence of the only sink the verb can reach.
    expect(source).toContain("options?.enabled !== true");
  });
});
