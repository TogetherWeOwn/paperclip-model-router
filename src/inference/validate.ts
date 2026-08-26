import type { ModelCapability, TaskDescriptor } from "../engine/types.js";
import type { ContentBlock, InvokeRequest, Message, ToolDefinition } from "./types.js";

const TOP_LEVEL_KEYS = new Set([
  "task",
  "messages",
  "system",
  "maxOutputTokens",
  "stopSequences",
  "tools",
  "toolChoice",
  "metadata",
]);
const TASK_KEYS = new Set([
  "taskClass",
  "summary",
  "issueId",
  "requiredCapabilities",
  "requiredContextTokens",
  "signals",
  "pinnedModelId",
  "pinReason",
  "estimatedInputTokens",
  "estimatedOutputTokens",
]);
const CAPABILITIES = new Set<ModelCapability>([
  "tools",
  "structured-output",
  "vision",
  "long-context",
  "computer-use",
]);

export class InvocationValidationError extends Error {}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvocationValidationError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: Set<string>, path: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new InvocationValidationError(`${path} carries unknown field(s): ${unknown.sort().join(", ")}`);
  }
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new InvocationValidationError(`${path} must be a string`);
  return value;
}

function positiveInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new InvocationValidationError(`${path} must be a positive integer`);
  }
  return value as number;
}

function parseTask(value: unknown): TaskDescriptor {
  const raw = record(value, "task");
  rejectUnknown(raw, TASK_KEYS, "task");
  const task: TaskDescriptor = {};
  task.taskClass = optionalString(raw.taskClass, "task.taskClass");
  task.summary = optionalString(raw.summary, "task.summary");
  task.issueId = optionalString(raw.issueId, "task.issueId");
  task.pinnedModelId = optionalString(raw.pinnedModelId, "task.pinnedModelId");
  task.pinReason = optionalString(raw.pinReason, "task.pinReason");
  task.requiredContextTokens = positiveInteger(raw.requiredContextTokens, "task.requiredContextTokens");
  task.estimatedInputTokens = positiveInteger(raw.estimatedInputTokens, "task.estimatedInputTokens");
  task.estimatedOutputTokens = positiveInteger(raw.estimatedOutputTokens, "task.estimatedOutputTokens");

  if (raw.requiredCapabilities !== undefined) {
    if (!Array.isArray(raw.requiredCapabilities)) {
      throw new InvocationValidationError("task.requiredCapabilities must be an array");
    }
    task.requiredCapabilities = raw.requiredCapabilities.map((entry, index) => {
      if (typeof entry !== "string" || !CAPABILITIES.has(entry as ModelCapability)) {
        throw new InvocationValidationError(`task.requiredCapabilities[${index}] is not supported`);
      }
      return entry as ModelCapability;
    });
  }

  if (raw.signals !== undefined) {
    const signals = record(raw.signals, "task.signals");
    task.signals = {};
    for (const [key, signal] of Object.entries(signals)) {
      if (typeof signal !== "number" || !Number.isFinite(signal)) {
        throw new InvocationValidationError(`task.signals.${key} must be a finite number`);
      }
      task.signals[key] = signal;
    }
  }
  return task;
}

function parseBlock(value: unknown, path: string): ContentBlock {
  const raw = record(value, path);
  if (raw.type === "text") {
    rejectUnknown(raw, new Set(["type", "text"]), path);
    if (typeof raw.text !== "string") throw new InvocationValidationError(`${path}.text must be a string`);
    return { type: "text", text: raw.text };
  }
  if (raw.type === "image_url") {
    rejectUnknown(raw, new Set(["type", "url"]), path);
    if (typeof raw.url !== "string" || raw.url.length === 0) {
      throw new InvocationValidationError(`${path}.url must be a non-empty string`);
    }
    return { type: "image_url", url: raw.url };
  }
  if (raw.type === "tool_call") {
    rejectUnknown(raw, new Set(["type", "id", "name", "arguments"]), path);
    if (typeof raw.id !== "string" || typeof raw.name !== "string" || raw.arguments === undefined) {
      throw new InvocationValidationError(`${path} must include id, name, and structured arguments`);
    }
    return { type: "tool_call", id: raw.id, name: raw.name, arguments: raw.arguments };
  }
  if (raw.type === "tool_result") {
    rejectUnknown(raw, new Set(["type", "toolCallId", "content", "isError"]), path);
    if (typeof raw.toolCallId !== "string" || typeof raw.content !== "string") {
      throw new InvocationValidationError(`${path} must include toolCallId and string content`);
    }
    if (raw.isError !== undefined && typeof raw.isError !== "boolean") {
      throw new InvocationValidationError(`${path}.isError must be a boolean`);
    }
    return {
      type: "tool_result",
      toolCallId: raw.toolCallId,
      content: raw.content,
      ...(raw.isError === true ? { isError: true } : {}),
    };
  }
  throw new InvocationValidationError(`${path}.type is not supported`);
}

