import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { ROUTE_KEYS } from "../src/constants.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { companyDecisionRecords, readFixture } from "./helpers.js";

// TOG-7900 (Gap G2x): the issue route
// (`POST /issues/:issueId/invoke`, `src/worker.ts` `onApiRequest`) must serve
// the HOST-resolved company (`input.companyId`, resolved by the host from the
// `issueId` path param per the manifest's `companyResolution: { from:
// "issue", param: "issueId" }`) and never trust caller input (contract §2).
//
// Caller-controlled channels on this route are `query.companyId`,
// `body.companyId`, and `body.task.issueId`. The worker must:
//   - declare issue-based resolution in the manifest (never query-based),
//   - force `task.issueId` from `params.issueId` (path wins over body spoof),
//   - ignore `query.companyId` entirely (serve `input.companyId`),
//   - refuse a `body.companyId` as an unknown field (400, no cross-company
//     side effects) — never serve the forged company.
//
// Deleting the `issueId` override spread, switching the manifest entry back
// to `{ from: "query" }`, or reading company from query/body instead of
// `input.companyId` must fail THESE tests.

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const SECRET_A = "resolved-secret-a";
const SECRET_B = "resolved-secret-b";

function success(protocol: "openai" | "anthropic") {
  return protocol === "openai"
    ? new Response(JSON.stringify({ id: "chatcmpl-1", object: "chat.completion", model: "echo-a", choices: [{ index: 0, message: { role: "assistant", content: "hello a" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "request-a" } })
    : new Response(JSON.stringify({ id: "msg-1", type: "message", role: "assistant", model: "echo-b", content: [{ type: "text", text: "hello b" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 4, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json", "request-id": "request-b" } });
}

async function twoCompanyWorker() {
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
  const secretCalls: Array<{ secretId: string; companyId?: string; configPath?: string }> = [];
  harness.ctx.secrets = {
    async resolve(ref, options) {
      const secretId = typeof ref === "object" && ref ? String(ref.secretId) : String(ref);
      secretCalls.push({ secretId, ...options });
      return options?.companyId === COMPANY_A ? SECRET_A : SECRET_B;
    },
  };
  const httpCalls: Array<{ url: string; init?: RequestInit }> = [];
  harness.ctx.http = {
    async fetch(url, init) {
      httpCalls.push({ url: String(url), init });
      return String(url).includes("company-a.example") ? success("openai") : success("anthropic");
    },
  };
  const { definition } = createPlugin();
  await definition.setup(harness.ctx);
  return { harness, definition, httpCalls, secretCalls };
}

const validBody = () => ({
  task: { taskClass: "implementation" },
  messages: [{ role: "user", content: "hello" }],
  maxOutputTokens: 100,
});

const issueRequest = (overrides: Record<string, unknown> = {}) => ({
  routeKey: ROUTE_KEYS.invokeIssue,
  method: "POST",
  path: "/issues/issue-path/invoke",
  params: { issueId: "issue-path" },
  query: {},
  body: validBody(),
  actor: { actorType: "agent" as const, actorId: "agent-a", runId: "run-a" },
  companyId: COMPANY_A,
  headers: {},
  ...overrides,
});

describe("TOG-7900: the issue route serves the host-resolved company, never caller input", () => {
  it("declares host-side company resolution from the issue param, not the query", () => {
    const route = manifest.apiRoutes?.find((entry) => entry.routeKey === ROUTE_KEYS.invokeIssue);
    expect(route).toMatchObject({
      method: "POST",
      path: "/issues/:issueId/invoke",
      companyResolution: { from: "issue", param: "issueId" },
    });
  });

  it("forces task.issueId from the path param over a forged body value", async () => {
    const { definition, harness } = await twoCompanyWorker();
    const response = await definition.onApiRequest!(issueRequest({
      body: { ...validBody(), task: { taskClass: "implementation", issueId: "spoof" } },
    }));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ outcome: "completed" });
    const records = companyDecisionRecords(harness, COMPANY_A);
    expect(records).toHaveLength(1);
    // The audit carries the path issue, never the caller's spoof.
    expect(records[0]).toMatchObject({ issueId: "issue-path" });
    expect(JSON.stringify(records)).not.toContain("spoof");
    expect(companyDecisionRecords(harness, COMPANY_B)).toHaveLength(0);
  });

  it("ignores a forged query companyId and serves the host-resolved company", async () => {
    const { definition, harness, httpCalls, secretCalls } = await twoCompanyWorker();
    const response = await definition.onApiRequest!(issueRequest({
      query: { companyId: COMPANY_B },
    }));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      outcome: "completed",
      response: { modelId: "minimax-m2.5" },
    });
    // Company A's model, URL, and secret — the forged query bought nothing.
    expect(httpCalls).toHaveLength(1);
    expect(httpCalls[0]?.url).toBe("https://company-a.example/api/v1/chat/completions");
    expect(secretCalls).toEqual([
      { secretId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", companyId: COMPANY_A, configPath: "upstream.credentialSecretRef" },
    ]);
    expect(companyDecisionRecords(harness, COMPANY_A)).toHaveLength(1);
    expect(companyDecisionRecords(harness, COMPANY_B)).toHaveLength(0);
  });

  it("refuses a forged body companyId instead of serving the other company", async () => {
    const { definition, harness, httpCalls, secretCalls } = await twoCompanyWorker();
    const response = await definition.onApiRequest!(issueRequest({
      body: { ...validBody(), companyId: COMPANY_B },
    }));
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ outcome: "error", error: { code: "invalid-request" } });
    // Refusal before selection: no upstream attempt, no secret touch.
    expect(httpCalls).toHaveLength(0);
    expect(secretCalls).toHaveLength(0);
    // The refusal audit lands under the host company, never the forged one.
    expect(companyDecisionRecords(harness, COMPANY_B)).toHaveLength(0);
    expect(companyDecisionRecords(harness, COMPANY_A)).toHaveLength(1);
  });

  it("scopes the same path issueId to each host company independently", async () => {
    const { definition, harness, httpCalls, secretCalls } = await twoCompanyWorker();
    const forCompany = (companyId: string) => issueRequest({
      path: "/issues/shared-issue/invoke",
      params: { issueId: "shared-issue" },
      companyId,
      actor: { actorType: "agent" as const, actorId: `agent-${companyId.slice(0, 4)}`, runId: "run-shared" },
    });

    const first = await definition.onApiRequest!(forCompany(COMPANY_A));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ outcome: "completed", response: { modelId: "minimax-m2.5" } });

    const second = await definition.onApiRequest!(forCompany(COMPANY_B));
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ outcome: "completed", response: { modelId: "gpt-4.1" } });

    // Each company served its own upstream with its own credential.
    expect(httpCalls.map((call) => call.url)).toEqual([
      "https://company-a.example/api/v1/chat/completions",
      "https://company-b.example/compatible/v1/messages",
    ]);
    expect(secretCalls.map((call) => call.companyId)).toEqual([COMPANY_A, COMPANY_B]);
    // Audits stay under their host company with the shared path issue.
    expect(companyDecisionRecords(harness, COMPANY_A)).toMatchObject([{ issueId: "shared-issue" }]);
    expect(companyDecisionRecords(harness, COMPANY_B)).toMatchObject([{ issueId: "shared-issue" }]);
  });
});
