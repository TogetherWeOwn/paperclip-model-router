/**
 * Stable identifiers for the plugin. Everything here is code, not configuration:
 * these values are the same in every company the plugin is installed for.
 *
 * Anything that legitimately differs between companies belongs in
 * `src/config/schema.ts` and is supplied per company through
 * `POST /api/plugins/:pluginId/config`.
 */

export const PLUGIN_ID = "togetherweown.paperclip-model-router";

/** Kept in sync with package.json by `npm run verify` (see tests/manifest.spec.ts). */
export const PLUGIN_VERSION = "0.1.1";

/** Host plugin API generation this manifest targets. */
export const PLUGIN_API_VERSION = 1 as const;

/** `ctx.data.register` keys. */
export const DATA_KEYS = {
  /** Effective, defaulted configuration for a company. */
  effectiveConfig: "effective-config",
  /** Recent routing decisions recorded for a company. */
  decisions: "decisions",
  /** Quota-gate view for a company. */
  quota: "quota",
} as const;

/** `ctx.actions.register` keys. */
export const ACTION_KEYS = {
  /** Produce a routing decision for a task descriptor. */
  route: "route",
  /** Re-read the teamclaude quota snapshot for a company. */
  refreshQuota: "refresh-quota",
} as const;

/** Agent-facing tool names. */
export const TOOL_NAMES = {
  selectModel: "model_router_select",
} as const;

/** Scoped API route keys (served under /api/plugins/:pluginId/api/...). */
export const ROUTE_KEYS = {
  routeIssue: "route-issue",
  companyConfig: "company-config",
} as const;

/** Plugin state keys, all written under `scopeKind: "company"`. */
export const STATE_KEYS = {
  /** Ring buffer of recent decisions, for audit and for the UI. */
  decisionLog: "decision-log",
  /** Last teamclaude quota snapshot and the gate level derived from it. */
  quotaSnapshot: "quota-snapshot",
  /** Model chosen for an issue, so a mid-task switch does not destroy the prompt cache. */
  issueStickiness: "issue-stickiness",
} as const;

/** How many decisions to retain per company in `STATE_KEYS.decisionLog`. */
export const DECISION_LOG_LIMIT = 200;
