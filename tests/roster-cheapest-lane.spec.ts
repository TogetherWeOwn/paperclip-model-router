import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  auditCheapestLanePerTier,
  DEFAULT_AUDIT_TIERS,
  T2_TIER,
  T3_TIER,
  type CheapestLaneRow,
  type TierCheapestLane,
} from "../src/roster-cheapest-lane.js";

// T2/T3 cheapest-lane propose-only audit (fixtures + readout).
//
// Tier mapping: T2 -> `strong`, T3 -> `frontier`, matching the dead-lane
// probe precedent — the audit's T1/T2/T3 tiers live in model-selection
// vocabulary, this repo's ladder is small/standard/strong/frontier. Every
// case runs the REAL audit over frozen in-memory rows: no live catalogue
// read, no roster write, no pin, no enforce flip. Each case asserts the FULL
// expected readout (cheapest id + lane + gap codes), so audit drift in
// either direction — a rule dropped or a new gap firing on a frozen case —
// fails loudly instead of slipping through. The no-live-path tests read the
// real module and the real src tree to prove there is no call surface for a
// selection change to travel.

const LANES = ["cliproxy-claude", "cliproxy-codex", "cliproxy-muse"] as const;

interface AuditCase {
  id: string;
  title: string;
  rows: CheapestLaneRow[];
  expect: TierCheapestLane[];
}

function cheapest(tier: "strong" | "frontier", modelId: string, laneId: string | null, cost: number, gaps: TierCheapestLane["gaps"]): TierCheapestLane {
  return {
    tier,
    eligibleCount: expect.any(Number) as unknown as number,
    laneBoundCount: expect.any(Number) as unknown as number,
    cheapestModelId: modelId,
    cheapestLaneId: laneId,
    cheapestExpectedCostUsd: cost,
    gaps,
  };
}

