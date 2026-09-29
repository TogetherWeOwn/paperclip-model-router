import type {
  CapacityEvidence,
  CapacityHealth,
  CapacitySnapshot,
  CapacitySourceDefinition,
  CapacityWindow,
} from "./types.js";
import { firstValue, fraction, normalizeHealth, recordOf, timestamp } from "./value-normalization.js";

function collectEvidenceRecords(payload: unknown, source: CapacitySourceDefinition): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    const record = recordOf(node);
    if (!record) return;
    // TOG-7163 (TOG-1921 audit of PR #41): collect only the OUTERMOST record
    // carrying utilization — do not descend into a matched record's subtree.
    // The old code collected the nested quota windows as independent records
    // too, and every nested fragment then fanned out onto EVERY model id, so
    // per-model groups inside one record flipped the whole pool's verdict when
    // input order changed (exhausted-to-healthy on reversal). Per-model groups
    // still reach their model below: the projection reads them from the
    // outermost record's subtree via `modelIdentityFields` instead of as
    // standalone records.
    const utilization = source.windows.some((entry) => firstValue(record, entry.utilizationFields));
    if (utilization) {
      found.push(record);
      return;
    }
    for (const value of Object.values(record)) {
      if (value && typeof value === "object") visit(value);
    }
  };
  visit(payload);
  return found;
}

// Ordered so headroom-shaped keys win over utilization-shaped ones: a nested
// window carrying BOTH `remainingFraction` and `utilization` reports headroom,
// and `utilization` must only be read when no headroom key is present.
const NESTED_REMAINING_KEYS = ["remainingFraction", "remaining_fraction", "remaining", "utilization"];

function normalizeWindow(
  record: Record<string, unknown>,
  definition: CapacitySourceDefinition["windows"][number],
): CapacityWindow | null {
  const direct = firstValue(record, definition.utilizationFields);
  // TOG-7163: nested quota windows. A sanitized auth-file record may carry a
  // window's value inside a sub-object keyed by the window's configured field
  // name (e.g. `quota_windows: {"five-hour": {remainingFraction, resetAt}}`).
  // The direct hit keeps precedence; the nested lookup matches a child key
  // against the definition's `utilizationFields` case-insensitively, then reads
  // the fraction from inside. The nested match is accepted ONLY when the
  // child's own key names this window — never by scanning every sub-object for
  // any fraction, which is the first-match projection defect (TOG-1921 #1) in
  // another shape: the first nested window found would otherwise serve every
  // window definition.
  let raw = direct?.value;
  let rawField = direct?.field;
  let scope: Record<string, unknown> = record;
  if (fraction(raw) === null) {
    for (const [key, value] of Object.entries(record)) {
      const nested = recordOf(value);
      if (!nested) continue;
      const namesWindow = definition.utilizationFields.some(
        (field) => field.trim().toLowerCase() === key.trim().toLowerCase());
      if (!namesWindow) continue;
      const inner = firstValue(nested, [...definition.utilizationFields, ...NESTED_REMAINING_KEYS]);
      if (inner !== null && fraction(inner.value) !== null) {
        raw = inner.value;
        rawField = inner.field;
        scope = nested;
        break;
      }
    }
  }
  // TOG-7163: nested windows report HEADROOM (`remainingFraction`), while the
  // flat lane documents report UTILIZATION. The configured `utilizationFields`
  // name the key, not the polarity — so polarity follows the key that matched:
  // a `remain*` key means utilization = 1 - value, anything else is already a
  // utilization fraction. Reading headroom as utilization (or vice versa) is
  // exactly the exhausted/healthy inversion the audit reproduced.
  const matchedHeadroom = rawField !== undefined &&
    ["remainingfraction", "remaining_fraction", "remaining", "remain", "headroom", "left"].some(
      (stem) => rawField.trim().toLowerCase() === stem || rawField.trim().toLowerCase().startsWith("remaining"));
  const normalizedUtilization = fraction(raw) === null
    ? null
    : matchedHeadroom ? 1 - (fraction(raw) as number) : fraction(raw);
  // Reset-only windows are metadata without capacity evidence. Ignoring them
  // prevents a reset timestamp from outranking a real utilization window.
  if (normalizedUtilization === null) return null;
  const reset = firstValue(scope, definition.resetFields) ?? firstValue(record, definition.resetFields);
  const normalizedReset = timestamp(reset?.value);
  return {
    name: definition.name,
    utilization: normalizedUtilization,
    remainingFraction: 1 - normalizedUtilization,
    resetsAt: normalizedReset,
    sourcePath: rawField ?? definition.name,
  };
}

