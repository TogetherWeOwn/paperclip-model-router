import type { RouterConfig } from "./config/types.js";
import type { RoutingDecision } from "./engine/types.js";
import type { InferenceResult, NormalizedStopReason } from "./inference/types.js";

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

export function decisionPruneSql(namespace: string): string {
  return `DELETE FROM ${decisionTable(namespace)}
   WHERE recorded_at < $1::timestamptz - ($2 * interval '1 day')`;
}
