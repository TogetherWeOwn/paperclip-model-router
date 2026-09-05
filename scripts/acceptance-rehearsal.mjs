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

console.log(`\n${failures === 0 ? "REHEARSAL PASSED" : `REHEARSAL FAILED — ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
