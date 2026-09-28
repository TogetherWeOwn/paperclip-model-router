/**
 * TOG-7898 (gap G18): conformance pins for the normative async section
 * (`docs/contracts/compatible-upstream-v1.md` section 10).
 *
 * The heavy async machinery is pinned elsewhere — TTL expiry and reap-under-
 * failure (`tog-7895`), reap shapes (`tog-7417`), envelope parity
 * (`tog-7886`), reconcile flush (`worker.spec.ts`) — but the contract's
 * literal numbers and boundary claims had no pin: the timeout table, the
 * 15-minute TTL value, the reconcile schedule, route statuses, company
 * isolation, the single-attempt rule, early-exit rowlessness, and reap-time
 * audit attribution. Each test below names the contract paragraph it guards;
 * weakening the paragraph's code must fail the test by name.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ACTION_KEYS, JOB_KEYS, PENDING_INVOCATION_TTL_MS, ROUTE_KEYS, STATE_KEYS } from "../src/constants.js";
import { ROUTER_CONFIG_SCHEMA } from "../src/config/schema.js";
import { validateUpstreamConfig } from "../src/inference/adapters.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { companyDecisionRecords, readFixture } from "./helpers.js";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const SECRET_A = "resolved-secret-a";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const contract = readFileSync(join(repo, "docs/contracts/compatible-upstream-v1.md"), "utf8");

function success(protocol: "openai" | "anthropic") {
  return protocol === "openai"
    ? new Response(JSON.stringify({ id: "chatcmpl-1", object: "chat.completion", model: "echo-a", choices: [{ index: 0, message: { role: "assistant", content: "hello a" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "request-a" } })
    : new Response(JSON.stringify({ id: "msg-1", type: "message", role: "assistant", model: "echo-b", content: [{ type: "text", text: "hello b" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 4, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json", "request-id": "request-b" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function sharedWorker() {
  const configs = new Map([
    [COMPANY_A, readFixture("company-a")],
    [COMPANY_B, readFixture("company-b")],
  ]);
  const harness = createTestHarness({ manifest, config: {} });
  harness.ctx.config = {
    async get(companyId) {
      const config = configs.get(String(companyId));
      if (!config) throw new Error("missing company config");
      return structuredClone(config);
    },
  };
  harness.ctx.secrets = {
    async resolve(_ref, options) {
      return options?.companyId === COMPANY_A ? SECRET_A : "resolved-secret-other";
    },
  };
  const httpCalls: string[] = [];
  harness.ctx.http = {
    async fetch(url) {
      httpCalls.push(String(url));
      return String(url).includes("company-a.example") ? success("openai") : success("anthropic");
    },
  };
  let fetchCalls = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    fetchCalls += 1;
    return success(String(url).includes("company-a.example") ? "openai" : "anthropic");
  });
  const { definition } = createPlugin();
  await definition.setup(harness.ctx);
  return { harness, definition, configs, httpCalls, fetchCallCount: () => fetchCalls };
}

const invocation = {
  task: { taskClass: "implementation", issueId: "issue-1" },
  messages: [{ role: "user", content: "hello" }],
  maxOutputTokens: 100,
};

const pendingRowKey = (companyId: string, requestId: string) => ({
  scopeKind: "company" as const,
  scopeId: companyId,
  stateKey: `${STATE_KEYS.pendingInvocations}:${requestId}`,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TOG-7898: contract section 10 numbers match shipped code", () => {
  it("section 10.2 bound: upstream timeout schema is 1s..300s, default 25s", () => {
    // Guards the section 3 table fix on this card (max was stale at 25,000):
    // the shipped schema is the source of truth for the contract numbers.
    const schema = ROUTER_CONFIG_SCHEMA as unknown as {
      properties: {
        upstream: { properties: { requestTimeoutMs: unknown } };
        models: { items: { properties: { requestTimeoutMs: unknown } } };
      };
    };
    expect(schema.properties.upstream.properties.requestTimeoutMs)
      .toMatchObject({ minimum: 1_000, maximum: 300_000, default: 25_000 });
    expect(schema.properties.models.items.properties.requestTimeoutMs)
      .toMatchObject({ minimum: 1_000, maximum: 300_000 });
  });

  it("section 10.2 bound: the runtime validator enforces the same ceiling the contract states", () => {
    const { upstream } = { upstream: (readFixture("company-a") as Record<string, unknown>).upstream as Parameters<typeof validateUpstreamConfig>[0] };
    const ok = { ...upstream, requestTimeoutMs: 300_000 };
    expect(validateUpstreamConfig(ok)).toEqual([]);
    expect(validateUpstreamConfig({ ...upstream, requestTimeoutMs: 300_001 }).join(" ")).toContain("requestTimeoutMs");
    expect(validateUpstreamConfig({ ...upstream, requestTimeoutMs: 999 }).join(" ")).toContain("requestTimeoutMs");
  });

  it("section 10.3 TTL: the constant is literally 15 minutes and anchors the row", async () => {
    expect(PENDING_INVOCATION_TTL_MS).toBe(900_000);
    const { harness } = await sharedWorker();
    const submitted = await harness.performAction(ACTION_KEYS.invokeAsync, invocation, { companyId: COMPANY_A }) as { requestId: string };
    const row = harness.getState(pendingRowKey(COMPANY_A, submitted.requestId)) as Record<string, unknown>;
    expect(Date.parse(String(row.expiresAt)) - Date.parse(String(row.startedAt))).toBe(PENDING_INVOCATION_TTL_MS);
  });

  it("section 10.1 surfaces: the reconcile job is registered to run every minute", () => {
    const jobs = manifest.jobs ?? [];
    expect(jobs.map((job) => [job.jobKey, job.schedule])).toContainEqual(
      [JOB_KEYS.reconcileAsyncInvocations, "* * * * *"],
    );
  });
});

describe("TOG-7898: contract section 10 boundaries", () => {
  it("section 10.2/10.5: one submit performs exactly one upstream attempt, never on the host bridge", async () => {
    const { harness, httpCalls, fetchCallCount } = await sharedWorker();
    const submitted = await harness.performAction(ACTION_KEYS.invokeAsync, invocation, { companyId: COMPANY_A }) as { requestId: string };
    let polled: unknown = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      polled = await harness.performAction(ACTION_KEYS.invokeResult, { requestId: submitted.requestId }, { companyId: COMPANY_A });
      if ((polled as { status: string }).status !== "pending") break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(polled).toMatchObject({ status: "completed", outcome: "completed" });
    expect(fetchCallCount()).toBe(1);
    expect(httpCalls).toHaveLength(0);
  });

  it("section 10.4/10.5: the reap aborts without issuing an upstream request", async () => {
    const { harness } = await sharedWorker();
    let upstreamCalls = 0;
    vi.stubGlobal("fetch", async () => {
      upstreamCalls += 1;
      return await new Promise<Response>(() => undefined);
    });
    const submitted = await harness.performAction(ACTION_KEYS.invokeAsync, invocation, {
      companyId: COMPANY_A,
      actor: { type: "agent", agentId: "agent-a", runId: "run-a" },
    }) as { requestId: string };
    // The background continuation yields at the DNS guard before reaching
    // the socket; let it run to the fetch before reaping.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(upstreamCalls).toBe(1);
    await harness.performAction(ACTION_KEYS.cancelRunInvocations, { runId: "run-a" }, { companyId: COMPANY_A });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(upstreamCalls).toBe(1);
    await expect(harness.performAction(
      ACTION_KEYS.invokeResult,
      { requestId: submitted.requestId },
      { companyId: COMPANY_A },
    )).resolves.toMatchObject({ status: "error", error: { code: "invocation-cancelled" } });
  });

  it("section 10.1 isolation: another company's poll and reap cannot see the row", async () => {
    const { harness } = await sharedWorker();
    vi.stubGlobal("fetch", async () => await new Promise<Response>(() => undefined));
    const submitted = await harness.performAction(ACTION_KEYS.invokeAsync, invocation, {
      companyId: COMPANY_A,
      actor: { type: "agent", agentId: "agent-a", runId: "run-a" },
    }) as { requestId: string };
    await expect(harness.performAction(
      ACTION_KEYS.invokeResult,
      { requestId: submitted.requestId },
      { companyId: COMPANY_B },
    )).resolves.toEqual({ status: "not-found" });
    await expect(harness.performAction(
      ACTION_KEYS.cancelRunInvocations,
      { runId: "run-a" },
      { companyId: COMPANY_B },
    )).resolves.toEqual({ runId: "run-a", cancelled: [], alreadyTerminal: [], failed: [] });
    await expect(harness.performAction(
      ACTION_KEYS.invokeResult,
      { requestId: submitted.requestId },
      { companyId: COMPANY_A },
    )).resolves.toMatchObject({ status: "pending" });
  });

  it("section 10.1 routes: invalid submit is 400 with no row, unknown/empty poll is 200 not-found", async () => {
    const { definition, harness, fetchCallCount } = await sharedWorker();
    const before = fetchCallCount();
    const invalid = await definition.onApiRequest!({
      routeKey: ROUTE_KEYS.invokeAsync,
      method: "POST",
      path: "/invoke-async",
      params: {},
      query: { companyId: COMPANY_A },
      body: { task: {}, messages: [], maxOutputTokens: 1 },
      actor: { actorType: "agent", actorId: "agent-a", runId: "run-a" },
      companyId: COMPANY_A,
      headers: {},
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ outcome: "error", error: { code: "invalid-request" } });
    const invalidId = (invalid.body as { requestId: string }).requestId;
    expect(harness.getState(pendingRowKey(COMPANY_A, invalidId))).toBeUndefined();
    expect(fetchCallCount()).toBe(before);

    for (const params of [{ requestId: "never-submitted" }, { requestId: "" }, {}] as Array<{ requestId?: string }>) {
      const polled = await definition.onApiRequest!({
        routeKey: ROUTE_KEYS.invokeResult,
        method: "GET",
        path: "/invoke/x",
        params,
        query: { companyId: COMPANY_A },
        body: {},
        actor: { actorType: "agent", actorId: "agent-a", runId: "run-a" },
        companyId: COMPANY_A,
        headers: {},
      });
      expect(polled.status).toBe(200);
      expect(polled.body).toEqual({ status: "not-found" });
    }
  });

  it("section 10.1 early exit: Rule 0 resolves at submit with no pending row and no upstream call", async () => {
    const { harness, fetchCallCount } = await sharedWorker();
    const before = fetchCallCount();
    const result = await harness.performAction(ACTION_KEYS.invokeAsync, {
      task: { taskClass: "mechanical", summary: "lint the repo" },
      messages: [{ role: "user", content: "lint" }],
      maxOutputTokens: 10,
    }, { companyId: COMPANY_A }) as { outcome: string; requestId: string };
    expect(result.outcome).toBe("no-model-needed");
    expect("status" in result).toBe(false);
    expect(harness.getState(pendingRowKey(COMPANY_A, result.requestId))).toBeUndefined();
    expect(fetchCallCount()).toBe(before);
    expect(companyDecisionRecords(harness, COMPANY_A)).toMatchObject([{ outcome: "no-model-needed" }]);
  });

  it("section 10.5 audit: the reap record carries no issue content and keeps the submitting agent/run", async () => {
    const { harness } = await sharedWorker();
    vi.stubGlobal("fetch", async () => await new Promise<Response>(() => undefined));
    const submitted = await harness.performAction(ACTION_KEYS.invokeAsync, invocation, {
      companyId: COMPANY_A,
      actor: { type: "agent", agentId: "agent-a", runId: "run-a" },
    }) as { requestId: string };
    await harness.performAction(ACTION_KEYS.cancelRunInvocations, { runId: "run-a" }, { companyId: COMPANY_A });
    expect(companyDecisionRecords(harness, COMPANY_A)).toMatchObject([{
      requestId: submitted.requestId,
      outcome: "error",
      errorCode: "invocation-cancelled",
      issueId: null,
      agentId: "agent-a",
      runId: "run-a",
    }]);
  });
});

describe("TOG-7898: contract section 10 exists and states its numbers", () => {
  it("keeps the normative async section with its envelope, TTL, and status claims", () => {
    expect(contract).toContain("## 10. Asynchronous invocation (submit + poll)");
    for (const claim of [
      "15 minutes",
      "300,000",
      "HTTP 202",
      "`not-found`",
      "invocation-cancelled",
      "reconcile-async-invocations",
      "cancel-run-invocations",
      "MUST NOT resurrect",
      "MUST NOT overwrite",
    ]) {
      expect(contract, `contract section 10 must state: ${claim}`).toContain(claim);
    }
  });

  it("keeps the corrected timeout table (max 300,000, not the stale 25,000)", () => {
    expect(contract).toContain("| `requestTimeoutMs` | 1,000 | 300,000 | 25,000 |");
  });
});
