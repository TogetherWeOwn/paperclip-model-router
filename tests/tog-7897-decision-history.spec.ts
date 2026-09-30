/**
 * TOG-7897 (gap G16): decision_records has insert + 90-day prune but no
 * read/query path — operators cannot inspect routing history — and retention
 * is a hardcoded constant.
 *
 * This pins the two halves of the fix through the worker seam:
 *
 * 1. `query-decisions` — a bounded company-scoped read. The company id comes
 *    from the host-authorized action context and is bound as $1, so a caller
 *    can only ever see its own company's rows. The window start is derived
 *    from the company's configured retention; the row limit is clamped to
 *    [1, 200].
 * 2. `decisionLog.retentionDays` — configurable retention (1–3650 days,
 *    default 90). Enforced on every write (not only at worker startup), so a
 *    lowered retention takes effect on the company's next write. The legacy
 *    import and the startup sweep honor the same window.
 *
 * The zero-leakage test seeds rows for company A and asserts a company-B
 * query returns none of them AND the issued SQL binds B's id — a string-key
 * check on the envelope is not enough, because the caller's company id is
 * injected by the host, not by params.
 */

import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveConfig } from "../src/config/resolve.js";
import { ACTION_KEYS, DECISION_LOG_RETENTION_DAYS, STATE_KEYS } from "../src/constants.js";
import {
  DECISION_QUERY_MAX_LIMIT,
  decisionQuerySql,
  decisionRowToRecord,
} from "../src/decision-records.js";
import manifest from "../src/manifest.js";
import { createPlugin } from "../src/worker.js";
import { companyDecisionRecords, readFixture } from "./helpers.js";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";

function openAiSuccess() {
  return new Response(JSON.stringify({
    id: "chatcmpl-1", object: "chat.completion", model: "minimax-m2.5",
    choices: [{ index: 0, message: { role: "assistant", content: "hello a" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "request-a" } });
}

async function workerWithConfigs(
  overrides: Record<string, Record<string, unknown>> = {},
  persistedCompanyIds: string[] = [],
) {
  const configs = new Map<string, Record<string, unknown>>();
  for (const [company, fixture] of [["a", COMPANY_A], ["b", COMPANY_B]] as const) {
    const raw = readFixture(`company-${company}`) as Record<string, unknown>;
    const override = overrides[fixture];
    configs.set(fixture, override ? { ...raw, ...override } : raw);
  }
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
      return options?.companyId === COMPANY_A ? "resolved-secret-a" : "resolved-secret-b";
    },
  };
  harness.ctx.http = { async fetch() { return openAiSuccess(); } };
  vi.stubGlobal("fetch", async () => openAiSuccess());
  harness.ctx.db.query = async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
    harness.dbQueries.push({ sql, params });
    return (sql.startsWith("SELECT DISTINCT company_id FROM")
      ? persistedCompanyIds.map((company_id) => ({ company_id })) : []) as T[];
  };
  const { definition } = createPlugin();
  await definition.setup(harness.ctx);
  return { harness, definition };
}

