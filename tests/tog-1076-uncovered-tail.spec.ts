/**
 * TOG-1076 — the uncovered-model tail under `fail-open`.
 *
 * Driven by the REAL deployed production config row (company
 * $PAPERCLIP_COMPANY_ID, plugin_config.updated_at
 * 2026-09-05T10:32:45.959Z), dumped read-only from the database and read
 * through the shipped `resolveConfig`. Nothing here is a hand-built fixture:
 * the model table, the four capacity sources and their modelIds are exactly
 * what the deployed engine loads.
 *
 * The claim under test: with every metered lane positively `exhausted`,
 * `exclude-lane` refuses, and `fail-open` selects an UNMETERED gemini model
 * with `degraded: false` — so the exhaustion backstop silently shifts onto a
 * lane with no quota visibility and nothing marks the decision as degraded.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CapacityEvidence } from "../src/capacity/types.js";
import { resolveConfig } from "../src/config/resolve.js";
import type { RouterConfig } from "../src/config/types.js";
import { selectModel } from "../src/engine/select.js";

const DEPLOYED_CONFIG_PATH = new URL("./data/tog1076-deployed-config.json", import.meta.url);
const LIVE_SNAPSHOT_PATH = new URL("./data/tog1076-live-snapshot.json", import.meta.url);

const raw = JSON.parse(readFileSync(DEPLOYED_CONFIG_PATH, "utf8")) as Record<string, unknown>;

function withUnknownTelemetry(policy: RouterConfig["capacityRouting"]["unknownTelemetry"]): RouterConfig {
  const capacityRouting = { ...(raw.capacityRouting as Record<string, unknown>), unknownTelemetry: policy };
  return resolveConfig({ ...raw, capacityRouting });
}

/** Model ids named by at least one capacity source in the deployed config. */
function meteredIds(config: RouterConfig): Set<string> {
  const ids = new Set<string>();
  for (const source of config.capacityRouting.sources) for (const id of source.modelIds) ids.add(id);
  return ids;
}

function enabledIds(config: RouterConfig): string[] {
  return config.models.filter((model) => model.enabled).map((model) => model.id);
}

/**
 * Every metered lane reports a positive `exhausted` health — the real fleet
 * exhaustion case, not a telemetry outage. Per TOG-1062 this is a positive
 * signal and must exclude those models under every policy.
 */
function everyMeteredLaneExhausted(config: RouterConfig): CapacityEvidence[] {
  const evidence: CapacityEvidence[] = [];
  for (const source of config.capacityRouting.sources) {
    for (const modelId of source.modelIds) {
      evidence.push({
        modelId,
        source: source.id,
        laneLabel: "record-1",
        health: "exhausted",
        posture: "unavailable",
        utilization: 1,
        remainingFraction: 0,
        resetsAt: "2026-09-05T18:00:00.000Z",
        resetInSeconds: 3600,
        windows: [],
        telemetryAvailable: true,
        reason: "quota exhausted",
      });
    }
  }
  return evidence;
}

