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
  const body = input.config.protocol === "openai-chat-completions"
    ? buildOpenAiRequest(input.request, input.modelId)
    : buildAnthropicRequest(input.request, input.modelId);
  const request = input.http.fetch(upstreamUrl(input.config), {
    method: "POST",
    headers: requestHeaders(input.config, input.credential),
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
    const name = cause instanceof Error ? cause.name : "";
    if (name === "TypeError") {
      return error("upstream-url-rejected", "The host rejected the configured compatible upstream URL.", false);
    }
    return error("upstream-connect", "The router could not connect to the compatible upstream.", true);
  } finally {
    if (timer) clearTimeout(timer);
  }

  try {
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
