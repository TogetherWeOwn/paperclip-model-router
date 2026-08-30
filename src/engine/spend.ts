import type { ModelEntry } from "./types.js";

/**
 * A company's month-to-date spend, as measured by the router's own completed
 * invocations. This is the feed that makes the budget gates real: before it
 * existed `budgetSpentFraction` was an optional caller-supplied signal that
 * nothing ever supplied, so `warn`/`downshift`/`halt` never fired and the whole
 * `budget` config block — `haltFraction` included — was decorative.
 *
 * It measures what the router spent, which is the only spend the router can
 * honestly claim to know about. Agent runs that bypass the router are not in it.
 */
export interface SpendLedger {
  /** Calendar month this total covers, as `YYYY-MM` in UTC. A new month resets
   * the total rather than carrying it, matching `budget.monthlyCapUsd`. */
  month: string;
  totalUsd: number;
  invocations: number;
}

export function emptyLedger(month: string): SpendLedger {
  return { month, totalUsd: 0, invocations: 0 };
}

/** `YYYY-MM` in UTC for an ISO timestamp. */
export function monthKey(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function isSpendLedger(value: unknown): value is SpendLedger {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SpendLedger>;
  return typeof candidate.month === "string" &&
    typeof candidate.totalUsd === "number" && Number.isFinite(candidate.totalUsd) &&
    typeof candidate.invocations === "number" && Number.isFinite(candidate.invocations);
}

/**
 * Cost of one completed invocation, from the model table's own per-MTok prices
 * and the usage the upstream reported. Returns 0 when the upstream reported no
 * usage — an unmetered call is not evidence of spend, and inventing an estimate
 * here would make the halt gate fire on numbers nobody can audit.
 */
export function invocationCostUsd(
  model: ModelEntry | undefined,
  usage: { inputTokens: number | null; outputTokens: number | null },
): number {
  if (!model) return 0;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  if (input === 0 && output === 0) return 0;
  return (input / 1_000_000) * model.costPerMTokIn + (output / 1_000_000) * model.costPerMTokOut;
}

/** Add one invocation's cost, rolling the month over when the calendar moves. */
export function accrue(ledger: SpendLedger, costUsd: number, at: Date): SpendLedger {
  const month = monthKey(at);
  const base = ledger.month === month ? ledger : emptyLedger(month);
  if (costUsd <= 0) return base === ledger ? ledger : base;
  return { month, totalUsd: base.totalUsd + costUsd, invocations: base.invocations + 1 };
}

/**
 * The fraction of the monthly cap this company has spent, or `undefined` when
 * no cap is configured. `undefined` keeps `gateLevelFor` at "ok" — an unset cap
 * means the operator has not asked for a limit, which is different from a cap
 * of zero.
 */
export function spentFraction(ledger: SpendLedger, monthlyCapUsd: number, at: Date): number | undefined {
  if (!Number.isFinite(monthlyCapUsd) || monthlyCapUsd <= 0) return undefined;
  if (ledger.month !== monthKey(at)) return 0;
  return ledger.totalUsd / monthlyCapUsd;
}
