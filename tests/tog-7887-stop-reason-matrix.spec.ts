/**
 * TOG-7887 G13 — pin the stop-reason matrix across both protocols.
 *
 * Refusal, content-filter, max-tokens-with-empty-content, and truncation are
 * all handled inside the adapters (`openAiStop`, `anthropicStop`, and
 * `stopReasonForEmptyContent`), but until now no single table pinned the
 * protocol x upstream-stop-shape -> normalized `stopReason` + content-emptiness
 * mapping. A protocol-mapping refactor could silently reclassify a refusal as
 * success (or a filter hit as an end-turn) and only scattered tests would
 * notice.
 *
 * Each row names its cell (`<protocol> <upstream stop> + <content shape>`), so
 * flipping any one mapping turns exactly its cell(s) red by name. That is the
 * acceptance check: change one arm of `openAiStop`/`anthropicStop` and this
 * spec must fail naming the cell.
 *
 * Contract reference: docs/contracts/compatible-upstream-v1.md section 7 stop
 * mapping table, plus the TOG-1035 empty-content rule (an asserted refusal or
 * filter explains the emptiness and is kept; only an unbelievable "it
 * finished" — end-turn/other with no readable content — is corrected to
 * max-tokens).
 */
import { describe, expect, it } from "vitest";

import {
  normalizeAnthropicSuccess,
  normalizeOpenAiSuccess,
} from "../src/inference/adapters.js";
import type { NormalizedStopReason } from "../src/inference/types.js";

type Protocol = "openai-chat-completions" | "anthropic-messages";

interface MatrixCell {
  /** Cell name: flipping the mapping under test must fail exactly this name. */
  name: string;
  protocol: Protocol;
  body: unknown;
  expectedStopReason: NormalizedStopReason;
  /** Pinned content emptiness: true means `content` must be `[]`. */
  expectEmpty: boolean;
  expectedStopSequence?: string | null;
}

function openAiEnvelope(finishReason: unknown, message: Record<string, unknown>): unknown {
  return {
    object: "chat.completion",
    id: "chatcmpl-matrix",
    model: "matrix-model",
    choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finishReason }],
  };
}

function anthropicEnvelope(stopReason: unknown, content: unknown[], stopSequence: unknown = null): unknown {
  return {
    id: "msg-matrix",
    type: "message",
    role: "assistant",
    model: "matrix-model",
    content,
    stop_reason: stopReason,
    stop_sequence: stopSequence,
  };
}

const OPENAI_TOOL_CALL = {
  tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: '{"id":1}' } }],
};

const ANTHROPIC_TOOL_USE = [{ type: "tool_use", id: "toolu-1", name: "lookup", input: { id: 1 } }];

