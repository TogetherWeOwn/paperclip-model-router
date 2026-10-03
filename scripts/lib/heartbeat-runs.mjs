/**
 * Windowed heartbeat-run collector for scripts/routing-fidelity.mjs.
 *
 * What the API actually does (probed against the live host on 2026-10-03):
 * - `GET /api/companies/{id}/heartbeat-runs` returns newest-first and honors
 *   `limit` up to a hard cap of 1000. `offset`, `status` and every cursor or
 *   time param tried (`before`, `cursor`, `page`, `until`, `since`,
 *   `createdBefore`, `createdAfter`) are ignored: each of them returns the
 *   same newest page again.
 * - `agentId=<uuid>` IS honored, so one company-wide page cannot be paged
 *   backwards but each agent's newest 1000 runs can be read separately.
 *
 * So the collector reads one page per agent, dedupes by run id, and applies
 * the time window client-side. An agent whose full 1000-row page never reaches
 * back to the window start has more in-window runs than the API will return;
 * that agent is reported in `truncatedAgents` instead of being silently
 * under-counted.
 */

/** The server-side hard cap on `limit`. */
export const RUN_PAGE_LIMIT = 1000;

const AGENT_CONCURRENCY = 4;

function createdMs(run) {
  const ms = Date.parse(run?.createdAt ?? "");
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {object} opts
 * @param {(path: string) => Promise<unknown>} opts.api   GET helper returning parsed JSON.
 * @param {string} opts.companyId
 * @param {number} opts.sinceMs                           Window start (epoch ms), inclusive.
 * @param {number} [opts.untilMs]                         Window end (epoch ms), inclusive; default open.
 * @param {number} [opts.maxRuns]                         Optional cap on kept runs (newest first).
 * @param {number} [opts.pageLimit]
 */
export async function collectRuns({ api, companyId, sinceMs, untilMs = Infinity, maxRuns = Infinity, pageLimit = RUN_PAGE_LIMIT }) {
  const agents = await api(`/api/companies/${companyId}/agents`);
  if (!Array.isArray(agents)) throw new Error("agents list: expected an array");

  const byId = new Map();
  const truncatedAgents = [];
  let duplicateRowsDropped = 0;
  let undatedRows = 0;

  for (let i = 0; i < agents.length; i += AGENT_CONCURRENCY) {
    const pages = await Promise.all(
      agents.slice(i, i + AGENT_CONCURRENCY).map(async (agent) => {
        const page = await api(
          `/api/companies/${companyId}/heartbeat-runs?agentId=${encodeURIComponent(agent.id)}&limit=${pageLimit}`,
        );
        if (!Array.isArray(page)) throw new Error(`heartbeat-runs for agent ${agent.id}: expected an array`);
        return { agent, page };
      }),
    );

    for (const { agent, page } of pages) {
      // If the server stopped honoring agentId, every agent would return the
      // same company-wide page and the truncation test below would be wrong.
      // Dedupe would hide it; failing loudly does not.
      const foreign = page.find((r) => r?.agentId !== undefined && r.agentId !== agent.id);
      if (foreign) {
        throw new Error(
          `heartbeat-runs ignored agentId=${agent.id}: row ${foreign.id} belongs to agent ${foreign.agentId}`,
        );
      }

      let oldest = Infinity;
      for (const run of page) {
        const created = createdMs(run);
        if (created === null) {
          undatedRows += 1;
          continue;
        }
        oldest = Math.min(oldest, created);
        if (created < sinceMs || created > untilMs) continue;
        if (byId.has(run.id)) {
          duplicateRowsDropped += 1;
          continue;
        }
        byId.set(run.id, run);
      }

      // A full page whose oldest row is still inside the window start means
      // the API stopped returning rows before the window was exhausted.
      if (page.length >= pageLimit && oldest >= sinceMs) {
        truncatedAgents.push({
          agentId: agent.id,
          name: agent.name ?? null,
          rows: page.length,
          oldestFetched: new Date(oldest).toISOString(),
        });
      }
    }
  }

  const newestFirst = [...byId.values()].sort((a, b) => (createdMs(b) ?? 0) - (createdMs(a) ?? 0));
  const cappedAtMaxRuns = newestFirst.length > maxRuns;
  const rows = cappedAtMaxRuns ? newestFirst.slice(0, maxRuns) : newestFirst;

  return {
    rows,
    distinctRuns: rows.length,
    agentsScanned: agents.length,
    duplicateRowsDropped,
    undatedRows,
    truncatedAgents,
    cappedAtMaxRuns,
  };
}
