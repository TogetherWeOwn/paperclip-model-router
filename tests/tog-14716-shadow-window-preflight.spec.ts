import { describe, expect, it } from "vitest";

import {
  checkShadowWindow,
  SHADOW_WINDOW_DEFAULT_FRESH_WITHIN_MS,
  type ShadowEvidenceSample,
} from "../src/enforce-preflight.js";

// Enforce preflight: enforce is refused while the shadow decision window is
// stale (no fresh shadow evidence in N minutes), allowed on a fresh window.
// Fixtures only — synthetic observedAt timestamps around a fixed `now`, no
// live state, no staging, no worker wiring.
//
// The closing matrix composes this conjunct with the TOG-14412 empty-tier
// conjunct (in progress, not landed here): enforce proceeds iff the shadow
// window is fresh AND the tier pool is non-empty. The empty-tier half is a
// local stand-in predicate — "no surviving tier candidate refuses enforce" —
// so the matrix proves the two conjuncts AND without conflict (each refusal
// keeps its own reason; neither masks the other).

const NOW = "2026-10-04T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function sample(ageMs: number): ShadowEvidenceSample {
  return { observedAt: iso(NOW_MS - ageMs) };
}

// Stand-in for the TOG-14412 empty-tier conjunct: an empty surviving tier pool
// refuses enforce. Kept local until that card lands; the composition contract
// is "both conjuncts must allow", so either may refuse without conflict.
function emptyTierAllows(survivingTierCandidates: readonly string[]): { allow: boolean; reason: string } {
  if (survivingTierCandidates.length === 0) return { allow: false, reason: "empty-tier" };
  return { allow: true, reason: "tier-non-empty" };
}

function enforceAllowed(
  samples: readonly ShadowEvidenceSample[],
  tierCandidates: readonly string[],
): { allow: boolean; reasons: string[] } {
  const shadow = checkShadowWindow(samples, { enabled: true, now: NOW });
  const tier = emptyTierAllows(tierCandidates);
  return {
    allow: shadow.allowEnforce && tier.allow,
    reasons: [shadow.reason, tier.reason],
  };
}

describe("enforce preflight: stale window refuses, fresh window allows", () => {
  it("refuses enforce when the window holds only stale shadow evidence", () => {
    const verdict = checkShadowWindow([sample(30 * MIN), sample(90 * MIN)], {
      enabled: true,
      now: NOW,
    });
    expect(verdict.allowEnforce).toBe(false);
    expect(verdict.reason).toBe("shadow-window-stale");
    expect(verdict.freshAgeMs).toBe(30 * MIN);
    expect(verdict.detectedAt).toBe(NOW);
  });

  it("allows enforce on a fresh window and reports the freshest age", () => {
    const verdict = checkShadowWindow([sample(30 * MIN), sample(1 * MIN)], {
      enabled: true,
      now: NOW,
    });
    expect(verdict.allowEnforce).toBe(true);
    expect(verdict.reason).toBe("fresh");
    expect(verdict.freshAgeMs).toBe(1 * MIN);
  });

  it("treats the boundary as fresh: age exactly at the horizon still allows", () => {
    const verdict = checkShadowWindow([sample(5 * MIN)], { enabled: true, now: NOW });
    expect(verdict.allowEnforce).toBe(true);
    expect(verdict.reason).toBe("fresh");
  });

  it("refuses on no samples, unparseable timestamps, and future-dated skew", () => {
    for (const samples of [
      [],
      [{ observedAt: "not-a-timestamp" }],
      [{ observedAt: iso(NOW_MS + MIN) }],
    ] as ShadowEvidenceSample[][]) {
      const verdict = checkShadowWindow(samples, { enabled: true, now: NOW });
      expect(verdict.allowEnforce).toBe(false);
      expect(verdict.reason).toBe("shadow-window-stale");
    }
  });

  it("stays inert with the flag off, even on a stale window", () => {
    for (const options of [undefined, {}, { enabled: false }] as const) {
      const verdict = checkShadowWindow([sample(90 * MIN)], { ...options, now: NOW });
      expect(verdict.allowEnforce).toBe(true);
      expect(verdict.reason).toBe("disabled");
      expect(verdict.freshAgeMs).toBeNull();
    }
  });

  it("honours a caller horizon and falls back to the 5-minute default on bad input", () => {
    expect(SHADOW_WINDOW_DEFAULT_FRESH_WITHIN_MS).toBe(5 * MIN);
    const custom = checkShadowWindow([sample(10 * MIN)], {
      enabled: true,
      now: NOW,
      freshWithinMs: 15 * MIN,
    });
    expect(custom.allowEnforce).toBe(true);
    for (const freshWithinMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const verdict = checkShadowWindow([sample(10 * MIN)], { enabled: true, now: NOW, freshWithinMs });
      expect(verdict.allowEnforce).toBe(false);
      expect(verdict.reason).toBe("shadow-window-stale");
    }
  });
});

describe("enforce preflight composed with the empty-tier conjunct", () => {
  it("matrix: stale/fresh window x empty/non-empty tier", () => {
    // stale window + non-empty tier: refused for the window, tier does not mask it.
    expect(enforceAllowed([sample(30 * MIN)], ["model-a"])).toEqual({
      allow: false,
      reasons: ["shadow-window-stale", "tier-non-empty"],
    });
    // stale window + empty tier: refused by both, each reason preserved.
    expect(enforceAllowed([sample(30 * MIN)], [])).toEqual({
      allow: false,
      reasons: ["shadow-window-stale", "empty-tier"],
    });
    // fresh window + empty tier: refused for the tier alone — no conflict.
    expect(enforceAllowed([sample(1 * MIN)], [])).toEqual({
      allow: false,
      reasons: ["fresh", "empty-tier"],
    });
    // fresh window + non-empty tier: the only cell that allows enforce.
    expect(enforceAllowed([sample(1 * MIN)], ["model-a"])).toEqual({
      allow: true,
      reasons: ["fresh", "tier-non-empty"],
    });
  });
});
