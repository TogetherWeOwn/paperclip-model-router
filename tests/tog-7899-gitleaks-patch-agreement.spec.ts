/**
 * G20 (TOG-7846 rev 2, card [TOG-7899](/TOG/issues/TOG-7899)): the gitleaks
 * install hardening + scanner self-test wiring live in
 * `docs/operator/tog-488-ci-secret-scan.patch`, which no agent can push
 * ([ADR 0008](../docs/decisions/0008-workflow-files-are-operator-applied.md)).
 * Until a human applies it, the live `secret-scan` job still installs gitleaks
 * with an unverified `curl | tar` pipe and never runs
 * `scripts/gitleaks-selftest.sh` — and `npm run check:workflows` stays red by
 * design while the patch is pending, so it cannot be part of `npm run verify`.
 *
 * This spec is the part that CAN run on every commit: it pins the agreement
 * between the patch and the tree, in whichever lifecycle state they are in:
 *   - patch present, not yet applied ("pending"): the patch must apply
 *     cleanly, target the same gitleaks version the live workflow pins, carry
 *     a well-formed digest pin, and wire the self-test script — which must
 *     exist, be tracked, and stay executable;
 *   - patch present and already applied: the live workflow must carry the
 *     hardening itself, with the same digest the patch pinned;
 *   - patch deleted (the operator runbook deletes it after applying): the
 *     live workflow must carry the hardening, otherwise the deletion lost
 *     the change.
 * Any other state — patch rotted against a moved workflow, digest malformed,
 * script missing, `.gitleaks.toml` drifted from the config the self-test
 * probes — fails. Each test names the repair.
 */

import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const PATCH_REL = "docs/operator/tog-488-ci-secret-scan.patch";
const PATCH = join(repo, PATCH_REL);
const CI_REL = ".github/workflows/ci.yml";
const CI = join(repo, CI_REL);
const TOML_REL = ".gitleaks.toml";
const TOML = join(repo, TOML_REL);
const SELFTEST_REL = "scripts/gitleaks-selftest.sh";
const SELFTEST = join(repo, SELFTEST_REL);

const VERSION_RE = /GITLEAKS_VERSION:\s*"?([0-9][^"\s]*)"?/;
const DIGEST_RE = /GITLEAKS_SHA256:\s*"?([0-9a-fA-F]{64})"?/;
const HEX64_RE = /^[0-9a-f]{64}$/i;

// Every marker must be present in the authoritative text: the patch's
// effective content while pending, the live workflow once applied.
const HARDENING_MARKERS = [
  "GITLEAKS_SHA256",
  "--retry", // staged download with retries, not curl|tar
  SELFTEST_REL, // the scanner self-test actually wired in
  "DOWNLOAD failure", // a failed download says it is not a finding
  "unverified scanner", // a digest mismatch refuses to run
];

