import type { RouterConfig } from "./config/types.js";

/**
 * TOG-7891 (Gap G4): the monthly spend ledger.
 *
 * Budget gates used to run off a spent fraction handed in from outside — a
 * host-injected run fraction (TOG-7417) or a caller-claimed
 * `task.signals.budgetSpentFraction` — while the per-row tokens×price the
 * audit trail already records were never summed. `monthlyCapUsd` therefore
 * could not be enforced from history.
 *
 * This module turns `decision_records` into the enforcement source: a
 * company-scoped rollup of `(input_tokens × price_in + output_tokens ×
 * price_out)` over the current calendar month, whose fraction
 * (`totalUsd / monthlyCapUsd`) drives the same warn/downshift/halt gates in
 * `selectModel`. Prices come from the live model table
 * (`costPerMTokIn/Out`); rows naming a model absent from the table, or
 * carrying null/unreadable token counts, price at $0 rather than failing the
 * rollup.
 *
 * Timezone rule: the month window is the UTC calendar month containing
 * "now" — `[startOfMonthUTC, startOfNextMonthUTC)`. `recorded_at` is
 * `timestamptz`, the company has no timezone setting, and UTC is the only
 * deterministic boundary a reviewer can recompute by hand.
 *
 * Failure posture is fail-open (the TOG-1040 principle): a ledger read that
 * errors returns null and the worker falls back to the
 * injected-or-caller fraction exactly as before. A ledger outage degrades
 * budget accuracy; it never denies service.
 */

export interface MonthWindow {
  /** Inclusive lower bound, ISO-8601 UTC (`recorded_at >= start`). */
  startIso: string;
  /** Exclusive upper bound, ISO-8601 UTC (`recorded_at < end`). */
  endIso: string;
  /** `YYYY-MM` label for traces. */
  monthLabel: string;
}

export function monthWindowUtc(now: Date): MonthWindow {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const startIso = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)).toISOString();
  const endIso = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)).toISOString();
  return {
    startIso,
    endIso,
    monthLabel: `${year}-${String(month + 1).padStart(2, "0")}`,
  };
}

export interface ModelPrices {
  costPerMTokIn: number;
  costPerMTokOut: number;
}

export function modelPrices(config: RouterConfig): Map<string, ModelPrices> {
  const prices = new Map<string, ModelPrices>();
  for (const model of config.models) {
    prices.set(model.id, {
      costPerMTokIn: model.costPerMTokIn,
      costPerMTokOut: model.costPerMTokOut,
    });
  }
  return prices;
}

/** One ledger row as the host returns it (`bigint` columns may arrive as numeric strings). */
export interface SpendLedgerRow {
  modelId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

function asTokenCount(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    if (value.trim() === "") return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return Math.trunc(parsed);
  }
  return null;
}

function asModelId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Defensively normalize one raw DB row; garbage prices at $0 through nulls, never throws. */
export function normalizeSpendRow(row: unknown): SpendLedgerRow {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return { modelId: null, inputTokens: null, outputTokens: null };
  }
  const record = row as Record<string, unknown>;
  return {
    modelId: asModelId(record.model_id),
    inputTokens: asTokenCount(record.input_tokens),
    outputTokens: asTokenCount(record.output_tokens),
  };
}

export function rowCostUsd(row: SpendLedgerRow, prices: Map<string, ModelPrices>): number {
  if (!row.modelId) return 0;
  const price = prices.get(row.modelId);
  if (!price) return 0;
  const input = row.inputTokens ?? 0;
  const output = row.outputTokens ?? 0;
  return (input / 1_000_000) * price.costPerMTokIn + (output / 1_000_000) * price.costPerMTokOut;
}

export interface MonthlySpendSummary {
  totalUsd: number;
  /** Rows in the window, including $0 rows (unknown model, null tokens). */
  rowCount: number;
}

/**
 * Dollars for trace lines: exact when the value is an exact cent amount,
 * four decimals otherwise (token prices routinely produce fractions of a
 * cent — truncating to two decimals would make a hand recomputation look
 * "wrong" by a cent).
 */
export function formatUsd(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  if (Object.is(rounded, -0) || Math.abs(value - rounded) < 1e-9) {
    return rounded.toFixed(2);
  }
  return value.toFixed(4);
}

