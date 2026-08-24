#!/usr/bin/env node
/**
 * TOG-156 acceptance rehearsal — the five evidence items, offline.
 *
 * The acceptance criterion is empirical: ONE install must serve a SECOND
 * company correctly with no code edits. Proving that for real needs an
 * operator (`POST /api/plugins/install` is instance-level and restarts every
 * company's worker). This script proves everything about that claim which does
 * NOT need instance authority, so the operator's live run is a diff against a
 * known-good transcript rather than an open question.
 *
 * What makes this different from `npm test`:
 *
 *   - It runs the BUILT artifact — `dist/worker.js`, the file that ships in the
 *     tarball — not `src/`. The tests import `src/`; the host loads `dist/`.
 *   - It runs ONE `createPlugin()` and ONE `setup(ctx)` for BOTH companies,
 *     which is the actual production topology: one worker process, one context,
 *     every read company-scoped through `ctx.config.get(companyId)`. Two
 *     separate harnesses cannot show that a shared worker keeps companies apart.
 *   - It emits the five numbered evidence items from TOG-227 in the order the
 *     runbook captures them, so live output can be compared line for line.
 *
 * What it does NOT prove, and no offline script can:
 *
 *   - that `paperclipai plugin install` succeeds on this host,
 *   - that the host's config store round-trips a POSTed config,
 *   - that the live HTTP routes are reachable and authorized.
 *
 * Those are steps 2-4 of the operator runbook. Everything downstream of them is
 * what this rehearses.
 *
 * Two host services are stubbed, and only two:
 *
 *   - `ctx.config.get(companyId)` — the SDK test harness returns one config
 *     regardless of company, which cannot express "two companies". Replaced
 *     with a per-company map, which is what the host's (pluginId, companyId)
 *     config table is.
 *   - `ctx.http.fetch` — so the teamclaude quota gate is deterministic offline.
 *     The live run reads the real endpoint.
 *
 * Usage:
 *   node scripts/acceptance-rehearsal.mjs [--json <path>]
 *
 * Env:
 *   COMPANY_A_ID / COMPANY_B_ID   label the two companies with real ids
 *   FIXTURE_A    / FIXTURE_B      use other configs than the shipped examples
 *
 * Exits non-zero if any evidence item fails.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

const COMPANY_A = process.env.COMPANY_A_ID ?? "11111111-1111-4111-8111-111111111111";
const COMPANY_B = process.env.COMPANY_B_ID ?? "22222222-2222-4222-8222-222222222222";
const FIXTURE_A = process.env.FIXTURE_A ?? "tests/fixtures/company-a.json";
const FIXTURE_B = process.env.FIXTURE_B ?? "tests/fixtures/company-b.json";

// Company B's scenario is "a company that enabled Claude PAYG", which is now an
// OWNER-level decision as well as a company one: `providers.claudePaygEnabled`
// only takes effect alongside this instance unlock. The rehearsal therefore
// models an instance where the owner granted it — otherwise B's config would be
// refused and the two-company evidence would be measuring the refusal instead of
// the per-company divergence it exists to show.
//
// Set BEFORE `dist/worker.js` is imported, and the locked case is asserted
// explicitly as its own evidence item rather than left implicit.
// The operator's LIVE run does NOT set this. If the live instance has not
// unlocked PAYG, company B's config is refused at write time — expected, and
// the runbook says so.
process.env.MODEL_ROUTER_CLAUDE_PAYG_UNLOCK ??= "1";

// Likewise, every Claude evidence item below asserts what a WORKING Claude lane
// does, and a bare Claude id only means "teamclaude" once an OmniRoute combo
// says so. TOG-294 measured the alternative on the live router: no teamclaude
// combo exists, and a bare `claude-sonnet-5` was silently resolved to
// `anthropic/claude-sonnet-5` and served. So the rehearsal models a deployed
// instance, and says so in its transcript rather than leaving it implicit.
//
// The operator's LIVE run must NOT set this by hand. If the live instance has
// not deployed the teamclaude combos, the Claude evidence items are SUPPOSED to
// fail — that failure is the rehearsal correctly reporting that the lane is not
// there yet. Confirm with `scripts/claude-lane-preflight.sh` first.
process.env.MODEL_ROUTER_CLAUDE_COMBO_ARMED ??= "1";

// --- reporting ---------------------------------------------------------------

const results = [];
let failures = 0;

function section(title) {
  console.log(`\n${"=".repeat(74)}\n${title}\n${"=".repeat(74)}`);
}

function check(label, ok, detail = "") {
  if (!ok) failures += 1;
  results.push({ label, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
}

function show(label, value) {
  console.log(`  ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

function readJson(relativeOrAbsolute) {
  const path = isAbsolute(relativeOrAbsolute)
    ? relativeOrAbsolute
    : join(repo, relativeOrAbsolute);
  return JSON.parse(readFileSync(path, "utf8"));
}

// --- the built artifact, loaded exactly once ---------------------------------

const manifest = (await import(pathToFileURL(join(repo, "dist/manifest.js")).href)).default;
const workerModule = await import(pathToFileURL(join(repo, "dist/worker.js")).href);
const builtWorkerSource = readFileSync(join(repo, "dist/worker.js"), "utf8");
const pkg = readJson("package.json");

/**
 * The host's per-(pluginId, companyId) config table. The whole acceptance
 * criterion is that this map — and nothing else — is what differs per company.
 */
