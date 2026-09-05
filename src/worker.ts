import { randomUUID } from "node:crypto";

import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, ToolResult } from "@paperclipai/plugin-sdk";

import { readCapacitySource, type CapacityHttpClient } from "./capacity/read.js";
import type { CapacityEvidence, CapacitySnapshot } from "./capacity/types.js";
import { resolveConfig } from "./config/resolve.js";
import { validateSecretRefShape } from "./config/secret-ref.js";
import { isReservedLiteralHost } from "./config/upstream-constraints.js";
import type { RouterConfig } from "./config/types.js";
import {
  ACTION_KEYS,
  DECISION_LOG_LIMIT,
  PLUGIN_VERSION,
  ROUTE_KEYS,
  STATE_KEYS,
  TOOL_NAMES,
} from "./constants.js";
import { selectModel } from "./engine/select.js";
import type { RoutingDecision } from "./engine/types.js";
import { validateUpstreamConfig } from "./inference/adapters.js";
import { invokeCompatibleUpstream } from "./inference/transport.js";
import type { InferenceResult, InvokeRequest } from "./inference/types.js";
import { InvocationValidationError, parseInvokeRequest } from "./inference/validate.js";

interface DecisionRecord {
  at: string;
  requestId: string;
  runId: string | null;
  issueId: string | null;
  taskClass: string | null;
  selectionOutcome: RoutingDecision["outcome"] | null;
  modelId: string | null;
  fallbackUsed: boolean;
  upstreamProtocol: RouterConfig["upstream"]["protocol"] | null;
  outcome: InferenceResult["outcome"];
  errorCode: string | null;
  upstreamStatus: number | null;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  upstreamRequestId: string | null;
  capacityMode: RoutingDecision["capacity"]["mode"] | null;
  capacityTelemetry: RoutingDecision["capacity"]["telemetry"] | null;
  capacityLane: string | null;
  capacityLaneLabel: string | null;
  capacityPosture: RoutingDecision["capacity"]["usagePosture"] | null;
  capacityReason: string | null;
  shadowModelId: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function capacityHttp(ctx: PluginContext): CapacityHttpClient {
  return {
    async request({ url, method, headers, redirect, timeoutMs, maxResponseBytes }) {
      const pending = ctx.http.fetch(url, { method, headers, redirect });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const response = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("capacity request timeout")), timeoutMs);
        }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      const text = await response.text();
      const responseBytes = new TextEncoder().encode(text).byteLength;
      let body: unknown = null;
      if (responseBytes <= maxResponseBytes) {
        try { body = JSON.parse(text); } catch { body = null; }
      }
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        body,
        responseBytes,
        redirected: response.redirected || (response.status >= 300 && response.status < 400),
      };
    },
  };
}

function summary(result: InferenceResult): string {
  if (result.outcome === "completed") {
    return `Model ${result.response.modelId} completed with stop reason ${result.response.stopReason}.`;
  }
  if (result.outcome === "error") return `Model Router invocation failed: ${result.error.code}.`;
  if (result.outcome === "no-model-needed") return "Rule 0 matched; no model request was made.";
  if (result.outcome === "disabled") return "Model Router is disabled for this company.";
  return "No eligible model was available for this invocation.";
}

