import type { ModelEntry } from "../engine/types.js";
import type {
  BudgetConfig,
  CapacityRoutingConfig,
  CompatibleUpstreamConfig,
  RouterConfig,
  RoutingConfig,
  Rule0Config,
  TaskClassConfig,
  TieringConfig,
} from "./types.js";

export const DEFAULT_ROUTING: RoutingConfig = {
  enabled: true,
  mode: "advise",
  fallbackModelId: null,
  stickyModelWithinIssue: true,
  maxOutputTokens: 16_384,
};

export const DEFAULT_UPSTREAM: CompatibleUpstreamConfig = {
  protocol: "openai-chat-completions",
  baseUrl: "https://example.invalid",
  credentialSecretRef: null,
  requestTimeoutMs: 25_000,
  maxResponseBytes: 8_388_608,
  extraHeaders: {},
};

export const DEFAULT_TIERING: TieringConfig = {
  signalWeights: {},
  thresholds: { small: 0, standard: 30, strong: 60, frontier: 85 },
  defaultTier: "standard",
};

export const DEFAULT_BUDGET: BudgetConfig = {
  monthlyCapUsd: 0,
  warnFraction: 0.6,
  downshiftFraction: 0.8,
  haltFraction: 0.95,
};

export const DEFAULT_CAPACITY_ROUTING: CapacityRoutingConfig = {
  enabled: false,
  mode: "shadow",
  unknownTelemetry: "fail-closed",
  conserveUtilization: 0.6,
  avoidUtilization: 0.8,
  sources: [],
};

export const DEFAULT_RULE0: Rule0Config = {
  enabled: true,
  deterministicPatterns: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function pickStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function resolveModels(value: unknown): ModelEntry[] {
  if (!Array.isArray(value)) return [];
  const models: ModelEntry[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const id = pickString(raw.id, "");
    if (!id) continue;
    models.push({
      id,
      tier: pickString(raw.tier, "standard") as ModelEntry["tier"],
      quality: pickNumber(raw.quality, 0),
      costPerMTokIn: pickNumber(raw.costPerMTokIn, 0),
      costPerMTokOut: pickNumber(raw.costPerMTokOut, 0),
      contextWindow: pickNumber(raw.contextWindow, 0),
      capabilities: pickStringArray(raw.capabilities, []) as ModelEntry["capabilities"],
      providers: pickStringArray(raw.providers, []),
      enabled: pickBoolean(raw.enabled, true),
    });
  }
  return models;
}

function resolveTaskClasses(value: unknown): TaskClassConfig[] {
  if (!Array.isArray(value)) return [];
  const classes: TaskClassConfig[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const key = pickString(raw.key, "");
    if (!key) continue;
    const entry: TaskClassConfig = {
      key,
      qualityFloor: pickNumber(raw.qualityFloor, 0),
    };
    if (typeof raw.maxTier === "string") entry.maxTier = raw.maxTier as TaskClassConfig["maxTier"];
    const required = pickStringArray(raw.requiredCapabilities, []);
    if (required.length > 0) entry.requiredCapabilities = required;
    if (typeof raw.pinnedModelId === "string" && raw.pinnedModelId.length > 0) {
      entry.pinnedModelId = raw.pinnedModelId;
    }
    classes.push(entry);
  }
  return classes;
}

function resolveCapacitySources(value: unknown): CapacityRoutingConfig["sources"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const id = pickString(raw.id, "");
    const statusUrl = pickString(raw.statusUrl, "");
    if (!id || !statusUrl) return [];
    const windows = Array.isArray(raw.windows)
      ? raw.windows.flatMap((entry) => {
          if (!isRecord(entry)) return [];
          const name = pickString(entry.name, "");
          const utilizationFields = pickStringArray(entry.utilizationFields, []);
          if (!name || utilizationFields.length === 0) return [];
          return [{
            name,
            utilizationFields,
            resetFields: pickStringArray(entry.resetFields, []),
          }];
        })
      : [];
    return [{
      id,
      statusUrl,
      apiKeySecretRef: isRecord(raw.apiKeySecretRef)
        ? (raw.apiKeySecretRef as unknown as CapacityRoutingConfig["sources"][number]["apiKeySecretRef"])
        : null,
      providers: pickStringArray(raw.providers, []),
      accountIdFields: pickStringArray(raw.accountIdFields, ["account", "accountId", "id", "email"]),
      healthFields: pickStringArray(raw.healthFields, ["health", "status", "unifiedStatus"]),
      windows,
    }];
  });
}

function resolveRule0(value: unknown): Rule0Config {
  if (!isRecord(value)) return { ...DEFAULT_RULE0, deterministicPatterns: [] };
  const patterns: Rule0Config["deterministicPatterns"] = [];
  if (Array.isArray(value.deterministicPatterns)) {
    for (const raw of value.deterministicPatterns) {
      if (!isRecord(raw)) continue;
      const pattern = pickString(raw.pattern, "");
      const tool = pickString(raw.tool, "");
      if (pattern && tool) patterns.push({ pattern, tool });
    }
  }
  return {
    enabled: pickBoolean(value.enabled, DEFAULT_RULE0.enabled),
    deterministicPatterns: patterns,
  };
}

