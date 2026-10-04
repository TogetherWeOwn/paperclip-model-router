import type { RouterConfig } from "./config/types.js";
import type { RoutingDecision } from "./engine/types.js";
import type { InferenceResult, NormalizedStopReason } from "./inference/types.js";
import { monthWindowUtc } from "./spend-ledger.js";

export interface DecisionRecord {
  id: string;
  companyId: string;
  at: string;
  requestId: string;
  agentId: string | null;
  runId: string | null;
  issueId: string | null;
  taskClass: string | null;
  selectionOutcome: RoutingDecision["outcome"] | null;
  modelId: string | null;
  fallbackUsed: boolean;
  upstreamProtocol: RouterConfig["upstream"]["protocol"] | null;
  outcome: InferenceResult["outcome"];
  errorCode: string | null;
  upstreamStatus: number | null;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  stopReason: NormalizedStopReason | null;
  upstreamRequestId: string | null;
  capacityMode: RoutingDecision["capacity"]["mode"] | null;
  capacityTelemetry: RoutingDecision["capacity"]["telemetry"] | null;
  capacityLane: string | null;
  capacityLaneLabel: string | null;
  capacityPosture: RoutingDecision["capacity"]["usagePosture"] | null;
  capacityReason: string | null;
  /** Served without capacity awareness because telemetry was absent (TOG-1040). */
  capacityDegraded: boolean;
  /**
   * TOG-7885 (G8): age of the capacity snapshot this decision served from,
   * in wall-clock ms. Null when capacity routing is disabled or no snapshot
   * was ever stored. Integer-valued (worker rounds) so the column stays
   * `bigint`; the alertable rollup is `capacitySnapshotStale`.
   */
  capacitySnapshotAgeMs: number | null;
  /**
   * TOG-7885 (G8): true when `capacitySnapshotAgeMs` exceeded
   * `capacityRouting.maxSnapshotAgeMs` at decision time (or no snapshot
   * existed while capacity routing was enabled). This is the
   * company-scoped rollup behind the degraded-age alert query.
   */
  capacitySnapshotStale: boolean;
  shadowModelId: string | null;
}

function decisionTable(namespace: string): string {
  return `${namespace}.decision_records`;
}

export function decisionInsertSql(namespace: string): string {
  return `INSERT INTO ${decisionTable(namespace)} (
     id, company_id, recorded_at, request_id, agent_id, run_id, issue_id, task_class,
     selection_outcome, model_id, fallback_used, upstream_protocol, outcome, error_code,
     upstream_status, latency_ms, input_tokens, output_tokens, stop_reason,
     upstream_request_id, capacity_mode, capacity_telemetry, capacity_lane,
     capacity_lane_label, capacity_posture, capacity_reason, capacity_degraded,
     capacity_snapshot_age_ms, capacity_snapshot_stale,
     shadow_model_id
   ) VALUES (
     $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
     $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28,
     $29, $30
   )
   ON CONFLICT (company_id, request_id) DO NOTHING`;
}

export function decisionRecordParams(record: DecisionRecord): unknown[] {
  return [
    record.id,
    record.companyId,
    record.at,
    record.requestId,
    record.agentId,
    record.runId,
    record.issueId,
    record.taskClass,
    record.selectionOutcome,
    record.modelId,
    record.fallbackUsed,
    record.upstreamProtocol,
    record.outcome,
    record.errorCode,
    record.upstreamStatus,
    record.latencyMs,
    record.inputTokens,
    record.outputTokens,
    record.stopReason,
    record.upstreamRequestId,
    record.capacityMode,
    record.capacityTelemetry,
    record.capacityLane,
    record.capacityLaneLabel,
    record.capacityPosture,
    record.capacityReason,
    record.capacityDegraded,
    record.capacitySnapshotAgeMs,
    record.capacitySnapshotStale,
    record.shadowModelId,
  ];
}

/** Startup discovers durable writers from the table, not a lossy state index. */
export function decisionCompaniesSql(namespace: string): string {
  return `SELECT DISTINCT company_id FROM ${decisionTable(namespace)}`;
}

/**
 * History visibility follows retentionDays; physical retention also preserves
 * the whole current UTC accounting month, even when monthly caps are disabled.
 * Legacy import uses the same floor so a short history window cannot erase
 * evidence consumed by the monthly spend ledger.
 */
export function decisionRetentionCutoff(retentionDays: number, now: Date): string {
  const historyCutoff = now.getTime() - retentionDays * 86_400_000;
  const monthStart = Date.parse(monthWindowUtc(now).startIso);
  return new Date(Math.min(historyCutoff, monthStart)).toISOString();
}

/** Per-company prune; $2 is the physical cutoff, not the history window. */
export function decisionPruneCompanySql(namespace: string): string {
  return `DELETE FROM ${decisionTable(namespace)}
   WHERE company_id = $1 AND recorded_at < $2::timestamptz`;
}

