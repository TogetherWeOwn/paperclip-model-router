/**
 * Flag-gated stale-proposal withdraw verb (shadow output only, no live mutation).
 *
 * A stale proposal is a Decisions-page proposal that has sat unanswered for
 * more than N heartbeats. This verb answers one question on fixtures: "which
 * proposals would be marked withdrawn?" It returns a fresh shadow list and
 * never touches live state: it takes no plugin context, reads no
 * `ctx.state`/`ctx.db`, performs no `ctx.http` call, resolves no secret, and
 * auto-responds to nothing. There is deliberately no worker wiring — the verb
 * exists so tests and offline rehearsals can assert the withdraw shape before
 * anything is ever allowed near the live path.
 *
 * Flag: `WithdrawStaleProposalsOptions.enabled`, default `false` (off). When
 * off, every proposal reads as not withdrawn. When on, proposals with
 * `ageHeartbeats` strictly greater than `staleAfterHeartbeats` read as
 * withdrawn — except `humanOnly` proposals, which are always skipped.
 */

export interface StaleProposal {
  /** Stable proposal identifier carried through to the shadow output. */
  id: string;
  /** Heartbeats since the proposal was raised. Must be a finite number >= 0. */
  ageHeartbeats: number;
  /** Human-gated proposals are never withdrawn, however stale. */
  humanOnly?: boolean;
}

export interface StaleProposalWithdrawal {
  /** Mirrors the input proposal id. */
  id: string;
  /** True only when the flag is on, the proposal is stale, and not human-only. */
  withdrawn: boolean;
  /** Machine-readable reason: "stale" | "fresh" | "human-only-skipped" | "disabled". */
  reason: string;
}

export interface WithdrawStaleProposalsOptions {
  /**
   * Gate for the verb. Default `false`: the verb marks nothing unless the
   * caller explicitly opts in. There is no global default to flip — each call
   * site passes its own flag, so live routing cannot inherit an "on".
   */
  enabled?: boolean;
  /**
   * Proposals with `ageHeartbeats` strictly greater than this are stale.
   * Default {@link DEFAULT_STALE_AFTER_HEARTBEATS}. Non-finite or negative
   * values fall back to the default so a bad caller cannot withdraw the world.
   */
  staleAfterHeartbeats?: number;
}

/** Default staleness horizon in heartbeats when the caller names none. */
export const DEFAULT_STALE_AFTER_HEARTBEATS = 10;

function normalizeThreshold(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return DEFAULT_STALE_AFTER_HEARTBEATS;
  }
  return Math.floor(value);
}

function normalizeAge(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

/**
 * Mark stale proposals as withdrawn in a fresh shadow list.
 *
 * Pure: allocates a new array of new objects, never mutates the input array
 * or its entries, performs no I/O, reads no config, touches no live state.
 */
export function withdrawStaleProposals(
  proposals: readonly StaleProposal[],
  options?: WithdrawStaleProposalsOptions,
): StaleProposalWithdrawal[] {
  if (options?.enabled !== true) {
    return proposals.map((proposal) => ({ id: proposal.id, withdrawn: false, reason: "disabled" }));
  }
  const threshold = normalizeThreshold(options?.staleAfterHeartbeats);
  return proposals.map((proposal) => {
    if (proposal.humanOnly === true) {
      return { id: proposal.id, withdrawn: false, reason: "human-only-skipped" };
    }
    if (normalizeAge(proposal.ageHeartbeats) > threshold) {
      return { id: proposal.id, withdrawn: true, reason: "stale" };
    }
    return { id: proposal.id, withdrawn: false, reason: "fresh" };
  });
}
