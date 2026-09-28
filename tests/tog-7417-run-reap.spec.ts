/**
 * TOG-7417: authoritative run-budget fraction + run-end reap of async
 * invocations (the TOG-7138 CISO D3 precondition on widening router-invoke
 * access).
 *
 * (a) The host injects the authoritative spent fraction through the
 * tool/action context — a channel the caller cannot write to — and
 * prepareInvocation prefers it over the caller-claimed
 * `task.signals.budgetSpentFraction`, which any caller can forge. The
 * stock test harness only forwards the SDK-declared context fields, so the
 * preference itself is pinned at the unit level (the exact two calls the
 * worker makes, composed in order), while the worker level pins the default
 * path: no injected fraction means the caller signal rules exactly as before.
 *
 * (b) Async invocations carry their run on the pending record, the worker
 * keeps one AbortController per in-flight call, and a
 * `cancel-run-invocations {runId}` action settles a finished run's
 * still-open invocations to terminal `invocation-cancelled` instead of
 * lingering to TTL. No model is invoked by these tests (no spend): every
 * upstream is a stubbed fetch.
 */
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractAuthoritativeBudgetSpentFraction,
  resolveBudgetSpentFraction,
} from "../src/budget-authority.js";
import { ACTION_KEYS, STATE_KEYS, TOOL_NAMES } from "../src/constants.js";
import { invokeCompatibleUpstream } from "../src/inference/transport.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { companyDecisionRecords, fixtureConfig, readFixture } from "./helpers.js";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const SECRET_A = "resolved-secret-a";

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
      return String(url).includes("company-a.example") ? success("openai") : success("anthropic");
    },
  };
  vi.stubGlobal("fetch", async (url: string) => success(String(url).includes("company-a.example") ? "openai" : "anthropic"));
  const { definition } = createPlugin();
  await definition.setup(harness.ctx);
  return { harness, configs };
}

