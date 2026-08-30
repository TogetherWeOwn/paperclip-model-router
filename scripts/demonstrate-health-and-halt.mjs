#!/usr/bin/env node
/**
 * TOG-681 §7 asks for two LIVE demonstrations, not two green tests:
 *
 *   - disabling an upstream account causes the scheduled job to flip `enabled`
 *     and the next selection to route elsewhere;
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
async function harness(catalogue) {
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

// === DEMONSTRATION 1 — an upstream model goes dark ==========================

say(`\n${"=".repeat(74)}\nDEMONSTRATION 1 — disabling a model upstream reroutes the next selection\n${"=".repeat(74)}\n`);

const healthy = await harness(ALL);
const beforeId = (await invoke(healthy.h)).decision.modelId;
say(`  upstream catalogue: ${ALL.join(", ")}`);
say(`  selection          -> ${beforeId}   (cheapest clearing the quality floor)`);
check(beforeId === "minimax-m2.5", "the cheapest qualifying model is selected while everything is healthy", `selected ${beforeId}`);

// The account stops serving it. Everything else about the config is unchanged.
const remaining = ALL.filter((id) => id !== beforeId);
const dark = await harness(remaining);
say(`\n  ${beforeId} is disabled on the upstream account.`);
say(`  upstream catalogue: ${remaining.join(", ")}\n`);

await dark.h.runJob(JOB_KEY);
const afterOneRun = (await invoke(dark.h)).decision.modelId;
say(`  scheduled job run 1 -> selection still ${afterOneRun}`);
check(
  afterOneRun === beforeId,
  "one absence is a strike, not a verdict — the table is unchanged after a single run",
  "a flap must not black out a model on one reading",
);

await dark.h.runJob(JOB_KEY);
const health = dark.h.getState({ scopeKind: "company", scopeId: COMPANY, stateKey: "model-health" });
const verdict = health?.[beforeId]?.verdict;
const afterTwoRuns = (await invoke(dark.h)).decision.modelId;
say(`  scheduled job run 2 -> ${beforeId} verdict="${verdict}"`);
say(`  selection           -> ${afterTwoRuns}   (rerouted)\n`);

check(verdict === "dead", `the job flipped ${beforeId} out of service`, `verdict=${verdict}`);
check(
  afterTwoRuns !== beforeId,
  "the next selection routes elsewhere instead of failing forever against a dead model",
  `${beforeId} -> ${afterTwoRuns}`,
);
const messages = dark.h.activity.map((entry) => entry.message);
check(
  messages.some((message) => message.includes(`took ${beforeId} out of service`)),
  "the flip reached the board through activity.log.write",
  messages.join("\n      ") || "(no activity recorded)",
);

// An indeterminate probe must change nothing — blacking out the whole table
// on a 503 would be strictly worse than the defect being fixed.
const broken = await harness(ALL);
broken.h.ctx.http.fetch = async (url, init) => {
  if (String(url).endsWith("/v1/models")) return new Response("{}", { status: 503 });
  return new Response(JSON.stringify({
    id: "c", object: "chat.completion", model: JSON.parse(String(init.body)).model,
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { "content-type": "application/json" } });
};
await broken.h.runJob(JOB_KEY);
await broken.h.runJob(JOB_KEY);
const brokenState = broken.h.getState({ scopeKind: "company", scopeId: COMPANY, stateKey: "model-health" });
say(`  upstream returns 503 to the catalogue probe, twice`);
say(`  health overlay      -> ${brokenState === undefined ? "never written" : JSON.stringify(brokenState)}`);
say(`  selection           -> ${(await invoke(broken.h)).decision.modelId}   (unchanged)\n`);
check(
  brokenState === undefined && broken.h.activity.length === 0,
  "an indeterminate probe changes nothing rather than blacking out the table",
  "a 503 from the catalogue is not evidence that a model is dead",
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
