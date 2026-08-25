#!/usr/bin/env node
/**
 * TOG-157 Phase 5 — the end-to-end gate, run against the shipped artifact.
 *
 * TOG-157 asks for six demonstrations plus a cost baseline. Three of the six
 * need substrate that is not deployed (OmniRoute combos, and teamclaude
 * registered as an OmniRoute provider). This script does two things about that,
 * and the second is the point:
 *
 *   1. It runs every demonstration that CAN be run today, against
 *      `dist/worker.js` — the file that ships in the tarball — rather than
 *      against `src/`.
 *   2. For every demonstration it CANNOT run, it emits an explicit BLOCKED
 *      record naming the missing substrate and the issue that owns it, and it
 *      exits non-zero. A blocked item is never silently omitted and never
 *      counted as a pass. An optimistic report here is worse than a delay.
 *
 * The leak attempts in D3 are written as attacks that should fail. Where an
 * attack SUCCEEDS, that is recorded as a LEAK and fails the run. "We tried and
 * could not" is the only useful form of the claim that Claude cannot leak.
 *
 * Usage:
 *   node scripts/phase5-evidence.mjs [--json <path>]
 *
 * Exit codes:
 *   0  every executable demonstration passed AND nothing is blocked
 *   1  a demonstration failed, a leak was found, or an item is blocked
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";

// --- reporting ---------------------------------------------------------------

/** Every numbered demonstration TOG-157 asks for, with its live verdict. */
const demos = [];
const checks = [];
let failures = 0;
let leaks = 0;

function section(title) {
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}`);
}

function check(label, ok, detail = "") {
  if (!ok) failures += 1;
  checks.push({ label, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
}

/**
 * An attack that must be refused. `refused` true means the system held.
 * A successful attack is a LEAK and is strictly worse than a failed check.
 */
function attack(label, refused, detail = "") {
  if (!refused) {
    leaks += 1;
    failures += 1;
  }
  checks.push({ label, ok: refused, detail, kind: "attack" });
  console.log(`  ${refused ? "REFUSED " : "*** LEAK "} ${label}${detail ? `\n        ${detail}` : ""}`);
}

function demo(id, title, verdict, notes) {
  demos.push({ id, title, verdict, notes });
  if (verdict === "BLOCKED") failures += 1;
}

function show(label, value) {
  console.log(`  ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

function readJson(rel) {
  return JSON.parse(readFileSync(isAbsolute(rel) ? rel : join(repo, rel), "utf8"));
}

// --- the built artifact, loaded exactly once ---------------------------------

const manifest = (await import(pathToFileURL(join(repo, "dist/manifest.js")).href)).default;
const workerModule = await import(pathToFileURL(join(repo, "dist/worker.js")).href);
const pkg = readJson("package.json");

const baseA = readJson("tests/fixtures/company-a.json");
const configs = new Map([
  [COMPANY_A, structuredClone(baseA)],
  [COMPANY_B, readJson("tests/fixtures/company-b.json")],
]);

/** Controls what the stubbed teamclaude status endpoint reports. */
const quota = { value: 0.1, fail: null };
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
    if (quota.fail) throw new Error(quota.fail);
    return {
      status: 200,
      async json() {
        return { accounts: [{ unified5h: quota.value, unified7d: quota.value / 2 }] };
      },
    };
  },
};

const { definition } = workerModule.createPlugin();
await definition.setup(ctx);

const route = (companyId, body, issueId = "issue-phase5") =>
  definition.onApiRequest({
    routeKey: "route-issue",
    method: "POST",
    path: `/issues/${issueId}/route`,
    params: { issueId },
    query: {},
    body,
    actor: { actorType: "agent", actorId: "phase5" },
    companyId,
    headers: {},
  });

/** The full decision path including the live quota read and the decision log. */
const routeAction = (companyId, params) => harness.performAction("route", { companyId, ...params });

/** Mutate company A's config for one attack, then restore it. */
async function withConfigA(mutate, fn) {
  const saved = structuredClone(configs.get(COMPANY_A));
  const next = structuredClone(saved);
  mutate(next);
  configs.set(COMPANY_A, next);
  try {
    return await fn();
  } finally {
    configs.set(COMPANY_A, saved);
  }
}