const invocation = {
  task: { taskClass: "implementation", issueId: "issue-1" },
  messages: [{ role: "user", content: "hello" }],
  maxOutputTokens: 100,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TOG-7897: query-decisions read path", () => {
  it("returns the caller's own rows and zero rows from another company", async () => {
    const { harness } = await workerWithConfigs();
    await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A });
    await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A });

    const written = companyDecisionRecords(harness, COMPANY_A);
    expect(written).toHaveLength(2);

    const dbRows = written.map((record, index) => ({
      id: `row-${index}`,
      company_id: COMPANY_A,
      recorded_at: new Date().toISOString(),
      request_id: record.requestId,
      agent_id: null,
      run_id: null,
      issue_id: "issue-1",
      task_class: "implementation",
      selection_outcome: "selected",
      model_id: "minimax-m2.5",
      fallback_used: false,
      upstream_protocol: "openai-chat-completions",
      outcome: "completed",
      error_code: null,
      upstream_status: 200,
      latency_ms: 10,
      input_tokens: 2n,
      output_tokens: "3",
      stop_reason: "end-turn",
      upstream_request_id: "request-a",
      capacity_mode: "disabled",
      capacity_telemetry: "not-evaluated",
      capacity_lane: null,
      capacity_lane_label: null,
      capacity_posture: "not-evaluated",
      capacity_reason: null,
      capacity_degraded: false,
      capacity_snapshot_age_ms: 42_000,
      capacity_snapshot_stale: true,
      shadow_model_id: null,
    }));
    harness.ctx.db.query = async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      harness.dbQueries.push({ sql, params });
      // The harness mirrors the host contract: the worker's own SQL scopes
      // the rows. Filter like Postgres would so a missing company filter
      // shows up as leaked rows, not as a passing string assertion.
      const [companyId, windowStart, limit] = params ?? [];
      void sql;
      return dbRows
        .filter((row) => row.company_id === companyId && row.recorded_at >= String(windowStart))
        .slice(0, Number(limit)) as T[];
    };

    // A caller WITH a seeded row sees it — proves the envelope carries the
    // company's own history, not an empty stub.
    const own = await harness.performAction(ACTION_KEYS.queryDecisions, {}, { companyId: COMPANY_A }) as {
      companyId: string; retentionDays: number; limit: number; records: Array<Record<string, unknown>>;
    };
    expect(own.companyId).toBe(COMPANY_A);
    expect(own.retentionDays).toBe(DECISION_LOG_RETENTION_DAYS);
    expect(own.limit).toBe(DECISION_QUERY_MAX_LIMIT);
    expect(own.records).toHaveLength(2);
    expect(own.records[0]).toMatchObject({ companyId: COMPANY_A, requestId: written[0]?.requestId });
    // Driver-shaped values normalize: bigint and numeric strings become numbers.
    expect(own.records[0]).toMatchObject({ inputTokens: 2, outputTokens: 3, upstreamStatus: 200 });
    // TOG-7885 rollup columns ride along on the read path.
    expect(own.records[0]).toMatchObject({ capacitySnapshotAgeMs: 42_000, capacitySnapshotStale: true });

    // A caller with NO seeded rows sees nothing from the other company —
    // this is the acceptance predicate, and it asserts both the envelope
    // and the issued SQL, because the company id rides the host-injected
    // action context rather than caller params.
    harness.dbQueries.length = 0;
    const other = await harness.performAction(ACTION_KEYS.queryDecisions, {}, { companyId: COMPANY_B }) as {
      companyId: string; records: Array<Record<string, unknown>>;
    };
    expect(other.records).toHaveLength(0);
    expect(harness.dbQueries).toHaveLength(1);
    expect(harness.dbQueries[0]?.params?.[0]).toBe(COMPANY_B);
    expect(harness.dbQueries[0]?.sql).toContain("company_id = $1");
    expect(harness.dbQueries[0]?.sql).toContain("LIMIT $3");
  });

  it("clamps the row limit to [1, 200] and honors the retention override in the window start", async () => {
    const { harness } = await workerWithConfigs({ [COMPANY_A]: { decisionLog: { retentionDays: 7 } } });
    await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A });

    const now = new Date("2026-09-06T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      harness.ctx.db.query = async (sql, params) => {
        harness.dbQueries.push({ sql, params });
        return [];
      };
      // Main's TOG-7891 spend ledger reads decision_records at invoke time,
      // so the invoke above already logged a ledger query — reset the log so
      // index 0 is the read-path query under test, not the ledger read.
      harness.dbQueries.length = 0;

      const clamped = await harness.performAction(ACTION_KEYS.queryDecisions, { limit: 10_000 }, { companyId: COMPANY_A }) as {
        retentionDays: number; limit: number; records: unknown[];
      };
      expect(clamped.retentionDays).toBe(7);
      expect(clamped.limit).toBe(DECISION_QUERY_MAX_LIMIT);
      expect(clamped.records).toEqual([]);
      const expectedStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString();
      expect(harness.dbQueries[0]?.params).toEqual([COMPANY_A, expectedStart, DECISION_QUERY_MAX_LIMIT]);

      const floored = await harness.performAction(ACTION_KEYS.queryDecisions, { limit: 0 }, { companyId: COMPANY_A }) as {
        limit: number;
      };
      expect(floored.limit).toBe(1);
      expect(harness.dbQueries[1]?.params?.[2]).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a query-only SELECT inside the plugin namespace (host validator shape)", async () => {
    const sql = decisionQuerySql("plugin_model_router_4dc1d582dd");
    expect(sql).toMatch(/^SELECT /);
    expect(sql).not.toMatch(/INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE/i);
    const refs = sql.match(/[a-z0-9_]+\.[a-z0-9_]+/gi) ?? [];
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith("plugin_model_router_4dc1d582dd.")).toBe(true);
    }
  });

  it("stamps every returned record with the caller's company, never the row", async () => {
    const hostile = { company_id: COMPANY_A, recorded_at: new Date().toISOString(), request_id: "x" };
    const record = decisionRowToRecord(hostile, COMPANY_B);
    expect(record.companyId).toBe(COMPANY_B);
    expect(record.requestId).toBe("x");
    // Pre-migration-002 rows carry no snapshot age: null/false, never "fresh".
    expect(record).toMatchObject({ capacitySnapshotAgeMs: null, capacitySnapshotStale: false });
  });
});

