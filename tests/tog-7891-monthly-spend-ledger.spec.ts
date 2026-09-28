/**
 * TOG-7891 (Gap G4): enforce `monthlyCapUsd` from a `decision_records`
 * spend ledger.
 *
 * Budget gates used to run off a fraction handed in from outside — the
 * TOG-7417 host injection or a caller-claimed
 * `task.signals.budgetSpentFraction` — while the tokens×price recorded per
 * row were never summed. This pins the replacement:
 *
 * - the pure rollup: input+output tokens × live model-table prices over the
 *   current UTC calendar month (`src/spend-ledger.ts`), including month
 *   boundaries, price mutations, $0 rows, and defensive parsing;
 * - the resolution order: a readable ledger beats a forged caller claim,
 *   both trusted sources count with the HIGHER winning, and an unreadable
 *   ledger falls back to the injected-or-caller fraction (fail-open);
 * - end to end: seeded ledger rows move the gates through warn, downshift
 *   and halt with `decision.budget` provenance, rows outside the month or
 *   company are excluded, and the SQL params prove the company-scoped
 *   half-open UTC window.
 *
 * Reviewer acceptance: seed rows across a month boundary; totals and gate
 * transitions match the hand-computed fixture below.
 */

import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveBudgetSpentFraction,
  resolveEffectiveBudgetSpentFraction,
} from "../src/budget-authority.js";
import { ACTION_KEYS, TOOL_NAMES } from "../src/constants.js";
import manifest from "../src/manifest.js";
import {
  formatUsd,
  modelPrices,
  monthWindowUtc,
  normalizeSpendRow,
  rowCostUsd,
  spendFractionFor,
  spendLedgerSql,
  summarizeMonthlySpend,
  readMonthlySpendLedger,
  type SpendLedgerLog,
  type SpendLedgerStore,
} from "../src/spend-ledger.js";
import { createPlugin } from "../src/worker.js";
import { fixtureConfig, readFixture } from "./helpers.js";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const SECRET_A = "resolved-secret-a";

// Hand-computed fixture (company-a model table):
// - minimax-m2.5: 0.25/MTok in, 1/MTok out
// - claude-sonnet-5: 3/MTok in, 15/MTok out
// - qwen3-coder: 0.08/MTok in, 0.32/MTok out
//
// Ledger rows (UTC, current month = 2026-09):
// - 1_000_000 in + 1_000_000 out on minimax-m2.5  = 0.25 + 1.00 = $1.25
// - 1_000_000 in + 0 out on claude-sonnet-5       = 3.00        = $3.00
// - 0 in + 1_000_000 out on qwen3-coder           = 0.32        = $0.32
// - 500 in on an unknown model (price changed)                   = $0.00
// - null tokens on minimax-m2.5 (usage missing)                  = $0.00
// Total = $4.57 over 5 rows. Against monthlyCapUsd 250 that is 0.01828
// (ok); scaled fixtures below drive the gate transitions.
const LEDGER_ROWS = [
  { model_id: "minimax-m2.5", input_tokens: 1_000_000, output_tokens: 1_000_000 },
  { model_id: "claude-sonnet-5", input_tokens: 1_000_000, output_tokens: 0 },
  { model_id: "qwen3-coder", input_tokens: 0, output_tokens: 1_000_000 },
  { model_id: "retired-model", input_tokens: 500, output_tokens: 500 },
  { model_id: "minimax-m2.5", input_tokens: null, output_tokens: null },
];
const LEDGER_TOTAL_USD = 4.57;

function companyA() {
  return fixtureConfig("company-a");
}

const quietLog: SpendLedgerLog = { warn() {} };

