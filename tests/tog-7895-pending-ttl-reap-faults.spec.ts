/**
 * TOG-7895 (gap G12): deterministic fault-injection tests for pending-row TTL
 * expiry and run-end reap under storage failure.
 *
 * `src/constants.ts` PENDING_INVOCATION_TTL_MS (15 min) and reap idempotency
 * are code-reviewed but were only exercised on happy paths: the TTL test in
 * `worker.spec.ts` never resolves the late upstream call, and the reap tests
 * in `tog-7417-run-reap.spec.ts` never fail storage mid-reap. This spec
 * injects each fault deterministically — no wall-clock waits, no fake timers:
 *
 * - expiry mid-poll: state surgery rewrites the row's `expiresAt` to the past
 *   while the upstream call is still in flight (a hung fetch gate);
 * - reap vs late outcome: a deferred fetch gate controls exactly when the
 *   upstream outcome lands relative to the reap;
 * - storage failure: `harness.ctx.state` / `harness.ctx.db` wrappers throw on
 *   the exact key/statement under test, then heal so the retry converges.
 *
 * Acceptance pins: rows always end terminal, audit-complete, and a late
 * outcome never overwrites a reaped terminal. Each test fails if the
 * production behavior it pins is removed (flag check, re-read, lazy expiry,
 * never-throw reap, reconcile flush).
 */
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ACTION_KEYS, JOB_KEYS, PENDING_INVOCATION_TTL_MS, STATE_KEYS } from "../src/constants.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { companyDecisionRecords, readFixture } from "./helpers.js";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const SECRET_A = "resolved-secret-a";

