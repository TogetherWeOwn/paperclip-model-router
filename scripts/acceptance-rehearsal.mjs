#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMPANY_A = process.env.COMPANY_A_ID ?? "11111111-1111-4111-8111-111111111111";
const COMPANY_B = process.env.COMPANY_B_ID ?? "22222222-2222-4222-8222-222222222222";
const COMPANY_C = process.env.COMPANY_C_ID ?? "33333333-3333-4333-8333-333333333333";
const configs = new Map([
  [COMPANY_A, JSON.parse(readFileSync(join(root, "tests/fixtures/company-a.json"), "utf8"))],
  [COMPANY_B, JSON.parse(readFileSync(join(root, "tests/fixtures/company-b.json"), "utf8"))],
  [COMPANY_C, JSON.parse(readFileSync(join(root, "tests/fixtures/company-c.json"), "utf8"))],
]);

const manifest = (await import(pathToFileURL(join(root, "dist/manifest.js")).href)).default;
const { createPlugin } = await import(pathToFileURL(join(root, "dist/worker.js")).href);
const workerSource = readFileSync(join(root, "dist/worker.js"), "utf8");
const harness = createTestHarness({ manifest, config: {} });

harness.ctx.config = {
  async get(companyId) {
    const config = configs.get(String(companyId));
    if (!config) throw new Error(`missing config for ${companyId}`);
    return structuredClone(config);
  },
};
const secretCalls = [];
const secretValues = [];
let secretSequence = 0;
const laneKey = (companyId) => companyId === COMPANY_A ? "a" : companyId === COMPANY_B ? "b" : "c";
harness.ctx.secrets = {
  async resolve(ref, options) {
    secretSequence += 1;
    secretCalls.push({ secretId: ref.secretId, companyId: options?.companyId, configPath: options?.configPath });
    const value = `runtime-${laneKey(options?.companyId)}-${secretSequence}`;
    secretValues.push(value);
    return value;
  },
};
const httpCalls = [];
function openAiResponse(tag, requestId) {
  return new Response(JSON.stringify({ id: `chatcmpl-${tag}`, object: "chat.completion", model: `echo-${tag}`, choices: [{ index: 0, message: { role: "assistant", content: `company ${tag}` }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json", "x-request-id": requestId } });
}
harness.ctx.http = {
  async fetch(url, init) {
    const parsed = JSON.parse(String(init?.body));
    httpCalls.push({ url: String(url), headers: init?.headers, model: parsed.model, redirect: init?.redirect });
    if (String(url).includes("company-a")) return openAiResponse("a", "request-a");
    if (String(url).includes("company-c")) return openAiResponse("c", "request-c");
    return new Response(JSON.stringify({ id: "msg-b", type: "message", role: "assistant", model: "echo-b", content: [{ type: "text", text: "company b" }], stop_reason: "end_turn", stop_sequence: null }), { status: 200, headers: { "content-type": "application/json", "request-id": "request-b" } });
  },
};

const { definition } = createPlugin();
await definition.setup(harness.ctx);
let failures = 0;
function check(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n      ${detail}` : ""}`);
}

const invocation = {
  task: { taskClass: "implementation", issueId: "rehearsal" },
  messages: [{ role: "user", content: "hello" }],
  maxOutputTokens: 100,
};

check("one built worker declares multi-company support", definition.multiCompanyConfig === true);
check("the built bundle contains no company UUID", !workerSource.includes(COMPANY_A) && !workerSource.includes(COMPANY_B) && !workerSource.includes(COMPANY_C));
check("the built bundle contains no direct networking imports", !/node:(?:http|https|net|tls)/.test(workerSource));
check("the built bundle uses the stock host HTTP boundary", workerSource.includes(".http.fetch") || workerSource.includes("http: t.http"));

const resultA = await harness.performAction("invoke", invocation, { companyId: COMPANY_A });
const resultA2 = await harness.performAction("invoke", invocation, { companyId: COMPANY_A });
const resultB = await harness.performAction("invoke", invocation, { companyId: COMPANY_B });
check("company A completes through its OpenAI-compatible upstream", resultA.outcome === "completed" && resultA2.outcome === "completed" && resultA.response.upstream.protocol === "openai-chat-completions" && resultA.response.modelId === "minimax-m2.5");
check("company B completes through its Anthropic-compatible upstream", resultB.outcome === "completed" && resultB.response.upstream.protocol === "anthropic-messages" && resultB.response.modelId === "gpt-4.1");
check("the same invocation selects differently only because company config differs", resultA.response.modelId !== resultB.response.modelId);
check("each company uses its own base URL", httpCalls.map((call) => call.url).join("|") === "https://company-a.example/api/v1/chat/completions|https://company-a.example/api/v1/chat/completions|https://company-b.example/compatible/v1/messages");
check("each call disables redirects", httpCalls.every((call) => call.redirect === "manual"));
check("each call sends Accept-Encoding identity", httpCalls.every((call) => Object.entries(call.headers).some(([name, value]) => name.toLowerCase() === "accept-encoding" && value === "identity")));
check("secret resolution is repeated at call time and company-scoped", secretCalls.length === 3 && secretCalls[0].companyId === COMPANY_A && secretCalls[1].companyId === COMPANY_A && secretCalls[2].companyId === COMPANY_B && secretCalls.every((call) => call.configPath === "upstream.credentialSecretRef"));
check("repeated calls receive distinct secret resolutions rather than a cached credential", httpCalls[0].headers.Authorization !== httpCalls[1].headers.Authorization);

const rule0 = await harness.performAction("invoke", {
  task: { taskClass: "mechanical", summary: "lint the repo" },
  messages: [{ role: "user", content: "lint" }],
  maxOutputTokens: 10,
}, { companyId: COMPANY_A });
check("Rule 0 makes no upstream or secret request", rule0.outcome === "no-model-needed" && httpCalls.length === 3 && secretCalls.length === 3);

const decisionWrites = harness.dbExecutes.filter((entry) => entry.sql.includes("INSERT INTO") && entry.sql.includes(".decision_records"));
const logA = decisionWrites.filter((entry) => entry.params?.[1] === COMPANY_A);
const logB = decisionWrites.filter((entry) => entry.params?.[1] === COMPANY_B);
check("decision records are company-scoped durable inserts", logA.length === 3 && logB.length === 1);
check("decision records contain no request content or credential", !JSON.stringify([logA, logB]).includes("hello") && !JSON.stringify([logA, logB]).includes("runtime-a") && !JSON.stringify([logA, logB]).includes("runtime-b"));

// --- Evidence 7: usage-aware model evidence, refreshed separately ---------

console.log("\nEVIDENCE 7 — model-usage evidence refresh is separate and shadow-first");

const capacitySecretRef = { type: "secret_ref", secretId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
const capacitySources = [
  {
    id: "simulated-scarce", statusUrl: "https://scarce-capacity.invalid/status",
    apiKeySecretRef: capacitySecretRef, modelIds: ["subscription-model"],
    healthFields: ["status"], requestTimeoutMs: 5000,
    maxResponseBytes: 262144, windows: [{ name: "window", utilizationFields: ["used"], resetFields: ["resetsAt"] }],
  },
  {
    id: "simulated-available", statusUrl: "https://available-capacity.invalid/status",
    apiKeySecretRef: null, modelIds: ["available-model"],
    healthFields: ["status"], requestTimeoutMs: 5000,
    maxResponseBytes: 262144, windows: [{ name: "window", utilizationFields: ["used"], resetFields: ["resetsAt"] }],
  },
];
const capacityConfig = {
  ...structuredClone(configs.get(COMPANY_A)),
  routing: { ...configs.get(COMPANY_A).routing, fallbackModelId: null, stickyModelWithinIssue: false },
  models: [
    { id: "subscription-model", tier: "standard", quality: 80, costPerMTokIn: 0, costPerMTokOut: 0, contextWindow: 200000, capabilities: ["tools"], enabled: true },
    { id: "available-model", tier: "standard", quality: 80, costPerMTokIn: 1, costPerMTokOut: 4, contextWindow: 200000, capabilities: ["tools"], enabled: true },
  ],
  taskClasses: [{ key: "implementation", qualityFloor: 70 }],
  capacityRouting: { enabled: true, mode: "shadow", unknownTelemetry: "fail-closed", sources: capacitySources },
};
const capacityConfigs = new Map([[COMPANY_A, capacityConfig]]);
const capacityHarness = createTestHarness({ manifest, config: {} });
capacityHarness.ctx.config = { async get(companyId) { return structuredClone(capacityConfigs.get(String(companyId))); } };
const capacitySecretCalls = [];
capacityHarness.ctx.secrets = { async resolve(ref, options) { capacitySecretCalls.push({ ref, options }); return "runtime-capacity-secret"; } };
const capacityHttpCalls = [];
capacityHarness.ctx.http = {
  async fetch(url, init) {
    capacityHttpCalls.push({ url: String(url), method: init?.method, headers: init?.headers });
    if (init?.method === "GET") {
      const row = String(url).includes("scarce-capacity")
        ? { lane: "scarce", status: "degraded", used: 0.98 }
        : { lane: "available", status: "healthy", used: 0.2 };
      return new Response(JSON.stringify({ rows: [row] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ id: "chatcmpl-capacity", object: "chat.completion", model: "echo", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
  },
};
const { definition: capacityWorker } = createPlugin();
await capacityWorker.setup(capacityHarness.ctx);
const refreshed = await capacityHarness.performAction("refresh-capacity", { companyId: COMPANY_B }, { companyId: COMPANY_A });
check("refresh is company scoped and uses the distinct capacity secret path", refreshed.error === null && capacitySecretCalls.length === 1 && capacitySecretCalls[0].options.companyId === COMPANY_A && capacitySecretCalls[0].options.configPath === "capacityRouting.sources.0.apiKeySecretRef");
check("refresh output contains no credential, provider, or account serving claim", !JSON.stringify(refreshed).includes("runtime-capacity-secret") && !/provider|account/i.test(JSON.stringify(refreshed)));
const capacityInvocation = { task: { taskClass: "implementation" }, messages: [{ role: "user", content: "hello" }], maxOutputTokens: 100 };
const getsBeforeShadow = capacityHttpCalls.filter((call) => call.method === "GET").length;
const shadow = await capacityHarness.performAction("invoke", capacityInvocation, { companyId: COMPANY_A });
check("shadow preserves the v1 winner and invoke makes zero inline capacity GETs", shadow.outcome === "completed" && shadow.decision.modelId === "subscription-model" && shadow.decision.capacity.shadowModelId === "available-model" && capacityHttpCalls.filter((call) => call.method === "GET").length === getsBeforeShadow);
check("shadow makes exactly one inference POST", capacityHttpCalls.filter((call) => call.method === "POST").length === 1);
capacityConfigs.set(COMPANY_A, { ...capacityConfig, capacityRouting: { ...capacityConfig.capacityRouting, mode: "enforce" } });
const postsBeforeEnforce = capacityHttpCalls.filter((call) => call.method === "POST").length;
const enforced = await capacityHarness.performAction("invoke", capacityInvocation, { companyId: COMPANY_A });
check("enforce changes only the opaque model ID and still makes one inference POST", enforced.outcome === "completed" && enforced.decision.modelId === "available-model" && capacityHttpCalls.filter((call) => call.method === "POST").length === postsBeforeEnforce + 1);
check("capacity decision exposes no provider/account fields", !/Provider|Account|provider|account/.test(JSON.stringify(enforced.decision.capacity)));

// --- Evidence 8: async submit + poll + run-end cancel, isolated company ----

console.log("\nEVIDENCE 8 — async submit/poll completes and run-end cancel settles invocation-cancelled");

// The async background continuation rides the worker process's own global
// fetch, not the host HTTP bridge the sync checks above pinned: the host
// aborts every bridged call at 30s, which is the cap the async path exists
// to escape. Stub the global fetch before submitting; the sync bridge stub
// above stays untouched, so any async traffic on it is a leak.
const asyncUpstreamCalls = [];
let deferCompanyC = false;
let releaseDeferredUpstream = null;
const workerFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  asyncUpstreamCalls.push({ url: String(url), headers: init?.headers, redirect: init?.redirect, signal: init?.signal ?? null });
  if (String(url).includes("company-c.example") && deferCompanyC) {
    await new Promise((resolve) => { releaseDeferredUpstream = resolve; });
    releaseDeferredUpstream = null;
  }
  if (String(url).includes("company-c.example")) return openAiResponse("c", "request-async-c");
  throw new Error(`unexpected async upstream call to ${url}`);
};

async function pollTerminal(companyId, requestId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const polled = await harness.performAction("invoke-result", { requestId }, { companyId });
    if (polled.status === "completed" || polled.status === "error") return polled;
    if (polled.status !== "pending") throw new Error(`unexpected poll status ${polled.status}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("async invocation never reached a terminal state");
}
const asyncDecisionWrites = () => harness.dbExecutes.filter((entry) => entry.sql.includes("INSERT INTO") && entry.sql.includes(".decision_records"));
const writesFor = (companyId) => asyncDecisionWrites().filter((entry) => entry.params?.[1] === companyId);
const noResolvedCredential = (value) => !secretValues.some((secret) => JSON.stringify(value).includes(secret));

const secretsBeforeAsync = secretCalls.length;
const logABeforeAsync = writesFor(COMPANY_A).length;
const logBBeforeAsync = writesFor(COMPANY_B).length;
const logCBeforeAsync = writesFor(COMPANY_C).length;

// Half 1: submit on the async company, poll to completion.
const submitted = await harness.performAction("invoke-async", {
  task: { taskClass: "implementation", issueId: "rehearsal-async-complete" },
  messages: [{ role: "user", content: "a long, careful answer" }],
  maxOutputTokens: 4000,
}, { companyId: COMPANY_C, actor: { type: "agent", agentId: "rehearsal-agent", runId: "rehearsal-run-complete" } });
check("async submit returns pending with the same selection the sync path makes", submitted.status === "pending" && typeof submitted.requestId === "string" && submitted.decision?.modelId === "minimax-m2.5");
const submitCredential = secretValues[secretsBeforeAsync];
check("async submit resolves the company secret at call time, company-scoped", secretCalls.length === secretsBeforeAsync + 1 && secretCalls[secretsBeforeAsync].companyId === COMPANY_C && secretCalls[secretsBeforeAsync].configPath === "upstream.credentialSecretRef");
const completed = await pollTerminal(COMPANY_C, submitted.requestId);
check("async poll reaches completed through the company upstream", completed.status === "completed" && completed.outcome === "completed" && completed.response?.modelId === "minimax-m2.5" && completed.response?.upstream?.protocol === "openai-chat-completions");
const completedCall = asyncUpstreamCalls.find((call) => call.url.includes("company-c.example"));
check("the async upstream call satisfies the sync contract", completedCall?.url === "https://company-c.example/api/v1/chat/completions" && completedCall?.redirect === "manual" && completedCall?.headers?.["Accept-Encoding"] === "identity" && completedCall?.headers?.Authorization === `Bearer ${submitCredential}`);
check("async traffic never touches the sync host bridge", httpCalls.every((call) => !call.url.includes("company-c")));
check("a company cannot poll another company's request", (await harness.performAction("invoke-result", { requestId: submitted.requestId }, { companyId: COMPANY_A })).status === "not-found");
const completedRow = harness.getState({ scopeKind: "company", scopeId: COMPANY_C, stateKey: `pending-invocations:${submitted.requestId}` });
check("the completed pending row carries attribution but no credential or prompt", completedRow?.status === "completed" && completedRow?.runId === "rehearsal-run-complete" && completedRow?.agentId === "rehearsal-agent" && noResolvedCredential(completedRow) && !JSON.stringify(completedRow).includes("a long,"));
check("the completed run left the run index on its own", harness.getState({ scopeKind: "company", scopeId: COMPANY_C, stateKey: "pending-invocations-by-run:rehearsal-run-complete" }) === undefined);
const completedAudit = writesFor(COMPANY_C).find((entry) => entry.params?.[3] === submitted.requestId);
check("the completion wrote one company-scoped audit row with run attribution", writesFor(COMPANY_C).length === logCBeforeAsync + 1 && completedAudit?.params?.[4] === "rehearsal-agent" && completedAudit?.params?.[5] === "rehearsal-run-complete" && completedAudit?.params?.[12] === "completed" && noResolvedCredential(completedAudit) && !JSON.stringify(completedAudit).includes("a long,"));

// Half 2: a second submit holds its upstream socket open; the run-end reap
// aborts it and settles invocation-cancelled.
deferCompanyC = true;
const hanging = await harness.performAction("invoke-async", {
  task: { taskClass: "implementation", issueId: "rehearsal-async-cancel" },
  messages: [{ role: "user", content: "a long, careful answer" }],
  maxOutputTokens: 4000,
}, { companyId: COMPANY_C, actor: { type: "agent", agentId: "rehearsal-agent", runId: "rehearsal-run-cancel" } });
// The continuation reaches the upstream socket after selection, secret
// resolution, and the request-time DNS guard — all async — while this flow
// races ahead synchronously. Wait for the second socket to actually open
// before reaping: otherwise the reap aborts a controller nobody has consumed
// yet and the "aborted the real socket" pin below asserts against a call
// that does not exist yet. (The completed call is already recorded, so the
// hanging socket is the second entry.)
for (let attempt = 0; attempt < 500 && asyncUpstreamCalls.length < 2; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
check("the second submit stays pending while its upstream socket is held open", hanging.status === "pending" && asyncUpstreamCalls.length === 2 && (await harness.performAction("invoke-result", { requestId: hanging.requestId }, { companyId: COMPANY_C })).status === "pending");
const inFlightRow = harness.getState({ scopeKind: "company", scopeId: COMPANY_C, stateKey: `pending-invocations:${hanging.requestId}` });
check("the in-flight pending row carries run attribution but no credential or prompt", inFlightRow?.status === "pending" && inFlightRow?.runId === "rehearsal-run-cancel" && noResolvedCredential(inFlightRow) && !JSON.stringify(inFlightRow).includes("a long,"));
const reaped = await harness.performAction("cancel-run-invocations", { runId: "rehearsal-run-cancel" }, { companyId: COMPANY_C });
check("run-end reap settles exactly the named run", reaped.runId === "rehearsal-run-cancel" && JSON.stringify(reaped.cancelled) === JSON.stringify([hanging.requestId]) && reaped.alreadyTerminal.length === 0 && reaped.failed.length === 0);
const hangingCall = asyncUpstreamCalls.find((call) => call.signal?.aborted === true);
check("the reap aborted the real upstream socket, not just the row", hangingCall?.url.includes("company-c.example") === true);
const cancelled = await pollTerminal(COMPANY_C, hanging.requestId);
check("the reaped invocation polls as non-retryable invocation-cancelled", cancelled.status === "error" && cancelled.outcome === "error" && cancelled.error?.code === "invocation-cancelled" && cancelled.error?.retryable === false && cancelled.error?.upstreamStatus === null);
deferCompanyC = false;
releaseDeferredUpstream?.();
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));
check("a late upstream outcome never overwrites the reaped terminal", (await harness.performAction("invoke-result", { requestId: hanging.requestId }, { companyId: COMPANY_C })).error?.code === "invocation-cancelled");
const cancelledAudit = writesFor(COMPANY_C).find((entry) => entry.params?.[3] === hanging.requestId);
check("the reap wrote one company-scoped audit row naming the cancel", cancelledAudit?.params?.[1] === COMPANY_C && cancelledAudit?.params?.[4] === "rehearsal-agent" && cancelledAudit?.params?.[5] === "rehearsal-run-cancel" && cancelledAudit?.params?.[12] === "error" && cancelledAudit?.params?.[13] === "invocation-cancelled" && noResolvedCredential(cancelledAudit));
check("a second reap is a no-op and unknown runs/ids stay empty", (await harness.performAction("cancel-run-invocations", { runId: "rehearsal-run-cancel" }, { companyId: COMPANY_C })).cancelled.length === 0 && (await harness.performAction("cancel-run-invocations", { runId: "run-never-ran" }, { companyId: COMPANY_C })).cancelled.length === 0 && (await harness.performAction("invoke-result", { requestId: "never-submitted" }, { companyId: COMPANY_C })).status === "not-found");
check("async made exactly one upstream call per submit", asyncUpstreamCalls.length === 2);
check("async submits resolved exactly two company-scoped secrets", secretCalls.length === secretsBeforeAsync + 2 && secretCalls[secretsBeforeAsync + 1].companyId === COMPANY_C);
// The reaped continuation still audits its late upstream outcome (the decision
// record is history; the pending row is state), so the reaped request writes
// two audit rows — the reap's `invocation-cancelled` plus the late outcome.
// Both ride the same requestId, which the durable table dedupes via
// ON CONFLICT (company_id, request_id) DO NOTHING.
const auditsFor = (requestId) => writesFor(COMPANY_C).filter((entry) => entry.params?.[3] === requestId);
check("Evidence 8 wrote nothing outside the async company", writesFor(COMPANY_A).length === logABeforeAsync && writesFor(COMPANY_B).length === logBBeforeAsync && auditsFor(submitted.requestId).length === 1 && auditsFor(hanging.requestId).length === 2 && new Set(writesFor(COMPANY_C).slice(logCBeforeAsync).map((entry) => entry.params?.[1])).size === 1);
globalThis.fetch = workerFetch;

console.log(`\n${failures === 0 ? "REHEARSAL PASSED" : `REHEARSAL FAILED — ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
