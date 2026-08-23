/**
 * The routing engine.
 *
 * Objective function, and it is not "use the cheapest model":
 *
 *   minimize expected cost, SUBJECT TO a hard quality floor and hard
 *   capability/privacy/provider constraints.
 *
 * Cost never buys its way past quality. Gates run in a fixed order and each one
 * is a filter, not a weight:
 *
 *   1. Rule 0        — does this need a model at all?
 *   2. Capability    — context window, tools, structured output, modality.
 *   3. Claude block  — a Claude-family model resolves to one provider, or not at all.
 *   4. Quality floor — reject anything below the floor for this task class.
 *   5. Cheapest survivor wins.
 *
 * Budget and quota pressure lower the tier *ceiling*; they never lower the
 * quality floor.
 *
 * Three routes return a model without being the cheapest survivor — a pin,
 * stickiness, and the configured fallback — and the order they are evaluated in
 * is load-bearing, because each one is a way of leaving this function:
 *
 *   pin  ->  budget halt  ->  stickiness  ->  fallback  ->  cheapest survivor
 *
 * The budget halt sits above stickiness and the fallback deliberately. It used
 * to sit below both, which meant a halted company kept spending through either
 * of them. Only a pin outranks it, and that is documented.
 */

import type { RouterConfig } from "../config/types.js";
import {
  MODEL_TIER_ORDER,
  type Candidate,
  type GateLevel,
  type ModelEntry,
  type ModelTier,
  type Rejection,
  type RejectionStage,
  type RoutingDecision,
  type RuntimeSignals,
  type TaskDescriptor,
} from "./types.js";

/** Default token estimate when the caller gives none. Only affects ranking. */
const DEFAULT_INPUT_TOKENS = 8_000;
const DEFAULT_OUTPUT_TOKENS = 2_000;

/**
 * Rejection stages the fallback model may NOT cross.
 *
 * `routing.fallbackModelId` exists so a company can choose a floor rather than
 * a failure, and it is deliberately allowed past the *estimates*: the tier
 * ceiling, the quality floor, a capability the caller only thinks it needs.
 * Those are judgements about fit.
 *
 * These four are not judgements. They are statements that this company may not
 * be served by this model at all — it is not in the table, it is Claude and
 * Claude is confined to one provider, its provider is not approved, or the
 * pooled quota is exhausted. A fallback that crossed them would be a hole
 * straight through Rule 1, and was: see TOG-228.
 */
const NON_NEGOTIABLE_STAGES: readonly RejectionStage[] = [
  "not-in-table",
  "claude-block",
  "provider-not-permitted",
  "quota-gate",
];

function tierIndex(tier: ModelTier): number {
  const index = MODEL_TIER_ORDER.indexOf(tier);
  return index === -1 ? MODEL_TIER_ORDER.indexOf("standard") : index;
}

function lowerTier(tier: ModelTier, steps: number): ModelTier {
  const next = Math.max(0, tierIndex(tier) - steps);
  return MODEL_TIER_ORDER[next] as ModelTier;
}

/** Fraction thresholds -> gate level. Undefined utilization means the gate is unknown, so `ok`. */
export function gateLevelFor(
  value: number | undefined,
  thresholds: { warn: number; downshift: number; halt: number },
): GateLevel {
  if (typeof value !== "number" || !Number.isFinite(value)) return "ok";
  if (value >= thresholds.halt) return "halt";
  if (value >= thresholds.downshift) return "downshift";
  if (value >= thresholds.warn) return "warn";
  return "ok";
}

/** Rule 0: the cheapest call is the one never made. */
export function matchRule0(
  summary: string | undefined,
  config: RouterConfig,
): { tool: string; pattern: string } | null {
  if (!config.rule0.enabled) return null;
  if (!summary) return null;
  for (const entry of config.rule0.deterministicPatterns) {
    let expression: RegExp;
    try {
      expression = new RegExp(entry.pattern, "i");
    } catch {
      // A company can store an invalid pattern. Skip it rather than throwing:
      // a broken Rule 0 entry must not take routing down.
      continue;
    }
    if (expression.test(summary)) return { tool: entry.tool, pattern: entry.pattern };
  }
  return null;
}

