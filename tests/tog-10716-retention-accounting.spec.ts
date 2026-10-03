import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import fixture from "./fixtures/company-a.json" with { type: "json" };
import type { InferenceResult } from "../src/inference/types.js";
import manifest from "../src/manifest.js";
import { ACTION_KEYS, STATE_KEYS } from "../src/constants.js";
import { DECISION_RECORD_COLUMNS } from "../src/decision-records.js";
import { resolveConfig } from "../src/config/resolve.js";
import { createPlugin } from "../src/worker.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-09-20T12:00:00.000Z";
const DAY = 86_400_000;
const request = {
  task: { taskClass: "implementation" },
  messages: [{ role: "user", content: "Explain this implementation" }],
  maxOutputTokens: 100,
};

type Row = Record<string, unknown> & { company_id: string; recorded_at: string; request_id: string };

function row(companyId: string, at: string, requestId: string): Row {
  return {
    id: requestId, company_id: companyId, recorded_at: at, request_id: requestId,
    outcome: "completed", model_id: "minimax-m2.5", input_tokens: 1_000_000, output_tokens: 1_000_000,
  };
}

function config(retentionDays?: number, monthlyCapUsd = 0) {
  return {
    ...structuredClone(fixture),
    ...(retentionDays === undefined ? {} : { decisionLog: { retentionDays } }),
    budget: { ...fixture.budget, monthlyCapUsd },
  };
}

