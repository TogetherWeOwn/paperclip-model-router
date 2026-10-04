/**
 * Flag-gated suggest_tasks dismiss-path parity verb (shadow output only, no live mutation).
 *
 * A suggest_tasks interaction proposes follow-up tasks. The host answers one
 * question per disposition on fixtures: "which tasks would exist, and is the
 * interaction closed?" The host contract is:
 * - accept: the suggested tasks are created and the interaction closes.
 * - dismiss: no task is created and the interaction still closes.
 *
 * This verb models that contract without touching it: it takes fixture
 * suggestions and a disposition string, returns a fresh shadow outcome, and
 * never touches live state. It takes no plugin context, reads no
 * `ctx.state`/`ctx.db`, performs no `ctx.http` call, resolves no secret, and
 * creates no task or response. There is deliberately no worker wiring — the
 * verb exists so tests and offline rehearsals can assert the dismiss shape
 * before anything is ever allowed near the live path.
 *
 * Flag: `ResolveSuggestTasksOptions.enabled`, default `false` (off). When
 * off, the verb returns the legacy plugin behavior: nothing created and the
 * interaction left open (`reason: "disabled"`), whatever the disposition.
 * When on, `dismiss` returns no tasks with a closed interaction (host parity),
 * `accept` returns one created id per suggestion with a closed interaction,
 * and any other disposition returns nothing created with the interaction left
 * open (`reason: "unknown-disposition"`) rather than guessing.
 */

/** One fixture suggestion: the only fields the outcome carries through. */
export interface SuggestedTaskFixture {
  /** Stable suggestion identifier carried through to the shadow output. */
  id: string;
  /** Short human-readable title; carried for readability, never executed. */
  title: string;
}

/** Shadow outcome: what would exist and whether the interaction would close. */
export interface SuggestTasksOutcome {
  /** Ids that would be created. Empty on every dismiss path. */
  createdIds: string[];
  /** Host interaction state after the disposition: "open" or "closed". */
  interactionStatus: "open" | "closed";
  /** Machine-readable reason: "accepted" | "dismissed" | "unknown-disposition" | "disabled". */
  reason: string;
}

export interface ResolveSuggestTasksOptions {
  /**
   * Gate for the verb. Default `false`: the verb returns the legacy
   * open/no-create shape unless the caller explicitly opts in. There is no
   * global default to flip — each call site passes its own flag, so live
   * routing cannot inherit an "on".
   */
  enabled?: boolean;
}

function normalizeId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Resolve a suggest_tasks disposition to its shadow outcome.
 *
 * Pure: allocates a new outcome with a new ids array, never mutates the input
 * array or its entries, performs no I/O, reads no config, touches no live
 * state.
 */
export function resolveSuggestTasksOutcome(
  suggestions: readonly SuggestedTaskFixture[],
  disposition: string,
  options?: ResolveSuggestTasksOptions,
): SuggestTasksOutcome {
  if (options?.enabled !== true) {
    return { createdIds: [], interactionStatus: "open", reason: "disabled" };
  }
  if (disposition === "dismiss") {
    return { createdIds: [], interactionStatus: "closed", reason: "dismissed" };
  }
  if (disposition === "accept") {
    const createdIds: string[] = [];
    if (Array.isArray(suggestions)) {
      for (const suggestion of suggestions) {
        const id = normalizeId((suggestion as SuggestedTaskFixture | null)?.id);
        if (id !== null) createdIds.push(id);
      }
    }
    return { createdIds, interactionStatus: "closed", reason: "accepted" };
  }
  return { createdIds: [], interactionStatus: "open", reason: "unknown-disposition" };
}
