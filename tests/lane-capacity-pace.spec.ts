import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  evaluateLanePace,
  normalizeLaneDocument,
  type LanePaceDefinition,
} from "../packages/lane-capacity/src/pace.js";

const OBSERVED_AT = "2026-09-10T14:53:41.507882Z";

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../packages/lane-capacity/tests/data/tog2135/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

const CLAUDE: LanePaceDefinition = {
  laneId: "claude",
  healthFields: ["health"],
  windows: [
    { name: "five_hour", role: "serviceability", utilizationFields: ["five_hour_utilization"], resetFields: ["five_hour_resets_at"] },
    { name: "seven_day", role: "allowance", utilizationFields: ["seven_day_utilization"], resetFields: ["seven_day_resets_at"] },
  ],
};

const CODEX: LanePaceDefinition = {
  laneId: "codex",
  healthFields: ["health"],
  windows: [
    { name: "five_hour", role: "serviceability", utilizationFields: ["five_hour_utilization"], resetFields: ["five_hour_resets_at"], defaultWindowSeconds: 18_000 },
    { name: "weekly", role: "allowance", utilizationFields: ["weekly_utilization"], resetFields: ["weekly_resets_at"] },
  ],
};

describe("TOG-2135 pace model", () => {
  it("excludes unserviceable accounts from the Claude and codex pace values (TOG-2674)", () => {
    const claude = evaluateLanePace({
      observation: normalizeLaneDocument({ document: fixture("claude"), definition: CLAUDE }),
      asOf: OBSERVED_AT,
    });
    const codex = evaluateLanePace({
      observation: normalizeLaneDocument({ document: fixture("codex"), definition: CODEX }),
      asOf: OBSERVED_AT,
    });

    expect(claude.score).toEqual({ utilization: 0.51, elapsed: 0.833, deviation: -0.323, paceDebt: 0.323, clearRate: 0.017434556417542605 });
    expect(claude.state).toBe("behind");
    expect(codex.score).toEqual({ utilization: 0.43, elapsed: 0.135, deviation: 0.295, paceDebt: -0.295, clearRate: 0.003923139405204615 });
    expect(codex.state).toBe("ahead");
  });

  it("never lets a 1.00-utilization unserviceable account drag down a 0.02-serviceable one (TOG-2674)", () => {
    const verdict = evaluateLanePace({
      observation: normalizeLaneDocument({
        definition: CLAUDE,
        document: {
          observedAt: OBSERVED_AT,
          staleAfterSeconds: 300,
          records: [
            { health: "healthy", weight: 1, governing_window: "seven_day", window_seconds: { five_hour: 18000, seven_day: 604800 }, five_hour_utilization: 0.02, seven_day_utilization: 0.02, seven_day_resets_at: "2026-09-16T14:53:41.507882Z" },
            { health: "exhausted", weight: 1, governing_window: "seven_day", window_seconds: { five_hour: 18000, seven_day: 604800 }, five_hour_utilization: 1, seven_day_utilization: 1, seven_day_resets_at: "2026-09-16T14:53:41.507882Z" },
          ],
        },
      }),
      asOf: OBSERVED_AT,
    });
    expect(verdict.score?.utilization).toBe(0.02);
    expect(verdict.score?.utilization).not.toBe(0.51);
    expect(verdict.knownAccountCount).toBe(1);
  });

  it("uses a weighted mean rather than max aggregation", () => {
    // Both accounts are serviceable here (TOG-2674 fixed unserviceable ones
    // out of the frozen claude/codex fixtures, which now reduce to a single
    // account where weighted-mean and max happen to coincide — this fixture
    // keeps two live accounts with different weight/utilization so the two
    // aggregation strategies provably diverge).
    const verdict = evaluateLanePace({
      observation: normalizeLaneDocument({
        definition: CLAUDE,
        document: {
          observedAt: OBSERVED_AT,
          staleAfterSeconds: 300,
          records: [
            { health: "healthy", weight: 3, governing_window: "seven_day", window_seconds: { five_hour: 18000, seven_day: 604800 }, five_hour_utilization: 0.1, seven_day_utilization: 0.2, seven_day_resets_at: "2026-09-16T14:53:41.507882Z" },
            { health: "healthy", weight: 1, governing_window: "seven_day", window_seconds: { five_hour: 18000, seven_day: 604800 }, five_hour_utilization: 0.1, seven_day_utilization: 0.8, seven_day_resets_at: "2026-09-16T14:53:41.507882Z" },
          ],
        },
      }),
      asOf: OBSERVED_AT,
    });
    expect(verdict.score?.utilization).toBe(0.35);
    expect(verdict.score?.utilization).not.toBe(0.8);
  });

  it("weights a Max20x-style account according to its reported weight", () => {
    const definition: LanePaceDefinition = {
      laneId: "claude",
      healthFields: ["health"],
      windows: [
        { name: "seven_day", role: "allowance", utilizationFields: ["seven_day_utilization"], resetFields: ["seven_day_resets_at"] },
      ],
    };
    const verdict = evaluateLanePace({
      observation: normalizeLaneDocument({
        definition,
        document: {
          observedAt: OBSERVED_AT,
          staleAfterSeconds: 300,
          records: [
            { health: "healthy", weight: 20, governing_window: "seven_day", window_seconds: { seven_day: 604800 }, seven_day_utilization: 0.9, seven_day_resets_at: "2026-09-16T14:53:41.507882Z" },
            { health: "healthy", weight: 1, governing_window: "seven_day", window_seconds: { seven_day: 604800 }, seven_day_utilization: 0.1, seven_day_resets_at: "2026-09-16T14:53:41.507882Z" },
          ],
        },
      }),
      asOf: OBSERVED_AT,
    });
    expect(verdict.knownWeight).toBe(21);
    expect(verdict.score!.utilization).toBeGreaterThan(0.8);
  });

  it("keeps unknown fail-neutral instead of classifying it behind", () => {
    const verdict = evaluateLanePace({
      observation: normalizeLaneDocument({
        definition: CODEX,
        document: {
          observedAt: OBSERVED_AT,
          staleAfterSeconds: 300,
          records: [{ health: "healthy", weight: 1, governing_window: "weekly", window_seconds: { weekly: 604800 }, weekly_utilization: 0.1, weekly_resets_at: null }],
        },
      }),
      asOf: OBSERVED_AT,
    });
    expect(verdict.state).toBe("unknown");
    expect(verdict.serviceable).toBe(true);
  });

  it("does not let one five-hour-exhausted account stop a serviceable pool", () => {
    const verdict = evaluateLanePace({
      observation: normalizeLaneDocument({
        definition: CLAUDE,
        document: {
          observedAt: OBSERVED_AT,
          staleAfterSeconds: 300,
          records: [
            { health: "healthy", weight: 1, governing_window: "seven_day", window_seconds: { five_hour: 18000, seven_day: 604800 }, five_hour_utilization: 1, seven_day_utilization: 0.2, seven_day_resets_at: "2026-09-16T14:53:41.507882Z" },
            { health: "healthy", weight: 1, governing_window: "seven_day", window_seconds: { five_hour: 18000, seven_day: 604800 }, five_hour_utilization: 0.2, seven_day_utilization: 0.2, seven_day_resets_at: "2026-09-16T14:53:41.507882Z" },
          ],
        },
      }),
      asOf: OBSERVED_AT,
    });
    expect(verdict.serviceable).toBe(true);
    expect(verdict.serviceableAccountCount).toBe(1);
    expect(verdict.state).not.toBe("exhausted");
  });

  it("defaults an absent legacy weight to one, never zero", () => {
    const observation = normalizeLaneDocument({
      definition: CODEX,
      document: {
        observedAt: OBSERVED_AT,
        records: [
          { health: "healthy", governing_window: "weekly", window_seconds: { weekly: 604800 }, weekly_utilization: 0.2, weekly_resets_at: "2026-09-15T14:53:41.507882Z" },
          { health: "healthy", weight: 3, governing_window: "weekly", window_seconds: { weekly: 604800 }, weekly_utilization: 0.6, weekly_resets_at: "2026-09-15T14:53:41.507882Z" },
        ],
      },
    });
    const verdict = evaluateLanePace({ observation, asOf: OBSERVED_AT });
    expect(observation.accounts[0]).toMatchObject({ weight: 1, weightSource: "default" });
    expect(verdict.score?.utilization).toBe(0.5);
    expect(verdict.knownWeight).toBe(4);
  });

  it("chooses the longest valid allowance and falls back when it is uncomputable", () => {
    const definition: LanePaceDefinition = {
      laneId: "multi-window",
      healthFields: ["health"],
      windows: [
        { name: "weekly", role: "allowance", utilizationFields: ["weekly_utilization"], resetFields: ["weekly_resets_at"] },
        { name: "monthly", role: "allowance", utilizationFields: ["monthly_utilization"], resetFields: ["monthly_resets_at"] },
      ],
    };
    const monthly = normalizeLaneDocument({
      definition,
      document: { observedAt: OBSERVED_AT, records: [{ health: "healthy", weight: 1, window_seconds: { weekly: 604800, monthly: 2592000 }, weekly_utilization: 0.2, weekly_resets_at: "2026-09-16T00:00:00Z", monthly_utilization: 0.4, monthly_resets_at: "2026-10-01T00:00:00Z" }] },
    });
    const fallback = normalizeLaneDocument({
      definition,
      document: { observedAt: OBSERVED_AT, records: [{ health: "healthy", weight: 1, window_seconds: { weekly: 604800, monthly: 2592000 }, weekly_utilization: 0.2, weekly_resets_at: "2026-09-16T00:00:00Z", monthly_utilization: 0.4, monthly_resets_at: null }] },
    });
    expect(evaluateLanePace({ observation: monthly, asOf: OBSERVED_AT }).accounts[0]?.governingWindow).toBe("monthly");
    expect(evaluateLanePace({ observation: fallback, asOf: OBSERVED_AT }).accounts[0]?.governingWindow).toBe("weekly");
  });

  it("binds to the window with the smaller clear rate, not the longer or more-utilized one (Go monthly binding)", () => {
    const definition: LanePaceDefinition = {
      laneId: "go",
      healthFields: ["health"],
      windows: [
        { name: "weekly", role: "allowance", utilizationFields: ["weekly_utilization"], resetFields: ["weekly_resets_at"] },
        { name: "monthly", role: "allowance", utilizationFields: ["monthly_utilization"], resetFields: ["monthly_resets_at"] },
      ],
    };
    // Weekly has the HIGHER utilization (0.9) but resets in 6h, so its clear
    // rate is fast (0.1 remaining / 6h ≈ 0.0167/h). Monthly has LOWER
    // utilization (0.5) but is nowhere near reset, so its clear rate is slow
    // (0.5 remaining / 720h ≈ 0.0007/h) — monthly is the true bottleneck.
    const observation = normalizeLaneDocument({
      definition,
      document: {
        observedAt: OBSERVED_AT,
        staleAfterSeconds: 300,
        records: [{
          health: "healthy", weight: 1,
          window_seconds: { weekly: 604800, monthly: 2592000 },
          weekly_utilization: 0.9, weekly_resets_at: "2026-09-10T20:53:41.507882Z",
          monthly_utilization: 0.5, monthly_resets_at: "2026-10-10T14:53:41.507882Z",
        }],
      },
    });
    const verdict = evaluateLanePace({ observation, asOf: OBSERVED_AT });
    expect(verdict.accounts[0]?.governingWindow).toBe("monthly");
    expect(verdict.score?.utilization).toBe(0.5);
  });

  it("marks stale telemetry unknown, never behind", () => {
    const verdict = evaluateLanePace({
      observation: normalizeLaneDocument({ document: fixture("claude"), definition: CLAUDE }),
      asOf: "2026-09-10T15:00:00Z",
    });
    expect(verdict).toMatchObject({ state: "unknown", serviceable: null, reason: "snapshot-stale" });
  });

  it("marks urgency only inside the configured reset threshold", () => {
    const observation = normalizeLaneDocument({
      definition: CODEX,
      document: { observedAt: OBSERVED_AT, records: [{ health: "healthy", weight: 1, governing_window: "weekly", window_seconds: { weekly: 604800 }, weekly_utilization: 0.1, weekly_resets_at: "2026-09-11T02:53:41.507882Z" }] },
    });
    expect(evaluateLanePace({ observation, asOf: OBSERVED_AT }).state).toBe("behind-urgent");
  });
});