// 8k-in/2k-out mix: cost = 0.008 * in + 0.002 * out.
const CASES: AuditCase[] = [
  {
    id: "clean",
    title: "both tiers have a lane-bound cheapest row and no gaps",
    rows: [
      { id: "std-workhorse", tier: "standard", enabled: true, costPerMTokIn: 1, costPerMTokOut: 4, quality: 60, laneId: "cliproxy-codex" },
      { id: "str-cheap", tier: "strong", enabled: true, costPerMTokIn: 3, costPerMTokOut: 15, quality: 72, laneId: "cliproxy-claude" },
      { id: "str-pricey", tier: "strong", enabled: true, costPerMTokIn: 5, costPerMTokOut: 25, quality: 80, laneId: "cliproxy-claude" },
      { id: "fr-only", tier: "frontier", enabled: true, costPerMTokIn: 5, costPerMTokOut: 25, quality: 95, laneId: "cliproxy-claude" },
    ],
    expect: [
      // T2 (strong): std-workhorse 0.016 < str-cheap 0.054 — below-ceiling wins.
      { ...cheapest("strong", "std-workhorse", "cliproxy-codex", 0.016, []), eligibleCount: 3, laneBoundCount: 3 },
      // T3 (frontier): std-workhorse still cheapest at 0.016.
      { ...cheapest("frontier", "std-workhorse", "cliproxy-codex", 0.016, []), eligibleCount: 4, laneBoundCount: 4 },
    ],
  },
  {
    id: "cheapest-unpinned",
    title: "enabled cheapest row with no lane binding is proposed as a gap",
    rows: [
      { id: "std-cheap-unpinned", tier: "standard", enabled: true, costPerMTokIn: 1, costPerMTokOut: 4, quality: 60 },
      { id: "str-laned", tier: "strong", enabled: true, costPerMTokIn: 3, costPerMTokOut: 15, quality: 72, laneId: "cliproxy-claude" },
      { id: "fr-laned", tier: "frontier", enabled: true, costPerMTokIn: 5, costPerMTokOut: 25, quality: 95, laneId: "cliproxy-claude" },
    ],
    expect: [
      {
        ...cheapest("strong", "std-cheap-unpinned", null, 0.016, [
          { code: "cheapest-unpinned", detail: expect.any(String) as unknown as string },
        ]),
        eligibleCount: 2,
        laneBoundCount: 1,
      },
      {
        ...cheapest("frontier", "std-cheap-unpinned", null, 0.016, [
          { code: "cheapest-unpinned", detail: expect.any(String) as unknown as string },
        ]),
        eligibleCount: 3,
        laneBoundCount: 2,
      },
    ],
  },
  {
    id: "cheapest-unknown-lane",
    title: "cheapest row bound to a lane outside the frozen lane set",
    rows: [
      { id: "std-cheap-stray", tier: "standard", enabled: true, costPerMTokIn: 1, costPerMTokOut: 4, quality: 60, laneId: "cliproxy-nope" },
      { id: "str-laned", tier: "strong", enabled: true, costPerMTokIn: 3, costPerMTokOut: 15, quality: 72, laneId: "cliproxy-claude" },
      { id: "fr-laned", tier: "frontier", enabled: true, costPerMTokIn: 5, costPerMTokOut: 25, quality: 95, laneId: "cliproxy-claude" },
    ],
    expect: [
      {
        ...cheapest("strong", "std-cheap-stray", null, 0.016, [
          { code: "cheapest-unknown-lane", detail: expect.any(String) as unknown as string },
        ]),
        eligibleCount: 2,
        laneBoundCount: 1,
      },
      {
        ...cheapest("frontier", "std-cheap-stray", null, 0.016, [
          { code: "cheapest-unknown-lane", detail: expect.any(String) as unknown as string },
        ]),
        eligibleCount: 3,
        laneBoundCount: 2,
      },
    ],
  },
  {
    id: "no-lane-bound-rows",
    title: "no eligible row binds a known lane: cheapest gap plus tier gap",
    rows: [
      { id: "std-a", tier: "standard", enabled: true, costPerMTokIn: 1, costPerMTokOut: 4, quality: 60 },
      { id: "str-a", tier: "strong", enabled: true, costPerMTokIn: 3, costPerMTokOut: 15, quality: 72 },
    ],
    expect: [
      {
        ...cheapest("strong", "std-a", null, 0.016, [
          { code: "cheapest-unpinned", detail: expect.any(String) as unknown as string },
          { code: "no-lane-bound-rows", detail: expect.any(String) as unknown as string },
        ]),
        eligibleCount: 2,
        laneBoundCount: 0,
      },
      // T3 (frontier): nothing enabled at or below the ceiling except the two
      // lower-tier unlaned rows — same gaps, plus no enabled row at the tier.
      {
        ...cheapest("frontier", "std-a", null, 0.016, [
          { code: "cheapest-unpinned", detail: expect.any(String) as unknown as string },
          { code: "no-lane-bound-rows", detail: expect.any(String) as unknown as string },
          { code: "tier-has-no-enabled-rows", detail: expect.any(String) as unknown as string },
        ]),
        eligibleCount: 2,
        laneBoundCount: 0,
      },
    ],
  },
  {
    id: "tier-empty",
    title: "no enabled row at or below the ceiling: a single no-eligible gap",
    rows: [
      { id: "std-off", tier: "standard", enabled: false, costPerMTokIn: 1, costPerMTokOut: 4, quality: 60, laneId: "cliproxy-codex" },
      { id: "fr-on", tier: "frontier", enabled: true, costPerMTokIn: 5, costPerMTokOut: 25, quality: 95, laneId: "cliproxy-claude" },
    ],
    expect: [
      {
        tier: "strong",
        eligibleCount: 0,
        laneBoundCount: 0,
        cheapestModelId: null,
        cheapestLaneId: null,
        cheapestExpectedCostUsd: null,
        gaps: [{ code: "no-eligible-row", detail: expect.any(String) as unknown as string }],
      },
      // T3 still serves: the frontier row is at the ceiling.
      { ...cheapest("frontier", "fr-on", "cliproxy-claude", 0.09, []), eligibleCount: 1, laneBoundCount: 1 },
    ],
  },
  {
    id: "below-ceiling-only",
    title: "tier covered only by cheaper lower-tier rows: gap recorded, readout still names them",
    rows: [
      { id: "small-cheap", tier: "small", enabled: true, costPerMTokIn: 1, costPerMTokOut: 1, quality: 40, laneId: "cliproxy-muse" },
      { id: "std-cheap", tier: "standard", enabled: true, costPerMTokIn: 1, costPerMTokOut: 4, quality: 60, laneId: "cliproxy-codex" },
    ],
    expect: [
      {
        // T2 (strong): small-cheap 0.010 < std-cheap 0.016.
        ...cheapest("strong", "small-cheap", "cliproxy-muse", 0.01, [
          { code: "tier-has-no-enabled-rows", detail: expect.any(String) as unknown as string },
        ]),
        eligibleCount: 2,
        laneBoundCount: 2,
      },
      {
        ...cheapest("frontier", "small-cheap", "cliproxy-muse", 0.01, [
          { code: "tier-has-no-enabled-rows", detail: expect.any(String) as unknown as string },
        ]),
        eligibleCount: 2,
        laneBoundCount: 2,
      },
    ],
  },
  {
    id: "cost-tie-quality-wins",
    title: "equal-cost rows break the tie on quality, mirroring the selector baseline",
    rows: [
      { id: "str-plain", tier: "strong", enabled: true, costPerMTokIn: 3, costPerMTokOut: 15, quality: 70, laneId: "cliproxy-claude" },
      { id: "str-better", tier: "strong", enabled: true, costPerMTokIn: 3, costPerMTokOut: 15, quality: 80, laneId: "cliproxy-codex" },
      { id: "fr-laned", tier: "frontier", enabled: true, costPerMTokIn: 5, costPerMTokOut: 25, quality: 95, laneId: "cliproxy-claude" },
    ],
    expect: [
      { ...cheapest("strong", "str-better", "cliproxy-codex", 0.054, []), eligibleCount: 2, laneBoundCount: 2 },
      { ...cheapest("frontier", "str-better", "cliproxy-codex", 0.054, []), eligibleCount: 3, laneBoundCount: 3 },
    ],
  },
];

