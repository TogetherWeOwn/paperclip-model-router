/**
 * Plugin worker.
 *
 * Everything company-specific arrives through `ctx.config.get(companyId)`.
 * The worker holds no company constants and branches on no company id; if it
 * ever needs to, that thing belongs in `src/config/schema.ts` instead.
 */

import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";

import { resolveConfig } from "./config/resolve.js";
import { validateSecretRefShape } from "./config/secret-ref.js";
import type { RouterConfig } from "./config/types.js";
import {
  ACTION_KEYS,
  CLAUDE_PAYG_UNLOCK_ENV,
  CLAUDE_PROVIDER_ALLOWLIST,
  DATA_KEYS,
  DECISION_LOG_LIMIT,
  idNamesClaude,
  isClaudeProviderAllowed,
  PLUGIN_VERSION,
  ROUTE_KEYS,
  STATE_KEYS,
  TOOL_NAMES,
} from "./constants.js";
import { selectModel } from "./engine/select.js";
import type { RoutingDecision, TaskDescriptor } from "./engine/types.js";
import { readQuotaSnapshot, type QuotaHttpClient, type QuotaSnapshot } from "./quota/teamclaude.js";

interface DecisionRecord {
  at: string;
  companyId: string;
  issueId: string | null;
  taskClass: string | null;
  outcome: RoutingDecision["outcome"];
  modelId: string | null;
  trace: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function descriptorFrom(params: Record<string, unknown>): TaskDescriptor {
  const descriptor: TaskDescriptor = {};
  if (typeof params.taskClass === "string") descriptor.taskClass = params.taskClass;
  if (typeof params.summary === "string") descriptor.summary = params.summary;
  if (typeof params.issueId === "string") descriptor.issueId = params.issueId;
  if (typeof params.pinnedModelId === "string") descriptor.pinnedModelId = params.pinnedModelId;
  if (typeof params.pinReason === "string") descriptor.pinReason = params.pinReason;
  if (typeof params.requiredContextTokens === "number") {
    descriptor.requiredContextTokens = params.requiredContextTokens;
  }
  if (typeof params.estimatedInputTokens === "number") {
    descriptor.estimatedInputTokens = params.estimatedInputTokens;
  }
  if (typeof params.estimatedOutputTokens === "number") {
    descriptor.estimatedOutputTokens = params.estimatedOutputTokens;
  }
  if (Array.isArray(params.requiredCapabilities)) {
    descriptor.requiredCapabilities = params.requiredCapabilities.filter(
      (entry): entry is TaskDescriptor["requiredCapabilities"] extends undefined
        ? never
        : NonNullable<TaskDescriptor["requiredCapabilities"]>[number] => typeof entry === "string",
    );
  }
  const signals = asRecord(params.signals);
  const numericSignals: Record<string, number> = {};
  for (const [key, value] of Object.entries(signals)) {
    if (typeof value === "number" && Number.isFinite(value)) numericSignals[key] = value;
  }
  if (Object.keys(numericSignals).length > 0) descriptor.signals = numericSignals;
  return descriptor;
}

/** Adapts `ctx.http.fetch` to the quota reader's minimal client. */
function quotaHttp(ctx: PluginContext): QuotaHttpClient {
  return {
    async request({ url, method, headers }) {
      const response = await ctx.http.fetch(url, { method, headers });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { status: response.status, body };
    },
  };
}

/** Signature of the single routing entry point every surface calls. */
type Decide = (
  companyId: string,
  descriptor: TaskDescriptor,
  options?: { budgetSpentFraction?: number },
) => Promise<{ decision: RoutingDecision; quota: QuotaSnapshot | null }>;

export function createPlugin() {
  // `onApiRequest` is a top-level worker hook and receives no context, so setup
  // parks the context here for it. One worker process serves every company; the
  // context is company-agnostic and every read is explicitly company-scoped.
  let context: PluginContext | null = null;
  // ...and parks `decide` here too. `onApiRequest` used to call `selectModel`
  // directly, which quietly gave the HTTP route its own routing engine: no quota
  // gate, no stickiness, and no entry in the decision log. Two surfaces, two
  // answers, one of them unaudited. There is now exactly one path.
  let decide: Decide | null = null;

  return definePlugin({
    async setup(ctx) {
      context = ctx;
      const companyConfig = async (companyId: string): Promise<RouterConfig> =>
        resolveConfig(await ctx.config.get(companyId));

      const stickyKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: STATE_KEYS.issueStickiness,
      });

      const readStickyModel = async (
        companyId: string,
        issueId: string | undefined,
      ): Promise<string | undefined> => {
        if (!issueId) return undefined;
        const map = asRecord(await ctx.state.get(stickyKey(companyId)));
        const value = map[issueId];
        return typeof value === "string" ? value : undefined;
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

      const readQuota = async (
        companyId: string,
        config: RouterConfig,
      ): Promise<QuotaSnapshot | null> => {
        if (!config.quotaGate.enabled) return null;
        let apiKey: string | null = null;
        if (config.quotaGate.apiKeySecretRef) {
          try {
            apiKey = await ctx.secrets.resolve(config.quotaGate.apiKeySecretRef as never, {
              companyId,
              configPath: "quotaGate.apiKeySecretRef",
            });
          } catch (error) {
            ctx.logger.warn("quota gate: could not resolve the teamclaude key", {
              companyId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        const snapshot = await readQuotaSnapshot({
          config: config.quotaGate,
          http: quotaHttp(ctx),
          apiKey,
          now: () => new Date().toISOString(),
        });
        await ctx.state.set(
          { scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.quotaSnapshot },
          snapshot as unknown as Record<string, unknown>,
        );
        return snapshot;
      };

      const recordDecision = async (
        companyId: string,
        descriptor: TaskDescriptor,
        decision: RoutingDecision,
      ): Promise<void> => {
        const key = {
          scopeKind: "company" as const,
          scopeId: companyId,
          stateKey: STATE_KEYS.decisionLog,
        };
        const existing = await ctx.state.get(key);
        const log: DecisionRecord[] = Array.isArray(existing) ? (existing as DecisionRecord[]) : [];
        log.unshift({
          at: new Date().toISOString(),
          companyId,
          issueId: descriptor.issueId ?? null,
          taskClass: decision.taskClass,
          outcome: decision.outcome,
          modelId: decision.modelId,
          trace: decision.trace,
        });
        await ctx.state.set(key, log.slice(0, DECISION_LOG_LIMIT));

        await ctx.metrics.write(`model_router.decision.${decision.outcome}`, 1, {
          companyId,
          model: decision.modelId ?? "none",
        });
      };

      /** The one path every surface goes through. */
      const decideFor: Decide = async (
        companyId: string,
        descriptor: TaskDescriptor,
        options?: { budgetSpentFraction?: number },
      ): Promise<{ decision: RoutingDecision; quota: QuotaSnapshot | null }> => {
        const config = await companyConfig(companyId);
        const quota = await readQuota(companyId, config);
        const decision = selectModel({
          descriptor,
          config,
          signals: {
            budgetSpentFraction: options?.budgetSpentFraction,
            claudeQuotaUtilization: quota?.maxUtilization ?? undefined,
            // An enabled gate that could not read its number must say so in the
            // trace; an open gate is not the same fact as a healthy one.
            claudeQuotaError: quota?.error ?? undefined,
            stickyModelId: config.routing.stickyModelWithinIssue
              ? await readStickyModel(companyId, descriptor.issueId)
              : undefined,
          },
        });
        await recordDecision(companyId, descriptor, decision);
        if (decision.outcome === "selected") {
          await writeStickyModel(companyId, descriptor.issueId, decision.modelId);
        }
        return { decision, quota };
      };
      decide = decideFor;

      // ---- agent tool ------------------------------------------------------
      ctx.tools.register(
        TOOL_NAMES.selectModel,
        {
          displayName: "Select a model",
          description:
            "Return the cheapest model that clears this company's quality floor and constraints, with the full reasoning trace.",
          parametersSchema: { type: "object", required: ["companyId"] },
        },
        async (params) => {
          const input = asRecord(params);
          const companyId = typeof input.companyId === "string" ? input.companyId : "";
          if (!companyId) {
            return { ok: false, error: "companyId is required" } as never;
          }
          const { decision } = await decideFor(companyId, descriptorFrom(input));
          return { ok: true, data: decision } as never;
        },
      );

      // ---- UI / bridge data ------------------------------------------------
      ctx.data.register(DATA_KEYS.effectiveConfig, async ({ companyId }) => {
        const id = String(companyId ?? "");
        return { version: PLUGIN_VERSION, config: await companyConfig(id) };
      });

      ctx.data.register(DATA_KEYS.decisions, async ({ companyId }) => {
        const value = await ctx.state.get({
          scopeKind: "company",
          scopeId: String(companyId ?? ""),
          stateKey: STATE_KEYS.decisionLog,
        });
        return { decisions: Array.isArray(value) ? value : [] };
      });

      ctx.data.register(DATA_KEYS.quota, async ({ companyId }) => {
        const id = String(companyId ?? "");
        const config = await companyConfig(id);
        const stored = await ctx.state.get({
          scopeKind: "company",
          scopeId: id,
          stateKey: STATE_KEYS.quotaSnapshot,
        });
        return { enabled: config.quotaGate.enabled, snapshot: stored ?? null };
      });

      // ---- actions ---------------------------------------------------------
      ctx.actions.register(ACTION_KEYS.route, async (params) => {
        const input = asRecord(params);
        const companyId = String(input.companyId ?? "");
        if (!companyId) throw new Error("companyId is required");
        const budget =
          typeof input.budgetSpentFraction === "number" ? input.budgetSpentFraction : undefined;
        const { decision } = await decideFor(companyId, descriptorFrom(input), {
          budgetSpentFraction: budget,
        });
        return decision as unknown as Record<string, unknown>;
      });

      ctx.actions.register(ACTION_KEYS.refreshQuota, async (params) => {
        const companyId = String(asRecord(params).companyId ?? "");
        if (!companyId) throw new Error("companyId is required");
        const config = await companyConfig(companyId);
        const snapshot = await readQuota(companyId, config);
        return { snapshot } as unknown as Record<string, unknown>;
      });

      ctx.logger.info("Model Router worker ready", { version: PLUGIN_VERSION });
    },

    async onHealth() {
      return { status: "ok", message: `Model Router ${PLUGIN_VERSION}` };
    },

    /**
     * Config is per company, so validation is too.
     *
     * Note what this is NOT: the persisting write, `POST /plugins/:id/config`,
     * validates against `instanceConfigSchema` with Ajv and never calls this
     * hook. Only `POST /plugins/:id/config/test` — a dry run that stores
     * nothing — reaches it. So this is an operator-facing check, not a gate:
     * anything that must actually be refused at write time has to be expressible
     * in `src/config/schema.ts`. The two overlap on purpose.
     */
    async onValidateConfig(config: Record<string, unknown>) {
      const resolved = resolveConfig(config);
      const errors: string[] = [];
      const warnings: string[] = [];

      if (resolved.routing.enabled && resolved.models.length === 0) {
        warnings.push("routing is enabled but no models are configured — every decision will be `no-eligible-model`");
      }
      if (resolved.routing.enabled && resolved.providers.permitted.length === 0) {
        warnings.push("no permitted providers — every model will be rejected as provider-not-permitted");
      }
      // `resolveConfig` has already forced this to false unless the instance
      // unlock is present, so read the RAW value to tell the two cases apart:
      // an owner who unlocked PAYG deliberately gets the warning, and a company
      // that set the flag on its own gets a refusal.
      const rawPaygRequested =
        (config.providers as Record<string, unknown> | undefined)?.claudePaygEnabled === true;
      if (resolved.providers.claudePaygEnabled) {
        warnings.push("Claude pay-as-you-go is ENABLED for this company — Claude may be served by providers other than teamclaude");
      } else if (rawPaygRequested) {
        errors.push(
          `providers.claudePaygEnabled is true, but Claude PAYG is not unlocked on this instance. ` +
            `Owner rule 1 keeps Claude PAYG disabled until the OWNER enables it, and a company config row is not the owner. ` +
            `The flag is ignored by the engine regardless; set ${CLAUDE_PAYG_UNLOCK_ENV}=1 in the instance environment if the owner has authorised it.`,
        );
      }
      // The Claude block's destination, which used to be a free-form string:
      // `claudeFamilyProvider: "openrouter"` did not disable the block, it aimed
      // it, and a Claude model teamclaude cannot serve came back `selected`.
      if (!isClaudeProviderAllowed(resolved.providers.claudeFamilyProvider)) {
        errors.push(
          `providers.claudeFamilyProvider is "${resolved.providers.claudeFamilyProvider}", which is not a provider owner rule 1 allows for Claude ` +
            `(allowed: ${CLAUDE_PROVIDER_ALLOWLIST.join(", ")}). This field may narrow that list, not extend it. ` +
            `The engine blocks every Claude model while this is set, so routing is failing closed rather than leaking — but fix the config rather than leaving it.`,
        );
      }

      const ids = new Set<string>();
      const claudeFamilies = new Set(
        resolved.providers.claudeFamilies.map((entry) => entry.toLowerCase()),
      );
      for (const model of resolved.models) {
        if (ids.has(model.id)) errors.push(`duplicate model id: ${model.id}`);
        ids.add(model.id);

        // The TOG-237 mislabel, in both directions.
        //
        // An ERROR when the id names Claude and the declared family does not.
        // The engine no longer *routes* on this — `idNamesClaude` governs the
        // Claude block regardless — so this config is no longer a bypass. It is
        // still refused rather than warned, because a model table that
        // contradicts itself about which rows are Claude is a table nobody
        // should be reasoning about owner rule 1 from, and the operator should
        // find out at write time rather than by reading a trace during an
        // incident.
        const declaredClaude = claudeFamilies.has(model.family.toLowerCase());
        if (idNamesClaude(model.id) && !declaredClaude) {
          errors.push(
            `model ${model.id} has a Claude/Anthropic id but declares family "${model.family}", which is not in providers.claudeFamilies (${resolved.providers.claudeFamilies.join(", ") || "empty"}). ` +
              "Before TOG-237 this silently exempted the model from the Claude block; it no longer does, but the table must not disagree with itself. " +
              "Set the family to a configured Claude family, or add this family to providers.claudeFamilies.",
          );
        }
        // A WARNING the other way. This one only ever *widens* the Claude block,
        // so it cannot leak — but it is usually a typo, and it silently confines
        // a non-Anthropic model to `claudeFamilyProvider`, which looks like an
        // outage rather than a misconfiguration.
        if (declaredClaude && !idNamesClaude(model.id)) {
          warnings.push(
            `model ${model.id} declares Claude family "${model.family}" but its id does not name Claude or Anthropic — it will be confined to ${resolved.providers.claudeFamilyProvider} by the Claude block. Intended?`,
          );
        }
      }
      const classKeys = new Set<string>();
      for (const entry of resolved.taskClasses) {
        if (classKeys.has(entry.key)) errors.push(`duplicate task class key: ${entry.key}`);
        classKeys.add(entry.key);
        if (entry.pinnedModelId && !ids.has(entry.pinnedModelId)) {
          errors.push(`task class ${entry.key} pins ${entry.pinnedModelId}, which is not in the model table`);
        }
      }
      // An error, not a warning. A fallback id that is not in the table has been
      // seen by no gate at all — the Claude block included — so the engine
      // refuses it at routing time. Refusing it at write time instead means the
      // operator finds out now rather than during an incident.
      if (resolved.routing.fallbackModelId && !ids.has(resolved.routing.fallbackModelId)) {
        errors.push(
          `routing.fallbackModelId ${resolved.routing.fallbackModelId} is not in the model table, so no gate can vet it`,
        );
      }
      for (const entry of resolved.rule0.deterministicPatterns) {
        try {
          new RegExp(entry.pattern, "i");
        } catch (error) {
          errors.push(
            `rule0 pattern ${entry.pattern} is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const gate = resolved.quotaGate;
      if (gate.enabled && !gate.statusUrl) {
        errors.push("quotaGate.enabled is true but quotaGate.statusUrl is empty");
      }
      if (gate.enabled && !gate.apiKeySecretRef) {
        warnings.push("quota gate has no apiKeySecretRef — the status endpoint will likely answer 401");
      }
      // The host cannot do this for us. `format: "secret-ref"` is registered
      // host-side as `ajv.addFormat("secret-ref", { validate: () => true })` — a
      // UI hint with no validation behind it — and the field is typed
      // `["object","null"]`, so `{"apiKey":"sk-ant-..."}` is accepted verbatim
      // and stored in the company's config row. The claim that a credential
      // cannot be stored in a config is only true if this plugin makes it true.
      const secretRefError = validateSecretRefShape(
        asRecord(config.quotaGate)["apiKeySecretRef"],
        "quotaGate.apiKeySecretRef",
      );
      if (secretRefError) errors.push(secretRefError);
      if (!(gate.warnUtilization <= gate.downshiftUtilization && gate.downshiftUtilization <= gate.pauseUtilization)) {
        errors.push("quotaGate thresholds must satisfy warn <= downshift <= pause");
      }
      const budget = resolved.budget;
      if (!(budget.warnFraction <= budget.downshiftFraction && budget.downshiftFraction <= budget.haltFraction)) {
        errors.push("budget fractions must satisfy warn <= downshift <= halt");
      }

      return { ok: errors.length === 0, errors, warnings };
    },

    async onApiRequest(input) {
      if (!context || !decide) return { status: 503, body: { error: "worker is not initialised" } };

      if (input.routeKey === ROUTE_KEYS.companyConfig) {
        const config = resolveConfig(await context.config.get(input.companyId));
        return { status: 200, body: { version: PLUGIN_VERSION, config } };
      }
      if (input.routeKey === ROUTE_KEYS.routeIssue) {
        const body = asRecord(input.body);
        const descriptor = descriptorFrom({ ...body, issueId: input.params.issueId });
        const { decision } = await decide(input.companyId, descriptor, {
          budgetSpentFraction:
            typeof body.budgetSpentFraction === "number" ? body.budgetSpentFraction : undefined,
        });
        return { status: 200, body: { decision } };
      }
      return { status: 404, body: { error: `unknown route ${input.routeKey}` } };
    },
  });
}

const plugin = createPlugin();

export default plugin;

runWorker(plugin, import.meta.url);
