import type { CapacityEvidence } from "../capacity/types.js";
import type { RouterConfig } from "../config/types.js";
import { MODEL_TIER_ORDER, type Candidate, type GateLevel, type ModelEntry, type ModelTier, type RoutingDecision, type RuntimeSignals, type TaskDescriptor } from "./types.js";

const DEFAULT_INPUT_TOKENS = 8_000;
const DEFAULT_OUTPUT_TOKENS = 2_000;
type Ranked = { model: ModelEntry; cost: number; evidence: CapacityEvidence | null };

function tierIndex(tier: ModelTier): number { const index = MODEL_TIER_ORDER.indexOf(tier); return index === -1 ? 1 : index; }
function lowerTier(tier: ModelTier): ModelTier { return MODEL_TIER_ORDER[Math.max(0, tierIndex(tier) - 1)] as ModelTier; }
export function gateLevelFor(value: number | undefined, thresholds: { warn: number; downshift: number; halt: number }): GateLevel {
  if (typeof value !== "number" || !Number.isFinite(value)) return "ok";
  if (value >= thresholds.halt) return "halt";
  if (value >= thresholds.downshift) return "downshift";
  if (value >= thresholds.warn) return "warn";
  return "ok";
}
export function matchRule0(summary: string | undefined, config: RouterConfig): { tool: string; pattern: string } | null {
  if (!config.rule0.enabled || !summary) return null;
  for (const entry of config.rule0.deterministicPatterns) { try { if (new RegExp(entry.pattern, "i").test(summary)) return entry; } catch { continue; } }
  return null;
}
export function scoreTier(descriptor: TaskDescriptor, config: RouterConfig): { tier: ModelTier; score: number | null } {
  if (!descriptor.signals || Object.keys(descriptor.signals).length === 0) return { tier: config.tiering.defaultTier, score: null };
  let score = 0;
  for (const [key, value] of Object.entries(descriptor.signals)) { const weight = config.tiering.signalWeights[key]; if (typeof weight === "number") score += value * weight; }
  for (const tier of [...MODEL_TIER_ORDER].reverse()) if (score >= config.tiering.thresholds[tier]) return { tier, score };
  return { tier: "small", score };
}
function expectedCostUsd(model: ModelEntry, descriptor: TaskDescriptor): number {
  return ((descriptor.estimatedInputTokens ?? DEFAULT_INPUT_TOKENS) / 1_000_000) * model.costPerMTokIn + ((descriptor.estimatedOutputTokens ?? DEFAULT_OUTPUT_TOKENS) / 1_000_000) * model.costPerMTokOut;
}
function evidenceRank(evidence: CapacityEvidence): number {
  switch (evidence.posture) { case "available": return 0; case "conserve": return 1; case "avoid": return 2; case "unknown": return 3; case "unavailable": return 4; }
}
function aggregateEvidenceFor(modelId: string, evidence: CapacityEvidence[]): CapacityEvidence | null {
  const entries = evidence.filter((entry) => entry.modelId === modelId);
  if (entries.length === 0) return null;
  return entries.sort((a, b) =>
    evidenceRank(b) - evidenceRank(a) ||
    (b.utilization ?? -1) - (a.utilization ?? -1) ||
    a.source.localeCompare(b.source) ||
    a.laneLabel.localeCompare(b.laneLabel)
  )[0]!;
}
function baselineOrder(a: Ranked, b: Ranked): number { return a.cost - b.cost || b.model.quality - a.model.quality || a.model.id.localeCompare(b.model.id); }
function capacityOrder(a: Ranked, b: Ranked): number { return (a.evidence ? evidenceRank(a.evidence) : 5) - (b.evidence ? evidenceRank(b.evidence) : 5) || (a.evidence?.utilization ?? Infinity) - (b.evidence?.utilization ?? Infinity) || baselineOrder(a, b); }

export interface SelectInput { descriptor: TaskDescriptor; config: RouterConfig; signals?: RuntimeSignals }

