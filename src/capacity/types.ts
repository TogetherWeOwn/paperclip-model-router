export type {
  CapacityEvidence,
  CapacityHealth,
  CapacityReasonCode,
  CapacitySnapshot,
  CapacityWindow,
} from "../../packages/lane-capacity/src/types.js";

export type { LanePaceDefinition, LanePaceVerdict, PacePolicy, PaceState } from "../../packages/lane-capacity/src/pace.js";

import type { CapacitySourceDefinition } from "../../packages/lane-capacity/src/types.js";

export type { CapacitySourceDefinition } from "../../packages/lane-capacity/src/types.js";

export interface CapacitySourceConfig extends CapacitySourceDefinition {
  apiKeySecretRef: import("../config/types.js").SecretRef | null;
  /**
   * Lane-document shape for pace evaluation (TOG-2139 slice 6). Absent =
   * pace-neutral source: its models carry no pace verdict and never gain or
   * lose eligibility from pace ordering.
   */
  pace?: import("../config/types.js").SourcePaceDefinition;
}
