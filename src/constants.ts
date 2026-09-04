export const PLUGIN_ID = "togetherweown.paperclip-model-router";

/** Kept in sync with package.json by `npm run verify`. */
export const PLUGIN_VERSION = "0.3.0";

export const PLUGIN_API_VERSION = 1 as const;

export const ACTION_KEYS = {
  invoke: "invoke",
  refreshCapacity: "refresh-capacity",
} as const;

export const TOOL_NAMES = {
  invoke: "model_router_invoke",
} as const;

export const ROUTE_KEYS = {
  invoke: "invoke",
  invokeIssue: "invoke-issue",
} as const;

export const STATE_KEYS = {
  decisionLog: "decision-log",
  capacitySnapshot: "capacity-snapshot",
  issueStickiness: "issue-stickiness",
} as const;

export const DECISION_LOG_LIMIT = 200;
