/**
 * TOG-7906 (R2-28): mutation gate for the TOG-7417 budget-authority precedence.
 *
 * `resolveBudgetSpentFraction` (`authoritative ?? caller`,
 * `src/budget-authority.ts`) is the anti-forgery hinge: the host injects the
 * authoritative spent fraction through the tool/action context — a channel the
 * caller cannot write to — and it must win over the caller-claimed
 * `task.signals.budgetSpentFraction`, which any caller can forge (low to dodge
 * the halt gate, high to force a downshift). If a refactor drops the
 * preference, these tests scream.
 *
 * Named mutants this file kills (reviewer acceptance: apply either, the suite
 * goes red naming the forgery window):
 *
 * - MUTANT 1 "swap precedence": `return callerClaimed ?? authoritative` in
 *   `resolveBudgetSpentFraction`. The forged claim wins whenever it is
 *   defined. Killed by the unit pins below — each names its forgery window
 *   (host=halt vs caller=ok, host=ok vs caller=halt, host zero vs caller).
 * - MUTANT 2 "drop host extraction": `worker.ts` stops calling
 *   `extractAuthoritativeBudgetSpentFraction(actorContext)` (passes
 *   `undefined` instead), so the host injection never reaches the gates.
 *   Killed by the worker-seam tests below, which drive the REAL registered
 *   invoke handlers with a host-injected fraction. The existing TOG-7417
 *   worker tests stay green under this mutant — they only pin the
 *   no-injection default path — so without these seam tests the mutant
 *   survives.
 *
 * Seam note: the stock SDK harness cannot carry the host field —
 * `actionContextFor` rebuilds the actor as
 * `{type,userId,agentId,runId,companyId}` and `executeTool` rebuilds the run
 * context as `{agentId,runId,companyId,projectId}` — so
 * `harness.performAction`/`executeTool` drop `budgetSpentFraction` before the
 * worker ever sees it (the TOG-7417 comment in `tog-7417-run-reap.spec.ts`
 * notes the same gap). These tests capture the registered handlers at setup
 * and invoke them directly with the host context the production bridge
 * supplies, bypassing only the harness sanitization. The ledger is switched
 * off (`monthlyCapUsd: 0`) so the gates move off exactly the
 * injected-vs-caller pair — the TOG-7417 precedence, isolated from the
 * TOG-7891 ledger.
 */
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractAuthoritativeBudgetSpentFraction,
  resolveBudgetSpentFraction,
} from "../src/budget-authority.js";
import { ACTION_KEYS, TOOL_NAMES } from "../src/constants.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { readFixture } from "./helpers.js";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const SECRET_A = "resolved-secret-a";

function success() {
  return new Response(JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "echo-a",
    choices: [{ index: 0, message: { role: "assistant", content: "hello a" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "request-a" } });
}

const invocation = {
  task: { taskClass: "implementation", issueId: "issue-1" },
  messages: [{ role: "user", content: "hello" }],
  maxOutputTokens: 100,
};

/**
 * A worker with the monthly spend ledger switched off, exposing the REAL
 * registered invoke handlers so tests can hand them the host context the
 * production bridge supplies (which the stock harness would strip).
 */
async function workerWithCapturedHandlers() {
  const config = readFixture("company-a") as Record<string, unknown>;
  (config.budget as Record<string, unknown>).monthlyCapUsd = 0;
  const harness = createTestHarness({ manifest, config: {} });
  harness.ctx.config = {
    async get(companyId: string) {
      if (companyId !== COMPANY_A) throw new Error("missing company config");
      return structuredClone(config);
    },
  };
  harness.ctx.secrets = {
    async resolve() {
      return SECRET_A;
    },
  };
  harness.ctx.http = {
    async fetch() {
      return success();
    },
  };
  vi.stubGlobal("fetch", async () => success());

  const captured: {
    invokeAction?: (params: unknown, actionCtx: unknown) => Promise<unknown>;
    invokeTool?: (params: unknown, runCtx: unknown) => Promise<unknown>;
  } = {};
  const actions = harness.ctx.actions as unknown as {
    register(key: string, handler: (...args: any[]) => unknown): unknown;
  };
  const originalActionRegister = actions.register.bind(actions);
  type CapturedAction = NonNullable<typeof captured.invokeAction>;
  actions.register = ((key: string, handler: (...args: any[]) => unknown) => {
    if (key === ACTION_KEYS.invoke) captured.invokeAction = handler as unknown as CapturedAction;
    return originalActionRegister(key, handler);
  }) as typeof actions.register;
  const tools = harness.ctx.tools as unknown as {
    register(name: string, declaration: unknown, handler: (...args: any[]) => unknown): unknown;
  };
  const originalToolRegister = tools.register.bind(tools);
  type CapturedTool = NonNullable<typeof captured.invokeTool>;
  tools.register = ((name: string, declaration: unknown, handler: (...args: any[]) => unknown) => {
    if (name === TOOL_NAMES.invoke) captured.invokeTool = handler as unknown as CapturedTool;
    return originalToolRegister(name, declaration, handler);
  }) as typeof tools.register;

  const { definition } = createPlugin();
  await definition.setup(harness.ctx);
  if (!captured.invokeAction || !captured.invokeTool) {
    throw new Error("invoke handlers were not registered during setup");
  }
  return { harness, captured };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TOG-7906: resolveBudgetSpentFraction precedence pins (MUTANT 1: swap)", () => {
  it("forged-low caller claim loses (forgery window: host=halt 0.97 vs caller=ok 0.0)", () => {
    // A caller forging 0.0 to dodge the halt gate loses to the host reading.
    // Under the swap mutant this returns 0.0 (gates: ok) — the dodge succeeds.
    expect(resolveBudgetSpentFraction(0.97, 0.0)).toBe(0.97);
  });

  it("forged-high caller claim loses (forgery window: host=ok 0.1 vs caller=halt 0.99)", () => {
    // A caller forging 0.99 to force a downshift/halt loses to the host.
    // Under the swap mutant this returns 0.99 (gates: halt) — the force succeeds.
    expect(resolveBudgetSpentFraction(0.1, 0.99)).toBe(0.1);
  });

  it("host zero is authoritative, not absent (forgery window: host=0 vs caller=0.99; ?? keeps 0, || would forge)", () => {
    // Zero is a real reading (a fresh run), not a missing one: `??` keeps it.
    // The swap mutant returns 0.99 here; an `||` refactor would too.
    expect(resolveBudgetSpentFraction(0, 0.99)).toBe(0);
  });

  it("absent host falls through to the caller (no forgery window: nothing to protect)", () => {
    // Negative control: with no injection the caller signal flows through
    // exactly as before — the preference only fires when the host speaks.
    expect(resolveBudgetSpentFraction(undefined, 0.99)).toBe(0.99);
    expect(resolveBudgetSpentFraction(undefined, undefined)).toBeUndefined();
  });
});

