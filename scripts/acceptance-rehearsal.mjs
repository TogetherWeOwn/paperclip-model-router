#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMPANY_A = process.env.COMPANY_A_ID ?? "11111111-1111-4111-8111-111111111111";
const COMPANY_B = process.env.COMPANY_B_ID ?? "22222222-2222-4222-8222-222222222222";
const configs = new Map([
  [COMPANY_A, JSON.parse(readFileSync(join(root, "tests/fixtures/company-a.json"), "utf8"))],
  [COMPANY_B, JSON.parse(readFileSync(join(root, "tests/fixtures/company-b.json"), "utf8"))],
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
let secretSequence = 0;
harness.ctx.secrets = {
  async resolve(ref, options) {
    secretSequence += 1;
    secretCalls.push({ secretId: ref.secretId, companyId: options?.companyId, configPath: options?.configPath });
    return `runtime-${options?.companyId === COMPANY_A ? "a" : "b"}-${secretSequence}`;
  },
};
const httpCalls = [];
harness.ctx.http = {
  async fetch(url, init) {
    const parsed = JSON.parse(String(init?.body));
    httpCalls.push({ url: String(url), headers: init?.headers, model: parsed.model, redirect: init?.redirect });
    if (String(url).includes("company-a")) {
      return new Response(JSON.stringify({ id: "chatcmpl-a", object: "chat.completion", model: "echo-a", choices: [{ index: 0, message: { role: "assistant", content: "company a" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "request-a" } });
    }
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
check("the built bundle contains no company UUID", !workerSource.includes(COMPANY_A) && !workerSource.includes(COMPANY_B));
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

const logA = harness.getState({ scopeKind: "company", scopeId: COMPANY_A, stateKey: "decision-log" }) ?? [];
const logB = harness.getState({ scopeKind: "company", scopeId: COMPANY_B, stateKey: "decision-log" }) ?? [];
check("decision records are company-scoped", logA.length === 3 && logB.length === 1);
check("decision records contain no request content or credential", !JSON.stringify([logA, logB]).includes("hello") && !JSON.stringify([logA, logB]).includes("runtime-a") && !JSON.stringify([logA, logB]).includes("runtime-b"));

// --- Evidence 7: usage-aware router v2, simulated and credential-free -------

console.log("\nEVIDENCE 7 — usage-aware v2 shadows and enforces across two capacity lanes");

const capacitySources = [
  {
    id: "simulated-subscription",
    statusUrl: "https://subscription-capacity.invalid/status",
    apiKeySecretRef: null,
    providers: ["subscription"],
    accountIdFields: ["account"],
    healthFields: ["status"],
    windows: [{ name: "five-hour", utilizationFields: ["used5h"], resetFields: ["resets5hAt"] }],
  },
  {
    id: "simulated-available",
    statusUrl: "https://available-capacity.invalid/status",
    apiKeySecretRef: null,
    providers: ["available"],
    accountIdFields: ["account"],
    healthFields: ["status"],
    windows: [{ name: "five-hour", utilizationFields: ["used5h"], resetFields: ["resets5hAt"] }],
  },
];
const capacityConfig = {
  ...structuredClone(configs.get(COMPANY_A)),
  routing: { ...configs.get(COMPANY_A).routing, stickyModelWithinIssue: false },
  models: [
    { id: "subscription-model", tier: "standard", quality: 80, costPerMTokIn: 0, costPerMTokOut: 0, contextWindow: 200000, capabilities: ["tools"], providers: ["subscription"], enabled: true },
    { id: "available-model", tier: "standard", quality: 80, costPerMTokIn: 1, costPerMTokOut: 4, contextWindow: 200000, capabilities: ["tools"], providers: ["available"], enabled: true },
    { id: "cheap-below-floor", tier: "small", quality: 30, costPerMTokIn: 0, costPerMTokOut: 0, contextWindow: 200000, capabilities: ["tools"], providers: ["available"], enabled: true },
  ],
  taskClasses: [{ key: "implementation", qualityFloor: 70 }],
  capacityRouting: { enabled: true, mode: "shadow", unknownTelemetry: "fail-closed", sources: capacitySources },
};
const capacityPayloads = new Map([
  [capacitySources[0].statusUrl, { accounts: [{ account: "scarce-subscription", status: "allowed", used5h: 0.98, resets5hAt: "2026-09-04T18:00:00Z" }] }],
  [capacitySources[1].statusUrl, { accounts: [{ account: "available-capacity", status: "allowed", used5h: 0.2, resets5hAt: "2026-09-05T12:00:00Z" }] }],
]);
const capacityConfigs = new Map([[COMPANY_A, capacityConfig]]);
const capacityHarness = createTestHarness({ manifest, config: {} });
capacityHarness.ctx.config = { async get(companyId) { return structuredClone(capacityConfigs.get(String(companyId))); } };
capacityHarness.ctx.secrets = { async resolve() { return "capacity-rehearsal-secret"; } };
const capacityHttpCalls = [];
capacityHarness.ctx.http = {
  async fetch(url, init) {
    capacityHttpCalls.push({ url: String(url), method: init?.method });
    const payload = capacityPayloads.get(String(url));
    if (payload) return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ id: "chatcmpl-capacity", object: "chat.completion", model: "echo", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
  },
};
const { definition: capacityWorker } = createPlugin();
await capacityWorker.setup(capacityHarness.ctx);
const capacityInvocation = { task: { taskClass: "implementation" }, messages: [{ role: "user", content: "hello" }], maxOutputTokens: 100 };
const shadow = await capacityHarness.performAction("invoke", capacityInvocation, { companyId: COMPANY_A });
check("shadow mode records a healthier alternative without changing invocation", shadow.outcome === "completed" && shadow.decision.modelId === "subscription-model" && shadow.decision.capacity.shadowModelId === "available-model", `selected=${shadow.decision.modelId} shadow=${shadow.decision.capacity.shadowModelId}`);
check("capacity telemetry adds two GETs and inference remains exactly one POST", capacityHttpCalls.filter((call) => call.method === "GET").length === 2 && capacityHttpCalls.filter((call) => call.method === "POST").length === 1);

capacityConfigs.set(COMPANY_A, { ...capacityConfig, capacityRouting: { ...capacityConfig.capacityRouting, mode: "enforce" } });
capacityHttpCalls.length = 0;
const enforced = await capacityHarness.performAction("invoke", capacityInvocation, { companyId: COMPANY_A });
check("enforce mode invokes the healthier quality-qualified model", enforced.outcome === "completed" && enforced.decision.modelId === "available-model" && capacityHttpCalls.filter((call) => call.method === "POST").length === 1, `selected=${enforced.decision.modelId}`);

const noTelemetryHarness = createTestHarness({ manifest, config: {} });
noTelemetryHarness.ctx.config = capacityHarness.ctx.config;
noTelemetryHarness.ctx.secrets = capacityHarness.ctx.secrets;
let outageInferenceCalls = 0;
noTelemetryHarness.ctx.http = { async fetch(url, init) { if (init?.method === "GET") throw new Error("simulated telemetry outage"); outageInferenceCalls += 1; return new Response("{}"); } };
const { definition: noTelemetryWorker } = createPlugin();
await noTelemetryWorker.setup(noTelemetryHarness.ctx);
const noTelemetry = await noTelemetryHarness.performAction("invoke", capacityInvocation, { companyId: COMPANY_A });
check("enforcement fails closed before inference when telemetry is unavailable", noTelemetry.outcome === "no-eligible-model" && outageInferenceCalls === 0, `outcome=${noTelemetry.outcome}`);

console.log(`\n${failures === 0 ? "REHEARSAL PASSED" : `REHEARSAL FAILED — ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