/** Weighted-sum tier score. No signals at all means the configured default tier. */
export function scoreTier(
  descriptor: TaskDescriptor,
  config: RouterConfig,
): { tier: ModelTier; score: number | null } {
  const signals = descriptor.signals;
  if (!signals || Object.keys(signals).length === 0) {
    return { tier: config.tiering.defaultTier, score: null };
  }
  let score = 0;
  for (const [key, value] of Object.entries(signals)) {
    const weight = config.tiering.signalWeights[key];
    if (typeof weight !== "number") continue;
    score += value * weight;
  }
  const thresholds = config.tiering.thresholds;
  for (const tier of [...MODEL_TIER_ORDER].reverse()) {
    if (score >= thresholds[tier]) return { tier, score };
  }
  return { tier: "small", score };
}

function expectedCostUsd(model: ModelEntry, descriptor: TaskDescriptor): number {
  const inputTokens = descriptor.estimatedInputTokens ?? DEFAULT_INPUT_TOKENS;
  const outputTokens = descriptor.estimatedOutputTokens ?? DEFAULT_OUTPUT_TOKENS;
  return (
    (inputTokens / 1_000_000) * model.costPerMTokIn +
    (outputTokens / 1_000_000) * model.costPerMTokOut
  );
}

function isClaudeFamily(model: ModelEntry, config: RouterConfig): boolean {
  const family = model.family.toLowerCase();
  return config.providers.claudeFamilies.some((entry) => entry.toLowerCase() === family);
}

/**
 * Providers a model may actually be served by in this company, after the
 * permitted list and the Claude block.
 *
 * Returns null when the model is blocked outright.
 */
function permittedProvidersFor(
  model: ModelEntry,
  config: RouterConfig,
): { providers: string[]; blockedBy: "claude-block" | "provider-not-permitted" | null } {
  const permitted = config.providers.permitted;
  // An empty permitted list means "no provider is approved yet", not "all are".
  // Failing closed is the only safe reading for a company that has not configured this.
  const intersect = model.providers.filter((provider) => permitted.includes(provider));

  if (isClaudeFamily(model, config) && !config.providers.claudePaygEnabled) {
    const only = config.providers.claudeFamilyProvider;
    const claudeOk = intersect.filter((provider) => provider === only);
    if (claudeOk.length === 0) {
      return { providers: [], blockedBy: "claude-block" };
    }
    return { providers: claudeOk, blockedBy: null };
  }

  if (intersect.length === 0) return { providers: [], blockedBy: "provider-not-permitted" };
  return { providers: intersect, blockedBy: null };
}

function providerRank(providers: string[], config: RouterConfig): number {
  let best = Number.MAX_SAFE_INTEGER;
  for (const provider of providers) {
    const index = config.providers.preferenceOrder.indexOf(provider);
    const rank = index === -1 ? config.providers.preferenceOrder.length : index;
    if (rank < best) best = rank;
  }
  return best;
}

export interface SelectInput {
  descriptor: TaskDescriptor;
  config: RouterConfig;
  signals?: RuntimeSignals;
}

