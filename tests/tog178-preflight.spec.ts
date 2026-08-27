/**
 * Mutation suite for scripts/tog178-catalogue-revalidate.mjs.
 *
 * The revalidator returned PASS on its first run against the live catalogue. That is
 * exactly the result a checker with no teeth returns, and this company has already been
 * burned by one: the TOG-207 mock served invented routes and scored 30/30 green.
 *
 * So every test below CORRUPTS a known-good input in one specific way and asserts the
 * checker goes red on the specific check that owns that failure. A test that only asserts
 * "exit != 0" would pass even if the wrong gate fired, so each one pins the check id.
 *
 * The catalogue is a trimmed snapshot of the real corpus (tests/fixtures/tog178/
 * catalogue.json — every allowlisted leaf, the captured Claude-family ids, the protected
 * prefixes), so the containment checks run against real ids rather than toy ones. That
 * matters most for `aug/*`: those ids carry no `claude` substring, and a substring
 * audit clears them. M8 is the test that a substring audit would fail.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..");
const SCRIPT = join(REPO, "scripts", "tog178-catalogue-revalidate.mjs");
const FX = join(REPO, "tests", "fixtures", "tog178");
const INPUTS = [
  "TOG-178-combo-specs.json",
  "TOG-178-mapping-plan.json",
  "TOG-178-combo-allowlist.txt",
  "TOG-178-combo-legs.tsv",
  "TOG-178-containment-proof.json",
];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Copy the pristine inputs into a temp dir so each mutation starts from known-good. */
function stage(): string {
  const d = mkdtempSync(join(tmpdir(), "tog178-"));
  dirs.push(d);
  for (const f of INPUTS) copyFileSync(join(FX, f), join(d, f));
  return d;
}

const readJson = (d: string, f: string) => JSON.parse(readFileSync(join(d, f), "utf8"));
const writeJson = (d: string, f: string, v: unknown) =>
  writeFileSync(join(d, f), JSON.stringify(v));

/**
 * Run the revalidator against a staged dir. Returns exit code and combined output.
 * The script reports on stderr (so its findings survive a stdout redirect), so both
 * streams are captured on every path — success included.
 */
function run(dir: string, env: Record<string, string> = {}) {
  const r = spawnSync("node", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      TOG178_DIR: dir,
      TOG178_CATALOGUE_FIXTURE: join(FX, "catalogue.json"),
      ...env,
    },
  });
  // status is null when the child died on a signal. That is a harness failure, not a
  // verdict, so it becomes -1 and fails every assertion below rather than matching one.
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Assert the run failed AND that the named check is the one that caught it. */
function expectCaughtBy(r: { code: number; out: string }, check: string) {
  expect(r.code, `expected a non-zero exit\n${r.out}`).toBe(1);
  expect(r.out, `expected check ${check} to fire\n${r.out}`).toContain(`FAIL  [${check}]`);
}

describe("the known-good spec passes", () => {
  it("returns 0 and says plainly that a fixture run is not a live check", () => {
    const r = run(stage());
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("FIXTURE MODE");
    expect(r.out).toContain("NOT A LIVE CHECK");
  });
});

describe("the canonical companions agree", () => {
  it("derives every combo and allowlisted leaf from the 51-row TSV", () => {
    const rows = readFileSync(join(FX, "TOG-178-combo-legs.tsv"), "utf8")
      .trim().split("\n").slice(1).map((line) => line.split("\t"));
    const specs = readJson(FX, "TOG-178-combo-specs.json");
    const mappings = readJson(FX, "TOG-178-mapping-plan.json");
    const allowlist = readFileSync(join(FX, "TOG-178-combo-allowlist.txt"), "utf8")
      .split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    const proof = readJson(FX, "TOG-178-containment-proof.json");

    expect(rows).toHaveLength(51);
    expect(specs).toHaveLength(rows.length);
    expect(mappings).toHaveLength(rows.length);
    expect(specs.map((s: { name: string }) => s.name)).toEqual(rows.map((r) => r[0]));
    expect([...new Set(rows.flatMap((r) => [r[1], r[2]]))].sort()).toEqual(allowlist);
    expect(proof._overall).toBe("PASS");
    expect(proof._corpus).toMatchObject({ combo_legs: 102, combo_leaf_ids: 89, combos: 51, mappings: 51 });
  });
});

