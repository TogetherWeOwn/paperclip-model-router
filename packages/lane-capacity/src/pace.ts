import type { CapacityHealth } from "./types.js";
import { firstValue, fraction, normalizeHealth, recordOf, timestamp } from "./value-normalization.js";

export type PaceState = "behind-urgent" | "behind" | "on" | "ahead" | "unknown" | "exhausted" | "free";
export type PaceWindowRole = "serviceability" | "allowance";

export interface PaceWindowDefinition {
  name: string;
  role: PaceWindowRole;
  utilizationFields: string[];
  resetFields: string[];
  defaultWindowSeconds?: number | null;
}

export interface LanePaceDefinition {
  laneId: string;
  free?: boolean;
  healthFields: string[];
  weightFields?: string[];
  accountKeyFields?: string[];
  governingWindowField?: string;
  windowSecondsField?: string;
  staleAfterSecondsField?: string;
  windows: PaceWindowDefinition[];
}

export interface PaceWindowObservation {
  name: string;
  role: PaceWindowRole;
  utilization: number | null;
  resetsAt: string | null;
  windowSeconds: number | null;
  sourcePath: string | null;
}

export interface PaceAccountObservation {
  accountKey: string;
  health: CapacityHealth;
  weight: number;
  weightSource: "reported" | "default";
  governingWindow: string | null;
  windows: PaceWindowObservation[];
}

export interface LanePaceObservation {
  laneId: string;
  free: boolean;
  observedAt: string | null;
  staleAfterSeconds: number | null;
  accounts: PaceAccountObservation[];
  error: "invalid-document" | "no-records" | null;
}

export interface PaceScore {
  utilization: number;
  elapsed: number;
  deviation: number;
  paceDebt: number;
  clearRate: number | null;
}

export interface PaceAccountVerdict {
  accountKey: string;
  health: CapacityHealth;
  weight: number;
  weightSource: "reported" | "default";
  governingWindow: string | null;
  governingResetAt: string | null;
  serviceable: boolean;
  state: Exclude<PaceState, "free">;
  score: PaceScore | null;
}

export interface LanePaceVerdict {
  laneId: string;
  observedAt: string | null;
  state: PaceState;
  serviceable: boolean | null;
  score: PaceScore | null;
  accounts: PaceAccountVerdict[];
  knownAccountCount: number;
  knownWeight: number;
  serviceableAccountCount: number;
  urgentResetAt: string | null;
  reason: "ok" | "free-lane" | "document-unavailable" | "snapshot-stale" | "no-records" | "no-computable-governing-window" | "all-accounts-unserviceable";
}

export interface PacePolicy {
  margin?: number;
  urgentResetSeconds?: number;
  maxSnapshotAgeSeconds?: number;
}

const SCALE = 1_000;
const DEFAULT_MARGIN = 0.1;
const DEFAULT_URGENT_RESET_SECONDS = 24 * 60 * 60;
const DEFAULT_MAX_SNAPSHOT_AGE_SECONDS = 15 * 60;

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function windowSeconds(record: Record<string, unknown>, field: string, window: PaceWindowDefinition): number | null {
  const raw = record[field];
  if (typeof raw === "number") return positiveNumber(raw);
  const mapped = recordOf(raw);
  if (mapped) {
    return positiveNumber(mapped[window.name]) ??
      positiveNumber(mapped[window.name.replace(/-/g, "_")]);
  }
  return positiveNumber(window.defaultWindowSeconds);
}

function normalizedWeight(record: Record<string, unknown>, fields: string[]): { weight: number; source: "reported" | "default" } {
  const reported = positiveNumber(firstValue(record, fields)?.value);
  return reported === null
    ? { weight: 1, source: "default" }
    : { weight: reported, source: "reported" };
}

export function normalizeLaneDocument(input: {
  document: unknown;
  definition: LanePaceDefinition;
}): LanePaceObservation {
  const document = recordOf(input.document);
  if (!document) {
    return { laneId: input.definition.laneId, free: Boolean(input.definition.free), observedAt: null, staleAfterSeconds: null, accounts: [], error: "invalid-document" };
  }
  const records = Array.isArray(document.records) ? document.records : [];
  const observedAt = timestamp(document.observedAt);
  const staleAfterSeconds = positiveNumber(document[input.definition.staleAfterSecondsField ?? "staleAfterSeconds"]);
  const governingWindowField = input.definition.governingWindowField ?? "governing_window";
  const windowSecondsField = input.definition.windowSecondsField ?? "window_seconds";
  const accounts = records.flatMap((value, index): PaceAccountObservation[] => {
    const record = recordOf(value);
    if (!record) return [];
    const weight = normalizedWeight(record, input.definition.weightFields ?? ["weight"]);
    const reportedGoverningWindow = typeof record[governingWindowField] === "string" ? record[governingWindowField] as string : null;
    const reportedAccountKey = firstValue(record, input.definition.accountKeyFields ?? ["account_key"])?.value;
    const accountKey = typeof reportedAccountKey === "string" && reportedAccountKey.trim().length > 0
      ? reportedAccountKey
      : `record-${index + 1}`;
    return [{
      accountKey,
      health: normalizeHealth(firstValue(record, input.definition.healthFields)?.value) ?? "unknown",
      weight: weight.weight,
      weightSource: weight.source,
      governingWindow: reportedGoverningWindow,
      windows: input.definition.windows.map((window) => {
        const utilization = firstValue(record, window.utilizationFields);
        const reset = firstValue(record, window.resetFields);
        return {
          name: window.name,
          role: window.role,
          utilization: fraction(utilization?.value),
          resetsAt: timestamp(reset?.value),
          windowSeconds: windowSeconds(record, windowSecondsField, window),
          sourcePath: utilization?.field ?? null,
        };
      }),
    }];
  });
  return {
    laneId: input.definition.laneId,
    free: Boolean(input.definition.free),
    observedAt,
    staleAfterSeconds,
    accounts,
    error: records.length === 0 ? "no-records" : null,
  };
}

