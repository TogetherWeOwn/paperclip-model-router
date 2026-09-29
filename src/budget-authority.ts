/**
 * TOG-7417: the host is the authority on how much of a run's budget is spent.
 *
 * `task.signals.budgetSpentFraction` is caller-supplied and any caller can
 * forge it (low to dodge the halt gate, high to force a downshift). The host
 * injects the authoritative fraction through the tool/action context — a
 * channel the caller cannot write to — and `prepareInvocation` prefers it.
 * The engine (`selectModel`) is unchanged: it only moves the
 * warn/downshift/halt gates off whatever fraction it is handed and cannot
 * tell the two sources apart, so the preference has to live here.
 *
 * The stock SDK `ToolRunContext` / action actor types do not declare this
 * field yet, so extraction is structural (a cast + finite-number validation)
 * rather than typed. An absent or non-finite value means "host did not
 * inject", and the caller signal is used exactly as before.
 */

export function asFiniteFraction(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Read the host-injected authoritative fraction off a tool/action context. */
export function extractAuthoritativeBudgetSpentFraction(context: unknown): number | undefined {
  if (!context || typeof context !== "object") return undefined;
  return asFiniteFraction((context as Record<string, unknown>).budgetSpentFraction);
}

/**
 * The authoritative fraction wins whenever the host injected one; otherwise
 * the caller-supplied signal flows through unchanged (including undefined).
 *
 * Kept for TOG-7417 callers that resolve only the injected-vs-caller pair.
 * The worker's enforcement path uses `resolveEffectiveBudgetSpentFraction`,
 * which folds the spend ledger in as well.
 */
export function resolveBudgetSpentFraction(
  authoritative: number | undefined,
  callerClaimed: number | undefined,
): number | undefined {
  return authoritative ?? callerClaimed;
}

/**
 * TOG-7891 (Gap G4): which trusted channel the budget gates moved off.
 *
 * - `ledger`: the company-scoped monthly spend rollup from decision_records.
 * - `authoritative`: the TOG-7417 host injection through the tool/action context.
 * - `caller`: the untrusted caller-claimed `task.signals.budgetSpentFraction`.
 * - `none`: no fraction anywhere; the gates rest at `ok`.
 */
export type BudgetFractionSource = "ledger" | "authoritative" | "caller" | "none";

/**
 * TOG-7891 (Gap G4): fold the monthly spend ledger into the fraction the
 * budget gates move off.
 *
 * The ledger measures exactly the capped quantity — this company's
 * decision_records tokens×price over the current UTC calendar month — so a
 * readable ledger is ground truth the caller claim can neither dodge nor
 * force. The TOG-7417 host injection stays in the chain because the host may
 * track spend outside decision_records: both trusted sources count, and the
 * HIGHER wins, so enforcement is never looser than the host's authoritative
 * reading. The caller claim is untrusted and survives only when neither
 * trusted source exists (the legacy path); a forged-high claim loses to a
 * quiet ledger exactly like a forged-low one does.
 *
 * Non-finite inputs (including NaN) count as absent on every channel.
 */
export function resolveEffectiveBudgetSpentFraction(
  ledger: number | undefined,
  authoritative: number | undefined,
  callerClaimed: number | undefined,
): { fraction: number | undefined; source: BudgetFractionSource } {
  const trusted: Array<{ fraction: number; source: BudgetFractionSource }> = [];
  if (typeof ledger === "number" && Number.isFinite(ledger)) {
    trusted.push({ fraction: ledger, source: "ledger" });
  }
  if (typeof authoritative === "number" && Number.isFinite(authoritative)) {
    trusted.push({ fraction: authoritative, source: "authoritative" });
  }
  if (trusted.length > 0) {
    let winner = trusted[0]!;
    for (const entry of trusted) {
      if (entry.fraction > winner.fraction) winner = entry;
    }
    return winner;
  }
  if (typeof callerClaimed === "number" && Number.isFinite(callerClaimed)) {
    return { fraction: callerClaimed, source: "caller" };
  }
  return { fraction: undefined, source: "none" };
}
