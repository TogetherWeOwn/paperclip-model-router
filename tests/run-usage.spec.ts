import { describe, expect, it } from "vitest";

// A resumed run's `usageJson` is the session's running total. These specs pin the
// within-session delta that turns it back into per-run usage. The fixtures mirror
// the live shape: consecutive runs of one session with growing counters, and a
// fresh session that restarts them.

interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
}
interface Run {
  id: string;
  agentId: string;
  createdAt: string;
  status: string;
  sessionIdBefore: string | null;
  sessionIdAfter: string | null;
  contextSnapshot?: { wakeReason?: string };
  usageJson?: Partial<Usage> & { model?: string; sessionReused?: boolean };
}
interface Row {
  id: string;
  resumed: boolean;
  anchored: boolean;
  counterReset: boolean;
  usage: Usage | null;
  cumulative: Usage;
}
interface Summary {
  runs: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  rereadPerOutputToken: number | null;
  costPerRun: number | null;
}
interface RunUsage {
  perRunUsage(runs: Run[]): { runs: Row[]; unanchored: number; counterResets: number };
  summarize(rows: Row[]): Summary;
  summarizeBy(rows: Row[], keyOf: (r: Row) => string): Record<string, Summary>;
}
const specifier = new URL("../scripts/lib/run-usage.mjs", import.meta.url).href;
const lib: RunUsage = await import(/* @vite-ignore */ specifier);

const T0 = Date.parse("2026-10-07T00:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function run(
  id: string,
  minutes: number,
  session: { before: string | null; after: string },
  usage: Usage,
  extra: { agentId?: string; wake?: string; model?: string; status?: string } = {},
): Run {
  return {
    id,
    agentId: extra.agentId ?? "agent-a",
    createdAt: at(minutes),
    status: extra.status ?? "succeeded",
    sessionIdBefore: session.before,
    sessionIdAfter: session.after,
    contextSnapshot: { wakeReason: extra.wake ?? "issue_monitor_due" },
    usageJson: { ...usage, model: extra.model ?? "model-x", sessionReused: session.before !== null },
  };
}
const u = (inputTokens: number, cachedInputTokens: number, outputTokens: number, costUsd: number): Usage => ({
  inputTokens,
  cachedInputTokens,
  outputTokens,
  costUsd,
});

// One session, three runs, running totals as the CLI reports them on resume.
const SESSION = [
  run("r1", 0, { before: null, after: "s1" }, u(100, 1_000, 10, 1.0)),
  run("r2", 10, { before: "s1", after: "s1" }, u(180, 2_200, 25, 2.1)),
  run("r3", 20, { before: "s1", after: "s1" }, u(260, 3_900, 31, 3.4)),
];

