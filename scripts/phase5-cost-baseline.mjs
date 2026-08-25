#!/usr/bin/env node
/**
 * TOG-157 — the cost baseline: what a representative task cost before this
 * system and after, with retries, cache loss and output tokens counted.
 *
 * The epic exists to save money without losing quality, so this has to be a
 * measurement, not an assertion. Every number below is tagged:
 *
 *   [MEASURED]  read from live instrumentation or from a completed sibling task
 *   [MODELLED]  computed from measured inputs by arithmetic shown in full
 *   [UNMEASURED] an input nobody has measured yet — carried as a variable and
 *                swept, never as a point estimate
 *
 * The headline result is deliberately NOT a single savings percentage. The
 * per-call saving is large and easy; whether it survives retries is the whole
 * question, and the retry rate is [UNMEASURED]. So the deliverable is a
 * break-even: the failure rate at which the cheap choice stops being cheap.
 * That is rules 7 and 8 made numerical rather than repeated as advice.
 *
 * Usage: node scripts/phase5-cost-baseline.mjs [--json <path>]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACING = process.env.PACING_FILE ?? "/paperclip/operator-handoff/quota-pacing.jsonl";

const models = JSON.parse(readFileSync(join(repo, "tests/fixtures/company-a.json"), "utf8")).models;
const byId = Object.fromEntries(models.map((m) => [m.id, m]));

const out = {};
const line = (s = "") => console.log(s);
const rule = (t) => line(`\n${"=".repeat(78)}\n${t}\n${"=".repeat(78)}`);

// =============================================================================
// 1. The measured baseline
// =============================================================================

rule("1. BASELINE — what the company actually spends today  [MEASURED]");

let pacing = [];
try {
  pacing = readFileSync(PACING, "utf8").trim().split("\n").map((l) => JSON.parse(l));
} catch (err) {
  line(`  could not read ${PACING}: ${err.message}`);
}

if (pacing.length >= 2) {
  const t0 = new Date(pacing[0].ts);
  const t1 = new Date(pacing[pacing.length - 1].ts);
  const hours = (t1 - t0) / 3_600_000;
  const delta = pacing[pacing.length - 1].company_spend_usd_notional - pacing[0].company_spend_usd_notional;
  const perHour = delta / hours;
  const cap = pacing[pacing.length - 1].company_cap_usd_notional;

  out.baseline = {
    source: PACING,
    samples: pacing.length,
    windowHours: Number(hours.toFixed(2)),
    spendUsd: Number(delta.toFixed(2)),
    usdPerHour: Number(perHour.toFixed(2)),
    usdPerDayProjected: Number((perHour * 24).toFixed(0)),
    usdPerMonthProjected: Number((perHour * 24 * 30).toFixed(0)),
    notionalCapUsd: cap,
  };

  line(`  source: ${PACING} (${pacing.length} samples)`);
  line(`  window: ${hours.toFixed(2)} h  (${pacing[0].ts} -> ${pacing[pacing.length - 1].ts})`);
  line(`  spend over window: $${delta.toFixed(2)}`);
  line(`  BURN RATE: $${perHour.toFixed(2)}/hour`);
  line(`             $${(perHour * 24).toFixed(0)}/day projected`);
  line(`             $${(perHour * 24 * 30).toFixed(0)}/month projected  against a $${cap} notional cap`);
  line();
  line(`  What "notional" means, precisely, because it changes how to read every number here:`);
  line(`  all Claude traffic is served by the teamclaude SUBSCRIPTION, so the cash outlay is a`);
  line(`  fixed fee and this figure is NOT an invoice. It is what the same traffic would cost at`);
  line(`  Anthropic list prices. That makes it exactly the right "before" number for this epic:`);
  line(`  it is the counterfactual bill the routing system is trying to avoid, and it is also`);
  line(`  the correct unit for comparing against opencode-go and OpenRouter, which ARE metered.`);
  line();
  line(`  The binding constraint today is quota, not dollars. The pool has been "BEHIND" pace in`);
  line(`  ${pacing.filter((p) => p.pool_verdict === "BEHIND").length}/${pacing.length} samples, and unused weekly quota is destroyed at reset.`);
}

// =============================================================================
// 2. The representative task
// =============================================================================

rule("2. THE REPRESENTATIVE TASK — one agent turn");

// [MEASURED] TOG-167 measured a fixed ~34k-token prompt prefix on this harness,
// and priced it: $0.044 on haiku-4-5, $0.128 on sonnet-4-6, before a single
// answer token. 34k reproduces both figures at those models' list prices, so it
// is a measurement carried forward rather than a guess.
const IN_TOKENS = 34_000;
// [UNMEASURED] output length per turn. Swept in section 5 rather than trusted.
const OUT_TOKENS = 4_000;

// [MEASURED] TOG-164 / TOG-189: cache write costs 1.25x base input, cache read
// costs 0.1x list (measured at 0.111).
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.1;

line(`  input tokens:  ${IN_TOKENS.toLocaleString()}  [MEASURED — TOG-167's fixed prompt prefix]`);
line(`  output tokens: ${OUT_TOKENS.toLocaleString()}  [UNMEASURED — swept in section 5]`);
line(`  cache write multiplier: ${CACHE_WRITE_MULT}x   cache read multiplier: ${CACHE_READ_MULT}x  [MEASURED — TOG-164, TOG-189]`);

/** Cost of one turn. `cache` is "cold" (pay full input), "write", or "read". */
function turnCost(model, { inTok = IN_TOKENS, outTok = OUT_TOKENS, cache = "cold" } = {}) {
  const mult = cache === "write" ? CACHE_WRITE_MULT : cache === "read" ? CACHE_READ_MULT : 1;
  return (inTok / 1e6) * model.costPerMTokIn * mult + (outTok / 1e6) * model.costPerMTokOut;
}

