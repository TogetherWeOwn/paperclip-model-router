export const PLUGIN_ID = "togetherweown.paperclip-model-router";

/** Kept in sync with package.json by `npm run verify`. */
export const PLUGIN_VERSION = "0.5.0";

export const PLUGIN_API_VERSION = 1 as const;

export const ACTION_KEYS = {
  invoke: "invoke",
  invokeAsync: "invoke-async",
  invokeResult: "invoke-result",
  refreshCapacity: "refresh-capacity",
} as const;

export const TOOL_NAMES = {
  invoke: "model_router_invoke",
  invokeAsync: "model_router_invoke_async",
  invokeResult: "model_router_invoke_result",
} as const;

export const ROUTE_KEYS = {
  invoke: "invoke",
  invokeIssue: "invoke-issue",
  invokeAsync: "invoke-async",
  invokeResult: "invoke-result",
} as const;

export const STATE_KEYS = {
  capacitySnapshot: "capacity-snapshot",
  issueStickiness: "issue-stickiness",
  legacyDecisionLog: "decision-log",
  decisionLogMigration: "decision-log-database-migration-v1",
  pendingInvocations: "pending-invocations",
} as const;

export const DECISION_LOG_RETENTION_DAYS = 90;

/**
 * TOG-3419: how long a `model_router_invoke_async` submission stays pollable
 * after it finishes (or while it is still running). `ctx.state` has no native
 * TTL, so this is enforced by hand at read time in the poll handler.
 */
export const PENDING_INVOCATION_TTL_MS = 15 * 60 * 1_000;
