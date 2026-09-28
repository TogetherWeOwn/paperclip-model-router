import { randomUUID } from "node:crypto";

import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, ToolResult } from "@paperclipai/plugin-sdk";

import { readCapacitySource, type CapacityHttpClient } from "./capacity/read.js";
import type { CapacityEvidence, CapacitySnapshot, LanePaceVerdict } from "./capacity/types.js";
import { resolveConfig } from "./config/resolve.js";
import { validateSecretRefShape } from "./config/secret-ref.js";
import {
  isReservedLiteralHost,
  MAX_REQUEST_TIMEOUT_MS,
  MIN_REQUEST_TIMEOUT_MS,
} from "./config/upstream-constraints.js";
import type { RouterConfig } from "./config/types.js";
import {
  ACTION_KEYS,
  DECISION_LOG_RETENTION_DAYS,
  JOB_KEYS,
  PENDING_INVOCATION_TTL_MS,
  PLUGIN_VERSION,
  ROUTE_KEYS,
  STATE_KEYS,
  TOOL_NAMES,
} from "./constants.js";
import {
  decisionInsertSql,
  decisionPruneSql,
  decisionRecordParams,
  type DecisionRecord,
} from "./decision-records.js";
import type { RoutingDecision } from "./engine/types.js";
import { selectModel } from "./engine/select.js";
import { extractAuthoritativeBudgetSpentFraction, resolveEffectiveBudgetSpentFraction } from "./budget-authority.js";
import { validateUpstreamConfig } from "./inference/adapters.js";
import { effectiveMaxSyncOutputTokens } from "./inference/sync-budget.js";
import { readMonthlySpendLedger } from "./spend-ledger.js";
import { directFetchHttpClient, invokeCompatibleUpstream } from "./inference/transport.js";
import type { InferenceError, InferenceResult, InvokeRequest, NormalizedResponse } from "./inference/types.js";
import { InvocationValidationError, parseInvokeRequest } from "./inference/validate.js";

type AsyncInvokeResult =
  | InferenceResult
  | { status: "pending"; requestId: string; decision: RoutingDecision };

// TOG-7417: `runId` makes run-scoped reap expressible — the run-end hook
// enumerates a run's still-open invocations through the by-run index and
// settles them. `agentId` rides along so the reap-time audit row keeps its
// submitter. Rows written by older workers lack both; every reader treats a
// missing value as null.
type PendingInvocationRecord =
  | { status: "pending"; requestId: string; decision: RoutingDecision; startedAt: string; expiresAt: string; runId: string | null; agentId: string | null }
  | {
      status: "completed";
      requestId: string;
      decision: RoutingDecision;
      outcome: "completed";
      response: NormalizedResponse;
      error: null;
      startedAt: string;
      expiresAt: string;
      runId: string | null;
      agentId: string | null;
    }
  | {
      status: "error";
      requestId: string;
      decision: RoutingDecision;
      outcome: "error";
      response: null;
      error: InferenceError;
      startedAt: string;
      expiresAt: string;
      runId: string | null;
      agentId: string | null;
    };

type PollResult = { status: "not-found" } | PendingInvocationRecord;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function legacyDecisionRecord(companyId: string, value: unknown): DecisionRecord | null {
  const row = asRecord(value);
  const requestId = nullableString(row.requestId);
  const at = nullableString(row.at);
  const outcome = nullableString(row.outcome);
  if (!requestId || !at || !outcome) return null;
  return {
    id: randomUUID(),
    companyId,
    at,
    requestId,
    agentId: nullableString(row.agentId),
    runId: nullableString(row.runId),
    issueId: nullableString(row.issueId),
    taskClass: nullableString(row.taskClass),
    selectionOutcome: nullableString(row.selectionOutcome) as DecisionRecord["selectionOutcome"],
    modelId: nullableString(row.modelId),
    fallbackUsed: row.fallbackUsed === true,
    upstreamProtocol: nullableString(row.upstreamProtocol) as DecisionRecord["upstreamProtocol"],
    outcome: outcome as DecisionRecord["outcome"],
    errorCode: nullableString(row.errorCode),
    upstreamStatus: nullableNumber(row.upstreamStatus),
    latencyMs: nullableNumber(row.latencyMs) ?? 0,
    inputTokens: nullableNumber(row.inputTokens),
    outputTokens: nullableNumber(row.outputTokens),
    stopReason: nullableString(row.stopReason) as DecisionRecord["stopReason"],
    upstreamRequestId: nullableString(row.upstreamRequestId),
    capacityMode: nullableString(row.capacityMode) as DecisionRecord["capacityMode"],
    capacityTelemetry: nullableString(row.capacityTelemetry) as DecisionRecord["capacityTelemetry"],
    capacityLane: nullableString(row.capacityLane),
    capacityLaneLabel: nullableString(row.capacityLaneLabel),
    capacityPosture: nullableString(row.capacityPosture) as DecisionRecord["capacityPosture"],
    capacityReason: nullableString(row.capacityReason),
    capacityDegraded: row.capacityDegraded === true,
    shadowModelId: nullableString(row.shadowModelId),
  };
}