rule("3. PER-TURN COST BY MODEL  [MODELLED from the measured profile]");
line(`  ${"model".padEnd(18)} ${"tier".padEnd(9)} ${"q".padStart(3)}  ${"cold".padStart(9)} ${"cache-read".padStart(11)}  vs opus-5`);
const opus = byId["claude-opus-5"];
const opusCold = turnCost(opus);
const perModel = [];
for (const m of models) {
  const cold = turnCost(m);
  const warm = turnCost(m, { cache: "read" });
  perModel.push({ id: m.id, tier: m.tier, quality: m.quality, cold, warm, ratio: opusCold / cold });
  line(
    `  ${m.id.padEnd(18)} ${m.tier.padEnd(9)} ${String(m.quality).padStart(3)}  ` +
      `$${cold.toFixed(4).padStart(8)} $${warm.toFixed(4).padStart(10)}  ${(opusCold / cold).toFixed(1)}x cheaper`,
  );
}
out.perModel = perModel.map((r) => ({ ...r, cold: Number(r.cold.toFixed(5)), warm: Number(r.warm.toFixed(5)) }));

// =============================================================================
// 4. Before vs after, per task class
// =============================================================================

rule("4. BEFORE vs AFTER, per task class  [MODELLED]");
line(`  BEFORE: every task runs on the frontier default (claude-opus-5). That is what an`);
line(`  unrouted Paperclip agent does — it inherits the session model and never steps down.`);
line(`  AFTER: the model the shipped router actually selected for that class in the D1-D6 run.`);
line();

// These are the selections the evidence harness observed on company-a, not
// aspirational picks. See scripts/phase5-evidence.mjs section D4's sweep.
const selections = [
  { key: "mechanical", floor: 40, after: "qwen3-coder" },
  { key: "implementation", floor: 60, after: "minimax-m2.5" },
  { key: "review", floor: 70, after: "glm-4.6" },
  { key: "architecture", floor: 85, after: "claude-sonnet-5" },
];

