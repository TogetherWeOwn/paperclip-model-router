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
    new Date(Date.parse(NOW) + offset * 60_000).toISOString();

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

  it("trips a flaky lane the streak logic would keep serving", () => {
    const nine = drive(flaky(9));
    expect(nine["qwen3-coder"]?.verdict).toBe("unknown");
    const ten = drive([[9, false]], nine);
    expect(ten["qwen3-coder"]).toMatchObject({ verdict: "degraded" });
    expect(ten["qwen3-coder"]?.reason).toContain("5 of 10 routed calls failed");
    expect(ten["qwen3-coder"]?.degradedAt).toBe(atMinute(9));
  });

  it("trips exactly at the 20% boundary", () => {
    // Two separated failures in ten: never consecutive, exactly 20%.
    const pattern: Array<[number, boolean]> = [
      [0, false], [1, true], [2, true], [3, true], [4, true],
      [5, false], [6, true], [7, true], [8, true], [9, true],
    ];
    const state = drive(pattern);
    expect(state["qwen3-coder"]).toMatchObject({ verdict: "degraded" });
    expect(state["qwen3-coder"]?.reason).toContain("2 of 10 routed calls failed");
  });

  it("holds a 10% lane on streaks alone", () => {
    const pattern: Array<[number, boolean]> = [
      [0, false], [1, true], [2, true], [3, true], [4, true],
      [5, true], [6, true], [7, true], [8, true], [9, true],
    ];
    const state = drive(pattern);
    expect(state["qwen3-coder"]?.verdict).toBe("healthy");
  });

  it("ignores a high rate on too few samples", () => {
    // 1 failure in 4 is a 25% rate, but 4 samples are below the minimum, so
    // streaks alone decide — and three straight successes heal to healthy.
    const state = drive([[0, false], [1, true], [2, true], [3, true]]);
    expect(state["qwen3-coder"]?.verdict).toBe("healthy");
    // Two samples at a 50% rate still trip nothing: below the minimum, streaks rule.
    expect(drive([[0, false], [1, true]])["qwen3-coder"]?.verdict).toBe("unknown");
  });

  it("lets aged-out failures slide out of the window", () => {
    let state = drive(flaky(10));
    expect(state["qwen3-coder"]?.verdict).toBe("degraded");
    // Sixteen minutes later the tripping evidence has left the 15-minute
    // window; two successes recover on streaks with no rate to override them.
    state = drive([[25, true], [26, true]], state);
    expect(state["qwen3-coder"]?.verdict).toBe("healthy");
  });

  it("slides the avoid window forward while the lane keeps failing", () => {
    let state = drive(flaky(10));
    expect(state["qwen3-coder"]?.degradedAt).toBe(atMinute(9));
    state = drive(
      [[10, false], [11, false], [12, false], [13, false], [14, false], [15, false]],
      state,
    );
    expect(state["qwen3-coder"]?.verdict).toBe("degraded");
    expect(state["qwen3-coder"]?.degradedAt).toBe(atMinute(15));
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
      "qwen3-coder": {
        verdict: "degraded",
        checkedAt: NOW,
        reason: "rate trip",
        strikes: 0,
        failureStreak: 1,
        successStreak: 0,
        lastInvocationAt: NOW,
        degradedAt: NOW,
        recentOutcomes: Array.from({ length: 10 }, () => ({ at: atMinute(30), succeeded: false })),
      },
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