const configs = new Map([
  [COMPANY_A, readJson(FIXTURE_A)],
  [COMPANY_B, readJson(FIXTURE_B)],
]);

const quotaUtilization = { value: 0.10 };
const httpCalls = [];

const harness = createTestHarness({ manifest, config: {} });
const ctx = harness.ctx;

ctx.config = {
  async get(companyId) {
    const stored = configs.get(String(companyId));
    if (!stored) throw new Error(`no config row for company ${companyId}`);
    return structuredClone(stored);
  },
};

ctx.http = {
  async fetch(url, init) {
    httpCalls.push({ url: String(url), method: init?.method ?? "GET" });
    const payload = {
      accounts: [
        { unified5h: quotaUtilization.value, unified7d: quotaUtilization.value / 2 },
      ],
    };
    return {
      status: 200,
      async json() {
        return payload;
      },
    };
  },
};

// ONE plugin instance, ONE setup, for BOTH companies — the production topology.
const { definition } = workerModule.createPlugin();
let setupCalls = 0;
await definition.setup(ctx);
setupCalls += 1;

const route = (companyId, body, issueId = "issue-rehearsal") =>
  definition.onApiRequest({
    routeKey: "route-issue",
    method: "POST",
    path: `/issues/${issueId}/route`,
    params: { issueId },
    query: {},
    body,
    actor: { actorType: "agent", actorId: "rehearsal" },
    companyId,
    headers: {},
  });

const effectiveConfig = (companyId) =>
  definition.onApiRequest({
    routeKey: "company-config",
    method: "GET",
    path: "/effective-config",
    params: {},
    query: { companyId },
    body: null,
    actor: { actorType: "agent", actorId: "rehearsal" },
    companyId,
    headers: {},
  });

/** The full decision path: quota read, budget, stickiness, decision log, metrics. */
const routeAction = (companyId, params) =>
  harness.performAction("route", { companyId, ...params });

// --- Evidence 1: one install, one version ------------------------------------

section("EVIDENCE 1 — one install, one version, one worker serving both companies");

show("plugin id", manifest.id);
show("version", manifest.version);
show("apiVersion", manifest.apiVersion);
show("worker entrypoint", manifest.entrypoints.worker);
show("capabilities", manifest.capabilities.join(", "));

check(
  "the built manifest version matches package.json",
  manifest.version === pkg.version,
  `manifest=${manifest.version} package.json=${pkg.version}`,
);
check(
  "the manifest declares exactly one worker entrypoint and no per-company install surface",
  Object.keys(manifest.entrypoints).length === 1 && manifest.entrypoints.worker === "./dist/worker.js",
  JSON.stringify(manifest.entrypoints),
);
check(
  "one createPlugin() and one setup(ctx) serve both companies",
  setupCalls === 1,
  `setup called ${setupCalls} time(s) for ${configs.size} companies`,
);