async function persistDecisionRecord(ctx: PluginContext, record: DecisionRecord): Promise<void> {
  await ctx.db.execute(
    decisionInsertSql(ctx.db.namespace),
    decisionRecordParams(record),
  );
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
  let invoke: ((
    companyId: string,
    raw: unknown,
    actor?: { agentId?: string | null; runId?: string | null },
  ) => Promise<InferenceResult>) | null = null;
  let invokeAsync: ((
    companyId: string,
    raw: unknown,
    actor?: { agentId?: string | null; runId?: string | null },
  ) => Promise<AsyncInvokeResult>) | null = null;
  let invokeResult: ((companyId: string, requestId: string) => Promise<PollResult>) | null = null;

  return definePlugin({
    multiCompanyConfig: true,

    async setup(ctx) {
      context = ctx;
      const companyConfig = async (companyId: string): Promise<RouterConfig> =>
        resolveConfig(await ctx.config.get(companyId));
      const migratedDecisionLogs = new Set<string>();

      const migrateLegacyDecisionLog = async (companyId: string): Promise<void> => {
        if (migratedDecisionLogs.has(companyId)) return;
        const migrationKey = {
          scopeKind: "company" as const,
          scopeId: companyId,
          stateKey: STATE_KEYS.decisionLogMigration,
        };
        const legacy = await ctx.state.get({
          scopeKind: "company",
          scopeId: companyId,
          stateKey: STATE_KEYS.legacyDecisionLog,
        });
        if (Array.isArray(legacy)) {
          const cutoff = Date.now() - DECISION_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
          for (const value of legacy) {
            const record = legacyDecisionRecord(companyId, value);
            if (record && Date.parse(record.at) >= cutoff) {
              await persistDecisionRecord(ctx, record);
            }
          }
        }
        await ctx.state.set(migrationKey, { reconciledAt: new Date().toISOString() });
        migratedDecisionLogs.add(companyId);
      };

      const pruneDecisionRecords = async (): Promise<void> => {
        await ctx.db.execute(
          decisionPruneSql(ctx.db.namespace),
          [new Date().toISOString(), DECISION_LOG_RETENTION_DAYS],
        );
      };

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
      ): Promise<{ snapshots: CapacitySnapshot[]; evidence: CapacityEvidence[]; error: string | null; paceVerdicts: Record<string, LanePaceVerdict>; modelLaneByPace: Record<string, string> }> => {
        const stored = asRecord(await ctx.state.get(capacityStateKey(companyId)));
        const refreshedAt = typeof stored.refreshedAt === "string" ? Date.parse(stored.refreshedAt) : Number.NaN;
        const paceRefreshedAt = typeof stored.paceRefreshedAt === "string" ? Date.parse(stored.paceRefreshedAt) : Number.NaN;
        const lastRefreshError = typeof stored.lastRefreshError === "string" ? stored.lastRefreshError : null;
        const stale = !Number.isFinite(refreshedAt) || Date.now() - refreshedAt > config.capacityRouting.maxSnapshotAgeMs;
        const paceStale = !Number.isFinite(paceRefreshedAt) || Date.now() - paceRefreshedAt > config.capacityRouting.maxSnapshotAgeMs;
        // TOG-2139/TOG-2922: pace freshness is independent of capacity evidence.
        // A lane document can yield a valid pace verdict even when the legacy
        // capacity normalizer cannot recognize its records. Rebuilding the
        // model->lane map from config keeps a config edit effective without a
        // fresh fetch.
        const modelLaneByPace: Record<string, string> = {};
        for (const source of config.capacityRouting.sources) {
          if (!source.pace) continue;
          for (const modelId of source.modelIds) modelLaneByPace[modelId] = source.pace.laneId;
        }
        const paceVerdicts: Record<string, LanePaceVerdict> = {};
        const storedPace = paceStale ? null : asRecord(stored.paceVerdicts);
        if (storedPace) {
          for (const source of config.capacityRouting.sources) {
            const verdict = asRecord(storedPace[source.id]);
            if (source.pace && verdict && typeof verdict.laneId === "string" && typeof verdict.state === "string") {
              // Validate the stored shape minimally; the selector tolerates any
              // missing fields as fail-neutral unknowns.
              paceVerdicts[source.pace.laneId] = verdict as unknown as LanePaceVerdict;
            }
          }
        }
        return {
          snapshots: Array.isArray(stored.snapshots) ? stored.snapshots as CapacitySnapshot[] : [],
          evidence: Array.isArray(stored.evidence) ? stored.evidence as CapacityEvidence[] : [],
          error: lastRefreshError ?? (stale ? "capacity-snapshot-stale" : null),
          paceVerdicts,
          modelLaneByPace,
        };
      };

      const refreshCapacity = async (
        companyId: string,
        config: RouterConfig,
      ): Promise<{ snapshots: CapacitySnapshot[]; evidence: CapacityEvidence[]; error: string | null; paceVerdicts: Record<string, LanePaceVerdict>; laneDown: Record<string, boolean> }> => {
        if (!config.capacityRouting.enabled) return { snapshots: [], evidence: [], error: null, paceVerdicts: {}, laneDown: {} };
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
          snapshots.push(await readCapacitySource({
            source,
            http: capacityHttp(ctx),
            apiKey,
            now: () => new Date().toISOString(),
            // TOG-2139: pace is computed from the same response body, so passing
            // the lane definition changes nothing about the capacity fetch itself.
            // TOG-2922: evaluate it whenever the source configures it, including
            // while paceOrdering is off. That warms the stored verdicts so the
            // enable is genuinely one-key and observable before it steers
            // anything; steering stays gated on the flag at the selectModel call.
            lane: source.pace,
            pacePolicy: config.capacityRouting.pacePolicy,
          }));
        }
        const evidence = snapshots.flatMap((snapshot) => snapshot.evidence);
        const snapshotErrors = snapshots.map((snapshot) => snapshot.error).filter((value): value is string => Boolean(value));
        const malformedEvidence = evidence.some((entry) =>
          entry.health !== "unavailable" && entry.health !== "exhausted" &&
          (!entry.telemetryAvailable || entry.health === "unknown" || entry.posture === "unknown")
        );
        const incompleteModelIds = config.capacityRouting.sources.flatMap((source) =>
          source.modelIds.filter((modelId) => !evidence.some((entry) => entry.modelId === modelId))
        );
        const result = {
          snapshots,
          evidence,
          error: snapshotErrors.join("; ") || (malformedEvidence || incompleteModelIds.length > 0 ? "capacity-refresh-incomplete" : null),
          // TOG-2139: keyed by SOURCE id for storage; `storedCapacity`
          // translates to lane ids through the config. A failed pace
          // evaluation is simply absent — never an error on the refresh.
          paceVerdicts: Object.fromEntries(snapshots
            .filter((snapshot) => snapshot.pace && typeof snapshot.pace.state === "string")
            .map((snapshot) => [snapshot.source, snapshot.pace!])),
          // TOG-3551: publish a per-lane down flag keyed by SOURCE id so the
          // host dispatch-sweep / repinPass can read it straight from
          // plugin_state. A lane is down when its source fetch errored or any
          // of its evidence says the lane cannot serve (exhausted/unavailable
          // health, an unavailable posture, or a margin-aware serviceability
          // window trip). Computed from the CURRENT
          // snapshots so a failed attempt flips the flag rather than serving a
          // stale "up".
          laneDown: Object.fromEntries(snapshots.map((snapshot) => [
            snapshot.source,
            Boolean(snapshot.error) || snapshot.pace?.reason === "serviceability-window-exhausted" || snapshot.evidence.some((entry) =>
              entry.posture === "unavailable" ||
              entry.health === "exhausted" ||
              entry.health === "unavailable"),
          ])),
        };
        const key = capacityStateKey(companyId);
        const previous = asRecord(await ctx.state.get(key));
        const refreshedAt = new Date().toISOString();
        if (!result.error && result.evidence.length > 0) {
          await ctx.state.set(key, {
            ...result,
            refreshedAt,
            lastRefreshError: null,
            paceVerdicts: result.paceVerdicts,
            paceRefreshedAt: refreshedAt,
            laneDown: result.laneDown,
          });
        } else {
          await ctx.state.set(key, {
            ...previous,
            lastRefreshAttemptAt: refreshedAt,
            lastRefreshError: result.error ?? "capacity-refresh-empty",
            // Replace rather than merge: a failed source must clear its old
            // verdict immediately instead of steering with stale pace.
            paceVerdicts: result.paceVerdicts,
            paceRefreshedAt: refreshedAt,
            // TOG-3551: overwrite (never merge) laneDown from the current
            // attempt so a lane that just went down is not masked by a prior
            // "up" flag persisted in `previous`.
            laneDown: result.laneDown,
          });
        }
        return result;
      };

      const pendingInvocationKey = (companyId: string, requestId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: `${STATE_KEYS.pendingInvocations}:${requestId}`,
      });
      const pendingInvocationExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

      const deletePendingInvocation = async (companyId: string, requestId: string): Promise<void> => {
        const timerKey = `${companyId}:${requestId}`;
        const timer = pendingInvocationExpiryTimers.get(timerKey);
        if (timer) clearTimeout(timer);
        pendingInvocationExpiryTimers.delete(timerKey);
        await ctx.state.delete(pendingInvocationKey(companyId, requestId));
      };

      // ctx.state has no native TTL. One row per request makes concurrent
      // submissions independent; a worker-local timer deletes the row at its
      // deadline, and polling also deletes an expired row if the worker was
      // restarted before that timer fired.
      const schedulePendingInvocationExpiry = (
        companyId: string,
        requestId: string,
        expiresAt: string,
      ): void => {
        const timerKey = `${companyId}:${requestId}`;
        const previous = pendingInvocationExpiryTimers.get(timerKey);
        if (previous) clearTimeout(previous);
        const delayMs = Math.max(0, Date.parse(expiresAt) - Date.now());
        const timer = setTimeout(() => {
          pendingInvocationExpiryTimers.delete(timerKey);
          void ctx.state.delete(pendingInvocationKey(companyId, requestId)).catch(() => {
            ctx.logger.error("Failed to delete expired async invocation", { requestId });
          });
        }, delayMs);
        timer.unref?.();
        pendingInvocationExpiryTimers.set(timerKey, timer);
      };

      const readPendingInvocation = async (
        companyId: string,
        requestId: string,
      ): Promise<PendingInvocationRecord | null> => {
        const stored = await ctx.state.get(pendingInvocationKey(companyId, requestId));
        const entry = stored && typeof stored === "object" && !Array.isArray(stored)
          ? stored as PendingInvocationRecord
          : null;
        if (!entry || typeof entry.expiresAt !== "string") return null;
        const expiresAtMs = Date.parse(entry.expiresAt);
        if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
          await deletePendingInvocation(companyId, requestId);
          return null;
        }
        schedulePendingInvocationExpiry(companyId, requestId, entry.expiresAt);
        return entry;
      };

      const writePendingInvocation = async (companyId: string, entry: PendingInvocationRecord): Promise<void> => {
        await ctx.state.set(pendingInvocationKey(companyId, entry.requestId), entry);
        schedulePendingInvocationExpiry(companyId, entry.requestId, entry.expiresAt);
      };

      // TOG-7417: one AbortController per in-flight async upstream call, so
      // the run-end reap aborts the actual socket instead of merely marking a
      // row. Keyed like the expiry timers. Synchronous invoke never registers
      // here and its wire shape is unchanged.
      const pendingInvocationControllers = new Map<string, AbortController>();
      const pendingInvocationControllerKey = (companyId: string, requestId: string): string =>
        `${companyId}:${requestId}`;
      // TOG-7417: flags for invocations the reap settled while their
      // continuation was still in flight. The continuation checks this before
      // persisting so a late upstream outcome can never overwrite the
      // `invocation-cancelled` terminal the reap already wrote.
      const cancelledInvocationFlags = new Set<string>();

      // TOG-7417: ctx.state has no listing primitive, so the reap cannot
      // enumerate "all pending rows for run R" on its own. This index — one
      // company-scoped row per agent run holding its still-open request ids —
      // makes that enumeration explicit. Best-effort by design: a submit
      // whose index write fails still returns pending (the pending row is the
      // source of truth), and the reap prunes entries whose record is already
      // terminal or gone, so a missed removal heals on the next reap.
      const pendingRunIndexKey = (companyId: string, runId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: `${STATE_KEYS.pendingInvocationsByRun}:${runId}`,
      });

      const readRunIndex = async (companyId: string, runId: string): Promise<string[]> => {
        const stored = asRecord(await ctx.state.get(pendingRunIndexKey(companyId, runId)));
        if (!Array.isArray(stored.requestIds)) return [];
        return (stored.requestIds as unknown[]).filter((id): id is string => typeof id === "string");
      };

      const addToRunIndex = async (companyId: string, runId: string | null, requestId: string): Promise<void> => {
        if (!runId) return;
        const requestIds = await readRunIndex(companyId, runId);
        if (requestIds.includes(requestId)) return;
        await ctx.state.set(pendingRunIndexKey(companyId, runId), { requestIds: [...requestIds, requestId] });
      };

      const removeFromRunIndex = async (companyId: string, runId: string | null, requestId: string): Promise<void> => {
        if (!runId) return;
        const remaining = (await readRunIndex(companyId, runId)).filter((id) => id !== requestId);
        const key = pendingRunIndexKey(companyId, runId);
        if (remaining.length === 0) await ctx.state.delete(key);
        else await ctx.state.set(key, { requestIds: remaining });
      };

      // TOG-3419: the host clears a plugin's invocation scope the instant it
      // sends the worker's RPC response back, but invokeAsync's background
      // continuation is an unawaited promise that keeps running afterward —
      // any ctx.state/ctx.db call it makes still carries that now-stale
      // invocation id (Node's AsyncLocalStorage follows the causal chain,
      // detached promises included) and the host rejects it. These two caches
      // hold what the continuation could not persist so polling stays correct
      // immediately, and `reconcileAsyncInvocations` (run from a scheduled
      // job, which carries no invocation id and so runs under the host's
      // proactive-company grant instead) flushes them for real once it can.
      const terminalResultCache = new Map<string, { companyId: string; terminal: PendingInvocationRecord }>();
      const pendingAuditFlushes = new Map<string, {
        companyId: string;
        actor: { agentId: string | null; runId: string | null };
        request: InvokeRequest | null;
        result: InferenceResult;
        latencyMs: number;
      }>();
      const terminalCacheKey = (companyId: string, requestId: string): string => `${companyId}:${requestId}`;

      const reconcileAsyncInvocations = async (): Promise<void> => {
        for (const [key, { companyId, terminal }] of terminalResultCache) {
          if (Date.parse(terminal.expiresAt) <= Date.now()) {
            terminalResultCache.delete(key);
            continue;
          }
          try {
            await writePendingInvocation(companyId, terminal);
            terminalResultCache.delete(key);
          } catch {
            // Still unpersistable (or a transient failure) — retry next tick.
          }
        }
        for (const [requestId, pending] of pendingAuditFlushes) {
          try {
            await record(pending.companyId, pending.actor, pending.request, pending.result, pending.latencyMs);
            pendingAuditFlushes.delete(requestId);
          } catch {
            // Retry next tick.
          }
        }
      };

      const record = async (
        companyId: string,
        actor: { agentId: string | null; runId: string | null },
        request: InvokeRequest | null,
        result: InferenceResult,
        latencyMs: number,
      ) => {
        const decision = result.decision;
        const response = result.outcome === "completed" ? result.response : null;
        const failure = result.outcome === "error" ? result.error : null;
        await migrateLegacyDecisionLog(companyId);
        await persistDecisionRecord(ctx, {
          id: randomUUID(),
          companyId,
          at: new Date().toISOString(),
          requestId: result.requestId,
          agentId: actor.agentId,
          runId: actor.runId,
          issueId: request?.task.issueId ?? null,
          taskClass: decision?.taskClass ?? null,
          selectionOutcome: decision?.outcome ?? null,
          modelId: decision?.modelId ?? null,
          fallbackUsed: decision?.fallbackUsed ?? false,
          upstreamProtocol: response?.upstream.protocol ?? (decision?.outcome === "selected" ? (await companyConfig(companyId)).upstream.protocol : null),
          outcome: result.outcome,
          errorCode: failure?.code ?? null,
          upstreamStatus: failure?.upstreamStatus ?? null,
          latencyMs: Math.max(0, Math.round(latencyMs)),
          inputTokens: response?.usage.inputTokens ?? null,
          outputTokens: response?.usage.outputTokens ?? null,
          stopReason: response?.stopReason ?? null,
          upstreamRequestId: response?.upstream.requestId ?? failure?.upstreamRequestId ?? null,
          capacityMode: decision?.capacity.mode ?? null,
          capacityTelemetry: decision?.capacity.telemetry ?? null,
          capacityLane: decision?.capacity.selectedSource ?? null,
          capacityLaneLabel: decision?.capacity.selectedLaneLabel ?? null,
          capacityPosture: decision?.capacity.usagePosture ?? null,
          capacityReason: decision?.capacity.decisionReason ?? null,
          capacityDegraded: decision?.capacity.degraded ?? false,
          shadowModelId: decision?.capacity.shadowModelId ?? null,
        });
        await ctx.metrics.write(`model_router.invoke.${result.outcome}`, 1);
      };

      type PreparedInvocation = {
        requestId: string;
        startedAt: number;
        actor: { agentId: string | null; runId: string | null };
        config: RouterConfig;
        request: InvokeRequest;
        decision: RoutingDecision & { modelId: string };
        credential: string;
        selectedEntry: RouterConfig["models"][number] | undefined;
      };

      type PrepareOutcome =
        | { kind: "terminal"; result: InferenceResult }
        | { kind: "ready"; prepared: PreparedInvocation };

      // Shared fast prefix for sync and async invoke: validate config, parse the
      // request, select a model, and resolve its credential. The sync-only
      // output budget check runs immediately after selection, before stickiness
      // or secret access. Every early exit is already record()-ed.
      const prepareInvocation = async (
        companyId: string,
        raw: unknown,
        mode: "sync" | "async",
        actorContext: { agentId?: string | null; runId?: string | null; budgetSpentFraction?: unknown } = {},
      ): Promise<PrepareOutcome> => {
        const actor = {
          agentId: actorContext.agentId ?? null,
          runId: actorContext.runId ?? null,
        };
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
          await record(companyId, actor, request, result, Date.now() - startedAt);
          return { kind: "terminal", result };
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
          await record(companyId, actor, request, result, Date.now() - startedAt);
          return { kind: "terminal", result };
        }

        const capacity = config.capacityRouting.enabled
          ? await storedCapacity(companyId, config)
          : { snapshots: [], evidence: [], error: null, paceVerdicts: {}, modelLaneByPace: {} };
        // TOG-7417: the host injects the authoritative spent fraction through
        // the tool/action context (a channel the caller cannot write to) and
        // it wins over the caller-claimed task.signals value, which any
        // caller can forge to dodge the halt gate or force a downshift.
        // TOG-7891 (Gap G4): the company-scoped monthly spend ledger from
        // decision_records folds in as the primary trusted source — it
        // measures exactly the capped quantity, so a readable ledger beats a
        // forged-low caller claim. The host injection stays because the host
        // may track spend outside decision_records; both trusted sources
        // count and the HIGHER wins. The engine (gate movement in
        // selectModel) is unchanged — only the fraction's source changes here.
        const authoritativeBudgetSpentFraction =
          extractAuthoritativeBudgetSpentFraction(actorContext);
        const monthlyLedger = await readMonthlySpendLedger(
          ctx.db, ctx.logger, companyId, config, new Date(),
        );
        const effectiveBudget = resolveEffectiveBudgetSpentFraction(
          monthlyLedger.fraction,
          authoritativeBudgetSpentFraction,
          request.task.signals?.budgetSpentFraction,
        );
        const decision = selectModel({
          descriptor: request.task,
          config,
          signals: {
            budgetSpentFraction: effectiveBudget.fraction,
            budgetFractionSource: effectiveBudget.source === "none" ? "unspecified" : effectiveBudget.source,
            ...(monthlyLedger.ledger && effectiveBudget.source === "ledger"
              ? { budgetLedger: { totalUsd: monthlyLedger.ledger.totalUsd, monthLabel: monthlyLedger.ledger.monthLabel } }
              : {}),
            capacityEvidence: capacity.evidence,
            capacityError: capacity.error ?? undefined,
            paceVerdicts: config.capacityRouting.paceOrdering ? capacity.paceVerdicts : undefined,
            modelLaneByPace: config.capacityRouting.paceOrdering ? capacity.modelLaneByPace : undefined,
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
          await record(companyId, actor, request, result, Date.now() - startedAt);
          return { kind: "terminal", result };
        }

        // The selected id, not the requested one: under capacity enforce those
        // differ, and the budget has to follow the model actually being invoked.
        const selectedEntry = config.models.find((model) => model.id === decision.modelId);
        if (mode === "sync") {
          const maxSyncOutputTokens = effectiveMaxSyncOutputTokens(
            config.upstream.requestTimeoutMs,
            selectedEntry?.requestTimeoutMs,
            selectedEntry?.maxSyncOutputTokens,
          );
          if (request.maxOutputTokens > maxSyncOutputTokens) {
            result = {
              outcome: "error",
              requestId,
              decision,
              response: null,
              error: {
                code: "invalid-request",
                message: `maxOutputTokens (${request.maxOutputTokens}) is not reachable within the synchronous invoke budget for model ${decision.modelId} (up to ${maxSyncOutputTokens} tokens). Use ${TOOL_NAMES.invokeAsync} for longer generations.`,
                retryable: false,
                upstreamStatus: null,
                upstreamRequestId: null,
              },
            };
            await record(companyId, actor, request, result, Date.now() - startedAt);
            return { kind: "terminal", result };
          }
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
          await record(companyId, actor, request, result, Date.now() - startedAt);
          return { kind: "terminal", result };
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
          await record(companyId, actor, request, result, Date.now() - startedAt);
          return { kind: "terminal", result };
        }

        return {
          kind: "ready",
          prepared: {
            requestId,
            startedAt,
            actor,
            config,
            request,
            decision: decision as RoutingDecision & { modelId: string },
            credential,
            selectedEntry,
          },
        };
      };

      const invokeFor = async (
        companyId: string,
        raw: unknown,
        actorContext: { agentId?: string | null; runId?: string | null; budgetSpentFraction?: unknown } = {},
      ): Promise<InferenceResult> => {
        const prepared = await prepareInvocation(companyId, raw, "sync", actorContext);
        if (prepared.kind === "terminal") return prepared.result;
        const { requestId, startedAt, actor, config, request, decision, credential, selectedEntry } = prepared.prepared;

        const transport = await invokeCompatibleUpstream({
          http: ctx.http,
          config: config.upstream,
          credential,
          request,
          modelId: decision.modelId,
          ...(selectedEntry?.requestTimeoutMs !== undefined
            ? { modelTimeoutMs: selectedEntry.requestTimeoutMs }
            : {}),
        });
        const result: InferenceResult = transport.error
          ? { outcome: "error", requestId, decision, response: null, error: transport.error }
          : { outcome: "completed", requestId, decision, response: transport.response, error: null };
        await record(companyId, actor, request, result, Date.now() - startedAt);
        return result;
      };

      const invokeAsyncFor = async (
        companyId: string,
        raw: unknown,
        actorContext: { agentId?: string | null; runId?: string | null; budgetSpentFraction?: unknown } = {},
      ): Promise<AsyncInvokeResult> => {
        const prepared = await prepareInvocation(companyId, raw, "async", actorContext);
        if (prepared.kind === "terminal") return prepared.result;
        const { requestId, startedAt, actor, config, request, decision, credential, selectedEntry } = prepared.prepared;

        // TOG-7417: one AbortController per in-flight call. Register before
        // the continuation starts; the reap aborts this controller, which is
        // what terminates the real upstream socket.
        const abortController = new AbortController();
        const controllerKey = pendingInvocationControllerKey(companyId, requestId);
        pendingInvocationControllers.set(controllerKey, abortController);

        const startedAtIso = new Date(startedAt).toISOString();
        const expiresAt = new Date(startedAt + PENDING_INVOCATION_TTL_MS).toISOString();
        await writePendingInvocation(companyId, {
          status: "pending",
          requestId,
          decision,
          startedAt: startedAtIso,
          expiresAt,
          runId: actor.runId,
          agentId: actor.agentId,
        });
        // Best-effort: a submit whose index write fails still returns pending
        // (the pending row is the source of truth); the reap prunes stale
        // index entries against the record, so a failure heals on next reap.
        try {
          await addToRunIndex(companyId, actor.runId, requestId);
        } catch {
          ctx.logger.warn("Could not index async invocation by run; run-end reap may miss it", { requestId });
        }

        // Deliberately not awaited: the handler returns "pending" now while
        // this keeps running in the same long-lived worker process (spike
        // confirmed both assumptions this relies on, see TOG-3419 comments).
        // Transport, terminal-state, and audit failures are isolated so a
        // bookkeeping error can never rewrite a successful upstream outcome.
        void (async () => {
          let result: InferenceResult;
          try {
            const transport = await invokeCompatibleUpstream({
              // Direct worker `fetch`, not `ctx.http`: the host bridge aborts at
              // 30s, which is the exact cap async invoke exists to escape. See
              // directFetchHttpClient for the SSRF/timeout rationale. The sync
              // path above deliberately keeps `ctx.http` and its 30s ceiling.
              http: directFetchHttpClient,
              config: config.upstream,
              credential,
              request,
              modelId: decision.modelId,
              ...(selectedEntry?.requestTimeoutMs !== undefined
                ? { modelTimeoutMs: selectedEntry.requestTimeoutMs }
                : {}),
              // TOG-7417: the run-end reap aborts this signal.
              signal: abortController.signal,
            });
            result = transport.error
              ? { outcome: "error", requestId, decision, response: null, error: transport.error }
              : { outcome: "completed", requestId, decision, response: transport.response, error: null };
          } catch {
            result = {
              outcome: "error",
              requestId,
              decision,
              response: null,
              error: {
                code: "upstream-connect",
                message: "The async invocation failed unexpectedly.",
                retryable: true,
                upstreamStatus: null,
                upstreamRequestId: null,
              },
            };
          } finally {
            // The call settled: nothing left to abort. Reap-after-settle finds
            // no controller and goes straight to record inspection.
            pendingInvocationControllers.delete(controllerKey);
          }

          // TOG-7417: the reap may have settled this invocation to
          // `invocation-cancelled` while the call was in flight. A late
          // upstream outcome must never overwrite it. The flag covers the
          // common case (the call was still in flight when the reap ran, so
          // a controller existed to flag); the re-read covers the narrow
          // interleave where the call settled between the reap's settle and
          // this write. Either way the observed outcome is still audited —
          // the decision record is history, the pending row is state.
          let reaped = cancelledInvocationFlags.has(controllerKey);
          if (!reaped) {
            try {
              const current = await readPendingInvocation(companyId, requestId);
              reaped = !!current && current.status !== "pending";
            } catch {
              // Detached-scope read failure (TOG-3419): fall through and
              // persist; the reconcile job converges the row.
              reaped = false;
            }
          }
          if (reaped) {
            cancelledInvocationFlags.delete(controllerKey);
            try {
              await record(companyId, actor, request, result, Date.now() - startedAt);
            } catch {
              pendingAuditFlushes.set(requestId, {
                companyId,
                actor,
                request,
                result,
                latencyMs: Date.now() - startedAt,
              });
              ctx.logger.warn(
                "Could not persist async invocation audit record from its own continuation; reconcileAsyncInvocations will retry",
                { requestId },
              );
            }
            return;
          }

          const terminal: PendingInvocationRecord = result.outcome === "completed"
            ? { status: "completed", requestId, decision, outcome: "completed", response: result.response, error: null, startedAt: startedAtIso, expiresAt, runId: actor.runId, agentId: actor.agentId }
            : { status: "error", requestId, decision, outcome: "error", response: null, error: result.error, startedAt: startedAtIso, expiresAt, runId: actor.runId, agentId: actor.agentId };
          // Always cache the terminal result locally first: polling must see
          // it immediately regardless of whether the host lets this detached
          // continuation persist it (see TOG-3419 — it usually can't).
          terminalResultCache.set(terminalCacheKey(companyId, requestId), { companyId, terminal });
          try {
            await writePendingInvocation(companyId, terminal);
            terminalResultCache.delete(terminalCacheKey(companyId, requestId));
          } catch {
            ctx.logger.warn(
              "Could not persist async invocation outcome from its own continuation; reconcileAsyncInvocations will retry",
              { requestId },
            );
          }
          // TOG-7417: the record reached its terminal state — leave the run
          // index (and the reap's view of this run) even when persistence of
          // the terminal row itself is still queued for the reconcile job.
          try {
            await removeFromRunIndex(companyId, actor.runId, requestId);
          } catch {
            ctx.logger.warn(
              "Could not remove async invocation from the run index; the run-end reap prunes stale index entries",
              { requestId },
            );
          }
          try {
            await record(companyId, actor, request, result, Date.now() - startedAt);
          } catch {
            pendingAuditFlushes.set(requestId, {
              companyId,
              actor,
              request,
              result,
              latencyMs: Date.now() - startedAt,
            });
            ctx.logger.warn(
              "Could not persist async invocation audit record from its own continuation; reconcileAsyncInvocations will retry",
              { requestId },
            );
          }
        })().catch(() => {
          ctx.logger.error("Async invocation continuation failed unexpectedly", { requestId });
        });

        return { status: "pending", requestId, decision };
      };

      // TOG-7417: run-end reap. The host calls this when an agent run
      // finishes so async invocations that run outlives are aborted and
      // settled to a terminal outcome instead of lingering to TTL (the CISO
      // D3 precondition on widening router-invoke access). For every request
      // id in the run's index:
      // - still pending: abort its in-flight upstream socket (when the worker
      //   that started it is still alive to hold the controller), mark the
      //   late-outcome flag so the continuation cannot overwrite the terminal
      //   below, and settle the row to error/invocation-cancelled with an
      //   audit record;
      // - already terminal or gone (TTL, another reap, a worker restart that
      //   lost the controllers): prune the index entry and report it as
      //   already-terminal, never as cancelled.
      // Idempotent: a second call for the same run finds empty/index-miss
      // rows and reports zeroes. Never throws on storage failures — it
      // reports how many it could not settle so the host can retry.
      const cancelRunInvocationsFor = async (
        companyId: string,
        runId: string,
      ): Promise<{ runId: string; cancelled: string[]; alreadyTerminal: string[]; failed: string[] }> => {
        const outcome: { runId: string; cancelled: string[]; alreadyTerminal: string[]; failed: string[] } = {
          runId,
          cancelled: [],
          alreadyTerminal: [],
          failed: [],
        };
        let requestIds: string[];
        try {
          requestIds = await readRunIndex(companyId, runId);
        } catch {
          ctx.logger.warn("Could not read the run invocation index for run-end reap", { runId });
          return outcome;
        }
        for (const requestId of requestIds) {
          const controllerKey = pendingInvocationControllerKey(companyId, requestId);
          let stored: PendingInvocationRecord | null = null;
          try {
            stored = await readPendingInvocation(companyId, requestId);
          } catch {
            outcome.failed.push(requestId);
            continue;
          }
          if (!stored || stored.status !== "pending") {
            try {
              await removeFromRunIndex(companyId, runId, requestId);
            } catch {
              // Pruning is hygiene; the stale entry heals on the next reap.
            }
            outcome.alreadyTerminal.push(requestId);
            continue;
          }
          const controller = pendingInvocationControllers.get(controllerKey);
          if (controller) {
            // Settle the terminal BEFORE aborting: once aborted, the
            // continuation's transport resolves and it must see the flag.
            cancelledInvocationFlags.add(controllerKey);
            controller.abort();
            pendingInvocationControllers.delete(controllerKey);
          }
          const cancelledTerminal: PendingInvocationRecord = {
            status: "error",
            requestId,
            decision: stored.decision,
            outcome: "error",
            response: null,
            error: {
              code: "invocation-cancelled",
              message: "The invocation was cancelled when its agent run ended.",
              retryable: false,
              upstreamStatus: null,
              upstreamRequestId: null,
            },
            startedAt: stored.startedAt,
            expiresAt: stored.expiresAt,
            runId: stored.runId ?? runId,
            agentId: stored.agentId ?? null,
          };
          const reapActor = { agentId: stored.agentId ?? null, runId: stored.runId ?? runId };
          terminalResultCache.set(terminalCacheKey(companyId, requestId), { companyId, terminal: cancelledTerminal });
          try {
            await writePendingInvocation(companyId, cancelledTerminal);
            terminalResultCache.delete(terminalCacheKey(companyId, requestId));
          } catch {
            outcome.failed.push(requestId);
            continue;
          }
          try {
            await removeFromRunIndex(companyId, runId, requestId);
          } catch {
            ctx.logger.warn(
              "Could not remove a reaped invocation from the run index; the next reap prunes it",
              { requestId },
            );
          }
          try {
            await record(companyId, reapActor, null, {
              outcome: "error",
              requestId,
              decision: stored.decision,
              response: null,
              error: cancelledTerminal.error,
            }, Date.now() - Date.parse(stored.startedAt));
          } catch {
            pendingAuditFlushes.set(requestId, {
              companyId,
              actor: reapActor,
              request: null,
              result: {
                outcome: "error",
                requestId,
                decision: stored.decision,
                response: null,
                error: cancelledTerminal.error,
              },
              latencyMs: Date.now() - Date.parse(stored.startedAt),
            });
          }
          outcome.cancelled.push(requestId);
        }
        return outcome;
      };

      const invokeResultFor = async (companyId: string, requestId: string): Promise<PollResult> => {
        if (!requestId) return { status: "not-found" };
        const cached = terminalResultCache.get(terminalCacheKey(companyId, requestId));
        if (cached && Date.parse(cached.terminal.expiresAt) > Date.now()) return cached.terminal;
        return await readPendingInvocation(companyId, requestId) ?? { status: "not-found" };
      };

      invoke = invokeFor;
      invokeAsync = invokeAsyncFor;
      invokeResult = invokeResultFor;
      await pruneDecisionRecords();

      ctx.tools.register(
        TOOL_NAMES.invoke,
        {
          displayName: "Invoke a routed model",
          description: "Select, invoke once, normalize, and audit using the host-authorized company scope.",
          parametersSchema: { type: "object" },
        },
        async (params, runCtx): Promise<ToolResult> => {
          const result = await invokeFor(runCtx.companyId, params, runCtx);
          return { content: summary(result), data: result };
        },
      );

      ctx.actions.register(ACTION_KEYS.invoke, async (params, actionCtx) => {
        if (!actionCtx.companyId) throw new Error("host-authorized company context is required");
        const { companyId: _hostInjectedCompanyId, ...request } = params;
        return invokeFor(actionCtx.companyId, request, actionCtx.actor);
      });

      ctx.tools.register(
        TOOL_NAMES.invokeAsync,
        {
          displayName: "Invoke a routed model asynchronously",
          description: "Select, submit the generation in the background, and return a requestId immediately. Poll model_router_invoke_result for the outcome.",
          parametersSchema: { type: "object" },
        },
        async (params, runCtx): Promise<ToolResult> => {
          const result = await invokeAsyncFor(runCtx.companyId, params, runCtx);
          return {
            content: "status" in result
              ? `Invocation ${result.requestId} accepted; poll ${TOOL_NAMES.invokeResult} for its result.`
              : summary(result),
            data: result,
          };
        },
      );

      ctx.tools.register(
        TOOL_NAMES.invokeResult,
        {
          displayName: "Poll an async model invocation",
          description: "Read the current status of a model_router_invoke_async submission by requestId.",
          parametersSchema: { type: "object" },
        },
        async (params, runCtx): Promise<ToolResult> => {
          const requestId = typeof (params as Record<string, unknown>).requestId === "string"
            ? (params as Record<string, unknown>).requestId as string
            : "";
          const result = await invokeResultFor(runCtx.companyId, requestId);
          return { content: `Invocation ${requestId || "(missing)"} is ${result.status}.`, data: result };
        },
      );

      ctx.actions.register(ACTION_KEYS.invokeAsync, async (params, actionCtx) => {
        if (!actionCtx.companyId) throw new Error("host-authorized company context is required");
        const { companyId: _hostInjectedCompanyId, ...request } = params;
        return invokeAsyncFor(actionCtx.companyId, request, actionCtx.actor);
      });

      ctx.actions.register(ACTION_KEYS.invokeResult, async (params, actionCtx) => {
        if (!actionCtx.companyId) throw new Error("host-authorized company context is required");
        const requestId = typeof params.requestId === "string" ? params.requestId : "";
        return invokeResultFor(actionCtx.companyId, requestId);
      });

      ctx.actions.register(ACTION_KEYS.refreshCapacity, async (_params, actionCtx) => {
        if (!actionCtx.companyId) throw new Error("host-authorized company context is required");
        return refreshCapacity(actionCtx.companyId, await companyConfig(actionCtx.companyId)) as unknown as Record<string, unknown>;
      });

      ctx.actions.register(ACTION_KEYS.cancelRunInvocations, async (params, actionCtx) => {
        if (!actionCtx.companyId) throw new Error("host-authorized company context is required");
        const runId = typeof params.runId === "string" && params.runId.length > 0 ? params.runId : "";
        if (!runId) throw new Error("runId is required");
        return cancelRunInvocationsFor(actionCtx.companyId, runId);
      });

      ctx.jobs.register(JOB_KEYS.reconcileAsyncInvocations, reconcileAsyncInvocations);

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
        if (model.requestTimeoutMs !== undefined &&
            (!Number.isInteger(model.requestTimeoutMs) ||
              model.requestTimeoutMs < MIN_REQUEST_TIMEOUT_MS ||
              model.requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS)) {
          errors.push(`model ${model.id} requestTimeoutMs must be an integer from ${MIN_REQUEST_TIMEOUT_MS} through ${MAX_REQUEST_TIMEOUT_MS}`);
        }
        if (model.maxSyncOutputTokens !== undefined &&
            (!Number.isInteger(model.maxSyncOutputTokens) || model.maxSyncOutputTokens < 1)) {
          errors.push(`model ${model.id} maxSyncOutputTokens must be a positive integer`);
        }
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
      if (!context || !invoke || !invokeAsync || !invokeResult) {
        return { status: 503, body: { error: "worker is not initialised" } };
      }
      const actor = {
        agentId: input.actor.agentId ?? (input.actor.actorType === "agent" ? input.actor.actorId : null),
        runId: input.actor.runId ?? null,
      };
      if (input.routeKey === ROUTE_KEYS.invoke || input.routeKey === ROUTE_KEYS.invokeIssue) {
        const body = asRecord(input.body);
        const request = input.routeKey === ROUTE_KEYS.invokeIssue
          ? { ...body, task: { ...asRecord(body.task), issueId: input.params.issueId } }
          : body;
        const result = await invoke(input.companyId, request, actor);
        return { status: result.outcome === "error" && result.error.code === "invalid-request" ? 400 : 200, body: result };
      }
      if (input.routeKey === ROUTE_KEYS.invokeAsync) {
        const body = asRecord(input.body);
        const result = await invokeAsync(input.companyId, body, actor);
        const status = "status" in result
          ? 202
          : result.outcome === "error" && result.error.code === "invalid-request" ? 400 : 200;
        return { status, body: result };
      }
      if (input.routeKey === ROUTE_KEYS.invokeResult) {
        const requestId = typeof input.params.requestId === "string" ? input.params.requestId : "";
        const result = await invokeResult(input.companyId, requestId);
        return { status: 200, body: result };
      }
      return { status: 404, body: { error: `unknown route ${input.routeKey}` } };
    },
  });
}

const plugin = createPlugin();
export default plugin;
runWorker(plugin, import.meta.url);
