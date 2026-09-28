export const MIN_REQUEST_TIMEOUT_MS = 1_000;

/**
 * The ceiling an operator may configure, not the timeout anyone gets by default.
 *
 * This was 25s, and it was the wall a generation had to finish inside. A thinking
 * model routinely does not: TOG-1035 measured 20 of 32 `implementation` calls to
 * glm-5.3-flash failing at exactly 25.0s while OmniRoute's own call log showed the
 * same completions arriving upstream at ~27s. The work was done; the router had
 * already hung up on it. v1 invokes once with no retry, so that is a discarded
 * generation, not a delayed one.
 */
export const MAX_REQUEST_TIMEOUT_MS = 300_000;

/**
 * Pinned deliberately rather than derived from the ceiling.
 *
 * The config schema publishes this as its `default`, so for a company that never
 * sets `requestTimeoutMs` this value *is* the timeout. It used to be spelled
 * `MAX_REQUEST_TIMEOUT_MS`, which meant raising the ceiling would have silently
 * moved every unconfigured company from 25s to 300s — a routing change smuggled in
 * as a bounds change. Raising the ceiling stays strictly opt-in.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 25_000;

/**
 * TOG-3419: the wall-clock budget the *synchronous* `/invoke` path gets to
 * finish inside, independent of how large `requestTimeoutMs` is configured.
 * `model_router_invoke_async` has no such ceiling beyond the worker's own
 * `MAX_REQUEST_TIMEOUT_MS`.
 */
export const SYNC_BUDGET_CEILING_MS = 28_000;

/**
 * TOG-7896 (R2-14): per-class throughput table for the derived
 * `maxSyncOutputTokens` default. The sync preflight rejects a request whose
 * `maxOutputTokens` cannot finish inside the sync budget at the applicable
 * row's rate; an explicit per-model `maxSyncOutputTokens` always wins over
 * every row here.
 *
 * | class     | rate (tok/s) | provenance                                      |
 * |-----------|--------------|-------------------------------------------------|
 * | `chat`    | 1200/28 (~43)| Measured: glm-5.3-flash, ~1200 output tokens in |
 * |           |              | ~28s upstream generation time (TOG-1035).        |
 * | `reasoning`| 600/28 (~21) | Uncalibrated conservative estimate: HALF the    |
 * |           |              | measured chat row. No per-class production      |
 * |           |              | measurement exists yet; halving steers an       |
 * |           |              | unlabeled reasoning model toward async instead  |
 * |           |              | of risking a discarded sync generation.         |
 *
 * A model without `syncThroughputClass` uses the `chat` row, so every
 * existing config keeps byte-for-byte the budget it already had. Operators
 * with measured numbers for their own models must set `maxSyncOutputTokens`
 * explicitly instead of relying on either row. To calibrate a row: run N
 * representative generations, record billed output tokens over upstream
 * wall-clock, and take a low percentile (p10) as the row rate — the preflight
 * is a reachability ceiling, so the row must reflect slow generations, not
 * the median.
 */
export const SYNC_THROUGHPUT_CHAT_TOKENS_PER_MS = 1_200 / 28_000;
export const SYNC_THROUGHPUT_REASONING_TOKENS_PER_MS = 600 / 28_000;

/** Back-compat alias: the single pre-R2-14 baseline, now the `chat` row. */
export const SYNC_THROUGHPUT_TOKENS_PER_MS = SYNC_THROUGHPUT_CHAT_TOKENS_PER_MS;

/**
 * Resolves the applicable throughput row. Absent or unrecognized classes fall
 * through to `chat` — the measured, historically shipped default — never to
 * the estimate. Stored config rows can carry any value at all (the JSON
 * schema is form metadata that validates nothing at runtime), so the
 * execution path allowlists rather than trusts.
 */
export function syncThroughputTokensPerMs(modelClass: unknown): number {
  return modelClass === "reasoning"
    ? SYNC_THROUGHPUT_REASONING_TOKENS_PER_MS
    : SYNC_THROUGHPUT_CHAT_TOKENS_PER_MS;
}

export const MIN_RESPONSE_BYTES = 1_024;
export const MAX_RESPONSE_BYTES = 16_777_216;

export const FORBIDDEN_EXTRA_HEADER_NAMES = [
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "anthropic-version",
  "anthropic-beta",
  "openai-beta",
  "content-type",
  "accept",
  "accept-encoding",
  "content-length",
  "host",
  "connection",
  "transfer-encoding",
  "cookie",
] as const;

export const FORBIDDEN_EXTRA_HEADERS = new Set<string>(FORBIDDEN_EXTRA_HEADER_NAMES);

export { isReservedLiteralHost } from "../../packages/lane-capacity/src/url-policy.js";