// "No code edits between the two companies" has to be mechanically checkable,
// not merely asserted in prose. The shipped bundle must not name a company.
const uuidsInBundle = [
  ...new Set(builtWorkerSource.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []),
];
check(
  "the built worker bundle contains no company UUID",
  uuidsInBundle.length === 0,
  uuidsInBundle.length === 0 ? "" : `found: ${uuidsInBundle.join(", ")}`,
);
// Every comparison of a companyId against a string literal, minus the harmless
// `typeof x.companyId === "string"` guards. Anything left is a company branch.
const companyBranches = (
  builtWorkerSource.match(/(typeof\s+)?[\w.]*companyId\s*[=!]==?\s*"[^"]*"/g) ?? []
).filter((match) => !match.startsWith("typeof "));
check(
  "the built worker bundle branches on no company id literal",
  companyBranches.length === 0,
  companyBranches.length === 0 ? "" : `found: ${companyBranches.join(", ")}`,
);

// --- Evidence 2: effective config differs per company ------------------------

section("EVIDENCE 2 — GET /effective-config resolves differently for each company");

const configA = await effectiveConfig(COMPANY_A);
const configB = await effectiveConfig(COMPANY_B);

check("effective-config answers 200 for company A", configA.status === 200, `status=${configA.status}`);
check("effective-config answers 200 for company B", configB.status === 200, `status=${configB.status}`);

const A = configA.body.config;
const B = configB.body.config;

check(
  "both companies are served by the same plugin version",
  configA.body.version === configB.body.version && configA.body.version === manifest.version,
  `A=${configA.body.version} B=${configB.body.version}`,
);

/** Every company-specific dimension TOG-227 names must actually differ. */
const dimensions = [
  ["model table", () => A.models.map((m) => m.id).join(","), () => B.models.map((m) => m.id).join(",")],
  ["implementation quality floor", () => floorFor(A, "implementation"), () => floorFor(B, "implementation")],
  ["permitted providers", () => A.providers.permitted.join(","), () => B.providers.permitted.join(",")],
  ["provider preference", () => A.providers.preferenceOrder.join(","), () => B.providers.preferenceOrder.join(",")],
  ["claudePaygEnabled", () => A.providers.claudePaygEnabled, () => B.providers.claudePaygEnabled],
  ["monthly budget cap (USD)", () => A.budget.monthlyCapUsd, () => B.budget.monthlyCapUsd],
  ["budget halt fraction", () => A.budget.haltFraction, () => B.budget.haltFraction],
  ["quota gate enabled", () => A.quotaGate.enabled, () => B.quotaGate.enabled],
  ["tiering signal weights", () => JSON.stringify(A.tiering.signalWeights), () => JSON.stringify(B.tiering.signalWeights)],
  ["tiering thresholds", () => JSON.stringify(A.tiering.thresholds), () => JSON.stringify(B.tiering.thresholds)],
  ["default tier", () => A.tiering.defaultTier, () => B.tiering.defaultTier],
  ["rule 0 patterns", () => A.rule0.deterministicPatterns.map((p) => p.pattern).join(" | "), () => B.rule0.deterministicPatterns.map((p) => p.pattern).join(" | ")],
  ["fallback model", () => String(A.routing.fallbackModelId), () => String(B.routing.fallbackModelId)],
  ["sticky within issue", () => A.routing.stickyModelWithinIssue, () => B.routing.stickyModelWithinIssue],
];

function floorFor(config, key) {
  return config.taskClasses.find((entry) => entry.key === key)?.qualityFloor ?? null;
}

console.log(`\n  ${"dimension".padEnd(30)} ${"company A".padEnd(38)} company B`);
console.log(`  ${"-".repeat(30)} ${"-".repeat(38)} ${"-".repeat(38)}`);
for (const [label, readA, readB] of dimensions) {
  const left = String(readA());
  const right = String(readB());
  console.log(`  ${label.padEnd(30)} ${left.slice(0, 37).padEnd(38)} ${right.slice(0, 37)}`);
}
console.log("");

