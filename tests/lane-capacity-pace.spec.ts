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
  it("reproduces the frozen Claude and codex weighted pace values", () => {
    const claude = evaluateLanePace({
      observation: normalizeLaneDocument({ document: fixture("claude"), definition: CLAUDE }),
      asOf: OBSERVED_AT,
    });
    const codex = evaluateLanePace({
      observation: normalizeLaneDocument({ document: fixture("codex"), definition: CODEX }),
      asOf: OBSERVED_AT,
    });

    expect(claude.score).toEqual({ utilization: 0.673, elapsed: 0.803, deviation: -0.13 });
    expect(claude.state).toBe("behind");
    expect(codex.score).toEqual({ utilization: 0.715, elapsed: 0.178, deviation: 0.537 });
    expect(codex.state).toBe("ahead");
  });

  it("uses a weighted mean rather than max aggregation", () => {
    const verdict = evaluateLanePace({
      observation: normalizeLaneDocument({ document: fixture("claude"), definition: CLAUDE }),
      asOf: OBSERVED_AT,
    });
    expect(verdict.score?.utilization).toBe(0.673);
    expect(verdict.score?.utilization).not.toBe(1);
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

  it("hard-stops the lane when one account's serviceability window trips", () => {
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
    expect(verdict.serviceable).toBe(false);
    expect(verdict.serviceableAccountCount).toBe(1);
    expect(verdict.state).toBe("exhausted");
    expect(verdict.reason).toBe("serviceability-window-exhausted");
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