function roundHalfEven(value: number): number {
  const lower = Math.floor(value);
  const fraction = value - lower;
  if (Math.abs(fraction - 0.5) <= 1e-12) return lower % 2 === 0 ? lower : lower + 1;
  return Math.round(value);
}

function toMilli(value: number): number {
  return roundHalfEven(Math.min(1, Math.max(0, value)) * SCALE);
}

function score(utilizationMilli: number, elapsedMilli: number, clearRateValue: number | null): PaceScore {
  return {
    utilization: utilizationMilli / SCALE,
    elapsed: elapsedMilli / SCALE,
    deviation: (utilizationMilli - elapsedMilli) / SCALE,
    paceDebt: (elapsedMilli - utilizationMilli) / SCALE,
    clearRate: clearRateValue,
  };
}

function weightedMilli(values: Array<{ value: number; weight: number }>): number {
  const weight = values.reduce((sum, entry) => sum + entry.weight, 0);
  return roundHalfEven(values.reduce((sum, entry) => sum + entry.value * entry.weight, 0) / weight);
}

function weightedRate(values: Array<{ value: number | null; weight: number }>): number | null {
  const usable = values.filter((entry): entry is { value: number; weight: number } => entry.value !== null);
  if (usable.length === 0) return null;
  const weight = usable.reduce((sum, entry) => sum + entry.weight, 0);
  return usable.reduce((sum, entry) => sum + entry.value * entry.weight, 0) / weight;
}

function clearRate(window: PaceWindowObservation, observedAtMs: number): number | null {
  if (
    window.role !== "allowance" ||
    window.utilization === null ||
    window.resetsAt === null ||
    window.windowSeconds === null
  ) return null;
  const resetMs = Date.parse(window.resetsAt);
  if (!Number.isFinite(resetMs)) return null;
  const hoursToReset = Math.max(1, (resetMs - observedAtMs) / 3_600_000);
  return Math.max(0, 1 - window.utilization) / hoursToReset;
}

function governingWindow(account: PaceAccountObservation, observedAtMs: number): PaceWindowObservation | null {
  let binding: PaceWindowObservation | null = null;
  let bindingRate = Infinity;
  for (const window of account.windows) {
    const rate = clearRate(window, observedAtMs);
    if (rate === null) continue;
    if (rate < bindingRate || (rate === bindingRate && (binding === null || window.name < binding.name))) {
      binding = window;
      bindingRate = rate;
    }
  }
  return binding;
}

function serviceable(account: PaceAccountObservation, governing: PaceWindowObservation | null): boolean {
  if (account.health === "exhausted" || account.health === "unavailable") return false;
  if (governing?.utilization !== null && governing && governing.utilization >= 1) return false;
  return account.windows.every((window) =>
    window.role !== "serviceability" || window.utilization === null || window.utilization < 1
  );
}

function stateFor(deviationMilli: number, marginMilli: number): "ahead" | "behind" | "on" {
  if (deviationMilli > marginMilli) return "ahead";
  if (deviationMilli < -marginMilli) return "behind";
  return "on";
}