export function resolveConfig(raw: unknown): RouterConfig {
  const source = isRecord(raw) ? raw : {};
  const routingRaw = isRecord(source.routing) ? source.routing : {};
  const upstreamRaw = isRecord(source.upstream) ? source.upstream : {};
  const tieringRaw = isRecord(source.tiering) ? source.tiering : {};
  const thresholdsRaw = isRecord(tieringRaw.thresholds) ? tieringRaw.thresholds : {};
  const budgetRaw = isRecord(source.budget) ? source.budget : {};
  const capacityRaw = isRecord(source.capacityRouting) ? source.capacityRouting : {};

  const signalWeights: Record<string, number> = {};
  if (isRecord(tieringRaw.signalWeights)) {
    for (const [key, weight] of Object.entries(tieringRaw.signalWeights)) {
      if (typeof weight === "number" && Number.isFinite(weight)) signalWeights[key] = weight;
    }
  }

  const extraHeaders: Record<string, string> = {};
  if (isRecord(upstreamRaw.extraHeaders)) {
    for (const [name, value] of Object.entries(upstreamRaw.extraHeaders)) {
      if (typeof value === "string") extraHeaders[name] = value;
    }
  }

  return {
    routing: {
      enabled: pickBoolean(routingRaw.enabled, DEFAULT_ROUTING.enabled),
      mode: routingRaw.mode === "enforce" ? "enforce" : "advise",
      fallbackModelId:
        typeof routingRaw.fallbackModelId === "string" && routingRaw.fallbackModelId.length > 0
          ? routingRaw.fallbackModelId
          : null,
      stickyModelWithinIssue: pickBoolean(
        routingRaw.stickyModelWithinIssue,
        DEFAULT_ROUTING.stickyModelWithinIssue,
      ),
      maxOutputTokens: pickNumber(routingRaw.maxOutputTokens, DEFAULT_ROUTING.maxOutputTokens),
    },
    upstream: {
      protocol:
        upstreamRaw.protocol === "openai-chat-completions" || upstreamRaw.protocol === "anthropic-messages"
          ? upstreamRaw.protocol
          : null,
      baseUrl: pickString(upstreamRaw.baseUrl, DEFAULT_UPSTREAM.baseUrl),
      credentialSecretRef: isRecord(upstreamRaw.credentialSecretRef)
        ? (upstreamRaw.credentialSecretRef as unknown as CompatibleUpstreamConfig["credentialSecretRef"])
        : null,
      requestTimeoutMs: pickNumber(
        upstreamRaw.requestTimeoutMs,
        DEFAULT_UPSTREAM.requestTimeoutMs,
      ),
      maxResponseBytes: pickNumber(
        upstreamRaw.maxResponseBytes,
        DEFAULT_UPSTREAM.maxResponseBytes,
      ),
      extraHeaders,
    },
    models: resolveModels(source.models),
    taskClasses: resolveTaskClasses(source.taskClasses),
    tiering: {
      signalWeights,
      thresholds: {
        small: pickNumber(thresholdsRaw.small, DEFAULT_TIERING.thresholds.small),
        standard: pickNumber(thresholdsRaw.standard, DEFAULT_TIERING.thresholds.standard),
        strong: pickNumber(thresholdsRaw.strong, DEFAULT_TIERING.thresholds.strong),
        frontier: pickNumber(thresholdsRaw.frontier, DEFAULT_TIERING.thresholds.frontier),
      },
      defaultTier: pickString(
        tieringRaw.defaultTier,
        DEFAULT_TIERING.defaultTier,
      ) as TieringConfig["defaultTier"],
    },
    budget: {
      monthlyCapUsd: pickNumber(budgetRaw.monthlyCapUsd, DEFAULT_BUDGET.monthlyCapUsd),
      warnFraction: pickNumber(budgetRaw.warnFraction, DEFAULT_BUDGET.warnFraction),
      downshiftFraction: pickNumber(budgetRaw.downshiftFraction, DEFAULT_BUDGET.downshiftFraction),
      haltFraction: pickNumber(budgetRaw.haltFraction, DEFAULT_BUDGET.haltFraction),
    },
    capacityRouting: {
      enabled: pickBoolean(capacityRaw.enabled, DEFAULT_CAPACITY_ROUTING.enabled),
      mode: capacityRaw.mode === "enforce" ? "enforce" : "shadow",
      unknownTelemetry: capacityRaw.unknownTelemetry === "exclude-lane" ? "exclude-lane" : "fail-closed",
      conserveUtilization: pickNumber(capacityRaw.conserveUtilization, DEFAULT_CAPACITY_ROUTING.conserveUtilization),
      avoidUtilization: pickNumber(capacityRaw.avoidUtilization, DEFAULT_CAPACITY_ROUTING.avoidUtilization),
      sources: resolveCapacitySources(capacityRaw.sources),
    },
    rule0: resolveRule0(source.rule0),
  };
}