export function createPlugin() {
  let context: PluginContext | null = null;
  let invoke: ((companyId: string, raw: unknown, runId?: string | null) => Promise<InferenceResult>) | null = null;

  return definePlugin({
    multiCompanyConfig: true,

    async setup(ctx) {
      context = ctx;
      const companyConfig = async (companyId: string): Promise<RouterConfig> =>
        resolveConfig(await ctx.config.get(companyId));

      const stickyKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: STATE_KEYS.issueStickiness,
      });

      const readStickyModel = async (companyId: string, issueId: string | undefined) => {
        if (!issueId) return undefined;
        const map = asRecord(await ctx.state.get(stickyKey(companyId)));
        return typeof map[issueId] === "string" ? (map[issueId] as string) : undefined;
      };

      const writeStickyModel = async (
        companyId: string,
        issueId: string | undefined,
        modelId: string | null,
      ): Promise<void> => {
        if (!issueId || !modelId) return;
        const map = asRecord(await ctx.state.get(stickyKey(companyId)));
        if (map[issueId] === modelId) return;
        map[issueId] = modelId;
        await ctx.state.set(stickyKey(companyId), map);
      };

      const capacityStateKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: STATE_KEYS.capacitySnapshot,
      });

      const storedCapacity = async (
        companyId: string,
        config: RouterConfig,
      ): Promise<{ snapshots: CapacitySnapshot[]; evidence: CapacityEvidence[]; error: string | null }> => {
        const stored = asRecord(await ctx.state.get(capacityStateKey(companyId)));
        const refreshedAt = typeof stored.refreshedAt === "string" ? Date.parse(stored.refreshedAt) : Number.NaN;
        const lastRefreshError = typeof stored.lastRefreshError === "string" ? stored.lastRefreshError : null;
        const stale = !Number.isFinite(refreshedAt) || Date.now() - refreshedAt > config.capacityRouting.maxSnapshotAgeMs;
        return {
          snapshots: Array.isArray(stored.snapshots) ? stored.snapshots as CapacitySnapshot[] : [],
          evidence: Array.isArray(stored.evidence) ? stored.evidence as CapacityEvidence[] : [],
          error: lastRefreshError ?? (stale ? "capacity-snapshot-stale" : null),
        };
      };

      const refreshCapacity = async (
        companyId: string,
        config: RouterConfig,
      ): Promise<{ snapshots: CapacitySnapshot[]; evidence: CapacityEvidence[]; error: string | null }> => {
        if (!config.capacityRouting.enabled) return { snapshots: [], evidence: [], error: null };
        const snapshots: CapacitySnapshot[] = [];
        for (let index = 0; index < config.capacityRouting.sources.length; index += 1) {
          const source = config.capacityRouting.sources[index]!;
          let apiKey: string | null = null;
          if (source.apiKeySecretRef) {
            try {
              apiKey = await ctx.secrets.resolve(source.apiKeySecretRef as never, {
                companyId,
                configPath: `capacityRouting.sources.${index}.apiKeySecretRef`,
              });
            } catch {
              snapshots.push({ fetchedAt: new Date().toISOString(), source: source.id, evidence: [], error: "capacity-secret-unavailable" });
              continue;
            }
          }
          snapshots.push(await readCapacitySource({ source, http: capacityHttp(ctx), apiKey, now: () => new Date().toISOString() }));
        }
        const evidence = snapshots.flatMap((snapshot) => snapshot.evidence);
        const snapshotErrors = snapshots.map((snapshot) => snapshot.error).filter((value): value is string => Boolean(value));
        const malformedEvidence = evidence.some((entry) =>
          !entry.telemetryAvailable || entry.health === "unknown" || entry.posture === "unknown"
        );
        const incompleteModelIds = config.capacityRouting.sources.flatMap((source) =>
          source.modelIds.filter((modelId) => !evidence.some((entry) => entry.modelId === modelId))
        );
        const result = {
          snapshots,
          evidence,
          error: snapshotErrors.join("; ") || (malformedEvidence || incompleteModelIds.length > 0 ? "capacity-refresh-incomplete" : null),
        };
        const key = capacityStateKey(companyId);
        const previous = asRecord(await ctx.state.get(key));
        if (!result.error && result.evidence.length > 0) {
          await ctx.state.set(key, { ...result, refreshedAt: new Date().toISOString(), lastRefreshError: null });
        } else {
          await ctx.state.set(key, {
            ...previous,
            lastRefreshAttemptAt: new Date().toISOString(),
            lastRefreshError: result.error ?? "capacity-refresh-empty",
          });
        }
        return result;
      };

      const record = async (
        companyId: string,
        runId: string | null,
        request: InvokeRequest | null,
        result: InferenceResult,
        latencyMs: number,
      ) => {
        const decision = result.decision;
        const key = {
          scopeKind: "company" as const,
          scopeId: companyId,
          stateKey: STATE_KEYS.decisionLog,
        };
        const current = await ctx.state.get(key);
        const log: DecisionRecord[] = Array.isArray(current) ? (current as DecisionRecord[]) : [];
        const response = result.outcome === "completed" ? result.response : null;
        const failure = result.outcome === "error" ? result.error : null;
        log.unshift({
          at: new Date().toISOString(),
          requestId: result.requestId,
          runId,
          issueId: request?.task.issueId ?? null,
          taskClass: decision?.taskClass ?? null,
          selectionOutcome: decision?.outcome ?? null,
          modelId: decision?.modelId ?? null,
          fallbackUsed: decision?.fallbackUsed ?? false,
          upstreamProtocol: response?.upstream.protocol ?? (decision?.outcome === "selected" ? (await companyConfig(companyId)).upstream.protocol : null),
          outcome: result.outcome,
          errorCode: failure?.code ?? null,
          upstreamStatus: failure?.upstreamStatus ?? null,
          latencyMs: Math.max(0, Math.min(Math.round(latencyMs), 60_000)),
          inputTokens: response?.usage.inputTokens ?? null,
          outputTokens: response?.usage.outputTokens ?? null,
          upstreamRequestId: response?.upstream.requestId ?? failure?.upstreamRequestId ?? null,
          capacityMode: decision?.capacity.mode ?? null,
          capacityTelemetry: decision?.capacity.telemetry ?? null,
          capacityLane: decision?.capacity.selectedSource ?? null,
          capacityLaneLabel: decision?.capacity.selectedLaneLabel ?? null,
          capacityPosture: decision?.capacity.usagePosture ?? null,
          capacityReason: decision?.capacity.decisionReason ?? null,
          shadowModelId: decision?.capacity.shadowModelId ?? null,
        });
        await ctx.state.set(key, log.slice(0, DECISION_LOG_LIMIT));
        await ctx.metrics.write(`model_router.invoke.${result.outcome}`, 1);
      };

      const invokeFor = async (
        companyId: string,
        raw: unknown,
        runId: string | null = null,
      ): Promise<InferenceResult> => {
        const requestId = randomUUID();
        const startedAt = Date.now();
        let request: InvokeRequest | null = null;
        let result: InferenceResult;
        const config = await companyConfig(companyId);
        const upstreamErrors = validateUpstreamConfig(config.upstream);
        const secretRefError = validateSecretRefShape(
          config.upstream.credentialSecretRef,
          "upstream.credentialSecretRef",
        );
        if (upstreamErrors.length > 0 || secretRefError) {
          result = {
            outcome: "error",
            requestId,
            decision: null,
            response: null,
            error: {
              code: upstreamErrors.length > 0 ? "upstream-url-rejected" : "secret-unavailable",
              message: upstreamErrors.length > 0
                ? "The configured compatible upstream is invalid."
                : "The compatible upstream credential reference is invalid.",
              retryable: false,
              upstreamStatus: null,
              upstreamRequestId: null,
            },
          };
          await record(companyId, runId, request, result, Date.now() - startedAt);
          return result;
        }
        try {
          const protocol = config.upstream.protocol;
          if (protocol !== "openai-chat-completions" && protocol !== "anthropic-messages") {
            throw new Error("unsupported compatible upstream protocol");
          }
          request = parseInvokeRequest(
            raw,
            config.routing.maxOutputTokens,
            protocol,
          );
        } catch (failure) {
          result = {
            outcome: "error",
            requestId,
            decision: null,
            response: null,
            error: {
              code: "invalid-request",
              message: failure instanceof InvocationValidationError
                ? failure.message.slice(0, 512)
                : "The invocation request is invalid.",
              retryable: false,
              upstreamStatus: null,
              upstreamRequestId: null,
            },
          };
          await record(companyId, runId, request, result, Date.now() - startedAt);
          return result;
        }

        const capacity = config.capacityRouting.enabled
          ? await storedCapacity(companyId, config)
          : { snapshots: [], evidence: [], error: null };
        const decision = selectModel({
          descriptor: request.task,
          config,
          signals: {
            budgetSpentFraction: request.task.signals?.budgetSpentFraction,
            capacityEvidence: capacity.evidence,
            capacityError: capacity.error ?? undefined,
            stickyModelId: config.routing.stickyModelWithinIssue
              ? await readStickyModel(companyId, request.task.issueId)
              : undefined,
          },
        });

        if (decision.outcome !== "selected" || !decision.modelId) {
          const outcome = decision.outcome === "selected" ? "no-eligible-model" : decision.outcome;
          result = {
            outcome,
            requestId,
            decision,
            response: null,
            error: null,
          };
          await record(companyId, runId, request, result, Date.now() - startedAt);
          return result;
        }

        await writeStickyModel(companyId, request.task.issueId, decision.modelId);
        if (!config.upstream.credentialSecretRef) {
          result = {
            outcome: "error",
            requestId,
            decision,
            response: null,
            error: {
              code: "secret-unavailable",
              message: "The compatible upstream credential is not configured.",
              retryable: false,
              upstreamStatus: null,
              upstreamRequestId: null,
            },
          };
          await record(companyId, runId, request, result, Date.now() - startedAt);
          return result;
        }

        let credential: string;
        try {
          credential = await ctx.secrets.resolve(config.upstream.credentialSecretRef as never, {
            companyId,
            configPath: "upstream.credentialSecretRef",
          });
        } catch {
          result = {
            outcome: "error",
            requestId,
            decision,
            response: null,
            error: {
              code: "secret-unavailable",
              message: "The compatible upstream credential could not be resolved.",
              retryable: false,
              upstreamStatus: null,
              upstreamRequestId: null,
            },
          };
          await record(companyId, runId, request, result, Date.now() - startedAt);
          return result;
        }

        const transport = await invokeCompatibleUpstream({
          http: ctx.http,
          config: config.upstream,
          credential,
          request,
          modelId: decision.modelId,
        });
        result = transport.error
          ? { outcome: "error", requestId, decision, response: null, error: transport.error }
          : { outcome: "completed", requestId, decision, response: transport.response, error: null };
        await record(companyId, runId, request, result, Date.now() - startedAt);
        return result;
      };
      invoke = invokeFor;

      ctx.tools.register(
        TOOL_NAMES.invoke,
        {
          displayName: "Invoke a routed model",
          description: "Select, invoke once, normalize, and audit using the host-authorized company scope.",
          parametersSchema: { type: "object" },
        },
        async (params, runCtx): Promise<ToolResult> => {
          const result = await invokeFor(runCtx.companyId, params, runCtx.runId);
          return { content: summary(result), data: result };
        },
      );

      ctx.actions.register(ACTION_KEYS.invoke, async (params, actionCtx) => {
        if (!actionCtx.companyId) throw new Error("host-authorized company context is required");
        const { companyId: _hostInjectedCompanyId, ...request } = params;
        return invokeFor(actionCtx.companyId, request, actionCtx.actor.runId);
      });

      ctx.actions.register(ACTION_KEYS.refreshCapacity, async (_params, actionCtx) => {
        if (!actionCtx.companyId) throw new Error("host-authorized company context is required");
        return refreshCapacity(actionCtx.companyId, await companyConfig(actionCtx.companyId)) as unknown as Record<string, unknown>;
      });

      ctx.logger.info("Model Router worker ready", { version: PLUGIN_VERSION });
    },

    async onHealth() {
      return { status: "ok", message: `Model Router ${PLUGIN_VERSION}` };
    },

    async onValidateConfig(raw: Record<string, unknown>) {
      const config = resolveConfig(raw);
      const errors = validateUpstreamConfig(config.upstream);
      const warnings: string[] = [];
      if (config.routing.enabled && config.models.length === 0) {
        warnings.push("routing is enabled but no models are configured");
      }
      if (!config.upstream.credentialSecretRef) {
        errors.push("upstream.credentialSecretRef is required");
      }
      const secretRefError = validateSecretRefShape(
        asRecord(raw.upstream).credentialSecretRef,
        "upstream.credentialSecretRef",
      );
      if (secretRefError) errors.push(secretRefError);
      const ids = new Set<string>();
      for (const model of config.models) {
        if (ids.has(model.id)) errors.push(`duplicate model id: ${model.id}`);
        ids.add(model.id);
      }
      for (const entry of config.taskClasses) {
        if (entry.pinnedModelId && !ids.has(entry.pinnedModelId)) {
          errors.push(`task class ${entry.key} pins ${entry.pinnedModelId}, which is not in the model table`);
        }
      }
      if (config.routing.fallbackModelId && !ids.has(config.routing.fallbackModelId)) {
        errors.push(`routing.fallbackModelId ${config.routing.fallbackModelId} is not in the model table`);
      }
      for (const entry of config.rule0.deterministicPatterns) {
        try { new RegExp(entry.pattern, "i"); } catch { errors.push(`rule0 pattern ${entry.pattern} is not a valid regular expression`); }
      }
      if (!(config.budget.warnFraction <= config.budget.downshiftFraction && config.budget.downshiftFraction <= config.budget.haltFraction)) {
        errors.push("budget fractions must satisfy warn <= downshift <= halt");
      }
      if (config.capacityRouting.enabled && config.capacityRouting.sources.length === 0) {
        errors.push("capacityRouting.enabled is true but no telemetry sources are configured");
      }
      if (config.capacityRouting.conserveUtilization > config.capacityRouting.avoidUtilization) {
        errors.push("capacityRouting thresholds must satisfy conserve <= avoid");
      }
      if (config.capacityRouting.mode === "enforce") {
        warnings.push("capacity routing is enforcing; promote only after shadow and outage evidence");
      }
      for (let index = 0; index < config.capacityRouting.sources.length; index += 1) {
        const source = config.capacityRouting.sources[index]!;
        let parsed: URL | null = null;
        try { parsed = new URL(source.statusUrl); } catch { errors.push(`capacity source ${source.id} statusUrl must be an absolute URL`); }
        if (parsed) {
          if (parsed.protocol !== "https:") errors.push(`capacity source ${source.id} statusUrl must use https`);
          if (parsed.username || parsed.password || parsed.search || parsed.hash) errors.push(`capacity source ${source.id} statusUrl must not contain credentials, query, or fragment`);
          if (isReservedLiteralHost(parsed.hostname)) errors.push(`capacity source ${source.id} statusUrl must not use a private or reserved literal address`);
        }
        if (source.modelIds.length === 0) errors.push(`capacity source ${source.id} names no model ids`);
        for (const modelId of source.modelIds) {
          if (!ids.has(modelId)) errors.push(`capacity source ${source.id} names unknown model id ${modelId}`);
        }
        if (!Number.isInteger(source.requestTimeoutMs) || source.requestTimeoutMs < 1_000 || source.requestTimeoutMs > 25_000) errors.push(`capacity source ${source.id} requestTimeoutMs must be an integer from 1000 through 25000`);
        if (!Number.isInteger(source.maxResponseBytes) || source.maxResponseBytes < 1_024 || source.maxResponseBytes > 16_777_216) errors.push(`capacity source ${source.id} maxResponseBytes must be an integer from 1024 through 16777216`);
        if (source.windows.length === 0) errors.push(`capacity source ${source.id} names no utilization windows`);
        const sourceSecretError = validateSecretRefShape(source.apiKeySecretRef, `capacityRouting.sources.${index}.apiKeySecretRef`);
        if (sourceSecretError) errors.push(sourceSecretError);
      }
      return { ok: errors.length === 0, errors, warnings };
    },

    async onApiRequest(input) {
      if (!context || !invoke) return { status: 503, body: { error: "worker is not initialised" } };
      if (input.routeKey !== ROUTE_KEYS.invoke && input.routeKey !== ROUTE_KEYS.invokeIssue) {
        return { status: 404, body: { error: `unknown route ${input.routeKey}` } };
      }
      const body = asRecord(input.body);
      const request = input.routeKey === ROUTE_KEYS.invokeIssue
        ? { ...body, task: { ...asRecord(body.task), issueId: input.params.issueId } }
        : body;
      const result = await invoke(input.companyId, request, input.actor.runId ?? null);
      return { status: result.outcome === "error" && result.error.code === "invalid-request" ? 400 : 200, body: result };
    },
  });
}

const plugin = createPlugin();
export default plugin;
runWorker(plugin, import.meta.url);
