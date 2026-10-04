import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  checkAssembledRoster,
  diffRosterRows,
  emitRosterStaleness,
  ROSTER_DEFAULT_FRESH_WITHIN_MS,
  type RosterSnapshot,
  type RosterSnapshotRow,
  type RosterStalenessLogger,
  type RosterStalenessVerdict,
} from "../src/roster-staleness.js";

// Propose-only assembled-roster staleness detector: a snapshot older than
// the freshness horizon, or one whose regeneration diffs, yields a proposal
// verdict only — no refresh, no re-pin, no enforce.
//
// Fixture mechanics: synthetic snapshots with fixed ISO timestamps around a
// fixed `now`, and inline pure regenerate doubles returning frozen row
// sets, so the fresh / stale-age / diff-mismatch boundary is pinned without
// clocks, network, or the real assembler. The emit half takes an injected
// spy logger — never a plugin context — so the flag-off tests prove silence
// and the import test proves there is no live call path for a refresh or
// mutation to travel.

const NOW = "2026-10-04T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function row(id: string, overrides?: Partial<RosterSnapshotRow>): RosterSnapshotRow {
  return { id, tier: "flash", enabled: true, laneId: "claude", ...overrides };
}

const BASE_ROWS: RosterSnapshotRow[] = [row("aaa"), row("bbb", { laneId: "codex" })];

function snapshot(ageMs: number, rows: readonly RosterSnapshotRow[] = BASE_ROWS): RosterSnapshot {
  return { assembledAt: iso(NOW_MS - ageMs), rows: [...rows] };
}

function sameRows(): RosterSnapshotRow[] {
  return BASE_ROWS.map((r) => ({ ...r }));
}

function spyLogger(): RosterStalenessLogger & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    info(message: string, fields?: Record<string, unknown>): void {
      calls.push([message, fields]);
    },
  };
}

function check(
  snap: RosterSnapshot,
  regenerate?: (() => RosterSnapshotRow[]) | null,
  extra?: { now?: string; freshWithinMs?: number },
): RosterStalenessVerdict {
  return checkAssembledRoster(snap, regenerate ?? null, { enabled: true, now: NOW, ...extra });
}

describe("roster-staleness: fresh vs stale-age vs diff-mismatch", () => {
  it("a fresh snapshot whose regeneration matches never proposes", () => {
    const verdict = check(snapshot(10 * MIN), sameRows);
    expect(verdict.propose).toBe(false);
    expect(verdict.reason).toBe("fresh");
    expect(verdict.snapshotAgeMs).toBe(10 * MIN);
    expect(verdict.diff).toEqual({ added: [], removed: [], changed: [] });
    expect(verdict.detectedAt).toBe(NOW);
  });

  it("a fresh snapshot with no regenerate function reads fresh on age alone", () => {
    const verdict = check(snapshot(10 * MIN));
    expect(verdict.propose).toBe(false);
    expect(verdict.reason).toBe("fresh");
    expect(verdict.diff).toBeNull();
  });

  it("a snapshot older than the horizon proposes with reason roster-stale-age", () => {
    const verdict = check(snapshot(90 * MIN), sameRows);
    expect(verdict.propose).toBe(true);
    expect(verdict.reason).toBe("roster-stale-age");
    expect(verdict.snapshotAgeMs).toBe(90 * MIN);
    // Age firing still carries the content evidence (here: no drift).
    expect(verdict.diff).toEqual({ added: [], removed: [], changed: [] });
  });

  it("a fresh snapshot whose regeneration diffs proposes with reason roster-diff-mismatch", () => {
    const drifted = [row("aaa"), row("bbb", { laneId: "codex" }), row("ccc")];
    const verdict = check(snapshot(5 * MIN), () => drifted);
    expect(verdict.propose).toBe(true);
    expect(verdict.reason).toBe("roster-diff-mismatch");
    expect(verdict.snapshotAgeMs).toBe(5 * MIN);
    expect(verdict.diff).toEqual({ added: ["ccc"], removed: [], changed: [] });
  });

  it("an age-stale snapshot that also drifts keeps the age reason with diff evidence", () => {
    const verdict = check(snapshot(90 * MIN), () => [row("aaa")]);
    expect(verdict.propose).toBe(true);
    expect(verdict.reason).toBe("roster-stale-age");
    expect(verdict.diff).toEqual({ added: [], removed: ["bbb"], changed: [] });
  });

  it("a custom horizon moves the age boundary", () => {
    const snap = snapshot(20 * MIN);
    expect(check(snap, sameRows, { freshWithinMs: 10 * MIN }).reason).toBe("roster-stale-age");
    expect(check(snap, sameRows, { freshWithinMs: 30 * MIN }).reason).toBe("fresh");
  });

  it("a non-finite or non-positive horizon falls back to the default", () => {
    expect(ROSTER_DEFAULT_FRESH_WITHIN_MS).toBe(60 * MIN);
    const snap = snapshot(90 * MIN);
    // 90 min is stale under the default; a garbage horizon must not bless it.
    expect(check(snap, sameRows, { freshWithinMs: NaN }).reason).toBe("roster-stale-age");
    expect(check(snap, sameRows, { freshWithinMs: -1 }).reason).toBe("roster-stale-age");
  });
});