function gitApplyCheck(extra: string[]): boolean {
  try {
    execFileSync("git", ["apply", ...extra, "--check", PATCH], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/** Content the patch produces: added lines with `+` stripped, context as-is. */
function patchEffectiveText(patch: string): string {
  return patch
    .split("\n")
    .filter((l) => !/^(\+\+\+|---|diff |index |@@)/.test(l))
    .filter((l) => !l.startsWith("-"))
    .map((l) => (l.startsWith("+") ? l.slice(1) : l))
    .join("\n");
}

function patchTouchedFiles(): string[] {
  const out = execFileSync("git", ["apply", "--numstat", PATCH], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const parts = l.split(/\s+/);
      return parts[parts.length - 1] ?? "";
    })
    .filter(Boolean);
}

function isHex64(value: string | undefined): value is string {
  return typeof value === "string" && HEX64_RE.test(value);
}

// Lifecycle state, resolved once at collection time. Read-only git probes:
// safe under concurrently running agents.
const patchPresent = existsSync(PATCH);
const forwardApplies = patchPresent && gitApplyCheck([]);
const reverseApplies = patchPresent && gitApplyCheck(["--reverse"]);
const pending = patchPresent && forwardApplies;

describe("gitleaks operator-patch agreement (TOG-7899/G20)", () => {
  it("lifecycle is coherent: pending-and-fresh, applied, or applied-and-cleaned-up", () => {
    expect(
      !patchPresent || forwardApplies || reverseApplies,
      `${PATCH_REL} neither applies cleanly nor is already applied — the ` +
        `workflow moved underneath it. Regenerate the patch against the ` +
        `current tree (docs/PROCESS.md rule 6); do not hand the operator ` +
        `a conflict to resolve in a file the authors cannot push.`,
    ).toBe(true);
  });

  if (pending) {
    it("pending: patch scope is the secret-scan job only", () => {
      expect(patchTouchedFiles()).toEqual([CI_REL]);
    });

    it("pending: patch targets the gitleaks version the live workflow pins", () => {
      const live = readFileSync(CI, "utf8").match(VERSION_RE)?.[1];
      const patched = patchEffectiveText(readFileSync(PATCH, "utf8")).match(VERSION_RE)?.[1];
      expect(patched, "patch must name a GITLEAKS_VERSION").toBeDefined();
      expect(live, "live workflow must pin GITLEAKS_VERSION").toBeDefined();
      expect(
        patched === live,
        `patch targets gitleaks ${patched} but live ${CI_REL} pins ${live}: ` +
          `one of them moved. Reconcile before the operator applies a stale version.`,
      ).toBe(true);
    });

    it("pending: patch carries the full hardening with a well-formed digest pin", () => {
      const text = patchEffectiveText(readFileSync(PATCH, "utf8"));
      for (const marker of HARDENING_MARKERS) {
        expect(text.includes(marker), `patch must carry: ${marker}`).toBe(true);
      }
      const digest = text.match(DIGEST_RE)?.[1];
      expect(
        isHex64(digest),
        "GITLEAKS_SHA256 must be a full 64-hex pin, not a placeholder — " +
          "CI would pipe an unverified binary into the job whose purpose " +
          "is being trustworthy about credentials.",
      ).toBe(true);
    });
  }

  if (!forwardApplies) {
    // Applied (patch present + reverse applies) or cleaned up (patch gone):
    // the live workflow is the authoritative text now.
    it("applied: live workflow carries the full hardening", () => {
      expect(existsSync(CI), `${CI_REL} must exist`).toBe(true);
      const text = readFileSync(CI, "utf8");
      for (const marker of HARDENING_MARKERS) {
        expect(text.includes(marker), `live ${CI_REL} must carry: ${marker}`).toBe(true);
      }
      expect(
        isHex64(text.match(DIGEST_RE)?.[1]),
        `live ${CI_REL} must pin GITLEAKS_SHA256 as full 64-hex.`,
      ).toBe(true);
    });

    if (patchPresent) {
      it("applied: patch digest and live digest agree", () => {
        const fromPatch = patchEffectiveText(readFileSync(PATCH, "utf8")).match(DIGEST_RE)?.[1];
        const live = readFileSync(CI, "utf8").match(DIGEST_RE)?.[1];
        expect(isHex64(fromPatch), "patch must pin a well-formed digest").toBe(true);
        expect(
          live === fromPatch,
          `live digest ${live} != patch digest ${fromPatch}: the applied ` +
            `workflow drifted from the reviewed patch.`,
        ).toBe(true);
      });
    }
  }

  it("the self-test script the patch wires in is tracked and executable", () => {
    const tracked = execFileSync("git", ["ls-files", "--", SELFTEST_REL], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    expect(
      tracked === SELFTEST_REL,
      `${SELFTEST_REL} must be a tracked file — the patch wires it into CI, ` +
        `and an operator could apply the patch cleanly onto a tree where ` +
        `the command does not exist.`,
    ).toBe(true);
    let executable = false;
    try {
      accessSync(SELFTEST, constants.X_OK);
      executable = true;
    } catch {
      executable = false;
    }
    expect(
      executable,
      `${SELFTEST_REL} must stay executable (CI runs it as ${SELFTEST_REL}).`,
    ).toBe(true);
  });

  it(".gitleaks.toml already agrees with the patch: no change needed there", () => {
    const toml = readFileSync(TOML, "utf8");
    expect(toml.includes("useDefault = true"), `${TOML_REL} must extend the default ruleset`).toBe(true);
    expect(
      toml.includes("3f2504e0-4f89-41d3-9a0c-0305e82c3301"),
      `${TOML_REL} must keep the anchored fixture-UUID allowlist entry the self-test probes.`,
    ).toBe(true);
    expect(
      toml.includes("[[rules]]"),
      "custom rules were deleted in PR #29 — none may return unreviewed.",
    ).toBe(false);
  });
});
