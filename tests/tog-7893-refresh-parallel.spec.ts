/**
 * TOG-7893 (gap G9): `refreshCapacity` fetched sources one at a time
 * (`src/worker.ts`), so refresh time grew linearly with fleet size and risked
 * overrunning `maxSnapshotAgeMs`. The fetch now fans out with a documented
 * bound (`REFRESH_CAPACITY_MAX_IN_FLIGHT`, currently 4).
 *
 * Each test below fails on the old sequential loop for a reason that names
 * the property it pins:
 *
 * - overlap/timing: 4 x 120ms sources complete in ~120ms, not ~480ms. The
 *   overlap assertion (last start < first end) is scheduling-deterministic;
 *   the wall-clock assertion (< the sequential floor) is the acceptance shape
 *   ("completes in ~1 source-time").
 * - isolation/order: a slow 503 and a fast 401 settle out of order, but the
 *   snapshots and the joined error string stay in config order, and the good
 *   lanes keep their evidence. Removing the per-source catch (or letting one
 *   rejection fault the refresh) turns this red.
 * - bound: 6 slow sources never exceed 4 in flight. Raising the bound without
 *   updating the docs turns this red by design — the bound is documented, so
 *   changing it is a docs change too.
 * - secrets: credential resolution stays sequential in config order, so the
 *   credential-call order is unchanged by the fetch fan-out.
 */
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { ACTION_KEYS, STATE_KEYS } from "../src/constants.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { readFixture } from "./helpers.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";

function source(id: string, modelId: string) {
  return {
    id,
    statusUrl: `https://capacity.example/${id}`,
    modelIds: [modelId],
    healthFields: ["status"],
    requestTimeoutMs: 5000,
    maxResponseBytes: 262144,
    windows: [{ name: "weekly", utilizationFields: ["used"], resetFields: [] }],
  };
}

function configWithSources(count: number, withSecrets: boolean) {
  const config = readFixture("company-a") as Record<string, unknown>;
  const models = Array.from({ length: count }, (_, index) => ({
    id: `model-${index}`,
    tier: "standard",
    quality: 80,
    costPerMTokIn: 1,
    costPerMTokOut: 1,
    contextWindow: 200_000,
    enabled: true,
  }));
  config.models = models;
  config.capacityRouting = {
    enabled: true,
    mode: "shadow",
    unknownTelemetry: "fail-open",
    sources: models.map((model, index) => {
      const entry = source(`lane-${index}`, model.id);
      return withSecrets
        ? { ...entry, apiKeySecretRef: { type: "secret_ref", secretId: `aaaaaaaa-aaaa-4aaa-8aa${index}-aaaaaaaaaaaa` } }
        : entry;
    }),
  };
  return config;
}