describe("TOG-7906: worker-seam forgery proofs (MUTANT 2: drop host extraction)", () => {
  it("a forged-low caller signal cannot dodge the halt gate end to end (forgery window: host 0.97 vs caller 0.0)", async () => {
    const { captured } = await workerWithCapturedHandlers();
    const result = await captured.invokeAction!(
      { ...invocation, task: { ...invocation.task, signals: { budgetSpentFraction: 0.0 } } },
      { companyId: COMPANY_A, actor: { type: "agent", agentId: "agent-a", runId: "run-a", budgetSpentFraction: 0.97 } },
    ) as { outcome: string; decision: { gates: { budget: string }; budget: { source: string; fraction: number | null } } };
    // The gates moved off the host reading, not the forged caller signal.
    expect(result.outcome).toBe("no-eligible-model");
    expect(result.decision.gates.budget).toBe("halt");
    expect(result.decision.budget.source).toBe("authoritative");
    expect(result.decision.budget.fraction).toBe(0.97);
  });

  it("a forged-high caller signal cannot force a halt end to end (forgery window: host 0.1 vs caller 0.99)", async () => {
    const { captured } = await workerWithCapturedHandlers();
    const toolResult = await captured.invokeTool!(
      { ...invocation, task: { ...invocation.task, signals: { budgetSpentFraction: 0.99 } } },
      { companyId: COMPANY_A, agentId: "agent-a", runId: "run-a", projectId: "project-a", budgetSpentFraction: 0.1 },
    ) as { data: { outcome: string; decision: { gates: { budget: string }; budget: { source: string; fraction: number | null } } } };
    expect(toolResult.data.outcome).toBe("completed");
    expect(toolResult.data.decision.gates.budget).toBe("ok");
    expect(toolResult.data.decision.budget.source).toBe("authoritative");
    expect(toolResult.data.decision.budget.fraction).toBe(0.1);
  });

  it("without an injected fraction the caller signal still rules (no forgery window: fail-open composition)", async () => {
    const { captured } = await workerWithCapturedHandlers();
    // Negative control: no host injection means the extraction yields
    // undefined and the caller claim flows through exactly as before — this
    // passes with AND without the extraction, pinning the legacy composition
    // so the forgery tests above cannot be satisfied by always halting.
    const hostContext = { agentId: "agent-a", runId: "run-a" };
    expect(extractAuthoritativeBudgetSpentFraction(hostContext)).toBeUndefined();
    const result = await captured.invokeAction!(
      { ...invocation, task: { ...invocation.task, signals: { budgetSpentFraction: 0.99 } } },
      { companyId: COMPANY_A, actor: { type: "agent", ...hostContext } },
    ) as { outcome: string; decision: { gates: { budget: string }; budget: { source: string } } };
    expect(result.outcome).toBe("no-eligible-model");
    expect(result.decision.gates.budget).toBe("halt");
    expect(result.decision.budget.source).toBe("caller");
  });
});
