import { describe, expect, it } from "vitest";

import { applyHealth, DEAD_STRIKES, reconcileHealth } from "../src/health/reconcile.js";
import { parseCatalogue, probeCatalogue } from "../src/health/probe.js";
import type { ModelHealthState } from "../src/health/types.js";
import { fixtureConfig } from "./helpers.js";

const NOW = "2026-08-30T00:00:00.000Z";
const models = fixtureConfig("company-a").models;
const ALL = new Set(models.map((model) => model.id));

function catalogue(ids: Set<string> | null) {
  return { modelIds: ids, detail: "probe", status: ids ? 200 : null };
}

/** Drive the same probe answer through reconcile until it sticks. */
function repeat(ids: Set<string> | null, times: number): ModelHealthState {
  let state: ModelHealthState = {};
  for (let index = 0; index < times; index += 1) {
    state = reconcileHealth({ models, probe: catalogue(ids), previous: state, now: NOW }).next;
  }
  return state;
}

describe("a model that goes dark is taken out of service", () => {
  it("needs consecutive confirmations before disabling anything", () => {
    const present = new Set([...ALL].filter((id) => id !== "qwen3-coder"));
    const first = reconcileHealth({ models, probe: catalogue(present), previous: {}, now: NOW });
    // One absence is a strike, not a verdict — the model still serves.
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

  it("flips a recovered model back and clears its strikes", () => {
    const dark = repeat(new Set([...ALL].filter((id) => id !== "qwen3-coder")), DEAD_STRIKES);
    expect(dark["qwen3-coder"]?.verdict).toBe("dead");

    const recovered = reconcileHealth({ models, probe: catalogue(ALL), previous: dark, now: NOW });
    expect(recovered.next["qwen3-coder"]).toMatchObject({ verdict: "healthy", strikes: 0 });
    expect(recovered.flips).toEqual([
      expect.objectContaining({ modelId: "qwen3-coder", from: "dead", to: "healthy" }),
    ]);
  });

  it("never re-enables a model the operator disabled", () => {
    const operatorDisabled = models.map((model) =>
      model.id === "qwen3-coder" ? { ...model, enabled: false } : model,
    );
    const healthy = reconcileHealth({ models, probe: catalogue(ALL), previous: {}, now: NOW }).next;
    expect(applyHealth(operatorDisabled, healthy).find((m) => m.id === "qwen3-coder")?.enabled).toBe(false);
  });

  it("changes nothing at all on an indeterminate probe", () => {
    // The failure mode this guards: a bad minute upstream blacking out the
    // whole table, which is strictly worse than the defect being fixed.
    const previous = repeat(ALL, 1);
    const result = reconcileHealth({ models, probe: catalogue(null), previous, now: NOW });
    expect(result.next).toBe(previous);
    expect(result.flips).toEqual([]);
    expect(applyHealth(models, result.next).every((model) => model.enabled)).toBe(true);
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
    // The upstream did answer and listed nothing. That legitimately disables
    // the table; only failures are indeterminate.
    expect(parseCatalogue({ data: [] })).toEqual(new Set());
  });
});
