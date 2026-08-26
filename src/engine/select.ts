import type { RouterConfig } from "../config/types.js";
import {
  MODEL_TIER_ORDER,
  type Candidate,
  type GateLevel,
  type ModelEntry,
  type ModelTier,
  type RoutingDecision,
  type RuntimeSignals,
  type TaskDescriptor,
} from "./types.js";

const DEFAULT_INPUT_TOKENS = 8_000;
const DEFAULT_OUTPUT_TOKENS = 2_000;

function tierIndex(tier: ModelTier): number {
  const index = MODEL_TIER_ORDER.indexOf(tier);
  return index === -1 ? MODEL_TIER_ORDER.indexOf("standard") : index;
}

function lowerTier(tier: ModelTier, steps: number): ModelTier {
  return MODEL_TIER_ORDER[Math.max(0, tierIndex(tier) - steps)] as ModelTier;
}

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

export function matchRule0(
  summary: string | undefined,
  config: RouterConfig,
): { tool: string; pattern: string } | null {
  if (!config.rule0.enabled || !summary) return null;
  for (const entry of config.rule0.deterministicPatterns) {
    try {
      if (new RegExp(entry.pattern, "i").test(summary)) return entry;
    } catch {
      continue;
    }
  }
  return null;
}

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
    if (typeof weight === "number") score += value * weight;
  }
  for (const tier of [...MODEL_TIER_ORDER].reverse()) {
    if (score >= config.tiering.thresholds[tier]) return { tier, score };
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

export interface SelectInput {
  descriptor: TaskDescriptor;
  config: RouterConfig;
  signals?: RuntimeSignals;
}

export function selectModel(input: SelectInput): RoutingDecision {
  const { descriptor, config } = input;
  const runtime = input.signals ?? {};
  const trace: string[] = [];
  const rejections: RoutingDecision["rejections"] = [];
  const budgetFraction = runtime.budgetSpentFraction;
  const budgetGate = gateLevelFor(budgetFraction, {
    warn: config.budget.warnFraction,
    downshift: config.budget.downshiftFraction,
    halt: config.budget.haltFraction,
  });

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
    gates: { budget: budgetGate },
  };

  if (!config.routing.enabled) {
    trace.push("routing.enabled is false — invocation is disabled");
    return { ...base, outcome: "disabled" };
  }

  const rule0 = matchRule0(descriptor.summary, config);
  if (rule0) {
    trace.push(`rule 0: summary matches /${rule0.pattern}/i — ${rule0.tool} answers this, no model call`);
    return { ...base, outcome: "no-model-needed" };
  }
  trace.push("rule 0: no deterministic tool matched");

  const taskClass = descriptor.taskClass
    ? config.taskClasses.find((entry) => entry.key === descriptor.taskClass)
    : undefined;
  if (descriptor.taskClass && !taskClass) {
    trace.push(`task class "${descriptor.taskClass}" is not configured — refusing rather than deleting its quality floor`);
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

  let ceiling = scoredTier;
  if (taskClass?.maxTier && tierIndex(taskClass.maxTier) < tierIndex(ceiling)) {
    ceiling = taskClass.maxTier;
    trace.push(`task class ceiling: ${taskClass.key} caps at ${ceiling}`);
  }
  if (budgetGate === "downshift" || budgetGate === "halt") {
    const dropped = lowerTier(ceiling, 1);
    trace.push(`budget gate ${budgetGate} at ${((budgetFraction ?? 0) * 100).toFixed(0)}% of cap: ceiling ${ceiling} -> ${dropped}`);
    ceiling = dropped;
  } else if (budgetGate === "warn") {
    trace.push(`budget gate warn at ${((budgetFraction ?? 0) * 100).toFixed(0)}% of cap`);
  }
  base.effectiveTier = ceiling;

  const required = new Set<string>([
    ...(descriptor.requiredCapabilities ?? []),
    ...(taskClass?.requiredCapabilities ?? []),
  ]);
  if (required.size > 0) trace.push(`hard capability gate: ${[...required].sort().join(", ")}`);

  const qualified: Array<{ model: ModelEntry; cost: number }> = [];
  for (const model of config.models) {
    if (!model.enabled) {
      rejections.push({ modelId: model.id, stage: "not-in-table", reason: "disabled in the model table" });
      continue;
    }
    const missing = [...required].filter(
      (capability) => !model.capabilities.includes(capability as ModelEntry["capabilities"][number]),
    );
    if (missing.length > 0) {
      rejections.push({ modelId: model.id, stage: "capability", reason: `missing ${missing.sort().join(", ")}` });
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
    if (model.quality < qualityFloor) {
      rejections.push({
        modelId: model.id,
        stage: "quality-floor",
        reason: `quality ${model.quality} < floor ${qualityFloor}`,
      });
      continue;
    }
    qualified.push({ model, cost: expectedCostUsd(model, descriptor) });
  }

  let appliedCeiling = ceiling;
  if (qualified.length > 0 && !qualified.some((entry) => tierIndex(entry.model.tier) <= tierIndex(ceiling))) {
    const lowestQualifiedTier = qualified.reduce<ModelTier>(
      (lowest, entry) => tierIndex(entry.model.tier) < tierIndex(lowest) ? entry.model.tier : lowest,
      qualified[0]!.model.tier,
    );
    trace.push(`tier ceiling ${ceiling} lifted to ${lowestQualifiedTier}: nothing below it clears quality floor ${qualityFloor}`);
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

  survivors.sort((left, right) => {
    if (left.cost !== right.cost) return left.cost - right.cost;
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

  const pinnedId = descriptor.pinnedModelId ?? taskClass?.pinnedModelId ?? null;
  if (pinnedId) {
    const pinnedSurvived = qualified.some((entry) => entry.model.id === pinnedId);
    const reason = descriptor.pinReason ??
      (descriptor.pinnedModelId ? "pinned on the task" : `pinned on task class ${taskClass?.key}`);
    base.pin = { modelId: pinnedId, reason, honored: pinnedSurvived };
    if (pinnedSurvived) {
      trace.push(`pin honoured: ${pinnedId} (${reason})`);
      return { ...base, outcome: "selected", modelId: pinnedId };
    }
    const why = rejections.find((entry) => entry.modelId === pinnedId);
    trace.push(`pin refused: ${pinnedId} (${reason}) — ${why ? `${why.stage}: ${why.reason}` : "not in the model table"}`);
  }

  if (budgetGate === "halt" && !base.pin?.honored) {
    trace.push(`budget gate halt at ${((budgetFraction ?? 0) * 100).toFixed(0)}% of cap: refusing non-pinned model work`);
    return { ...base, outcome: "no-eligible-model" };
  }

  if (config.routing.stickyModelWithinIssue && runtime.stickyModelId) {
    const stickyPool = budgetGate === "downshift" ? survivors : qualified;
    const incumbent = stickyPool.find((entry) => entry.model.id === runtime.stickyModelId);
    if (incumbent) {
      trace.push(`sticky: keeping ${incumbent.model.id} already used on this issue — a switch would destroy the prompt cache`);
      return { ...base, outcome: "selected", modelId: incumbent.model.id };
    }
  }

  if (survivors.length === 0) {
    trace.push(config.models.length === 0 ? "no models configured" : `no model survived the gates (${rejections.length} rejected)`);
    const fallbackId = config.routing.fallbackModelId;
    if (fallbackId) {
      const fallbackModel = config.models.find((model) => model.id === fallbackId && model.enabled);
      if (!fallbackModel) {
        trace.push(`fallback ${fallbackId} refused — it is not an enabled model in this company's table`);
        return { ...base, outcome: "no-eligible-model" };
      }
      trace.push(`fallback model configured: ${fallbackId} — selected before transport despite estimate-level gates`);
      return { ...base, outcome: "selected", modelId: fallbackId, fallbackUsed: true };
    }
    return { ...base, outcome: "no-eligible-model" };
  }

  const winner = survivors[0]!;
  trace.push(`selected ${winner.model.id} at an expected $${winner.cost.toFixed(5)} — cheapest of ${survivors.length} clearing quality floor ${qualityFloor}`);
  return { ...base, outcome: "selected", modelId: winner.model.id };
}
