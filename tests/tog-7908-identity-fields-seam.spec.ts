/**
 * TOG-7908 (gap G10, TOG-7846 rev 2): `modelIdentityFields` fail-neutral
 * fallback at the worker seam.
 *
 * TOG-7163's grouped-quota projection (`modelIdentityFields: ["model"]`
 * steering each quota group onto exactly the model it names) is unit-tested in
 * lane-capacity (tests/tog-7163-antigravity-projection.spec.ts), but nothing
 * pins the path the worker actually serves: raw stored config through
 * `resolveConfig` (the worker's `companyConfig`), into `refreshCapacity`, out
 * as stored evidence, and into the next `invoke` selection. A resolver that
 * threw on malformed fields, dropped valid ones, or silently lost the key
 * would pass every unit test and mis-route live traffic.
 *
 * The fixture is deliberately SYMMETRIC: both quota groups are healthy at the
 * same utilization (0.5). Projection (2 evidence rows, one per model) and
 * legacy fan-out (4 rows, every record informing every model) therefore select
 * the same winner — which is exactly the acceptance: a reviewer removing the
 * fields must see routing fall back to fan-out with identical selections.
 * Row counts, not selections, discriminate the two paths; selections pin the
 * fallback is genuinely serving (telemetry available, evidence-backed) rather
 * than refusing or degrading to the static policy.
 *
 * Each test fails on a plausible regression for the reason named:
 * - projection: a resolver that drops the key, or a first-group-wins
 *   projection regression, yields 4 fan-out rows instead of 2.
 * - removal: fail-closed handling of absent fields (refresh error,
 *   no-eligible-model) or any selection divergence turns this red.
 * - malformed: a resolver that throws on junk (string/number/null/object or
 *   all-junk arrays) rejects the refresh action instead of fanning out.
 * - mixed valid+junk: all-or-nothing validation of the array drops the valid
 *   "model" entry and fans out (4 rows instead of 2).
 */
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { ACTION_KEYS } from "../src/constants.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { readFixture } from "./helpers.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ABSENT = Symbol("modelIdentityFields-absent");

