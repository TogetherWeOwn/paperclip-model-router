import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The heartbeat-runs list endpoint returns the newest `limit` rows (hard cap
// 1000) and IGNORES `offset`, `status` and every cursor or time param; only
// `agentId` filters. The first version of routing-fidelity.mjs paged with
// `offset` and so fetched the same newest page 25 times: every count came out a
// multiple of 25 and a "24 h" window covered 77 minutes.
//
// The fixture below reproduces that server. A reader that pages by offset gets
// duplicate rows from it; the per-agent reader must not.

// scripts/ is outside tsconfig's `include` and has no declarations, so resolve
// the module through a computed specifier (see ci-health.spec.ts).
interface Run {
  id: string;
  agentId: string;
  createdAt: string;
  contextSnapshot?: { issueId?: string; wakeReason?: string };
  usageJson?: { model?: string };
}
interface Agent {
  id: string;
  name: string;
}
interface Collected {
  rows: Run[];
  distinctRuns: number;
  agentsScanned: number;
  duplicateRowsDropped: number;
  undatedRows: number;
  truncatedAgents: { agentId: string; name: string | null; rows: number; oldestFetched: string }[];
  cappedAtMaxRuns: boolean;
}
interface HeartbeatRuns {
  RUN_PAGE_LIMIT: number;
  collectRuns(opts: {
    api: (path: string) => Promise<unknown>;
    companyId: string;
    sinceMs: number;
    untilMs?: number;
    maxRuns?: number;
    pageLimit?: number;
  }): Promise<Collected>;
}
const specifier = new URL("../scripts/lib/heartbeat-runs.mjs", import.meta.url).href;
const lib: HeartbeatRuns = await import(/* @vite-ignore */ specifier);

const COMPANY = "co-1";
const HOUR = 3600 * 1000;
const NOW = Date.parse("2026-10-03T08:00:00.000Z");
const SINCE = NOW - 24 * HOUR;

const iso = (ms: number) => new Date(ms).toISOString();

/** `count` runs for one agent, newest at `newestMs`, one per `stepMs` going back. */
function runsFor(agentId: string, count: number, newestMs: number, stepMs: number, prefix = agentId): Run[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-run-${i}`,
    agentId,
    createdAt: iso(newestMs - i * stepMs),
    contextSnapshot: { issueId: `issue-${agentId}`, wakeReason: i === count - 1 ? "issue_assigned" : "issue_monitor_due" },
    usageJson: { model: "claude-sonnet-5-5" },
  }));
}

/** The live endpoint's behaviour: newest-first, `limit` (cap 1000) and `agentId` honored, nothing else. */
function fakeServer(agents: Agent[], runs: Run[]) {
  const requested: string[] = [];
  const api = async (path: string): Promise<unknown> => {
    requested.push(path);
    return serve(path);
  };
  const serve = (path: string): unknown => {
    const url = new URL(path, "http://fixture");
    if (url.pathname === `/api/companies/${COMPANY}/agents`) return agents;
    if (url.pathname === `/api/companies/${COMPANY}/heartbeat-runs`) {
      const agentId = url.searchParams.get("agentId");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 1000);
      return runs
        .filter((r) => agentId === null || r.agentId === agentId)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, limit);
    }
    throw new Error(`fixture: unexpected path ${path}`);
  };
  return { api, requested, serve };
}

const agentA: Agent = { id: "A", name: "Agent A" };
const agentB: Agent = { id: "B", name: "Agent B" };
const agentC: Agent = { id: "C", name: "Agent C" };

describe("fixture fidelity: the legacy offset loop really duplicates against it", () => {
  it("returns the same rows for every offset", async () => {
    const { serve } = fakeServer([agentA], runsFor("A", 500, NOW, 60_000));
    const first = serve(`/api/companies/${COMPANY}/heartbeat-runs?limit=200&offset=0`) as Run[];
    const later = serve(`/api/companies/${COMPANY}/heartbeat-runs?limit=200&offset=800`) as Run[];
    expect(later.map((r) => r.id)).toEqual(first.map((r) => r.id));
  });

  it("makes a 25-page offset loop collect 25x duplicates", async () => {
    const { serve } = fakeServer([agentA], runsFor("A", 500, NOW, 60_000));
    const legacy: Run[] = [];
    for (let offset = 0; offset < 5000; offset += 200) {
      legacy.push(...(serve(`/api/companies/${COMPANY}/heartbeat-runs?limit=200&offset=${offset}`) as Run[]));
    }
    expect(legacy).toHaveLength(5000);
    expect(new Set(legacy.map((r) => r.id)).size).toBe(200);
  });
});

describe("collectRuns", () => {
  it("never repeats a request, never sends offset or a cursor, and returns each run once", async () => {
    const runs = [...runsFor("A", 300, NOW, 60_000), ...runsFor("B", 120, NOW - 5000, 120_000), ...runsFor("C", 40, NOW - 9000, 600_000)];
    const { api, requested } = fakeServer([agentA, agentB, agentC], runs);
    const out = await lib.collectRuns({ api, companyId: COMPANY, sinceMs: SINCE });

    // One agents call plus exactly one runs call per agent: a repeated page is a failure.
    expect(new Set(requested).size).toBe(requested.length);
    expect(requested).toHaveLength(1 + 3);
    for (const path of requested) expect(path).not.toMatch(/[?&](offset|cursor|before|page|until)=/);

    const ids = out.rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(out.distinctRuns).toBe(300 + 120 + 40);
    expect(out.duplicateRowsDropped).toBe(0);
    expect(out.agentsScanned).toBe(3);
    expect(out.truncatedAgents).toEqual([]);
  });

  it("covers a 24 h window that a single company-wide page could not", async () => {
    // 2400 in-window runs from three agents: one company-wide page (cap 1000)
    // reaches back ~10 h, the per-agent reader reaches all 24 h.
    const step = (24 * HOUR) / 800;
    const runs = ["A", "B", "C"].flatMap((id) => runsFor(id, 800, NOW, step - 1));
    const { api, serve } = fakeServer([agentA, agentB, agentC], runs);

    const companyWide = serve(`/api/companies/${COMPANY}/heartbeat-runs?limit=5000`) as Run[];
    const oldestCompanyWide = Math.min(...companyWide.map((r) => Date.parse(r.createdAt)));
    expect(NOW - oldestCompanyWide).toBeLessThan(10 * HOUR);

    const out = await lib.collectRuns({ api, companyId: COMPANY, sinceMs: SINCE });
    expect(out.distinctRuns).toBe(2400);
    const oldest = Math.min(...out.rows.map((r) => Date.parse(r.createdAt)));
    expect(NOW - oldest).toBeGreaterThan(23 * HOUR);
    expect(out.truncatedAgents).toEqual([]);
  });

  it("applies the window client-side and keeps a run exactly at the boundary", async () => {
    const runs: Run[] = [
      { id: "new", agentId: "A", createdAt: iso(NOW) },
      { id: "edge", agentId: "A", createdAt: iso(SINCE) },
      { id: "old", agentId: "A", createdAt: iso(SINCE - 1) },
    ];
    const { api } = fakeServer([agentA], runs);
    const out = await lib.collectRuns({ api, companyId: COMPANY, sinceMs: SINCE });
    expect(out.rows.map((r) => r.id)).toEqual(["new", "edge"]);
  });

  it("applies untilMs as an inclusive window end", async () => {
    const runs: Run[] = [
      { id: "future", agentId: "A", createdAt: iso(NOW + 1) },
      { id: "edge", agentId: "A", createdAt: iso(NOW) },
      { id: "inside", agentId: "A", createdAt: iso(NOW - HOUR) },
    ];
    const { api } = fakeServer([agentA], runs);
    const out = await lib.collectRuns({ api, companyId: COMPANY, sinceMs: SINCE, untilMs: NOW });
    expect(out.rows.map((r) => r.id)).toEqual(["edge", "inside"]);
  });

  it("returns rows newest first", async () => {
    const { api } = fakeServer([agentA, agentB], [...runsFor("A", 5, NOW, 60_000), ...runsFor("B", 5, NOW - 30_000, 60_000)]);
    const out = await lib.collectRuns({ api, companyId: COMPANY, sinceMs: SINCE });
    const times = out.rows.map((r) => Date.parse(r.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  describe("truncation", () => {
    it("flags an agent whose whole 1000-row page is inside the window", async () => {
      // 1000 rows spread over 10 h: the page is full and fully in-window, so
      // older in-window runs may exist that the API will not return.
      const busy = runsFor("B", lib.RUN_PAGE_LIMIT, NOW, 36_000);
      const { api } = fakeServer([agentA, agentB], [...runsFor("A", 10, NOW, 60_000), ...busy]);
      const out = await lib.collectRuns({ api, companyId: COMPANY, sinceMs: SINCE });
      expect(out.truncatedAgents).toEqual([
        {
          agentId: "B",
          name: "Agent B",
          rows: 1000,
          oldestFetched: iso(NOW - 999 * 36_000),
        },
      ]);
    });

    it("does not flag a full page that already reaches past the window start", async () => {
      // 1000 rows over 48 h: the page crosses the window start, so the window is complete.
      const full = runsFor("B", lib.RUN_PAGE_LIMIT, NOW, (48 * HOUR) / 1000);
      const { api } = fakeServer([agentB], full);
      const out = await lib.collectRuns({ api, companyId: COMPANY, sinceMs: SINCE });
      expect(out.truncatedAgents).toEqual([]);
      expect(out.distinctRuns).toBeLessThan(1000);
    });

    it("does not flag a short page, however recent", async () => {
      const { api } = fakeServer([agentA], runsFor("A", 999, NOW, 1000));
      const out = await lib.collectRuns({ api, companyId: COMPANY, sinceMs: SINCE });
      expect(out.truncatedAgents).toEqual([]);
      expect(out.distinctRuns).toBe(999);
    });

    it("flags a full page that stops short of the window start when untilMs excludes all of it", async () => {
      // Re-running an earlier window: the agent's 1000 newest rows are all
      // newer than untilMs, so none of the requested window is reachable.
      const busy = runsFor("B", lib.RUN_PAGE_LIMIT, NOW, 36_000);
      const { api } = fakeServer([agentB], busy);
      const out = await lib.collectRuns({ api, companyId: COMPANY, sinceMs: NOW - 30 * HOUR, untilMs: NOW - 20 * HOUR });
      expect(out.distinctRuns).toBe(0);
      expect(out.truncatedAgents.map((a) => a.agentId)).toEqual(["B"]);
    });

    it("honors an explicit page limit", async () => {
      const { api, requested } = fakeServer([agentA], runsFor("A", 50, NOW, 1000));
      const out = await lib.collectRuns({ api, companyId: COMPANY, sinceMs: SINCE, pageLimit: 10 });
      expect(requested[1]).toContain("limit=10");
      expect(out.distinctRuns).toBe(10);
      expect(out.truncatedAgents.map((a) => a.agentId)).toEqual(["A"]);
    });
  });

  it("fails loudly when the server stops honoring agentId", async () => {
    // Without the guard this would dedupe to a plausible-looking total while
    // every agent's truncation verdict was computed from someone else's page.
    const runs = [...runsFor("A", 5, NOW, 1000), ...runsFor("B", 5, NOW, 1000)];
    const api = async (path: string) => {
      const url = new URL(path, "http://fixture");
      if (url.pathname.endsWith("/agents")) return [agentA, agentB];
      return runs;
    };
    await expect(lib.collectRuns({ api, companyId: COMPANY, sinceMs: SINCE })).rejects.toThrow(/ignored agentId/);
  });

  it("dedupes a run id that appears under two agents and counts the drop", async () => {
    const shared: Run = { id: "shared", agentId: "A", createdAt: iso(NOW) };
    const api = async (path: string) => {
      const url = new URL(path, "http://fixture");
      if (url.pathname.endsWith("/agents")) return [agentA, agentB];
      return url.searchParams.get("agentId") === "A"
        ? [shared]
        : [{ ...shared, agentId: "B" }];
    };
    const out = await lib.collectRuns({ api, companyId: COMPANY, sinceMs: SINCE });
    expect(out.distinctRuns).toBe(1);
    expect(out.duplicateRowsDropped).toBe(1);
  });

  it("counts rows with no usable createdAt instead of windowing them in", async () => {
    const runs: Run[] = [
      { id: "ok", agentId: "A", createdAt: iso(NOW) },
      { id: "bad", agentId: "A", createdAt: "not-a-date" },
    ];
    const { api } = fakeServer([agentA], runs);
    const out = await lib.collectRuns({ api, companyId: COMPANY, sinceMs: SINCE });
    expect(out.rows.map((r) => r.id)).toEqual(["ok"]);
    expect(out.undatedRows).toBe(1);
  });

  it("keeps the newest rows under maxRuns and says it capped", async () => {
    const { api } = fakeServer([agentA], runsFor("A", 20, NOW, 1000));
    const out = await lib.collectRuns({ api, companyId: COMPANY, sinceMs: SINCE, maxRuns: 5 });
    expect(out.cappedAtMaxRuns).toBe(true);
    expect(out.rows.map((r) => r.id)).toEqual(["A-run-0", "A-run-1", "A-run-2", "A-run-3", "A-run-4"]);
    const uncapped = await lib.collectRuns({ api, companyId: COMPANY, sinceMs: SINCE, maxRuns: 20 });
    expect(uncapped.cappedAtMaxRuns).toBe(false);
  });
});

// End to end: run the real script against a local server with the live
// endpoint's behaviour. The old script printed a totalRuns that was a multiple
// of 25 here.
describe("scripts/routing-fidelity.mjs against an offset-ignoring server", () => {
  const exec = promisify(execFile);
  const script = fileURLToPath(new URL("../scripts/routing-fidelity.mjs", import.meta.url));
  let server: Server;
  let baseUrl = "";
  let runsRequested: string[] = [];

  beforeAll(async () => {
    const now = Date.now();
    const agents = [agentA, agentB];
    // A: 130 recent runs. B: a full 1000-row page entirely inside the 24 h window.
    const runs = [...runsFor("A", 130, now - 60_000, 30_000), ...runsFor("B", 1000, now - 60_000, 60_000)];
    const fake = fakeServer(agents, runs);
    server = createServer((req, res) => {
      const path = req.url ?? "";
      let body: unknown;
      if (path.startsWith("/api/issues/")) {
        body = { assigneeAdapterOverrides: { adapterConfig: { model: "claude-sonnet-5" } } };
      } else {
        if (path.includes("/heartbeat-runs")) runsRequested.push(path);
        body = fake.serve(path);
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("reports distinct runs, flags the truncated agent and fetches each page once", async () => {
    runsRequested = [];
    const { stdout, stderr } = await exec(process.execPath, [script, "--hours", "24"], {
      env: { ...process.env, NODE_ENV: "", PAPERCLIP_API_URL: baseUrl, PAPERCLIP_API_KEY: "k", PAPERCLIP_COMPANY_ID: COMPANY },
    });
    const report = JSON.parse(stdout);

    expect(report.distinctRuns).toBe(1130);
    expect(report.totalRuns).toBe(1130);
    expect(report.duplicateRowsDropped).toBe(0);
    expect(report.agentsScanned).toBe(2);
    expect(report.truncatedAgents).toHaveLength(1);
    expect(report.truncatedAgents[0]).toMatchObject({ agentId: "B", rows: 1000 });
    expect(stderr).toMatch(/WARNING Agent B returned a full page of 1000 runs/);

    expect(new Set(runsRequested).size).toBe(runsRequested.length);
    expect(runsRequested).toHaveLength(2);
    // The window now spans the real data, not a 200-row slice.
    expect(Date.parse(report.windowNewest) - Date.parse(report.windowOldest)).toBeGreaterThan(900 * 60_000);
  }, 60_000);
});