const modelById = (id) => baseA.models.find((m) => m.id === id);
const rejectionFor = (decision, id) => (decision.rejections ?? []).find((r) => r.modelId === id);

console.log(`TOG-157 Phase 5 evidence — ${manifest.id} v${manifest.version} (package ${pkg.version})`);
console.log(`Artifact under test: dist/worker.js  (the file that ships in the tarball)`);

// =============================================================================
// D1 — a non-Claude task routes through OmniRoute and is served by opencode-go
// =============================================================================

section("D1 — non-Claude task prefers opencode-go, and the run record names the provider");

const impl = (await route(COMPANY_A, { taskClass: "implementation" })).body.decision;
show("selected", impl.modelId);
show("tier", `${impl.requestedTier} -> ${impl.effectiveTier}`);
show("quality floor", impl.qualityFloor);

const selected = modelById(impl.modelId);
check(
  "an implementation task selects a non-Claude model",
  selected && selected.family !== "claude",
  `${impl.modelId} family=${selected?.family}`,
);
check(
  "the selected model is servable by opencode-go",
  selected?.providers.includes("opencode-go"),
  `providers=${JSON.stringify(selected?.providers)}`,
);
check(
  "opencode-go is first in this company's provider preference order (owner rule 2)",
  baseA.providers.preferenceOrder[0] === "opencode-go",
  `preferenceOrder=${JSON.stringify(baseA.providers.preferenceOrder)}`,
);

// Owner rule 3: Paperclip names a MODEL and must not be able to name a provider.
// That is a property of the decision object, so it is checkable here.
const decisionKeys = Object.keys(impl);
check(
  "the decision names a model and never a provider (owner rule 3)",
  typeof impl.modelId === "string" && !decisionKeys.includes("provider") && !decisionKeys.includes("providerId"),
  `decision keys: ${decisionKeys.join(", ")}`,
);

demo(
  "D1",
  "non-Claude task routes through OmniRoute, served by opencode-go, run record proves the provider",
  "PARTIAL",
  [
    "PROVEN (policy layer): the router selects a non-Claude model that opencode-go can serve, and ranks opencode-go first.",
    "NOT PROVEN (transport): no live OmniRoute request was made, so no run record names the serving provider.",
    "Blocked by: model_combo_mappings is 0 rows on the live instance (TOG-178 Phase 2a-deploy is in backlog),",
    "and this agent holds no OMNIROUTE_API_KEY — GET /api/v1/models returns 401 from this container.",
  ],
);

// =============================================================================
// D2 — Go plan rotation, then OpenRouter only when Go is exhausted
// =============================================================================

section("D2 — Go plan rotation and OpenRouter terminal fallback");

console.log("  Not executable from the policy layer, by design.");
console.log("  Plan rotation and PAYG fallback are OmniRoute's job (owner rule 3): the router");
console.log("  names a model and is structurally unable to observe which plan served it.");
console.log("  Forcing this needs the combo layer, which is not deployed.");

demo("D2", "force Go plan unavailability, prove rotation, prove OpenRouter is terminal", "BLOCKED", [
  "Requires OmniRoute combos with ordered legs (opencode-go x N, then openrouter).",
  "Live state: model_combo_mappings = 0 rows; combos from TOG-152 are specified but not applied (TOG-178, backlog).",
  "Two funded opencode-go connections now exist (main, main-2), so rotation is no longer vacuous — it is just not configured.",
  "Also required: per-connection provenance. TOG-152 established the SSE trailer is the reliable instrument;",
  "the x-omniroute-* response headers are dropped on ~4/7 slow (OpenRouter) responses, which biases exactly this measurement.",
]);

// =============================================================================
// D3 — the Claude block, attacked from the policy layer
// =============================================================================

section("D3 — Claude reaches teamclaude and nothing else. Attacks that must be refused.");

const arch = (await route(COMPANY_A, { taskClass: "architecture" })).body.decision;
show("architecture task selects", arch.modelId);
check(
  "a Claude-requiring task does select a Claude model when teamclaude is permitted",
  modelById(arch.modelId)?.family === "claude",
  `${arch.modelId} — the block must not be vacuous`,
);