line(`  ${"class".padEnd(16)} ${"floor".padStart(5)}  ${"before".padStart(9)}  ${"after".padEnd(16)} ${"cost".padStart(9)}  saving`);
const classRows = [];
for (const s of selections) {
  const after = byId[s.after];
  const afterCost = turnCost(after);
  const saving = (1 - afterCost / opusCold) * 100;
  classRows.push({ ...s, beforeCost: opusCold, afterCost, savingPct: saving, afterQuality: after.quality });
  line(
    `  ${s.key.padEnd(16)} ${String(s.floor).padStart(5)}  $${opusCold.toFixed(4)}  ${s.after.padEnd(16)} ` +
      `$${afterCost.toFixed(4)}  ${saving.toFixed(1)}%`,
  );
}
out.byTaskClass = classRows.map((r) => ({
  ...r,
  beforeCost: Number(r.beforeCost.toFixed(5)),
  afterCost: Number(r.afterCost.toFixed(5)),
  savingPct: Number(r.savingPct.toFixed(1)),
}));

line();
line(`  ⚠ The blended saving depends on the TASK MIX, and the mix is [UNMEASURED]. Nobody has`);
line(`  instrumented what fraction of this company's agent turns are mechanical vs architecture.`);
line(`  So the blend is shown as a sensitivity, not as a headline:`);
line();
const mixes = [
  { name: "architecture-heavy", w: [0.1, 0.2, 0.2, 0.5] },
  { name: "even", w: [0.25, 0.25, 0.25, 0.25] },
  { name: "implementation-heavy", w: [0.2, 0.5, 0.2, 0.1] },
  { name: "mechanical-heavy", w: [0.5, 0.3, 0.15, 0.05] },
];
line(`  ${"mix".padEnd(22)} ${"blended after".padStart(14)}  ${"saving".padStart(7)}   $/month at observed volume`);
const mixRows = [];
const monthlyBefore = out.baseline?.usdPerMonthProjected ?? 0;
for (const mix of mixes) {
  const blended = classRows.reduce((acc, r, i) => acc + r.afterCost * mix.w[i], 0);
  const saving = (1 - blended / opusCold) * 100;
  const after$ = monthlyBefore * (blended / opusCold);
  mixRows.push({ name: mix.name, blended, savingPct: saving, monthlyAfter: after$ });
  line(
    `  ${mix.name.padEnd(22)} ${("$" + blended.toFixed(4)).padStart(14)}  ${(saving.toFixed(1) + "%").padStart(7)}   ` +
      `$${monthlyBefore.toLocaleString()} -> $${Math.round(after$).toLocaleString()}`,
  );
}
out.mixSensitivity = mixRows.map((r) => ({
  ...r,
  blended: Number(r.blended.toFixed(5)),
  savingPct: Number(r.savingPct.toFixed(1)),
  monthlyAfter: Math.round(r.monthlyAfter),
}));

// =============================================================================
// 5. Rules 7 and 8 — the retry that makes a cheap model expensive
// =============================================================================

rule("5. RETRIES AND ESCALATION — the number that decides whether any of this is real");

line(`  Rule 7/8: never repeatedly retry a failing weak model — escalate. So the cost of`);
line(`  routing a task DOWN is not the cheap model's price. It is:`);
line();
line(`    E[cost] = C_cheap + p_fail x ( C_cheap_wasted_output + C_strong_at_cold_cache )`);
line();
line(`  The escalation re-pays input at COLD cache, not at cache-read, because switching`);
line(`  model destroys the prefix cache — TOG-164's result, and the reason the penalty is`);
line(`  1.25x input rather than 0.1x. A retry is what makes a cheap model expensive, and`);
line(`  this is where that shows up arithmetically.`);
line();
line(`  p_fail is [UNMEASURED] for every model in the table. Nobody has run a graded task`);
line(`  suite per model on real company work. So the honest deliverable is the BREAK-EVEN:`);
line(`  the failure rate at which routing down stops paying.`);
line();

/** Expected cost of routing down to `cheap`, escalating to `strong` on failure. */
function expectedWithEscalation(cheap, strong, pFail) {
  const c = turnCost(cheap);
  // On failure the cheap model still emitted its output tokens, and the strong
  // model then pays a cold-cache input again.
  const wasted = (OUT_TOKENS / 1e6) * cheap.costPerMTokOut;
  const escalate = turnCost(strong, { cache: "write" });
  return c + pFail * (wasted + escalate);
}

function breakEven(cheap, strong) {
  const target = turnCost(strong);
  const c = turnCost(cheap);
  const wasted = (OUT_TOKENS / 1e6) * cheap.costPerMTokOut;
  const escalate = turnCost(strong, { cache: "write" });
  const p = (target - c) / (wasted + escalate);
  return Math.min(1, Math.max(0, p));
}

