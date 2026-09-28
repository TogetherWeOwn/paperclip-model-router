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

/**
 * Bounded reason codes. Closed on purpose: an upstream error string routinely
 * embeds a connection ID or a URL, so propagating one would reintroduce exactly
 * the identity leak the contract forbids (§2.2).
 */
export type CapacityReasonCode =
  | "capacity-url-rejected"
  | "capacity-request-failed"
  | "capacity-redirect-refused"
  | "capacity-response-too-large"
  | "capacity-authentication-failed"
  | "capacity-http-failed"
  | "capacity-unexpected-media-type"
  | "capacity-invalid-json"
  | "capacity-schema-version-unsupported"
  | "capacity-contract-malformed"
  | "capacity-producer-unavailable"
  | "capacity-snapshot-stale"
  | "capacity-secret-unavailable"
  | "capacity-no-recognizable-records";

export interface CapacitySnapshot {
  fetchedAt: string;
  source: string;
  evidence: CapacityEvidence[];
  /**
   * Contract §4's required distinction, made structural.
   *
   * `"available"` with an empty `evidence` array is a TRUSTWORTHY answer: the
   * producer is healthy and reports that it governs no model we asked about.
   * `"unavailable"` is a failure. Collapsing the two — the common bug, where an
   * outage returns nothing and reads as "nothing is constrained" — lets a
   * telemetry failure present as unlimited capacity. That is why this is a
   * required field rather than something inferred from `evidence.length`.
   */
  telemetry: "available" | "unavailable";
  reasonCode: CapacityReasonCode | null;
  /** Retained for existing consumers; mirrors `reasonCode`. */
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
  /**
   * TOG-7163 (TOG-1921 audit of PR #41): per-model quota groups inside one
   * payload record must project onto exactly one model. These fields carry the
   * model identity on a grouped record (e.g. `["model"]`); records naming a
   * different model are that model's evidence, not absent telemetry for this
   * one. Absent/empty = legacy fan-out: every record informs every model id.
   */
  modelIdentityFields?: string[];
  windows: Array<{
    name: string;
    utilizationFields: string[];
    resetFields: string[];
  }>;
}