describe("TOG-1076: enabled models with no capacity telemetry coverage", () => {
  const config = withUnknownTelemetry("exclude-lane");

  it("the deployed config leaves exactly the 6 gemini models unmetered", () => {
    const metered = meteredIds(config);
    const uncovered = enabledIds(config)
      .filter((id) => !metered.has(id))
      .sort();

    expect(uncovered).toEqual([
      "cliproxy/gemini-3-flash",
      "cliproxy/gemini-3.1-flash-lite",
      "cliproxy/gemini-3.1-pro-low",
      "cliproxy/gemini-3.6-flash-high",
      "cliproxy/gemini-3.7-flash-high",
      "cliproxy/gemini-pro-agent",
    ]);
    // Sanity: the finding is about a minority tail, not a broken config.
    expect(enabledIds(config)).toHaveLength(45);
  });

  it("exclude-lane refuses when every metered lane is exhausted", () => {
    const decision = selectModel({
      descriptor: { taskClass: "mechanical" },
      config: withUnknownTelemetry("exclude-lane"),
      signals: { capacityEvidence: everyMeteredLaneExhausted(config) },
    });

    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.modelId).toBeNull();
  });

  it("fail-open still SERVES from an unmetered model rather than denying (this part is correct)", () => {
    const failOpen = withUnknownTelemetry("fail-open");
    const metered = meteredIds(failOpen);
    const decision = selectModel({
      descriptor: { taskClass: "mechanical" },
      config: failOpen,
      signals: { capacityEvidence: everyMeteredLaneExhausted(failOpen) },
    });

    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).not.toBeNull();

    // The winner is a model no capacity source covers, selected on absent
    // evidence. Serving here is the intended fail-open behaviour — the defect
    // was never that it serves, only that it did so silently.
    expect(metered.has(decision.modelId!)).toBe(false);
    expect(decision.modelId).toMatch(/^cliproxy\/gemini-/);
    expect(decision.capacity.usagePosture).toBe("unknown");
    expect(decision.capacity.selectedSource).toBeNull();
    expect(decision.capacity.telemetry).toBe("available");
  });

  /**
   * The fix. Serving an uncovered model IS a degraded decision: the router had
   * no capacity evidence for what it chose. Before the change this reported
   * `degraded: false` purely because the telemetry FETCH succeeded, so a
   * dashboard watching the flag saw a healthy decision.
   */
  it("flags an uncovered winner as degraded, so the shift is visible", () => {
    const failOpen = withUnknownTelemetry("fail-open");
    const decision = selectModel({
      descriptor: { taskClass: "mechanical" },
      config: failOpen,
      signals: { capacityEvidence: everyMeteredLaneExhausted(failOpen) },
    });

    expect(decision.outcome).toBe("selected");
    expect(decision.capacity.degraded).toBe(true);
  });

  it("does NOT flag the healthy path — a covered winner stays undegraded", () => {
    const failOpen = withUnknownTelemetry("fail-open");
    // One healthy covered lane: the ordinary case, 166/200 of real traffic.
    const healthy: CapacityEvidence[] = [
      {
        modelId: "cliproxy/deepseek-v4-flash",
        source: "cliproxy-opencode-go",
        laneLabel: "record-1",
        health: "healthy",
        posture: "available",
        utilization: 0.1,
        remainingFraction: 0.9,
        resetsAt: null,
        resetInSeconds: null,
        windows: [],
        telemetryAvailable: true,
        reason: "ok",
      },
    ];
    const decision = selectModel({
      descriptor: { taskClass: "mechanical" },
      config: failOpen,
      signals: { capacityEvidence: healthy },
    });

    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("cliproxy/deepseek-v4-flash");
    expect(decision.capacity.degraded).toBe(false);
  });

  /**
   * The tail is NOT confined to total fleet exhaustion, contrary to the framing
   * this issue was raised under.
   *
   * Driven by the LIVE capacity snapshot as the deployed engine last refreshed
   * it (2026-09-05T12:57:51.796Z), in which `cliproxy-kimi` is ALREADY
   * exhausted in production. Exhaust two more lanes — leaving `cliproxy-claude`
   * healthy and reporting — and `implementation` already lands on an unmetered
   * gemini model. The healthy claude survivors are all either below quality
   * floor 60 or above the `standard` tier ceiling, so the uncovered models are
   * the only things left in the band.
   */
  it("an uncovered model wins while a metered lane is still healthy, not just at total exhaustion", () => {
    const failOpen = withUnknownTelemetry("fail-open");
    const live = JSON.parse(readFileSync(LIVE_SNAPSHOT_PATH, "utf8")) as { evidence: CapacityEvidence[] };

    // Sanity: the live snapshot really does already carry an exhausted lane.
    const liveExhausted = new Set(live.evidence.filter((e) => e.health === "exhausted").map((e) => e.source));
    expect([...liveExhausted]).toEqual(["cliproxy-kimi"]);

    const knockOut = new Set(["cliproxy-codex", "cliproxy-opencode-go"]);
    const evidence = live.evidence.map((entry) =>
      knockOut.has(entry.source)
        ? { ...entry, health: "exhausted" as const, posture: "unavailable" as const, utilization: 1, remainingFraction: 0, telemetryAvailable: true }
        : entry,
    );

    // cliproxy-claude is untouched and still positively healthy.
    const stillHealthy = evidence.filter((e) => e.posture === "available");
    expect(stillHealthy.length).toBeGreaterThan(0);
    expect(new Set(stillHealthy.map((e) => e.source))).toEqual(new Set(["cliproxy-claude"]));

    const decision = selectModel({
      descriptor: { taskClass: "implementation" },
      config: failOpen,
      signals: { capacityEvidence: evidence },
    });

    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toMatch(/^cliproxy\/gemini-/);
    expect(decision.capacity.degraded).toBe(true);
  });

  it("the exhausted metered lanes are excluded for the right reason (not the TOG-1062 regression)", () => {
    const failOpen = withUnknownTelemetry("fail-open");
    const decision = selectModel({
      descriptor: { taskClass: "mechanical" },
      config: failOpen,
      signals: { capacityEvidence: everyMeteredLaneExhausted(failOpen) },
    });

    const capacityRejected = decision.rejections.filter((entry) => entry.stage === "capacity");
    expect(capacityRejected.length).toBeGreaterThan(0);
    for (const entry of capacityRejected) expect(entry.reason).toContain("unavailable");

    // Every surviving candidate is an unmetered model — nothing metered slipped through.
    const metered = meteredIds(failOpen);
    for (const candidate of decision.candidates) expect(metered.has(candidate.modelId)).toBe(false);
  });
});
