import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * TOG-2993 follow-on: `package.json` `files` listed
 * `docs/operator/TOG-2922-v0.4.3-pace-ordering.md` after that runbook had been
 * renamed for v0.4.4. npm does not error on a `files` entry that matches
 * nothing -- it just ships one file fewer. The v0.4.4 tarball therefore
 * contained NO operator runbook at all, and nothing caught it: the release was
 * reviewed, re-hashed and reproduced byte-for-byte, because the hashes were
 * consistent with a package that was quietly missing a file.
 *
 * Every entry here is a literal path (no globs), so existence is the whole
 * check. If a future entry needs a glob, match it instead of asserting the
 * literal.
 */
const ROOT = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  version: string;
  files: string[];
};

describe("TOG-2993: every packaged path exists", () => {
  it.each(pkg.files)("ships %s", (entry) => {
    expect(entry).not.toMatch(/[*?[\]]/);
    expect(existsSync(path.join(ROOT, entry)), `${entry} is listed in package.json files but does not exist`).toBe(true);
  });

  it("ships the operator runbook for the pace-ordering release", () => {
    // The install commands the operator actually runs must travel with the
    // package; that is the whole point of listing them in `files`.
    const runbook = pkg.files.find((entry) => entry.endsWith("TOG-2922-pace-ordering.md"));
    expect(runbook, "the TOG-2922 runbook is not in package.json files").toBeDefined();
    const body = readFileSync(path.join(ROOT, runbook!), "utf8");
    // This runbook documents one specific historical migration (its bundle
    // paths, e.g. `tog-2922-model-router-v0.4.5`, are that release's
    // artifacts) -- it is not rewritten on every later version bump, so it
    // is pinned to the version it actually shipped with, not `pkg.version`.
    expect(body, "the runbook does not mention the v0.4.5 release it documents").toContain("0.4.5");
    // It must invoke the gate, not a keys-only assertion.
    expect(body).toContain("tog-2922-prerequisite-refresh-gate.mjs");
  });

  it("ships every script the runbook tells the operator to run", () => {
    const runbook = readFileSync(path.join(ROOT, "docs/operator/TOG-2922-pace-ordering.md"), "utf8");
    const referenced = [...runbook.matchAll(/\$NEW_DIR\/(scripts\/[\w.-]+)/g)].map((match) => match[1]!);
    expect(referenced.length).toBeGreaterThan(0);
    for (const script of new Set(referenced)) {
      expect(pkg.files, `${script} is run by the runbook but not packaged`).toContain(script);
    }
  });

  it("ships the operator runbook for async invoke (TOG-3419), matching the current version", () => {
    const runbook = pkg.files.find((entry) => entry.endsWith("TOG-3419-async-invoke.md"));
    expect(runbook, "the TOG-3419 runbook is not in package.json files").toBeDefined();
    const body = readFileSync(path.join(ROOT, runbook!), "utf8");
    expect(body, `the runbook does not mention version ${pkg.version}`).toContain(pkg.version);
    expect(body).toContain("invoke-async");
    expect(body).toContain("maxSyncOutputTokens");
  });
});
