/**
 * The vendored omniroute-broker carries its own 78-case suite, written against
 * `node:test` rather than vitest. Adding it to `npm run verify` is not enough to
 * make CI run it: the CI job invokes `typecheck`, `test`, `build` and
 * `verify:host` as separate steps and never calls `npm run verify` — only the
 * release workflow does. So a broker regression would reach `main` unseen.
 *
 * This spec closes that by running the broker's suite as a child process from
 * inside the vitest run that CI does invoke. It is a bridge, not a reimplementation:
 * the broker suite stays the single definition of broker correctness, and this file
 * only asserts that it passed.
 *
 * Workflow files cannot be changed by an agent (the App token has no `workflows`
 * permission), so wiring this through the existing `test` script is also the only
 * route available that does not need an operator.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BROKER = resolve(REPO, "plugins", "omniroute-broker");
const SUITE = resolve(BROKER, "test", "broker.test.mjs");

describe("the vendored omniroute-broker suite", () => {
  it("is actually present — vendoring it is what makes CI able to see it", () => {
    // If the broker directory ever disappears (or its dist/ falls back under the
    // repo's blanket `dist/` ignore rule, which already happened once), this fails
    // loudly instead of the suite below quietly testing nothing.
    expect(existsSync(SUITE), `no broker suite at ${SUITE}`).toBe(true);
    expect(
      existsSync(resolve(BROKER, "dist", "verbs.js")),
      "the broker's dist/ is missing — check .gitignore for a rule matching it",
    ).toBe(true);
  });

  it("passes all of its own cases", () => {
    // Throws on a non-zero exit, and vitest surfaces the captured output.
    const out = execFileSync("node", ["--test", SUITE], {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    // `node --test` exits 0 when it runs zero tests, so asserting the exit code
    // alone would pass on an empty suite. Require a positive, non-zero pass count.
    //
    // Two reporters are possible and they do not share a summary format: the spec
    // reporter (the default on a TTY-less run here) emits "ℹ pass 78", while TAP
    // emits "# pass 78". Match either, so a reporter change cannot turn this
    // assertion into an unparseable no-op.
    const count = (label: string) =>
      Number(new RegExp(String.raw`^(?:#|ℹ)\s*${label}\s+(\d+)\s*$`, "m").exec(out)?.[1] ?? NaN);
    const passed = count("pass");
    const failed = count("fail");

    expect(Number.isNaN(passed), `could not parse a pass count from:\n${out}`).toBe(false);
    expect(failed).toBe(0);
    expect(passed).toBeGreaterThan(0);
  });
});
