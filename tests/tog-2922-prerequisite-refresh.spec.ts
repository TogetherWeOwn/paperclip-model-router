import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readCapacitySource } from "../packages/lane-capacity/src/read.js";

/**
 * TOG-2922 acceptance: the PREREQUISITE config write -- which lands
 * `sources[].pace` while `capacityRouting.paceOrdering` is still false --
 * produces a non-empty verdict for every live source.
 *
 * This is the criterion the v0.4.3 candidate failed (TOG-2929). It gated pace
 * evaluation on the steering flag, so the prerequisite refresh stored nothing
 * and the later one-key enable would have started cold. `worker.spec.ts` pins
 * the worker seam; this pins the other half the review asked for: the exact
 * reviewed `pace` blocks compute against the field names the four live lane
 * collectors actually publish.
 *
 * The lane documents below carry the real field NAMES from the reviewed blocks
 * and real utilization VALUES observed 2026-09-16T16:10Z. They are fixtures,
 * not a live fetch -- CI holds no lane credentials. The live assertion is the
 * `jq -e` gate in the operator runbook, run against the real refresh at install
 * time.
 */
const ROOT = path.resolve(import.meta.dirname, "..");
const prerequisites = JSON.parse(
  readFileSync(path.join(ROOT, "docs/operator/tog-2922-pace-prerequisites.json"), "utf8"),
) as {
  capacityRouting: {
    pacePolicy: Record<string, number>;
    sourcesById: Record<string, { pace: {
      windows: Array<{ name: string; utilizationFields: string[]; resetFields: string[]; defaultWindowSeconds: number }>;
    } }>;
  };
};
const { pacePolicy, sourcesById } = prerequisites.capacityRouting;

const OBSERVED_AT = "2026-09-16T16:10:28.507Z";
const observed = new Date(OBSERVED_AT);
const plus = (seconds: number) => new Date(observed.getTime() + seconds * 1_000).toISOString();

/**
 * Lane documents are written out LITERALLY, not derived from the pace blocks
 * under test. A first cut of this file built each document from the block's own
 * `utilizationFields`, which made it self-fulfilling: renaming a field in the
 * prerequisites renamed it in the fixture too, and a deliberately wrong field
 * name survived as a green test. These literals are the independent witness --
 * field names transcribed from what the four collectors publish, utilization
 * values observed 2026-09-16T16:10Z (TOG-2482 lane-pace series). If someone
 * edits a field name in the reviewed prerequisites, the verdict degrades to
 * `unknown` here and the suite goes red.
 */
const LANE_DOCUMENTS: Record<string, { records: Array<Record<string, unknown>> }> = {
  "cliproxy-claude": {
    records: [{
      health: "healthy",
      weight: 1,
      governing_window: "seven_day",
      window_seconds: { five_hour: 18_000, seven_day: 604_800 },
      five_hour_utilization: 0.59,
      five_hour_resets_at: plus(9_000),
      seven_day_utilization: 0.59,
      seven_day_resets_at: plus(302_400),
    }],
  },
  "cliproxy-codex": {
    records: [{
      health: "healthy",
      weight: 1,
      governing_window: "weekly",
      window_seconds: { weekly: 604_800 },
      weekly_utilization: 0.99,
      weekly_resets_at: plus(302_400),
    }],
  },
  // Kimi publishes health, weight and window metadata but no utilization or
  // reset pair at all. That absence is the point of its `windows: []` block.
  "cliproxy-kimi": {
    records: [{
      health: "healthy",
      weight: 1,
      governing_window: "weekly",
      window_seconds: { weekly: 604_800 },
    }],
  },
  "cliproxy-opencode-go": {
    records: [{
      health: "healthy",
      weight: 1,
      governing_window: "weekly",
      window_seconds: { five_hour: 18_000, weekly: 604_800 },
      five_hour_utilization: 0.23,
      five_hour_resets_at: plus(9_000),
      weekly_utilization: 0.23,
      weekly_resets_at: plus(302_400),
    }],
  },
};

function laneDocument(sourceId: string) {
  return {
    schemaVersion: 1,
    observedAt: OBSERVED_AT,
    staleAfterSeconds: 300,
    records: LANE_DOCUMENTS[sourceId]!.records,
  };
}

