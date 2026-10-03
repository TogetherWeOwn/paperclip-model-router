import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { evidenceFromContract } from "../src/capacity/normalize.js";
import type { CapacitySourceDefinition } from "../src/capacity/types.js";

// Muse lane-row validation vectors (source-only, offline).
//
// Mirror of the Codex+Claude pack-2 suite for the roster's Muse lane row:
// frozen wire bodies for the cliproxy-meta source, run through the pure
// contract consumer — no HTTP, no live catalogue read, no roster write. Cases
// pin model id, lane binding (every projected row carries the Muse lane
// source), snapshot expiry, reset-countdown derivation and preference,
// serviceable/state agreement, and weekly-window projection. Each case
// asserts the FULL expected outcome (telemetry, reason code, every projected
// row field), so consumer drift in either direction — dropping a rule or
// adding one that fires on a frozen body — fails loudly instead of slipping
// through. The binding cases additionally prove the byte-for-byte lookup:
// other lanes' rows in the same snapshot never project onto the Muse source.

const here = dirname(fileURLToPath(import.meta.url));

interface ExpectedWindow {
  name: string;
  utilization: number | null;
  remainingFraction: number | null;
  resetsAt: string | null;
  sourcePath: string;
}

interface ExpectedRow {
  modelId: string;
  source: string;
  health: string;
  posture: string;
  utilization: number | null;
  resetsAt: string | null;
  resetInSeconds: number | null;
  windows: ExpectedWindow[];
}

interface VectorCase {
  id: string;
  title: string;
  source: string;
  fetchedAt: string;
  payload: unknown;
  expect: {
    telemetry: "available" | "unavailable";
    reasonCode: string | null;
    rows: ExpectedRow[];
  };
}

const fixture = JSON.parse(
  readFileSync(join(here, "fixtures", "muse-lane-row-vectors.json"), "utf8"),
) as {
  version: number;
  sources: Record<string, CapacitySourceDefinition>;
  cases: VectorCase[];
};

describe("muse lane-row vectors (offline)", () => {
  for (const kase of fixture.cases) {
    it(`${kase.id}: ${kase.title}`, () => {
      const source: CapacitySourceDefinition | undefined = fixture.sources[kase.source];
      expect(source, `unknown source ${kase.source}`).toBeDefined();
      if (!source) throw new Error(`unknown source ${kase.source}`);

      const got = evidenceFromContract({
        payload: kase.payload,
        source,
        fetchedAt: kase.fetchedAt,
      });

      expect(got.telemetry).toBe(kase.expect.telemetry);
      expect(got.reasonCode).toBe(kase.expect.reasonCode);
      expect(
        got.evidence.map((row) => ({
          modelId: row.modelId,
          source: row.source,
          health: row.health,
          posture: row.posture,
          utilization: row.utilization,
          resetsAt: row.resetsAt,
          resetInSeconds: row.resetInSeconds,
          windows: row.windows.map((window) => ({
            name: window.name,
            utilization: window.utilization,
            remainingFraction: window.remainingFraction,
            resetsAt: window.resetsAt,
            sourcePath: window.sourcePath,
          })),
        })),
      ).toEqual(kase.expect.rows);
    });
  }

  it("muse source binds the roster's Muse row to the Muse lane", () => {
    const muse: CapacitySourceDefinition | undefined = fixture.sources.muse;
    expect(muse, "missing muse source").toBeDefined();
    if (!muse) throw new Error("missing muse source");
    expect(muse.id).toBe("cliproxy-meta");
    expect(muse.modelIds).toEqual(["muse-spark-1.3-contributor"]);
  });

  it("fixture covers all five vector groups", () => {
    const ids = fixture.cases.map((c) => c.id);
    for (const prefix of ["expiry-", "countdown-", "agreement-", "binding-", "windows-"]) {
      expect(ids.some((id) => id.startsWith(prefix)), `no ${prefix}* case`).toBe(true);
    }
  });
});
