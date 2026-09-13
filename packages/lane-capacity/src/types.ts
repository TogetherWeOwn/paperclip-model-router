export type CapacityHealth = "healthy" | "degraded" | "exhausted" | "unavailable" | "unknown";

export interface CapacityWindow {
  name: string;
  utilization: number | null;
  resetsAt: string | null;
  remainingFraction: number | null;
  sourcePath: string;
}

/**
 * Capacity evidence associated with an opaque model id before inference.
 * `source` and `laneLabel` are operator-defined telemetry labels. They are not
 * claims about the provider or account that ultimately serves the request.
 */
export interface CapacityEvidence {
  modelId: string;
  source: string;
  laneLabel: string;
  health: CapacityHealth;
  posture: "available" | "conserve" | "avoid" | "unavailable" | "unknown";
  utilization: number | null;
  remainingFraction: number | null;
  resetsAt: string | null;
  resetInSeconds: number | null;
  windows: CapacityWindow[];
  telemetryAvailable: boolean;
  reason: string;
}

export interface CapacitySnapshot {
  fetchedAt: string;
  source: string;
  evidence: CapacityEvidence[];
  error: string | null;
  /**
   * TOG-2139 (slice 6): pace verdict for this source's lane, evaluated from
   * the same fetched document as `evidence` when the caller supplies a lane
   * definition. Null when pace evaluation was not requested or the document
   * could not be parsed — always fail-neutral, never an error of its own.
   */
  pace?: import("./pace.js").LanePaceVerdict | null;
}

export interface CapacitySourceDefinition {
  id: string;
  statusUrl: string;
  /** Opaque model ids whose selection this source may inform. */
  modelIds: string[];
  healthFields: string[];
  requestTimeoutMs: number;
  maxResponseBytes: number;
  windows: Array<{
    name: string;
    utilizationFields: string[];
    resetFields: string[];
  }>;
}
