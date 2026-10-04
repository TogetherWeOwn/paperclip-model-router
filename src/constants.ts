export const PLUGIN_ID = "togetherweown.paperclip-model-router";

/** Kept in sync with package.json by `npm run verify`. */
export const PLUGIN_VERSION = "0.8.0";

export const PLUGIN_API_VERSION = 1 as const;

export const ACTION_KEYS = {
  invoke: "invoke",
  invokeAsync: "invoke-async",
  invokeResult: "invoke-result",
  refreshCapacity: "refresh-capacity",
  /**
   * TOG-7417: run-end reap. The host calls this when an agent run finishes so
   * still-running async invocations for that run are aborted and settled to a
   * terminal `invocation-cancelled` outcome instead of lingering to TTL.
   */
  cancelRunInvocations: "cancel-run-invocations",
  /**
   * TOG-7897: company-scoped read path over the durable decision records.
   * The host injects the company id; the query filters on it, so a caller
   * can only ever see its own company's routing history.
   */
  queryDecisions: "query-decisions",
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
  /**
   * TOG-7160 (port of TOG-930): read each company's configured upstream
   * catalogue and take models that have gone dark out of service. Catalogue
   * presence never creates positive health — it only clears absence strikes;
   * `healthy`/`degraded` require real invocation evidence.
   */
  modelHealth: "model-health-probe",
} as const;

export const STATE_KEYS = {
  capacitySnapshot: "capacity-snapshot",
  issueStickiness: "issue-stickiness",
  legacyDecisionLog: "decision-log",
  decisionLogMigration: "decision-log-database-migration-v1",
  /** Prefix for one company-scoped state row per async request id. */
  pendingInvocations: "pending-invocations",
  /**
   * TOG-7417: one company-scoped state row per agent run holding the request
   * ids of its still-open async invocations (`{ requestIds: string[] }`), so
   * the run-end reap can enumerate them. `ctx.state` has no listing
   * primitive, hence the explicit index. Best-effort: entries missing here
   * still expire via the pending row's own TTL.
   */
  pendingInvocationsByRun: "pending-invocations-by-run",
  /**
   * TOG-7160 (port of TOG-930): company-scoped invocation-derived model
   * health overlay (`ModelHealthState`). `ctx.config` is read-only to the
   * plugin, so the probe records health here and selection reads the overlay
   * on top of the operator's model table. The operator's `enabled: false`
   * always wins — the probe can take a model out of service, never put one
   * back into service against the operator's wish.
   */
  modelHealth: "model-health",
} as const;

/**
 * TOG-7877 (G15): bound on the per-company issue-stickiness map
 * (`issue-stickiness` state row). Without a cap the row grows one entry per
 * issue id forever. Eviction is insertion-ordered LRU on the write path: the
 * written issue moves to most-recent, and the oldest entries past the cap are
 * dropped. Reads never move recency, so the sticky hot path (same issue, same
 * model) performs no state write. An evicted issue is not an error — its next
 * invocation simply re-selects. 1000 entries ≈ ~100 KB worst case per company
 * row, far above any realistic active-issue count.
 */
export const ISSUE_STICKINESS_MAX_ENTRIES = 1000;

export const DECISION_LOG_RETENTION_DAYS = 90;

/**
 * TOG-3419: how long a `model_router_invoke_async` submission stays pollable
 * after it finishes (or while it is still running). `ctx.state` has no native
 * TTL, so the worker schedules deletion and the poll handler lazily deletes an
 * expired row if a worker restart interrupted that timer.
 */
export const PENDING_INVOCATION_TTL_MS = 15 * 60 * 1_000;