function success(protocol: "openai" | "anthropic") {
  return protocol === "openai"
    ? new Response(JSON.stringify({ id: "chatcmpl-1", object: "chat.completion", model: "echo-a", choices: [{ index: 0, message: { role: "assistant", content: "hello a" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "request-a" } })
    : new Response(JSON.stringify({ id: "msg-1", type: "message", role: "assistant", model: "echo-b", content: [{ type: "text", text: "hello b" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 4, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json", "request-id": "request-b" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let detached async continuations (transport parse, state writes, audit) drain. */
async function settleTicks(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function sharedWorker() {
  const configs = new Map([[COMPANY_A, readFixture("company-a")]]);
  const harness = createTestHarness({ manifest, config: {} });
  harness.ctx.config = {
    async get(companyId) {
      const config = configs.get(String(companyId));
      if (!config) throw new Error("missing company config");
      return structuredClone(config);
    },
  };
  harness.ctx.secrets = {
    async resolve(_ref, options) {
      return options?.companyId === COMPANY_A ? SECRET_A : "resolved-secret-other";
    },
  };
  harness.ctx.http = {
    async fetch(url) {
      return String(url).includes("company-a.example") ? success("openai") : success("anthropic");
    },
  };
  vi.stubGlobal("fetch", async (url: string) => success(String(url).includes("company-a.example") ? "openai" : "anthropic"));
  const { definition } = createPlugin();
  await definition.setup(harness.ctx);
  return { harness };
}

const invocation = {
  task: { taskClass: "implementation", issueId: "issue-1" },
  messages: [{ role: "user", content: "hello" }],
  maxOutputTokens: 100,
};

const pendingRowKey = (requestId: string) => ({
  scopeKind: "company" as const,
  scopeId: COMPANY_A,
  stateKey: `${STATE_KEYS.pendingInvocations}:${requestId}`,
});

const runIndexKey = (runId: string) => ({
  scopeKind: "company" as const,
  scopeId: COMPANY_A,
  stateKey: `${STATE_KEYS.pendingInvocationsByRun}:${runId}`,
});

async function submitInFlight(harness: Awaited<ReturnType<typeof sharedWorker>>["harness"], runId: string, gate: ReturnType<typeof deferred<Response>>) {
  vi.stubGlobal("fetch", async () => gate.promise);
  const submitted = await harness.performAction(ACTION_KEYS.invokeAsync, invocation, {
    companyId: COMPANY_A,
    actor: { type: "agent", agentId: "agent-a", runId },
  }) as { requestId: string };
  expect(submitted.requestId).toMatch(/^[0-9a-f-]{36}$/);
  return submitted;
}

/** Rewrite the row's expiresAt to the past: deterministic TTL expiry without waiting 15 minutes. */
async function expireRow(harness: Awaited<ReturnType<typeof sharedWorker>>["harness"], requestId: string) {
  const row = harness.getState(pendingRowKey(requestId)) as Record<string, unknown>;
  expect(row).toMatchObject({ status: "pending", requestId });
  await harness.ctx.state.set(pendingRowKey(requestId), {
    ...row,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TOG-7895 pending-row TTL + reap fault injection", () => {
  describe("expiry mid-poll", () => {
    it("an expired row polls not-found; a late upstream success still audits but never resurrects the row", async () => {
      const { harness } = await sharedWorker();
      const gate = deferred<Response>();
      const submitted = await submitInFlight(harness, "run-a", gate);

      // The submitted row carries the 15-minute TTL wired from constants.
      const row = harness.getState(pendingRowKey(submitted.requestId)) as Record<string, unknown>;
      expect(Date.parse(String(row.expiresAt)) - Date.parse(String(row.startedAt))).toBe(PENDING_INVOCATION_TTL_MS);

      await expireRow(harness, submitted.requestId);

      // Polling past the deadline lazily expires the row: not-found, and the
      // state row is deleted (not left as a stale pending).
      await expect(harness.performAction(
        ACTION_KEYS.invokeResult,
        { requestId: submitted.requestId },
        { companyId: COMPANY_A },
      )).resolves.toEqual({ status: "not-found" });
      expect(harness.getState(pendingRowKey(submitted.requestId))).toBeUndefined();

      // The hung upstream finally succeeds. The continuation must still audit
      // the observed outcome (audit-complete) …
      gate.resolve(success("openai"));
      await settleTicks();
      const audits = companyDecisionRecords(harness, COMPANY_A).filter((record) => record.requestId === submitted.requestId);
      expect(audits).toMatchObject([{ outcome: "completed", runId: "run-a", agentId: "agent-a" }]);

      // … but the late outcome must never resurrect a pollable row: the
      // terminal it wrote carries the already-past expiresAt, so polling
      // still reports not-found and the run index is pruned.
      await expect(harness.performAction(
        ACTION_KEYS.invokeResult,
        { requestId: submitted.requestId },
        { companyId: COMPANY_A },
      )).resolves.toEqual({ status: "not-found" });
      expect(harness.getState(pendingRowKey(submitted.requestId))).toBeUndefined();
      expect(harness.getState(runIndexKey("run-a"))).toBeUndefined();
    });

    it("reap of an expired row reports already-terminal, never cancelled", async () => {
      const { harness } = await sharedWorker();
      const gate = deferred<Response>();
      const submitted = await submitInFlight(harness, "run-a", gate);
      await expireRow(harness, submitted.requestId);

      const reaped = await harness.performAction(ACTION_KEYS.cancelRunInvocations, { runId: "run-a" }, { companyId: COMPANY_A });
      expect(reaped).toEqual({ runId: "run-a", cancelled: [], alreadyTerminal: [submitted.requestId], failed: [] });

      // The reap pruned the stale index entry and never wrote a terminal: a
      // later poll still reports not-found, not invocation-cancelled.
      expect(harness.getState(runIndexKey("run-a"))).toBeUndefined();
      await expect(harness.performAction(
        ACTION_KEYS.invokeResult,
        { requestId: submitted.requestId },
        { companyId: COMPANY_A },
      )).resolves.toEqual({ status: "not-found" });

      // Let the hung call settle so no dangling continuation outlives the test.
      gate.resolve(success("openai"));
      await settleTicks();
    });
  });

  describe("reap racing a late upstream outcome", () => {
    it("reap wins: the row stays invocation-cancelled, both sides audit", async () => {
      const { harness } = await sharedWorker();
      const gate = deferred<Response>();
      const submitted = await submitInFlight(harness, "run-a", gate);

      const reaped = await harness.performAction(ACTION_KEYS.cancelRunInvocations, { runId: "run-a" }, { companyId: COMPANY_A });
      expect(reaped).toEqual({ runId: "run-a", cancelled: [submitted.requestId], alreadyTerminal: [], failed: [] });

      // The late upstream success lands after the reap settled the terminal.
      gate.resolve(success("openai"));
      await settleTicks();

      // The late outcome never overwrote the reaped terminal …
      const polled = await harness.performAction(
        ACTION_KEYS.invokeResult,
        { requestId: submitted.requestId },
        { companyId: COMPANY_A },
      );
      expect(polled).toMatchObject({ status: "error", error: { code: "invocation-cancelled", retryable: false } });
      expect(harness.getState(pendingRowKey(submitted.requestId))).toMatchObject({
        status: "error",
        error: { code: "invocation-cancelled" },
      });

      // … and both sides are audit-complete: the reap's cancellation record
      // plus the continuation's audit-only record of the observed outcome.
      const audits = companyDecisionRecords(harness, COMPANY_A).filter((record) => record.requestId === submitted.requestId);
      expect(audits).toHaveLength(2);
      expect(audits).toEqual(expect.arrayContaining([
        expect.objectContaining({ outcome: "error", errorCode: "invocation-cancelled", runId: "run-a" }),
        expect.objectContaining({ outcome: "completed", runId: "run-a" }),
      ]));
    });

    it("outcome wins: reap of a settled row reports already-terminal and leaves it untouched", async () => {
      const { harness } = await sharedWorker();
      const submitted = await harness.performAction(ACTION_KEYS.invokeAsync, invocation, {
        companyId: COMPANY_A,
        actor: { type: "agent", agentId: "agent-a", runId: "run-a" },
      }) as { requestId: string };
      await settleTicks();

      // The call completed on its own and left the index; a stale index entry
      // (missed removal, worker restart) races a reap against the terminal.
      await expect(harness.performAction(
        ACTION_KEYS.invokeResult,
        { requestId: submitted.requestId },
        { companyId: COMPANY_A },
      )).resolves.toMatchObject({ status: "completed", outcome: "completed" });
      await harness.ctx.state.set(runIndexKey("run-a"), { requestIds: [submitted.requestId, "ghost-never-submitted"] });

      const reaped = await harness.performAction(ACTION_KEYS.cancelRunInvocations, { runId: "run-a" }, { companyId: COMPANY_A });
      expect(reaped).toEqual({
        runId: "run-a",
        cancelled: [],
        alreadyTerminal: [submitted.requestId, "ghost-never-submitted"],
        failed: [],
      });

      // The settled terminal is untouched and the stale index healed.
      await expect(harness.performAction(
        ACTION_KEYS.invokeResult,
        { requestId: submitted.requestId },
        { companyId: COMPANY_A },
      )).resolves.toMatchObject({ status: "completed", outcome: "completed" });
      expect(harness.getState(runIndexKey("run-a"))).toBeUndefined();
    });
  });

  describe("storage throws mid-reap", () => {
    it("unreadable run index: the reap reports empty, never throws; a retry settles terminal + audited", async () => {
      const { harness } = await sharedWorker();
      const gate = deferred<Response>();
      const submitted = await submitInFlight(harness, "run-a", gate);

      const originalGet = harness.ctx.state.get.bind(harness.ctx.state);
      harness.ctx.state.get = async (key) => {
        if (key.stateKey === runIndexKey("run-a").stateKey) throw new Error("injected index read failure");
        return originalGet(key);
      };

      const reaped = await harness.performAction(ACTION_KEYS.cancelRunInvocations, { runId: "run-a" }, { companyId: COMPANY_A });
      expect(reaped).toEqual({ runId: "run-a", cancelled: [], alreadyTerminal: [], failed: [] });
      expect(harness.getState(pendingRowKey(submitted.requestId))).toMatchObject({ status: "pending" });

      // Heal and retry: the row ends terminal and audit-complete.
      harness.ctx.state.get = originalGet;
      const retried = await harness.performAction(ACTION_KEYS.cancelRunInvocations, { runId: "run-a" }, { companyId: COMPANY_A });
      expect(retried).toEqual({ runId: "run-a", cancelled: [submitted.requestId], alreadyTerminal: [], failed: [] });
      expect(harness.getState(pendingRowKey(submitted.requestId))).toMatchObject({
        status: "error",
        error: { code: "invocation-cancelled" },
      });
      expect(companyDecisionRecords(harness, COMPANY_A)).toMatchObject([{
        requestId: submitted.requestId,
        outcome: "error",
        errorCode: "invocation-cancelled",
      }]);

      gate.resolve(success("openai"));
      await settleTicks();
    });

    it("unreadable row for one of two invocations: partial outcome; a retry settles the failed one", async () => {
      const { harness } = await sharedWorker();
      const goodGate = deferred<Response>();
      const badGate = deferred<Response>();
      const good = await submitInFlight(harness, "run-a", goodGate);
      const bad = await submitInFlight(harness, "run-a", badGate);

      const originalGet = harness.ctx.state.get.bind(harness.ctx.state);
      harness.ctx.state.get = async (key) => {
        if (key.stateKey === pendingRowKey(bad.requestId).stateKey) throw new Error("injected row read failure");
        return originalGet(key);
      };

      const reaped = await harness.performAction(ACTION_KEYS.cancelRunInvocations, { runId: "run-a" }, { companyId: COMPANY_A });
      expect(reaped).toEqual({ runId: "run-a", cancelled: [good.requestId], alreadyTerminal: [], failed: [bad.requestId] });
      expect(harness.getState(pendingRowKey(good.requestId))).toMatchObject({
        status: "error",
        error: { code: "invocation-cancelled" },
      });
      // The unreadable row is untouched: still pending, still indexed.
      expect(harness.getState(pendingRowKey(bad.requestId))).toMatchObject({ status: "pending" });

      // Heal and retry: the failed row converges to the same terminal.
      harness.ctx.state.get = originalGet;
      const retried = await harness.performAction(ACTION_KEYS.cancelRunInvocations, { runId: "run-a" }, { companyId: COMPANY_A });
      expect(retried).toEqual({ runId: "run-a", cancelled: [bad.requestId], alreadyTerminal: [], failed: [] });
      for (const requestId of [good.requestId, bad.requestId]) {
        expect(harness.getState(pendingRowKey(requestId))).toMatchObject({
          status: "error",
          error: { code: "invocation-cancelled" },
        });
      }
      const cancellations = companyDecisionRecords(harness, COMPANY_A).filter((record) => record.errorCode === "invocation-cancelled");
      expect(cancellations).toHaveLength(2);

      goodGate.resolve(success("openai"));
      badGate.resolve(success("openai"));
      await settleTicks();
    });

    it("terminal write fails: polling still serves cancelled from cache; reconcile + late settle converge", async () => {
      const { harness } = await sharedWorker();
      const gate = deferred<Response>();
      const submitted = await submitInFlight(harness, "run-a", gate);

      const originalSet = harness.ctx.state.set.bind(harness.ctx.state);
      harness.ctx.state.set = async (key, value) => {
        if (key.stateKey === pendingRowKey(submitted.requestId).stateKey) throw new Error("injected terminal write failure");
        return originalSet(key, value);
      };

      const reaped = await harness.performAction(ACTION_KEYS.cancelRunInvocations, { runId: "run-a" }, { companyId: COMPANY_A });
      expect(reaped).toEqual({ runId: "run-a", cancelled: [], alreadyTerminal: [], failed: [submitted.requestId] });

      // The terminal never reached storage, but polling still serves the
      // cancelled outcome from the reconcile cache — no window where the row
      // looks pending again.
      await expect(harness.performAction(
        ACTION_KEYS.invokeResult,
        { requestId: submitted.requestId },
        { companyId: COMPANY_A },
      )).resolves.toMatchObject({ status: "error", error: { code: "invocation-cancelled" } });
      expect(companyDecisionRecords(harness, COMPANY_A)).toHaveLength(0);

      // Heal and run the scheduled job: the cached terminal persists, and the
      // queued cancellation audit (TOG-7895 fix) flushes with it.
      harness.ctx.state.set = originalSet;
      await harness.runJob(JOB_KEYS.reconcileAsyncInvocations);
      expect(harness.getState(pendingRowKey(submitted.requestId))).toMatchObject({
        status: "error",
        error: { code: "invocation-cancelled" },
      });
      expect(companyDecisionRecords(harness, COMPANY_A)).toMatchObject([{
        requestId: submitted.requestId,
        errorCode: "invocation-cancelled",
      }]);

      // The late upstream outcome (the socket was already aborted) still
      // audits without overwriting the terminal.
      gate.resolve(success("openai"));
      await settleTicks();
      const polled = await harness.performAction(
        ACTION_KEYS.invokeResult,
        { requestId: submitted.requestId },
        { companyId: COMPANY_A },
      );
      expect(polled).toMatchObject({ status: "error", error: { code: "invocation-cancelled" } });
      expect(companyDecisionRecords(harness, COMPANY_A).filter((record) => record.requestId === submitted.requestId)).toHaveLength(2);

      // The continuation never prunes the index on the reaped path, so a
      // follow-up reap heals the leftover index entry as already-terminal.
      const healed = await harness.performAction(ACTION_KEYS.cancelRunInvocations, { runId: "run-a" }, { companyId: COMPANY_A });
      expect(healed).toEqual({ runId: "run-a", cancelled: [], alreadyTerminal: [submitted.requestId], failed: [] });
      expect(harness.getState(runIndexKey("run-a"))).toBeUndefined();
    });

    it("index prune fails: the reap still reports cancelled with row terminal + audited; the next reap heals the index", async () => {
      const { harness } = await sharedWorker();
      const gate = deferred<Response>();
      const submitted = await submitInFlight(harness, "run-a", gate);

      const originalDelete = harness.ctx.state.delete.bind(harness.ctx.state);
      harness.ctx.state.delete = async (key) => {
        if (key.stateKey === runIndexKey("run-a").stateKey) throw new Error("injected index prune failure");
        return originalDelete(key);
      };

      const reaped = await harness.performAction(ACTION_KEYS.cancelRunInvocations, { runId: "run-a" }, { companyId: COMPANY_A });
      expect(reaped).toEqual({ runId: "run-a", cancelled: [submitted.requestId], alreadyTerminal: [], failed: [] });
      expect(harness.getState(pendingRowKey(submitted.requestId))).toMatchObject({
        status: "error",
        error: { code: "invocation-cancelled" },
      });
      expect(companyDecisionRecords(harness, COMPANY_A)).toMatchObject([{
        requestId: submitted.requestId,
        errorCode: "invocation-cancelled",
      }]);

      harness.ctx.state.delete = originalDelete;
      const healed = await harness.performAction(ACTION_KEYS.cancelRunInvocations, { runId: "run-a" }, { companyId: COMPANY_A });
      expect(healed).toEqual({ runId: "run-a", cancelled: [], alreadyTerminal: [submitted.requestId], failed: [] });
      expect(harness.getState(runIndexKey("run-a"))).toBeUndefined();

      gate.resolve(success("openai"));
      await settleTicks();
    });

    it("audit write fails: the reap reports cancelled with no audit yet; reconcile flushes it", async () => {
      const { harness } = await sharedWorker();
      const gate = deferred<Response>();
      const submitted = await submitInFlight(harness, "run-a", gate);

      const originalExecute = harness.ctx.db.execute.bind(harness.ctx.db);
      harness.ctx.db.execute = async (sql, params) => {
        void params;
        throw new Error(`injected audit failure: ${String(sql).slice(0, 24)}`);
      };

      const reaped = await harness.performAction(ACTION_KEYS.cancelRunInvocations, { runId: "run-a" }, { companyId: COMPANY_A });
      expect(reaped).toEqual({ runId: "run-a", cancelled: [submitted.requestId], alreadyTerminal: [], failed: [] });
      // Terminal row persisted; the audit is queued, not lost.
      expect(harness.getState(pendingRowKey(submitted.requestId))).toMatchObject({
        status: "error",
        error: { code: "invocation-cancelled" },
      });
      expect(companyDecisionRecords(harness, COMPANY_A)).toHaveLength(0);

      // Heal and run the scheduled job: the queued cancellation audit flushes.
      harness.ctx.db.execute = originalExecute;
      await harness.runJob(JOB_KEYS.reconcileAsyncInvocations);
      expect(companyDecisionRecords(harness, COMPANY_A)).toMatchObject([{
        requestId: submitted.requestId,
        outcome: "error",
        errorCode: "invocation-cancelled",
        runId: "run-a",
      }]);

      // The late outcome still audits without touching the terminal.
      gate.resolve(success("openai"));
      await settleTicks();
      expect(harness.getState(pendingRowKey(submitted.requestId))).toMatchObject({
        status: "error",
        error: { code: "invocation-cancelled" },
      });
      expect(companyDecisionRecords(harness, COMPANY_A).filter((record) => record.requestId === submitted.requestId)).toHaveLength(2);
    });
  });
});