export function selectModel(input: SelectInput): RoutingDecision {
  const { descriptor, config } = input;
  const runtime = input.signals ?? {};
  const trace: string[] = [];
  const rejections: Rejection[] = [];

  const budgetFraction = runtime.budgetSpentFraction;
  const budgetGate = gateLevelFor(budgetFraction, {
    warn: config.budget.warnFraction,
    downshift: config.budget.downshiftFraction,
    halt: config.budget.haltFraction,
  });
  const claudeQuotaGate = config.quotaGate.enabled
    ? gateLevelFor(runtime.claudeQuotaUtilization, {
        warn: config.quotaGate.warnUtilization,
        downshift: config.quotaGate.downshiftUtilization,
        halt: config.quotaGate.pauseUtilization,
      })
    : "ok";

  const base: RoutingDecision = {
    outcome: "no-eligible-model",
    modelId: null,
    requestedTier: null,
    effectiveTier: null,
    taskClass: descriptor.taskClass ?? null,
    qualityFloor: null,
    trace,
    rejections,
    candidates: [],
    pin: null,
    fallbackUsed: false,
    gates: { budget: budgetGate, claudeQuota: claudeQuotaGate },
  };

  // A gate that cannot read its own input is not a gate. The quota reader fails
  // soft on purpose — a teamclaude outage must not take routing down — but the
  // resulting `ok` is "unknown", not "healthy", and the caller has to be able to
  // tell those apart.
  if (config.quotaGate.enabled && typeof runtime.claudeQuotaUtilization !== "number") {
    trace.push(
      `claude quota gate is enabled but utilization is unknown${
        runtime.claudeQuotaError ? ` (${runtime.claudeQuotaError})` : ""
      } — the gate is OPEN and Claude work is not being throttled`,
    );
  }

  if (!config.routing.enabled) {
    trace.push("routing.enabled is false — the caller keeps its own model");
    return { ...base, outcome: "disabled" };
  }

  // ---- 1. Rule 0 -----------------------------------------------------------
  const rule0 = matchRule0(descriptor.summary, config);
  if (rule0) {
    trace.push(
      `rule 0: summary matches /${rule0.pattern}/i — ${rule0.tool} answers this, no model call`,
    );
    return { ...base, outcome: "no-model-needed" };
  }
  trace.push("rule 0: no deterministic tool matched");

  // ---- task class and quality floor ---------------------------------------
  const taskClass = descriptor.taskClass
    ? config.taskClasses.find((entry) => entry.key === descriptor.taskClass)
    : undefined;
  if (descriptor.taskClass && !taskClass) {
    // Falling back to floor 0 here is the most expensive kind of bug: a typo in
    // a class key silently deletes the quality floor, and the cheapest model in
    // the table wins a decision that was supposed to demand the best one. That
    // is cost beating quality, which this engine forbids. Refuse instead — the
    // caller must escalate, not silently downgrade.
    trace.push(
      `task class "${descriptor.taskClass}" is not configured for this company — refusing rather than routing with no quality floor; configure the class or send no taskClass`,
    );
    return { ...base, outcome: "no-eligible-model" };
  }
  const qualityFloor = taskClass?.qualityFloor ?? 0;
  base.qualityFloor = qualityFloor;

  const { tier: scoredTier, score } = scoreTier(descriptor, config);
  base.requestedTier = scoredTier;
  trace.push(
    score === null
      ? `tiering: no signals, default tier ${scoredTier}`
      : `tiering: score ${score.toFixed(2)} -> tier ${scoredTier}`,
  );

  // ---- tier ceiling: task class, then budget and quota pressure ------------
  let ceiling = scoredTier;
  if (taskClass?.maxTier && tierIndex(taskClass.maxTier) < tierIndex(ceiling)) {
    ceiling = taskClass.maxTier;
    trace.push(`task class ceiling: ${taskClass.key} caps at ${ceiling}`);
  }
  if (budgetGate === "downshift" || budgetGate === "halt") {
    const dropped = lowerTier(ceiling, 1);
    trace.push(
      `budget gate ${budgetGate} at ${((budgetFraction ?? 0) * 100).toFixed(0)}% of cap: ceiling ${ceiling} -> ${dropped}`,
    );
    ceiling = dropped;
  } else if (budgetGate === "warn") {
    trace.push(`budget gate warn at ${((budgetFraction ?? 0) * 100).toFixed(0)}% of cap`);
  }
  if (claudeQuotaGate === "downshift") {
    trace.push(
      `claude quota gate downshift at ${((runtime.claudeQuotaUtilization ?? 0) * 100).toFixed(0)}% utilization: Claude-family models are dropped a tier`,
    );
  } else if (claudeQuotaGate === "halt") {
    trace.push(
      `claude quota gate paused at ${((runtime.claudeQuotaUtilization ?? 0) * 100).toFixed(0)}% utilization: Claude-family models are unavailable`,
    );
  }
  base.effectiveTier = ceiling;

  // ---- required capabilities ----------------------------------------------
  const required = new Set<string>([
    ...(descriptor.requiredCapabilities ?? []),
    ...(taskClass?.requiredCapabilities ?? []),
  ]);
  if (required.size > 0) {
    trace.push(`hard capability gate: ${[...required].sort().join(", ")}`);
  }

  // ---- candidate filtering -------------------------------------------------
  // `qualified` holds everything that cleared every HARD gate: capability,
  // context window, the Claude block, provider permission, the quota gate and
  // the quality floor. The tier ceiling is applied afterwards, because it is a
  // cost control and cost may never overrule the quality floor.
  const qualified: Array<{ model: ModelEntry; providers: string[]; cost: number }> = [];

  for (const model of config.models) {
    if (!model.enabled) {
      rejections.push({ modelId: model.id, stage: "not-in-table", reason: "disabled in the model table" });
      continue;
    }

    // 2. hard capability gates
    const missing = [...required].filter(
      (capability) => !model.capabilities.includes(capability as ModelEntry["capabilities"][number]),
    );
    if (missing.length > 0) {
      rejections.push({
        modelId: model.id,
        stage: "capability",
        reason: `missing ${missing.sort().join(", ")}`,
      });
      continue;
    }
    if (
      typeof descriptor.requiredContextTokens === "number" &&
      model.contextWindow < descriptor.requiredContextTokens
    ) {
      rejections.push({
        modelId: model.id,
        stage: "context-window",
        reason: `context window ${model.contextWindow} < required ${descriptor.requiredContextTokens}`,
      });
      continue;
    }

    // 3. the Claude block, and the permitted-provider list
    const { providers, blockedBy } = permittedProvidersFor(model, config);
    if (blockedBy === "claude-block") {
      rejections.push({
        modelId: model.id,
        stage: "claude-block",
        reason: `Claude-family model may only be served by ${config.providers.claudeFamilyProvider} while Claude PAYG is disabled`,
      });
      continue;
    }
    if (blockedBy === "provider-not-permitted") {
      rejections.push({
        modelId: model.id,
        stage: "provider-not-permitted",
        reason:
          model.providers.length === 0
            ? "model lists no providers"
            : `none of ${model.providers.join(", ")} is permitted for this company`,
      });
      continue;
    }

    // the quota gate is a Claude-family gate only; it never touches other families
    if (isClaudeFamily(model, config)) {
      if (claudeQuotaGate === "halt") {
        rejections.push({
          modelId: model.id,
          stage: "quota-gate",
          reason: `Claude work is paused at ${((runtime.claudeQuotaUtilization ?? 0) * 100).toFixed(0)}% pooled quota utilization`,
        });
        continue;
      }
      if (claudeQuotaGate === "downshift" && tierIndex(model.tier) > tierIndex(lowerTier(ceiling, 1))) {
        rejections.push({
          modelId: model.id,
          stage: "quota-gate",
          reason: `Claude tier ${model.tier} exceeds the downshifted ceiling ${lowerTier(ceiling, 1)}`,
        });
        continue;
      }
    }

    // 4. quality floor — the one comparison cost may never win
    if (model.quality < qualityFloor) {
      rejections.push({
        modelId: model.id,
        stage: "quality-floor",
        reason: `quality ${model.quality} < floor ${qualityFloor}`,
      });
      continue;
    }

    qualified.push({ model, providers, cost: expectedCostUsd(model, descriptor) });
  }

  // ---- tier ceiling, applied last and never below the quality floor --------
  // If the ceiling would eliminate every model that cleared the floor, the floor
  // wins: the ceiling lifts to the cheapest tier that can actually do the job,
  // and the trace says so. A cost control that silently blocks all work is worse
  // than no cost control, and degrading below the floor is explicitly forbidden.
  let appliedCeiling = ceiling;
  if (qualified.length > 0 && !qualified.some((entry) => tierIndex(entry.model.tier) <= tierIndex(ceiling))) {
    const lowestQualifiedTier = qualified.reduce<ModelTier>(
      (lowest, entry) => (tierIndex(entry.model.tier) < tierIndex(lowest) ? entry.model.tier : lowest),
      qualified[0]!.model.tier,
    );
    trace.push(
      `tier ceiling ${ceiling} lifted to ${lowestQualifiedTier}: nothing at or below ${ceiling} clears the quality floor ${qualityFloor}, and cost never overrules the floor`,
    );
    appliedCeiling = lowestQualifiedTier;
    base.effectiveTier = lowestQualifiedTier;
  }

  const survivors = qualified.filter((entry) => {
    if (tierIndex(entry.model.tier) <= tierIndex(appliedCeiling)) return true;
    rejections.push({
      modelId: entry.model.id,
      stage: "tier-ceiling",
      reason: `tier ${entry.model.tier} exceeds ceiling ${appliedCeiling}`,
    });
    return false;
  });

  // 5. cheapest survivor wins; provider preference and quality break ties
  survivors.sort((left, right) => {
    if (left.cost !== right.cost) return left.cost - right.cost;
    const rank = providerRank(left.providers, config) - providerRank(right.providers, config);
    if (rank !== 0) return rank;
    if (left.model.quality !== right.model.quality) return right.model.quality - left.model.quality;
    return left.model.id.localeCompare(right.model.id);
  });

  const candidates: Candidate[] = survivors.map((entry) => ({
    modelId: entry.model.id,
    tier: entry.model.tier,
    quality: entry.model.quality,
    expectedCostUsd: entry.cost,
  }));
  base.candidates = candidates;

  // ---- pins ----------------------------------------------------------------
  // A pin is honoured only if the pinned model survived every gate. A pin is an
  // instruction about preference, not a licence to cross the Claude block.
  // A pin names a model explicitly, so the tier ceiling — an estimate and a cost
  // control — does not block it. Every hard gate still does.
  const pinnedId = descriptor.pinnedModelId ?? taskClass?.pinnedModelId ?? null;
  if (pinnedId) {
    const pinnedSurvived = qualified.some((entry) => entry.model.id === pinnedId);
    const reason =
      descriptor.pinReason ??
      (descriptor.pinnedModelId ? "pinned on the task" : `pinned on task class ${taskClass?.key}`);
    base.pin = { modelId: pinnedId, reason, honored: pinnedSurvived };
    if (pinnedSurvived) {
      trace.push(`pin honoured: ${pinnedId} (${reason})`);
      return {
        ...base,
        outcome: "selected",
        modelId: pinnedId,
      };
    }
    const why = rejections.find((entry) => entry.modelId === pinnedId);
    trace.push(
      `pin refused: ${pinnedId} (${reason}) — ${why ? `${why.stage}: ${why.reason}` : "not in this company's model table"}`,
    );
  }

  // ---- budget halt ---------------------------------------------------------
  // Checked here, immediately after the pin, because everything below this line
  // is a way of returning a model: stickiness, and the fallback. Both used to
  // sit in front of this check and both therefore ignored it — a halted company
  // kept right on spending. A pin is the one documented exception.
  if (budgetGate === "halt" && !pinnedId) {
    trace.push(
      `budget gate halt at ${((budgetFraction ?? 0) * 100).toFixed(0)}% of cap: refusing non-pinned model work`,
    );
    return { ...base, outcome: "no-eligible-model" };
  }

  // ---- cache-preserving stickiness ----------------------------------------
  // Switching model mid-issue throws away the prompt cache, which can cost more
  // than the model difference saves. Keep the incumbent when it still survives.
  if (config.routing.stickyModelWithinIssue && runtime.stickyModelId) {
    // The incumbent is judged against the hard gates, not the tier ceiling: the
    // ceiling is a cost estimate, and throwing away the cache is itself a cost.
    // Real cost pressure still wins — under budget or quota downshift the
    // incumbent has to re-qualify under the lowered ceiling like anything else.
    const underPressure =
      budgetGate === "downshift" ||
      budgetGate === "halt" ||
      claudeQuotaGate === "downshift" ||
      claudeQuotaGate === "halt";
    const stickyPool = underPressure ? survivors : qualified;
    const incumbent = stickyPool.find((entry) => entry.model.id === runtime.stickyModelId);
    if (incumbent) {
      trace.push(
        `sticky: keeping ${incumbent.model.id} already used on this issue — a switch would destroy the prompt cache`,
      );
      return { ...base, outcome: "selected", modelId: incumbent.model.id };
    }
    if (survivors.length > 0) {
      trace.push(
        `sticky: ${runtime.stickyModelId} no longer survives the gates, switching despite the cache cost`,
      );
    }
  }

  if (survivors.length === 0) {
    if (config.models.length === 0) {
      trace.push("no models configured for this company — nothing to select from");
    } else {
      trace.push(`no model survived the gates (${rejections.length} rejected)`);
    }
    const fallbackId = config.routing.fallbackModelId;
    if (fallbackId) {
      // The fallback is an escape hatch from the estimates, not from the rules.
      const blocker = rejections.find(
        (entry) =>
          entry.modelId === fallbackId &&
          NON_NEGOTIABLE_STAGES.includes(entry.stage),
      );
      const inTable = config.models.some((model) => model.id === fallbackId);
      if (blocker) {
        trace.push(
          `fallback ${fallbackId} refused — ${blocker.stage}: ${blocker.reason}. A fallback may cross a capability or quality estimate; it may not cross a hard constraint.`,
        );
        return { ...base, outcome: "no-eligible-model" };
      }
      if (!inTable) {
        // Unknown to this company's table means unknown to every gate, so the
        // Claude block never got a chance to look at it. Refuse: an id nobody
        // has vetted is exactly how a Claude model reaches a PAYG provider.
        trace.push(
          `fallback ${fallbackId} refused — it is not in this company's model table, so no gate has vetted it`,
        );
        return { ...base, outcome: "no-eligible-model" };
      }
      trace.push(
        `fallback model configured: ${fallbackId} — it clears every hard constraint and is used despite the gates above`,
      );
      return { ...base, outcome: "selected", modelId: fallbackId, fallbackUsed: true };
    }
    return { ...base, outcome: "no-eligible-model" };
  }

  const winner = survivors[0]!;
  trace.push(
    `selected ${winner.model.id} at an expected $${winner.cost.toFixed(5)} — cheapest of ${survivors.length} that cleared quality floor ${qualityFloor}`,
  );
  return { ...base, outcome: "selected", modelId: winner.model.id };
}