const identical = dimensions.filter(([, readA, readB]) => String(readA()) === String(readB()));
check(
  "every company-specific dimension resolves differently",
  identical.length === 0,
  identical.length === 0 ? `${dimensions.length} dimensions, all different` : `identical: ${identical.map(([l]) => l).join(", ")}`,
);

section("EVIDENCE 2b — what the operator will see on each config write");

for (const [label, companyId] of [["A", COMPANY_A], ["B", COMPANY_B]]) {
  const verdict = await definition.onValidateConfig(configs.get(companyId));
  console.log(`  company ${label}: ok=${verdict.ok}`);
  for (const error of verdict.errors) console.log(`    ERROR   ${error}`);
  for (const warning of verdict.warnings) console.log(`    WARNING ${warning}`);
  check(`company ${label}'s config is accepted by onValidateConfig`, verdict.ok, verdict.errors.join("; "));
}

// Owner rule 1: enabling Claude PAYG must be loud, never silent.
const paygVerdict = await definition.onValidateConfig({
  ...configs.get(COMPANY_A),
  providers: { ...configs.get(COMPANY_A).providers, claudePaygEnabled: true },
});
check(
  "turning Claude PAYG on produces a loud warning at config-write time",
  paygVerdict.warnings.some((w) => w.includes("pay-as-you-go is ENABLED")),
  paygVerdict.warnings.join("; "),
);

// ...and the other half of that switch: on an instance the owner has NOT
// unlocked, the identical company config is refused rather than warned about.
// `resolveConfig` reads the environment per call, so dropping the variable for
// the length of this check is enough to model the locked instance.
{
  const unlock = process.env.MODEL_ROUTER_CLAUDE_PAYG_UNLOCK;
  delete process.env.MODEL_ROUTER_CLAUDE_PAYG_UNLOCK;
  let lockedVerdict;
  try {
    lockedVerdict = await definition.onValidateConfig(configs.get(COMPANY_B));
  } finally {
    process.env.MODEL_ROUTER_CLAUDE_PAYG_UNLOCK = unlock;
  }
  check(
    "a company cannot enable Claude PAYG on its own — the instance must unlock it",
    lockedVerdict.ok === false &&
      lockedVerdict.errors.some((e) => e.includes("not unlocked on this instance")),
    `ok=${lockedVerdict.ok} errors=${lockedVerdict.errors.join("; ")}`,
  );
}

// --- Evidence 3: identical request, different correct decisions --------------

section("EVIDENCE 3 — the identical routing request, two companies, two answers");

const implA = await route(COMPANY_A, { taskClass: "implementation" });
const implB = await route(COMPANY_B, { taskClass: "implementation" });

const decisionA = implA.body.decision;
const decisionB = implB.body.decision;

console.log("  POST /issues/:id/route  {\"taskClass\":\"implementation\"}\n");
for (const [label, decision] of [["A", decisionA], ["B", decisionB]]) {
  console.log(`  company ${label}: outcome=${decision.outcome} model=${decision.modelId} tier=${decision.requestedTier} floor=${decision.qualityFloor}`);
  for (const line of decision.trace) console.log(`      ${line}`);
  console.log("");
}

check(
  "the two companies choose different models for the same request",
  decisionA.modelId !== decisionB.modelId,
  `A=${decisionA.modelId} B=${decisionB.modelId}`,
);
check(
  "each choice comes from that company's own model table",
  A.models.some((m) => m.id === decisionA.modelId) && B.models.some((m) => m.id === decisionB.modelId),
);
check(
  "neither company can reach a model the other one has and it does not",
  !B.models.some((m) => m.id === decisionA.modelId),
  `A chose ${decisionA.modelId}; B's table is ${B.models.map((m) => m.id).join(",")}`,
);
check(
  "each choice clears that company's own quality floor",
  decisionA.qualityFloor === floorFor(A, "implementation") &&
    decisionB.qualityFloor === floorFor(B, "implementation") &&
    decisionA.qualityFloor !== decisionB.qualityFloor,
  `A floor=${decisionA.qualityFloor} B floor=${decisionB.qualityFloor}`,
);

