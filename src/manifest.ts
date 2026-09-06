import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

import { ROUTER_CONFIG_SCHEMA } from "./config/schema.js";
import {
  PLUGIN_API_VERSION,
  PLUGIN_ID,
  PLUGIN_VERSION,
  ROUTE_KEYS,
  TOOL_NAMES,
} from "./constants.js";

const INVOKE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["task", "messages", "maxOutputTokens"],
  properties: {
    task: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskClass: { type: "string" },
        summary: { type: "string" },
        issueId: { type: "string" },
        requiredCapabilities: {
          type: "array",
          items: {
            type: "string",
            enum: ["tools", "structured-output", "vision", "long-context", "computer-use"],
          },
        },
        requiredContextTokens: { type: "integer", minimum: 1 },
        signals: { type: "object", additionalProperties: { type: "number" } },
        pinnedModelId: { type: "string" },
        pinReason: { type: "string" },
        estimatedInputTokens: { type: "integer", minimum: 1 },
        estimatedOutputTokens: { type: "integer", minimum: 1 },
      },
    },
    messages: { type: "array", minItems: 1, items: { type: "object" } },
    system: { type: "string" },
    maxOutputTokens: { type: "integer", minimum: 1 },
    stopSequences: { type: "array", items: { type: "string" } },
    tools: { type: "array", items: { type: "object" } },
    toolChoice: {
      oneOf: [
        { type: "string", enum: ["auto", "none", "required"] },
        { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string" } } },
      ],
    },
    metadata: { type: "object", additionalProperties: { type: "string" } },
  },
} as const;

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: PLUGIN_API_VERSION,
  version: PLUGIN_VERSION,
  displayName: "Model Router",
  description:
    "Selects an eligible model, invokes a company-configured OpenAI-compatible or Anthropic-compatible upstream, and returns one normalized result.",
  author: "TogetherWeOwn",
  categories: ["automation"],
  capabilities: [
    "plugin.state.read",
    "plugin.state.write",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "http.outbound",
    "secrets.read-ref",
    "metrics.write",
    "agent.tools.register",
    "api.routes.register",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  database: {
    namespaceSlug: "model_router",
    migrationsDir: "migrations",
    coreReadTables: [],
  },
  instanceConfigSchema: ROUTER_CONFIG_SCHEMA as unknown as Record<string, unknown>,
  tools: [
    {
      name: TOOL_NAMES.invoke,
      displayName: "Invoke a routed model",
      description:
        "Select a model under this company's routing policy, invoke its compatible upstream once, and return a normalized response.",
      parametersSchema: INVOKE_SCHEMA as unknown as Record<string, unknown>,
    },
  ],
  apiRoutes: [
    {
      routeKey: ROUTE_KEYS.invoke,
      method: "POST",
      path: "/invoke",
      auth: "board-or-agent",
      capability: "api.routes.register",
      checkoutPolicy: "none",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: ROUTE_KEYS.invokeIssue,
      method: "POST",
      path: "/issues/:issueId/invoke",
      auth: "board-or-agent",
      capability: "api.routes.register",
      checkoutPolicy: "none",
      companyResolution: { from: "issue", param: "issueId" },
    },
  ],
};

export default manifest;