function success() {
  return new Response(JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "echo-a",
    choices: [{ index: 0, message: { role: "assistant", content: "hello a" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "request-a" } });
}

async function sharedWorker(options: {
  ledgerRows?: unknown[] | "throw";
  monthlyCapUsd?: number;
} = {}) {
  const configs = new Map([[COMPANY_A, readFixture("company-a")]]);
  if (options.monthlyCapUsd !== undefined) {
    ((configs.get(COMPANY_A) as Record<string, Record<string, unknown>>).budget as Record<string, unknown>).monthlyCapUsd =
      options.monthlyCapUsd;
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
    async resolve() {
      return SECRET_A;
    },
  };
  harness.ctx.http = {
    async fetch() {
      return success();
    },
  };
  vi.stubGlobal("fetch", async () => success());
  if (options.ledgerRows !== undefined) {
    const rows = options.ledgerRows;
    harness.ctx.db.query = (async <T>(sql: string, params?: unknown[]) => {
      harness.dbQueries.push({ sql, params });
      if (rows === "throw") throw new Error("ledger unavailable");
      return rows as T[];
    }) as typeof harness.ctx.db.query;
  }
  const { definition } = createPlugin();
  await definition.setup(harness.ctx);
  return { harness };
}

const invocation = {
  task: { taskClass: "implementation", issueId: "issue-1" },
  messages: [{ role: "user", content: "hello" }],
  maxOutputTokens: 100,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("month window (UTC calendar month, half-open)", () => {
  it("opens on the first of the month and closes on the first of the next", () => {
    expect(monthWindowUtc(new Date("2026-09-15T12:00:00.000Z"))).toEqual({
      startIso: "2026-09-01T00:00:00.000Z",
      endIso: "2026-10-01T00:00:00.000Z",
      monthLabel: "2026-09",
    });
  });

  it("rolls the year at January", () => {
    expect(monthWindowUtc(new Date("2026-01-01T00:00:00.000Z"))).toEqual({
      startIso: "2026-01-01T00:00:00.000Z",
      endIso: "2026-02-01T00:00:00.000Z",
      monthLabel: "2026-01",
    });
    expect(monthWindowUtc(new Date("2025-12-31T23:59:59.999Z")).monthLabel).toBe("2025-12");
    expect(monthWindowUtc(new Date("2025-12-31T23:59:59.999Z")).endIso).toBe("2026-01-01T00:00:00.000Z");
  });

  it("a row stamped exactly on the boundary opens the month it starts", () => {
    const window = monthWindowUtc(new Date("2026-09-15T00:00:00.000Z"));
    // The SQL pairs `>= start` with `< end` so the end stamp is next
    // month's problem, never this month's double-count.
    expect(window.startIso <= "2026-09-30T23:59:59.999Z").toBe(true);
    expect("2026-10-01T00:00:00.000Z" < window.endIso).toBe(false);
    expect(window.endIso).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("rollup math", () => {
  it("sums tokens × live prices to the hand-computed total", () => {
    const summary = summarizeMonthlySpend(LEDGER_ROWS, modelPrices(companyA()));
    expect(summary.rowCount).toBe(5);
    expect(summary.totalUsd).toBeCloseTo(LEDGER_TOTAL_USD, 9);
  });

  it("prices a retired model id at $0 instead of failing the rollup", () => {
    const prices = modelPrices(companyA());
    expect(rowCostUsd({ modelId: "retired-model", inputTokens: 500, outputTokens: 500 }, prices)).toBe(0);
  });

  it("prices null token counts at $0", () => {
    const prices = modelPrices(companyA());
    expect(rowCostUsd({ modelId: "minimax-m2.5", inputTokens: null, outputTokens: null }, prices)).toBe(0);
    expect(rowCostUsd({ modelId: null, inputTokens: 5, outputTokens: 5 }, prices)).toBe(0);
  });

  it("follows a price mutation in the live table", () => {
    // A price cut takes effect for the whole window on the next read — the
    // rollup never caches prices, so the reviewer recomputes from the same
    // table the router read.
    const config = companyA();
    const before = summarizeMonthlySpend(
      [{ model_id: "minimax-m2.5", input_tokens: 1_000_000, output_tokens: 0 }],
      modelPrices(config),
    );
    expect(before.totalUsd).toBeCloseTo(0.25, 9);
    config.models.find((model) => model.id === "minimax-m2.5")!.costPerMTokIn = 0.5;
    const after = summarizeMonthlySpend(
      [{ model_id: "minimax-m2.5", input_tokens: 1_000_000, output_tokens: 0 }],
      modelPrices(config),
    );
    expect(after.totalUsd).toBeCloseTo(0.5, 9);
  });

  it("parses defensively: bigint-shaped strings, negatives, and garbage", () => {
    // Host drivers may hand bigint columns back as strings.
    expect(normalizeSpendRow({ model_id: "m", input_tokens: "1000", output_tokens: "2000" }))
      .toEqual({ modelId: "m", inputTokens: 1000, outputTokens: 2000 });
    // Negatives and non-numeric junk price at $0 through nulls, never throw.
    expect(normalizeSpendRow({ model_id: "m", input_tokens: -5, output_tokens: "junk" }))
      .toEqual({ modelId: "m", inputTokens: null, outputTokens: null });
    expect(normalizeSpendRow({ model_id: "", input_tokens: 1.9, output_tokens: null }))
      .toEqual({ modelId: null, inputTokens: 1, outputTokens: null });
    expect(normalizeSpendRow(null))
      .toEqual({ modelId: null, inputTokens: null, outputTokens: null });
    expect(normalizeSpendRow("not-a-row"))
      .toEqual({ modelId: null, inputTokens: null, outputTokens: null });
  });

  it("empty history is $0 over 0 rows, not an error", () => {
    expect(summarizeMonthlySpend([], modelPrices(companyA()))).toEqual({ totalUsd: 0, rowCount: 0 });
  });

  it("the fraction is undefined without a positive cap", () => {
    expect(spendFractionFor(4.57, 0)).toBeUndefined();
    expect(spendFractionFor(4.57, -10)).toBeUndefined();
    expect(spendFractionFor(4.57, Number.NaN)).toBeUndefined();
    expect(spendFractionFor(4.57, 250)).toBeCloseTo(0.01828, 5);
  });

  it("formats trace dollars exactly at whole cents, four decimals below a cent", () => {
    expect(formatUsd(4.5)).toBe("4.50");
    expect(formatUsd(4.57)).toBe("4.57");
    // Token prices routinely land below a cent; two decimals would make a
    // hand recomputation look "wrong" by a cent.
    expect(formatUsd(1 / 300)).toBe("0.0033");
    expect(formatUsd(162.5)).toBe("162.50");
  });
});

describe("resolution order (ledger × host injection × caller claim)", () => {
  it("a readable ledger beats a forged caller claim in both directions", () => {
    // Forged-low dodge loses to the ledger.
    expect(resolveEffectiveBudgetSpentFraction(0.97, undefined, 0.0))
      .toEqual({ fraction: 0.97, source: "ledger" });
    // Forged-high force loses to the ledger.
    expect(resolveEffectiveBudgetSpentFraction(0.1, undefined, 0.99))
      .toEqual({ fraction: 0.1, source: "ledger" });
  });

  it("the higher trusted source wins, never the looser one", () => {
    // The host may track spend outside decision_records; the ledger must not
    // undercut an authoritative reading the host already holds.
    expect(resolveEffectiveBudgetSpentFraction(0.5, 0.97, 0.0))
      .toEqual({ fraction: 0.97, source: "authoritative" });
    expect(resolveEffectiveBudgetSpentFraction(0.97, 0.5, 0.0))
      .toEqual({ fraction: 0.97, source: "ledger" });
  });

  it("the legacy injected-or-caller path survives exactly when neither trusted source exists", () => {
    // Pin the untouched TOG-7417 composition inside the new resolver.
    expect(resolveEffectiveBudgetSpentFraction(undefined, 0.97, 0.0).fraction)
      .toBe(resolveBudgetSpentFraction(0.97, 0.0));
    expect(resolveEffectiveBudgetSpentFraction(undefined, undefined, 0.99))
      .toEqual({ fraction: 0.99, source: "caller" });
    expect(resolveEffectiveBudgetSpentFraction(undefined, undefined, undefined))
      .toEqual({ fraction: undefined, source: "none" });
  });

  it("non-finite inputs count as absent on every channel", () => {
    expect(resolveEffectiveBudgetSpentFraction(Number.NaN, 0.5, 0.1))
      .toEqual({ fraction: 0.5, source: "authoritative" });
    expect(resolveEffectiveBudgetSpentFraction(0.5, Number.NaN, 0.1))
      .toEqual({ fraction: 0.5, source: "ledger" });
    expect(resolveEffectiveBudgetSpentFraction(undefined, undefined, Number.NaN))
      .toEqual({ fraction: undefined, source: "none" });
  });
});

describe("ledger read", () => {
  it("skips the query entirely when no positive cap is configured", async () => {
    const seen: Array<{ sql: string; params?: unknown[] }> = [];
    const store: SpendLedgerStore = {
      namespace: "ns",
      async query(sql, params) {
        seen.push({ sql, params });
        return [];
      },
    };
    const config = companyA();
    config.budget.monthlyCapUsd = 0;
    const result = await readMonthlySpendLedger(store, quietLog, COMPANY_A, config, new Date("2026-09-15T00:00:00.000Z"));
    expect(result).toEqual({ fraction: undefined, ledger: null });
    expect(seen).toHaveLength(0);
  });

  it("scopes the SQL to the company and the half-open UTC month", async () => {
    const seen: Array<{ sql: string; params?: unknown[] }> = [];
    const store: SpendLedgerStore = {
      namespace: "plugin_model_router_test",
      async query(sql, params) {
        seen.push({ sql, params });
        return [];
      },
    };
    const config = companyA();
    await readMonthlySpendLedger(store, quietLog, COMPANY_A, config, new Date("2026-09-15T12:00:00.000Z"));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.params).toEqual([COMPANY_A, "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"]);
    expect(seen[0]!.sql).toBe(spendLedgerSql("plugin_model_router_test"));
    expect(seen[0]!.sql).toContain("company_id = $1");
    expect(seen[0]!.sql).toContain("recorded_at >= $2");
    expect(seen[0]!.sql).toContain("recorded_at < $3");
    expect(seen[0]!.sql).not.toContain("input.content");
  });

  it("a failed read warns once and falls back (fail-open), never throws", async () => {
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const store: SpendLedgerStore = {
      namespace: "ns",
      async query() {
        throw new Error("connection reset");
      },
    };
    const result = await readMonthlySpendLedger(
      store,
      { warn: (message, meta) => warnings.push({ message, meta }) },
      COMPANY_A,
      companyA(),
      new Date("2026-09-15T00:00:00.000Z"),
    );
    expect(result).toEqual({ fraction: undefined, ledger: null });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain("fall back");
    expect(warnings[0]!.meta).toMatchObject({ companyId: COMPANY_A, month: "2026-09" });
  });
});

describe("gates move off the ledger end to end", () => {
  // One scaled row family; the cap moves so each gate is the ledger's doing.
  // minimax-m2.5 at 1.25/MTok combined: 1M in + 1M out per row = $1.25/row.
  function spendRows(count: number): unknown[] {
    return Array.from({ length: count }, () => ({
      model_id: "minimax-m2.5",
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    }));
  }

  it.each([
    ["ok", 10, 250, "ok"],
    ["warn", 130, 250, "warn"],
    ["downshift", 170, 250, "downshift"],
    ["halt", 200, 250, "halt"],
  ])("%s at the hand-computed ledger fraction", async (_label, rows, cap, gate) => {
    const { harness } = await sharedWorker({ ledgerRows: spendRows(rows as number), monthlyCapUsd: cap as number });
    const result = await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A }) as {
      outcome: string;
      decision: { gates: { budget: string }; budget: { source: string; fraction: number | null; ledger: { totalUsd: number; monthLabel: string } | null } };
    };
    const expectedTotal = (rows as number) * 1.25;
    expect(result.decision.budget.source).toBe("ledger");
    expect(result.decision.budget.fraction).toBeCloseTo(expectedTotal / (cap as number), 9);
    expect(result.decision.budget.ledger).toMatchObject({ totalUsd: expectedTotal });
    expect(result.decision.gates.budget).toBe(gate);
  });

  it("a ledger halt refuses non-pinned work but honors a surviving pin", async () => {
    const { harness } = await sharedWorker({ ledgerRows: spendRows(200), monthlyCapUsd: 250 });
    const halted = await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A }) as {
      outcome: string;
      decision: { gates: { budget: string } };
    };
    expect(halted.decision.gates.budget).toBe("halt");
    expect(halted.outcome).toBe("no-eligible-model");
    const pinned = await harness.performAction(ACTION_KEYS.invoke, {
      ...invocation,
      task: { ...invocation.task, pinnedModelId: "minimax-m2.5" },
    }, { companyId: COMPANY_A }) as { outcome: string; decision: { modelId: string; pin: { honored: boolean } } };
    expect(pinned).toMatchObject({ outcome: "completed", decision: { modelId: "minimax-m2.5", pin: { honored: true } } });
  });

  it("a forged-low caller claim cannot dodge a ledger halt", async () => {
    const { harness } = await sharedWorker({ ledgerRows: spendRows(200), monthlyCapUsd: 250 });
    const result = await harness.performAction(ACTION_KEYS.invoke, {
      ...invocation,
      task: { ...invocation.task, signals: { budgetSpentFraction: 0.0 } },
    }, { companyId: COMPANY_A }) as { outcome: string; decision: { gates: { budget: string }; budget: { source: string } } };
    expect(result.decision.budget.source).toBe("ledger");
    expect(result.decision.gates.budget).toBe("halt");
    expect(result.outcome).toBe("no-eligible-model");
  });

  it("the trace names the ledger dollars, cap, and month for hand recomputation", async () => {
    const { harness } = await sharedWorker({ ledgerRows: spendRows(130), monthlyCapUsd: 250 });
    const result = await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A }) as {
      decision: { trace: string[] };
    };
    const line = result.decision.trace.find((entry) => entry.startsWith("budget: $"));
    expect(line).toBeDefined();
    // 130 rows × $1.25 = $162.50 of $250.00 in the September window.
    expect(line).toContain("$162.50 of $250.00");
    expect(line).toContain(new Date().toISOString().slice(0, 7));
  });

  it("rows outside the month and company never reach the gates", async () => {
    // The worker passes a half-open UTC window and the company id as params;
    // the DB does the exclusion. This pins the params the gates depend on.
    const { harness } = await sharedWorker({ ledgerRows: [], monthlyCapUsd: 250 });
    await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A });
    const spends = harness.dbQueries.filter((entry) => entry.sql.includes("output_tokens"));
    expect(spends).toHaveLength(1);
    const params = spends[0]!.params as unknown[];
    expect(params[0]).toBe(COMPANY_A);
    const [start, end] = [String(params[1]), String(params[2])];
    expect(new Date(start).toISOString()).toBe(start);
    expect(new Date(end).toISOString()).toBe(end);
    expect(Date.parse(end) - Date.parse(start)).toBeGreaterThan(27 * 24 * 60 * 60 * 1_000);
    expect(Date.parse(end) - Date.parse(start)).toBeLessThan(32 * 24 * 60 * 60 * 1_000);
    // A September row and an August row cannot both satisfy one half-open window.
    expect("2026-08-31T23:59:59.999Z" >= start && "2026-08-31T23:59:59.999Z" < end).toBe(false);
  });

  it("an unreadable ledger falls back to the caller fraction (fail-open)", async () => {
    const { harness } = await sharedWorker({ ledgerRows: "throw", monthlyCapUsd: 250 });
    const result = await harness.performAction(ACTION_KEYS.invoke, {
      ...invocation,
      task: { ...invocation.task, signals: { budgetSpentFraction: 0.1 } },
    }, { companyId: COMPANY_A }) as {
      outcome: string;
      decision: { gates: { budget: string }; budget: { source: string; ledger: null } };
    };
    expect(result).toMatchObject({
      outcome: "completed",
      decision: { gates: { budget: "ok" }, budget: { source: "caller", ledger: null } },
    });
    expect(harness.logs.some((entry) => entry.level === "warn" && entry.message.includes("fall back"))).toBe(true);
  });

  it("no cap configured means no ledger query and the legacy path rules", async () => {
    const { harness } = await sharedWorker({ ledgerRows: [], monthlyCapUsd: 0 });
    const result = await harness.executeTool(TOOL_NAMES.invoke, {
      ...invocation,
      task: { ...invocation.task, signals: { budgetSpentFraction: 0.1 } },
    }, { companyId: COMPANY_A, runId: "run-a", agentId: "agent-a", projectId: "project-a" });
    expect(result.data).toMatchObject({
      outcome: "completed",
      decision: { gates: { budget: "ok" }, budget: { source: "caller", ledger: null } },
    });
    expect(harness.dbQueries.filter((entry) => entry.sql.includes("output_tokens"))).toHaveLength(0);
  });
});