/** Columns the read path returns, in SELECT order. */
export const DECISION_RECORD_COLUMNS = [
  "id",
  "company_id",
  "recorded_at",
  "request_id",
  "agent_id",
  "run_id",
  "issue_id",
  "task_class",
  "selection_outcome",
  "model_id",
  "fallback_used",
  "upstream_protocol",
  "outcome",
  "error_code",
  "upstream_status",
  "latency_ms",
  "input_tokens",
  "output_tokens",
  "stop_reason",
  "upstream_request_id",
  "capacity_mode",
  "capacity_telemetry",
  "capacity_lane",
  "capacity_lane_label",
  "capacity_posture",
  "capacity_reason",
  "capacity_degraded",
  // TOG-7885 columns ride along: the read path returns the full record, and
  // a row that predates migration 002 reads NULL/false here (never-stored,
  // never "fresh") — the mapper below makes that explicit.
  "capacity_snapshot_age_ms",
  "capacity_snapshot_stale",
  "shadow_model_id",
] as const;

/** TOG-7897: hard bound on one read so the action cannot page the table. */
export const DECISION_QUERY_MAX_LIMIT = 200;

/**
 * TOG-7897: the operator read path. The caller's company id is bound as $1
 * by the worker (never taken from params), so a query can only ever return
 * its own company's rows. The window start ($2) is computed from the
 * company's configured retention, and $3 is the clamped row limit.
 */
export function decisionQuerySql(namespace: string): string {
  return `SELECT ${DECISION_RECORD_COLUMNS.join(", ")} FROM ${decisionTable(namespace)}
   WHERE company_id = $1 AND recorded_at >= $2::timestamptz
   ORDER BY recorded_at DESC
   LIMIT $3`;
}

function dbIso(value: unknown): string {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  return typeof value === "string" ? value : String(value ?? "");
}

/**
 * The `bigint` token columns (and, on some drivers, the integer columns) do
 * not always come back as JS numbers, so the read path normalizes instead of
 * assuming the driver's type mapping.
 */
function dbNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isFinite(asNumber) ? asNumber : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const asNumber = Number(value);
    return Number.isFinite(asNumber) ? asNumber : null;
  }
  return null;
}

function dbString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * TOG-7897: map one raw `decision_records` row to the `DecisionRecord`
 * shape. `companyId` is the host-authorized scope, not a row field.
 * Isolation is enforced by decisionQuerySql's company predicate, not by
 * stamping the result envelope.
 */
export function decisionRowToRecord(
  row: Record<string, unknown>,
  companyId: string,
): DecisionRecord {
  return {
    id: dbString(row.id) ?? "",
    companyId,
    at: dbIso(row.recorded_at),
    requestId: dbString(row.request_id) ?? "",
    agentId: dbString(row.agent_id),
    runId: dbString(row.run_id),
    issueId: dbString(row.issue_id),
    taskClass: dbString(row.task_class),
    selectionOutcome: dbString(row.selection_outcome) as DecisionRecord["selectionOutcome"],
    modelId: dbString(row.model_id),
    fallbackUsed: row.fallback_used === true,
    upstreamProtocol: dbString(row.upstream_protocol) as DecisionRecord["upstreamProtocol"],
    outcome: (dbString(row.outcome) ?? "error") as DecisionRecord["outcome"],
    errorCode: dbString(row.error_code),
    upstreamStatus: dbNumber(row.upstream_status),
    latencyMs: dbNumber(row.latency_ms) ?? 0,
    inputTokens: dbNumber(row.input_tokens),
    outputTokens: dbNumber(row.output_tokens),
    stopReason: dbString(row.stop_reason) as DecisionRecord["stopReason"],
    upstreamRequestId: dbString(row.upstream_request_id),
    capacityMode: dbString(row.capacity_mode) as DecisionRecord["capacityMode"],
    capacityTelemetry: dbString(row.capacity_telemetry) as DecisionRecord["capacityTelemetry"],
    capacityLane: dbString(row.capacity_lane),
    capacityLaneLabel: dbString(row.capacity_lane_label),
    capacityPosture: dbString(row.capacity_posture) as DecisionRecord["capacityPosture"],
    capacityReason: dbString(row.capacity_reason),
    capacityDegraded: row.capacity_degraded === true,
    // TOG-7885: rows written before migration 002 carry no age. They read
    // as never-stored (null/false) — the honest pre-migration value, not
    // "fresh" — matching the legacyDecisionRecord backfill on main.
    capacitySnapshotAgeMs: dbNumber(row.capacity_snapshot_age_ms),
    capacitySnapshotStale: row.capacity_snapshot_stale === true,
    shadowModelId: dbString(row.shadow_model_id),
  };
}