// --- Evidence 4: the Claude block holds where PAYG is off --------------------

section("EVIDENCE 4 — the Claude block refuses a non-teamclaude Claude route where PAYG is off");

const archA = (await route(COMPANY_A, { taskClass: "architecture" })).body.decision;
console.log(`  company A (claudePaygEnabled=${A.providers.claudePaygEnabled}): ${archA.outcome} -> ${archA.modelId}`);
check(
  "company A routes Claude, because its Claude models list teamclaude",
  archA.modelId === "claude-sonnet-5" && !archA.rejections.some((r) => r.stage === "claude-block"),
  `outcome=${archA.outcome} model=${archA.modelId}`,
);

// Flip ONE key in company B's stored config — a config write, not a code edit —
// and B's Claude route, which is openrouter-only, must be refused.
const storedB = configs.get(COMPANY_B);
configs.set(COMPANY_B, {
  ...storedB,
  providers: { ...storedB.providers, claudePaygEnabled: false },
});

const archBlocked = (await route(COMPANY_B, { taskClass: "architecture" })).body.decision;
const blocks = archBlocked.rejections.filter((r) => r.stage === "claude-block");
// Deliberately NOT `m.family === "claude"`. That was the TOG-237 defect, and an
// oracle that trusts the same field the engine stopped trusting would pass
// vacuously on exactly the config that breaks the block: mislabel the model and
// it drops out of this set, so "no Claude model was served" becomes true by
// omission. Classify the way the engine now does — id OR declared family.
const isClaude = (m) => /claude|anthropic/i.test(m.id) || (B.providers.claudeFamilies ?? []).includes(m.family);
const claudeIds = new Set(B.models.filter(isClaude).map((m) => m.id));
console.log(`  company B with claudePaygEnabled flipped to false: ${archBlocked.outcome} -> ${archBlocked.modelId}`);
for (const line of archBlocked.trace) console.log(`      ${line}`);
for (const block of blocks) console.log(`      REFUSED ${block.modelId}: ${block.detail ?? block.stage}`);

check(
  "flipping only claudePaygEnabled refuses B's openrouter-only Claude route",
  blocks.length > 0,
  `claude-block rejections=${blocks.length}`,
);
// B configures a fallback, so the refusal lands on a non-Claude model rather
// than on `no-eligible-model`. The gate still held: what must never happen is
// Claude being served off teamclaude, and it is not.
check(
  "no Claude model is served once PAYG is off, fallback included",
  archBlocked.modelId === null || !claudeIds.has(archBlocked.modelId),
  `outcome=${archBlocked.outcome} model=${archBlocked.modelId} (B's fallback is ${B.routing.fallbackModelId})`,
);

// The check above holds only because B's fallback happens to be a non-Claude
// model. The hostile case — the one TOG-228 found live — is a fallback that
// NAMES a Claude model: it is in B's table so config validation accepts it, and
// before the fix it was returned without ever consulting the `claude-block`
// rejection that had just eliminated it. Point the fallback straight at the
// blocked model and confirm the block outranks it.
configs.set(COMPANY_B, {
  ...storedB,
  providers: { ...storedB.providers, claudePaygEnabled: false },
  routing: { ...storedB.routing, fallbackModelId: "claude-sonnet-5" },
});
const archHostile = (await route(COMPANY_B, { taskClass: "architecture" })).body.decision;
console.log(`  company B, PAYG off and fallback pointed AT claude-sonnet-5: ${archHostile.outcome} -> ${archHostile.modelId}`);
for (const line of archHostile.trace) console.log(`      ${line}`);
check(
  "a fallback naming a Claude model does not cross the Claude block (TOG-228 defect 1)",
  archHostile.modelId === null || !claudeIds.has(archHostile.modelId),
  `outcome=${archHostile.outcome} model=${archHostile.modelId} fallback=claude-sonnet-5`,
);

