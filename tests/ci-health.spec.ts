/**
 * Guard suite for scripts/ci-health.mjs — the TOG-489 detector.
 *
 * The script answers "did CI actually run", which the PR page cannot. Its whole
 * value is a distinction, so the tests are about the distinction and not about
 * the happy path: a classifier that shouted DID_NOT_RUN at everything would have
 * looked perfectly correct on the day it was written, because on that day every
 * check on `main` really had been refused.
 *
 * Two directions, and they are not equally dangerous:
 *
 *   a real failure mistaken for infrastructure  -> the company learns to wave
 *                                                  through red builds. Silent,
 *                                                  permanent, and it defeats the
 *                                                  secret scan.
 *   infrastructure mistaken for a real failure  -> someone wastes an hour and
 *                                                  finds the truth.
 *
 * Only the second is self-correcting, so `REFUSAL_PATTERNS` is deliberately
 * narrow and the adversarial strings below are the ones that would widen it:
 * a genuine test failure in a module called "billing", and a job that was
 * CANCELLED rather than never started. Both must stay FAIL.
 *
 * These tests run offline against the pure classifiers. The live end-to-end
 * behaviour was verified by hand against four real commits (three green, one
 * refused) and is recorded on TOG-489.
 */

import { describe, expect, it } from "vitest";

// scripts/ is outside tsconfig's `include` and has no declarations, so resolve
// the module through a computed specifier: TS types a non-literal dynamic
// import as `any` instead of failing to find a .d.ts, and vitest loads the real
// file at runtime. The local interfaces below are the actual contract.
type Annotation = { message: string };
type CheckRun = {
  name: string;
  status: string;
  conclusion?: string | null;
  started_at?: string;
  completed_at?: string;
  html_url?: string;
};
type Result = {
  name: string;
  verdict: "PASS" | "FAIL" | "DID_NOT_RUN" | "PENDING" | "SKIPPED";
  seconds: number | null;
  reason?: string;
  audience?: string;
  message?: string | null;
  note?: string;
};
interface CiHealth {
  EXIT: Record<string, number>;
  REFUSAL_PATTERNS: { match: RegExp; label: string; audience: string }[];
  classifyRefusal(
    a: Annotation[] | null,
  ): { label: string; audience: string; message: string } | null;
  classifyCheckRun(cr: CheckRun, annotations: Annotation[] | null): Result;
  decideVerdict(
    results: Result[],
    required?: string[],
  ): {
    verdict: string;
    refused: Result[];
    failed: Result[];
    missing: string[];
    unsatisfied: string[];
  };
}

const specifier = new URL("../scripts/ci-health.mjs", import.meta.url).href;
const ci: CiHealth = await import(/* @vite-ignore */ specifier);

/** The exact annotation GitHub returned on every job of d29c2ab, 2026-08-25. */
const TOG489_ANNOTATION =
  "The job was not started because recent account payments have failed or " +
  "your spending limit needs to be increased. Please check the 'Billing & " +
  "plans' section in your settings";

const ann = (message: string): Annotation[] => [{ message }];

const completed = (name: string, conclusion: string, seconds = 20): CheckRun => ({
  name,
  status: "completed",
  conclusion,
  started_at: "2026-08-25T17:38:09Z",
  completed_at: new Date(
    new Date("2026-08-25T17:38:09Z").getTime() + seconds * 1000,
  ).toISOString(),
});

describe("refusal patterns do not swallow genuine failures", () => {
  // Every one of these is a job that RAN and produced a real finding. If any is
  // classified as infrastructure, the finding gets dismissed and never fixed.
  const GENUINE = [
    "gitleaks has detected a secret in commit d29c2ab: aws-access-token in src/config.ts:14",
    "Process completed with exit code 1.",
    "src/engine.ts(88,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "FAIL tests/two-company.spec.ts > routes company B to the configured lane",
    "CHANGELOG.md has no entry for version 0.2.4; refusing to tag a release.",
    "npm ERR! code E404 notarget No matching version found for @paperclip/model-router@0.9.9",
    // Adversarial: the word "billing" in a real product failure.
    "The billing module test failed: expected 3 charges, received 2.",
    // Adversarial: cancelled is not the same as never started. A cancelled job
    // may well have run and been killed; it is not a spend problem.
    "Error: the job was cancelled because a dependent job failed",
    // Adversarial: a test asserting ON the refusal string must not itself match.
    "expected the spending limit banner to render, but it did not",
  ];

  for (const message of GENUINE) {
    it(`stays a genuine failure: ${message.slice(0, 54)}`, () => {
      expect(ci.classifyRefusal(ann(message))).toBeNull();
      expect(ci.classifyCheckRun(completed("secret scan", "failure"), ann(message)).verdict).toBe(
        "FAIL",
      );
    });
  }
});

