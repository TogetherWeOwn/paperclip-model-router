import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  BURN_ALERT_THRESHOLDS,
  detectBurnAlerts,
  emitBurnAlertProposals,
  thresholdsForLane,
  type BurnAlertLogger,
} from "../packages/lane-capacity/src/burn-alerts.js";
import { laneBurnDown, type LaneBurnDown } from "../packages/lane-capacity/src/burn-down.js";
import {
  evaluateLanePace,
  normalizeLaneDocument,
  type LanePaceDefinition,
  type LanePaceVerdict,
} from "../packages/lane-capacity/src/pace.js";

// Per-lane burn-rate alert thresholds, propose-only, on fixture snapshots.
//
// Every lane case runs a RECORDED lane document
// (packages/lane-capacity/tests/data/tog2135, frozen observedAt) through the
// real pace evaluator and the real burn-down readout, then judges each
// account against its lane's threshold entry — never hand-typed projections.
// The Muse lane is evaluated on the weekly single-account `kimi` fixture
// shape (the established hotter-burn proxy). Level boundaries, overrides and
// the emit flag use synthetic readouts: pure data in, proposal records out.
// Nothing here paces, selects, writes config, or touches a host script.
//
// Scope boundaries (owned elsewhere, not duplicated here):
// - margin deadband edges: the hysteresis slice (every fixture projection
//   sits clear of the trip ceiling and pace margin inputs);
// - weekly-vs-five-hour precedence: the conflict slice;
// - pinned-vs-unpinned fleet mix: the drift snapshot slice;
// - shadow-emit repair: the shadow slice.

const OBSERVED_AT = "2026-09-10T14:53:41.507882Z";

