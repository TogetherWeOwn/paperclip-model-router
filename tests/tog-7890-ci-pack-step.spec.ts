import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * TOG-7890 (gap G20): the pack/load CI step keeps only hosted-runner truth.
 *
 * TOG-2941 hardened the step against persistent self-hosted runners —
 * run-unique unpack dirs (`installed-${run_id}-${run_attempt}`), a preamble
 * wipe, and an always-run cleanup step — because a path outside the workspace
 * survived into the next job on the same box. Since #70 every job in this
 * repository runs on GitHub-hosted `ubuntu-latest`, a fresh VM per job that is
 * discarded either way, so that machinery guards nothing and only obscures
 * the step. The simplification ships as an operator patch
 * (`docs/operator/tog-7890-*.patch`): agents cannot push `.github/workflows/`
 * (decision 0008), and for `pull_request` events GitHub runs the BASE
 * branch's workflow definition, so CI on the handoff PR itself still executes
 * the old step.
 *
 * That is why these tests never assert the simplification against the raw
 * tree. They evaluate the EFFECTIVE workflow — the tree plus this card's
 * pending patch when it has not been applied yet — so the suite is green in
 * all three states of the handoff: pending (this PR), applied (operator PR),
 * and cleaned up (patch deleted after landing). Two halves:
 *
 *   1. the verify-first precondition still holds on the raw tree (no workflow
 *      sends a job to a self-hosted runner — if one ever does again, per-run
 *      isolation becomes necessary and this suite must be revisited, not just
 *      re-run green), and
 *   2. the effective step carries no run-unique machinery and keeps every
 *      check (same pack/unpack/load assertions, explicit tarball name rather
 *      than a glob, both CI jobs intact).
 *
 * They read the workflow textually, the way `docs-install-version.spec.ts`
 * reads the docs: the deliverable is the file, so the file is the fixture.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflowsDir = join(root, ".github", "workflows");
const operatorDir = join(root, "docs", "operator");

const workflowFiles = readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f));
const workflowText = new Map(
  workflowFiles.map((f) => [f, readFileSync(join(workflowsDir, f), "utf8")]),
);
const rawCi = workflowText.get("ci.yml")!;

const git = (args: string[], cwd: string) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });

/** This card's handoff patch, if it is still queued. */
function pendingPatch(): string | null {
  const patches = existsSync(operatorDir)
    ? readdirSync(operatorDir).filter((f) => /^tog-7890-.*\.patch$/.test(f))
    : [];
  if (patches.length === 0) return null;
  expect(
    patches.length,
    `expected one TOG-7890 handoff patch, found ${patches.length}`,
  ).toBe(1);
  return join(operatorDir, patches[0]!);
}

/**
 * The workflow the runner will see once the handoff completes: the raw tree
 * with this card's patch applied when it is still pending, the raw tree
 * otherwise (already applied, or cleaned up after landing). Materialized in a
 * temp dir so the checkout is never touched.
 */
function effectiveCi(): string {
  const patch = pendingPatch();
  if (patch === null) return rawCi;
  let forwardApplies = true;
  try {
    git(["apply", "--check", patch], root);
  } catch {
    forwardApplies = false;
  }
  if (!forwardApplies) return rawCi; // already applied: the tree IS the state
  const stage = mkdtempSync(join(tmpdir(), "tog-7890-ci-"));
  mkdirSync(join(stage, ".github", "workflows"), { recursive: true });
  writeFileSync(join(stage, ".github", "workflows", "ci.yml"), rawCi);
  git(["apply", patch], stage);
  return readFileSync(join(stage, ".github", "workflows", "ci.yml"), "utf8");
}

const ci = effectiveCi();

describe("TOG-7890: no workflow sends jobs to persistent runners", () => {
  it("every workflow file exists where the guard looks for it", () => {
    // A green suite over zero files would prove nothing; fail loudly instead.
    expect(workflowFiles).toContain("ci.yml");
    expect(rawCi.length).toBeGreaterThan(0);
  });

  it.each(workflowFiles)("%s schedules no job onto a self-hosted runner", (file) => {
    // The precondition is the scheduling directive, not prose: a comment can
    // mention self-hosted runners without sending anything there, and only a
    // `runs-on` label puts a job on a persistent box where per-run isolation
    // would matter again.
    const scheduled = [...workflowText.get(file)!.matchAll(/^\s*runs-on:\s*(.+)$/gm)].map(
      (m) => m[1]!.trim(),
    );
    expect(scheduled.length, `${file} has no runs-on at all`).toBeGreaterThan(0);
    for (const label of scheduled) {
      expect(
        label,
        `${file} schedules a job onto ${label}, so the fixed unpack ` +
          `directory in ci.yml is no longer safe: restore per-run isolation ` +
          `before re-running this suite.`,
      ).not.toMatch(/self-hosted/);
    }
  });

  it.each(workflowFiles)("%s runs on a fresh hosted VM", (file) => {
    expect(workflowText.get(file)).toContain("ubuntu-latest");
  });
});

