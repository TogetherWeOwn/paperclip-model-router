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
harness.ctx.secrets = {
  async resolve(ref, options) {
    secretCalls.push({ secretId: ref.secretId, companyId: options?.companyId, configPath: options?.configPath });
    return options?.companyId === COMPANY_A ? "runtime-a" : "runtime-b";
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
const resultB = await harness.performAction("invoke", invocation, { companyId: COMPANY_B });
check("company A completes through its OpenAI-compatible upstream", resultA.outcome === "completed" && resultA.response.upstream.protocol === "openai-chat-completions" && resultA.response.modelId === "minimax-m2.5");
check("company B completes through its Anthropic-compatible upstream", resultB.outcome === "completed" && resultB.response.upstream.protocol === "anthropic-messages" && resultB.response.modelId === "gpt-4.1");
check("the same invocation selects differently only because company config differs", resultA.response.modelId !== resultB.response.modelId);
check("each company uses its own base URL", httpCalls.map((call) => call.url).join("|") === "https://company-a.example/api/v1/chat/completions|https://company-b.example/compatible/v1/messages");
check("each call disables redirects", httpCalls.every((call) => call.redirect === "manual"));
check("each call sends Accept-Encoding identity", httpCalls.every((call) => Object.entries(call.headers).some(([name, value]) => name.toLowerCase() === "accept-encoding" && value === "identity")));
check("secret resolution is call-time and company-scoped", secretCalls.length === 2 && secretCalls[0].companyId === COMPANY_A && secretCalls[1].companyId === COMPANY_B && secretCalls.every((call) => call.configPath === "upstream.credentialSecretRef"));

const rule0 = await harness.performAction("invoke", {
  task: { taskClass: "mechanical", summary: "lint the repo" },
  messages: [{ role: "user", content: "lint" }],
  maxOutputTokens: 10,
}, { companyId: COMPANY_A });
check("Rule 0 makes no upstream or secret request", rule0.outcome === "no-model-needed" && httpCalls.length === 2 && secretCalls.length === 2);

const logA = harness.getState({ scopeKind: "company", scopeId: COMPANY_A, stateKey: "decision-log" }) ?? [];
const logB = harness.getState({ scopeKind: "company", scopeId: COMPANY_B, stateKey: "decision-log" }) ?? [];
check("decision records are company-scoped", logA.length === 2 && logB.length === 1);
check("decision records contain no request content or credential", !JSON.stringify([logA, logB]).includes("hello") && !JSON.stringify([logA, logB]).includes("runtime-a") && !JSON.stringify([logA, logB]).includes("runtime-b"));

console.log(`\n${failures === 0 ? "REHEARSAL PASSED" : `REHEARSAL FAILED — ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