function laneDocument(name: string): unknown {
  const path = fileURLToPath(new URL(`../packages/lane-capacity/tests/data/tog2135/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

function laneVerdict(doc: string, allowance: string): LanePaceVerdict {
  const definition: LanePaceDefinition = {
    laneId: doc,
    healthFields: ["health"],
    windows: [{ name: allowance, role: "allowance", utilizationFields: [`${allowance}_utilization`], resetFields: [`${allowance}_resets_at`] }],
  };
  return evaluateLanePace({
    observation: normalizeLaneDocument({ document: laneDocument(doc), definition }),
    asOf: OBSERVED_AT,
  });
}

function readoutFor(laneId: string, doc: string, allowance: string): LaneBurnDown {
  return laneBurnDown(laneVerdict(doc, allowance));
}

function syntheticReadout(laneId: string, projected: number | null): LaneBurnDown {
  return {
    laneId,
    observedAt: OBSERVED_AT,
    state: "on",
    serviceable: true,
    reason: "ok",
    accounts: [
      {
        accountKey: "record-1",
        utilization: 0.5,
        elapsed: 0.5,
        projected,
        verdict: projected === null ? "unknown" : "on-track",
        reason: projected === null ? "no-computable-window" : "within-target-band",
      },
    ],
  };
}

function levelsFor(laneId: string, doc: string, allowance: string): string[] {
  return detectBurnAlerts(readoutFor(laneId, doc, allowance)).map((proposal) => `${proposal.accountKey}=${proposal.level}`);
}

function spyLogger(): BurnAlertLogger & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    info(message: string, fields?: Record<string, unknown>): void {
      calls.push([message, fields]);
    },
  };
}

describe("pacer per-lane burn alert thresholds (propose-only)", () => {
  it("pins the per-lane threshold table", () => {
    expect(BURN_ALERT_THRESHOLDS).toEqual({
      claude: { overWatch: 1.1, overWarn: 1.3, overCritical: 3.0, underCool: 0.85 },
      codex: { overWatch: 1.5, overWarn: 2.5, overCritical: 4.0, underCool: 0.85 },
      muse: { overWatch: 1.2, overWarn: 1.5, overCritical: 2.5, underCool: 0.9 },
    });
  });

  it("claude fixture: cool account proposes cool, hot account proposes warn", () => {
    // Recorded projections: record-1 ~0.61 (waste), record-2 ~1.35 (hot).
    expect(levelsFor("claude", "claude", "seven_day")).toEqual(["record-1=cool", "record-2=warn"]);
    const proposals = detectBurnAlerts(readoutFor("claude", "claude", "seven_day"));
    expect(proposals[0]).toMatchObject({ laneId: "claude", level: "cool", reason: "below-cool-threshold" });
    expect(proposals[1]).toMatchObject({ laneId: "claude", level: "warn", reason: "above-warn-threshold" });
    expect(proposals[0]!.projected).toBeCloseTo(0.612245, 5);
    expect(proposals[1]!.projected).toBeCloseTo(1.345895, 5);
  });

  it("codex fixture: hot accounts propose warn and critical", () => {
    // Recorded projections: record-1 ~3.19, record-2 ~4.50.
    expect(levelsFor("codex", "codex", "weekly")).toEqual(["record-1=warn", "record-2=critical"]);
    const proposals = detectBurnAlerts(readoutFor("codex", "codex", "weekly"));
    expect(proposals[1]).toMatchObject({ level: "critical", reason: "above-critical-threshold" });
  });

  it("muse lane via the kimi weekly proxy proposes warn", () => {
    // Recorded projection ~1.51: just above the muse warn edge, below critical.
    expect(levelsFor("muse", "kimi", "weekly")).toEqual(["record-1=warn"]);
    // The kimi lane id itself resolves to the same muse entry.
    expect(levelsFor("kimi", "kimi", "weekly")).toEqual(["record-1=warn"]);
  });

  it("unrecognized lanes fall back to the muse entry on real fixtures", () => {
    // zai ~2.05 and opencode-go ~1.87: warn under muse, with lane identity kept.
    const zai = detectBurnAlerts(readoutFor("zai", "zai", "weekly"));
    expect(zai).toHaveLength(1);
    expect(zai[0]).toMatchObject({ laneId: "zai", level: "warn" });
    expect(zai[0]!.projected).toBeCloseTo(2.051429, 5);
    const opencode = detectBurnAlerts(readoutFor("opencode-go", "opencode-go", "monthly"));
    expect(opencode).toHaveLength(1);
    expect(opencode[0]).toMatchObject({ laneId: "opencode-go", level: "warn" });
  });

  it("never proposes without a computable projection", () => {
    const zen = readoutFor("zen-free", "zen-free", "weekly");
    expect(zen.accounts[0]!.projected).toBeNull();
    expect(detectBurnAlerts(zen)).toEqual([]);
    expect(detectBurnAlerts(syntheticReadout("codex", null))).toEqual([]);
    expect(detectBurnAlerts(syntheticReadout("codex", Number.NaN))).toEqual([]);
  });

  it("proposes at exactly each edge and stays silent just inside", () => {
    // codex entry: watch 1.5, warn 2.5, critical 4.0, cool 0.85.
    const cases: Array<{ projected: number; levels: string[] }> = [
      { projected: 1.5, levels: ["watch"] },
      { projected: 1.499, levels: [] },
      { projected: 2.5, levels: ["warn"] },
      { projected: 2.499, levels: ["watch"] },
      { projected: 4.0, levels: ["critical"] },
      { projected: 3.999, levels: ["warn"] },
      { projected: 0.85, levels: ["cool"] },
      { projected: 0.851, levels: [] },
      { projected: 0.99, levels: [] },
    ];
    for (const entry of cases) {
      const proposals = detectBurnAlerts(syntheticReadout("codex", entry.projected));
      expect(proposals.map((proposal) => proposal.level), `${entry.projected}`).toEqual(entry.levels);
    }
  });

  it("honors a per-call override without moving the table", () => {
    const readout = readoutFor("codex", "codex", "weekly");
    const relaxed = detectBurnAlerts(readout, { thresholds: { codex: { overWarn: 10, overCritical: 20 } } });
    expect(relaxed.map((proposal) => proposal.level)).toEqual(["watch", "watch"]);
    // The module default still warns and criticizes the same input.
    expect(detectBurnAlerts(readout).map((proposal) => proposal.level)).toEqual(["warn", "critical"]);
    expect(BURN_ALERT_THRESHOLDS.codex.overWarn).toBe(2.5);
  });

  it("a misordered or non-finite override falls back to the table", () => {
    const readout = readoutFor("codex", "codex", "weekly");
    expect(
      detectBurnAlerts(readout, { thresholds: { codex: { overWatch: 5, overWarn: 1 } } }).map((p) => p.level),
    ).toEqual(["warn", "critical"]);
    expect(
      detectBurnAlerts(readout, { thresholds: { codex: { overWarn: Number.NaN } } }).map((p) => p.level),
    ).toEqual(["warn", "critical"]);
    expect(thresholdsForLane("codex")).toEqual(BURN_ALERT_THRESHOLDS.codex);
    expect(thresholdsForLane("cliproxy-codex")).toEqual(BURN_ALERT_THRESHOLDS.codex);
  });

  it("is pure: repeated calls agree and inputs are untouched", () => {
    const readout = readoutFor("claude", "claude", "seven_day");
    const frozen = structuredClone(readout);
    const first = detectBurnAlerts(readout);
    expect(detectBurnAlerts(readout)).toEqual(first);
    expect(first).toHaveLength(2);
    expect(readout).toEqual(frozen);
    expect(detectBurnAlerts(null as unknown as LaneBurnDown)).toEqual([]);
  });
});

describe("burn alerts: proposals only, flag-gated emit", () => {
  const proposals = () => detectBurnAlerts(readoutFor("codex", "codex", "weekly"));

  it("flag absent (default off) never calls the logger", () => {
    const logger = spyLogger();
    expect(emitBurnAlertProposals(logger, proposals())).toBe(false);
    expect(logger.calls).toHaveLength(0);
  });

  it("flag explicitly off never calls the logger", () => {
    const logger = spyLogger();
    expect(emitBurnAlertProposals(logger, proposals(), { enabled: false })).toBe(false);
    expect(logger.calls).toHaveLength(0);
  });

  it("flag on emits exactly one log line carrying the proposals", () => {
    const logger = spyLogger();
    expect(emitBurnAlertProposals(logger, proposals(), { enabled: true })).toBe(true);
    expect(logger.calls).toHaveLength(1);
    const [message, fields] = logger.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain("2 account(s)");
    expect(message).toContain("propose-only");
    expect(fields).toEqual({ proposals: proposals() });
  });

  it("flag on with no proposals stays silent", () => {
    const logger = spyLogger();
    expect(emitBurnAlertProposals(logger, [], { enabled: true })).toBe(false);
    expect(logger.calls).toHaveLength(0);
  });

  it("a throwing logger reads as not emitted, never as a throw", () => {
    const logger: BurnAlertLogger = {
      info(): void {
        throw new Error("log sink down");
      },
    };
    expect(() => emitBurnAlertProposals(logger, proposals(), { enabled: true })).not.toThrow();
    expect(emitBurnAlertProposals(logger, proposals(), { enabled: true })).toBe(false);
  });
});

describe("burn alerts: no live call path", () => {
  it("the detector module imports no live plugin surface", () => {
    // Detection is pure data in, proposal records out; the emit takes an
    // injected logger. If this module ever gains an import reaching the
    // worker, config, plugin SDK, or any state/db/http/capacity surface, a
    // live call path exists and this test must fail. Only import lines are
    // inspected, so the doc comment may name the forbidden surfaces without
    // tripping the guard.
    const source = readFileSync(
      path.join(path.resolve(import.meta.dirname, ".."), "packages", "lane-capacity", "src", "burn-alerts.ts"),
      "utf8",
    );
    const imports = source
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import"))
      .join("\n");
    expect(imports).not.toMatch(/worker|config|plugin-sdk|capacity|inference|health|telemetry|fidelity/i);
    expect(imports).not.toMatch(/state|db|http|secrets|action|job|route/i);
    // The suite's only sink is the injected spy: flag-off silence above is
    // silence of the only sink the verb can reach.
    expect(source).toContain("options?.enabled !== true");
  });
});