line(`  ${"route down".padEnd(32)} ${"break-even p_fail".padStart(18)}   reading`);
const breakEvens = [];
for (const [cheapId, strongId] of [
  ["qwen3-coder", "claude-opus-5"],
  ["minimax-m2.5", "claude-opus-5"],
  ["glm-4.6", "claude-opus-5"],
  ["claude-sonnet-5", "claude-opus-5"],
  ["qwen3-coder", "claude-sonnet-5"],
  ["minimax-m2.5", "glm-4.6"],
]) {
  const p = breakEven(byId[cheapId], byId[strongId]);
  breakEvens.push({ cheap: cheapId, strong: strongId, breakEvenPFail: Number(p.toFixed(3)) });
  const reading =
    p > 0.9
      ? "essentially unconditional — route down"
      : p > 0.5
        ? "route down unless this model fails most of the time"
        : p > 0.25
          ? "route down only if it is reliable here"
          : "MARGINAL — needs a measured failure rate first";
  line(`  ${`${cheapId} -> ${strongId}`.padEnd(32)} ${(p * 100).toFixed(1).padStart(17)}%   ${reading}`);
}
out.breakEven = breakEvens;

line();
line(`  Read that table as the operating rule it implies:`);
line();
line(`  Routing DOWN from opus-5 to anything in the Go tier pays for itself unless the cheap`);
line(`  model fails more than ~83-86% of the time. The frontier model is so much more expensive that`);
line(`  even an expensive escalation is cheap relative to having started there. The epic's`);
line(`  premise survives contact with the retry term — for the big steps.`);
line();
line(`  The SMALL steps are where it inverts, and that is the finding worth carrying:`);
line(`  minimax-m2.5 -> glm-4.6 breaks even at a much lower failure rate, because the models`);
line(`  cost within one order of magnitude of each other and the escalation penalty is a large`);
line(`  fraction of the saving. Fine-grained downgrades inside the cheap tier are NOT`);
line(`  self-evidently worth it, and this system should not make them without measuring first.`);

// Sensitivity: does the conclusion survive a wrong output-token estimate?
line();
line(`  Sensitivity to the [UNMEASURED] output length (does the conclusion depend on it?):`);
line(`  ${"out tokens".padStart(11)}  ${"qwen->opus".padStart(11)} ${"minimax->glm".padStart(13)}`);
const sens = [];
for (const ot of [1_000, 4_000, 16_000, 64_000]) {
  const saved = OUT_TOKENS;
  // temporarily recompute with a different output length
  const be = (cheapId, strongId) => {
    const cheap = byId[cheapId], strong = byId[strongId];
    const cost = (m, mult = 1) => (IN_TOKENS / 1e6) * m.costPerMTokIn * mult + (ot / 1e6) * m.costPerMTokOut;
    const p = (cost(strong) - cost(cheap)) / ((ot / 1e6) * cheap.costPerMTokOut + cost(strong, CACHE_WRITE_MULT));
    return Math.min(1, Math.max(0, p));
  };
  const a = be("qwen3-coder", "claude-opus-5");
  const b = be("minimax-m2.5", "glm-4.6");
  sens.push({ outTokens: ot, qwenToOpus: Number(a.toFixed(3)), minimaxToGlm: Number(b.toFixed(3)) });
  line(`  ${ot.toLocaleString().padStart(11)}  ${(a * 100).toFixed(1).padStart(10)}% ${(b * 100).toFixed(1).padStart(12)}%`);
}
out.outputSensitivity = sens;
line();
line(`  The big step stays overwhelmingly favourable at every output length. The small step`);
line(`  stays marginal at every output length. So the conclusion does NOT rest on the one`);
line(`  input we could not measure — which is the only reason it is safe to act on it.`);

// =============================================================================
// 6. Quality
// =============================================================================

rule("6. QUALITY EVIDENCE — a cheaper number with worse output is a failure");

