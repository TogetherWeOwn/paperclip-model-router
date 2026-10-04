import type { CapacityEvidence, LanePaceVerdict, PaceState } from "../capacity/types.js";
import { boundRule0Summary } from "../config/rule0.js";
import type { RouterConfig } from "../config/types.js";
import { formatUsd } from "../spend-ledger.js";
import { MODEL_TIER_ORDER, type Candidate, type GateLevel, type ModelEntry, type ModelTier, type RoutingDecision, type RuntimeSignals, type TaskDescriptor } from "./types.js";

const DEFAULT_INPUT_TOKENS = 8_000;
const DEFAULT_OUTPUT_TOKENS = 2_000;
// TOG-3551 (scope 3): a pin must never park work on a lane already running hot.
// Above this governing-window (weekly, for the roster lanes) utilization the
// pin is refused even when the capacity gate would still count the lane
// "usable" — a lane at 0.85 is one burst from exhaustion and is not a safe pin
// target. Expressed as a fraction to match `CapacityEvidence.utilization`.
const PIN_MAX_WEEKLY_UTILIZATION = 0.7;
type Ranked = { model: ModelEntry; cost: number; evidence: CapacityEvidence | null; pace?: LanePaceVerdict | null };

// TOG-2139 (slice 6): pace-state ranking for `capacityRouting.paceOrdering`.
// Behind = win (the lane is under-consuming its subscription relative to its
// governing window; unused allowance is destroyed at reset, so the furthest
// behind is the cheapest real resource). `exhausted` and `unknown`/absent
// verdicts rank last — an unknown pace must never outrank a known one, and an
// exhausted lane must not win ordering even though the capacity gate (not
// pace) is what would actually exclude it.
const PACE_STATE_RANK: Record<PaceState, number> = {
  "behind-urgent": 0,
  behind: 1,
  on: 2,
  ahead: 3,
  free: 4,
  exhausted: 5,
  unknown: 6,
};

function paceDeviation(verdict: LanePaceVerdict | null | undefined): number {
  return typeof verdict?.score?.deviation === "number" ? verdict.score.deviation : Number.NaN;
}

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
  // TOG-7881 (G2): patterns are precompiled once at config resolution
  // (`resolveConfig` → `compileRule0Pattern`); the hot path reuses the stored
  // regex and never constructs one. The summary is length-bounded so every
  // match runs over a finite input alongside the load-time nested-quantifier
  // rejection.
  const bounded = boundRule0Summary(summary);
  for (const entry of config.rule0.deterministicPatterns) {
    if (entry.regex.test(bounded)) return { tool: entry.tool, pattern: entry.pattern };
  }
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

// TOG-2139 (slice 6): pace-first ordering (TOG-2048 D1 — accepted). Within an
// already-gated survivor pool: the eligible lane furthest BEHIND its pace line
// wins, deviation (utilisation − elapsed) breaks state ties toward the more
// behind lane, and everything else falls through to the comparator that pool
// used before this flag existed (baseline in shadow, capacity in enforce), so
// the flag only ever PREFIXES pace onto the existing order. Models without a
// usable verdict rank last together (fail-neutral). The comparator never changes
// eligibility; in enforce mode the capacity gate also rejects a positive
// serviceability-window trip before this comparator sees a row.
function paceOrder(next: (a: Ranked, b: Ranked) => number): (a: Ranked, b: Ranked) => number {
  return (a, b) => {
    const rankA = a.pace ? PACE_STATE_RANK[a.pace.state] : PACE_STATE_RANK.unknown;
    const rankB = b.pace ? PACE_STATE_RANK[b.pace.state] : PACE_STATE_RANK.unknown;
    if (rankA !== rankB) return rankA - rankB;
    const deviationA = paceDeviation(a.pace);
    const deviationB = paceDeviation(b.pace);
    if (Number.isFinite(deviationA) && Number.isFinite(deviationB) && deviationA !== deviationB) return deviationA - deviationB;
    return next(a, b);
  };
}

export interface SelectInput { descriptor: TaskDescriptor; config: RouterConfig; signals?: RuntimeSignals }

