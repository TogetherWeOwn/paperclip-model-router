import type { ModelEntry } from "../engine/types.js";
import type { CatalogueProbe, HealthFlip, ModelHealthEntry, ModelHealthState } from "./types.js";

/** Consecutive dead observations before a model is actually taken out of
 * service. Two, not one: the probe runs often enough that waiting for a second
 * confirmation costs minutes, and a single bad catalogue read is the far more
 * likely event. */
export const DEAD_STRIKES = 2;

function entryFor(state: ModelHealthState, modelId: string): ModelHealthEntry {
  return state[modelId] ?? { verdict: "unknown", checkedAt: "", reason: "never probed", strikes: 0 };
}

/**
 * Fold one catalogue probe into stored health.
 *
 * An indeterminate probe (`modelIds === null`) changes nothing at all — it does
 * not reset strikes and it does not add them. The router keeps whatever it last
 * knew rather than inventing a verdict from a failed request.
 */
export function reconcileHealth(input: {
  models: ModelEntry[];
  probe: CatalogueProbe;
  previous: ModelHealthState;
  now: string;
}): { next: ModelHealthState; flips: HealthFlip[] } {
  const { models, probe, previous, now } = input;
  if (probe.modelIds === null) {
    return { next: previous, flips: [] };
  }

  const next: ModelHealthState = {};
  const flips: HealthFlip[] = [];

  for (const model of models) {
    const before = entryFor(previous, model.id);
    const present = probe.modelIds.has(model.id);

    if (present) {
      next[model.id] = { verdict: "healthy", checkedAt: now, reason: "present in the upstream catalogue", strikes: 0 };
      // Only a model that was actually out of service is "returning" to it.
      // `unknown -> healthy` is just the first probe, and logging that would
      // announce the whole table on every fresh install.
      if (before.verdict === "dead") {
        flips.push({
          modelId: model.id,
          from: "dead",
          to: "healthy",
          reason: "present in the upstream catalogue again",
        });
      }
      continue;
    }

    const strikes = before.strikes + 1;
    const reason = `absent from the upstream catalogue (${strikes}/${DEAD_STRIKES} consecutive)`;
    if (strikes >= DEAD_STRIKES) {
      next[model.id] = { verdict: "dead", checkedAt: now, reason, strikes };
      if (before.verdict !== "dead") {
        flips.push({ modelId: model.id, from: before.verdict, to: "dead", reason });
      }
    } else {
      // Not enough evidence yet. Keep serving it, but remember the strike.
      next[model.id] = { verdict: before.verdict, checkedAt: now, reason, strikes };
    }
  }

  return { next, flips };
}

/**
 * Apply stored health on top of the operator's model table.
 *
 * Direction matters: this can only ever remove a model from service. A model the
 * operator disabled stays disabled no matter how healthy the upstream says it is.
 */
export function applyHealth(models: ModelEntry[], health: ModelHealthState): ModelEntry[] {
  return models.map((model) =>
    health[model.id]?.verdict === "dead" ? { ...model, enabled: false } : model,
  );
}