function success() {
  return new Response(JSON.stringify({
    id: "chatcmpl-1", object: "chat.completion", model: "echo",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * One record carrying two per-model quota groups, both healthy at the same
 * headroom (remaining 0.5 -> utilization 0.5). Symmetric on purpose: see the
 * header comment for why projection and fan-out must agree here.
 */
function groupedPayload() {
  const reset = "2026-10-06T22:00:00.000Z";
  const group = (model: string) => ({
    model,
    "five-hour": { remainingFraction: 0.5, resetAt: reset },
    weekly: { remainingFraction: 0.5, resetAt: reset },
  });
  return {
    provider: "acme",
    status: "active",
    quota_groups: [group("g10-cheap"), group("g10-expensive")],
  };
}

const MODELS = ["g10-cheap", "g10-expensive"];

function baseConfig(identityFields: unknown) {
  const config = readFixture("company-a") as Record<string, unknown>;
  (config.routing as { stickyModelWithinIssue: boolean }).stickyModelWithinIssue = false;
  // Same tier and quality so the static baseline ranks by cost: g10-cheap wins
  // unless capacity evidence says otherwise.
  config.models = MODELS.map((id, index) => ({
    id,
    tier: "standard",
    quality: 80,
    costPerMTokIn: index === 0 ? 1 : 5,
    costPerMTokOut: index === 0 ? 1 : 5,
    contextWindow: 200_000,
    enabled: true,
  }));
  config.taskClasses = [{ key: "implementation", qualityFloor: 60 }];
  const source: Record<string, unknown> = {
    id: "grouped-quota",
    statusUrl: "https://capacity.example.test/quota",
    modelIds: [...MODELS],
    healthFields: ["status"],
    requestTimeoutMs: 5000,
    maxResponseBytes: 262144,
    windows: [
      { name: "five-hour", utilizationFields: ["five-hour"], resetFields: ["resetAt", "reset_at"] },
      { name: "weekly", utilizationFields: ["weekly"], resetFields: ["resetAt", "reset_at"] },
    ],
  };
  // ABSENT mirrors the reviewer acceptance verbatim: the key is gone, not null.
  if (identityFields !== ABSENT) source.modelIdentityFields = identityFields;
  config.capacityRouting = {
    enabled: true,
    mode: "enforce",
    unknownTelemetry: "fail-open",
    maxSnapshotAgeMs: 300_000,
    sources: [source],
  };
  return config;
}

async function workerWith(identityFields: unknown = ABSENT) {
  const config = baseConfig(identityFields);
  const harness = createTestHarness({ manifest, config: {} });
  harness.ctx.config = { async get() { return structuredClone(config); } };
  harness.ctx.secrets = { async resolve() { return "resolved-secret"; } };
  harness.ctx.http = {
    async fetch(url) {
      if (String(url).includes("capacity.example.test")) {
        return new Response(JSON.stringify(groupedPayload()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
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
  evidence: Array<{
    modelId: string;
    laneLabel: string;
    utilization: number | null;
    health: string;
    posture: string;
    telemetryAvailable: boolean;
  }>;
};

// `ACTION_KEYS.invoke` returns the full InferenceResult: `outcome` is the serve
// outcome ("completed"), while the routing selection lives on `decision`.
type InvokeResult = {
  outcome: string;
  decision: {
    outcome: string;
    modelId: string;
    capacity: { telemetry: string; selectedSource: string | null; usagePosture: string };
  };
};

async function refresh(harness: Awaited<ReturnType<typeof workerWith>>) {
  return harness.performAction(ACTION_KEYS.refreshCapacity, {}, { companyId: COMPANY }) as Promise<RefreshResult>;
}

async function invoke(harness: Awaited<ReturnType<typeof workerWith>>) {
  return harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY }) as Promise<InvokeResult>;
}

describe("TOG-7908: modelIdentityFields at the worker seam", () => {
  it("projects each grouped-quota group onto exactly the model it names", async () => {
    const harness = await workerWith(["model"]);
    const result = await refresh(harness);

    expect(result.error).toBeNull();
    // Two collection records, each carrying exactly its own model's row. A
    // resolver that drops the key, or a first-group-wins projection
    // regression, fans out to 4 rows instead.
    expect(result.evidence).toHaveLength(2);
    const byModel = new Map(result.evidence.map((entry) => [entry.modelId, entry]));
    expect(byModel.get("g10-cheap")).toMatchObject({
      laneLabel: "record-1", utilization: 0.5, health: "healthy", telemetryAvailable: true,
    });
    expect(byModel.get("g10-expensive")).toMatchObject({
      laneLabel: "record-2", utilization: 0.5, health: "healthy", telemetryAvailable: true,
    });

    const served = await invoke(harness);
    expect(served.outcome).toBe("completed");
    expect(served.decision.outcome).toBe("selected");
    expect(served.decision.modelId).toBe("g10-cheap");
    expect(served.decision.capacity.telemetry).toBe("available");
    expect(served.decision.capacity.selectedSource).toBe("grouped-quota");
  });

  it("removing the fields falls back to legacy fan-out with identical selections", async () => {
    const projected = await workerWith(["model"]);
    const fannedOut = await workerWith();

    const withFields = await refresh(projected);
    const withoutFields = await refresh(fannedOut);

    expect(withFields.error).toBeNull();
    expect(withoutFields.error).toBeNull();
    expect(withFields.evidence).toHaveLength(2);
    // Legacy fan-out: every record informs every model id.
    expect(withoutFields.evidence).toHaveLength(4);
    const cheapRows = withoutFields.evidence.filter((entry) => entry.modelId === "g10-cheap");
    expect(cheapRows.map((entry) => entry.laneLabel).sort()).toEqual(["record-1", "record-2"]);
    expect(cheapRows.every((entry) => entry.utilization === 0.5 && entry.telemetryAvailable)).toBe(true);

    const servedWith = await invoke(projected);
    const servedWithout = await invoke(fannedOut);
    // The acceptance: identical selections with and without the fields, both
    // served off live evidence — not a refusal, and not the telemetry-outage
    // fallback (which would read telemetry "unavailable" / selectedSource null).
    expect(servedWithout.outcome).toBe("completed");
    expect(servedWithout.decision.outcome).toBe("selected");
    expect(servedWithout.decision.modelId).toBe(servedWith.decision.modelId);
    expect(servedWithout.decision.capacity.telemetry).toBe("available");
    expect(servedWithout.decision.capacity.selectedSource).toBe("grouped-quota");
  });

  it.each([
    ["non-array string", "model"],
    ["number", 42],
    ["null", null],
    ["empty-string array", [""]],
    ["whitespace-only array", ["  "]],
    ["all-junk array", [123, null, "", {}, []]],
    ["object", { model: "g10-cheap" }],
    ["empty array", []],
  ])("malformed identity fields (%s) resolve fail-neutral to legacy fan-out", async (_name, value) => {
    // The worker's companyConfig path runs resolveConfig, not the JSON schema,
    // so stored junk reaches the resolver: it must not throw, and the refresh
    // must serve via fan-out with the same selection as the no-fields variant.
    const harness = await workerWith(value);
    const result = await refresh(harness);

    expect(result.error).toBeNull();
    expect(result.evidence).toHaveLength(4);
    for (const modelId of MODELS) {
      const rows = result.evidence.filter((entry) => entry.modelId === modelId);
      expect(rows.map((entry) => entry.laneLabel).sort()).toEqual(["record-1", "record-2"]);
    }

    const served = await invoke(harness);
    expect(served.outcome).toBe("completed");
    expect(served.decision.outcome).toBe("selected");
    expect(served.decision.modelId).toBe("g10-cheap");
    expect(served.decision.capacity.telemetry).toBe("available");
  });

  it("keeps valid entries while dropping junk from a mixed array", async () => {
    // All-or-nothing validation of the array would drop the valid "model"
    // entry and fan out (4 rows); the fail-neutral resolver keeps it (2 rows).
    const harness = await workerWith(["model", 123, "", null, {}]);
    const result = await refresh(harness);

    expect(result.error).toBeNull();
    expect(result.evidence).toHaveLength(2);
    const byModel = new Map(result.evidence.map((entry) => [entry.modelId, entry]));
    expect(byModel.get("g10-cheap")?.laneLabel).toBe("record-1");
    expect(byModel.get("g10-expensive")?.laneLabel).toBe("record-2");

    const served = await invoke(harness);
    expect(served.outcome).toBe("completed");
    expect(served.decision.outcome).toBe("selected");
    expect(served.decision.modelId).toBe("g10-cheap");
  });
});
