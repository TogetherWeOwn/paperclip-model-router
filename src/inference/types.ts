import type { CompatibleUpstreamProtocol } from "../config/types.js";
import type { RoutingDecision, TaskDescriptor } from "../engine/types.js";

export interface InvokeRequest {
  task: TaskDescriptor;
  messages: Message[];
  system?: string;
  maxOutputTokens: number;
  stopSequences?: string[];
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
  metadata?: Record<string, string>;
}

export interface Message {
  role: "user" | "assistant" | "tool";
  content: string | ContentBlock[];
  toolCallId?: string;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; url: string }
  | { type: "tool_call"; id: string; name: string; arguments: unknown }
  | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean };

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export type NormalizedStopReason =
  | "end-turn"
  | "max-tokens"
  | "stop-sequence"
  | "tool-use"
  | "refusal"
  | "content-filter"
  | "other";

export interface NormalizedResponse {
  id: string | null;
  modelId: string;
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> }
  >;
  stopReason: NormalizedStopReason;
  stopSequence: string | null;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  };
  upstream: {
    protocol: CompatibleUpstreamProtocol;
    requestId: string | null;
    responseModelId: string | null;
  };
}

export type InferenceErrorCode =
  | "invalid-request"
  | "secret-unavailable"
  | "internal-error"
  | "upstream-url-rejected"
  /**
   * TOG-7881 (G2): the stored company config itself fails closed at load
   * (fail-closed `resolveConfig` throws: bad Rule 0 patterns, duplicate
   * model ids, forbidden extraHeaders). A stored-config refusal, never a
   * caller-request or upstream problem — non-retryable until the operator
   * fixes the config. The message names the offending path and index.
   */
  | "invalid-config"
  | "upstream-redirect"
  | "upstream-connect"
  | "upstream-timeout"
  | "upstream-response-too-large"
  | "upstream-authentication"
  | "upstream-permission"
  | "upstream-not-found"
  | "upstream-conflict"
  | "upstream-rate-limit"
  | "upstream-client-error"
  | "upstream-server-error"
  | "upstream-overloaded"
  | "invalid-upstream-response"
  /**
   * TOG-7417: the async invocation was reaped by `cancel-run-invocations`
   * when its agent run ended before the upstream call completed. Never
   * produced by the transport itself.
   */
  | "invocation-cancelled";

export interface InferenceError {
  code: InferenceErrorCode;
  message: string;
  retryable: boolean;
  upstreamStatus: number | null;
  upstreamRequestId: string | null;
}

export type InferenceResult =
  | {
      outcome: "no-model-needed" | "no-eligible-model" | "disabled";
      requestId: string;
      decision: RoutingDecision;
      response: null;
      error: null;
    }
  | {
      outcome: "completed";
      requestId: string;
      decision: RoutingDecision;
      response: NormalizedResponse;
      error: null;
    }
  | {
      outcome: "error";
      requestId: string;
      decision: RoutingDecision | null;
      response: null;
      error: InferenceError;
    };