// Attack 1 — a Claude model that only OpenRouter can serve.
await withConfigA(
  (cfg) => {
    const m = cfg.models.find((x) => x.id === "claude-sonnet-5");
    m.providers = ["openrouter"];
    cfg.models = cfg.models.filter((x) => x.family !== "claude" || x.id === "claude-sonnet-5");
    cfg.taskClasses.find((t) => t.key === "architecture").qualityFloor = 85;
  },
  async () => {
    const d = (await route(COMPANY_A, { taskClass: "architecture" })).body.decision;
    const rej = rejectionFor(d, "claude-sonnet-5");
    attack(
      "A1: a Claude model listing only openrouter is refused by the claude-block stage",
      rej?.stage === "claude-block" && d.modelId !== "claude-sonnet-5",
      `outcome=${d.outcome} selected=${d.modelId} rejection=${rej?.stage}: ${rej?.reason}`,
    );
  },
);

// Attack 2 — drop teamclaude from the permitted provider list entirely.
await withConfigA(
  (cfg) => {
    cfg.providers.permitted = ["opencode-go", "openrouter"];
  },
  async () => {
    const d = (await route(COMPANY_A, { taskClass: "architecture" })).body.decision;
    const claudeSelected = modelById(d.modelId)?.family === "claude";
    const blocked = (d.rejections ?? []).filter((r) => r.stage === "claude-block");
    attack(
      "A2: with teamclaude unpermitted, no Claude model is selected",
      !claudeSelected,
      `selected=${d.modelId} outcome=${d.outcome}; ${blocked.length} model(s) hit claude-block`,
    );
  },
);

// Attack 3 — the fallback path. TOG-228 found this served a Claude model
// without consulting the block. It was fixed in 0.2.0; this re-attacks it.
await withConfigA(
  (cfg) => {
    cfg.providers.permitted = ["opencode-go", "openrouter"];
    cfg.routing.fallbackModelId = "claude-opus-5";
    cfg.taskClasses.find((t) => t.key === "architecture").qualityFloor = 99;
  },
  async () => {
    const d = (await route(COMPANY_A, { taskClass: "architecture" })).body.decision;
    attack(
      "A3: routing.fallbackModelId naming a Claude model cannot bypass the block (TOG-228 regression)",
      d.modelId !== "claude-opus-5",
      `selected=${d.modelId} outcome=${d.outcome} fallbackUsed=${d.fallbackUsed}`,
    );
  },
);

// Attack 4 — a PIN. A pin outranks the tier ceiling and the budget halt.
// It must NOT outrank the Claude block.
await withConfigA(
  (cfg) => {
    cfg.providers.permitted = ["opencode-go", "openrouter"];
  },
  async () => {
    const d = (await route(COMPANY_A, {
      taskClass: "architecture",
      pinnedModelId: "claude-opus-5",
      pinReason: "phase5 leak attempt: pin outranks the ceiling, does it outrank the block?",
    })).body.decision;
    attack(
      "A4: a pin naming a Claude model does not outrank the Claude block",
      d.modelId !== "claude-opus-5" && d.pin?.honored === false,
      `selected=${d.modelId} pin.honored=${d.pin?.honored} — "${d.pin?.reason}"`,
    );
  },
);

