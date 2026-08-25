/**
 * Mutation suite for scripts/tog473-mapping-guard-calibration.mjs.
 *
 * The calibration checker returned PASS on its first run (350/350 Claude-bearing ids
 * blocked, 0/130 over-blocked, 52/52 planned mappings accepted). That is exactly the
 * result a checker with no teeth returns, so every test below corrupts a known-good
 * input in one specific way and asserts the checker goes red for the right reason.
 *
 * What this is guarding is narrower than the TOG-178 preflight and more dangerous:
 * `mappings.create` is the ONLY broker verb that moves traffic. Its safety argument is
 * an empirical claim about the catalogue ("the family regex covers every Claude-bearing
 * id"), and empirical claims rot. The broker's own unit tests assert against hand-written
 * strings, which is the same blind spot that let TOG-237 ship — so the oracle here is the
 * real 480-id corpus, not a literal.
 *
 * M2 is the one that matters most: an Anthropic-served id spelling none of the
 * protected family names. A `claude` substring check clears it, and so would any test written by
 * someone who already believed the regex was right.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..");
const SCRIPT = join(REPO, "scripts", "tog473-mapping-guard-calibration.mjs");
const FX = join(REPO, "tests", "fixtures", "tog178");
const BROKER = resolve(REPO, "plugins", "omniroute-broker");

// TOG-391 vendored the broker into this repository because the old sibling copy had no
// history or CI. A missing vendored broker is now a repository defect, so this suite must
// fail rather than silently skip.
const brokerPresent = existsSync(join(BROKER, "dist", "verbs.js"));
const describeBroker = describe;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Model = { id: string; owned_by?: string; object?: string };

/** Stage a private copy of the catalogue + mapping plan so each mutation starts clean. */
function stage(): string {
  const d = mkdtempSync(join(tmpdir(), "tog473-"));
  dirs.push(d);
  copyFileSync(join(FX, "catalogue.json"), join(d, "catalogue.json"));
  copyFileSync(join(FX, "TOG-178-mapping-plan.json"), join(d, "TOG-178-mapping-plan.json"));
  return d;
}

const readCatalogue = (d: string) => JSON.parse(readFileSync(join(d, "catalogue.json"), "utf8"));
const writeCatalogue = (d: string, v: unknown) =>
  writeFileSync(join(d, "catalogue.json"), JSON.stringify(v));

/** The catalogue fixture may be a bare array or a {data:[...]} envelope. Handle both. */
function models(cat: unknown): Model[] {
  return Array.isArray(cat) ? cat : ((cat as { data?: Model[] }).data ?? []);
}

