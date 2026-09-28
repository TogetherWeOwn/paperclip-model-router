/**
 * TOG-7894 (gap G9): `docs/OPERATIONS.md:76` states failed refreshes preserve
 * the last valid capacity-evidence snapshot but replace pace verdicts with only
 * the current attempt's results — pinned only by docs.
 *
 * `src/worker.ts` implements this in `refreshCapacity`: the failed branch
 * spreads `...previous` (snapshots/evidence/`refreshedAt` stay old) while
 * OVERWRITING `paceVerdicts`/`paceRefreshedAt`/`laneDown` from the current
 * attempt. Each test below fails on a plausible regression for a reason that
 * names the property it pins:
 *
 * - full failure: both lanes 503 on the second refresh. Merging old pace
 *   (`{...previous.paceVerdicts, ...result.paceVerdicts}`) or re-storing the
 *   old evidence timestamp keeps the stale behind verdict steering; this test
 *   asserts evidence is byte-identical to the first refresh, pace is `{}`, and
 *   the next invoke serves the static winner (no stale steering).
 * - partial failure: one lane 503s while the other returns FRESH verdicts with
 *   DIFFERENT numbers (legacy 0.5, weekly 0.85 vs first-refresh 0.2/0.95).
 *   Updating stored evidence from the partial attempt, or merging the failed
 *   lane's old verdict, turns this red: stored evidence must still read 0.2
 *   (old-but-valid) while stored pace carries only the fresh ahead verdict.
 */
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { ACTION_KEYS, STATE_KEYS } from "../src/constants.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { readFixture } from "./helpers.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";

