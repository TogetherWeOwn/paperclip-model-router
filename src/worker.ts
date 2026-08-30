import { randomUUID } from "node:crypto";

import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, ToolResult } from "@paperclipai/plugin-sdk";

import { resolveConfig } from "./config/resolve.js";
import { validateSecretRefShape } from "./config/secret-ref.js";
import type { RouterConfig } from "./config/types.js";
import {
  ACTION_KEYS,
  DECISION_LOG_LIMIT,
  JOB_KEYS,
  PLUGIN_VERSION,
  ROUTE_KEYS,
  STATE_KEYS,
  TOOL_NAMES,
} from "./constants.js";
import { selectModel } from "./engine/select.js";
import {
  accrue,
  emptyLedger,
  invocationCostUsd,
  isSpendLedger,
  monthKey,
  spentFraction,
  type SpendLedger,
} from "./engine/spend.js";
import type { RoutingDecision } from "./engine/types.js";
import { applyHealth, reconcileHealth } from "./health/reconcile.js";
import { probeCatalogue } from "./health/probe.js";
import type { ModelHealthState } from "./health/types.js";
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
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

      const healthKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: STATE_KEYS.modelHealth,
      });

      const spendKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: STATE_KEYS.spendLedger,
      });

      const readHealth = async (companyId: string): Promise<ModelHealthState> =>
        asRecord(await ctx.state.get(healthKey(companyId))) as ModelHealthState;

      const readLedger = async (companyId: string, at: Date): Promise<SpendLedger> => {
        const stored = await ctx.state.get(spendKey(companyId));
        return isSpendLedger(stored) ? stored : emptyLedger(monthKey(at));
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
        });
        await ctx.state.set(key, log.slice(0, DECISION_LOG_LIMIT));
        await ctx.metrics.write(`model_router.invoke.${result.outcome}`, 1);

        // Accrue what this call actually cost, so the budget gates have a feed.
        // Only completed calls with reported usage move the ledger.
        if (response && decision?.modelId) {
          const config = await companyConfig(companyId);
          const cost = invocationCostUsd(
            config.models.find((model) => model.id === decision.modelId),
            response.usage,
          );
          if (cost > 0) {
            const at = new Date();
            const next = accrue(await readLedger(companyId, at), cost, at);
            await ctx.state.set(spendKey(companyId), next);
            await ctx.metrics.write("model_router.spend.usd", cost);
          }
        }
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

        // The operator's table is what routing policy is written against, but a
        // model the scheduled probe found dark must not be selectable. The
        // overlay only ever removes models, so operator intent still wins.
        const health = await readHealth(companyId);
        const ledger = await readLedger(companyId, new Date(startedAt));
        const decision = selectModel({
          descriptor: request.task,
          config: { ...config, models: applyHealth(config.models, health) },
          signals: {
            // Measured spend, not a caller-supplied number: a caller that could
            // set its own budget fraction could also set it to zero and walk
            // straight through the halt gate.
            budgetSpentFraction: spentFraction(
              ledger,
              config.budget.monthlyCapUsd,
              new Date(startedAt),
            ),
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

      // --- scheduled model health -------------------------------------------
      // Probe one company's upstream catalogue and fold the answer into stored
      // health. Returns the flips so the job can log them; throws nothing, so
      // one broken company config cannot stop the sweep for the others.
      const probeCompany = async (companyId: string): Promise<number> => {
        let config: RouterConfig;
        try {
          config = await companyConfig(companyId);
        } catch {
          return 0;
        }
        if (config.models.length === 0) return 0;
        if (validateUpstreamConfig(config.upstream).length > 0) return 0;
        if (!config.upstream.credentialSecretRef) return 0;

        let credential: string;
        try {
          credential = await ctx.secrets.resolve(config.upstream.credentialSecretRef as never, {
            companyId,
            configPath: "upstream.credentialSecretRef",
          });
        } catch {
          // Indeterminate, not dead. Leave the table exactly as it was.
          return 0;
        }

        const probe = await probeCatalogue({ http: ctx.http, config: config.upstream, credential });
        const { next, flips } = reconcileHealth({
          models: config.models,
          probe,
          previous: await readHealth(companyId),
          now: new Date().toISOString(),
        });
        if (probe.modelIds === null) {
          ctx.logger.warn("Model health probe was indeterminate; model table left unchanged", {
            companyId,
            detail: probe.detail,
            status: probe.status,
          });
          return 0;
        }
        await ctx.state.set(healthKey(companyId), next);

        // A model going dark belongs on the board, not only in the failed
        // invocations it would otherwise cause.
        for (const flip of flips) {
          await ctx.activity.log({
            companyId,
            message: flip.to === "dead"
              ? `Model Router took ${flip.modelId} out of service: ${flip.reason}.`
              : `Model Router returned ${flip.modelId} to service: ${flip.reason}.`,
          });
          await ctx.metrics.write(`model_router.health.${flip.to}`, 1);
        }
        return flips.length;
      };

      ctx.jobs.register(JOB_KEYS.modelHealth, async () => {
        // Jobs are not company-scoped invocations, so the companies to sweep
        // have to be enumerated rather than inferred from an ambient scope.
        let companies: Array<{ id: string }>;
        try {
          companies = await ctx.companies.list();
        } catch (cause) {
          ctx.logger.error("Model health probe could not list companies", {
            error: cause instanceof Error ? cause.message : String(cause),
          });
          return;
        }
        let flips = 0;
        for (const company of companies) {
          try {
            flips += await probeCompany(company.id);
          } catch (cause) {
            ctx.logger.error("Model health probe failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }
        ctx.logger.info("Model health probe complete", { companies: companies.length, flips });
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