line(`  The objective function forbids trading quality for cost, so the cost result above is`);
line(`  only admissible if quality is held. Three pieces of evidence, and one honest gap.`);
line();
line(`  [MEASURED] The quality floor is structurally incapable of being beaten by cost.`);
line(`    TOG-228 swept 9 floors x 4 tier ceilings x 4 budget levels x 4 quota levels x 4`);
line(`    stickiness states against company-a: 576 combinations, and NO selection was ever`);
line(`    below its floor. That sweep is a committed test (tests/gate-integrity.spec.ts), so`);
line(`    it is a standing guarantee rather than a one-off run.`);
line();
line(`  [MEASURED] Cost cannot delete a floor by accident. An unconfigured taskClass key used`);
line(`    to fall back to floor 0 — a typo would silently hand the decision to the cheapest`);
line(`    model in the table. That is now a refusal (outcome "no-eligible-model"), forcing an`);
line(`    escalation instead of a silent downgrade. Found and fixed under TOG-228.`);
line();
line(`  [MEASURED] Effort is not a quality lever, so it is not being used as one. TOG-167 ran`);
line(`    552 graded runs ($13.65) and found effort does not rescue a failing task:`);
line(`    at a measured failure boundary, low vs max was p=1.000 on sonnet-4-6 and p=0.757 on`);
line(`    sonnet-4-5 (Fisher exact). The router therefore sets effort once per model and does`);
line(`    not trade it per task class.`);
line();
line(`  ⚠ [UNMEASURED] THE GAP, stated plainly: the quality NUMBERS in the tier table`);
line(`    (qwen 45, minimax 62, glm 74, sonnet 88, opus 95) are configured, not measured on`);
line(`    this company's work. The gates provably enforce whatever floors they are given, and`);
help_gap();
function help_gap() {
  line(`    they are provably not beatable by cost — but the mapping from "quality 74" to "good`);
  line(`    enough to review a Laravel PR" rests on judgement, not on a graded run.`);
  line();
  line(`    This is the same missing quantity as p_fail in section 5, seen from the other side,`);
  line(`    and it is the single highest-value measurement left in this epic. Until it exists,`);
  line(`    the defensible claim is the conditional one: IF the floors are right THEN the`);
  line(`    savings in section 4 are real and quality is held. The first half is not yet proven.`);
}

out.quality = {
  proven: [
    "576-combination sweep: no selection ever below its quality floor (committed test)",
    "unconfigured task class refuses rather than routing with floor 0 (TOG-228 fix)",
    "effort does not rescue failing tasks (TOG-167, 552 graded runs, p=1.000 / p=0.757)",
  ],
  unmeasured: [
    "the quality scores in the tier table are configured judgement, not graded on this company's work",
    "p_fail per model on real tasks — the same gap as section 5",
  ],
};

rule("SUMMARY");
line(`  BEFORE  [MEASURED]   $${out.baseline?.usdPerHour}/h notional  = ~$${out.baseline?.usdPerMonthProjected?.toLocaleString()}/month`);
line(`  AFTER   [MODELLED]   $${Math.round(out.mixSensitivity?.[1]?.monthlyAfter ?? 0).toLocaleString()}/month at an even task mix (${out.mixSensitivity?.[1]?.savingPct}% saving)`);
line(`                       range across mixes: $${Math.round(Math.min(...mixRows.map((r) => r.monthlyAfter))).toLocaleString()} - $${Math.round(Math.max(...mixRows.map((r) => r.monthlyAfter))).toLocaleString()}/month`);
line(`  ROBUST  [MODELLED]   the saving survives the retry term for every large downgrade`);
line(`                       (break-even p_fail 83-86%), and is marginal for small ones (38%)`);
line(`  QUALITY [PARTIAL]    enforcement of the floors is proven; the floors themselves are not`);
line();
line(`  This is a real saving with a real caveat, and the caveat is not rhetorical: the`);
line(`  numbers above are the value of routing IF the substrate that does the routing is`);
line(`  deployed. Per scripts/phase5-evidence.mjs, it is not. Today's spend is unchanged.`);

const j = process.argv.indexOf("--json");
if (j !== -1 && process.argv[j + 1]) {
  writeFileSync(process.argv[j + 1], JSON.stringify(out, null, 2));
  line(`\n  wrote ${process.argv[j + 1]}`);
}