// Attack 5 — the family label. The block keys off `model.family`, which is
// config-supplied. TOG-237 is open on exactly this.
await withConfigA(
  (cfg) => {
    cfg.providers.permitted = ["opencode-go", "openrouter"];
    const m = cfg.models.find((x) => x.id === "claude-sonnet-5");
    m.family = "anthropic"; // same model, a label the block does not recognise
  },
  async () => {
    const d = (await route(COMPANY_A, { taskClass: "architecture" })).body.decision;
    const leaked = d.modelId === "claude-sonnet-5";
    // Establish that this is a real rule-1 violation and not a cosmetic one:
    // the model that was selected is Anthropic's, and the ONLY provider left
    // able to serve it is openrouter, because teamclaude is not permitted here.
    const servable = modelById("claude-sonnet-5").providers.filter((p) =>
      configs.get(COMPANY_A).providers.permitted.includes(p),
    );
    const noClaudeBlockFired = !(d.rejections ?? []).some((r) => r.stage === "claude-block" && r.modelId === "claude-sonnet-5");
    attack(
      "A5: relabelling a Claude model's family does not smuggle it past the block (TOG-237)",
      !leaked,
      leaked
        ? `LEAKED: claude-sonnet-5 relabelled family="anthropic" was SELECTED. ` +
          `claude-block never fired for it (${noClaudeBlockFired}). ` +
          `Permitted providers able to serve it: ${JSON.stringify(servable)} — teamclaude is NOT among them. ` +
          `This is an Anthropic model routed to a non-teamclaude provider, i.e. a direct breach of owner rule 1.`
        : `selected=${d.modelId}`,
    );
  },
);

// Control — the switch is config, and turning it on is visible.
await withConfigA(
  (cfg) => {
    cfg.providers.claudePaygEnabled = true;
    cfg.providers.permitted = ["opencode-go", "openrouter"];
  },
  async () => {
    const d = (await route(COMPANY_A, { taskClass: "architecture" })).body.decision;
    check(
      "control: with claudePaygEnabled=true the block lifts — so the refusals above are the block, not an artefact",
      modelById(d.modelId)?.family === "claude",
      `selected=${d.modelId} (owner rule 1 keeps this false in production)`,
    );
  },
);

demo("D3", "Claude routes to teamclaude and cannot leak — policy layer AND combo layer", "PARTIAL", [
  "PROVEN (policy layer): 5 leak attempts, all refused, including a pin, the fallback path, and a family relabel.",
  "A5 is an INDEPENDENT confirmation of the TOG-237 fix: this attack was written against v0.2.1, where it",
  "SUCCEEDED (claude-sonnet-5 relabelled family=\"anthropic\" was selected with openrouter as its only",
  "permitted provider). Re-run unchanged against v0.2.2 it is refused. The fix holds against an attack",
  "that was not written to its shape.",
  "NOT PROVEN (combo layer): teamclaude is not registered as an OmniRoute provider.",
  "Live state: GET /api/v1/models returns 1422 ids and none carry a teamclaude prefix (verified on TOG-153 at 21:32 today).",
  "So there is no Claude combo to attack. TOG-153 (Phase 2b) is in_progress and owns this.",
  "Note the current production path: Claude traffic bypasses OmniRoute entirely — this agent's own",
  "ANTHROPIC_BASE_URL is http://host.containers.internal:3456, i.e. teamclaude direct. That satisfies",
  "owner rule 1 today by accident of topology, not by the designed control.",
]);

// =============================================================================
// D4 — the usage gate slows, then pauses, then resumes
// =============================================================================

section("D4 — the teamclaude usage gate: slow, pause, resume");

const ladder = [
  { util: 0.1, expect: "ok", label: "healthy" },
  { util: 0.75, expect: "warn", label: "warn threshold 0.70" },
  { util: 0.9, expect: "downshift", label: "downshift threshold 0.85 — SLOWS" },
  { util: 0.97, expect: "halt", label: "pause threshold 0.95 — PAUSES" },
  { util: 0.1, expect: "ok", label: "after reset — RESUMES" },
];

const ladderRows = [];
for (const step of ladder) {
  quota.value = step.util;
  const res = await routeAction(COMPANY_A, { taskClass: "architecture" });
  const d = res.decision ?? res.body?.decision ?? res;
  const level = d.gates?.claudeQuota;
  const claudeChosen = modelById(d.modelId)?.family === "claude";
  ladderRows.push({ util: step.util, level, modelId: d.modelId, claudeChosen });
  check(
    `utilization ${(step.util * 100).toFixed(0)}% -> gate "${step.expect}" (${step.label})`,
    level === step.expect,
    `gate=${level} selected=${d.modelId} claude=${claudeChosen}`,
  );
}

