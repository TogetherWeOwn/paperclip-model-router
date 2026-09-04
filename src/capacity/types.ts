export type CapacityHealth = "healthy" | "degraded" | "exhausted" | "unavailable" | "unknown";

export interface CapacityWindow {
  name: string;
  utilization: number | null;
  resetsAt: string | null;
  remainingFraction: number | null;
  sourcePath: string;
}

export interface CapacityLane {
  provider: string;
  account: string;
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
  lanes: CapacityLane[];
  error: string | null;
}

export interface CapacitySourceConfig {
  id: string;
  statusUrl: string;
  apiKeySecretRef: import("../config/types.js").SecretRef | null;
  providers: string[];
  accountIdFields: string[];
  healthFields: string[];
  windows: Array<{
    name: string;
    utilizationFields: string[];
    resetFields: string[];
  }>;
}