function success() {
  return new Response(JSON.stringify({
    id: "chatcmpl-1", object: "chat.completion", model: "echo",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

const PACE_WINDOWS = [{
  name: "weekly",
  role: "allowance",
  utilizationFields: ["weekly_utilization"],
  resetFields: ["weekly_resets_at"],
  defaultWindowSeconds: 604800,
}];

/**
 * One record satisfying BOTH normalizers: `legacy_used` feeds the legacy
 * capacity evidence windows, while the `weekly_*` fields feed the pace
 * definition. This is what makes the first refresh store valid evidence AND
 * pace together — the combination no existing test pins.
 */
function laneDocument(legacyUsed: number, weeklyUtilization: number, resetDays: number) {
  const observedAt = new Date();
  return {
    schemaVersion: 1,
    observedAt: observedAt.toISOString(),
    staleAfterSeconds: 300,
    records: [{
      health: "healthy",
      legacy_used: legacyUsed,
      governing_window: "weekly",
      window_seconds: { weekly: 604800 },
      weekly_utilization: weeklyUtilization,
      weekly_resets_at: new Date(observedAt.getTime() + resetDays * 24 * 60 * 60 * 1_000).toISOString(),
    }],
  };
}

function laneResponse(legacyUsed: number, weeklyUtilization: number, resetDays: number) {
  return new Response(JSON.stringify(laneDocument(legacyUsed, weeklyUtilization, resetDays)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function workerWithPaceLanes(fetchImpl: (url: string) => Promise<Response>) {
  const config = readFixture("company-a") as Record<string, unknown>;
  (config.routing as { stickyModelWithinIssue: boolean }).stickyModelWithinIssue = false;
  const expensive = (config.models as Array<{ id: string; tier: string }>).find((model) => model.id === "claude-sonnet-5");
  if (!expensive) throw new Error("missing expensive test model");
  // Same-tier so the tier ceiling admits both: without pace the cheaper
  // minimax-m2.5 wins on cost, with pace the behind claude-sonnet-5 wins.
  expensive.tier = "standard";
  config.capacityRouting = {
    enabled: true,
    mode: "enforce",
    unknownTelemetry: "fail-open",
    paceOrdering: true,
    maxSnapshotAgeMs: 300_000,
    sources: [
      {
        id: "expensive-behind",
        statusUrl: "https://capacity.example/behind",
        modelIds: ["claude-sonnet-5"],
        healthFields: ["health"],
        requestTimeoutMs: 5000,
        maxResponseBytes: 262144,
        windows: [{ name: "legacy", utilizationFields: ["legacy_used"], resetFields: [] }],
        pace: { laneId: "expensive-behind", healthFields: ["health"], windows: PACE_WINDOWS },
      },
      {
        id: "cheap-ahead",
        statusUrl: "https://capacity.example/ahead",
        modelIds: ["minimax-m2.5"],
        healthFields: ["health"],
        requestTimeoutMs: 5000,
        maxResponseBytes: 262144,
        windows: [{ name: "legacy", utilizationFields: ["legacy_used"], resetFields: [] }],
        pace: { laneId: "cheap-ahead", healthFields: ["health"], windows: PACE_WINDOWS },
      },
    ],
  };
  const harness = createTestHarness({ manifest, config: {} });
  harness.ctx.config = { async get() { return structuredClone(config); } };
  harness.ctx.secrets = { async resolve() { return "resolved-secret"; } };
  harness.ctx.http = {
    async fetch(url) {
      if (String(url).includes("capacity.example")) return fetchImpl(String(url));
      return success();
    },
  };
  const { definition } = createPlugin();
  await definition.setup(harness.ctx);
  return harness;
}

const invocation = {
  task: { taskClass: "implementation", issueId: "issue-1" },
  messages: [{ role: "user", content: "hello" }],
  maxOutputTokens: 100,
};

type RefreshResult = {
  error: string | null;
  paceVerdicts: Record<string, { state: string; score?: { utilization: number } | null }>;
};

function storedSnapshot(harness: Awaited<ReturnType<typeof workerWithPaceLanes>>) {
  return harness.getState({
    scopeKind: "company",
    scopeId: COMPANY,
    stateKey: STATE_KEYS.capacitySnapshot,
  }) as {
    evidence: Array<{ utilization: number }>;
    refreshedAt: string;
    paceRefreshedAt: string;
    paceVerdicts: Record<string, { state: string; score?: { utilization: number } | null }>;
    lastRefreshError: string | null;
    lastRefreshAttemptAt?: string;
  };
}

describe("TOG-7894: failed refresh preserves evidence but replaces pace verdicts", () => {
  it("full failure keeps last-valid evidence, drops stale pace, and never stale-steers", async () => {
    let fail = false;
    const harness = await workerWithPaceLanes(async (url) => {
      if (fail) return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
      return url.endsWith("/behind") ? laneResponse(0.2, 0.1, 1) : laneResponse(0.2, 0.95, 3);
    });

    const first = await harness.performAction(ACTION_KEYS.refreshCapacity, {}, { companyId: COMPANY }) as unknown as RefreshResult;
    expect(first.error).toBeNull();
    expect(first.paceVerdicts["expensive-behind"]?.state).toMatch(/^behind/);
    expect(first.paceVerdicts["cheap-ahead"]?.state).toBe("ahead");
    const valid = storedSnapshot(harness);
    expect(valid.evidence).toHaveLength(2);
    expect(valid.evidence.every((entry) => entry.utilization === 0.2)).toBe(true);
    expect(valid.lastRefreshError).toBeNull();

    // The pace steering proof: behind (expensive) outranks ahead (cheap).
    const paced = await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY }) as { decision: { modelId: string } };
    expect(paced.decision.modelId).toBe("claude-sonnet-5");

    fail = true;
    const second = await harness.performAction(ACTION_KEYS.refreshCapacity, {}, { companyId: COMPANY }) as unknown as RefreshResult;
    expect(second.error).toContain("capacity-http-failed");
    expect(second.paceVerdicts).toEqual({});

    const failed = storedSnapshot(harness);
    // Old-but-valid: the snapshot (evidence + timestamp) is byte-identical to
    // the first refresh. Re-storing partial/empty evidence turns this red.
    expect(failed.evidence).toEqual(valid.evidence);
    expect(failed.refreshedAt).toBe(valid.refreshedAt);
    expect(failed.lastRefreshError).toContain("capacity-http-failed");
    expect(failed.lastRefreshAttemptAt).toEqual(expect.any(String));
    // Current-or-absent: pace is the current attempt's empty result, stamped
    // fresh — never the stale behind/ahead pair. Merging old verdicts, or
    // failing to advance paceRefreshedAt, turns this red.
    expect(failed.paceVerdicts).toEqual({});
    expect(Date.parse(failed.paceRefreshedAt)).toBeGreaterThanOrEqual(Date.parse(valid.paceRefreshedAt));

    // Never stale-steering: with pace absent the next invoke falls back to the
    // static winner instead of serving the stale behind verdict.
    const served = await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY }) as {
      decision: { modelId: string; candidates: Array<{ modelId: string; paceState: string }> };
    };
    expect(served.decision.modelId).toBe("minimax-m2.5");
    for (const candidate of served.decision.candidates) {
      expect(candidate.paceState, `${candidate.modelId} must not carry stale pace`).toBe("unknown");
    }
  });

  it("partial failure preserves evidence and replaces pace with only the current attempt", async () => {
    let mode: "first" | "partial" = "first";
    const harness = await workerWithPaceLanes(async (url) => {
      if (mode === "first") return url.endsWith("/behind") ? laneResponse(0.2, 0.1, 1) : laneResponse(0.2, 0.95, 3);
      if (url.endsWith("/behind")) return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
      // Fresh numbers on the surviving lane: legacy 0.5 and weekly 0.85 prove
      // which attempt each half of the stored state came from.
      return laneResponse(0.5, 0.85, 3);
    });

    await harness.performAction(ACTION_KEYS.refreshCapacity, {}, { companyId: COMPANY });
    const valid = storedSnapshot(harness);
    expect(valid.evidence.every((entry) => entry.utilization === 0.2)).toBe(true);

    mode = "partial";
    const second = await harness.performAction(ACTION_KEYS.refreshCapacity, {}, { companyId: COMPANY }) as unknown as RefreshResult;
    expect(second.error).toContain("capacity-http-failed");
    // The current attempt's pace: only the surviving lane, with its NEW score.
    expect(Object.keys(second.paceVerdicts)).toEqual(["cheap-ahead"]);
    expect(second.paceVerdicts["cheap-ahead"]?.state).toBe("ahead");

    const stored = storedSnapshot(harness);
    // Evidence is old-but-valid: the surviving lane's fresh 0.5 must NOT leak
    // into the stored snapshot. Updating evidence from a failed (partial)
    // attempt turns this red.
    expect(stored.evidence).toEqual(valid.evidence);
    expect(stored.evidence.every((entry) => entry.utilization === 0.2)).toBe(true);
    expect(stored.refreshedAt).toBe(valid.refreshedAt);
    // Pace is current: the surviving lane's verdict carries the NEW
    // utilization, and the failed lane's stale behind verdict is gone. Merging
    // (`{...previous, ...current}`) turns both assertions red.
    expect(Object.keys(stored.paceVerdicts)).toEqual(["cheap-ahead"]);
    expect(stored.paceVerdicts["cheap-ahead"]?.state).toBe("ahead");
    expect(stored.paceVerdicts["cheap-ahead"]?.score?.utilization).toBeCloseTo(0.85, 3);
    expect(stored.lastRefreshError).toContain("capacity-http-failed");

    // The failed lane steers as unknown (fail-neutral), never with its stale
    // behind verdict; the surviving lane's current ahead verdict is live.
    const served = await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY }) as {
      decision: { modelId: string; candidates: Array<{ modelId: string; paceState: string }> };
    };
    expect(served.decision.modelId).toBe("minimax-m2.5");
    const byId = Object.fromEntries(served.decision.candidates.map((entry) => [entry.modelId, entry.paceState]));
    expect(byId["minimax-m2.5"]).toBe("ahead");
    expect(byId["claude-sonnet-5"], "failed lane must not reuse its stale behind verdict").toBe("unknown");
  });
});
