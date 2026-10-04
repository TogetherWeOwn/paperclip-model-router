import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { checkRosterRowContract, type RosterRow } from "../src/roster/contract.js";

// TOG-14187: lane-bound row contract guard on frozen fixtures (read-only).
//
// The property under test is exactness in both directions: each case asserts
// the FULL sorted violation-code set, so weakening the guard (dropping a
// rule lets a bad fixture pass) and strengthening it (a new rule firing on an
// old fixture) both fail loudly instead of slipping through. No live
// catalogue read, no roster write — the allowlist and lanes come from the
// frozen fixture only.

const here = dirname(fileURLToPath(import.meta.url));

interface ContractCase {
  id: string;
  title: string;
  rows: RosterRow[];
  expectViolationCodes: string[];
}

const fixture = JSON.parse(
  readFileSync(join(here, "roster-row-contract.fixture.json"), "utf8"),
) as { version: number; allowlist: string[]; lanes: string[]; cases: ContractCase[] };

describe("roster row contract guard on frozen fixtures (offline)", () => {
  for (const kase of fixture.cases) {
    it(`${kase.id}: ${kase.title}`, () => {
      const got = checkRosterRowContract({
        allowlist: fixture.allowlist,
        lanes: fixture.lanes,
        rows: kase.rows,
      })
        .map((v) => v.code)
        .sort();
      expect(got).toEqual([...kase.expectViolationCodes].sort());
    });
  }

  it("clean fixture is green: zero violations", () => {
    const kase = fixture.cases.find((c) => c.id === "clean");
    expect(kase).toBeDefined();
    expect(
      checkRosterRowContract({ allowlist: fixture.allowlist, lanes: fixture.lanes, rows: kase!.rows }),
    ).toEqual([]);
  });
});