// The other way to get a Claude model past the block needs no fallback at all:
// mislabel it. `family` is company-supplied, and until TOG-237 the block was
// decided entirely from that field, so `"family": "gpt"` on a `claude-*` id
// exempted the model outright — `selected`, empty `rejections`, not one trace
// line. The gate did not fail; it was never asked. Both layers are checked
// here, because they fail independently: the write should be refused, and the
// engine should hold even if a config reaches it some other way.
const mislabelledB = {
  ...storedB,
  providers: { ...storedB.providers, claudePaygEnabled: false },
  models: storedB.models.map((m) => (m.id === "claude-sonnet-5" ? { ...m, family: "gpt" } : m)),
};

const mislabelVerdict = await definition.onValidateConfig(mislabelledB);
check(
  "a Claude id filed under a non-Claude family is refused at config-write time (TOG-237)",
  mislabelVerdict.ok === false,
  `ok=${mislabelVerdict.ok} errors=${mislabelVerdict.errors.join("; ") || "(none)"}`,
);

configs.set(COMPANY_B, mislabelledB);
const archMislabelled = (await route(COMPANY_B, { taskClass: "architecture" })).body.decision;
const mislabelBlocks = archMislabelled.rejections.filter((r) => r.stage === "claude-block");
console.log(`  company B, PAYG off and claude-sonnet-5 mislabelled "family":"gpt": ${archMislabelled.outcome} -> ${archMislabelled.modelId}`);
for (const line of archMislabelled.trace) console.log(`      ${line}`);
for (const block of mislabelBlocks) console.log(`      REFUSED ${block.modelId}: ${block.detail ?? block.stage}`);
check(
  "the engine still blocks a mislabelled Claude model — the id is enough (TOG-237)",
  mislabelBlocks.some((r) => r.modelId === "claude-sonnet-5") && archMislabelled.modelId !== "claude-sonnet-5",
  `outcome=${archMislabelled.outcome} model=${archMislabelled.modelId} claude-block rejections=${mislabelBlocks.length}`,
);

configs.set(COMPANY_B, storedB);
const archRestored = (await route(COMPANY_B, { taskClass: "architecture" })).body.decision;
check(
  "restoring the key restores the route — the switch is config, and reversible",
  archRestored.modelId === "claude-sonnet-5",
  `model=${archRestored.modelId}`,
);

// --- Evidence 5: Rule 0 fires per company, on that company's patterns --------

section("EVIDENCE 5 — Rule 0 fires on each company's own patterns and nowhere else");

const rule0Cases = [
  ["lint the repo", COMPANY_A],
  ["bump the version and tag it", COMPANY_B],
];

for (const [summary, owner] of rule0Cases) {
  const forA = (await route(COMPANY_A, { summary, taskClass: "mechanical" })).body.decision;
  const forB = (await route(COMPANY_B, { summary, taskClass: "mechanical" })).body.decision;
  const label = owner === COMPANY_A ? "A" : "B";
  const other = owner === COMPANY_A ? "B" : "A";
  const hit = owner === COMPANY_A ? forA : forB;
  const miss = owner === COMPANY_A ? forB : forA;
  console.log(`  "${summary}"`);
  console.log(`      company A: ${forA.outcome}${forA.modelId ? ` -> ${forA.modelId}` : ""}`);
  console.log(`      company B: ${forB.outcome}${forB.modelId ? ` -> ${forB.modelId}` : ""}`);
  check(
    `"${summary}" needs no model in company ${label}`,
    hit.outcome === "no-model-needed",
    `outcome=${hit.outcome}`,
  );
  check(
    `"${summary}" is not a Rule 0 hit in company ${other}`,
    miss.outcome !== "no-model-needed",
    `outcome=${miss.outcome}`,
  );
}

// --- Evidence 6 (bonus): the gates, and company-scoped state -----------------

section("EVIDENCE 6 — gates and recorded state are per company on one shared worker");

