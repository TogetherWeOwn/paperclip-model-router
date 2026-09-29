import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveConfig } from "../src/config/resolve.js";
import type { RouterConfig } from "../src/config/types.js";

const here = dirname(fileURLToPath(import.meta.url));

export function readFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(here, "fixtures", `${name}.json`), "utf8"));
}

export function fixtureConfig(name: string): RouterConfig {
  return resolveConfig(readFixture(name));
}

export function decisionRecords(harness: {
  dbExecutes: Array<{ sql: string; params?: unknown[] }>;
}): Array<Record<string, unknown>> {
  return harness.dbExecutes
    .filter((entry) => entry.sql.includes("INSERT INTO") && entry.sql.includes(".decision_records"))
    .map((entry) => {
      const params = entry.params ?? [];
      return {
        id: params[0],
        companyId: params[1],
        at: params[2],
        requestId: params[3],
        agentId: params[4],
        runId: params[5],
        issueId: params[6],
        taskClass: params[7],
        selectionOutcome: params[8],
        modelId: params[9],
        fallbackUsed: params[10],
        upstreamProtocol: params[11],
        outcome: params[12],
        errorCode: params[13],
        upstreamStatus: params[14],
        latencyMs: params[15],
        inputTokens: params[16],
        outputTokens: params[17],
        stopReason: params[18],
        upstreamRequestId: params[19],
        capacityMode: params[20],
        capacityTelemetry: params[21],
        capacityLane: params[22],
        capacityLaneLabel: params[23],
        capacityPosture: params[24],
        capacityReason: params[25],
        capacityDegraded: params[26],
        capacitySnapshotAgeMs: params[27],
        capacitySnapshotStale: params[28],
        shadowModelId: params[29],
      };
    })
    .reverse();
}

export function companyDecisionRecords(
  harness: { dbExecutes: Array<{ sql: string; params?: unknown[] }> },
  companyId: string,
): Array<Record<string, unknown>> {
  return decisionRecords(harness).filter((record) => record.companyId === companyId);
}