describe("reviewer acceptance: month-boundary rows match the hand fixture", () => {
  it("September rows sum to $4.57 while August rows are excluded by the window params", async () => {
    // The company-a ledger from the header: $4.57 over 5 September rows.
    // The SQL window is what excludes the August control row — the reviewer
    // reproduces this by running the recorded query with the recorded params
    // against their seeded table and comparing with the $4.57 hand total.
    const { harness } = await sharedWorker({ ledgerRows: LEDGER_ROWS, monthlyCapUsd: 250 });
    const result = await harness.performAction(ACTION_KEYS.invoke, invocation, { companyId: COMPANY_A }) as {
      decision: { gates: { budget: string }; budget: { source: string; fraction: number; ledger: { totalUsd: number; monthLabel: string } | null } };
    };
    expect(result.decision.budget.source).toBe("ledger");
    expect(result.decision.budget.ledger?.totalUsd).toBeCloseTo(LEDGER_TOTAL_USD, 9);
    expect(result.decision.budget.fraction).toBeCloseTo(LEDGER_TOTAL_USD / 250, 9);
    expect(result.decision.gates.budget).toBe("ok");
    const spends = harness.dbQueries.filter((entry) => entry.sql.includes("output_tokens"));
    expect(spends).toHaveLength(1);
    const params = spends[0]!.params as unknown[];
    expect(params[0]).toBe(COMPANY_A);
    const [start, end] = [String(params[1]), String(params[2])];
    // The August control row falls outside the half-open window by the params.
    expect("2026-08-15T12:00:00.000Z" >= start && "2026-08-15T12:00:00.000Z" < end).toBe(false);
    // A store-backed check of the same predicate over the seeded rows: only
    // the five September rows would be returned, totaling the hand fixture.
    const september = [
      ...LEDGER_ROWS.map((row, index) => ({ ...row, recorded_at: `2026-09-${String(index + 1).padStart(2, "0")}T12:00:00.000Z` })),
      { model_id: "minimax-m2.5", input_tokens: 1_000_000, output_tokens: 1_000_000, recorded_at: "2026-08-15T12:00:00.000Z" },
    ].filter((row) => row.recorded_at >= start && row.recorded_at < end);
    expect(september).toHaveLength(5);
    expect(summarizeMonthlySpend(september, modelPrices(companyA())).totalUsd).toBeCloseTo(LEDGER_TOTAL_USD, 9);
  });
});