const budgetA = await routeAction(COMPANY_A, { taskClass: "implementation", budgetSpentFraction: 0.92 });
const budgetB = await routeAction(COMPANY_B, { taskClass: "implementation", budgetSpentFraction: 0.92 });
console.log(`  92% of budget spent: A budget gate=${budgetA.gates.budget} (${budgetA.outcome}), B budget gate=${budgetB.gates.budget} (${budgetB.outcome})`);
check(
  "the same spend fraction is a downshift in A and a halt in B",
  budgetA.gates.budget === "downshift" && budgetB.gates.budget === "halt",
  `A=${budgetA.gates.budget} B=${budgetB.gates.budget}`,
);

quotaUtilization.value = 0.97;
const quotaA = await routeAction(COMPANY_A, { taskClass: "architecture" });
const quotaB = await routeAction(COMPANY_B, { taskClass: "architecture" });
console.log(`  teamclaude pool at 97% (stubbed): A claudeQuota gate=${quotaA.gates.claudeQuota}, B claudeQuota gate=${quotaB.gates.claudeQuota}`);
check(
  "A's quota gate halts Claude; B, which configured no gate, is unaffected",
  quotaA.gates.claudeQuota === "halt" && quotaB.gates.claudeQuota === "ok" && quotaB.modelId === "claude-sonnet-5",
  `A=${quotaA.gates.claudeQuota} B=${quotaB.gates.claudeQuota}/${quotaB.modelId}`,
);
check(
  "the quota gate really called the configured status URL, and only A's",
  httpCalls.length > 0 && httpCalls.every((call) => call.url === A.quotaGate.statusUrl),
  `${httpCalls.length} call(s), all to ${A.quotaGate.statusUrl}`,
);
quotaUtilization.value = 0.10;

const logA = harness.getState({ scopeKind: "company", scopeId: COMPANY_A, stateKey: "decision-log" }) ?? [];
const logB = harness.getState({ scopeKind: "company", scopeId: COMPANY_B, stateKey: "decision-log" }) ?? [];
check(
  "each company's decision log is written under its own scope and holds only its own decisions",
  logA.length > 0 &&
    logB.length > 0 &&
    logA.every((entry) => entry.companyId === COMPANY_A) &&
    logB.every((entry) => entry.companyId === COMPANY_B),
  `A=${logA.length} entries, B=${logB.length} entries`,
);

// --- summary -----------------------------------------------------------------

section("SUMMARY");

console.log(`  plugin        ${manifest.id} v${manifest.version} (apiVersion ${manifest.apiVersion})`);
console.log(`  companies     A=${COMPANY_A}  B=${COMPANY_B}`);
console.log(`  configs       ${FIXTURE_A}  |  ${FIXTURE_B}`);
console.log(`  code edits    0 — one build, one worker instance, two config rows`);
console.log(`  checks        ${results.length - failures}/${results.length} passed`);
console.log("");
console.log("  NOT proven here, and only an operator can: the live install, the live");
console.log("  config POST, and the live HTTP routes. See");
console.log("  /paperclip/operator-handoff/TOG-156-plugin-install-runbook.md steps 2-4.");

const jsonFlag = process.argv.indexOf("--json");
if (jsonFlag !== -1 && process.argv[jsonFlag + 1]) {
  writeFileSync(
    process.argv[jsonFlag + 1],
    `${JSON.stringify(
      {
        plugin: { id: manifest.id, version: manifest.version, apiVersion: manifest.apiVersion },
        companies: { a: COMPANY_A, b: COMPANY_B },
        fixtures: { a: FIXTURE_A, b: FIXTURE_B },
        decisions: {
          implementation: { a: decisionA, b: decisionB },
          architecture: { a: archA, bPaygOff: archBlocked },
        },
        checks: results,
        passed: results.length - failures,
        total: results.length,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\n  wrote ${process.argv[jsonFlag + 1]}`);
}

console.log(
  failures === 0
    ? "\nREHEARSAL PASSED — every offline part of the TOG-156 acceptance criterion holds.\n"
    : `\nREHEARSAL FAILED — ${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
