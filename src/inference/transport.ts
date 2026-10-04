import { JsonRpcCallError } from "@paperclipai/plugin-sdk";
import type { PluginHttpClient } from "@paperclipai/plugin-sdk";

import type { CompatibleUpstreamConfig } from "../config/types.js";
import { checkResolvedHost, MAX_REQUEST_TIMEOUT_MS, MIN_REQUEST_TIMEOUT_MS } from "../config/upstream-constraints.js";
import type { HostAddressResolver } from "../config/upstream-constraints.js";
import {
  buildAnthropicRequest,
  buildOpenAiRequest,
  classifyHttpError,
  normalizeAnthropicSuccess,
  normalizeOpenAiSuccess,
  requestHeaders,
  upstreamRequestId,
  upstreamUrl,
} from "./adapters.js";
import type { InferenceError, InvokeRequest, NormalizedResponse } from "./types.js";

export type TransportResult =
  | { response: NormalizedResponse; error: null }
  | { response: null; error: InferenceError };

function error(code: InferenceError["code"], message: string, retryable: boolean): TransportResult {
  return { response: null, error: { code, message, retryable, upstreamStatus: null, upstreamRequestId: null } };
}

/**
 * A {@link PluginHttpClient} that performs the outbound request with the worker
 * process's own `fetch`, deliberately bypassing the host RPC bridge.
 *
 * Why this exists: the host-managed `ctx.http.fetch` bridge hard-aborts every
 * outbound request at 30s (`plugin-host-services.ts` `PLUGIN_FETCH_TIMEOUT_MS`),
 * which makes any generation longer than the host RPC cap impossible on that
 * path — this was the wall the async design first hit. The plugin SDK
 * explicitly sanctions direct `fetch` from a worker ("Plugins may also use
 * standard Node `fetch` or other libraries directly" — `PluginHttpClient`
 * docs). The worker is a long-lived forked Node process with direct network
 * egress, so its own `fetch` is not subject to the host abort and can run up to
 * this transport's own `MAX_REQUEST_TIMEOUT_MS` (300s) ceiling.
 *
 * SSRF: this path does not re-run the host's per-request DNS pinning. The
 * plugin pins instead: `invokeCompatibleUpstream` resolves the request
 * hostname at request time (TOG-7884) and refuses when ANY answer is
 * private/reserved — fail-closed on rebinding, split-horizon DNS, and records
 * that changed after config validation. Config validation additionally
 * constrains `upstream.baseUrl` to an https, credential-free,
 * non-private/reserved absolute URL (see `config/upstream-constraints` and
 * the `upstream.baseUrl` checks in the config validator). The per-request
 * payload never changes the host or path beyond that fixed endpoint.
 *
 * Used only by the async (submit + poll) background continuation. The
 * synchronous `/invoke` path keeps `ctx.http` and its 30s host cap unchanged.
 */
export const directFetchHttpClient: PluginHttpClient = {
  fetch: (url, init) => globalThis.fetch(url, init),
};

function sdkReconstructedEmptyResponseStatus(cause: unknown): 204 | 205 | 304 | null {
  if (!(cause instanceof TypeError)) return null;
  const match = /^Response constructor: Invalid response status code (204|205|304)$/.exec(cause.message);
  if (!match) return null;
  return Number(match[1]) as 204 | 205 | 304;
}

function isHostUrlRejection(cause: unknown): boolean {
  if (!(cause instanceof JsonRpcCallError)) return false;
  const message = cause.message.toLowerCase();
  return message.startsWith("invalid url:") ||
    message.startsWith("disallowed protocol ") ||
    message.startsWith("all resolved ips for ") ||
    message.startsWith("resolved ips for ") ||
    message.includes("url resolves to a private, local, multicast, or reserved address") ||
    message.includes("url cannot target private or reserved network addresses") ||
    message.includes("url cannot resolve to private or reserved network addresses");
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<{ value: unknown; tooLarge: boolean }> {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    return { value: null, tooLarge: true };
  }
  try {
    return { value: JSON.parse(text), tooLarge: false };
  } catch {
    return { value: undefined, tooLarge: false };
  }
}

/**
 * The wall-clock budget this one generation actually gets.
 *
 * A per-model override wins over the shared upstream value, but it is clamped
 * here rather than trusted: `getConfigSchema()` is form metadata that validates
 * nothing at runtime, so a stored row can carry any number at all. Clamping in
 * the execution path is what makes the bound real. A malformed or absent
 * override falls back to the upstream value instead of failing the call.
 */
export function effectiveRequestTimeoutMs(
  upstreamTimeoutMs: number,
  modelTimeoutMs?: number,
): number {
  if (modelTimeoutMs === undefined || !Number.isFinite(modelTimeoutMs)) return upstreamTimeoutMs;
  const requested = Math.trunc(modelTimeoutMs);
  return Math.min(Math.max(requested, MIN_REQUEST_TIMEOUT_MS), MAX_REQUEST_TIMEOUT_MS);
}