describe("catalogue churn — the failure this checker exists to catch", () => {
  it("M1: a leg id that no longer exists in the catalogue is caught by C2a", () => {
    const d = stage();
    const specs = readJson(d, "TOG-178-combo-specs.json");
    specs[0].models[0].model = "opencode-go/deepseek-v4-flash-DELETED";
    writeJson(d, "TOG-178-combo-specs.json", specs);
    expectCaughtBy(run(d), "C2a");
  });

  it("M5: a combo that lost its terminal PAYG leg is caught by C3", () => {
    const d = stage();
    const specs = readJson(d, "TOG-178-combo-specs.json");
    specs[2].models = specs[2].models.slice(0, 1);
    writeJson(d, "TOG-178-combo-specs.json", specs);
    expectCaughtBy(run(d), "C3");
  });
});

describe("Claude containment", () => {
  it("M3: a Claude id smuggled into a leg is caught by C4", () => {
    const d = stage();
    const specs = readJson(d, "TOG-178-combo-specs.json");
    specs[1].models[1].model = "openrouter/anthropic/claude-sonnet-4";
    writeJson(d, "TOG-178-combo-specs.json", specs);
    expectCaughtBy(run(d), "C4");
  });

  it("M2: a broad `*` mapping pattern is caught by C5a and C5b", () => {
    const d = stage();
    const maps = readJson(d, "TOG-178-mapping-plan.json");
    maps[0].pattern = "*";
    writeJson(d, "TOG-178-mapping-plan.json", maps);
    const r = run(d);
    expectCaughtBy(r, "C5a");
    expect(r.out).toContain("FAIL  [C5b]");
  });

  it("M8: `aug/*` is caught by C5b — the ids a `claude` substring audit would clear", () => {
    const d = stage();
    const maps = readJson(d, "TOG-178-mapping-plan.json");
    maps[5].pattern = "aug/*";
    writeJson(d, "TOG-178-mapping-plan.json", maps);
    const r = run(d);
    expectCaughtBy(r, "C5b");
    // The point of the test: these ids carry no `claude` substring at all.
    const aug = JSON.parse(readFileSync(join(FX, "catalogue.json"), "utf8"))
      .data.map((m: { id: string }) => m.id)
      .filter((i: string) => i.startsWith("aug/"));
    expect(aug.length).toBeGreaterThan(0);
    expect(aug.every((i: string) => !i.toLowerCase().includes("claude"))).toBe(true);
  });
});

describe("mapping integrity", () => {
  it("M4: a duplicate priority is caught by C6b — ties break on invisible created_at", () => {
    const d = stage();
    const maps = readJson(d, "TOG-178-mapping-plan.json");
    maps[1].priority = maps[0].priority;
    writeJson(d, "TOG-178-mapping-plan.json", maps);
    expectCaughtBy(run(d), "C6b");
  });
});

describe("additivity — the constraint protecting 19 bindings in other companies", () => {
  it("M7: a name inside a protected prefix is caught by C7a and C7b", () => {
    const d = stage();
    const specs = readJson(d, "TOG-178-combo-specs.json");
    specs[4].name = "hindsight/retain";
    writeJson(d, "TOG-178-combo-specs.json", specs);
    const r = run(d);
    expectCaughtBy(r, "C7b");
    expect(r.out).toContain("FAIL  [C7a]");
  });
});

describe("silent coercion", () => {
  it("M6: a strategy typo is caught by C8 — normalizeRoutingStrategy would not error", () => {
    const d = stage();
    const specs = readJson(d, "TOG-178-combo-specs.json");
    specs[3].strategy = "fill-frist";
    writeJson(d, "TOG-178-combo-specs.json", specs);
    expectCaughtBy(run(d), "C8");
  });
});

describe("a broken harness must never read as a clean spec", () => {
  it("an unreachable catalogue exits 2, not 0", () => {
    const r = run(stage(), {
      TOG178_CATALOGUE_FIXTURE: "",
      // Port 1 on loopback is refused deterministically on every runner. Pointing at
      // the `omniroute` alias instead would make this test depend on DNS that exists
      // in an agent container and not in CI.
      OMNIROUTE_MODELS_URL: "http://127.0.0.1:1/v1/models",
      OMNIROUTE_API_KEY: "sk-not-a-real-key",
    });
    expect(r.code, r.out).toBe(2);
    expect(r.out).toContain("UNABLE TO CHECK");
  });

  it("an empty catalogue exits 2 rather than vacuously passing every check", () => {
    const d = stage();
    const empty = join(d, "empty.json");
    writeFileSync(empty, JSON.stringify({ object: "list", data: [] }));
    const r = run(d, { TOG178_CATALOGUE_FIXTURE: empty });
    expect(r.code, r.out).toBe(2);
    expect(r.out).toContain("zero models");
  });
});
