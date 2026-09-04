#!/usr/bin/env node
/**
 * TOG-681 §7 and TOG-930 ask for installed-artifact demonstrations:
 *
 *   - real invocation failures degrade a catalogue-present model, hysteresis
 *     prevents a one-sample flap, and sustained success recovers it;
 *   - the halt gate refuses non-pinned work.
 *
 * `tests/job-health.spec.ts` already asserts both. This script is not a second
 * copy of those assertions — it differs in the two ways that matter for
 * evidence:
 *
 *   1  it runs the INSTALLED artifact. The tests import `../src/worker.js`;
 *      this imports the worker out of a tarball extracted into a directory
 *      that has never held this plugin. A defect introduced by bundling —
 *      a job handler tree-shaken away, a manifest key renamed at build time —
 *      is invisible to a source test and fatal in production.
 *   2  it emits a transcript. A reviewer reading `PASS` learns that someone's
 *      expectation held; a reviewer reading the model id before and after
 *      learns what the system did. §7 asks for the second thing.
 *
 * The upstream is a fake under this script's control, because "disable an
 * account" against the real gateway would mean disabling the owner's real
 * account. What is faked is the upstream's ANSWER; the job scheduler entry,
 * the health overlay, the selection path and the budget ledger are all the
 * shipped code, reached through the SDK's host harness.
 *
 * Exits non-zero if either demonstration does not reproduce.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPANY = "11111111-1111-4111-8111-111111111111";

let failures = 0;
function check(ok, label, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n      ${detail}` : ""}`);
}
function say(line = "") {
  console.log(line);
}

// --- install the artifact into a clean directory ----------------------------

const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const work = mkdtempSync(join(scratch, "demo-"));
const packDir = join(work, "pack");
mkdirSync(packDir, { recursive: true });

const packed = execFileSync("npm", ["pack", "--pack-destination", packDir, "--silent"], {
  cwd: root, encoding: "utf8",
}).trim().split("\n").pop().trim();

const install = join(work, "install");
mkdirSync(install, { recursive: true });
execFileSync("npm", ["init", "-y"], { cwd: install, stdio: "pipe" });
execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts", join(packDir, packed)], {
  cwd: install, stdio: "pipe",
  env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
});

const pkgRoot = join(install, "node_modules", "@togetherweown", "paperclip-model-router");
const { createPlugin } = await import(pathToFileURL(join(pkgRoot, "dist", "worker.js")).href);
const manifest = (await import(pathToFileURL(join(pkgRoot, "dist", "manifest.js")).href)).default;
const { createTestHarness } = await import("@paperclipai/plugin-sdk/testing");

const JOB_KEY = manifest.jobs[0].jobKey;
const config = JSON.parse(readFileSync(join(root, "tests", "fixtures", "company-a.json"), "utf8"));

say(`artifact  ${packed}`);
say(`installed ${pkgRoot}`);
say(`job key   ${JOB_KEY} (read from the INSTALLED manifest)`);

/**
 * A harness whose upstream catalogue this script controls. `catalogue` is the
 * account's answer to "what models can you serve" — taking an id out of it is
 * exactly what disabling that model upstream looks like from here.
 */