describe("roster-staleness: indeterminate inputs never propose", () => {
  it("flag off never proposes", () => {
    const verdict = checkAssembledRoster(snapshot(24 * 60 * MIN), () => [row("zzz")], {
      now: NOW,
    });
    expect(verdict.propose).toBe(false);
    expect(verdict.reason).toBe("disabled");
    expect(verdict.snapshotAgeMs).toBeNull();
    expect(verdict.diff).toBeNull();
  });

  it("unparseable assembledAt is indeterminate, not stale", () => {
    const verdict = check({ assembledAt: "not-a-time", rows: BASE_ROWS }, sameRows);
    expect(verdict.propose).toBe(false);
    expect(verdict.reason).toBe("indeterminate");
    expect(verdict.snapshotAgeMs).toBeNull();
  });

  it("a future-dated snapshot (clock skew) is indeterminate, never age-stale", () => {
    const verdict = check(
      { assembledAt: iso(NOW_MS + 10 * MIN), rows: BASE_ROWS },
      () => [row("zzz")],
    );
    expect(verdict.propose).toBe(false);
    expect(verdict.reason).toBe("indeterminate");
  });

  it("unparseable now is indeterminate", () => {
    const verdict = checkAssembledRoster(snapshot(5 * MIN), sameRows, {
      enabled: true,
      now: "not-a-time",
    });
    expect(verdict.propose).toBe(false);
    expect(verdict.reason).toBe("indeterminate");
    expect(verdict.detectedAt).toBeNull();
  });

  it("a throwing regenerate reads as no content evidence, not a proposal", () => {
    const verdict = check(snapshot(5 * MIN), () => {
      throw new Error("double broken");
    });
    expect(verdict.propose).toBe(false);
    expect(verdict.reason).toBe("fresh");
    expect(verdict.diff).toBeNull();
  });
});

describe("roster-staleness: diff unit vectors", () => {
  it("identical rows diff empty", () => {
    expect(diffRosterRows(BASE_ROWS, sameRows())).toEqual({ added: [], removed: [], changed: [] });
  });

  it("added, removed, and serving-field changes are reported per id", () => {
    const diff = diffRosterRows(BASE_ROWS, [
      row("aaa", { enabled: false }),
      row("ccc"),
    ]);
    expect(diff).toEqual({ added: ["ccc"], removed: ["bbb"], changed: ["aaa"] });
  });

  it("a lane rebinding counts as a change", () => {
    const diff = diffRosterRows(BASE_ROWS, [row("aaa"), row("bbb", { laneId: "grok" })]);
    expect(diff.changed).toEqual(["bbb"]);
  });

  it("rows without a usable id are ignored on both sides", () => {
    const diff = diffRosterRows(
      [...BASE_ROWS, { id: "" } as RosterSnapshotRow],
      [...sameRows(), { tier: "flash" } as RosterSnapshotRow],
    );
    expect(diff).toEqual({ added: [], removed: [], changed: [] });
  });

  it("extra row fields outside the serving projection do not drift", () => {
    const diff = diffRosterRows(BASE_ROWS, sameRows().map((r) => ({ ...r, note: "volatile" })));
    expect(diff).toEqual({ added: [], removed: [], changed: [] });
  });
});

describe("roster-staleness: flag-gated emit", () => {
  function staleVerdict(): RosterStalenessVerdict {
    return check(snapshot(90 * MIN), sameRows);
  }

  it("flag off never calls the logger", () => {
    const logger = spyLogger();
    expect(emitRosterStaleness(logger, staleVerdict())).toBe(false);
    expect(logger.calls).toHaveLength(0);
  });

  it("flag explicitly off never calls the logger", () => {
    const logger = spyLogger();
    expect(emitRosterStaleness(logger, staleVerdict(), { enabled: false })).toBe(false);
    expect(logger.calls).toHaveLength(0);
  });

  it("flag on with a fresh verdict stays silent", () => {
    const logger = spyLogger();
    const fresh = check(snapshot(5 * MIN), sameRows);
    expect(emitRosterStaleness(logger, fresh, { enabled: true })).toBe(false);
    expect(logger.calls).toHaveLength(0);
  });

  it("flag on emits exactly one log line carrying the verdict", () => {
    const logger = spyLogger();
    expect(emitRosterStaleness(logger, staleVerdict(), { enabled: true })).toBe(true);
    expect(logger.calls).toHaveLength(1);
    const [message, fields] = logger.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain("roster snapshot needs re-examination");
    expect(message).toContain("propose-only");
    expect(fields).toEqual({ verdict: staleVerdict() });
  });

  it("a throwing logger reads as not emitted, never as a throw", () => {
    const logger: RosterStalenessLogger = {
      info(): void {
        throw new Error("log sink down");
      },
    };
    expect(() => emitRosterStaleness(logger, staleVerdict(), { enabled: true })).not.toThrow();
    expect(emitRosterStaleness(logger, staleVerdict(), { enabled: true })).toBe(false);
  });
});

describe("roster-staleness: no live call path", () => {
  it("the detector module imports no live plugin surface", () => {
    // Detection is pure data in, verdict out; regeneration is an injected
    // pure double and the emit takes an injected logger. If this module ever
    // gains an import reaching the worker, config, assembler, plugin SDK, or
    // any state/db/http/capacity surface, a live call path exists and this
    // test must fail. Only import lines are inspected, so the doc comment
    // may name the forbidden surfaces without tripping the guard.
    const source = readFileSync(
      path.join(path.resolve(import.meta.dirname, ".."), "src", "roster-staleness.ts"),
      "utf8",
    );
    const imports = source
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import"))
      .join("\n");
    expect(imports).not.toMatch(/worker|config|plugin-sdk|capacity|inference|health|telemetry|fidelity/i);
    expect(imports).not.toMatch(/state|db|http|secrets|action|job|route|assembl/i);
    // The suite's only sink is the injected spy: flag-off silence above is
    // silence of the only sink the verb can reach.
    expect(source).toContain("options?.enabled !== true");
  });
});