const invocation = {
  task: { taskClass: "implementation", issueId: "issue-1" },
  messages: [{ role: "user", content: "hello" }],
  maxOutputTokens: 100,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("authoritative budget fraction", () => {
  it("extracts only a finite host-injected number, never caller-shaped junk", () => {
    expect(extractAuthoritativeBudgetSpentFraction(undefined)).toBeUndefined();
    expect(extractAuthoritativeBudgetSpentFraction(null)).toBeUndefined();
    expect(extractAuthoritativeBudgetSpentFraction({})).toBeUndefined();
    expect(extractAuthoritativeBudgetSpentFraction({ budgetSpentFraction: "0.9" })).toBeUndefined();
    expect(extractAuthoritativeBudgetSpentFraction({ budgetSpentFraction: Number.NaN })).toBeUndefined();
    expect(extractAuthoritativeBudgetSpentFraction({ budgetSpentFraction: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(extractAuthoritativeBudgetSpentFraction({ agentId: "a", runId: "r", budgetSpentFraction: 0.42 })).toBe(0.42);
    // Zero is a real reading (a fresh run), not a missing one.
    expect(extractAuthoritativeBudgetSpentFraction({ budgetSpentFraction: 0 })).toBe(0);
  });

  it("prefers the authoritative fraction, including a falsy zero, over the caller claim", () => {
    // A forged-low caller claim (dodge the halt gate) loses to the host.
    expect(resolveBudgetSpentFraction(0.97, 0.0)).toBe(0.97);
    // A forged-high caller claim (force a downshift) loses to the host.
    expect(resolveBudgetSpentFraction(0.1, 0.99)).toBe(0.1);
    // Zero from the host is authoritative, not absent: ?? keeps it.
    expect(resolveBudgetSpentFraction(0, 0.99)).toBe(0);
    // No injection: the caller signal flows through exactly as before.
    expect(resolveBudgetSpentFraction(undefined, 0.99)).toBe(0.99);
    expect(resolveBudgetSpentFraction(undefined, undefined)).toBeUndefined();
  });

  it("the worker composes extract-then-resolve, so a forged caller signal loses to an injected host reading", () => {
    const hostContext = { agentId: "agent-a", runId: "run-a", budgetSpentFraction: 0.97 };
    expect(resolveBudgetSpentFraction(extractAuthoritativeBudgetSpentFraction(hostContext), 0.0)).toBe(0.97);
    const legacyContext = { agentId: "agent-a", runId: "run-a" };
    expect(resolveBudgetSpentFraction(extractAuthoritativeBudgetSpentFraction(legacyContext), 0.99)).toBe(0.99);
  });

  it("without an injected fraction the caller signal still drives the halt gate end to end", async () => {
    const { harness } = await sharedWorker();
    // TOG-7891: the caller claim rules only when no trusted source exists.
    // A readable ledger with a configured cap is ground truth and beats a
    // forged caller claim, so this legacy path needs the ledger unreadable
    // (fail-open) to hold — which also pins the fail-open composition.
    harness.ctx.db.query = async () => { throw new Error("ledger unavailable"); };
    const result = await harness.performAction(ACTION_KEYS.invoke, {
      ...invocation,
      task: { ...invocation.task, signals: { budgetSpentFraction: 0.99 } },
    }, { companyId: COMPANY_A }) as { outcome: string; decision: { gates: { budget: string } } };
    expect(result.outcome).toBe("no-eligible-model");
    expect(result.decision.gates.budget).toBe("halt");
  });

  it("a non-halted caller signal still selects end to end on the tool path", async () => {
    const { harness } = await sharedWorker();
    const result = await harness.executeTool(TOOL_NAMES.invoke, {
      ...invocation,
      task: { ...invocation.task, signals: { budgetSpentFraction: 0.1 } },
    }, { companyId: COMPANY_A, runId: "run-a", agentId: "agent-a", projectId: "project-a" });
    expect(result.data).toMatchObject({ outcome: "completed", decision: { gates: { budget: "ok" } } });
  });
});

describe("run-end reap", () => {
  it("stamps the submitting run on the pending record and indexes it by run", async () => {
    const { harness } = await sharedWorker();
    vi.stubGlobal("fetch", async () => await new Promise<Response>(() => undefined));
    const submitted = await harness.performAction(ACTION_KEYS.invokeAsync, invocation, {
      companyId: COMPANY_A,
      actor: { type: "agent", agentId: "agent-a", runId: "run-a" },
    }) as { status: string; requestId: string };
    expect(submitted.status).toBe("pending");
    expect(harness.getState({
      scopeKind: "company",
      scopeId: COMPANY_A,
      stateKey: `${STATE_KEYS.pendingInvocations}:${submitted.requestId}`,
    })).toMatchObject({ status: "pending", runId: "run-a", agentId: "agent-a" });
    expect(harness.getState({
      scopeKind: "company",
      scopeId: COMPANY_A,
      stateKey: `${STATE_KEYS.pendingInvocationsByRun}:run-a`,
    })).toEqual({ requestIds: [submitted.requestId] });
  });

  it("aborts the in-flight socket, settles invocation-cancelled, audits it, and stays idempotent", async () => {
    const { harness } = await sharedWorker();
    const gate = deferred<Response>();
    const seen: Array<RequestInit | undefined> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      seen.push(init);
      return gate.promise;
    });
    const submitted = await harness.performAction(ACTION_KEYS.invokeAsync, invocation, {
      companyId: COMPANY_A,
      actor: { type: "agent", agentId: "agent-a", runId: "run-a" },
    }) as { requestId: string };

    const reaped = await harness.performAction(ACTION_KEYS.cancelRunInvocations, { runId: "run-a" }, { companyId: COMPANY_A });
    expect(reaped).toEqual({ runId: "run-a", cancelled: [submitted.requestId], alreadyTerminal: [], failed: [] });
    // The reap aborted the real upstream socket, not just the row.
    const signal = seen[0]?.signal as AbortSignal | undefined;
    expect(signal?.aborted).toBe(true);

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

    // A late upstream success must never overwrite the settled terminal.
    gate.resolve(success("openai"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const again = await harness.performAction(
      ACTION_KEYS.invokeResult,
      { requestId: submitted.requestId },
      { companyId: COMPANY_A },
    );
    expect(again).toMatchObject({ status: "error", error: { code: "invocation-cancelled" } });

    // Second reap for the same run is a no-op.
    const second = await harness.performAction(ACTION_KEYS.cancelRunInvocations, { runId: "run-a" }, { companyId: COMPANY_A });
    expect(second).toEqual({ runId: "run-a", cancelled: [], alreadyTerminal: [], failed: [] });
  });

  it("leaves an already-completed invocation alone and reports it already-terminal when the index still lists it", async () => {
    const { harness } = await sharedWorker();
    const submitted = await harness.performAction(ACTION_KEYS.invokeAsync, invocation, {
      companyId: COMPANY_A,
      actor: { type: "agent", agentId: "agent-a", runId: "run-a" },
    }) as { requestId: string };
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Healthy path first: the call completed and left the index on its own.
    await expect(harness.performAction(
      ACTION_KEYS.invokeResult,
      { requestId: submitted.requestId },
      { companyId: COMPANY_A },
    )).resolves.toMatchObject({ status: "completed", outcome: "completed" });
    const clean = await harness.performAction(ACTION_KEYS.cancelRunInvocations, { runId: "run-a" }, { companyId: COMPANY_A });
    expect(clean).toEqual({ runId: "run-a", cancelled: [], alreadyTerminal: [], failed: [] });

    // Stale index entry (TTL expiry and worker restarts prune the row but not
    // the index): the reap prunes it and reports already-terminal, never
    // cancelled, and the terminal outcome is untouched.
    await harness.ctx.state.set({
      scopeKind: "company",
      scopeId: COMPANY_A,
      stateKey: `${STATE_KEYS.pendingInvocationsByRun}:run-a`,
    }, { requestIds: [submitted.requestId, "ghost-never-submitted"] });
    const stale = await harness.performAction(ACTION_KEYS.cancelRunInvocations, { runId: "run-a" }, { companyId: COMPANY_A });
    expect(stale).toEqual({
      runId: "run-a",
      cancelled: [],
      alreadyTerminal: [submitted.requestId, "ghost-never-submitted"],
      failed: [],
    });
    await expect(harness.performAction(
      ACTION_KEYS.invokeResult,
      { requestId: submitted.requestId },
      { companyId: COMPANY_A },
    )).resolves.toMatchObject({ status: "completed", outcome: "completed" });
    expect(harness.getState({
      scopeKind: "company",
      scopeId: COMPANY_A,
      stateKey: `${STATE_KEYS.pendingInvocationsByRun}:run-a`,
    })).toBeUndefined();
  });

  it("reaps only the named run and requires a runId", async () => {
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

    const reaped = await harness.performAction(ACTION_KEYS.cancelRunInvocations, { runId: "run-a" }, { companyId: COMPANY_A });
    expect(reaped).toEqual({ runId: "run-a", cancelled: [first.requestId], alreadyTerminal: [], failed: [] });
    await expect(harness.performAction(
      ACTION_KEYS.invokeResult,
      { requestId: second.requestId },
      { companyId: COMPANY_A },
    )).resolves.toMatchObject({ status: "pending" });

    const unknown = await harness.performAction(ACTION_KEYS.cancelRunInvocations, { runId: "run-never-ran" }, { companyId: COMPANY_A });
    expect(unknown).toEqual({ runId: "run-never-ran", cancelled: [], alreadyTerminal: [], failed: [] });

    await expect(harness.performAction(ACTION_KEYS.cancelRunInvocations, {}, { companyId: COMPANY_A }))
      .rejects.toThrow("runId is required");
  });
});

describe("transport abort signal", () => {
  const request = {
    task: { taskClass: "implementation" },
    messages: [{ role: "user" as const, content: "hello" }],
    maxOutputTokens: 100,
  };

  it("reports an aborted signal as invocation-cancelled, never an upstream code", async () => {
    const config = fixtureConfig("company-a").upstream;
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn(async () => { throw new DOMException("This operation was aborted", "AbortError"); });
    const result = await invokeCompatibleUpstream({
      http: { fetch }, config, credential: "resolved-value", request, modelId: "minimax-m2.5", signal: controller.signal,
    });
    expect(result).toMatchObject({
      response: null,
      error: { code: "invocation-cancelled", retryable: false },
    });
    expect(result.error?.upstreamStatus).toBeNull();
  });

  it("forwards the caller signal on the fetch init; the sync path sends none", async () => {
    const config = fixtureConfig("company-a").upstream;
    const seen: Array<RequestInit | undefined> = [];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(init);
      return success("openai");
    });
    const controller = new AbortController();
    const withSignal = await invokeCompatibleUpstream({
      http: { fetch }, config, credential: "resolved-value", request, modelId: "minimax-m2.5", signal: controller.signal,
    });
    expect(withSignal.error).toBeNull();
    expect(seen[0]?.signal).toBe(controller.signal);

    seen.length = 0;
    const withoutSignal = await invokeCompatibleUpstream({
      http: { fetch }, config, credential: "resolved-value", request, modelId: "minimax-m2.5",
    });
    expect(withoutSignal.error).toBeNull();
    expect(seen[0]).not.toHaveProperty("signal");
  });
});