export function evaluateLanePace(input: {
  observation: LanePaceObservation;
  asOf?: string;
  policy?: PacePolicy;
}): LanePaceVerdict {
  const marginMilli = toMilli(input.policy?.margin ?? DEFAULT_MARGIN);
  const urgentResetSeconds = input.policy?.urgentResetSeconds ?? DEFAULT_URGENT_RESET_SECONDS;
  const maxSnapshotAgeSeconds = input.policy?.maxSnapshotAgeSeconds ?? DEFAULT_MAX_SNAPSHOT_AGE_SECONDS;
  const asOf = timestamp(input.asOf ?? input.observation.observedAt);

  if (input.observation.free) {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "free", serviceable: true, score: null, accounts: [], knownAccountCount: 0, knownWeight: 0, serviceableAccountCount: 0, urgentResetAt: null, reason: "free-lane" };
  }
  if (input.observation.error === "invalid-document" || input.observation.observedAt === null || asOf === null) {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: null, score: null, accounts: [], knownAccountCount: 0, knownWeight: 0, serviceableAccountCount: 0, urgentResetAt: null, reason: "document-unavailable" };
  }
  if (input.observation.error === "no-records") {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: null, score: null, accounts: [], knownAccountCount: 0, knownWeight: 0, serviceableAccountCount: 0, urgentResetAt: null, reason: "no-records" };
  }
  const observedAtMs = Date.parse(input.observation.observedAt);
  const asOfMs = Date.parse(asOf);
  const freshnessBudget = Math.min(input.observation.staleAfterSeconds ?? maxSnapshotAgeSeconds, maxSnapshotAgeSeconds);
  if ((asOfMs - observedAtMs) / 1_000 > freshnessBudget) {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: null, score: null, accounts: [], knownAccountCount: 0, knownWeight: 0, serviceableAccountCount: 0, urgentResetAt: null, reason: "snapshot-stale" };
  }

  const internal = input.observation.accounts.map((account) => {
    const governing = governingWindow(account, observedAtMs);
    const accountServiceable = serviceable(account, governing);
    if (!governing) {
      const exhausted = account.health === "exhausted" || account.health === "unavailable";
      return {
        verdict: { accountKey: account.accountKey, health: account.health, weight: account.weight, weightSource: account.weightSource, governingWindow: null, governingResetAt: null, serviceable: accountServiceable, state: exhausted ? "exhausted" as const : "unknown" as const, score: null },
        utilizationMilli: null,
        elapsedMilli: null,
        resetAtMs: null,
      };
    }
    const utilizationMilli = toMilli(governing.utilization!);
    const remainingSeconds = (Date.parse(governing.resetsAt!) - observedAtMs) / 1_000;
    const elapsedMilli = toMilli(1 - Math.min(1, Math.max(0, remainingSeconds / governing.windowSeconds!)));
    const accountScore = score(utilizationMilli, elapsedMilli, clearRate(governing, observedAtMs));
    const exhausted = account.health === "exhausted" || account.health === "unavailable" || governing.utilization! >= 1;
    let state: PaceAccountVerdict["state"] = exhausted ? "exhausted" : stateFor(utilizationMilli - elapsedMilli, marginMilli);
    const resetSeconds = (Date.parse(governing.resetsAt!) - asOfMs) / 1_000;
    if (state === "behind" && resetSeconds >= 0 && resetSeconds < urgentResetSeconds) state = "behind-urgent";
    return {
      verdict: { accountKey: account.accountKey, health: account.health, weight: account.weight, weightSource: account.weightSource, governingWindow: governing.name, governingResetAt: governing.resetsAt, serviceable: accountServiceable, state, score: accountScore },
      utilizationMilli,
      elapsedMilli,
      resetAtMs: Date.parse(governing.resetsAt!),
    };
  });

  const serviceableAccountCount = internal.filter((entry) => entry.verdict.serviceable).length;
  const accounts = internal.map((entry) => entry.verdict);
  if (serviceableAccountCount === 0) {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "exhausted", serviceable: false, score: null, accounts, knownAccountCount: internal.filter((entry) => entry.utilizationMilli !== null).length, knownWeight: internal.filter((entry) => entry.utilizationMilli !== null).reduce((sum, entry) => sum + entry.verdict.weight, 0), serviceableAccountCount, urgentResetAt: null, reason: "all-accounts-unserviceable" };
  }

  const known = internal.filter((entry): entry is typeof entry & { utilizationMilli: number; elapsedMilli: number; resetAtMs: number } =>
    entry.utilizationMilli !== null && entry.elapsedMilli !== null && entry.resetAtMs !== null && entry.verdict.serviceable
  );
  if (known.length === 0) {
    return { laneId: input.observation.laneId, observedAt: input.observation.observedAt, state: "unknown", serviceable: true, score: null, accounts, knownAccountCount: 0, knownWeight: 0, serviceableAccountCount, urgentResetAt: null, reason: "no-computable-governing-window" };
  }

  const utilizationMilli = weightedMilli(known.map((entry) => ({ value: entry.utilizationMilli, weight: entry.verdict.weight })));
  const elapsedMilli = weightedMilli(known.map((entry) => ({ value: entry.elapsedMilli, weight: entry.verdict.weight })));
  const laneClearRate = weightedRate(known.map((entry) => ({ value: entry.verdict.score?.clearRate ?? null, weight: entry.verdict.weight })));
  const laneScore = score(utilizationMilli, elapsedMilli, laneClearRate);
  let state: LanePaceVerdict["state"] = stateFor(utilizationMilli - elapsedMilli, marginMilli);
  const urgent = known
    .filter((entry) => entry.verdict.state === "behind-urgent")
    .sort((left, right) => left.resetAtMs - right.resetAtMs)[0];
  if (urgent) state = "behind-urgent";
  return {
    laneId: input.observation.laneId,
    observedAt: input.observation.observedAt,
    state,
    serviceable: true,
    score: laneScore,
    accounts,
    knownAccountCount: known.length,
    knownWeight: known.reduce((sum, entry) => sum + entry.verdict.weight, 0),
    serviceableAccountCount,
    urgentResetAt: urgent?.verdict.governingResetAt ?? null,
    reason: "ok",
  };
}
