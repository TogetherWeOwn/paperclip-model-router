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
 */
export function resolveBudgetSpentFraction(
  authoritative: number | undefined,
  callerClaimed: number | undefined,
): number | undefined {
  return authoritative ?? callerClaimed;
}