describe("TOG-7890: the effective pack/load step carries no run-unique machinery", () => {
  it("no run-id interpolation remains", () => {
    expect(ci).not.toContain("github.run_id");
    expect(ci).not.toContain("github.run_attempt");
  });

  it("the always-run cleanup step is gone", () => {
    expect(ci).not.toContain("Remove the unpacked artifact");
  });

  it("the unpack directory is a fixed path under RUNNER_TEMP", () => {
    // Outside the packed tree (so the scan and the tarball never see it),
    // stable within the run (so the load step finds it), and discarded with
    // the VM either way — which is why no wipe precedes it and no cleanup
    // follows it.
    expect(ci).toContain("INSTALL_DIR: ${{ runner.temp }}/installed");
    expect(ci).not.toContain("installed-${{");
    expect(ci).toContain('mkdir -p artifacts "$INSTALL_DIR"');
  });

  it("the handoff patch is queued or the tree already carries the change", () => {
    // Pending on this PR, applied-or-cleaned-up afterwards: either way the
    // effective step above is the simplified one. A second TOG-7890 patch
    // would mean the handoff split, which no operator runbook covers.
    const patch = pendingPatch();
    if (patch !== null) {
      git(["apply", "--check", patch], root); // throws when rotted
    }
  });

  it("no persistent-runner guard language survives in the effective workflow", () => {
    // The simplification rewrites the header and removes the TOG-2941 block.
    // The header may still name self-hosted runner groups as the REASON every
    // job is hosted-only — that is the scheduling fact — but the effective
    // ci.yml must not describe a persistent-runner threat model anymore,
    // otherwise the next reader re-derives the wrong guard.
    expect(ci).not.toContain("TOG-2941");
    expect(ci).not.toMatch(/run-unique/i);
    expect(ci).not.toMatch(/persistent runners keep/i);
  });

  it("the rotted TOG-2941 operator patch is deleted", () => {
    // Its change has been in the tree since #58; what was left in
    // docs/operator/ described a self-hosted world that no longer exists and
    // read as still-queued to the workflow guard.
    expect(
      existsSync(join(operatorDir, "TOG-2941-pack-step-run-unique.patch")),
      "docs/operator/TOG-2941-pack-step-run-unique.patch still exists",
    ).toBe(false);
  });
});

describe("TOG-7890: every check survived the simplification", () => {
  it("the pack/unpack/load step still asserts the same artifact", () => {
    expect(ci).toContain("Pack, unpack, install runtime deps, load");
    // The tarball is named explicitly, never globbed: the artifact loaded is
    // always the one this run just packed.
    expect(ci).toContain('test -f "artifacts/$tarball"');
    expect(ci).toContain('tar -xzf "artifacts/$tarball"');
    expect(ci).not.toContain("artifacts/*.tgz");
    expect(ci).toContain("packed worker has no setup handler");
    expect(ci).toContain("Assert the runtime entrypoints exist");
  });

  it("both CI jobs and their steps are intact", () => {
    expect(ci).toContain("typecheck, test, build, package, version");
    expect(ci).toContain("secret scan");
    for (const step of [
      "npm run typecheck",
      "npm run test",
      "npm run build",
      "npm run verify:host",
      "gitleaks dir .",
      "gitleaks git .",
    ]) {
      expect(ci, `ci.yml lost the \`${step}\` step`).toContain(step);
    }
  });

  it("check:ci still requires both checks by name", () => {
    // The card's acceptance criterion "npm run check:ci still classifies
    // correctly" rests on the two required names reaching the classifier;
    // the classifier itself is pinned by tests/ci-health.spec.ts.
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["check:ci"]).toContain("typecheck, test, build, package, version");
    expect(pkg.scripts["check:ci"]).toContain("secret scan");
  });
});
