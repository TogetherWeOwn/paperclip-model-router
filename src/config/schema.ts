/**
 * `instanceConfigSchema` for the manifest.
 *
 * The Paperclip host validates a company's submitted config against this schema
 * with Ajv (draft-07 plus `ajv-formats`, and the host-registered `secret-ref`
 * format) before it is stored, so a bad tier table is rejected at write time
 * rather than at routing time.
 *
 * Config rows are keyed by (pluginId, companyId): one global install, one config
 * per company. See docs/OPERATIONS.md.
 */

import { MODEL_TIER_ORDER } from "../engine/types.js";

const TIERS = [...MODEL_TIER_ORDER];

const MODEL_CAPABILITIES = [
  "tools",
  "structured-output",
  "vision",
  "long-context",
  "computer-use",
];

export const ROUTER_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  properties: {
    routing: {
      type: "object",
      title: "Routing",
      additionalProperties: false,
      properties: {
        enabled: {
          type: "boolean",
          title: "Routing enabled",
          description:
            "Master switch. When false every decision returns `disabled` and the caller keeps whatever model it would have used.",
          default: true,
        },
        mode: {
          type: "string",
          title: "Mode",
          enum: ["advise", "enforce"],
          description:
            "`advise` records a decision and returns it. `enforce` additionally applies it where the host permits.",
          default: "advise",
        },
        fallbackModelId: {
          type: ["string", "null"],
          title: "Fallback model id",
          description:
            "Model used when no candidate survives the gates. Null means the router refuses rather than silently downgrading.",
          default: null,
        },
        stickyModelWithinIssue: {
          type: "boolean",
          title: "Keep one model per issue",
          description:
            "Reuse the model already used on an issue unless a gate forces a change. Switching mid-task destroys the prompt cache.",
          default: true,
        },
      },
    },

    providers: {
      type: "object",
      title: "Providers",
      additionalProperties: false,
      properties: {
        permitted: {
          type: "array",
          title: "Permitted providers",
          description:
            "Providers this company may be served by. Intersected with each model's own provider list; an empty intersection rejects the model.",
          items: { type: "string", minLength: 1 },
          default: [],
        },
        preferenceOrder: {
          type: "array",
          title: "Provider preference order",
          description: "Tie-break order among permitted providers. Earlier is preferred.",
          items: { type: "string", minLength: 1 },
          default: [],
        },
        claudePaygEnabled: {
          type: "boolean",
          title: "Claude pay-as-you-go enabled",
          description:
            "While false, Claude-family models may only resolve to `claudeFamilyProvider`. Leave false unless the owner has enabled PAYG.",
          default: false,
        },
        claudeFamilyProvider: {
          type: "string",
          title: "Claude provider",
          description:
            "The single provider Claude-family models are permitted to use while PAYG is disabled.",
          minLength: 1,
          default: "teamclaude",
        },
        claudeFamilies: {
          type: "array",
          title: "Claude family names",
          description:
            "Model families treated as Claude by the Claude block. Matched case-insensitively against `models[].family`.",
          items: { type: "string", minLength: 1 },
          default: ["claude"],
        },
      },
    },

    models: {
      type: "array",
      title: "Model tier table",
      description:
        "Every model this company may use, with the price this company actually pays. Paperclip names a model; OmniRoute resolves the provider.",
      default: [],
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "family", "tier", "quality", "costPerMTokIn", "costPerMTokOut", "contextWindow"],
        properties: {
          id: { type: "string", minLength: 1, title: "Model id" },
          family: { type: "string", minLength: 1, title: "Family" },
          tier: { type: "string", enum: TIERS, title: "Tier" },
          quality: { type: "number", minimum: 0, maximum: 100, title: "Quality score" },
          costPerMTokIn: { type: "number", minimum: 0, title: "USD per 1M input tokens" },
          costPerMTokOut: { type: "number", minimum: 0, title: "USD per 1M output tokens" },
          contextWindow: { type: "integer", minimum: 1, title: "Context window (tokens)" },
          capabilities: {
            type: "array",
            title: "Capabilities",
            items: { type: "string", enum: MODEL_CAPABILITIES },
            default: [],
          },
          providers: {
            type: "array",
            title: "Providers that may serve this model",
            items: { type: "string", minLength: 1 },
            default: [],
          },
          enabled: { type: "boolean", title: "Enabled", default: true },
        },
      },
    },

    taskClasses: {
      type: "array",
      title: "Task classes",
      description: "Quality floor, and optional tier ceiling and pin, per class of work.",
      default: [],
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "qualityFloor"],
        properties: {
          key: { type: "string", minLength: 1 },
          qualityFloor: { type: "number", minimum: 0, maximum: 100 },
          maxTier: { type: "string", enum: TIERS },
          requiredCapabilities: {
            type: "array",
            items: { type: "string", enum: MODEL_CAPABILITIES },
          },
          pinnedModelId: { type: "string", minLength: 1 },
        },
      },
    },

    tiering: {
      type: "object",
      title: "Tiering",
      additionalProperties: false,
      properties: {
        signalWeights: {
          type: "object",
          title: "Signal weights",
          description: "Task score is the weighted sum of the descriptor's signals.",
          additionalProperties: { type: "number" },
          default: {},
        },
        thresholds: {
          type: "object",
          title: "Tier thresholds",
          description: "Lowest score that reaches each tier. Evaluated highest tier first.",
          additionalProperties: false,
          properties: {
            small: { type: "number" },
            standard: { type: "number" },
            strong: { type: "number" },
            frontier: { type: "number" },
          },
        },
        defaultTier: {
          type: "string",
          enum: TIERS,
          title: "Default tier",
          description: "Tier used when a descriptor carries no signals.",
          default: "standard",
        },
      },
    },

    budget: {
      type: "object",
      title: "Budget thresholds",
      additionalProperties: false,
      properties: {
        monthlyCapUsd: { type: "number", minimum: 0, title: "Monthly cap (USD)", default: 0 },
        warnFraction: {
          type: "number",
          minimum: 0,
          maximum: 1,
          title: "Warn at fraction of cap",
          default: 0.6,
        },
        downshiftFraction: {
          type: "number",
          minimum: 0,
          maximum: 1,
          title: "Drop one tier at fraction of cap",
          default: 0.8,
        },
        haltFraction: {
          type: "number",
          minimum: 0,
          maximum: 1,
          title: "Refuse non-pinned model work at fraction of cap",
          default: 0.95,
        },
      },
    },

    quotaGate: {
      type: "object",
      title: "Claude quota gate",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: false, title: "Quota gate enabled" },
        statusUrl: {
          type: "string",
          title: "teamclaude status URL",
          description:
            "Full URL of the teamclaude status endpoint as reachable from the host. Do not assume loopback.",
          default: "",
        },
        // The shape is pinned here, not left to `format`, because `format` does
        // not validate anything. The host registers it as
        // `ajv.addFormat("secret-ref", { validate: () => true })` — a hint that
        // tells the UI to show a secret picker and tells the host's extractor
        // where to look — and JSON Schema `format` applies to strings in any
        // case. Left open, `{"apiKey": "sk-ant-..."}` validated, was not
        // recognised as a binding by the host's extractor, and was persisted
        // verbatim into the company's config row. `additionalProperties: false`
        // plus the `const` is what actually keeps a credential out. TOG-228.
        apiKeySecretRef: {
          type: ["object", "null"],
          title: "teamclaude API key",
          description:
            "Paperclip secret holding the teamclaude key. A reference, never a value — no credential is ever stored in this repo or in this config.",
          format: "secret-ref",
          additionalProperties: false,
          required: ["type", "secretId"],
          properties: {
            type: { const: "secret_ref" },
            secretId: { type: "string", format: "uuid" },
            version: { oneOf: [{ const: "latest" }, { type: "integer", minimum: 1 }] },
            projectionClass: { type: "string", minLength: 1 },
            projectionAllowlistKey: { type: ["string", "null"] },
          },
          default: null,
        },
        windows: {
          type: "array",
          title: "Utilization windows",
          description:
            "teamclaude status fields to read. Values are fractions in [0,1]; 1.0 means the window is exhausted.",
          items: { type: "string", minLength: 1 },
          default: ["unified5h", "unified7d"],
        },
        warnUtilization: { type: "number", minimum: 0, maximum: 1, default: 0.7 },
        downshiftUtilization: { type: "number", minimum: 0, maximum: 1, default: 0.85 },
        pauseUtilization: { type: "number", minimum: 0, maximum: 1, default: 0.95 },
      },
    },

    rule0: {
      type: "object",
      title: "Rule 0 — no model at all",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: true },
        deterministicPatterns: {
          type: "array",
          title: "Deterministic tooling patterns",
          description:
            "When a task summary matches, the router answers `no-model-needed` and names the tool that should answer instead.",
          default: [],
          items: {
            type: "object",
            additionalProperties: false,
            required: ["pattern", "tool"],
            properties: {
              pattern: { type: "string", minLength: 1, title: "Case-insensitive regular expression" },
              tool: { type: "string", minLength: 1, title: "Tool that answers instead" },
            },
          },
        },
      },
    },
  },
} as const;