describe("perRunUsage", () => {
  it("turns running totals into each run's own usage", () => {
    const { runs } = lib.perRunUsage(SESSION);
    const byId = Object.fromEntries(runs.map((r) => [r.id, r]));
    expect(byId.r1!.usage).toEqual(u(100, 1_000, 10, 1.0));
    expect(byId.r2!.usage).toEqual({ inputTokens: 80, cachedInputTokens: 1_200, outputTokens: 15, costUsd: expect.closeTo(1.1, 9) });
    expect(byId.r3!.usage).toEqual({ inputTokens: 80, cachedInputTokens: 1_700, outputTokens: 6, costUsd: expect.closeTo(1.3, 9) });
    // The deltas add back up to the session's last running total: nothing counted twice.
    const total = lib.summarize(runs);
    expect(total.inputTokens).toBe(260);
    expect(total.cachedInputTokens).toBe(3_900);
    expect(total.outputTokens).toBe(31);
    expect(total.costUsd).toBeCloseTo(3.4, 9);
  });

  it("does not depend on row order", () => {
    const forward = lib.perRunUsage(SESSION).runs.map((r) => [r.id, r.usage]);
    const reversed = lib.perRunUsage([...SESSION].reverse()).runs.map((r) => [r.id, r.usage]);
    expect(Object.fromEntries(reversed)).toEqual(Object.fromEntries(forward));
  });

  it("makes a session reset look like no saving, where a raw sum shows a fall", () => {
    // Real usage is identical: three runs of 10 tokens out and $1 each. Resumed, the
    // CLI reports running totals (10, 20, 30); fresh, each run reports its own 10.
    const step = u(100, 1_000, 10, 1);
    const resumed = [
      run("p1", 0, { before: null, after: "p" }, step),
      run("p2", 10, { before: "p", after: "p" }, u(200, 2_000, 20, 2)),
      run("p3", 20, { before: "p", after: "p" }, u(300, 3_000, 30, 3)),
    ];
    const fresh = [
      run("q1", 0, { before: null, after: "q1" }, step),
      run("q2", 10, { before: null, after: "q2" }, step),
      run("q3", 20, { before: null, after: "q3" }, step),
    ];
    const rawSum = (rows: Run[]) => rows.reduce((acc, r) => acc + (r.usageJson?.costUsd ?? 0), 0);
    expect(rawSum(resumed)).toBe(6);
    expect(rawSum(fresh)).toBe(3); // the raw sum calls the reset a 50% saving
    const deltaSum = (rows: Run[]) => lib.summarize(lib.perRunUsage(rows).runs).costUsd;
    expect(deltaSum(resumed)).toBeCloseTo(3, 9);
    expect(deltaSum(fresh)).toBeCloseTo(3, 9); // the delta basis sees equal spend
  });

  it("leaves a resumed run with no predecessor unanchored instead of reporting a running total", () => {
    const orphan = run("r9", 5, { before: "missing", after: "missing" }, u(5_000, 90_000, 400, 40));
    const { runs, unanchored } = lib.perRunUsage([orphan]);
    expect(unanchored).toBe(1);
    expect(runs[0]!.anchored).toBe(false);
    expect(runs[0]!.usage).toBeNull();
    expect(lib.summarize(runs).runs).toBe(0);
  });

  it("treats a counter that goes backwards as a restart, not a negative run", () => {
    const restarted = [
      run("a", 0, { before: null, after: "s" }, u(900, 9_000, 90, 9)),
      run("b", 10, { before: "s", after: "s" }, u(300, 2_000, 20, 2)),
    ];
    const { runs, counterResets } = lib.perRunUsage(restarted);
    expect(counterResets).toBe(1);
    const b = runs.find((r) => r.id === "b")!;
    expect(b.counterReset).toBe(true);
    expect(b.usage).toEqual(u(300, 2_000, 20, 2));
  });

  it("chains within one agent only", () => {
    const other = run("o1", 5, { before: "s1", after: "s1" }, u(10, 10, 1, 0.1), { agentId: "agent-b" });
    const { runs, unanchored } = lib.perRunUsage([...SESSION, other]);
    // agent-b shares a session id with agent-a but has no predecessor of its own.
    expect(unanchored).toBe(1);
    expect(runs.find((r) => r.id === "o1")!.anchored).toBe(false);
  });

  it("finds the predecessor by the session a run resumed, even when the id changes on resume", () => {
    const rotated = [
      run("a", 0, { before: null, after: "s1" }, u(100, 1_000, 10, 1)),
      run("b", 10, { before: "s1", after: "s2" }, u(150, 1_800, 14, 1.6)),
      run("c", 20, { before: "s2", after: "s2" }, u(190, 2_300, 20, 2.1)),
    ];
    const byId = Object.fromEntries(lib.perRunUsage(rotated).runs.map((r) => [r.id, r]));
    expect(byId.b!.anchored).toBe(true);
    expect(byId.b!.usage).toEqual({ inputTokens: 50, cachedInputTokens: 800, outputTokens: 4, costUsd: expect.closeTo(0.6, 9) });
    expect(byId.c!.usage).toEqual({ inputTokens: 40, cachedInputTokens: 500, outputTokens: 6, costUsd: expect.closeTo(0.5, 9) });
  });

  it("anchors on a failed predecessor that reported usage", () => {
    const chain = [
      run("a", 0, { before: null, after: "s" }, u(100, 1_000, 10, 1), { status: "failed" }),
      run("b", 10, { before: "s", after: "s" }, u(150, 1_800, 14, 1.6)),
    ];
    const b = lib.perRunUsage(chain).runs.find((r) => r.id === "b")!;
    expect(b.anchored).toBe(true);
    expect(b.usage).toEqual({ inputTokens: 50, cachedInputTokens: 800, outputTokens: 4, costUsd: expect.closeTo(0.6, 9) });
  });

  it("ignores rows without usage", () => {
    const bare: Run = { id: "x", agentId: "agent-a", createdAt: at(1), status: "cancelled", sessionIdBefore: null, sessionIdAfter: null };
    expect(lib.perRunUsage([bare]).runs).toEqual([]);
  });
});

describe("summarize", () => {
  it("reports re-read tokens per output token and cost per run", () => {
    const { runs } = lib.perRunUsage(SESSION);
    const s = lib.summarize(runs);
    expect(s.rereadPerOutputToken).toBeCloseTo((260 + 3_900) / 31, 9);
    expect(s.costPerRun).toBeCloseTo(3.4 / 3, 9);
  });

  it("returns null ratios when nothing was written or no run carries usage", () => {
    expect(lib.summarize([]).rereadPerOutputToken).toBeNull();
    expect(lib.summarize([]).costPerRun).toBeNull();
  });

  it("groups by a caller key", () => {
    const { runs } = lib.perRunUsage(SESSION);
    const groups = lib.summarizeBy(runs, (r) => (r.resumed ? "resumed" : "fresh"));
    expect(groups.fresh!.runs).toBe(1);
    expect(groups.resumed!.runs).toBe(2);
  });
});
