import { describe, expect, it } from "vitest";

import {
  applyHealth,
  DEAD_STRIKES,
  DEGRADED_PROBATION_MS,
  normalizeHealthState,
  reconcileHealth,
  reconcileInvocation,
} from "../src/health/reconcile.js";
import { parseCatalogue, probeCatalogue } from "../src/health/probe.js";
import type { ModelHealthState } from "../src/health/types.js";
import { fixtureConfig } from "./helpers.js";

const NOW = "2026-08-30T00:00:00.000Z";
const models = fixtureConfig("company-a").models;
const ALL = new Set(models.map((model) => model.id));

function catalogue(ids: Set<string> | null) {
  return { modelIds: ids, detail: "probe", status: ids ? 200 : null };
}

function repeatCatalogue(ids: Set<string> | null, times: number): ModelHealthState {
  let state: ModelHealthState = {};
  for (let index = 0; index < times; index += 1) {
    state = reconcileHealth({ models, probe: catalogue(ids), previous: state, now: NOW }).next;
  }
  return state;
}

function observe(
  state: ModelHealthState,
  modelId: string,
  succeeded: boolean,
  at = NOW,
) {
  return reconcileInvocation({ modelId, succeeded, previous: state, now: at });
}

describe("catalogue health is absence evidence, not success evidence", () => {
  it("keeps a present model unknown until invocations prove it healthy", () => {
    const result = reconcileHealth({ models, probe: catalogue(ALL), previous: {}, now: NOW });
    expect(result.next["qwen3-coder"]).toMatchObject({
      verdict: "unknown",
      reason: "present in the upstream catalogue; awaiting invocation evidence",
    });
    expect(result.flips).toEqual([]);
    expect(applyHealth(models, result.next).every((model) => model.enabled)).toBe(true);
  });

  it("normalizes catalogue-only legacy healthy state to unknown", () => {
    expect(normalizeHealthState({
      "qwen3-coder": {
        verdict: "healthy",
        checkedAt: NOW,
        reason: "present in the upstream catalogue",
        strikes: 0,
      },
    })["qwen3-coder"]).toMatchObject({ verdict: "unknown", lastInvocationAt: null });
  });

  it("needs consecutive catalogue absences before disabling anything", () => {
    const present = new Set([...ALL].filter((id) => id !== "qwen3-coder"));
    const first = reconcileHealth({ models, probe: catalogue(present), previous: {}, now: NOW });
    expect(first.flips).toEqual([]);
    expect(first.next["qwen3-coder"]?.strikes).toBe(1);
    expect(applyHealth(models, first.next).find((m) => m.id === "qwen3-coder")?.enabled).toBe(true);

    const second = reconcileHealth({ models, probe: catalogue(present), previous: first.next, now: NOW });
    expect(second.next["qwen3-coder"]).toMatchObject({ verdict: "dead", strikes: DEAD_STRIKES });
    expect(second.flips).toEqual([
      expect.objectContaining({ modelId: "qwen3-coder", to: "dead" }),
    ]);
    expect(applyHealth(models, second.next).find((m) => m.id === "qwen3-coder")?.enabled).toBe(false);
  });

  it("returns a catalogue-dead model to unknown probation, not healthy", () => {
    const dark = repeatCatalogue(new Set([...ALL].filter((id) => id !== "qwen3-coder")), DEAD_STRIKES);
    const recovered = reconcileHealth({ models, probe: catalogue(ALL), previous: dark, now: NOW });
    expect(recovered.next["qwen3-coder"]).toMatchObject({ verdict: "unknown", strikes: 0 });
    expect(recovered.flips).toEqual([
      expect.objectContaining({ modelId: "qwen3-coder", from: "dead", to: "unknown" }),
    ]);
  });

  it("never re-enables a model the operator disabled", () => {
    const operatorDisabled = models.map((model) =>
      model.id === "qwen3-coder" ? { ...model, enabled: false } : model,
    );
    const present = reconcileHealth({ models, probe: catalogue(ALL), previous: {}, now: NOW }).next;
    expect(applyHealth(operatorDisabled, present).find((m) => m.id === "qwen3-coder")?.enabled).toBe(false);
  });

  it("changes nothing at all on an indeterminate probe", () => {
    const previous = reconcileHealth({ models, probe: catalogue(ALL), previous: {}, now: NOW }).next;
    const result = reconcileHealth({ models, probe: catalogue(null), previous, now: NOW });
    expect(result.next).toEqual(previous);
    expect(result.flips).toEqual([]);
  });
});