// TOG-7163 (TOG-1921 audit of PR #41): a sanitized auth-file record may carry
// several per-model quota groups inside one record (e.g. `quota_groups: [{model,
// "five-hour": {...}, weekly: {...}}, ...]`). Projecting the FIRST group's
// windows onto EVERY model flips the whole pool's verdict when the input order
// changes — both outputs went exhausted-to-healthy on reversal. The projection
// must be exact: a window match counts only when the record that carries the
// utilization also carries an identity naming the model the evidence row is
// being built for. Identity matching is case-insensitive on the configured
// model id, plus the substring after the last `/` (so `cliproxy/x` matches a
// `model: "x"` label), with exact-equality only — no prefix/substring matching,
// so `model-b` never claims `model-b-low`'s windows.
function recordIdentityMatchesModel(record: Record<string, unknown>, modelId: string, fields: string[]): boolean {
  const normalized = modelId.trim().toLowerCase();
  const short = normalized.split("/").pop() ?? normalized;
  for (const field of fields) {
    const value = record[field];
    if (typeof value !== "string") continue;
    const candidate = value.trim().toLowerCase();
    if (candidate === normalized || candidate === short) return true;
  }
  return false;
}

function collectGroupCandidates(record: Record<string, unknown>, identityFields: string[]): Record<string, unknown>[] {
  const groups: Record<string, unknown>[] = [];
  const visit = (node: unknown, isRoot: boolean): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, false);
      return;
    }
    const candidate = recordOf(node);
    if (!candidate) return;
    if (!isRoot) {
      // Every descendant record is a projection candidate: identity-bearing
      // ones are per-model groups, and the descent continues so groups nested
      // deeper (e.g. inside a `quota_windows` wrapper) are found too.
      groups.push(candidate);
    }
    for (const value of Object.values(candidate)) {
      if (value && typeof value === "object") visit(value, false);
    }
  };
  // The record itself is candidate zero: when collection yields a per-model
  // group as its own record (bare `{model, remainingFraction}` groups), the
  // projection must still match it by identity instead of falling back to a
  // bare-nested-fragment scan that finds nothing.
  groups.push(record);
  visit(record, true);
  // Identity-bearing candidates are per-model groups and sort first, so the
  // projection prefers an exact identity match over a bare nested window
  // fragment that merely carries utilization.
  const ranked = (candidate: Record<string, unknown>): number =>
    identityFields.some((field) => typeof candidate[field] === "string") ? 0 : 1;
  return groups.sort((left, right) => ranked(left) - ranked(right));
}

// The per-model group naming this modelId inside the record's subtree, or null
// when no group does. The caller falls back to the record's own windows
// (legacy fan-out) only when the subtree carries no usable identity at all; a
// subtree naming OTHER models is those models' evidence, not absent telemetry
// for this one.
function findModelGroup(
  record: Record<string, unknown>,
  modelId: string,
  identityFields: string[],
): Record<string, unknown> | null {
  if (identityFields.length === 0) return null;
  for (const candidate of collectGroupCandidates(record, identityFields)) {
    if (recordIdentityMatchesModel(candidate, modelId, identityFields)) return candidate;
  }
  return null;
}

function subtreeCarriesIdentity(record: Record<string, unknown>, identityFields: string[]): boolean {
  if (identityFields.length === 0) return false;
  return collectGroupCandidates(record, identityFields).some((candidate) =>
    identityFields.some((field) => typeof candidate[field] === "string"));
}

function resetInSeconds(resetsAt: string | null, fetchedAtMs: number): number | null {
  return resetsAt === null || !Number.isFinite(fetchedAtMs)
    ? null
    : Math.round((Date.parse(resetsAt) - fetchedAtMs) / 1000);
}

function windowHealth(utilization: number, secondsUntilReset: number | null): CapacityHealth {
  if (utilization >= 0.995) return secondsUntilReset !== null && secondsUntilReset > 0 && secondsUntilReset <= 300 ? "degraded" : "exhausted";
  if (utilization >= 0.9) return "degraded";
  return "healthy";
}

const HEALTH_RANK: Record<CapacityHealth, number> = {
  healthy: 0,
  degraded: 1,
  unknown: 2,
  exhausted: 3,
  unavailable: 4,
};