export async function invokeCompatibleUpstream(input: {
  http: PluginHttpClient;
  config: CompatibleUpstreamConfig;
  credential: string;
  request: InvokeRequest;
  modelId: string;
  /** Per-model override from the selected model's table entry; absent means inherit. */
  modelTimeoutMs?: number;
  /**
   * TOG-7417: abort signal for run-end reap. Only the async background
   * continuation supplies one (one AbortController per request, owned by the
   * worker); the synchronous path never aborts and passes nothing, so its
   * wire shape is unchanged. When the signal fires the outcome is
   * `invocation-cancelled`, never an upstream error code.
   */
  signal?: AbortSignal;
  /**
   * TOG-7884 (gap G6): request-time DNS resolution hook for the SSRF guard.
   * Defaults to the worker's real resolver; tests inject a mock. Absent in
   * every production call site, so the default applies there.
   */
  resolveHostAddresses?: HostAddressResolver;
}): Promise<TransportResult> {
  let url: string;
  let headers: Record<string, string>;
  let body: unknown;
  try {
    url = upstreamUrl(input.config);
    headers = requestHeaders(input.config, input.credential);
    if (input.config.protocol === "openai-chat-completions") {
      body = buildOpenAiRequest(input.request, input.modelId);
    } else if (input.config.protocol === "anthropic-messages") {
      body = buildAnthropicRequest(input.request, input.modelId);
    } else {
      return error("upstream-url-rejected", "The configured compatible upstream protocol is not supported.", false);
    }
  } catch {
    return error("upstream-url-rejected", "The configured compatible upstream is invalid.", false);
  }
  // TOG-7884 (gap G6): request-time DNS guard. The literal-host check in
  // config validation only sees IP literals; a DNS name resolving to 10.x /
  // 169.254.x / ::1 sails through it. This resolves the *request* hostname —
  // the derived upstreamUrl, not just baseUrl — and refuses when ANY answer
  // is private/reserved, closing the rebinding window on this path too.
  // No credential or header has been built into a wire call yet: requestHeaders
  // returns a plain object, and fetch is the first point anything leaves the
  // process, so refusing here guarantees nothing exfiltrates.
  try {
    const resolved = await checkResolvedHost(new URL(url).hostname, input.resolveHostAddresses);
    if (!resolved.allowed) {
      return error("upstream-url-rejected", "The configured compatible upstream URL resolves to a private or reserved address.", false);
    }
  } catch {
    return error("upstream-url-rejected", "The configured compatible upstream is invalid.", false);
  }
  // TOG-7417: the signal travels on the fetch init so both the real worker
  // fetch and the harness/test doubles see it. A test fake that ignores the
  // init still terminates when the reap path resolves the race, so an abort
  // is never hostage to a fake honoring AbortSignal.
  // A synchronously-throwing fetch never produced a request: it is a network
  // failure before headers (§8: network or DNS failure -> upstream-connect),
  // not a reason for the caller to see a throw.
  let request: Promise<Response>;
  try {
    request = input.http.fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "manual",
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch {
    return error("upstream-connect", "The router could not connect to the compatible upstream.", true);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: Response;
  try {
    response = await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("router-request-timeout")),
          effectiveRequestTimeoutMs(input.config.requestTimeoutMs, input.modelTimeoutMs),
        );
      }),
    ]);
  } catch (cause) {
    if (cause instanceof Error && cause.message === "router-request-timeout") {
      request.catch(() => undefined);
      return error("upstream-timeout", "The compatible upstream exceeded the configured request timeout.", true);
    }
    // TOG-7417: run-end reap. A rejection with an already-aborted signal is
    // the caller's cancellation, not an upstream failure — report it under
    // its own non-retryable code so retry logic never replays a run the host
    // has declared finished. Checked before the host-URL and connect
    // fallthroughs, which would otherwise misclassify the abort.
    if (input.signal?.aborted) {
      request.catch(() => undefined);
      return {
        response: null,
        error: { code: "invocation-cancelled", message: "The invocation was cancelled when its agent run ended.", retryable: false, upstreamStatus: null, upstreamRequestId: null },
      };
    }
    const emptyStatus = sdkReconstructedEmptyResponseStatus(cause);
    if (emptyStatus !== null) {
      response = new Response(null, { status: emptyStatus });
    } else if (isHostUrlRejection(cause)) {
      return error("upstream-url-rejected", "The host rejected the configured compatible upstream URL.", false);
    } else {
      return error("upstream-connect", "The router could not connect to the compatible upstream.", true);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  try {
    if (response.status >= 300 && response.status < 400) {
      const requestId = upstreamRequestId(response.headers, null);
      return { response: null, error: classifyHttpError(response.status, requestId) };
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const contentEncoding = response.headers.get("content-encoding")?.toLowerCase() ?? "identity";
    if (!contentType.includes("application/json")) {
      return error("invalid-upstream-response", "The compatible upstream did not return JSON response media.", false);
    }
    if (contentEncoding !== "identity" && contentEncoding !== "") {
      return error("invalid-upstream-response", "The compatible upstream returned a non-identity response encoding.", false);
    }
    const bounded = await readBoundedJson(response, input.config.maxResponseBytes);
    if (bounded.tooLarge) {
      return error("upstream-response-too-large", "The compatible upstream response exceeded the configured size limit.", false);
    }
    const requestId = upstreamRequestId(response.headers, bounded.value);
    if (response.status < 200 || response.status >= 300) {
      const classified = classifyHttpError(response.status, requestId);
      return { response: null, error: classified };
    }
    if (bounded.value === undefined) {
      return error("invalid-upstream-response", "The compatible upstream returned invalid JSON.", false);
    }
    try {
      const normalized = input.config.protocol === "openai-chat-completions"
        ? normalizeOpenAiSuccess(bounded.value, input.modelId, requestId)
        : normalizeAnthropicSuccess(bounded.value, input.modelId, requestId);
      return { response: normalized, error: null };
    } catch {
      return error("invalid-upstream-response", "The compatible upstream returned an invalid success envelope.", false);
    }
  } catch {
    return error("upstream-connect", "The compatible upstream response could not be read.", true);
  }
}