describe("invocation health has hysteresis in both directions", () => {
  it("degrades only after two failures and leaves the model routable", () => {
    const present = reconcileHealth({ models, probe: catalogue(ALL), previous: {}, now: NOW }).next;
    const first = observe(present, "qwen3-coder", false);
    expect(first.next["qwen3-coder"]?.verdict).toBe("unknown");
    expect(first.flips).toEqual([]);

    const second = observe(first.next, "qwen3-coder", false);
    expect(second.next["qwen3-coder"]).toMatchObject({ verdict: "degraded", failureStreak: 2 });
    expect(second.flips).toEqual([
      expect.objectContaining({ from: "unknown", to: "degraded" }),
    ]);
    expect(applyHealth(models, second.next).find((m) => m.id === "qwen3-coder")?.enabled).toBe(true);
  });

  it("replays failures and successes without single-sample oscillation", () => {
    let state = reconcileHealth({ models, probe: catalogue(ALL), previous: {}, now: NOW }).next;
    state = observe(state, "qwen3-coder", true).next;
    state = observe(state, "qwen3-coder", true).next;
    expect(state["qwen3-coder"]?.verdict).toBe("healthy");

    const sequence = [false, true, false, false, true, false, true, true];
    const verdicts: string[] = [];
    const flips: string[] = [];
    for (const succeeded of sequence) {
      const result = observe(state, "qwen3-coder", succeeded);
      state = result.next;
      verdicts.push(state["qwen3-coder"]!.verdict);
      flips.push(...result.flips.map((flip) => `${flip.from}->${flip.to}`));
    }
    // The closing two successes would recover on streaks alone, but the ten
    // observations carry 4 failures (40% >= 20%), so the error-rate breaker
    // holds the lane degraded until the window slides.
    expect(verdicts).toEqual([
      "healthy", "healthy", "healthy", "degraded",
      "degraded", "degraded", "degraded", "degraded",
    ]);
    expect(flips).toEqual(["healthy->degraded"]);
  });

  it("restarts the probation cooldown on every fresh failure", () => {
    let state = observe({}, "qwen3-coder", false).next;
    state = observe(state, "qwen3-coder", false).next;
    const almost = new Date(Date.parse(NOW) + DEGRADED_PROBATION_MS - 1).toISOString();
    state = observe(state, "qwen3-coder", false, almost).next;
    const oldDeadline = new Date(Date.parse(NOW) + DEGRADED_PROBATION_MS).toISOString();
    const result = reconcileHealth({ models, probe: catalogue(ALL), previous: state, now: oldDeadline });
    expect(result.next["qwen3-coder"]?.verdict).toBe("degraded");
  });

  it("moves a degraded model to probation after cooldown and recovers automatically", () => {
    let state = observe({}, "qwen3-coder", false).next;
    state = observe(state, "qwen3-coder", false).next;
    expect(state["qwen3-coder"]?.verdict).toBe("degraded");

    const probationAt = new Date(Date.parse(NOW) + DEGRADED_PROBATION_MS).toISOString();
    const probation = reconcileHealth({ models, probe: catalogue(ALL), previous: state, now: probationAt });
    expect(probation.next["qwen3-coder"]?.verdict).toBe("unknown");

    const first = observe(probation.next, "qwen3-coder", true, probationAt);
    expect(first.next["qwen3-coder"]?.verdict).toBe("unknown");
    const second = observe(first.next, "qwen3-coder", true, probationAt);
    expect(second.next["qwen3-coder"]).toMatchObject({ verdict: "healthy", successStreak: 2 });
  });
});