function okResponse() {
  return new Response(JSON.stringify({ rows: [{ status: "ok", used: 0.2 }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function workerWith(
  config: Record<string, unknown>,
  fetchImpl: (url: string) => Promise<Response>,
) {
  const harness = createTestHarness({ manifest, config: {} });
  harness.ctx.config = {
    async get() { return structuredClone(config); },
  };
  const secretCalls: string[] = [];
  harness.ctx.secrets = {
    async resolve(_ref, options) {
      secretCalls.push(String(options?.configPath));
      return "resolved-secret";
    },
  };
  const started: Array<{ url: string; at: number }> = [];
  const ended: Array<{ url: string; at: number }> = [];
  let active = 0;
  let maxActive = 0;
  harness.ctx.http = {
    async fetch(url) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push({ url: String(url), at: performance.now() });
      try {
        return await fetchImpl(String(url));
      } finally {
        active -= 1;
        ended.push({ url: String(url), at: performance.now() });
      }
    },
  };
  const { definition } = createPlugin();
  await definition.setup(harness.ctx);
  return { harness, secretCalls, started, ended, stats: () => ({ maxActive }) };
}

type RefreshResult = {
  error: string | null;
  snapshots: Array<{ source: string; error: string | null; evidence: unknown[] }>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("TOG-7893: refreshCapacity fetches with bounded concurrency", () => {
  it("refreshes 4 slow sources in ~1 source-time with all fetches overlapping", async () => {
    const delayMs = 120;
    const { harness, started, ended, stats } = await workerWith(configWithSources(4, false), async () => {
      await sleep(delayMs);
      return okResponse();
    });

    const before = performance.now();
    const refreshed = await harness.performAction(
      ACTION_KEYS.refreshCapacity, {}, { companyId: COMPANY },
    ) as unknown as RefreshResult;
    const elapsed = performance.now() - before;

    expect(refreshed.error).toBeNull();
    expect(refreshed.snapshots.map((snapshot) => snapshot.source))
      .toEqual(["lane-0", "lane-1", "lane-2", "lane-3"]);
    expect(refreshed.snapshots.every((snapshot) => snapshot.error === null && snapshot.evidence.length > 0)).toBe(true);
    // Deterministic proof of overlap: the last fetch started before the first
    // finished. Sequential fetching spaces starts ~delayMs apart.
    expect(Math.max(...started.map((entry) => entry.at)))
      .toBeLessThan(Math.min(...ended.map((entry) => entry.at)));
    // Acceptance shape: strictly less than the sequential floor (4 x delayMs),
    // which every sequential run must take or exceed.
    expect(elapsed).toBeLessThan(4 * delayMs);
    expect(stats().maxActive).toBeGreaterThan(1);
  });

  it("isolates failing sources and keeps snapshots and errors in config order", async () => {
    const { harness } = await workerWith(configWithSources(4, false), async (url) => {
      if (url.endsWith("/lane-1")) {
        // Slow failure settles AFTER the fast failure below; the joined error
        // must still read in config order, not settle order.
        await sleep(60);
        return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/lane-3")) {
        return new Response("{}", { status: 401, headers: { "content-type": "application/json" } });
      }
      return okResponse();
    });

    const refreshed = await harness.performAction(
      ACTION_KEYS.refreshCapacity, {}, { companyId: COMPANY },
    ) as unknown as RefreshResult;

    expect(refreshed.snapshots.map((snapshot) => snapshot.source))
      .toEqual(["lane-0", "lane-1", "lane-2", "lane-3"]);
    expect(refreshed.snapshots[1]).toMatchObject({ error: "capacity-http-failed", evidence: [] });
    expect(refreshed.snapshots[3]).toMatchObject({ error: "capacity-authentication-failed", evidence: [] });
    for (const index of [0, 2]) {
      expect(refreshed.snapshots[index]!.error).toBeNull();
      expect(refreshed.snapshots[index]!.evidence.length).toBeGreaterThan(0);
    }
    // Config order, not settle order: lane-1 failed second but sorts first.
    expect(refreshed.error).toBe("capacity-http-failed; capacity-authentication-failed");
  });

  it("preserves stored evidence for the healthy lanes when one source fails", async () => {
    const worker = await workerWith(configWithSources(4, false), async () => okResponse());
    await worker.harness.performAction(ACTION_KEYS.refreshCapacity, {}, { companyId: COMPANY });
    const valid = worker.harness.getState({
      scopeKind: "company",
      scopeId: COMPANY,
      stateKey: STATE_KEYS.capacitySnapshot,
    }) as { evidence: unknown[] };

    worker.harness.ctx.http.fetch = async (url) => {
      if (String(url).endsWith("/lane-2")) {
        return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
      }
      if (!String(url).includes("capacity.example")) {
        throw new Error(`unexpected fetch of ${String(url)}`);
      }
      return okResponse();
    };
    const failed = await worker.harness.performAction(
      ACTION_KEYS.refreshCapacity, {}, { companyId: COMPANY },
    ) as unknown as RefreshResult;

    expect(failed.error).toBe("capacity-http-failed");
    expect(failed.snapshots[2]).toMatchObject({ error: "capacity-http-failed", evidence: [] });
    expect(failed.snapshots.filter((snapshot) => snapshot.error === null)).toHaveLength(3);
    expect(worker.harness.getState({
      scopeKind: "company",
      scopeId: COMPANY,
      stateKey: STATE_KEYS.capacitySnapshot,
    })).toMatchObject({ evidence: valid.evidence, lastRefreshError: "capacity-http-failed" });
  });

  it("caps in-flight fetches at 4 with 6 slow sources", async () => {
    const { harness, stats } = await workerWith(configWithSources(6, false), async () => {
      await sleep(80);
      return okResponse();
    });

    const refreshed = await harness.performAction(
      ACTION_KEYS.refreshCapacity, {}, { companyId: COMPANY },
    ) as unknown as RefreshResult;

    expect(refreshed.error).toBeNull();
    expect(refreshed.snapshots).toHaveLength(6);
    expect(refreshed.snapshots.every((snapshot) => snapshot.error === null)).toBe(true);
    // The documented bound: never more than 4 at once, and more than 1 (the
    // fetch genuinely fans out rather than running sequentially).
    expect(stats().maxActive).toBe(4);
  });

  it("resolves source secrets sequentially in config order", async () => {
    const { harness, secretCalls } = await workerWith(configWithSources(3, true), async () => okResponse());

    const refreshed = await harness.performAction(
      ACTION_KEYS.refreshCapacity, {}, { companyId: COMPANY },
    ) as unknown as RefreshResult;

    expect(refreshed.error).toBeNull();
    expect(secretCalls).toEqual([
      "capacityRouting.sources.0.apiKeySecretRef",
      "capacityRouting.sources.1.apiKeySecretRef",
      "capacityRouting.sources.2.apiKeySecretRef",
    ]);
  });
});