describe("cheapest-lane audit: per-tier cheapest + gap readout on frozen rows", () => {
  for (const kase of CASES) {
    it(`${kase.id}: ${kase.title}`, () => {
      const before = structuredClone(kase.rows);
      const got = auditCheapestLanePerTier({ rows: kase.rows, lanes: [...LANES] });
      expect(got).toEqual(kase.expect);
      // Propose-only: the input rows are never mutated.
      expect(kase.rows).toEqual(before);
    });
  }

  it("defaults to auditing T2 then T3 in that order", () => {
    expect(DEFAULT_AUDIT_TIERS).toEqual([T2_TIER, T3_TIER]);
    expect(T2_TIER).toBe("strong");
    expect(T3_TIER).toBe("frontier");
    const got = auditCheapestLanePerTier({ rows: CASES[0]!.rows, lanes: [...LANES] }).map((entry) => entry.tier);
    expect(got).toEqual(["strong", "frontier"]);
  });

  it("a caller-supplied tier order controls the readout order", () => {
    const got = auditCheapestLanePerTier({ rows: CASES[0]!.rows, lanes: [...LANES], tiers: ["frontier", "strong"] });
    expect(got.map((entry) => entry.tier)).toEqual(["frontier", "strong"]);
    expect(got[0]!.cheapestModelId).toBe("std-workhorse");
  });

  it("disabled and off-ladder rows never become the cheapest", () => {
    const got = auditCheapestLanePerTier({
      rows: [
        { id: "ghost", tier: "nonsense", enabled: true, costPerMTokIn: 0, costPerMTokOut: 0, quality: 100, laneId: "cliproxy-claude" },
        { id: "off", tier: "standard", enabled: false, costPerMTokIn: 0, costPerMTokOut: 0, quality: 100, laneId: "cliproxy-codex" },
        { id: "real", tier: "standard", enabled: true, costPerMTokIn: 1, costPerMTokOut: 4, quality: 60, laneId: "cliproxy-codex" },
      ],
      lanes: [...LANES],
    });
    expect(got.map((entry) => entry.cheapestModelId)).toEqual(["real", "real"]);
  });

  it("the audit module imports only the tier types and no live plugin surface", () => {
    // Read the REAL module, not this spec. The audit runs pure over frozen
    // rows: a worker, plugin-SDK, capacity-fetch, secrets or transport import
    // would be a live call path for a selection change to travel. The
    // specifier list is compared to an exact allowlist, so any new import,
    // including a side-effect-only one, fails here.
    const specifiers = importSpecifiers(readFileSync(AUDIT_MODULE_PATH, "utf8"));
    expect(specifiers).toEqual(["./engine/types.js"]);
  });

  it("no other src file imports the audit module", () => {
    // The runtime-importer half of the "no live path" claim: the audit has
    // callers only in tests and the readout, never in plugin code.
    const importers = listTsFiles(SRC_DIR)
      .filter((file) => file !== AUDIT_MODULE_PATH)
      .filter((file) => importSpecifiers(readFileSync(file, "utf8")).some((spec) => /(^|\/)roster-cheapest-lane(\.js)?$/.test(spec)));
    expect(importers).toEqual([]);
  });

  it("the import scanner sees side-effect, re-export, dynamic and require imports", () => {
    // Self-check for the scanner above: a guard that cannot see an import
    // form cannot fail on it.
    const source = [
      'import "./a.js";',
      'import { x } from "./b.js";',
      'import type { Y } from "./c.js";',
      'export * from "./d.js";',
      'export { z } from "./e.js";',
      'const f = await import("./f.js");',
      'const g = require("./g.js");',
      '// import "./commented-line.js";',
      '/* import "./commented-block.js"; */',
    ].join("\n");
    expect(importSpecifiers(source)).toEqual(["./a.js", "./b.js", "./c.js", "./d.js", "./e.js", "./f.js", "./g.js"]);
  });
});

const AUDIT_MODULE_PATH = fileURLToPath(new URL("../src/roster-cheapest-lane.ts", import.meta.url));
const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

/** Module specifiers a TypeScript source imports, in source order. Comments are ignored. */
function importSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const found: { index: number; spec: string }[] = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s+from\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) found.push({ index: match.index ?? 0, spec: match[1]! });
  }
  return found.sort((a, b) => a.index - b.index).map((entry) => entry.spec);
}

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listTsFiles(full);
    return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
  });
}
