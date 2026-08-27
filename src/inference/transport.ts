import { JsonRpcCallError } from "@paperclipai/plugin-sdk";
import type { PluginHttpClient } from "@paperclipai/plugin-sdk";

import type { CompatibleUpstreamConfig } from "../config/types.js";
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

function isHostUrlRejection(cause: unknown): boolean {
  if (cause instanceof TypeError) return true;
  if (!(cause instanceof JsonRpcCallError)) return false;
  const message = cause.message.toLowerCase();
  return message.startsWith("invalid url:") ||
    message.startsWith("disallowed protocol ") ||
    message.startsWith("all resolved ips for ") ||
    message.startsWith("resolved ips for ") ||
    message.startsWith("dns resolution returned no results for ") ||
    message.startsWith("dns lookup timed out after ") ||
    message.startsWith("dns resolution failed for ") ||
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

export async function invokeCompatibleUpstream(input: {
  http: PluginHttpClient;
  config: CompatibleUpstreamConfig;
  credential: string;
  request: InvokeRequest;
  modelId: string;
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
  const request = input.http.fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "manual",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: Response;
  try {
    response = await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("router-request-timeout")), input.config.requestTimeoutMs);
      }),
    ]);
  } catch (cause) {
    if (cause instanceof Error && cause.message === "router-request-timeout") {
      request.catch(() => undefined);
      return error("upstream-timeout", "The compatible upstream exceeded the configured request timeout.", true);
    }
    if (isHostUrlRejection(cause)) {
      return error("upstream-url-rejected", "The host rejected the configured compatible upstream URL.", false);
    }
    return error("upstream-connect", "The router could not connect to the compatible upstream.", true);
  } finally {
    if (timer) clearTimeout(timer);
  }

  try {
    if (response.status >= 300 && response.status < 400) {
      return { response: null, error: classifyHttpError(response.status, null) };
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const contentEncoding = response.headers.get("content-encoding")?.toLowerCase() ?? "identity";
    if (!contentType.includes("application/json") || (contentEncoding !== "identity" && contentEncoding !== "")) {
      return error("invalid-upstream-response", "The compatible upstream did not return an uncompressed JSON response.", false);
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
