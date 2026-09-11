export type {
  CapacityEvidence,
  CapacityHealth,
  CapacitySnapshot,
  CapacityWindow,
} from "../../packages/lane-capacity/src/types.js";

import type { CapacitySourceDefinition } from "../../packages/lane-capacity/src/types.js";

export type { CapacitySourceDefinition } from "../../packages/lane-capacity/src/types.js";

export interface CapacitySourceConfig extends CapacitySourceDefinition {
  apiKeySecretRef: import("../config/types.js").SecretRef | null;
}