describe("rolling error-rate circuit breaker (15 min / 20% / 30 min avoid)", () => {
  const atMinute = (offset: number): string =>
    new Date(Date.parse(NOW) + Math.round(offset * 60_000)).toISOString();

  function entry(overrides: Partial<ModelHealthState[string]> = {}): ModelHealthState[string] {
    return {
      verdict: "unknown",
      checkedAt: NOW,
      reason: "seeded",
      strikes: 0,
      failureStreak: 0,
      successStreak: 0,
      lastInvocationAt: null,
      degradedAt: null,
      recentOutcomes: [],
      ...overrides,
    };
  }

  function drive(pattern: Array<[number, boolean]>, from: ModelHealthState = {}): ModelHealthState {
    let state = from;
    for (const [offset, succeeded] of pattern) {
      state = reconcileInvocation({
        modelId: "qwen3-coder",
        succeeded,
        previous: state,
        now: atMinute(offset),
      }).next;
    }
    return state;
  }

  /** Alternating failures never trip the consecutive streak, by construction. */
  const flaky = (count: number, start = 0): Array<[number, boolean]> =>
    Array.from({ length: count }, (_, index) => [start + index, index % 2 === 0] as [number, boolean]);

  /** One call per minute for `count` minutes, failing at the listed offsets and succeeding otherwise. */
  const withFailuresAt = (count: number, failures: number[]): Array<[number, boolean]> =>
    Array.from({ length: count }, (_, index) => [index, !failures.includes(index)] as [number, boolean]);

  it("trips a flaky lane the streak logic would keep serving", () => {
    const nine = drive(flaky(9));
    expect(nine["qwen3-coder"]?.verdict).toBe("unknown");
    const ten = drive([[9, false]], nine);
    expect(ten["qwen3-coder"]).toMatchObject({ verdict: "degraded" });
    expect(ten["qwen3-coder"]?.reason).toContain("5 of the last 10 routed calls failed");
    expect(ten["qwen3-coder"]?.degradedAt).toBe(atMinute(9));
  });

  it("trips exactly at the 20% boundary", () => {
    // Two separated failures in ten, the second one the tenth call: never
    // consecutive, exactly 20%.
    const state = drive(withFailuresAt(10, [1, 9]));
    expect(state["qwen3-coder"]).toMatchObject({ verdict: "degraded" });
    expect(state["qwen3-coder"]?.reason).toContain("2 of the last 10 routed calls failed");
  });

  it("holds a 10% lane on streaks alone", () => {
    const state = drive(withFailuresAt(10, [9]));
    expect(state["qwen3-coder"]?.verdict).toBe("healthy");
  });

  it("holds an 18.75% lane (3 failures in 16 calls) just under the threshold", () => {
    // Half-minute spacing keeps all sixteen calls inside the window.
    const pattern = Array.from({ length: 16 }, (_, index) =>
      [index / 2, ![3, 8, 15].includes(index)] as [number, boolean]);
    const state = drive(pattern);
    expect(state["qwen3-coder"]?.recentOutcomes).toHaveLength(16);
    expect(state["qwen3-coder"]?.verdict).toBe("healthy");
  });

  it("holds a 19% lane on a full ring (19 failures in 100 calls)", () => {
    const seeded = Array.from({ length: 99 }, (_, index) => ({
      at: new Date(Date.parse(NOW) + index * 5_000).toISOString(),
      succeeded: index % 5 !== 0 || index >= 90,
    }));
    expect(seeded.filter((outcome) => !outcome.succeeded)).toHaveLength(18);
    const previous: ModelHealthState = {
      "qwen3-coder": entry({
        verdict: "healthy",
        successStreak: 2,
        lastInvocationAt: seeded[98]!.at,
        recentOutcomes: seeded,
      }),
    };
    const next = observe(previous, "qwen3-coder", false, new Date(Date.parse(NOW) + 99 * 5_000).toISOString());
    expect(next.next["qwen3-coder"]?.recentOutcomes).toHaveLength(100);
    expect(next.next["qwen3-coder"]?.verdict).toBe("healthy");
  });

  it("ignores a high rate on too few samples", () => {
    // 1 failure in 4 is a 25% rate, but 4 samples are below the minimum, so
    // streaks alone decide — and three straight successes heal to healthy.
    const state = drive([[0, false], [1, true], [2, true], [3, true]]);
    expect(state["qwen3-coder"]?.verdict).toBe("healthy");
    // Two samples at a 50% rate still trip nothing: below the minimum, streaks rule.
    expect(drive([[0, false], [1, true]])["qwen3-coder"]?.verdict).toBe("unknown");
    // A failure that makes nine calls 22% bad is one sample short of the minimum.
    expect(drive(withFailuresAt(9, [1, 8]))["qwen3-coder"]?.verdict).toBe("healthy");
  });

  it("never opens the breaker on a success, even one that completes the sample minimum", () => {
    // Two failures in nine calls (22%) sit below the minimum; the tenth call
    // succeeds and makes the rate exactly 20%, yet the lane keeps serving.
    const nine = drive(withFailuresAt(9, [0, 4]));
    expect(nine["qwen3-coder"]?.verdict).toBe("healthy");
    const ten = reconcileInvocation({
      modelId: "qwen3-coder",
      succeeded: true,
      previous: nine,
      now: atMinute(9),
    });
    expect(ten.next["qwen3-coder"]?.verdict).toBe("healthy");
    expect(ten.next["qwen3-coder"]?.degradedAt).toBeNull();
    expect(ten.flips).toEqual([]);
    // The next failure sees 3 of 11 and trips.
    const eleven = observe(ten.next, "qwen3-coder", false, atMinute(10));
    expect(eleven.next["qwen3-coder"]?.verdict).toBe("degraded");
    expect(eleven.flips.map((flip) => `${flip.from}->${flip.to}`)).toEqual(["healthy->degraded"]);
  });

  it("lets aged-out failures slide out of the window", () => {
    let state = drive(flaky(10));
    expect(state["qwen3-coder"]?.verdict).toBe("degraded");
    // Sixteen minutes later the tripping evidence has left the 15-minute
    // window; two successes recover on streaks with no rate to override them.
    state = drive([[25, true], [26, true]], state);
    expect(state["qwen3-coder"]?.verdict).toBe("healthy");
  });

  it("slides the avoid window to the last failure, never past it", () => {
    // Failures and successes interleave, so the consecutive-failure path never
    // restarts the cooldown: only the rate path can move degradedAt here.
    let state = drive(flaky(10));
    expect(state["qwen3-coder"]?.degradedAt).toBe(atMinute(9));
    const steps: Array<[number, boolean, number]> = [
      [10, true, 9],
      [11, false, 11],
      [12, true, 11],
      [13, false, 13],
      [14, true, 13],
      [15, false, 15],
    ];
    for (const [offset, succeeded, expectedDegradedAt] of steps) {
      state = drive([[offset, succeeded]], state);
      expect(state["qwen3-coder"]?.verdict).toBe("degraded");
      expect(state["qwen3-coder"]?.degradedAt).toBe(atMinute(expectedDegradedAt));
    }
  });

  it("holds a tripped lane degraded through a run of successes without moving the cooldown", () => {
    const tripped = drive(flaky(10));
    expect(tripped["qwen3-coder"]?.degradedAt).toBe(atMinute(9));
    // Three straight successes would heal the lane on streaks alone; the rate
    // (5 of 13) overrides that, and the avoid window still ends 30 minutes
    // after the last failure, not the last success.
    const state = drive([[10, true], [11, true], [12, true]], tripped);
    expect(state["qwen3-coder"]).toMatchObject({ verdict: "degraded", degradedAt: atMinute(9) });
    const probation = reconcileHealth({
      models,
      probe: catalogue(ALL),
      previous: state,
      now: atMinute(39),
    });
    expect(probation.next["qwen3-coder"]?.verdict).toBe("unknown");
  });

  it("half-opens with a fresh ring after the 30-minute avoid", () => {
    const tripped = drive(flaky(10));
    expect(tripped["qwen3-coder"]?.verdict).toBe("degraded");
    const probationAt = atMinute(39);
    const probation = reconcileHealth({
      models,
      probe: catalogue(ALL),
      previous: tripped,
      now: probationAt,
    });
    expect(probation.next["qwen3-coder"]?.verdict).toBe("unknown");
    expect(probation.next["qwen3-coder"]?.recentOutcomes).toEqual([]);
    // One probationary failure must not re-trip on pre-probation evidence.
    const trial = observe(probation.next, "qwen3-coder", false, probationAt);
    expect(trial.next["qwen3-coder"]?.verdict).toBe("unknown");
  });

  it("clears the ring when probation starts even inside the window", () => {
    const previous: ModelHealthState = {
      "qwen3-coder": entry({
        verdict: "degraded",
        reason: "rate trip",
        failureStreak: 1,
        lastInvocationAt: NOW,
        degradedAt: NOW,
        recentOutcomes: Array.from({ length: 10 }, () => ({ at: atMinute(30), succeeded: false })),
      }),
    };
    const probation = reconcileHealth({
      models,
      probe: catalogue(ALL),
      previous,
      now: atMinute(31),
    });
    expect(probation.next["qwen3-coder"]).toMatchObject({ verdict: "unknown" });
    expect(probation.next["qwen3-coder"]?.recentOutcomes).toEqual([]);
  });

  it("clears the ring when a dead model reappears, so one trial failure cannot re-trip", () => {
    const previous: ModelHealthState = {
      "qwen3-coder": entry({
        verdict: "dead",
        strikes: DEAD_STRIKES,
        recentOutcomes: Array.from({ length: 10 }, () => ({ at: atMinute(1), succeeded: false })),
      }),
    };
    const revived = reconcileHealth({
      models,
      probe: catalogue(ALL),
      previous,
      now: atMinute(5),
    });
    expect(revived.next["qwen3-coder"]).toMatchObject({ verdict: "unknown", recentOutcomes: [] });
    const trial = observe(revived.next, "qwen3-coder", false, atMinute(5));
    expect(trial.next["qwen3-coder"]?.verdict).toBe("unknown");
  });

  describe("window edges", () => {
    // Nine successes and one failure inside the window plus one "edge" failure
    // whose timestamp varies, then a fresh failure at minute 15. With the edge
    // failure counted that is 3 of 12 (25%) and trips; without it, 2 of 11
    // (18%) and holds.
    const inside = [
      ...Array.from({ length: 9 }, (_, index) => ({ at: atMinute(6 + index), succeeded: true })),
      { at: atMinute(10), succeeded: false },
    ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

    function verdictWith(edge: string): string | undefined {
      const previous: ModelHealthState = {
        "qwen3-coder": entry({
          verdict: "healthy",
          successStreak: 2,
          lastInvocationAt: atMinute(14),
          recentOutcomes: [{ at: edge, succeeded: false }, ...inside],
        }),
      };
      return observe(previous, "qwen3-coder", false, atMinute(15)).next["qwen3-coder"]?.verdict;
    }

    it("drops a failure exactly one window old", () => {
      expect(verdictWith(atMinute(0))).toBe("healthy");
    });

    it("keeps a failure one millisecond inside the window", () => {
      expect(verdictWith(new Date(Date.parse(atMinute(0)) + 1).toISOString())).toBe("degraded");
    });

    it("counts a failure stamped at the same instant as the call", () => {
      expect(verdictWith(atMinute(15))).toBe("degraded");
    });

    it("ignores a future-dated failure", () => {
      expect(verdictWith(atMinute(16))).toBe("healthy");
    });
  });

  describe("ring bounds", () => {
    const at = (second: number): string => new Date(Date.parse(NOW) + second * 1_000).toISOString();

    it("keeps only the newest 100 observations of a busy lane", () => {
      let state: ModelHealthState = {};
      for (let call = 0; call < 150; call += 1) {
        state = reconcileInvocation({
          modelId: "qwen3-coder",
          succeeded: true,
          previous: state,
          now: at(call * 5),
        }).next;
      }
      const ring = state["qwen3-coder"]?.recentOutcomes ?? [];
      expect(ring).toHaveLength(100);
      expect(ring[0]?.at).toBe(at(50 * 5));
      expect(ring[99]?.at).toBe(at(149 * 5));
    });

    it("keeps the newest 100 entries of an oversized stored ring", () => {
      const stored = Array.from({ length: 150 }, (_, index) => ({ at: at(index), succeeded: true }));
      const ring = normalizeHealthState({ "qwen3-coder": entry({ recentOutcomes: stored }) })[
        "qwen3-coder"
      ]?.recentOutcomes ?? [];
      expect(ring).toHaveLength(100);
      expect(ring[0]?.at).toBe(at(50));
      expect(ring[99]?.at).toBe(at(149));
    });
  });

  it("normalizes a malformed ring to no evidence", () => {
    const state = normalizeHealthState({
      "qwen3-coder": {
        verdict: "unknown",
        checkedAt: NOW,
        reason: "x",
        strikes: 0,
        failureStreak: 0,
        successStreak: 0,
        lastInvocationAt: null,
        degradedAt: null,
        recentOutcomes: [
          { at: NOW, succeeded: true },
          { at: "not-a-date", succeeded: false },
          { at: NOW, succeeded: "yes" },
          null,
        ],
      },
    });
    expect(state["qwen3-coder"]?.recentOutcomes).toEqual([{ at: NOW, succeeded: true }]);
  });
});

describe("the catalogue probe fails indeterminate, never dead", () => {
  const config = fixtureConfig("company-a").upstream;

  it("reads an OpenAI-shaped catalogue", async () => {
    const probe = await probeCatalogue({
      http: { async fetch() {
        return new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }), { status: 200 });
      } },
      config,
      credential: "x",
    });
    expect(probe.modelIds).toEqual(new Set(["a", "b"]));
  });

  it("hits the catalogue path, not the inference path", async () => {
    const urls: string[] = [];
    await probeCatalogue({
      http: { async fetch(url) {
        urls.push(String(url));
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      } },
      config,
      credential: "x",
    });
    expect(urls).toEqual(["https://company-a.example/api/v1/models"]);
  });

  for (const [label, respond] of [
    ["a transport failure", async () => { throw new Error("connect ECONNREFUSED"); }],
    ["an auth failure", async () => new Response("{}", { status: 401 })],
    ["a server error", async () => new Response("{}", { status: 503 })],
    ["a non-JSON body", async () => new Response("<html>", { status: 200 })],
    ["an unrecognised shape", async () => new Response(JSON.stringify({ models: [] }), { status: 200 })],
  ] as const) {
    it(`returns null for ${label}`, async () => {
      const probe = await probeCatalogue({ http: { fetch: respond as never }, config, credential: "x" });
      expect(probe.modelIds).toBeNull();
    });
  }

  it("treats an empty catalogue as a real answer, not an error", () => {
    expect(parseCatalogue({ data: [] })).toEqual(new Set());
  });
});