function parseMessage(value: unknown, index: number): Message {
  const path = `messages[${index}]`;
  const raw = record(value, path);
  rejectUnknown(raw, new Set(["role", "content", "toolCallId"]), path);
  if (raw.role !== "user" && raw.role !== "assistant" && raw.role !== "tool") {
    throw new InvocationValidationError(`${path}.role is not supported`);
  }
  const toolCallId = optionalString(raw.toolCallId, `${path}.toolCallId`);
  if (raw.role === "tool" && !toolCallId) {
    throw new InvocationValidationError(`${path}.toolCallId is required for a tool message`);
  }
  let content: string | ContentBlock[];
  if (typeof raw.content === "string") {
    content = raw.content;
  } else if (Array.isArray(raw.content)) {
    content = raw.content.map((block, blockIndex) => parseBlock(block, `${path}.content[${blockIndex}]`));
    if (content.some((block) => block.type === "tool_call") && raw.role !== "assistant") {
      throw new InvocationValidationError(`${path} may contain tool_call blocks only for the assistant role`);
    }
    if (content.some((block) => block.type === "tool_result") && raw.role === "assistant") {
      throw new InvocationValidationError(`${path} may not contain tool_result blocks for the assistant role`);
    }
  } else {
    throw new InvocationValidationError(`${path}.content must be a string or content-block array`);
  }
  return { role: raw.role, content, ...(toolCallId ? { toolCallId } : {}) };
}

function parseTool(value: unknown, index: number): ToolDefinition {
  const path = `tools[${index}]`;
  const raw = record(value, path);
  rejectUnknown(raw, new Set(["name", "description", "inputSchema"]), path);
  if (typeof raw.name !== "string" || raw.name.length === 0) {
    throw new InvocationValidationError(`${path}.name must be a non-empty string`);
  }
  const description = optionalString(raw.description, `${path}.description`);
  const inputSchema = record(raw.inputSchema, `${path}.inputSchema`);
  return { name: raw.name, ...(description !== undefined ? { description } : {}), inputSchema };
}

export function parseInvokeRequest(
  value: unknown,
  configuredMaxOutputTokens: number,
  protocol?: "openai-chat-completions" | "anthropic-messages",
): InvokeRequest {
  const raw = record(value, "request");
  rejectUnknown(raw, TOP_LEVEL_KEYS, "request");
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    throw new InvocationValidationError("messages must contain at least one item");
  }
  if (!Number.isInteger(raw.maxOutputTokens) || (raw.maxOutputTokens as number) < 1) {
    throw new InvocationValidationError("maxOutputTokens must be a positive integer");
  }
  if ((raw.maxOutputTokens as number) > configuredMaxOutputTokens) {
    throw new InvocationValidationError(`maxOutputTokens exceeds the configured company maximum of ${configuredMaxOutputTokens}`);
  }

  const messages = raw.messages.map(parseMessage);
  const task = parseTask(raw.task);
  const hasImage = messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === "image_url"),
  );
  if (hasImage && !task.requiredCapabilities?.includes("vision")) {
    task.requiredCapabilities = [...(task.requiredCapabilities ?? []), "vision"];
  }
  const request: InvokeRequest = {
    task,
    messages,
    maxOutputTokens: raw.maxOutputTokens as number,
  };
  const system = optionalString(raw.system, "system");
  if (system !== undefined) request.system = system;

  if (raw.stopSequences !== undefined) {
    if (!Array.isArray(raw.stopSequences) || raw.stopSequences.some((entry) => typeof entry !== "string")) {
      throw new InvocationValidationError("stopSequences must be an array of strings");
    }
    request.stopSequences = raw.stopSequences as string[];
  }
  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools)) throw new InvocationValidationError("tools must be an array");
    request.tools = raw.tools.map(parseTool);
  }
  if (raw.toolChoice !== undefined) {
    if (raw.toolChoice === "auto" || raw.toolChoice === "none" || raw.toolChoice === "required") {
      request.toolChoice = raw.toolChoice;
    } else {
      const choice = record(raw.toolChoice, "toolChoice");
      rejectUnknown(choice, new Set(["name"]), "toolChoice");
      if (typeof choice.name !== "string" || choice.name.length === 0) {
        throw new InvocationValidationError("toolChoice.name must be a non-empty string");
      }
      request.toolChoice = { name: choice.name };
    }
  }
  if (raw.metadata !== undefined) {
    const metadata = record(raw.metadata, "metadata");
    request.metadata = {};
    for (const [key, entry] of Object.entries(metadata)) {
      if (typeof entry !== "string") throw new InvocationValidationError(`metadata.${key} must be a string`);
      request.metadata[key] = entry;
    }
  }
  if (protocol === "anthropic-messages") {
    if (hasImage) {
      throw new InvocationValidationError(
        "image_url is not supported by the Anthropic-compatible v1 profile",
      );
    }
  }
  return request;
}