async function verdictFor(sourceId: string) {
  const document = laneDocument(sourceId);
  return readCapacitySource({
    source: {
      id: sourceId,
      statusUrl: `https://lane.example/${sourceId}`,
      modelIds: [],
      healthFields: ["health"],
      requestTimeoutMs: 5_000,
      maxResponseBytes: 262_144,
      windows: [],
    },
    http: {
      async request() {
        return {
          status: 200,
          contentType: "application/json",
          body: document,
          responseBytes: JSON.stringify(document).length,
          redirected: false,
        };
      },
    },
    apiKey: null,
    now: () => OBSERVED_AT,
    // The whole point: the prerequisite write leaves paceOrdering false, and
    // the lane definition is still passed, because evaluation keys on the
    // source having a `pace` block rather than on the steering flag.
    lane: sourcesById[sourceId]!.pace as never,
    pacePolicy: pacePolicy as never,
  });
}

describe("TOG-2922: the reviewed prerequisite pace blocks produce verdicts with paceOrdering off", () => {
  it("covers exactly the four live sources", () => {
    expect(Object.keys(sourcesById).sort()).toEqual([
      "cliproxy-claude",
      "cliproxy-codex",
      "cliproxy-kimi",
      "cliproxy-opencode-go",
    ]);
  });

  /**
   * The expected verdict for each lane, stated as a literal.
   *
   * An earlier cut of this file asserted only `typeof state === "string"`
   * (TOG-2993). That is vacuous: a lane whose `utilizationFields` no longer
   * match what its collector publishes degrades to `unknown`, and `unknown` is
   * a string, so a broken prerequisite stayed green. Only Kimi is allowed to be
   * `unknown`, and only because its block is deliberately `windows: []`.
   */
  const EXPECTED_STATE: Record<string, string> = {
    "cliproxy-claude": "on",
    "cliproxy-codex": "ahead",
    "cliproxy-kimi": "unknown",
    "cliproxy-opencode-go": "behind",
  };

  it("returns the expected verdict for every source even while legacy capacity evidence is empty", async () => {
    for (const sourceId of Object.keys(sourcesById).sort()) {
      const snapshot = await verdictFor(sourceId);
      expect(snapshot.pace?.state, `${sourceId} produced the wrong verdict`).toBe(EXPECTED_STATE[sourceId]);
      // These fixtures carry no legacy capacity windows, so the evidence
      // normalizer reports exactly the error the LIVE snapshot has carried
      // since 2026-09-10. Pace is computed from the same body by its own
      // definition, so the verdict must survive it -- that is what makes the
      // prerequisite refresh usable on the router as it stands today.
      expect(snapshot.error).toBe("capacity payload carried no recognizable telemetry records");
      expect(snapshot.evidence).toEqual([]);
    }
  });

  it("splits the lanes rather than collapsing them to one state", async () => {
    // If every lane returned the same state the ordering would be inert, and a
    // verdict-count assertion alone would not notice.
    const codex = await verdictFor("cliproxy-codex");
    const opencode = await verdictFor("cliproxy-opencode-go");
    expect(codex.pace?.state, "codex at 0.99 utilization should be ahead of pace").toBe("ahead");
    expect(opencode.pace?.state, "opencode-go at 0.23 utilization should be behind pace").toMatch(/^behind/);
  });

  it("computes Claude from its own lane document rather than degrading to unknown", async () => {
    // Claude is the lane TOG-2993 caught: it is not covered by the
    // ahead/behind split above, and it is the one lane whose fields nothing
    // else pins. Renaming either `seven_day_utilization` or
    // `seven_day_resets_at` in the reviewed prerequisites makes the governing
    // window incomputable, and this assertion is what turns that red.
    const claude = await verdictFor("cliproxy-claude");
    expect(claude.pace?.state, "Claude must not be unknown").not.toBe("unknown");
    expect(claude.pace?.reason).toBe("ok");
    // 0.59 spent against 0.5 of the seven-day window elapsed: inside the 0.1
    // margin, so `on`. Pinning the score proves the number came from the lane
    // document and not from a default.
    expect(claude.pace?.score).toEqual({ utilization: 0.59, elapsed: 0.5, deviation: 0.09 });
  });

  it("keeps Kimi explicitly unknown instead of fabricating or dropping it", async () => {
    // Kimi publishes health but no utilization/reset pair, so its block is
    // `windows: []`. The verdict must be present and fail-neutral.
    const kimi = await verdictFor("cliproxy-kimi");
    expect(kimi.pace?.state).toBe("unknown");
  });
});
