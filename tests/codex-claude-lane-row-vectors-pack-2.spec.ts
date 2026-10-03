import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { evidenceFromContract } from "../src/capacity/normalize.js";
import type { CapacitySourceDefinition } from "../src/capacity/types.js";

// Codex + Claude lane-row validation vectors, pack 2 (source-only, offline).
//
// Frozen wire bodies for the two pacing-eligible lanes, run through the pure
// contract consumer — no HTTP, no live catalogue read, no roster write. Pack 2
// pins the time/agreement surface the round-trip suite does not freeze:
// snapshot expiry, reset-countdown derivation and preference, and
// serviceable/state agreement. Each case asserts the FULL expected outcome
// (telemetry, reason code, every projected row field), so consumer drift in
// either direction — dropping a rule or adding one that fires on a frozen
// body — fails loudly instead of slipping through.

const here = dirname(fileURLToPath(import.meta.url));

interface ExpectedRow {
  modelId: string;
  health: string;
  posture: string;
  utilization: number | null;
  resetsAt: string | null;
  resetInSeconds: number | null;
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
  readFileSync(join(here, "codex-claude-lane-row-vectors-pack-2.fixture.json"), "utf8"),
) as {
  version: number;
  sources: Record<string, CapacitySourceDefinition>;
  cases: VectorCase[];
};

describe("codex/claude lane-row vectors pack 2 (offline)", () => {
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
          health: row.health,
          posture: row.posture,
          utilization: row.utilization,
          resetsAt: row.resetsAt,
          resetInSeconds: row.resetInSeconds,
        })),
      ).toEqual(kase.expect.rows);
    });
  }

  it("fixture covers all three pack-2 groups", () => {
    const ids = fixture.cases.map((c) => c.id);
    for (const prefix of ["expiry-", "countdown-", "agreement-"]) {
      expect(ids.some((id) => id.startsWith(prefix)), `no ${prefix}* case`).toBe(true);
    }
  });
});
