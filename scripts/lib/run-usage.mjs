/**
 * Per-run token and cost usage for resumed agent sessions.
 *
 * Why this exists: on a resumed session, `usageJson` and `resultJson.modelUsage`
 * hold the whole session's running total, not the run's own usage. Measured on
 * the live host (2026-10-07, claude CLI 2.1.284):
 * - consecutive runs of one session never decrease in tokens or cost
 *   (98-100% of about 5,000 consecutive pairs, for every model);
 * - 0 of 65 fresh runs but 70 of 85 resumed runs (sampled) report more API time
 *   (`duration_api_ms`) than wall time (`duration_ms`), which one run cannot do;
 * - the difference between two consecutive runs equals the later run's
 *   `resultJson.usage` (219 of 228 resumed runs agree within 10%, most exactly).
 *
 * Summing `usageJson` over runs therefore counts a session's early tokens once
 * per later run. Over a 7-day window the summed `costUsd` was 2.36x the
 * delta-based sum. The same artifact flatters any treatment that resets
 * sessions: a fresh session zeroes the counter, so spend "falls" with no change
 * in real consumption. Compare treatments on the delta basis only.
 *
 * The delta of a resumed run is its counters minus those of the previous run in
 * the same session: the run whose `sessionIdAfter` equals this run's
 * `sessionIdBefore`. A resumed run with no such predecessor in the data is
 * `anchored: false` and carries no usage rather than a cumulative total.
 */

export const USAGE_KEYS = ["inputTokens", "cachedInputTokens", "outputTokens", "costUsd"];

function counters(run) {
  const usage = run?.usageJson ?? {};
  const out = {};
  for (const key of USAGE_KEYS) {
    const value = usage[key];
    out[key] = typeof value === "number" && Number.isFinite(value) ? value : 0;
  }
  return out;
}

function createdMs(run) {
  const ms = Date.parse(run?.createdAt ?? "");
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {object[]} runs  Heartbeat-run rows, any order. Rows without `usageJson` are ignored.
 * @returns {{
 *   runs: Array<{
 *     id: string, agentId: string, createdAt: string, status: string,
 *     wakeReason: string|null, model: string|null, resumed: boolean,
 *     anchored: boolean, counterReset: boolean,
 *     usage: {inputTokens:number, cachedInputTokens:number, outputTokens:number, costUsd:number}|null,
 *     cumulative: {inputTokens:number, cachedInputTokens:number, outputTokens:number, costUsd:number},
 *   }>,
 *   unanchored: number,
 *   counterResets: number,
 * }}
 */
export function perRunUsage(runs) {
  const withUsage = runs.filter((r) => r?.usageJson && typeof r.usageJson === "object");

  // Earlier runs of each session, oldest first, keyed by the session they end in.
  const bySession = new Map();
  for (const run of withUsage) {
    if (!run.sessionIdAfter) continue;
    const key = `${run.agentId}\u0000${run.sessionIdAfter}`;
    const list = bySession.get(key) ?? [];
    list.push(run);
    bySession.set(key, list);
  }
  for (const list of bySession.values()) list.sort((a, b) => (createdMs(a) ?? 0) - (createdMs(b) ?? 0));

  const result = [];
  let unanchored = 0;
  let counterResets = 0;
  for (const run of withUsage) {
    const resumed = run.usageJson.sessionReused === true;
    const cumulative = counters(run);
    let usage = cumulative;
    let anchored = true;
    let counterReset = false;

    if (resumed) {
      const here = createdMs(run);
      const earlier = (bySession.get(`${run.agentId}\u0000${run.sessionIdBefore}`) ?? []).filter(
        (p) => p.id !== run.id && here !== null && (createdMs(p) ?? Infinity) < here,
      );
      const previous = earlier[earlier.length - 1];
      if (!previous) {
        anchored = false;
        usage = null;
        unanchored += 1;
      } else {
        const before = counters(previous);
        usage = {};
        for (const key of USAGE_KEYS) {
          const delta = cumulative[key] - before[key];
          if (delta < 0) {
            // The counter went backwards: the session's totals restarted, so
            // this run's own counters are its usage.
            counterReset = true;
            usage = cumulative;
            break;
          }
          usage[key] = delta;
        }
        if (counterReset) counterResets += 1;
      }
    }

    result.push({
      id: run.id,
      agentId: run.agentId,
      createdAt: run.createdAt,
      status: run.status,
      wakeReason: run.contextSnapshot?.wakeReason ?? null,
      model: run.usageJson.model ?? null,
      resumed,
      anchored,
      counterReset,
      usage,
      cumulative,
    });
  }
  return { runs: result, unanchored, counterResets };
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Totals, medians and the re-read-to-output ratio for runs that carry a delta. */
export function summarize(rows) {
  const used = rows.filter((r) => r.usage);
  const sum = (key) => used.reduce((acc, r) => acc + r.usage[key], 0);
  const input = sum("inputTokens");
  const cached = sum("cachedInputTokens");
  const output = sum("outputTokens");
  const cost = sum("costUsd");
  return {
    runs: used.length,
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    costUsd: cost,
    medianInputTokens: median(used.map((r) => r.usage.inputTokens)),
    medianCachedInputTokens: median(used.map((r) => r.usage.cachedInputTokens)),
    medianOutputTokens: median(used.map((r) => r.usage.outputTokens)),
    // (fresh + cache-read) tokens re-read per output token; null when nothing was written.
    rereadPerOutputToken: output > 0 ? (input + cached) / output : null,
    costPerRun: used.length > 0 ? cost / used.length : null,
  };
}

/** Group rows by `keyOf(row)` and summarize each group. */
export function summarizeBy(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return Object.fromEntries([...groups].map(([key, list]) => [key, summarize(list)]));
}