const CELLS: MatrixCell[] = [
  // -- OpenAI finish_reason -------------------------------------------------
  { name: "openai finish_reason=stop + text", protocol: "openai-chat-completions", body: openAiEnvelope("stop", { content: "Done" }), expectedStopReason: "end-turn", expectEmpty: false },
  // TOG-1035: a well-formed success with nothing readable ran out of room.
  { name: "openai finish_reason=stop + empty string -> max-tokens", protocol: "openai-chat-completions", body: openAiEnvelope("stop", { content: "" }), expectedStopReason: "max-tokens", expectEmpty: true },
  { name: "openai finish_reason=stop + null content -> max-tokens", protocol: "openai-chat-completions", body: openAiEnvelope("stop", { content: null }), expectedStopReason: "max-tokens", expectEmpty: true },
  // Truncation: the model was cut off mid-generation; partial text survives.
  { name: "openai finish_reason=length + partial text (truncated)", protocol: "openai-chat-completions", body: openAiEnvelope("length", { content: "partial" }), expectedStopReason: "max-tokens", expectEmpty: false },
  { name: "openai finish_reason=length + empty", protocol: "openai-chat-completions", body: openAiEnvelope("length", { content: null }), expectedStopReason: "max-tokens", expectEmpty: true },
  { name: "openai finish_reason=tool_calls + tool_call", protocol: "openai-chat-completions", body: openAiEnvelope("tool_calls", { content: null, ...OPENAI_TOOL_CALL }), expectedStopReason: "tool-use", expectEmpty: false },
  // tool-use explains the emptiness, so it is kept rather than corrected.
  { name: "openai finish_reason=tool_calls + empty (kept, not corrected)", protocol: "openai-chat-completions", body: openAiEnvelope("tool_calls", { content: null }), expectedStopReason: "tool-use", expectEmpty: true },
  // The filter is WHY there is no content; reclassifying it as success hides it.
  { name: "openai finish_reason=content_filter + empty", protocol: "openai-chat-completions", body: openAiEnvelope("content_filter", { content: null }), expectedStopReason: "content-filter", expectEmpty: true },
  { name: "openai finish_reason=content_filter + partial text", protocol: "openai-chat-completions", body: openAiEnvelope("content_filter", { content: "partial" }), expectedStopReason: "content-filter", expectEmpty: false },
  { name: "openai finish_reason=null + text -> other", protocol: "openai-chat-completions", body: openAiEnvelope(null, { content: "Done" }), expectedStopReason: "other", expectEmpty: false },
  { name: "openai finish_reason=null + empty -> max-tokens", protocol: "openai-chat-completions", body: openAiEnvelope(null, { content: null }), expectedStopReason: "max-tokens", expectEmpty: true },
  { name: "openai finish_reason=function_call (legacy, unrecognized) + text -> other", protocol: "openai-chat-completions", body: openAiEnvelope("function_call", { content: "Done" }), expectedStopReason: "other", expectEmpty: false },
  // Protocol asymmetry: `refusal` is an Anthropic-only token; on the OpenAI
  // wire it is unrecognized and must not become `refusal`.
  { name: "openai finish_reason=refusal (anthropic-only token) + text -> other", protocol: "openai-chat-completions", body: openAiEnvelope("refusal", { content: "Done" }), expectedStopReason: "other", expectEmpty: false },

  // -- Anthropic stop_reason ------------------------------------------------
  { name: "anthropic stop_reason=end_turn + text", protocol: "anthropic-messages", body: anthropicEnvelope("end_turn", [{ type: "text", text: "Done" }]), expectedStopReason: "end-turn", expectEmpty: false },
  // TOG-1035: thinking-only reply — the budget went on hidden tokens.
  { name: "anthropic stop_reason=end_turn + thinking-only (empty) -> max-tokens", protocol: "anthropic-messages", body: anthropicEnvelope("end_turn", [{ type: "thinking", thinking: "<think>...</think>" }]), expectedStopReason: "max-tokens", expectEmpty: true },
  { name: "anthropic stop_reason=end_turn + [] (empty) -> max-tokens", protocol: "anthropic-messages", body: anthropicEnvelope("end_turn", []), expectedStopReason: "max-tokens", expectEmpty: true },
  // Truncation: partial text survives the cutoff.
  { name: "anthropic stop_reason=max_tokens + partial text (truncated)", protocol: "anthropic-messages", body: anthropicEnvelope("max_tokens", [{ type: "text", text: "partial" }]), expectedStopReason: "max-tokens", expectEmpty: false },
  { name: "anthropic stop_reason=max_tokens + empty", protocol: "anthropic-messages", body: anthropicEnvelope("max_tokens", []), expectedStopReason: "max-tokens", expectEmpty: true },
  { name: "anthropic stop_reason=stop_sequence + text + stop_sequence echoed", protocol: "anthropic-messages", body: anthropicEnvelope("stop_sequence", [{ type: "text", text: "Done" }], "STOP"), expectedStopReason: "stop-sequence", expectEmpty: false, expectedStopSequence: "STOP" },
  { name: "anthropic stop_reason=stop_sequence + empty (kept, not corrected)", protocol: "anthropic-messages", body: anthropicEnvelope("stop_sequence", []), expectedStopReason: "stop-sequence", expectEmpty: true },
  { name: "anthropic stop_reason=tool_use + tool_use", protocol: "anthropic-messages", body: anthropicEnvelope("tool_use", ANTHROPIC_TOOL_USE), expectedStopReason: "tool-use", expectEmpty: false },
  { name: "anthropic stop_reason=tool_use + empty (kept, not corrected)", protocol: "anthropic-messages", body: anthropicEnvelope("tool_use", []), expectedStopReason: "tool-use", expectEmpty: true },
  // The key anti-reclassification cells: a refusal must never read as success.
  { name: "anthropic stop_reason=refusal + empty", protocol: "anthropic-messages", body: anthropicEnvelope("refusal", []), expectedStopReason: "refusal", expectEmpty: true },
  { name: "anthropic stop_reason=refusal + text", protocol: "anthropic-messages", body: anthropicEnvelope("refusal", [{ type: "text", text: "I cannot help" }]), expectedStopReason: "refusal", expectEmpty: false },
  { name: "anthropic stop_reason=null + text -> other", protocol: "anthropic-messages", body: anthropicEnvelope(null, [{ type: "text", text: "Done" }]), expectedStopReason: "other", expectEmpty: false },
  { name: "anthropic stop_reason=null + empty -> max-tokens", protocol: "anthropic-messages", body: anthropicEnvelope(null, []), expectedStopReason: "max-tokens", expectEmpty: true },
  { name: "anthropic stop_reason=bogus + text -> other", protocol: "anthropic-messages", body: anthropicEnvelope("bogus", [{ type: "text", text: "Done" }]), expectedStopReason: "other", expectEmpty: false },
  // Protocol asymmetry: `content_filter` is an OpenAI-only token; on the
  // Anthropic wire it is unrecognized (other), and with no readable content
  // the empty-content rule corrects it to max-tokens.
  { name: "anthropic stop_reason=content_filter (openai-only token) + empty -> max-tokens", protocol: "anthropic-messages", body: anthropicEnvelope("content_filter", []), expectedStopReason: "max-tokens", expectEmpty: true },
];

describe("TOG-7887 G13: stop-reason matrix across both protocols", () => {
  it.each(CELLS)("$name", (cell) => {
    const result = cell.protocol === "openai-chat-completions"
      ? normalizeOpenAiSuccess(cell.body, "selected-model", null)
      : normalizeAnthropicSuccess(cell.body, "selected-model", null);
    expect(result.stopReason).toBe(cell.expectedStopReason);
    expect(result.content.length === 0).toBe(cell.expectEmpty);
    expect(result.stopSequence).toBe(cell.expectedStopSequence ?? null);
    expect(result.upstream.protocol).toBe(cell.protocol);
  });
});
