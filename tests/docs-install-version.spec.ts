/**
 * The documented install path is the deliverable, not a comment about it.
 *
 * The README and docs/OPERATIONS.md tell an operator to download and unpack a
 * specific tagged release. Those commands are copy-pasted verbatim onto a live
 * instance, so a stale version there is not a typo — it silently installs an
 * older build. That happened: the docs pinned `v0.1.1` through five releases,
 * and `v0.1.1` predates the gate fixes (TOG-228) and both halves of the Claude
 * block fix (TOG-237). An operator following the README to the letter would
 * have installed a build whose routing rules the installee's own config row can
 * edit out of the way.
 *
 * A release bumps `package.json` in the same commit that gets tagged, so
 * pinning the docs to that version makes the next bump fail here until the
 * commands are updated with it. The alternative — remembering — is what failed.
 *
 * Scope is deliberately narrow: only *executable install commands* are checked.
 * Prose that names an old version on purpose ("through `v0.1.1` it was ...",
 * the rollback floor) is history and must stay put, so it is not matched.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

const version = (
  JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string }
).version;

/** Files whose fenced commands an operator is expected to run as written. */
const DOCS = ["README.md", "docs/OPERATIONS.md"];

/**
 * Each pattern captures the version out of one shape of install command. They
 * are anchored on the command, not on a bare `vX.Y.Z`, so surrounding prose is
 * left alone.
 */
const COMMANDS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "gh release download", pattern: /gh release download\s+v(\d+\.\d+\.\d+)/g },
  {
    label: "tarball filename",
    pattern: /togetherweown-paperclip-model-router-(\d+\.\d+\.\d+)\.tgz/g,
  },
  {
    label: "plugin install --version",
    pattern: /paperclip-model-router\s+--version\s+(\d+\.\d+\.\d+)/g,
  },
];

describe("documented install commands", () => {
  for (const doc of DOCS) {
    const source = readFileSync(join(repo, doc), "utf8");

    for (const { label, pattern } of COMMANDS) {
      it(`${doc}: every \`${label}\` names the current version`, () => {
        const found = [...source.matchAll(new RegExp(pattern))].map((m) => m[1]);
        for (const named of found) {
          expect(
            named,
            `${doc} tells an operator to install ${named}, but this repo is ${version}. ` +
              `Update the install commands in the same commit as the version bump.`,
          ).toBe(version);
        }
      });
    }
  }

  it("does not document an install command before release authorization", () => {
    const readme = readFileSync(join(repo, "README.md"), "utf8");
    const operations = readFileSync(join(repo, "docs/OPERATIONS.md"), "utf8");
    expect(readme).not.toMatch(/gh release download|paperclipai plugin install/);
    expect(operations).not.toMatch(/gh release download|paperclipai plugin install/);
  });

  it("keeps executable install commands pinned if a future authorization adds them", () => {
    for (const doc of DOCS) {
      const source = readFileSync(join(repo, doc), "utf8");
      for (const { pattern } of COMMANDS) {
        for (const match of source.matchAll(new RegExp(pattern))) expect(match[1]).toBe(version);
      }
    }
  });

  it("states the current no-install boundary", () => {
    expect(readFileSync(join(repo, "docs/OPERATIONS.md"), "utf8")).toContain("not authorized for a public release or live installation");
  });
});

// Retain `version` as a checked input even while no command is authorized.
describe("package version", () => {
  it("is a semantic version", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