function run(dir: string) {
  const r = spawnSync("node", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      TOG473_CATALOGUE_FIXTURE: join(dir, "catalogue.json"),
      TOG473_BROKER_DIR: BROKER,
      TOG178_DIR: dir,
      // Must never be consulted in fixture mode. If the script ever reaches for the
      // network with a fixture set, this bogus value makes that visible instead of silent.
      OMNIROUTE_API_KEY: "",
    },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describeBroker("the known-good corpus passes", () => {
  it("returns 0 and says plainly that a fixture run is not a live check", () => {
    const r = run(stage());
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("NOT A LIVE CHECK");
    expect(r.out).toContain("RESULT: CALIBRATED");
  });

  it("reports the real corpus shape rather than a toy one", () => {
    const r = run(stage());
    expect(r.out).toMatch(/all 350 Claude-bearing ids are blocked/);
    expect(r.out).toMatch(/all 52 planned TOG-178 mappings pass/);
  });

  it("surfaces that every mapping create is two-key, so the runbook cannot miss it", () => {
    // Not a pass/fail condition — an operational fact phase 6 must plan for. `priority`
    // is mandatory on the route AND is a PAID_TRAFFIC_KEY, so the tripwire escalates
    // every single one of the 52 from single to dual approval.
    const r = run(stage());
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("52 of 52 mapping creates classify as TWO-KEY");
  });
});

describeBroker("guard bypass — the failure this checker exists to catch", () => {
  it("M1: an id spelling a family name is still blocked (control)", () => {
    const d = stage();
    const cat = readCatalogue(d);
    models(cat).push({ id: "vendor-x/claude-clone-v1", owned_by: "vendor-x", object: "model" });
    writeCatalogue(d, cat);
    // Caught by the WIDE net as Claude-bearing, and blocked by the regex ⇒ no escape.
    const r = run(d);
    expect(r.code, r.out).toBe(0);
  });

  it("M2: an Anthropic-served id spelling NO family name is caught as a bypass", () => {
    const d = stage();
    const cat = readCatalogue(d);
    // This is the TOG-237 shape: a substring check on "claude" clears it completely.
    models(cat).push({ id: "aug/atlas-v3-preview", owned_by: "anthropic", object: "model" });
    writeCatalogue(d, cat);
    const r = run(d);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("NOT blocked by the family regex");
    expect(r.out).toContain("aug/atlas-v3-preview");
  });

  it("M3: a family-name match with no corroborating string is reported, not failed", () => {
    const d = stage();
    const cat = readCatalogue(d);
    // A third-party model that happens to spell a family name. It is indistinguishable
    // from the 13 real `aug/` ids using the catalogue alone — both are bare family-name
    // matches with no "anthropic"/"claude" string — so the checker must NOT pretend it
    // can tell them apart. It reports; check 4 decides whether anything is actually lost.
    models(cat).push({ id: "opencode-go/haiku-writer-7b", owned_by: "opencode-go", object: "model" });
    writeCatalogue(d, cat);
    const r = run(d);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("14 id(s) match the family regex on the family name alone");
    expect(r.out).toContain("opencode-go/haiku-writer-7b");
  });

  it("M3b: the advisory list names the 13 real aug/ ids on the clean corpus", () => {
    const r = run(stage());
    expect(r.out).toContain("13 id(s) match the family regex on the family name alone");
    expect(r.out).toContain("aug/opus4.8");
  });

  it("M4: a catalogue id containing a wildcard char is reported as unaddressable", () => {
    const d = stage();
    const cat = readCatalogue(d);
    models(cat).push({ id: "opencode-go/weird?name", owned_by: "opencode-go", object: "model" });
    writeCatalogue(d, cat);
    const r = run(d);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("unaddressable under the ban");
  });
});

describeBroker("plan drift — the guard must not be widened to fit a plan", () => {
  it("M5: a planned mapping that gained a wildcard is refused, not accommodated", () => {
    const d = stage();
    const plan = JSON.parse(readFileSync(join(d, "TOG-178-mapping-plan.json"), "utf8"));
    const list = Array.isArray(plan) ? plan : plan.mappings;
    list[0].pattern = `${list[0].pattern}*`;
    writeFileSync(join(d, "TOG-178-mapping-plan.json"), JSON.stringify(plan));
    const r = run(d);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("REFUSED by the guard");
    expect(r.out).toContain("Widening the guard to fit a plan defeats its purpose");
  });

  it("M6: a planned mapping that lost its priority is refused", () => {
    const d = stage();
    const plan = JSON.parse(readFileSync(join(d, "TOG-178-mapping-plan.json"), "utf8"));
    const list = Array.isArray(plan) ? plan : plan.mappings;
    delete list[0].priority;
    writeFileSync(join(d, "TOG-178-mapping-plan.json"), JSON.stringify(plan));
    const r = run(d);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("REFUSED by the guard");
  });

  it("M7: a planned mapping re-pointing a Claude id is refused", () => {
    const d = stage();
    const plan = JSON.parse(readFileSync(join(d, "TOG-178-mapping-plan.json"), "utf8"));
    const list = Array.isArray(plan) ? plan : plan.mappings;
    list[0].pattern = "claude-sonnet-4-5";
    writeFileSync(join(d, "TOG-178-mapping-plan.json"), JSON.stringify(plan));
    const r = run(d);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("REFUSED by the guard");
  });
});

describeBroker("harness failures are not verdicts", () => {
  it("M8: an unreadable catalogue exits 2, never 0 and never 1", () => {
    const d = stage();
    writeFileSync(join(d, "catalogue.json"), "{not json");
    const r = run(d);
    expect(r.code, r.out).toBe(2);
    expect(r.out).toContain("This is not a pass");
  });

  it("M9: an empty catalogue exits 2 rather than vacuously passing", () => {
    const d = stage();
    writeCatalogue(d, []);
    const r = run(d);
    expect(r.code, r.out).toBe(2);
  });
});

describe("the suite cannot skip silently", () => {
  it("requires the vendored broker that the mutation suite exercises", () => {
    expect(
      brokerPresent,
      `[TOG-473] vendored omniroute-broker not found at ${BROKER}; the mutation suite has no subject.`,
    ).toBe(true);
  });
});