export function selectModel(input: SelectInput): RoutingDecision {
  const { descriptor, config } = input;
  const runtime = input.signals ?? {};
  const trace: string[] = [];
  const rejections: RoutingDecision["rejections"] = [];
  const budgetFraction = runtime.budgetSpentFraction;
  const budgetGate = gateLevelFor(budgetFraction, { warn: config.budget.warnFraction, downshift: config.budget.downshiftFraction, halt: config.budget.haltFraction });
  const capacityEnabled = config.capacityRouting.enabled;
  const evidence = (runtime.capacityEvidence ?? []).map((entry) => {
    // TOG-1062: an explicit `exhausted`/`unavailable` health IS a positive signal,
    // whether or not the producer also sent a utilization number. Test it BEFORE
    // the absence check, which keys off `telemetryAvailable` — and the normalizer
    // only sets that when a utilization is present (capacity/normalize.ts:152).
    // Ordering these the other way flattened a known-exhausted lane to `unknown`,
    // which fail-open then treats as absence and serves anyway.
    if (entry.health === "unavailable" || entry.health === "exhausted") return { ...entry, posture: "unavailable" as const, telemetryAvailable: true };
    if (!entry.telemetryAvailable || entry.health === "unknown" || entry.posture === "unknown") return { ...entry, health: "unknown" as const, posture: "unknown" as const, telemetryAvailable: false };
    if (entry.utilization !== null && entry.utilization >= config.capacityRouting.avoidUtilization) return { ...entry, posture: "avoid" as const };
    if (entry.utilization !== null && entry.utilization >= config.capacityRouting.conserveUtilization) return { ...entry, posture: "conserve" as const };
    return { ...entry, posture: "available" as const };
  });
  const capacityTelemetry = capacityEnabled ? evidence.length > 0 && !runtime.capacityError ? "available" : "unavailable" : "not-configured";
  const effectiveEvidence = capacityTelemetry === "available" ? evidence : [];
  const base: RoutingDecision = {
    outcome: "no-eligible-model", modelId: null, requestedTier: null, effectiveTier: null, taskClass: descriptor.taskClass ?? null, qualityFloor: null,
    trace, rejections, candidates: [], pin: null, fallbackUsed: false,
    capacity: {
      mode: capacityEnabled ? config.capacityRouting.mode : "disabled", telemetry: capacityTelemetry,
      selectedSource: null, selectedLaneLabel: null, usagePosture: "not-evaluated", utilization: null, resetsAt: null,
      shadowModelId: null, shadowSource: null, shadowLaneLabel: null,
      decisionReason: capacityEnabled ? capacityTelemetry === "available" ? "capacity telemetry available" : `capacity telemetry unavailable${runtime.capacityError ? `: ${runtime.capacityError}` : ""}` : "capacity routing disabled",
      degraded: false,
      servingModelId: runtime.servingModelId ?? descriptor.servingModelId ?? null, fallbackEvents: [],
    }, gates: { budget: budgetGate },
  };
  if (!config.routing.enabled) { trace.push("routing.enabled is false — invocation is disabled"); return { ...base, outcome: "disabled" }; }
  const rule0 = matchRule0(descriptor.summary, config);
  if (rule0) { trace.push(`rule 0: summary matches /${rule0.pattern}/i — ${rule0.tool} answers this, no model call`); return { ...base, outcome: "no-model-needed" }; }
  trace.push("rule 0: no deterministic tool matched");
  // TOG-1040: absence of a capacity signal is not a signal that capacity is
  // gone. Losing capacity-awareness must degrade routing quality, not deny
  // service, so only an explicit `fail-closed` refuses here. Under the default
  // `fail-open` we fall through to the static routing policy with a warning:
  // every model then carries `null` evidence, ranks last under capacityOrder,
  // and is still selectable.
  if (capacityEnabled && capacityTelemetry === "unavailable") {
    const detail = runtime.capacityError ? ` (${runtime.capacityError})` : "";
    if (config.capacityRouting.mode === "enforce" && config.capacityRouting.unknownTelemetry === "fail-closed") {
      trace.push(`capacity routing is enforcing and telemetry is unavailable${detail} — refusing`);
      return base;
    }
    base.capacity.degraded = true;
    trace.push(`WARNING: capacity telemetry is unavailable${detail} — falling back to the static routing policy without capacity awareness`);
  }
  const taskClass = descriptor.taskClass ? config.taskClasses.find((entry) => entry.key === descriptor.taskClass) : undefined;
  if (descriptor.taskClass && !taskClass) { trace.push(`task class "${descriptor.taskClass}" is not configured — refusing`); return base; }
  const qualityFloor = taskClass?.qualityFloor ?? 0;
  base.qualityFloor = qualityFloor;
  const scored = scoreTier(descriptor, config);
  base.requestedTier = scored.tier;
  trace.push(scored.score === null ? `tiering: no signals, default tier ${scored.tier}` : `tiering: score ${scored.score.toFixed(2)} -> tier ${scored.tier}`);
  let ceiling = scored.tier;
  if (taskClass?.maxTier && tierIndex(taskClass.maxTier) < tierIndex(ceiling)) ceiling = taskClass.maxTier;
  if (budgetGate === "downshift" || budgetGate === "halt") ceiling = lowerTier(ceiling);
  base.effectiveTier = ceiling;
  const required = new Set<string>([...(descriptor.requiredCapabilities ?? []), ...(taskClass?.requiredCapabilities ?? [])]);
  const qualified: Array<{ model: ModelEntry; cost: number }> = [];
  for (const model of config.models) {
    if (!model.enabled) { rejections.push({ modelId: model.id, stage: "not-in-table", reason: "disabled in the model table" }); continue; }
    const missing = [...required].filter((capability) => !model.capabilities.includes(capability as ModelEntry["capabilities"][number]));
    if (missing.length) { rejections.push({ modelId: model.id, stage: "capability", reason: `missing ${missing.sort().join(", ")}` }); continue; }
    if (descriptor.requiredContextTokens && model.contextWindow < descriptor.requiredContextTokens) { rejections.push({ modelId: model.id, stage: "context-window", reason: `context window ${model.contextWindow} < required ${descriptor.requiredContextTokens}` }); continue; }
    if (model.quality < qualityFloor) { rejections.push({ modelId: model.id, stage: "quality-floor", reason: `quality ${model.quality} < floor ${qualityFloor}` }); continue; }
    qualified.push({ model, cost: expectedCostUsd(model, descriptor) });
  }
  let appliedCeiling = ceiling;
  if (qualified.length && !qualified.some((entry) => tierIndex(entry.model.tier) <= tierIndex(ceiling))) {
    appliedCeiling = qualified.reduce<ModelTier>((lowest, entry) => tierIndex(entry.model.tier) < tierIndex(lowest) ? entry.model.tier : lowest, qualified[0]!.model.tier);
    base.effectiveTier = appliedCeiling;
    trace.push(`tier ceiling ${ceiling} lifted to ${appliedCeiling}: nothing below it clears quality floor ${qualityFloor}`);
  }
  const survivors = qualified.filter((entry) => { if (tierIndex(entry.model.tier) <= tierIndex(appliedCeiling)) return true; rejections.push({ modelId: entry.model.id, stage: "tier-ceiling", reason: `tier ${entry.model.tier} exceeds ceiling ${appliedCeiling}` }); return false; });
  const withCapacity = qualified.map((entry): Ranked => ({ ...entry, evidence: capacityEnabled ? aggregateEvidenceFor(entry.model.id, effectiveEvidence) : null }));
  const survivorIds = new Set(survivors.map((entry) => entry.model.id));
  const ranked = withCapacity.filter((entry) => survivorIds.has(entry.model.id)).sort(baselineOrder);
  // Evidence that positively reports exhaustion. This is the only capacity fact
  // that may deny a model under any policy — it is a real signal, not an absence.
  const positivelyUnavailable = (entry: Ranked): boolean =>
    Boolean(entry.evidence?.telemetryAvailable && entry.evidence.health !== "unknown" && entry.evidence.posture === "unavailable");
  // Evidence good enough to route ON: present, fresh, and not exhausted.
  const covered = (entry: Ranked): boolean =>
    Boolean(entry.evidence?.telemetryAvailable && entry.evidence.health !== "unknown" && entry.evidence.posture !== "unknown" && entry.evidence.posture !== "unavailable");
  // TOG-1040: under `fail-open`, missing/unknown evidence no longer excludes a
  // model — it only sorts it last. Under the stricter policies, absence excludes
  // exactly as before.
  const usable = (entry: Ranked): boolean => {
    if (!capacityEnabled) return true;
    if (config.capacityRouting.unknownTelemetry === "fail-open") return !positivelyUnavailable(entry);
    return covered(entry);
  };
  const unusableSurvivors = ranked.filter((candidate) => !usable(candidate));
  const usageAware = ranked.filter(usable).sort(capacityOrder);
  if (capacityEnabled && config.capacityRouting.mode === "enforce") for (const entry of unusableSurvivors) rejections.push({ modelId: entry.model.id, stage: "capacity", reason: entry.evidence ? `capacity evidence ${entry.evidence.source}/${entry.evidence.laneLabel} is ${entry.evidence.telemetryAvailable ? entry.evidence.posture : "unknown"}` : "no capacity evidence covers this model" });
  // TOG-1040: this used to refuse whenever ANY qualified model had missing or
  // unknown evidence — even when another model had healthy evidence and was
  // ready to serve. That is what produced `no-eligible-model` on records that
  // report `capacity telemetry available`. One uncovered model must not veto a
  // covered one, so only explicit `fail-closed` still refuses.
  if (capacityEnabled && config.capacityRouting.mode === "enforce" && config.capacityRouting.unknownTelemetry === "fail-closed" && unusableSurvivors.length > 0) {
    trace.push("capacity routing fail-closed: at least one qualified model has missing, unknown, or unavailable evidence");
    return base;
  }
  const shadow = capacityEnabled ? usageAware[0] ?? null : null;
  if (shadow) { base.capacity.shadowModelId = shadow.model.id; base.capacity.shadowSource = shadow.evidence?.source ?? null; base.capacity.shadowLaneLabel = shadow.evidence?.laneLabel ?? null; base.capacity.decisionReason = `preferred evidence ${shadow.evidence?.source}/${shadow.evidence?.laneLabel}`; }
  const pool = capacityEnabled && config.capacityRouting.mode === "enforce" ? usageAware : ranked;
  base.candidates = pool.map((entry): Candidate => ({ modelId: entry.model.id, tier: entry.model.tier, quality: entry.model.quality, expectedCostUsd: entry.cost, capacitySource: entry.evidence?.source ?? null, laneLabel: entry.evidence?.laneLabel ?? null, usagePosture: entry.evidence?.posture ?? (capacityEnabled ? "unknown" : "not-evaluated"), utilization: entry.evidence?.utilization ?? null, resetsAt: entry.evidence?.resetsAt ?? null }));
  const capacityFor = (entry: Ranked): RoutingDecision["capacity"] => ({ ...base.capacity, selectedSource: entry.evidence?.source ?? null, selectedLaneLabel: entry.evidence?.laneLabel ?? null, usagePosture: entry.evidence?.posture ?? (capacityEnabled ? "unknown" : "not-evaluated"), utilization: entry.evidence?.utilization ?? null, resetsAt: entry.evidence?.resetsAt ?? null });
  const pinnedId = descriptor.pinnedModelId ?? taskClass?.pinnedModelId ?? null;
  if (pinnedId) { const pinned = withCapacity.find((entry) => entry.model.id === pinnedId); const honored = Boolean(pinned && (!(capacityEnabled && config.capacityRouting.mode === "enforce") || usable(pinned))); const reason = descriptor.pinReason ?? "configured pin"; base.pin = { modelId: pinnedId, reason, honored }; if (honored) return { ...base, outcome: "selected", modelId: pinnedId, capacity: capacityFor(pinned!) }; trace.push(`pin refused: ${pinnedId}`); }
  if (budgetGate === "halt" && !base.pin?.honored) { trace.push("budget gate halt: refusing non-pinned model work"); return base; }
  if (config.routing.stickyModelWithinIssue && runtime.stickyModelId) { const stickyPool = (budgetGate === "downshift" ? ranked : withCapacity).filter((entry) => !(capacityEnabled && config.capacityRouting.mode === "enforce") || usable(entry)); const incumbent = stickyPool.find((entry) => entry.model.id === runtime.stickyModelId); if (incumbent) return { ...base, outcome: "selected", modelId: incumbent.model.id, capacity: capacityFor(incumbent) }; if (pool.length) trace.push(`sticky: ${runtime.stickyModelId} no longer survives the gates, switching despite the cache cost`); }
  if (!pool.length) {
    const fallbackId = config.routing.fallbackModelId;
    if (!fallbackId) return base;
    const model = config.models.find((entry) => entry.id === fallbackId && entry.enabled);
    if (!model) return base;
    const fallback: Ranked = { model, cost: expectedCostUsd(model, descriptor), evidence: capacityEnabled ? aggregateEvidenceFor(fallbackId, effectiveEvidence) : null };
    const clearsQualification = qualified.some((entry) => entry.model.id === fallbackId);
    if (capacityEnabled && config.capacityRouting.mode === "enforce" && !usable(fallback) && !rejections.some((entry) => entry.modelId === fallbackId && entry.stage === "capacity")) {
      rejections.push({ modelId: fallbackId, stage: "capacity", reason: fallback.evidence ? "fallback capacity evidence is unavailable or unknown" : "no capacity evidence covers this fallback model" });
    }
    if (!clearsQualification || (capacityEnabled && config.capacityRouting.mode === "enforce" && !usable(fallback))) {
      trace.push(`fallback ${fallbackId} refused — it must clear capability, context, quality, halt, and enforced capacity gates`);
      return base;
    }
    return { ...base, outcome: "selected", modelId: fallbackId, fallbackUsed: true, capacity: { ...capacityFor(fallback), fallbackEvents: [`configured fallback ${fallbackId} used`] } };
  }
  const winner = pool[0]!;
  trace.push(capacityEnabled && config.capacityRouting.mode === "enforce" ? `selected ${winner.model.id} using capacity evidence ${winner.evidence?.source}/${winner.evidence?.laneLabel}` : `selected ${winner.model.id} at an expected $${winner.cost.toFixed(5)}`);
  if (capacityEnabled && config.capacityRouting.mode === "shadow" && shadow && shadow.model.id !== winner.model.id) trace.push(`capacity shadow would choose ${shadow.model.id}; serving remains ${winner.model.id}`);
  return { ...base, outcome: "selected", modelId: winner.model.id, capacity: capacityFor(winner) };
}