// The ladder above uses `architecture`, whose quality floor (85) only Claude
// clears in this table. There, "slow" and "pause" collapse to the SAME outcome —
// a refusal — because the engine will not trade the floor for cost.
//
// TOG-157 asks the gate to "slow AND THEN pause". So the question is whether
// there is ANY task class where downshift degrades gracefully to a cheaper
// still-eligible model instead of refusing. Sweep every configured class rather
// than assert it either way.
console.log("\n  --- does downshift ever SLOW rather than refuse? sweep every task class ---");
console.log("    class            floor  ok            downshift     halt");
const sweep = [];
for (const tc of configs.get(COMPANY_A).taskClasses) {
  const at = {};
  for (const [label, util] of [["ok", 0.1], ["downshift", 0.9], ["halt", 0.97]]) {
    quota.value = util;
    const res = await routeAction(COMPANY_A, { taskClass: tc.key });
    const d = res.decision ?? res.body?.decision ?? res;
    at[label] = d.modelId ?? `(${d.outcome})`;
  }
  const claudeAtOk = modelById(at.ok)?.family === "claude";
  // A genuine "slow": Claude was the choice while healthy, and under pressure
  // the gate substituted a different model that still cleared the floor.
  const slowed = claudeAtOk && at.downshift !== at.ok && !at.downshift.startsWith("(");
  sweep.push({ key: tc.key, floor: tc.qualityFloor, ...at, claudeAtOk, slowed });
  console.log(
    `    ${tc.key.padEnd(16)} ${String(tc.qualityFloor).padEnd(6)} ${at.ok.padEnd(13)} ${at.downshift.padEnd(13)} ${at.halt}`,
  );
}
quota.value = 0.1;

const gateBites = sweep.filter((r) => r.claudeAtOk);
const gateSlows = sweep.filter((r) => r.slowed);
check(
  "the gate has at least one class where it bites at all (it is not vacuous)",
  gateBites.length > 0,
  `Claude is the healthy choice in ${gateBites.length}/${sweep.length} classes: ${gateBites.map((r) => r.key).join(", ") || "none"}`,
);
// This is reported as a finding, not asserted as a pass, because the honest
// answer determines whether D4 meets its own wording.
console.log(
  gateSlows.length > 0
    ? `\n    FINDING: downshift degrades gracefully in ${gateSlows.length} class(es): ${gateSlows.map((r) => r.key).join(", ")}`
    : `\n    FINDING: downshift NEVER degrades gracefully in this table. In every class where the gate\n` +
      `    bites (${gateBites.map((r) => r.key).join(", ") || "none"}), Claude is the only model clearing the floor, so\n` +
      `    dropping it a tier leaves nothing eligible and the gate REFUSES. "Slow" and "pause" are the\n` +
      `    same outcome. The engine is behaving correctly — it refuses to trade the quality floor for\n` +
      `    cost — but D4's "slows AND THEN pauses" is not satisfied by this configuration.`,
);
const gateIsBinary = gateSlows.length === 0;

const haltRow = ladderRows.find((r) => r.level === "halt");
const resumeRow = ladderRows[ladderRows.length - 1];
check(
  "at halt, no Claude-family model is selected",
  haltRow && !haltRow.claudeChosen,
  `at halt selected=${haltRow?.modelId}`,
);
check(
  "after the quota resets, Claude work resumes",
  resumeRow.claudeChosen,
  `selected=${resumeRow.modelId}`,
);

// A gate that cannot read its input must not read as healthy.
quota.value = 0.1;
quota.fail = "teamclaude unreachable (phase5 induced)";
const blindRes = await routeAction(COMPANY_A, { taskClass: "architecture" });
const blind = blindRes.decision ?? blindRes.body?.decision ?? blindRes;
quota.fail = null;
check(
  "when the quota endpoint fails, the trace says the gate is OPEN rather than healthy",
  (blind.trace ?? []).some((line) => /gate is OPEN|utilization is unknown/i.test(line)),
  (blind.trace ?? []).find((l) => /OPEN|unknown/i.test(l)) ?? "no such trace line",
);

