/**
 * TOG-13372: router-side reap on the first-class `agent.run.finished` event
 * (exit for the TOG-13354 H9 host hunk in heartbeat.ts).
 *
 * The subscription must settle the finished run's still-open async
 * invocations to terminal `invocation-cancelled` with no host action call:
 * abort the in-flight socket, keep the audit row, never overwrite the
 * terminal on a late upstream outcome, and never throw out of the handler.
 */
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ACTION_KEYS, STATE_KEYS } from "../src/constants.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { companyDecisionRecords, readFixture } from "./helpers.js";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const SECRET_A = "resolved-secret-a";

function success() {
  return new Response(JSON.stringify({ id: "chatcmpl-1", object: "chat.completion", model: "echo-a", choices: [{ index: 0, message: { role: "assistant", content: "hello a" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "request-a" } });
}

async function sharedWorker() {
  const configs = new Map([[COMPANY_A, readFixture("company-a")]]);
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
  harness.ctx.http = {
    async fetch(url) {
      return String(url).includes("company-a.example") ? success() : success();
    },
  };
  vi.stubGlobal("fetch", async () => success());
  const { definition } = createPlugin();
  await definition.setup(harness.ctx);
  return { harness };
}

const invocation = {
  task: { taskClass: "implementation", issueId: "issue-1" },
  messages: [{ role: "user", content: "hello" }],
  maxOutputTokens: 100,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("agent.run.finished event reap", () => {
  it("declares the events.subscribe capability the subscription requires", () => {
    expect(manifest.capabilities).toContain("events.subscribe");
  });

  it("reaps the finished run's in-flight invocation with no action call", async () => {
    const { harness } = await sharedWorker();
    const seen: Array<RequestInit | undefined> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      seen.push(init);
      return await new Promise<Response>(() => undefined);
    });
    const submitted = await harness.performAction(ACTION_KEYS.invokeAsync, invocation, {
      companyId: COMPANY_A,
      actor: { type: "agent", agentId: "agent-a", runId: "run-a" },
    }) as { status: string; requestId: string };
    expect(submitted.status).toBe("pending");

    await harness.emit("agent.run.finished", {}, { companyId: COMPANY_A, entityId: "run-a" });

    expect(seen[0]?.signal instanceof AbortSignal && (seen[0]?.signal as AbortSignal).aborted).toBe(true);
    const polled = await harness.performAction(
      ACTION_KEYS.invokeResult,
      { requestId: submitted.requestId },
      { companyId: COMPANY_A },
    );
    expect(polled).toMatchObject({
      status: "error",
      outcome: "error",
      error: { code: "invocation-cancelled", retryable: false },
    });
    expect(companyDecisionRecords(harness, COMPANY_A)).toMatchObject([{
      outcome: "error",
      errorCode: "invocation-cancelled",
      runId: "run-a",
      agentId: "agent-a",
    }]);
    expect(harness.getState({
      scopeKind: "company",
      scopeId: COMPANY_A,
      stateKey: `${STATE_KEYS.pendingInvocationsByRun}:run-a`,
    })).toBeUndefined();
  });

  it("reads the run id from the payload when the entity is absent", async () => {
    const { harness } = await sharedWorker();
    vi.stubGlobal("fetch", async () => await new Promise<Response>(() => undefined));
    const submitted = await harness.performAction(ACTION_KEYS.invokeAsync, invocation, {
      companyId: COMPANY_A,
      actor: { type: "agent", agentId: "agent-a", runId: "run-a" },
    }) as { requestId: string };

    await harness.emit("agent.run.finished", { runId: "run-a" }, { companyId: COMPANY_A });

    await expect(harness.performAction(
      ACTION_KEYS.invokeResult,
      { requestId: submitted.requestId },
      { companyId: COMPANY_A },
    )).resolves.toMatchObject({ status: "error", error: { code: "invocation-cancelled" } });
  });

  it("reaps only the finished run and never throws", async () => {
    const { harness } = await sharedWorker();
    vi.stubGlobal("fetch", async () => await new Promise<Response>(() => undefined));
    const first = await harness.performAction(ACTION_KEYS.invokeAsync, invocation, {
      companyId: COMPANY_A,
      actor: { type: "agent", agentId: "agent-a", runId: "run-a" },
    }) as { requestId: string };
    const second = await harness.performAction(ACTION_KEYS.invokeAsync, invocation, {
      companyId: COMPANY_A,
      actor: { type: "agent", agentId: "agent-b", runId: "run-b" },
    }) as { requestId: string };

    await expect(harness.emit("agent.run.finished", {}, { companyId: COMPANY_A, entityId: "run-a" }))
      .resolves.toBeUndefined();
    await expect(harness.performAction(
      ACTION_KEYS.invokeResult,
      { requestId: first.requestId },
      { companyId: COMPANY_A },
    )).resolves.toMatchObject({ error: { code: "invocation-cancelled" } });
    await expect(harness.performAction(
      ACTION_KEYS.invokeResult,
      { requestId: second.requestId },
      { companyId: COMPANY_A },
    )).resolves.toMatchObject({ status: "pending" });

    // Unknown run and missing run id are no-ops, never throws.
    await expect(harness.emit("agent.run.finished", {}, { companyId: COMPANY_A, entityId: "run-never-ran" }))
      .resolves.toBeUndefined();
    await expect(harness.emit("agent.run.finished", {}, { companyId: COMPANY_A }))
      .resolves.toBeUndefined();
    await expect(harness.performAction(
      ACTION_KEYS.invokeResult,
      { requestId: second.requestId },
      { companyId: COMPANY_A },
    )).resolves.toMatchObject({ status: "pending" });
  });
});