function success() {
  return new Response(JSON.stringify({
    id: "test", object: "chat.completion", model: "minimax-m2.5",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

/** SQL-shaped row fixture: executes actual worker maintenance, history and ledger paths. No services. */
async function worker(
  policies: Record<string, ReturnType<typeof config>>,
  seed: Row[] = [],
  unavailable = new Set<string>(),
  legacy: unknown[] | null = null,
) {
  const h = createTestHarness({ manifest, config: {} });
  let rows = structuredClone(seed);
  vi.spyOn(h.ctx.config, "get").mockImplementation(async (companyId) => {
    if (companyId && unavailable.has(companyId)) throw new Error("fixture config outage");
    return companyId ? structuredClone(policies[companyId] ?? {}) : {};
  });
  vi.spyOn(h.ctx.secrets, "resolve").mockResolvedValue("fixture-only");
  h.ctx.db.execute = async (sql, params = []) => {
    h.dbExecutes.push({ sql, params });
    if (sql.startsWith("DELETE FROM") && sql.includes(".decision_records")) {
      // Support the old SQL for defect reproduction and the repaired cutoff SQL.
      const scoped = sql.includes("company_id = $1");
      const cutoff = scoped
        ? Date.parse(String(params[1])) - (params.length === 3 ? Number(params[2]) * DAY : 0)
        : Date.parse(String(params[0])) - Number(params[1]) * DAY;
      rows = rows.filter((r) => (scoped && r.company_id !== params[0]) || Date.parse(r.recorded_at) >= cutoff);
    } else if (sql.startsWith("INSERT INTO") && sql.includes(".decision_records")) {
      if (!rows.some((r) => r.company_id === params[1] && r.request_id === params[3])) {
        rows.push(Object.fromEntries(DECISION_RECORD_COLUMNS.map((key, i) => [key, params[i]])) as Row);
      }
    } else {
      throw new Error(`Unexpected execute: ${sql}`);
    }
    return { rowCount: 0 };
  };
  h.ctx.db.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    h.dbQueries.push({ sql, params });
    if (sql.startsWith("SELECT DISTINCT company_id FROM")) {
      expect(params).toEqual([]);
      return [...new Set(rows.map((r) => r.company_id))].map((company_id) => ({ company_id })) as T[];
    }
    const [companyId, start, last] = params;
    const scoped = rows.filter((r) => r.company_id === companyId && r.recorded_at >= String(start));
    if (sql.includes("ORDER BY recorded_at DESC")) {
      expect(sql).toContain("WHERE company_id = $1 AND recorded_at >= $2::timestamptz");
      return scoped.sort((a, b) => b.recorded_at.localeCompare(a.recorded_at)).slice(0, Number(last)) as T[];
    }
    expect(sql).toContain("SELECT model_id, input_tokens, output_tokens FROM");
    expect(sql).toContain("recorded_at < $3::timestamptz");
    return scoped.filter((r) => r.recorded_at < String(last)) as T[];
  };
  if (legacy) await h.ctx.state.set({ scopeKind: "company", scopeId: A, stateKey: STATE_KEYS.legacyDecisionLog }, legacy);
  const { definition } = createPlugin();
  await definition.setup!(h.ctx);
  return { h, definition, rows: () => rows, unavailable };
}

function legacyRow(at: string, requestId: string) {
  return { at, requestId, outcome: "completed", modelId: "minimax-m2.5", inputTokens: 1_000_000, outputTokens: 1_000_000 };
}

beforeEach(() => {
  // Vitest 2 Date-only mocking leaves transport timers real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  vi.stubGlobal("fetch", vi.fn(async () => success()));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("TOG-10716 retention preserves history and monthly accounting", () => {
  it("startup discovers mixed 7/365-day policies from persisted rows without a writer index", async () => {
    const w = await worker({ [A]: config(7), [B]: config(365) }, [
      row(A, "2026-08-31T23:59:59.999Z", "short-expired"),
      row(A, "2026-09-01T00:00:00.000Z", "short-accounting"),
      row(B, new Date(Date.now() - 120 * DAY).toISOString(), "long-valid"),
      row(B, new Date(Date.now() - 366 * DAY).toISOString(), "long-expired"),
    ]);
    expect(w.rows().map((r) => r.request_id).sort()).toEqual(["long-valid", "short-accounting"]);
    const deletes = w.h.dbExecutes.filter((e) => e.sql.startsWith("DELETE"));
    expect(deletes).toHaveLength(2);
    expect(deletes.every((e) => e.sql.includes("WHERE company_id = $1"))).toBe(true);
    expect(deletes.map((e) => e.params?.[0]).sort()).toEqual([A, B]);
  });

  it("startup skips unreadable policy while safely pruning another company; recovery retries on write", async () => {
    const unavailable = new Set([B]);
    const w = await worker({ [A]: config(7), [B]: config(365) }, [
      row(A, "2026-08-01T00:00:00.000Z", "short-expired"),
      row(B, new Date(Date.now() - 120 * DAY).toISOString(), "long-valid"),
      row(B, new Date(Date.now() - 366 * DAY).toISOString(), "long-expired"),
    ], unavailable);
    expect(w.rows().map((r) => r.request_id).sort()).toEqual(["long-expired", "long-valid"]);
    expect(w.h.dbExecutes.filter((e) => e.sql.startsWith("DELETE")).map((e) => e.params?.[0])).toEqual([A]);
    unavailable.clear();
    await w.h.performAction(ACTION_KEYS.invoke, request, { companyId: B });
    expect(w.rows().some((r) => r.request_id === "long-valid")).toBe(true);
    expect(w.rows().some((r) => r.request_id === "long-expired")).toBe(false);
  });

  it("failed writer enumeration never falls back to a whole-table DELETE", async () => {
    const h = createTestHarness({ manifest, config: {} });
    vi.spyOn(h.ctx.db, "query").mockRejectedValue(new Error("fixture db outage"));
    await createPlugin().definition.setup!(h.ctx);
    expect(h.dbExecutes.filter((e) => e.sql.startsWith("DELETE"))).toEqual([]);
  });

  it("a legitimately absent policy retains the default 90-day window", async () => {
    const w = await worker({ [A]: config() }, [
      row(A, new Date(Date.now() - 89 * DAY).toISOString(), "default-valid"),
      row(A, new Date(Date.now() - 91 * DAY).toISOString(), "default-expired"),
    ]);
    expect(w.rows().map((r) => r.request_id)).toEqual(["default-valid"]);
  });

  it("two successive over-cap invocations BOTH halt at $1.25/$1 with seven-day retention", async () => {
    const w = await worker({ [A]: config(7, 1) }, [row(A, "2026-09-01T00:00:00.000Z", "spent")]);
    for (let i = 0; i < 2; i += 1) {
      const result = await w.h.performAction(ACTION_KEYS.invoke, request, { companyId: A }) as InferenceResult;
      expect(result.decision?.gates.budget).toBe("halt");
      expect(result.decision?.budget.ledger?.totalUsd).toBe(1.25);
      expect(result.outcome).toBe("no-eligible-model");
      expect(w.rows().some((r) => r.request_id === "spent")).toBe(true);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("error-result maintenance defers pruning and legacy reconciliation until config recovers", async () => {
    const w = await worker({ [A]: config(365) }, [], new Set(), [
      legacyRow(new Date(Date.now() - 120 * DAY).toISOString(), "legacy-valid"),
      legacyRow(new Date(Date.now() - 366 * DAY).toISOString(), "legacy-expired"),
    ]);
    w.rows().push(row(A, new Date(Date.now() - 120 * DAY).toISOString(), "valid"));
    w.unavailable.add(A);
    const error = await w.h.performAction(ACTION_KEYS.invoke, request, { companyId: A }) as InferenceResult;
    expect(error.outcome).toBe("error");
    expect(w.rows().some((r) => r.request_id === "valid")).toBe(true);
    expect(w.h.dbExecutes.filter((e) => e.sql.startsWith("DELETE"))).toEqual([]);
    const marker = { scopeKind: "company" as const, scopeId: A, stateKey: STATE_KEYS.decisionLogMigration };
    expect(await w.h.ctx.state.get(marker)).toBeNull();
    w.unavailable.clear();
    await w.h.performAction(ACTION_KEYS.invoke, request, { companyId: A });
    expect(w.rows().some((r) => r.request_id === "legacy-valid")).toBe(true);
    expect(w.rows().some((r) => r.request_id === "legacy-expired")).toBe(false);
    expect(await w.h.ctx.state.get(marker)).toMatchObject({ reconciledAt: NOW });
  });

  it("legacy import preserves current-month cap evidence before the first ledger read", async () => {
    const w = await worker({ [A]: config(7, 1) }, [], new Set(), [
      legacyRow("2026-08-31T23:59:59.999Z", "previous-month"),
      legacyRow("2026-09-01T00:00:00.000Z", "month-start"),
    ]);
    const result = await w.h.performAction(ACTION_KEYS.invoke, request, { companyId: A }) as InferenceResult;
    expect(result.decision?.gates.budget).toBe("halt");
    expect(result.decision?.budget.ledger?.totalUsd).toBe(1.25);
    expect(w.rows().some((r) => r.request_id === "month-start")).toBe(true);
    expect(w.rows().some((r) => r.request_id === "previous-month")).toBe(false);
  });

  it("keeps the accounting floor even with caps disabled, hides it from short history, rolls it off at UTC month boundary", async () => {
    vi.setSystemTime(new Date("2026-09-30T23:59:59.999Z"));
    const w = await worker({ [A]: config(7), [B]: config(7) }, [
      row(A, "2026-09-01T00:00:00.000Z", "accounting"),
      row(A, "2026-09-25T00:00:00.000Z", "history"),
      row(B, "2026-09-25T00:00:00.000Z", "other-company"),
    ]);
    await w.h.performAction(ACTION_KEYS.invoke, request, { companyId: A });
    expect(w.rows().some((r) => r.request_id === "accounting")).toBe(true);
    const history = await w.h.performAction(ACTION_KEYS.queryDecisions, { companyId: B, limit: 10_000 }, { companyId: A }) as {
      retentionDays: number; limit: number; records: Array<{ requestId: string }>;
    };
    expect(history.retentionDays).toBe(7);
    expect(history.limit).toBe(200);
    expect(history.records.some((r: { requestId: string }) => ["accounting", "other-company"].includes(r.requestId))).toBe(false);
    expect(history.records.some((r: { requestId: string }) => r.requestId === "history")).toBe(true);
    vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
    await w.h.performAction(ACTION_KEYS.invoke, request, { companyId: A });
    expect(w.rows().some((r) => r.request_id === "accounting")).toBe(false);
    // The floor is min(history cutoff, month start), not month start alone.
    expect(w.rows().some((r) => r.request_id === "history")).toBe(true);
    expect(w.rows().some((r) => r.request_id === "other-company")).toBe(true);
  });

  it("malformed stored policy skips pruning, rejects history reads, and retries migration after repair", async () => {
    const raw = config(365);
    raw.decisionLog = { retentionDays: 0 };
    const policies = { [A]: raw };
    const w = await worker(policies, [row(A, new Date(Date.now() - 120 * DAY).toISOString(), "valid")], new Set(), [
      legacyRow(new Date(Date.now() - 120 * DAY).toISOString(), "legacy-valid"),
    ]);
    await w.h.performAction(ACTION_KEYS.invoke, request, { companyId: A });
    expect(w.rows().some((r) => r.request_id === "valid")).toBe(true);
    expect(w.h.dbExecutes.filter((e) => e.sql.startsWith("DELETE"))).toEqual([]);
    expect(await w.h.ctx.state.get({ scopeKind: "company", scopeId: A, stateKey: STATE_KEYS.decisionLogMigration })).toBeNull();
    await expect(w.h.performAction(ACTION_KEYS.queryDecisions, {}, { companyId: A })).rejects.toThrow("decisionLog.retentionDays");
    policies[A] = config(365);
    await w.h.performAction(ACTION_KEYS.invoke, request, { companyId: A });
    expect(w.rows().some((r) => r.request_id === "legacy-valid")).toBe(true);
  });

  it("preserves the exact long-retention cutoff and deletes only the prior millisecond", async () => {
    const cutoff = Date.now() - 3650 * DAY;
    const w = await worker({ [A]: config(3650) }, [
      row(A, new Date(cutoff).toISOString(), "boundary"),
      row(A, new Date(cutoff - 1).toISOString(), "expired"),
    ]);
    expect(w.rows().map((r) => r.request_id)).toEqual(["boundary"]);
  });

  it.each([undefined, {}])("accepts optional decisionLog %s consistently at validation and resolution", async (decisionLog) => {
    const raw = { ...structuredClone(fixture), ...(decisionLog === undefined ? {} : { decisionLog }) };
    expect(resolveConfig(raw).decisionLog.retentionDays).toBe(90);
    expect((await createPlugin().definition.onValidateConfig!(raw)).ok).toBe(true);
  });

  it.each([0, -1, 3651, 7.5, "7", null, false])("rejects explicit malformed retention %s", async (retentionDays) => {
    const result = await createPlugin().definition.onValidateConfig!({ ...structuredClone(fixture), decisionLog: { retentionDays } });
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.includes("decisionLog.retentionDays"))).toBe(true);
  });

  it.each([null, [], "7", 7])("rejects malformed decisionLog block %s", async (decisionLog) => {
    const result = await createPlugin().definition.onValidateConfig!({ ...structuredClone(fixture), decisionLog });
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.includes("decisionLog"))).toBe(true);
  });
});