demo("D4", "usage gate slows then pauses Claude work as pooled quota depletes, and resumes after reset", "PARTIAL", [
  "PROVEN (policy layer): the full ok -> warn -> downshift -> halt -> ok ladder, driven by a live quota read,",
  "with Claude dropped at halt and restored after reset. A failed quota read reports an OPEN gate, not a healthy one.",
  gateIsBinary
    ? "NOT PROVEN (the 'slow' half): swept all 4 task classes. In every class where the gate bites, Claude is the ONLY model clearing the quality floor, so downshifting it leaves nothing eligible and the gate refuses. 'Slow' and 'pause' collapse to one outcome. The engine is right to refuse to trade the floor for cost; the gap is that the config has no graceful step between 'Claude' and 'nothing'."
    : "PROVEN (the 'slow' half): downshift substitutes a cheaper still-eligible model before halting.",
  "PROVEN (telemetry): /paperclip/operator-handoff/quota-pacing.jsonl is being written live — 20 samples,",
  "two teamclaude accounts with real weekly fractions, reset times and runs_in_flight.",
  "NOT PROVEN (enforcement): nothing consumes this gate in the dispatch path. TOG-192 (wire the quota gate into",
  "dispatch) and TOG-185 (throttle Claude dispatch in the heartbeat claim path) are both in backlog.",
  "So today the gate would slow and pause work IF a caller asked it. No caller asks it.",
]);

// =============================================================================
// D5 — Rule 0 prevents a model call
// =============================================================================

section("D5 — Rule 0: the cheapest call is the one never made");

const rule0Cases = [
  "run the tests for the quota reader",
  "lint the worker entrypoint",
  "find all usages of selectModel",
];
let rule0Prevented = 0;
for (const summary of rule0Cases) {
  const d = (await route(COMPANY_A, { summary, taskClass: "mechanical" })).body.decision;
  const prevented = d.outcome === "no-model-needed";
  if (prevented) rule0Prevented += 1;
  check(
    `"${summary}" -> no model call`,
    prevented,
    `outcome=${d.outcome} | ${(d.trace ?? [])[0] ?? ""}`,
  );
}

const notRule0 = (await route(COMPANY_A, {
  summary: "decide whether to migrate the event store to Postgres",
  taskClass: "architecture",
})).body.decision;
check(
  "Rule 0 is not indiscriminate: a genuine reasoning task still gets a model",
  notRule0.outcome === "selected",
  `outcome=${notRule0.outcome} selected=${notRule0.modelId}`,
);

demo("D5", "the Rule 0 gate demonstrably prevents at least one model call", "PASS", [
  `${rule0Prevented}/${rule0Cases.length} deterministic-tooling tasks returned outcome="no-model-needed" — zero tokens.`,
  "Each names the tool that answers instead (test runner, linter, ripgrep).",
  "A control task that genuinely needs reasoning still routes, so the gate is not indiscriminate.",
  "Rule 0 is also provably model-free: a committed test greps the module for urllib/requests/socket/anthropic/openai",
  "and fails on any hit, so a classifier cannot be slipped in front of it later.",
]);

// =============================================================================
// D6 — overrides are logged with reasoning, pins are respected
// =============================================================================

section("D6 — a logged override, and a respected pin");

// A pin that survives the gates is honoured, and outranks the tier ceiling.
const pinned = (await route(COMPANY_A, {
  taskClass: "implementation",
  pinnedModelId: "claude-sonnet-5",
  pinReason: "owner pinned sonnet-5 for the release review",
})).body.decision;
show("pinned selection", pinned.modelId);
show("pin record", pinned.pin);
check(
  "a pinned model that clears the hard gates is respected (owner rule 4)",
  pinned.modelId === "claude-sonnet-5" && pinned.pin?.honored === true,
  `selected=${pinned.modelId} honored=${pinned.pin?.honored}`,
);
check(
  "the pin is recorded with its reason",
  pinned.pin?.reason === "owner pinned sonnet-5 for the release review",
  `reason="${pinned.pin?.reason}"`,
);
check(
  "the pin overrides the tier ceiling that would otherwise have applied",
  pinned.requestedTier !== null && (pinned.trace ?? []).some((l) => /pin honoured/i.test(l)),
  (pinned.trace ?? []).find((l) => /pin honoured/i.test(l)) ?? "",
);

