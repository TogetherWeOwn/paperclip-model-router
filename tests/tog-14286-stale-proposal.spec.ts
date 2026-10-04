import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_STALE_AFTER_HEARTBEATS,
  withdrawStaleProposals,
} from "../src/stale-proposal.js";

// Flag-gated `withdraw_stale_proposal` verb: marks proposals older than N
// heartbeats as withdrawn in shadow output only — never auto-responds, never
// mutates live state, and always skips human_only items.
//
// Fixture mechanics: small in-memory proposal lists (fresh vs stale vs
// human-only) run through the pure verb. Flag-off tests prove nothing is
// marked, and the import test proves there is no live call path to mark
// through in the first place.

describe("stale-proposal withdraw shape on fixtures", () => {
  it("marks proposals older than N heartbeats as withdrawn when the flag is on", () => {
    const out = withdrawStaleProposals(
      [
        { id: "fresh", ageHeartbeats: 2 },
        { id: "stale", ageHeartbeats: 25 },
      ],
      { enabled: true, staleAfterHeartbeats: 10 },
    );
    expect(out).toEqual([
      { id: "fresh", withdrawn: false, reason: "fresh" },
      { id: "stale", withdrawn: true, reason: "stale" },
    ]);
  });

  it("treats the threshold as strictly-greater-than (age == N stays fresh)", () => {
    const out = withdrawStaleProposals(
      [
        { id: "at-boundary", ageHeartbeats: 10 },
        { id: "just-over", ageHeartbeats: 11 },
      ],
      { enabled: true, staleAfterHeartbeats: 10 },
    );
    expect(out).toEqual([
      { id: "at-boundary", withdrawn: false, reason: "fresh" },
      { id: "just-over", withdrawn: true, reason: "stale" },
    ]);
  });

  it("always skips human-only proposals, however stale", () => {
    const out = withdrawStaleProposals(
      [{ id: "human", ageHeartbeats: 999, humanOnly: true }],
      { enabled: true, staleAfterHeartbeats: 10 },
    );
    expect(out).toEqual([{ id: "human", withdrawn: false, reason: "human-only-skipped" }]);
  });

  it("returns an empty shadow list for empty input", () => {
    expect(withdrawStaleProposals([], { enabled: true })).toEqual([]);
  });

  it("falls back to the default horizon on a bad threshold", () => {
    expect(DEFAULT_STALE_AFTER_HEARTBEATS).toBe(10);
    const stale = { id: "stale", ageHeartbeats: 11 };
    for (const staleAfterHeartbeats of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(
        withdrawStaleProposals([stale], { enabled: true, staleAfterHeartbeats }),
      ).toEqual([{ id: "stale", withdrawn: true, reason: "stale" }]);
    }
  });
});

describe("stale-proposal flag gating (flag-off unchanged)", () => {
  const proposals = [
    { id: "fresh", ageHeartbeats: 2 },
    { id: "stale", ageHeartbeats: 25 },
    { id: "human", ageHeartbeats: 999, humanOnly: true },
  ];

  it("flag absent (default off) withdraws nothing", () => {
    expect(withdrawStaleProposals(proposals)).toEqual([
      { id: "fresh", withdrawn: false, reason: "disabled" },
      { id: "stale", withdrawn: false, reason: "disabled" },
      { id: "human", withdrawn: false, reason: "disabled" },
    ]);
  });

  it("flag explicitly off withdraws nothing", () => {
    expect(withdrawStaleProposals(proposals, { enabled: false })).toEqual(
      withdrawStaleProposals(proposals),
    );
  });
});

describe("stale-proposal shadow purity (no live mutation)", () => {
  it("never mutates the input array or its entries", () => {
    const proposals = [
      { id: "fresh", ageHeartbeats: 2 },
      { id: "stale", ageHeartbeats: 25 },
    ];
    const snapshot = structuredClone(proposals);
    const out = withdrawStaleProposals(proposals, { enabled: true, staleAfterHeartbeats: 10 });
    expect(proposals).toEqual(snapshot);
    expect(out).not.toBe(proposals as unknown);
    for (const row of out) {
      expect(proposals).not.toContain(row as unknown);
    }
    expect(out.filter((row) => row.withdrawn).map((row) => row.id)).toEqual(["stale"]);
  });

  it("the verb module imports no live plugin surface", () => {
    // The verb is pure: it takes fixtures and returns a fresh shadow list. If
    // this module ever gains an import reaching the worker, config, plugin
    // SDK, or any state/db/http/secrets/capacity surface, a live call path
    // exists and this test must fail. Only import lines are inspected, so the
    // doc comment may name the forbidden surfaces without tripping the guard.
    const source = readFileSync(
      path.join(path.resolve(import.meta.dirname, ".."), "src", "stale-proposal.ts"),
      "utf8",
    );
    const imports = source
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import"))
      .join("\n");
    expect(imports).not.toMatch(/worker|config|plugin-sdk|capacity|inference|health|telemetry|fidelity/i);
    expect(imports).not.toMatch(/state|db|http|secrets|respond|interaction/i);
    // The suite's only sink is the returned shadow list: flag-off silence
    // above is silence of the only output the verb can reach.
    expect(source).toContain("options?.enabled !== true");
  });
});
