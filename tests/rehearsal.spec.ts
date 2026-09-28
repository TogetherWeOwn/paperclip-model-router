/**
 * The acceptance rehearsal, run as part of the test suite.
 *
 * `scripts/acceptance-rehearsal.mjs` is a standalone script because its primary
 * job is to print a transcript an operator compares against the live install.
 * But it is also the executable form of this plugin's acceptance criterion —
 * one install, three companies (two sync, one async), no code edits — so it
 * must not be possible to break it without a red build. Running it here means
 * the existing `npm test` step covers it, with no separate CI wiring to keep
 * in sync.
 *
 * It loads `dist/`, which `npm test` does not otherwise produce, so build
 * first. esbuild takes milliseconds; this is cheaper than the alternative of
 * finding out at install time.
 */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(script: string): string {
  return execFileSync(process.execPath, [script], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("acceptance rehearsal", () => {
  it("passes every evidence item against the built worker", () => {
    run("esbuild.config.mjs");

    let output: string;
    try {
      output = run("scripts/acceptance-rehearsal.mjs");
    } catch (error) {
      // Surface the transcript rather than a bare non-zero exit code — the
      // failing check is the whole point of the diagnostic.
      const failed = error as { stdout?: string; stderr?: string };
      throw new Error(`rehearsal failed:\n${failed.stdout ?? ""}${failed.stderr ?? ""}`);
    }

    expect(output).toContain("REHEARSAL PASSED");
    expect(output).not.toContain("\n  FAIL  ");
    // The transcript is the deliverable the operator diffs against the live
    // install. A run that exits 0 but never exercised the async path would
    // still print REHEARSAL PASSED — each evidence header below is the pin
    // that keeps a silently-dropped section from passing green.
    expect(output).toContain("EVIDENCE 8");
    // The exact check count is brittle (it moves with every new check); the
    // stable pins are the section exercising the async contract end to end.
    expect(output).toContain("async poll reaches completed through the company upstream");
    expect(output).toContain("the reaped invocation polls as non-retryable invocation-cancelled");
    expect(output).toContain("async made exactly one upstream call per submit");
  }, 60_000);
});