async function harness(catalogue, invokeResponse = null) {
  const h = createTestHarness({ manifest, config: {} });
  h.seed({ companies: [{ id: COMPANY, name: "A" }] });
  h.ctx.config = { async get() { return structuredClone(config); } };
  h.ctx.secrets = { async resolve() { return "credential"; } };
  const calls = [];
  h.ctx.http = {
    async fetch(url, init) {
      calls.push(String(url));
      if (String(url).endsWith("/v1/models")) {
        return new Response(JSON.stringify({ data: catalogue.map((id) => ({ id })) }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      const body = JSON.parse(String(init.body));
      if (invokeResponse) return invokeResponse(body.model);
      return new Response(JSON.stringify({
        id: "chatcmpl-1", object: "chat.completion", model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  const { definition } = createPlugin();
  await definition.setup(h.ctx);
  return { h, calls };
}

const INVOCATION = {
  task: { taskClass: "implementation" },
  messages: [{ role: "user", content: "hello" }],
  maxOutputTokens: 100,
};
const ALL = ["qwen3-coder", "minimax-m2.5", "claude-sonnet-5"];

async function invoke(h, extra = {}) {
  return h.performAction("invoke", { ...INVOCATION, ...extra }, { companyId: COMPANY });
}

// === DEMONSTRATION 1 — invocation-backed model health ======================

say(`\n${"=".repeat(74)}\nDEMONSTRATION 1 — repeated invocation failure degrades and reroutes\n${"=".repeat(74)}\n`);

let failSelected = true;
const routed = await harness(ALL, (modelId) => {
  if (modelId === "minimax-m2.5" && failSelected) return new Response("{}", { status: 403 });
  return new Response(JSON.stringify({
    id: "chatcmpl-1", object: "chat.completion", model: modelId,
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 },
  }), { status: 200, headers: { "content-type": "application/json" } });
});
await routed.h.runJob(JOB_KEY);
const catalogueHealth = routed.h.getState({ scopeKind: "company", scopeId: COMPANY, stateKey: "model-health" });
say(`  catalogue lists all models; minimax verdict -> ${catalogueHealth?.["minimax-m2.5"]?.verdict}`);
check(
  catalogueHealth?.["minimax-m2.5"]?.verdict === "unknown",
  "catalogue presence alone does not report healthy",
  `verdict=${catalogueHealth?.["minimax-m2.5"]?.verdict}`,
);

const firstFailure = await invoke(routed.h);
let health = routed.h.getState({ scopeKind: "company", scopeId: COMPANY, stateKey: "model-health" });
say(`  invocation failure 1 -> selected=${firstFailure.decision.modelId}, verdict=${health?.["minimax-m2.5"]?.verdict}`);
check(
  firstFailure.outcome === "error" && health?.["minimax-m2.5"]?.verdict === "unknown",
  "one failed invocation is evidence, not an immediate verdict",
);

const secondFailure = await invoke(routed.h);
health = routed.h.getState({ scopeKind: "company", scopeId: COMPANY, stateKey: "model-health" });
say(`  invocation failure 2 -> selected=${secondFailure.decision.modelId}, verdict=${health?.["minimax-m2.5"]?.verdict}`);
check(
  secondFailure.outcome === "error" && health?.["minimax-m2.5"]?.verdict === "degraded",
  "two consecutive failures degrade the catalogue-present model",
);

const rerouted = await invoke(routed.h);
say(`  next selection       -> ${rerouted.decision.modelId}`);
check(
  rerouted.decision.modelId === "claude-sonnet-5",
  "a healthier qualifying model outranks the degraded lane",
  `minimax-m2.5 -> ${rerouted.decision.modelId}`,
);

// Age the degraded timestamp, then let the scheduled catalogue pass open the
// probation window. This is deterministic and sends no live provider traffic.
health = routed.h.getState({ scopeKind: "company", scopeId: COMPANY, stateKey: "model-health" });
health["minimax-m2.5"] = {
  ...health["minimax-m2.5"],
  degradedAt: "2026-08-30T00:00:00.000Z",
};
await routed.h.ctx.state.set(
  { scopeKind: "company", scopeId: COMPANY, stateKey: "model-health" },
  health,
);
failSelected = false;
await routed.h.runJob(JOB_KEY);
health = routed.h.getState({ scopeKind: "company", scopeId: COMPANY, stateKey: "model-health" });
say(`  cooldown + catalogue -> verdict=${health?.["minimax-m2.5"]?.verdict}`);
check(
  health?.["minimax-m2.5"]?.verdict === "unknown",
  "degraded cooldown opens an automatic probation path",
);

await invoke(routed.h);
health = routed.h.getState({ scopeKind: "company", scopeId: COMPANY, stateKey: "model-health" });
check(
  health?.["minimax-m2.5"]?.verdict === "unknown",
  "one successful probation call does not oscillate straight to healthy",
);
await invoke(routed.h);
health = routed.h.getState({ scopeKind: "company", scopeId: COMPANY, stateKey: "model-health" });
say(`  successful calls x2  -> verdict=${health?.["minimax-m2.5"]?.verdict}\n`);
check(
  health?.["minimax-m2.5"]?.verdict === "healthy",
  "two consecutive successful invocations recover the model without manual intervention",
);

// === DEMONSTRATION 2 — the halt gate refuses non-pinned work ================

say(`\n${"=".repeat(74)}\nDEMONSTRATION 2 — the halt gate refuses non-pinned work on measured spend\n${"=".repeat(74)}\n`);

const budget = config.budget ?? {};
const cap = budget.monthlyCapUsd;
const haltAt = cap * budget.haltFraction;
if (!Number.isFinite(haltAt) || haltAt <= 0) {
  // A demonstration that seeds a ledger to NaN reports "no halt" and reads as
  // a passing budget gate. Fail loudly on a fixture that cannot express one.
  console.error(`fixture company-a has no usable budget cap: monthlyCapUsd=${cap} haltFraction=${budget.haltFraction}`);
  process.exit(2);
}
const { h: spender } = await harness(ALL);
const now = new Date();
const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

say(`  company cap        $${cap} / month, haltFraction ${budget.haltFraction} => halt at $${haltAt}`);

// Seed the ledger just under the line, then let one REAL invocation carry it
// over. The gate must fire on spend the router itself measured and recorded,
// not on a number handed to it.
await spender.ctx.state.set(
  { scopeKind: "company", scopeId: COMPANY, stateKey: "spend-ledger" },
  { month, totalUsd: haltAt - 0.0005, invocations: 1 },
);
say(`  ledger seeded to   $${(haltAt - 0.0005).toFixed(4)}  (just under the halt line)`);

const carrying = await invoke(spender);
const ledger = spender.getState({ scopeKind: "company", scopeId: COMPANY, stateKey: "spend-ledger" });
say(`  one real call      -> ${carrying.decision.modelId}, outcome=${carrying.outcome}`);
say(`  ledger now         $${ledger.totalUsd.toFixed(4)}  (accrued from reported usage)`);
check(
  carrying.outcome === "completed" && ledger.totalUsd > haltAt,
  "a real invocation accrues its measured cost and carries the ledger over the halt line",
  `$${(haltAt - 0.0005).toFixed(4)} -> $${ledger.totalUsd.toFixed(4)}, halt at $${haltAt}`,
);

const httpBefore = spender.ctx.http.fetch;
let upstreamCallsDuringRefusal = 0;
spender.ctx.http.fetch = async (...args) => {
  upstreamCallsDuringRefusal += 1;
  return httpBefore(...args);
};

const refused = await invoke(spender);
say(`\n  next non-pinned call -> outcome=${refused.outcome}, budget gate=${refused.decision.gates?.budget}`);
check(
  refused.outcome === "no-eligible-model" && refused.decision.gates?.budget === "halt",
  "the halt gate REFUSES the next non-pinned call",
  `outcome=${refused.outcome} gate=${refused.decision.gates?.budget}`,
);
check(
  upstreamCallsDuringRefusal === 0,
  "the refusal costs nothing — no upstream request is made",
  `${upstreamCallsDuringRefusal} upstream call(s) during the refused invocation`,
);

const pinned = await invoke(spender, {
  task: { ...INVOCATION.task, pinnedModelId: "minimax-m2.5", pinReason: "operator pin" },
});
say(`  an explicitly pinned call -> outcome=${pinned.outcome}`);
check(
  pinned.outcome === "completed",
  "halt stops discretionary spend, not work an operator explicitly pinned",
  `pinned outcome=${pinned.outcome}`,
);

say(`\n${failures === 0 ? "BOTH DEMONSTRATIONS REPRODUCED" : `${failures} CHECK(S) FAILED`}`);
say(`against the installed artifact ${packed}\n`);

if (!process.env.PAPERCLIP_KEEP_SCRATCH) rmSync(work, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