function restrictiveWindow(
  windows: CapacityWindow[],
  fetchedAtMs: number,
): { window: CapacityWindow | null; health: CapacityHealth } {
  const evaluated = windows.map((window) => {
    const secondsUntilReset = resetInSeconds(window.resetsAt, fetchedAtMs);
    return {
      window,
      secondsUntilReset,
      health: windowHealth(window.utilization!, secondsUntilReset),
    };
  });
  evaluated.sort((left, right) =>
    HEALTH_RANK[right.health] - HEALTH_RANK[left.health] ||
    right.window.utilization! - left.window.utilization! ||
    (right.secondsUntilReset ?? Number.POSITIVE_INFINITY) -
      (left.secondsUntilReset ?? Number.POSITIVE_INFINITY) ||
    left.window.name.localeCompare(right.window.name)
  );
  return evaluated[0] ?? { window: null, health: "unknown" };
}

function conservativeHealth(explicit: CapacityHealth | null, window: CapacityHealth): CapacityHealth {
  if (explicit === null) return window;
  return HEALTH_RANK[explicit] >= HEALTH_RANK[window] ? explicit : window;
}

function postureFor(health: CapacityHealth, utilization: number | null): CapacityEvidence["posture"] {
  if (health === "unavailable" || health === "exhausted") return "unavailable";
  if (health === "unknown") return "unknown";
  if (health === "degraded" || (utilization !== null && utilization >= 0.8)) return "avoid";
  if (utilization !== null && utilization >= 0.6) return "conserve";
  return "available";
}

export function normalizeCapacityPayload(input: {
  payload: unknown;
  source: CapacitySourceDefinition;
  fetchedAt: string;
}): CapacitySnapshot {
  const fetchedAtMs = new Date(input.fetchedAt).getTime();
  const records = collectEvidenceRecords(input.payload, input.source);
  const evidence: CapacityEvidence[] = [];

  records.forEach((record, index) => {
    const explicit = normalizeHealth(firstValue(record, input.source.healthFields)?.value);
    // TOG-7163 (TOG-1921 defect 2): a per-record explicit status
    // (`status: "error"` on ONE credential) must not globally suppress the
    // healthy windows of sibling records. The conservative health fold stays
    // scoped to this record's row; the snapshot-level `error` below fires only
    // when NO record yielded usable telemetry, never as a blanket over a mixed
    // pool.
    const identityFields = input.source.modelIdentityFields ?? [];
    // TOG-7163 (TOG-1921 defect 1): exact model/group projection. The
    // collection above yields at most one record per credential/account — but
    // that record may still carry per-model quota groups in its subtree, and
    // projecting the FIRST group's windows onto EVERY model flips the whole
    // pool's verdict when input order changes (exhausted-to-healthy on
    // reversal). So each modelId's row MUST be built from the group naming
    // that model (`findModelGroup`); a record whose groups name only OTHER
    // models contributes no row for this model (that is those models'
    // evidence, not absent telemetry here). Records with no usable group
    // identity keep the legacy fan-out: the record's own windows inform every
    // model id, exactly as before.
    const groupedSubtree = subtreeCarriesIdentity(record, identityFields);

    for (const modelId of input.source.modelIds) {
      const group = findModelGroup(record, modelId, identityFields);
      if (group === null && groupedSubtree) continue;
      const windowScope = group ?? record;
      const windows = input.source.windows
        .map((definition) => normalizeWindow(windowScope, definition))
        .filter((entry): entry is CapacityWindow => entry !== null);
      const restrictive = restrictiveWindow(windows, fetchedAtMs);
      const utilization = restrictive.window?.utilization ?? null;
      const resetsAt = restrictive.window?.resetsAt ?? null;
      const health = conservativeHealth(explicit, restrictive.health);
      const telemetryAvailable = utilization !== null && health !== "unknown";
      evidence.push({
        modelId,
        source: input.source.id,
        laneLabel: `record-${index + 1}`,
        health,
        posture: postureFor(health, utilization),
        utilization,
        remainingFraction: utilization === null ? null : 1 - utilization,
        resetsAt,
        resetInSeconds: resetInSeconds(resetsAt, fetchedAtMs),
        windows,
        telemetryAvailable,
        reason: utilization === null
          ? `no valid utilization was present; explicit health ${explicit ?? "absent"}`
          : `${health}; ${Math.round(utilization * 100)}% utilized${resetsAt ? `; resets ${resetsAt}` : ""}`,
      });
    }
  });

  return {
    fetchedAt: input.fetchedAt,
    source: input.source.id,
    evidence,
    error: evidence.length === 0 ? "capacity payload carried no recognizable telemetry records" : null,
  };
}
