import { MODEL_TIER_ORDER } from "../engine/types.js";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
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
        pinBlocklist: {
          type: "array",
          title: "Pin blocklist",
          description:
            "Model ids that must never be honored as a pin, whatever the routing mode or capacity evidence (known-unserved / payment_required ids).",
          items: { type: "string", minLength: 1 },
          default: [],
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
          default: DEFAULT_REQUEST_TIMEOUT_MS,
          description:
            "Wall-clock budget for one upstream generation. The default stays 25s; raise it, or set models[].requestTimeoutMs, for reasoning models that think past it.",
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
      // TOG-7880 (gap G1): backstop only. Stock JSON Schema compares whole
      // elements exactly, so this refuses byte-identical rows but cannot
      // express per-id or case-insensitive uniqueness (and a custom keyword
      // would not survive host-side compilation). The real check is the
      // fail-closed duplicate-id refusal in resolveConfig + onValidateConfig.
      uniqueItems: true,
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
          requestTimeoutMs: {
            type: "integer",
            minimum: MIN_REQUEST_TIMEOUT_MS,
            maximum: MAX_REQUEST_TIMEOUT_MS,
            description:
              "Overrides upstream.requestTimeoutMs when this model is selected. Omit to inherit. Set it on reasoning models, which overrun a shared ceiling that suits the rest of the table.",
          },
          maxSyncOutputTokens: {
            type: "integer",
            minimum: 1,
            description:
              "Caps maxOutputTokens on the synchronous /invoke path only, rejecting unreachable requests in milliseconds. Omit to derive a default from this model's request timeout, its syncThroughputClass row, and a measured throughput baseline. model_router_invoke_async ignores this field.",
          },
          syncThroughputClass: {
            type: "string",
            enum: ["chat", "reasoning"],
            description:
              "Selects which throughput row the derived maxSyncOutputTokens default uses. Omit for the measured chat baseline (1200 tokens / 28s, TOG-1035). Set reasoning on models that spend wall-clock on hidden thinking tokens; their derived ceiling is half the chat row. An explicit maxSyncOutputTokens always wins over either row.",
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
    capacityRouting: {
      type: "object",
      title: "Usage-aware capacity routing",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: false },
        mode: { type: "string", enum: ["shadow", "enforce"], default: "shadow" },
        unknownTelemetry: {
          type: "string",
          enum: ["fail-open", "fail-closed", "exclude-lane"],
          default: "fail-open",
          description:
            "What ABSENT capacity evidence means in enforce mode. fail-open (default) never denies service for missing or unparseable telemetry: uncovered models rank last but stay selectable, and only evidence positively reporting 'unavailable' excludes a model. exclude-lane drops uncovered models and refuses only if none remain. fail-closed refuses the decision outright and can deny service during a telemetry outage.",
        },
        conserveUtilization: { type: "number", minimum: 0, maximum: 1, default: 0.6 },
        avoidUtilization: { type: "number", minimum: 0, maximum: 1, default: 0.8 },
        maxSnapshotAgeMs: { type: "integer", minimum: 1000, maximum: 86400000, default: 300000 },
        paceOrdering: {
          type: "boolean",
          default: false,
          description:
            "TOG-2139: order eligible candidates by subscription pace (furthest behind its governing-window pace line first, deviation next, then existing evidence order). Survivor-pool ordering only — pace never reorders across qualityFloor, capability, context-window, or tier gates and adds no rejection stage.",
        },
        pacePolicy: {
          type: "object",
          additionalProperties: false,
          properties: {
            margin: { type: "number", minimum: 0, maximum: 1 },
            urgentResetSeconds: { type: "integer", minimum: 1 },
            maxSnapshotAgeSeconds: { type: "integer", minimum: 1 },
          },
        },
        sources: {
          type: "array",
          default: [],
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "statusUrl", "modelIds", "windows"],
            properties: {
              id: { type: "string", minLength: 1 },
              statusUrl: {
                type: "string",
                format: "uri",
                pattern: "^https://[^/?#@]+(?:/[^?#]*)?$",
                not: { pattern: "^https://(?:localhost|127(?:\\.[0-9]{1,3}){3}|0(?:\\.[0-9]{1,3}){3}|10(?:\\.[0-9]{1,3}){3}|192\\.168(?:\\.[0-9]{1,3}){2}|172\\.(?:1[6-9]|2[0-9]|3[01])(?:\\.[0-9]{1,3}){2})(?::[0-9]+)?(?:/|$)" },
              },
              apiKeySecretRef: SECRET_REF_SCHEMA,
              modelIds: {
                type: "array",
                minItems: 1,
                items: { type: "string", minLength: 1 },
                description: "Opaque model ids whose selection this source may inform.",
              },
              requestTimeoutMs: {
                type: "integer",
                minimum: 1000,
                maximum: 25000,
                default: 5000,
              },
              maxResponseBytes: {
                type: "integer",
                minimum: 1024,
                maximum: 16777216,
                default: 262144,
              },
              healthFields: {
                type: "array",
                items: { type: "string", minLength: 1 },
                default: ["health", "status", "unifiedStatus"],
              },
              modelIdentityFields: {
                type: "array",
                items: { type: "string", minLength: 1 },
                description:
                  "TOG-7163: fields carrying the model identity on a per-model quota group inside one payload record. When set, a grouped record projects onto exactly the model it names; records naming another model are that model's evidence, not absent telemetry. Absent = legacy fan-out.",
              },
              windows: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["name", "utilizationFields"],
                  properties: {
                    name: { type: "string", minLength: 1 },
                    utilizationFields: {
                      type: "array",
                      minItems: 1,
                      items: { type: "string", minLength: 1 },
                    },
                    resetFields: {
                      type: "array",
                      items: { type: "string", minLength: 1 },
                      default: [],
                    },
                  },
                },
              },
              pace: {
                type: "object",
                additionalProperties: false,
                required: ["laneId"],
                description:
                  "Lane-document shape for pace evaluation (TOG-1916 §2). A health-only lane may use an empty windows array and remains pace-neutral until utilization telemetry appears. Absent = pace-neutral source.",
                properties: {
                  laneId: { type: "string", minLength: 1 },
                  free: { type: "boolean", default: false },
                  weightFields: { type: "array", items: { type: "string", minLength: 1 } },
                  healthFields: { type: "array", items: { type: "string", minLength: 1 } },
                  governingWindowField: { type: "string", minLength: 1 },
                  windowSecondsField: { type: "string", minLength: 1 },
                  staleAfterSecondsField: { type: "string", minLength: 1 },
                  windows: {
                    type: "array",
                    default: [],
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["name", "role", "utilizationFields"],
                      properties: {
                        name: { type: "string", minLength: 1 },
                        role: { type: "string", enum: ["serviceability", "allowance"] },
                        utilizationFields: {
                          type: "array",
                          minItems: 1,
                          items: { type: "string", minLength: 1 },
                        },
                        resetFields: { type: "array", items: { type: "string", minLength: 1 } },
                        defaultWindowSeconds: { type: "integer", minimum: 1 },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    decisionLog: {
      type: "object",
      title: "Decision history retention",
      additionalProperties: false,
      properties: {
        retentionDays: {
          type: "integer",
          minimum: 1,
          maximum: 3650,
          default: 90,
          description:
            "TOG-7897: how long a company's routing decision rows are kept, in days. Bounds both the prune sweep and the query-decisions read path.",
        },
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