describe("refusal patterns catch infrastructure refusals", () => {
  const REFUSALS: [string, string][] = [
    [TOG489_ANNOTATION, "GitHub refused to start the job"],
    [
      "You have exceeded your included Actions minutes usage for this billing cycle.",
      "Actions minutes exhausted",
    ],
    ["No runner is online matching the labels: ubuntu-latest", "no runner available"],
  ];

  for (const [message, label] of REFUSALS) {
    it(`caught as a refusal: ${message.slice(0, 54)}`, () => {
      const hit = ci.classifyRefusal(ann(message));
      expect(hit).not.toBeNull();
      expect(hit!.label).toBe(label);
    });
  }

  it("names an audience who is not an engineer, for the TOG-489 case", () => {
    // The failure being fixed is a routing failure: a billing problem was shown
    // to engineers as a secret-scanning result. The audience is the payload.
    const hit = ci.classifyRefusal(ann(TOG489_ANNOTATION));
    expect(hit!.audience).toContain("billing");
  });
});

describe("duration never decides a verdict", () => {
  // Before the TOG-2547 job merge, the healthy run on fdd1b62 finished
  // `version and changelog` in 6s and `secret scan` in 8s, while the refused
  // jobs took 2s. Any duration threshold separating those would fire on green
  // builds, so duration must not classify. `secret scan` (untouched by the
  // merge) still passes in ~8s, so the argument stands on current timings too.
  it("a 2-second failure with a genuine annotation is still a real failure", () => {
    const r = ci.classifyCheckRun(
      completed("secret scan", "failure", 2),
      ann("gitleaks: secret detected in src/config.ts"),
    );
    expect(r.verdict).toBe("FAIL");
    expect(r.seconds).toBe(2);
  });

  it("a 30-second failure with a refusal annotation is still a refusal", () => {
    const r = ci.classifyCheckRun(
      completed("typecheck, test, build, package, version", "failure", 30),
      ann(TOG489_ANNOTATION),
    );
    expect(r.verdict).toBe("DID_NOT_RUN");
    expect(r.seconds).toBe(30);
  });

  it("an 8-second PASS is never reclassified", () => {
    expect(ci.classifyCheckRun(completed("secret scan", "success", 8), null).verdict).toBe(
      "PASS",
    );
  });
});

describe("unreadable annotations resolve toward the loud answer", () => {
  it("null annotations mean a genuine failure, not an assumed refusal", () => {
    const r = ci.classifyCheckRun(completed("secret scan", "failure", 2), null);
    expect(r.verdict).toBe("FAIL");
    expect(r.note).toMatch(/could not be read/);
  });

  it("an empty annotation list is also a genuine failure", () => {
    expect(ci.classifyCheckRun(completed("secret scan", "failure"), []).verdict).toBe("FAIL");
  });
});

describe("check-run states", () => {
  it("in-flight checks are PENDING, not passes", () => {
    expect(ci.classifyCheckRun({ name: "x", status: "in_progress" }, null).verdict).toBe("PENDING");
    expect(ci.classifyCheckRun({ name: "x", status: "queued" }, null).verdict).toBe("PENDING");
  });

  it("skipped and neutral are neither pass nor fail", () => {
    expect(ci.classifyCheckRun(completed("x", "skipped"), null).verdict).toBe("SKIPPED");
    expect(ci.classifyCheckRun(completed("x", "neutral"), null).verdict).toBe("SKIPPED");
  });

  it("cancelled and timed_out are genuine failures absent a refusal annotation", () => {
    expect(ci.classifyCheckRun(completed("x", "cancelled"), []).verdict).toBe("FAIL");
    expect(ci.classifyCheckRun(completed("x", "timed_out"), []).verdict).toBe("FAIL");
  });
});