describe("TOG-7897: configurable retention", () => {
  it("defaults to 90 days and rejects out-of-range overrides at validate time", async () => {
    expect(resolveConfig({}).decisionLog).toEqual({ retentionDays: 90 });
    expect(resolveConfig({ decisionLog: { retentionDays: 7 } }).decisionLog).toEqual({ retentionDays: 7 });
    // Malformed stored policy must not silently authorize default-window pruning.
    expect(() => resolveConfig({ decisionLog: { retentionDays: 0 } })).toThrow("decisionLog.retentionDays");
    expect(() => resolveConfig({ decisionLog: { retentionDays: 3651 } })).toThrow("decisionLog.retentionDays");

    const { definition } = await workerWithConfigs();
    const base = readFixture("company-a") as Record<string, unknown>;
    const ok = await definition.onValidateConfig!({ ...base, decisionLog: { retentionDays: 7 } });
    expect(ok).toMatchObject({ ok: true });
    for (const bad of [0, -1, 3651, 1.5, "7", null]) {
      const rejected = await definition.onValidateConfig!({ ...base, decisionLog: { retentionDays: bad } });
      expect(rejected.ok).toBe(false);
      expect((rejected.errors ?? []).join(" ")).toContain("decisionLog.retentionDays");
    }
    // Absent block stays valid — the default applies.
    expect(await definition.onValidateConfig!(base)).toMatchObject({ ok: true });
  });

  it("honors a lowered retention on write with the UTC accounting floor", async () => {
    const now = new Date("2026-09-06T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const { harness } = await workerWithConfigs({ [COMPANY_A]: { decisionLog: { retentionDays: 7 } } });
      await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A });

      const prunes = harness.dbExecutes.filter((entry) =>
        entry.sql.includes("DELETE FROM") && entry.sql.includes(".decision_records"));
      // Empty startup table needs no delete; the seven-day cutoff is earlier than month start here.
      expect(prunes).toHaveLength(1);
      expect(prunes[0]?.params).toEqual([COMPANY_A, "2026-08-30T12:00:00.000Z"]);
      expect(prunes[0]?.sql).toContain("company_id = $1");
      expect(harness.dbQueries[0]?.sql).toContain("SELECT DISTINCT company_id FROM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the startup sweep prunes each persisted writer's own window without a global backstop", async () => {
    const now = new Date("2026-09-06T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      // Setup discovers companies from persisted decision rows, not state.
      const { harness } = await workerWithConfigs(
        {
          [COMPANY_A]: { decisionLog: { retentionDays: 7 } },
          [COMPANY_B]: { decisionLog: { retentionDays: 30 } },
        },
        [COMPANY_A, COMPANY_B],
      );

      const prunes = harness.dbExecutes.filter((entry) =>
        entry.sql.includes("DELETE FROM") && entry.sql.includes(".decision_records"));
      expect(prunes.map((entry) => entry.params)).toEqual([
        [COMPANY_A, "2026-08-30T12:00:00.000Z"],
        [COMPANY_B, "2026-08-07T12:00:00.000Z"],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the legacy import to the company's own retention window", async () => {
    const { harness } = await workerWithConfigs({ [COMPANY_A]: { decisionLog: { retentionDays: 7 } } });
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString();
    await harness.ctx.state.set({
      scopeKind: "company",
      scopeId: COMPANY_A,
      stateKey: STATE_KEYS.legacyDecisionLog,
    }, [
      { at: old, requestId: "outside-7-day-window", outcome: "completed" },
      { at: new Date().toISOString(), requestId: "inside-7-day-window", outcome: "completed" },
    ]);

    await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A });

    const requestIds = companyDecisionRecords(harness, COMPANY_A).map((record) => record.requestId);
    expect(requestIds).toContain("inside-7-day-window");
    expect(requestIds).not.toContain("outside-7-day-window");
  });
});
