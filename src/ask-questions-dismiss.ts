/**
 * Flag-gated ask_user_questions dismiss-path parity verb (shadow output only, no live mutation).
 *
 * An ask_user_questions interaction asks one question per disposition on
 * fixtures: "which answers would be recorded, and is the interaction closed?"
 * The host contract is:
 * - accept: the answers are recorded and the interaction closes.
 * - dismiss: nothing is recorded and the interaction still closes (state
 *   cleanup, no dangling interaction).
 *
 * This verb models that contract without touching it: it takes fixture
 * questions and a disposition string, returns a fresh shadow outcome, and
 * never touches live state. It takes no plugin context, reads no
 * `ctx.state`/`ctx.db`, performs no `ctx.http` call, resolves no secret, and
 * records no answer or response. There is deliberately no worker wiring — the
 * verb exists so tests and offline rehearsals can assert the dismiss shape
 * before anything is ever allowed near the live path.
 *
 * Flag: `ResolveAskQuestionsOptions.enabled`, default `false` (off). When
 * off, the verb returns the legacy plugin behavior: nothing recorded and the
 * interaction left open (`reason: "disabled"`), whatever the disposition.
 * When on, `dismiss` returns no recordings with a closed interaction (host
 * parity), `accept` returns one recorded id per question with a closed
 * interaction, and any other disposition returns nothing recorded with the
 * interaction left open (`reason: "unknown-disposition"`) rather than
 * guessing.
 */

/** One fixture question: the only fields the outcome carries through. */
export interface AskedQuestionFixture {
  /** Stable question identifier carried through to the shadow output. */
  id: string;
  /** Short human-readable prompt; carried for readability, never executed. */
  prompt: string;
}

/** Shadow outcome: what would be recorded and whether the interaction would close. */
export interface AskQuestionsOutcome {
  /** Ids that would be recorded. Empty on every dismiss path. */
  recordedIds: string[];
  /** Host interaction state after the disposition: "open" or "closed". */
  interactionStatus: "open" | "closed";
  /** Machine-readable reason: "accepted" | "dismissed" | "unknown-disposition" | "disabled". */
  reason: string;
}

export interface ResolveAskQuestionsOptions {
  /**
   * Gate for the verb. Default `false`: the verb returns the legacy
   * open/nothing-recorded shape unless the caller explicitly opts in. There
   * is no global default to flip — each call site passes its own flag, so
   * live routing cannot inherit an "on".
   */
  enabled?: boolean;
}

function normalizeId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Resolve an ask_user_questions disposition to its shadow outcome.
 *
 * Pure: allocates a new outcome with a new ids array, never mutates the input
 * array or its entries, performs no I/O, reads no config, touches no live
 * state.
 */
export function resolveAskQuestionsOutcome(
  questions: readonly AskedQuestionFixture[],
  disposition: string,
  options?: ResolveAskQuestionsOptions,
): AskQuestionsOutcome {
  if (options?.enabled !== true) {
    return { recordedIds: [], interactionStatus: "open", reason: "disabled" };
  }
  if (disposition === "dismiss") {
    return { recordedIds: [], interactionStatus: "closed", reason: "dismissed" };
  }
  if (disposition === "accept") {
    const recordedIds: string[] = [];
    if (Array.isArray(questions)) {
      for (const question of questions) {
        const id = normalizeId((question as AskedQuestionFixture | null)?.id);
        if (id !== null) recordedIds.push(id);
      }
    }
    return { recordedIds, interactionStatus: "closed", reason: "accepted" };
  }
  return { recordedIds: [], interactionStatus: "open", reason: "unknown-disposition" };
}