describe("verdict precedence", () => {
  const R = (verdict: Result["verdict"], name = "c"): Result =>
    ({ name, verdict, seconds: null, reason: "GitHub refused to start the job" }) as Result;

  it("a refusal dominates a genuine failure", () => {
    // Mixed state: if we reported RED here, someone would go debug a test
    // failure produced by a job that never ran.
    expect(ci.decideVerdict([R("FAIL"), R("DID_NOT_RUN")]).verdict).toBe("DID_NOT_RUN");
  });

  it("a refusal dominates passing checks", () => {
    expect(ci.decideVerdict([R("PASS"), R("PASS"), R("DID_NOT_RUN")]).verdict).toBe("DID_NOT_RUN");
  });

  it("genuine failures beat pending", () => {
    expect(ci.decideVerdict([R("FAIL"), R("PENDING")]).verdict).toBe("RED");
  });

  it("all passing is the only route to GREEN", () => {
    expect(ci.decideVerdict([R("PASS"), R("PASS")]).verdict).toBe("GREEN");
  });

  it("no checks at all is UNKNOWN, never GREEN", () => {
    expect(ci.decideVerdict([]).verdict).toBe("UNKNOWN");
  });

  it("a missing required check is UNKNOWN even when everything present passed", () => {
    expect(ci.decideVerdict([R("PASS")], ["secret scan"]).verdict).toBe("UNKNOWN");
  });

  it("a required check that was SKIPPED is UNKNOWN, not GREEN", () => {
    // Found by the exhaustive property test below, not by reasoning. A skipped
    // `secret scan` scanned nothing, but renders on a PR page as an absence
    // rather than as a problem — the same class of invisible gap as TOG-489.
    const results = [R("PASS", "typecheck, test, build, package, version"), R("SKIPPED", "secret scan")];
    expect(ci.decideVerdict(results).verdict).toBe("GREEN");
    const strict = ci.decideVerdict(results, ["typecheck, test, build, package, version", "secret scan"]);
    expect(strict.verdict).toBe("UNKNOWN");
    expect(strict.unsatisfied).toEqual(["secret scan"]);
  });

  it("a required check that is still PENDING is UNKNOWN", () => {
    expect(ci.decideVerdict([R("PENDING", "secret scan")], ["secret scan"]).verdict).toBe(
      "UNKNOWN",
    );
  });

  it("a still-running check is UNKNOWN, not GREEN", () => {
    expect(ci.decideVerdict([R("PASS"), R("PENDING")]).verdict).toBe("UNKNOWN");
  });

  it("only-skipped is UNKNOWN — nothing actually verified the commit", () => {
    expect(ci.decideVerdict([R("SKIPPED"), R("SKIPPED")]).verdict).toBe("UNKNOWN");
  });
});

describe("GREEN is unreachable unless every check passed", () => {
  // Exhaustive over every combination of two check states. This is the property
  // the merge rule in docs/PROCESS.md depends on, so it is asserted rather than
  // argued: exit 0 must imply "everything ran and passed".
  const STATES: Result["verdict"][] = ["PASS", "FAIL", "DID_NOT_RUN", "PENDING", "SKIPPED"];

  it("never reports GREEN when anything failed, was refused, or is running", () => {
    // The weak guarantee, which holds with no --require: GREEN tolerates a
    // SKIPPED check but nothing else. Anything stronger needs --require, which
    // is exactly why docs/PROCESS.md rule 1 names the two checks.
    for (const a of STATES) {
      for (const b of STATES) {
        const results = [
          { name: "a", verdict: a, seconds: null } as Result,
          { name: "b", verdict: b, seconds: null } as Result,
        ];
        const { verdict } = ci.decideVerdict(results);
        if (verdict === "GREEN") {
          expect([a, b].some((v) => v === "PASS")).toBe(true);
          for (const v of [a, b]) expect(["PASS", "SKIPPED"]).toContain(v);
        }
      }
    }
  });

  it("with every check named as required, GREEN implies all of them passed", () => {
    // The strong guarantee the merge gate relies on.
    for (const a of STATES) {
      for (const b of STATES) {
        const results = [
          { name: "a", verdict: a, seconds: null } as Result,
          { name: "b", verdict: b, seconds: null } as Result,
        ];
        const { verdict } = ci.decideVerdict(results, ["a", "b"]);
        if (verdict === "GREEN") expect([a, b]).toEqual(["PASS", "PASS"]);
      }
    }
  });

  it("exit codes keep the four states distinct", () => {
    expect(ci.EXIT).toMatchObject({ GREEN: 0, RED: 1, DID_NOT_RUN: 2, UNKNOWN: 3 });
    expect(new Set(Object.values(ci.EXIT)).size).toBe(4);
  });
});