export function summarizeMonthlySpend(
  rows: unknown[],
  prices: Map<string, ModelPrices>,
): MonthlySpendSummary {
  let totalUsd = 0;
  for (const raw of rows) {
    totalUsd += rowCostUsd(normalizeSpendRow(raw), prices);
  }
  return { totalUsd, rowCount: rows.length };
}

/**
 * The fraction the budget gates move off. Undefined when there is no cap to
 * enforce against (`monthlyCapUsd <= 0`, the default) or the inputs are not
 * usable — the caller then keeps the legacy injected-or-caller path.
 */
export function spendFractionFor(totalUsd: number, monthlyCapUsd: number): number | undefined {
  if (!Number.isFinite(totalUsd) || totalUsd < 0) return undefined;
  if (!Number.isFinite(monthlyCapUsd) || monthlyCapUsd <= 0) return undefined;
  return totalUsd / monthlyCapUsd;
}

function spendLedgerTable(namespace: string): string {
  return `${namespace}.decision_records`;
}

/**
 * Company-scoped month-window read. Params are
 * `[companyId, windowStartIso, windowEndIso]`; only the columns the rollup
 * needs are selected. The `>=` / `<` pairing is the half-open UTC month from
 * `monthWindowUtc` — a row stamped exactly on the boundary belongs to the
 * month it opens.
 */
export function spendLedgerSql(namespace: string): string {
  return `SELECT model_id, input_tokens, output_tokens FROM ${spendLedgerTable(namespace)}
   WHERE company_id = $1 AND recorded_at >= $2::timestamptz AND recorded_at < $3::timestamptz`;
}

/** Minimal structural surface the ledger read needs — `ctx.db` satisfies this. */
export interface SpendLedgerStore {
  namespace: string;
  query(sql: string, params: unknown[]): Promise<unknown[]>;
}

/** Minimal log surface — `ctx.logger` satisfies this. */
export interface SpendLedgerLog {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface MonthlySpendLedger {
  /**
   * The fraction the budget gates move off (`totalUsd / monthlyCapUsd`), or
   * undefined when there is nothing enforceable: no positive cap configured,
   * or the ledger could not be read (fail-open — the caller falls back to
   * the injected-or-caller fraction).
   */
  fraction: number | undefined;
  /**
   * The rollup backing the fraction; non-null if and only if the read
   * succeeded. Backs `decision.budget` and the trace line.
   */
  ledger: { totalUsd: number; rowCount: number; monthLabel: string } | null;
}

/**
 * Read this company's current-UTC-month spend from `decision_records` and
 * express it as a fraction of `monthlyCapUsd`.
 *
 * Skips the query entirely when no positive cap is configured (enforcement
 * off — the legacy path rules, with no extra DB traffic). Any query failure
 * warns once and returns an unreadable ledger so the worker falls back to
 * the injected-or-caller fraction: a ledger outage degrades budget accuracy,
 * never service.
 */
export async function readMonthlySpendLedger(
  store: SpendLedgerStore,
  log: SpendLedgerLog,
  companyId: string,
  config: RouterConfig,
  now: Date,
): Promise<MonthlySpendLedger> {
  const cap = config.budget.monthlyCapUsd;
  if (!Number.isFinite(cap) || cap <= 0) {
    return { fraction: undefined, ledger: null };
  }
  const window = monthWindowUtc(now);
  let rows: unknown[];
  try {
    rows = await store.query(
      spendLedgerSql(store.namespace),
      [companyId, window.startIso, window.endIso],
    );
  } catch {
    log.warn(
      "Monthly spend ledger unreadable; budget gates fall back to the injected-or-caller fraction",
      { companyId, month: window.monthLabel },
    );
    return { fraction: undefined, ledger: null };
  }
  const summary = summarizeMonthlySpend(
    Array.isArray(rows) ? rows : [],
    modelPrices(config),
  );
  return {
    fraction: spendFractionFor(summary.totalUsd, cap),
    ledger: { totalUsd: summary.totalUsd, rowCount: summary.rowCount, monthLabel: window.monthLabel },
  };
}