export function selectModel(input: SelectInput): RoutingDecision {
  const { descriptor, config } = input;
  const runtime = input.signals ?? {};
  const trace: string[] = [];
  const rejections: RoutingDecision["rejections"] = [];
  const budgetFraction = runtime.budgetSpentFraction;
  const budgetGate = gateLevelFor(budgetFraction, { warn: config.budget.warnFraction, downshift: config.budget.downshiftFraction, halt: config.budget.haltFraction });
  // TOG-7891 (Gap G4): provenance of the fraction above. The worker resolves
  // it from the monthly spend ledger, the TOG-7417 host injection, or the
  // caller claim; direct unit callers hand a fraction straight in and leave
  // the source absent, which reads `unspecified`. The gate movement itself is
  // unchanged — only its audit trail is new.
  const budgetSource = runtime.budgetFractionSource ?? "unspecified";
  const budgetLedger = runtime.budgetLedger && typeof runtime.budgetLedger.totalUsd === "number" &&
    Number.isFinite(runtime.budgetLedger.totalUsd) && typeof runtime.budgetLedger.monthLabel === "string"
    ? { totalUsd: runtime.budgetLedger.totalUsd, monthLabel: runtime.budgetLedger.monthLabel }
    : null;
  const budgetAudit: RoutingDecision["budget"] = {
    source: budgetSource,
    fraction: typeof budgetFraction === "number" && Number.isFinite(budgetFraction) ? budgetFraction : null,
    ledger: budgetLedger,
  };
  // TOG-7891 (Gap G4): when the gates move off the monthly spend ledger, say
  // so on the trace with the hand-recomputable inputs (dollars, cap, month).
  // Other sources keep their existing traces untouched.
  if (budgetSource === "ledger" && budgetLedger) {
    trace.push(
      `budget: $${formatUsd(budgetLedger.totalUsd)} of $${formatUsd(config.budget.monthlyCapUsd)} spent in ${budgetLedger.monthLabel} from the monthly spend ledger — gates move off the ledger fraction`,
    );
  }
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
  // Contract §4: producer health is a REPORTED fact, not one inferred from the
  // record count. Inferring it — the `evidence.length > 0` fallback below — is
  // precisely the collapse the contract exists to prevent, because it makes a
  // telemetry outage indistinguishable from a deployment that is healthy and
  // simply governs nothing. The fallback is kept only for the legacy vendor
  // path, which has no `telemetry` field to report.
  const producerHealthy = runtime.capacityTelemetry !== undefined
    ? runtime.capacityTelemetry === "available"
    : evidence.length > 0;
  const capacityTelemetry = capacityEnabled ? producerHealthy && !runtime.capacityError ? "available" : "unavailable" : "not-configured";
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
      // TOG-7885 (G8): pass through the worker-computed snapshot age. When
      // capacity routing is disabled there is no snapshot to age, so both
      // read null/false regardless of what the caller handed down.
      snapshotAgeMs: capacityEnabled ? runtime.capacitySnapshotAgeMs ?? null : null,
      snapshotStale: capacityEnabled ? runtime.capacitySnapshotStale ?? false : false,
      servingModelId: runtime.servingModelId ?? descriptor.servingModelId ?? null, fallbackEvents: [],
    }, gates: { budget: budgetGate }, budget: budgetAudit,
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
  // TOG-2139: pace verdicts attach to survivors only — a model rejected by any
  // upstream gate (qualityFloor, capability, context, tier ceiling) never
  // reaches this pool, so pace cannot promote it into eligibility. `ranked`
  // keeps its static baseline ordering: in `capacityRouting.mode: shadow` the
  // served model follows the static policy and the pace-aware pick surfaces
  // through the shadow advisory, exactly like capacity ordering today.
  const paceActive = capacityEnabled && config.capacityRouting.paceOrdering === true;
  const paceFor = (modelId: string): LanePaceVerdict | null => {
    if (!paceActive) return null;
    const laneId = runtime.modelLaneByPace?.[modelId];
    if (!laneId) return null;
    return runtime.paceVerdicts?.[laneId] ?? null;
  };
  const ranked = withCapacity
    .filter((entry) => survivorIds.has(entry.model.id))
    .map((entry): Ranked => ({ ...entry, pace: paceFor(entry.model.id) }))
    .sort(baselineOrder);
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
  const serviceabilityTripped = (entry: Ranked): boolean =>
    paceFor(entry.model.id)?.reason === "serviceability-window-exhausted";
  const usable = (entry: Ranked): boolean => {
    if (!capacityEnabled) return true;
    // Resolve by id: pins, sticky incumbents and fallbacks need not be in `ranked`.
    if (serviceabilityTripped(entry)) return false;
    if (config.capacityRouting.unknownTelemetry === "fail-open") return !positivelyUnavailable(entry);
    return covered(entry);
  };
  const unusableSurvivors = ranked.filter((candidate) => !usable(candidate));
  const usageAware = ranked.filter(usable).sort(paceActive ? paceOrder(capacityOrder) : capacityOrder);
  if (capacityEnabled && config.capacityRouting.mode === "enforce") for (const entry of unusableSurvivors) rejections.push({ modelId: entry.model.id, stage: "capacity", reason: serviceabilityTripped(entry) ? "serviceability-window-exhausted" : entry.evidence ? `capacity evidence ${entry.evidence.source}/${entry.evidence.laneLabel} is ${entry.evidence.telemetryAvailable ? entry.evidence.posture : "unknown"}` : "no capacity evidence covers this model" });
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
  // TOG-7160 (port of TOG-930): deprioritize invocation-degraded models to
  // last resort. A degraded model stays selectable when it is the only
  // option (or is explicitly pinned) but never wins while anything healthier
  // can serve. When every in-ceiling candidate is degraded but healthier
  // qualified models exist above the soft tier ceiling, the ceiling lifts for
  // them exactly like the quality-floor lift above — the tier ceiling is
  // soft, health is evidence. Capacity usability still applies: a lifted
  // model must clear the same `usable` gate the pool did.
  const degraded = runtime.degradedModelIds ?? new Set<string>();
  let routingPool = pool;
  const nonDegradedPool = pool.filter((entry) => !degraded.has(entry.model.id));
  if (pool.length > 0 && nonDegradedPool.length > 0 && nonDegradedPool.length < pool.length) {
    routingPool = nonDegradedPool;
    trace.push(
      `health: deprioritized ${pool.length - nonDegradedPool.length} degraded model(s); ${nonDegradedPool.length} healthier candidate(s) remain`,
    );
  } else if (pool.length > 0 && nonDegradedPool.length === 0) {
    const healthier = withCapacity
      .filter((entry) => !degraded.has(entry.model.id) && usable(entry))
      .map((entry): Ranked => ({ ...entry, pace: paceFor(entry.model.id) }))
      .sort(capacityEnabled && config.capacityRouting.mode === "enforce"
        ? (paceActive ? paceOrder(capacityOrder) : capacityOrder)
        : baselineOrder);
    if (healthier.length > 0) {
      routingPool = healthier;
      const readmittedIds = new Set(healthier.map((entry) => entry.model.id));
      for (let index = rejections.length - 1; index >= 0; index--) {
        const rejection = rejections[index]!;
        if (rejection.stage === "tier-ceiling" && readmittedIds.has(rejection.modelId)) {
          rejections.splice(index, 1);
        }
      }
      trace.push(
        `health: every candidate under the ${appliedCeiling} ceiling is degraded; lifted the soft ceiling for ${healthier.length} healthier qualified model(s)`,
      );
      base.effectiveTier = healthier[0]!.model.tier;
    } else {
      trace.push("health: every qualified model is degraded; retaining them as last-resort candidates");
    }
  }
  base.candidates = routingPool.map((entry): Candidate => ({ modelId: entry.model.id, tier: entry.model.tier, quality: entry.model.quality, expectedCostUsd: entry.cost, capacitySource: entry.evidence?.source ?? null, laneLabel: entry.evidence?.laneLabel ?? null, usagePosture: entry.evidence?.posture ?? (capacityEnabled ? "unknown" : "not-evaluated"), utilization: entry.evidence?.utilization ?? null, resetsAt: entry.evidence?.resetsAt ?? null, paceState: paceActive ? entry.pace?.state ?? "unknown" : "not-evaluated", paceDeviation: paceActive ? (entry.pace?.score?.deviation ?? null) : null }));
  // TOG-1076: `degraded` announces "we served without capacity awareness". Line
  // 102 raises it when telemetry is wholly unavailable, but under `fail-open` a
  // model no source covers is equally uninformed — and until now reported
  // degraded=false because the telemetry FETCH succeeded. That is the same
  // epistemic state reported two opposite ways, and it is what would let an
  // unmetered lane absorb fleet exhaustion invisibly. Judge the evidence behind
  // the model actually selected, not the health of the fetch.
  const capacityFor = (entry: Ranked): RoutingDecision["capacity"] => ({ ...base.capacity, degraded: base.capacity.degraded || (capacityEnabled && config.capacityRouting.mode === "enforce" && !covered(entry)), selectedSource: entry.evidence?.source ?? null, selectedLaneLabel: entry.evidence?.laneLabel ?? null, usagePosture: entry.evidence?.posture ?? (capacityEnabled ? "unknown" : "not-evaluated"), utilization: entry.evidence?.utilization ?? null, resetsAt: entry.evidence?.resetsAt ?? null });
  const pinnedId = descriptor.pinnedModelId ?? taskClass?.pinnedModelId ?? null;
  if (pinnedId) {
    const pinned = withCapacity.find((entry) => entry.model.id === pinnedId);
    // TOG-3551 (scope 3): refuse the pin when telemetry shows the lane above the
    // weekly utilization cap. Applies whenever capacity telemetry gives a real
    // reading (both shadow and enforce) — a hot lane is hot regardless of the
    // routing mode; a null reading (no telemetry) cannot trip the cap.
    const pinnedUtil = pinned?.evidence?.utilization ?? null;
    const overUtilCap = capacityEnabled && pinnedUtil !== null && pinnedUtil > PIN_MAX_WEEKLY_UTILIZATION;
    // TOG-3551 (scope 3): a blocklisted id is never honored as a pin, whatever
    // the mode or evidence — this is the operator list of known-unserved /
    // payment_required ids a label-only pin must not resurrect.
    const blocked = config.routing.pinBlocklist.includes(pinnedId);
    const honored = Boolean(pinned && !blocked && !overUtilCap && (!(capacityEnabled && config.capacityRouting.mode === "enforce") || usable(pinned)));
    const reason = descriptor.pinReason ?? "configured pin";
    base.pin = { modelId: pinnedId, reason, honored };
    if (honored) return { ...base, outcome: "selected", modelId: pinnedId, capacity: capacityFor(pinned!) };
    trace.push(blocked ? `pin refused: ${pinnedId} is on the pin blocklist` : overUtilCap ? `pin refused: ${pinnedId} over weekly utilization cap ${PIN_MAX_WEEKLY_UTILIZATION} (utilization ${pinnedUtil})` : `pin refused: ${pinnedId}`);
  }
  if (budgetGate === "halt" && !base.pin?.honored) { trace.push("budget gate halt: refusing non-pinned model work"); return base; }
  // TOG-7160 (port of TOG-930): a degraded sticky incumbent is released so
  // real traffic can test recovery elsewhere; the last-resort case (every
  // candidate degraded) still retains the incumbent via routingPool below.
  if (config.routing.stickyModelWithinIssue && runtime.stickyModelId) { const stickyBase = budgetGate === "downshift" ? routingPool : withCapacity.filter((entry) => !degraded.has(entry.model.id)); const stickyPool = stickyBase.filter((entry) => !(capacityEnabled && config.capacityRouting.mode === "enforce") || usable(entry)); const incumbent = stickyPool.find((entry) => entry.model.id === runtime.stickyModelId); if (incumbent) return { ...base, outcome: "selected", modelId: incumbent.model.id, capacity: capacityFor(incumbent) }; if (degraded.has(runtime.stickyModelId)) trace.push(`sticky: released degraded incumbent ${runtime.stickyModelId}`); if (routingPool.length) trace.push(`sticky: ${runtime.stickyModelId} no longer survives the gates, switching despite the cache cost`); }
  if (!routingPool.length) {
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
  const winner = routingPool[0]!;
  if (paceActive) trace.push(`pace ordering: ${winner.model.id} lane ${winner.pace ? `${winner.pace.state}${winner.pace.score ? ` (deviation ${winner.pace.score.deviation.toFixed(3)})` : ""}` : "unknown"}`);
  trace.push(capacityEnabled && config.capacityRouting.mode === "enforce" ? `selected ${winner.model.id} using capacity evidence ${winner.evidence?.source}/${winner.evidence?.laneLabel}` : `selected ${winner.model.id} at an expected $${winner.cost.toFixed(5)}`);
  if (capacityEnabled && config.capacityRouting.mode === "shadow" && shadow && shadow.model.id !== winner.model.id) trace.push(`capacity shadow would choose ${shadow.model.id}; serving remains ${winner.model.id}`);
  return { ...base, outcome: "selected", modelId: winner.model.id, capacity: capacityFor(winner) };
}
