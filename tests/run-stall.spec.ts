import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  detectRunStalls,
  emitRunStallProposals,
  RUN_STALL_DEFAULT_AFTER_MS,
  type RunStallLogger,
  type RunStallRow,
} from "../src/run-stall.js";

// Propose-only run-stall detector: runs stuck `in_progress` with no
// heartbeat beyond N minutes yield proposal records only.
//
// Fixture mechanics: synthetic run snapshots (snapshots, not live rows) with
// fixed ISO timestamps around a fixed `now`, so the stalled / active /
// finished boundary is pinned without clocks or network. The emit half takes
// an injected spy logger — never a plugin context — so the flag-off tests
// prove silence and the import test proves there is no live call path for a
// retry or mutation to travel.

const NOW = "2026-10-03T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function row(overrides: Partial<RunStallRow> & { id: string }): RunStallRow {
  return {
    status: "in_progress",
    createdAt: iso(NOW_MS - 60 * MIN),
    lastHeartbeatAt: iso(NOW_MS - 60 * MIN),
    ...overrides,
  };
}

function spyLogger(): RunStallLogger & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    info(message: string, fields?: Record<string, unknown>): void {
      calls.push([message, fields]);
    },
  };
}

describe("run-stall: stalled vs active vs finished", () => {
  it("flags a run silent past the threshold with routing fields carried through", () => {
    const proposals = detectRunStalls(
      [
        row({
          id: "run-stalled",
          agentId: "agent-a",
          issueId: "issue-1",
          lastHeartbeatAt: iso(NOW_MS - 45 * MIN),
        }),
      ],
      { now: NOW },
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toEqual({
      runId: "run-stalled",
      agentId: "agent-a",
      issueId: "issue-1",
      stalledForMs: 45 * MIN,
      lastHeartbeatAt: iso(NOW_MS - 45 * MIN),
      detectedAt: NOW,
    });
  });

  it("stays silent for an active run with a recent heartbeat", () => {
    const proposals = detectRunStalls(
      [row({ id: "run-active", lastHeartbeatAt: iso(NOW_MS - 5 * MIN) })],
      { now: NOW },
    );
    expect(proposals).toHaveLength(0);
  });

  it("never flags a recently finished run no matter how old its last beat", () => {
    for (const status of ["completed", "failed", "cancelled", "queued", "waiting"]) {
      const proposals = detectRunStalls(
        [
          row({
            id: `run-${status}`,
            status,
            lastHeartbeatAt: iso(NOW_MS - 180 * MIN),
            createdAt: iso(NOW_MS - 240 * MIN),
          }),
        ],
        { now: NOW },
      );
      expect(proposals, status).toHaveLength(0);
    }
  });

  it("falls back to createdAt for a run that never beat", () => {
    const old = detectRunStalls(
      [row({ id: "run-never-beat", createdAt: iso(NOW_MS - 60 * MIN), lastHeartbeatAt: null })],
      { now: NOW },
    );
    expect(old).toHaveLength(1);
    expect(old[0]).toMatchObject({ runId: "run-never-beat", lastHeartbeatAt: null });

    const young = detectRunStalls(
      [row({ id: "run-young", createdAt: iso(NOW_MS - 5 * MIN), lastHeartbeatAt: null })],
      { now: NOW },
    );
    expect(young).toHaveLength(0);
  });

  it("proposes at exactly the threshold and honors a custom one", () => {
    const at = detectRunStalls([row({ id: "run-at", lastHeartbeatAt: iso(NOW_MS - 30 * MIN) })], {
      now: NOW,
    });
    expect(at).toHaveLength(1);

    const custom = detectRunStalls(
      [row({ id: "run-custom", lastHeartbeatAt: iso(NOW_MS - 10 * MIN) })],
      { now: NOW, stallAfterMs: 5 * MIN },
    );
    expect(custom).toHaveLength(1);
    expect(
      detectRunStalls([row({ id: "run-custom", lastHeartbeatAt: iso(NOW_MS - 10 * MIN) })], {
        now: NOW,
        stallAfterMs: 15 * MIN,
      }),
    ).toHaveLength(0);
  });

  it("skips rows with no usable timestamp, future beats, or no id", () => {
    const proposals = detectRunStalls(
      [
        row({ id: "run-bad-beat", lastHeartbeatAt: "not-a-time", createdAt: "also-bad" }),
        row({ id: "run-future", lastHeartbeatAt: iso(NOW_MS + 5 * MIN) }),
        { status: "in_progress", createdAt: iso(NOW_MS - 60 * MIN) } as RunStallRow,
      ],
      { now: NOW },
    );
    expect(proposals).toHaveLength(0);
  });

  it("proposes nothing on a bad threshold or bad now", () => {
    const stalled = [row({ id: "run-x", lastHeartbeatAt: iso(NOW_MS - 90 * MIN) })];
    expect(detectRunStalls(stalled, { now: NOW, stallAfterMs: 0 })).toHaveLength(0);
    expect(detectRunStalls(stalled, { now: NOW, stallAfterMs: -1 })).toHaveLength(0);
    expect(detectRunStalls(stalled, { now: "not-a-time" })).toHaveLength(0);
  });

  it("defaults to a 30-minute threshold", () => {
    expect(RUN_STALL_DEFAULT_AFTER_MS).toBe(30 * 60 * 1_000);
  });

  it("is pure: repeated calls agree and the input rows are untouched", () => {
    const input = [
      row({ id: "run-a", lastHeartbeatAt: iso(NOW_MS - 60 * MIN) }),
      row({ id: "run-b", lastHeartbeatAt: iso(NOW_MS - 2 * MIN) }),
    ];
    const frozen = structuredClone(input);
    const first = detectRunStalls(input, { now: NOW });
    const second = detectRunStalls(input, { now: NOW });
    expect(second).toEqual(first);
    expect(first).toHaveLength(1);
    expect(input).toEqual(frozen);
  });
});

describe("run-stall: proposals only, flag-gated emit", () => {
  const stalled = () =>
    detectRunStalls([row({ id: "run-s", lastHeartbeatAt: iso(NOW_MS - 60 * MIN) })], { now: NOW });

  it("flag absent (default off) never calls the logger", () => {
    const logger = spyLogger();
    expect(emitRunStallProposals(logger, stalled())).toBe(false);
    expect(logger.calls).toHaveLength(0);
  });

  it("flag explicitly off never calls the logger", () => {
    const logger = spyLogger();
    expect(emitRunStallProposals(logger, stalled(), { enabled: false })).toBe(false);
    expect(logger.calls).toHaveLength(0);
  });

  it("flag on emits exactly one log line carrying the proposals", () => {
    const logger = spyLogger();
    expect(emitRunStallProposals(logger, stalled(), { enabled: true })).toBe(true);
    expect(logger.calls).toHaveLength(1);
    const [message, fields] = logger.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain("1 run(s) stalled");
    expect(message).toContain("propose-only");
    expect(fields).toEqual({ proposals: stalled() });
  });

  it("flag on with no proposals stays silent", () => {
    const logger = spyLogger();
    expect(emitRunStallProposals(logger, [], { enabled: true })).toBe(false);
    expect(logger.calls).toHaveLength(0);
  });

  it("a throwing logger reads as not emitted, never as a throw", () => {
    const logger: RunStallLogger = {
      info(): void {
        throw new Error("log sink down");
      },
    };
    expect(() => emitRunStallProposals(logger, stalled(), { enabled: true })).not.toThrow();
    expect(emitRunStallProposals(logger, stalled(), { enabled: true })).toBe(false);
  });
});

describe("run-stall: no live call path", () => {
  it("the detector module imports no live plugin surface", () => {
    // Detection is pure data in, proposal records out; the emit takes an
    // injected logger. If this module ever gains an import reaching the
    // worker, config, plugin SDK, or any state/db/http/capacity surface, a
    // live call path exists and this test must fail. Only import lines are
    // inspected, so the doc comment may name the forbidden surfaces without
    // tripping the guard.
    const source = readFileSync(
      path.join(path.resolve(import.meta.dirname, ".."), "src", "run-stall.ts"),
      "utf8",
    );
    const imports = source
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import"))
      .join("\n");
    expect(imports).not.toMatch(/worker|config|plugin-sdk|capacity|inference|health|telemetry|fidelity/i);
    expect(imports).not.toMatch(/state|db|http|secrets|action|job|route/i);
    // The suite's only sink is the injected spy: flag-off silence above is
    // silence of the only sink the verb can reach.
    expect(source).toContain("options?.enabled !== true");
  });
});
