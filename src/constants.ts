export const PLUGIN_ID = "togetherweown.paperclip-model-router";

/** Kept in sync with package.json by `npm run verify`. */
export const PLUGIN_VERSION = "0.7.1";

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

export const JOB_KEYS = {
  /**
   * TOG-3419: the host clears a plugin's invocation scope the instant it
   * receives the worker's RPC response, but `invokeAsync`'s background
   * continuation (an unawaited promise started during that response) keeps
   * running afterward. Node's AsyncLocalStorage still attaches the
   * now-cleared invocation id to any `ctx.state`/`ctx.db` call it makes, so
   * the host rejects it. A scheduled job's dispatch carries no invocation id
   * at all, so its handler runs under the host's proactive-company grant
   * instead and can flush what the continuation could not persist.
   */
  reconcileAsyncInvocations: "reconcile-async-invocations",
} as const;

export const STATE_KEYS = {
  capacitySnapshot: "capacity-snapshot",
  issueStickiness: "issue-stickiness",
  legacyDecisionLog: "decision-log",
  decisionLogMigration: "decision-log-database-migration-v1",
  /** Prefix for one company-scoped state row per async request id. */
  pendingInvocations: "pending-invocations",
} as const;

export const DECISION_LOG_RETENTION_DAYS = 90;

/**
 * TOG-3419: how long a `model_router_invoke_async` submission stays pollable
 * after it finishes (or while it is still running). `ctx.state` has no native
 * TTL, so the worker schedules deletion and the poll handler lazily deletes an
 * expired row if a worker restart interrupted that timer.
 */
export const PENDING_INVOCATION_TTL_MS = 15 * 60 * 1_000;