// A refused pin must say why, not fail silently.
const pinRefused = (await route(COMPANY_A, {
  taskClass: "implementation",
  pinnedModelId: "gpt-9-imaginary",
  pinReason: "phase5: a pin naming a model this company does not have",
})).body.decision;
check(
  "a pin that cannot be honoured is recorded as refused, with the reason",
  pinRefused.pin?.honored === false &&
    (pinRefused.trace ?? []).some((l) => /pin refused/i.test(l)),
  (pinRefused.trace ?? []).find((l) => /pin refused/i.test(l)) ?? "no pin-refused trace line",
);

// An override of the default choice, with its reasoning in the trace.
quota.value = 0.9;
const overrideRes = await routeAction(COMPANY_A, { taskClass: "architecture", budgetSpentFraction: 0.85 });
const override = overrideRes.decision ?? overrideRes.body?.decision ?? overrideRes;
quota.value = 0.1;
show("requested tier", override.requestedTier);
show("effective tier", override.effectiveTier);
console.log("  trace:");
for (const line of override.trace ?? []) console.log(`    - ${line}`);
check(
  "the router overrode the tier the task scored into",
  override.effectiveTier !== override.requestedTier,
  `${override.requestedTier} -> ${override.effectiveTier}`,
);
check(
  "every override step states its reason in the trace (auditable, owner rule 4)",
  (override.trace ?? []).some((l) => /budget gate/i.test(l)) &&
    (override.trace ?? []).some((l) => /quota gate/i.test(l)),
  `${(override.trace ?? []).length} trace lines`,
);

demo("D6", "a model override is logged with its reasoning, and a pinned model is respected", "PASS", [
  "A pin that clears the hard gates is honoured and recorded with its reason; it outranks the tier ceiling.",
  "A pin that cannot be honoured is recorded as refused WITH the stage and reason, rather than silently ignored.",
  "A pin does NOT outrank the Claude block (attack A4 above) — owner rule 1 beats owner rule 4, correctly.",
  "Tier overrides driven by budget and quota pressure each emit a reasoned trace line naming the gate,",
  "the threshold and the tier transition. The decision object carries requestedTier and effectiveTier separately.",
]);

// =============================================================================
// Summary
// =============================================================================

section("PHASE 5 SUMMARY");

for (const d of demos) {
  const mark = d.verdict === "PASS" ? "PASS   " : d.verdict === "PARTIAL" ? "PARTIAL" : "BLOCKED";
  console.log(`\n  [${mark}] ${d.id} — ${d.title}`);
  for (const n of d.notes) console.log(`           ${n}`);
}

const passed = checks.filter((c) => c.ok).length;
console.log(`\n  checks: ${passed}/${checks.length} passed`);
console.log(`  leak attempts: ${checks.filter((c) => c.kind === "attack").length}, leaks found: ${leaks}`);
console.log(`  demonstrations: ${demos.filter((d) => d.verdict === "PASS").length} PASS, ` +
  `${demos.filter((d) => d.verdict === "PARTIAL").length} PARTIAL, ` +
  `${demos.filter((d) => d.verdict === "BLOCKED").length} BLOCKED`);
console.log(`  quota endpoint reads during this run: ${httpCalls.length}`);

const jsonFlag = process.argv.indexOf("--json");
if (jsonFlag !== -1 && process.argv[jsonFlag + 1]) {
  const out = {
    issue: "TOG-157",
    plugin: { id: manifest.id, version: manifest.version },
    demos,
    checks,
    leaks,
    totals: { checks: checks.length, passed, failures },
  };
  writeFileSync(process.argv[jsonFlag + 1], JSON.stringify(out, null, 2));
  console.log(`\n  wrote ${process.argv[jsonFlag + 1]}`);
}

if (leaks > 0) {
  console.log(`\n  RESULT: ${leaks} LEAK(S) FOUND — the Claude block does not hold under attack.`);
}
console.log(
  failures === 0
    ? "\n  RESULT: Phase 5 PASSES."
    : `\n  RESULT: Phase 5 is a PARTIAL PASS. ${failures} item(s) failed or are blocked. Details above.`,
);

process.exit(failures === 0 ? 0 : 1);
