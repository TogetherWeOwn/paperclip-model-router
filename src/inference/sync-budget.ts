import { SYNC_BUDGET_CEILING_MS, syncThroughputTokensPerMs } from "../config/upstream-constraints.js";
import type { SyncThroughputClass } from "../engine/types.js";
import { effectiveRequestTimeoutMs } from "./transport.js";

/**
 * TOG-3419: the token count the synchronous `/invoke` path can plausibly
 * finish within `SYNC_BUDGET_CEILING_MS`, used to reject unreachable
 * requests before ever calling the upstream. An explicit per-model override
 * always wins; otherwise this derives a default from the model's effective
 * request timeout (clamped to the sync ceiling) and the per-class throughput
 * row for `modelSyncThroughputClass` (TOG-7896). `model_router_invoke_async`
 * never calls this — it inherits the model's full timeout with no token
 * ceiling beyond that.
 */
export function effectiveMaxSyncOutputTokens(
  upstreamTimeoutMs: number,
  modelTimeoutMs: number | undefined,
  modelMaxSyncOutputTokens: number | undefined,
  modelSyncThroughputClass?: SyncThroughputClass,
): number {
  if (modelMaxSyncOutputTokens !== undefined && Number.isFinite(modelMaxSyncOutputTokens)) {
    return Math.max(1, Math.trunc(modelMaxSyncOutputTokens));
  }
  const budgetMs = Math.min(
    effectiveRequestTimeoutMs(upstreamTimeoutMs, modelTimeoutMs),
    SYNC_BUDGET_CEILING_MS,
  );
  return Math.max(1, Math.floor(budgetMs * syncThroughputTokensPerMs(modelSyncThroughputClass)));
}
