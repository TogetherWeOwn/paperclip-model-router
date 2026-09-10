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
