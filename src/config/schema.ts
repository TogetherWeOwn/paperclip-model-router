import { MODEL_TIER_ORDER } from "../engine/types.js";
import {
  FORBIDDEN_EXTRA_HEADER_NAMES,
  MAX_REQUEST_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  MIN_REQUEST_TIMEOUT_MS,
  MIN_RESPONSE_BYTES,
} from "./upstream-constraints.js";

const TIERS = [...MODEL_TIER_ORDER];
const MODEL_CAPABILITIES = [
  "tools",
  "structured-output",
  "vision",
  "long-context",
  "computer-use",
];

const SECRET_REF_SCHEMA = {
  type: ["object", "null"],
  format: "secret-ref",
  additionalProperties: false,
  required: ["type", "secretId"],
  properties: {
    type: { const: "secret_ref" },
    secretId: { type: "string", format: "uuid" },
    version: { oneOf: [{ const: "latest" }, { type: "integer", minimum: 1 }] },
    projectionClass: { type: "string", enum: ["unclassified", "class_3_static_lease"] },
    projectionAllowlistKey: { type: ["string", "null"] },
  },
  default: null,
} as const;

function anyCase(value: string): string {
  return value.replace(/[a-z]/g, (character) => `[${character}${character.toUpperCase()}]`);
}

const FORBIDDEN_HEADER_PATTERN = `^(?:${FORBIDDEN_EXTRA_HEADER_NAMES.map(anyCase).join("|")})$`;

export const ROUTER_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  required: ["upstream"],
  properties: {
    routing: {
      type: "object",
      title: "Routing",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: true },
        mode: { type: "string", enum: ["advise", "enforce"], default: "advise" },
        fallbackModelId: { type: ["string", "null"], default: null },
        stickyModelWithinIssue: { type: "boolean", default: true },
        maxOutputTokens: {
          type: "integer",
          minimum: 1,
          maximum: 128000,
          default: 16384,
        },
      },
    },
    upstream: {
      type: "object",
      title: "Compatible upstream",
      additionalProperties: false,
      required: ["protocol", "baseUrl", "credentialSecretRef"],
      properties: {
        protocol: {
          type: "string",
          enum: ["openai-chat-completions", "anthropic-messages"],
        },
        baseUrl: {
          type: "string",
          format: "uri",
          pattern: "^https://[^/?#@]+(?:/[^?#]*)?$",
          description: "Absolute HTTPS base URL. The adapter appends its fixed v1 protocol path.",
        },
        credentialSecretRef: {
          ...SECRET_REF_SCHEMA,
          type: "object",
          default: undefined,
        },
        requestTimeoutMs: {
          type: "integer",
          minimum: MIN_REQUEST_TIMEOUT_MS,
          maximum: MAX_REQUEST_TIMEOUT_MS,
          default: MAX_REQUEST_TIMEOUT_MS,
        },
        maxResponseBytes: {
          type: "integer",
          minimum: MIN_RESPONSE_BYTES,
          maximum: MAX_RESPONSE_BYTES,
          default: 8388608,
        },
        extraHeaders: {
          type: "object",
          default: {},
          propertyNames: { not: { pattern: FORBIDDEN_HEADER_PATTERN } },
          additionalProperties: { type: "string", pattern: "^[^\\r\\n]*$" },
        },
      },
    },
    models: {
      type: "array",
      default: [],
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "tier", "quality", "costPerMTokIn", "costPerMTokOut", "contextWindow"],
        properties: {
          id: { type: "string", minLength: 1 },
          tier: { type: "string", enum: TIERS },
          quality: { type: "number", minimum: 0, maximum: 100 },
          costPerMTokIn: { type: "number", minimum: 0 },
          costPerMTokOut: { type: "number", minimum: 0 },
          contextWindow: { type: "integer", minimum: 1 },
          capabilities: {
            type: "array",
            items: { type: "string", enum: MODEL_CAPABILITIES },
            default: [],
          },
          enabled: { type: "boolean", default: true },
        },
      },
    },
    taskClasses: {
      type: "array",
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
      additionalProperties: false,
      properties: {
        signalWeights: { type: "object", additionalProperties: { type: "number" }, default: {} },
        thresholds: {
          type: "object",
          additionalProperties: false,
          properties: {
            small: { type: "number" },
            standard: { type: "number" },
            strong: { type: "number" },
            frontier: { type: "number" },
          },
        },
        defaultTier: { type: "string", enum: TIERS, default: "standard" },
      },
    },
    budget: {
      type: "object",
      additionalProperties: false,
      properties: {
        monthlyCapUsd: { type: "number", minimum: 0, default: 0 },
        warnFraction: { type: "number", minimum: 0, maximum: 1, default: 0.6 },
        downshiftFraction: { type: "number", minimum: 0, maximum: 1, default: 0.8 },
        haltFraction: { type: "number", minimum: 0, maximum: 1, default: 0.95 },
      },
    },
    rule0: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: true },
        deterministicPatterns: {
          type: "array",
          default: [],
          items: {
            type: "object",
            additionalProperties: false,
            required: ["pattern", "tool"],
            properties: {
              pattern: { type: "string", minLength: 1 },
              tool: { type: "string", minLength: 1 },
            },
          },
        },
      },
    },
  },
} as const;
