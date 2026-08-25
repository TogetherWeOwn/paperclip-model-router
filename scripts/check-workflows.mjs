#!/usr/bin/env node
/**
 * Guard the one part of this repository no agent can push: `.github/workflows/`.
 *
 * The GitHub App this company's agents authenticate as cannot write workflow
 * files, and the token broker refuses to mint the permission at all. That is a
 * deliberate boundary — see `docs/decisions/0008` — so workflow changes are
 * handed to an operator as a patch under `docs/operator/` and applied by a
 * human.
 *
 * A handoff nobody checks is a handoff that silently does not happen, and this
 * repository has already paid for that twice:
 *
 *   TOG-227  `scripts/gitleaks-selftest.sh` shipped with a header saying it was
 *            "run in the same CI job as the scan". It never was — the wiring
 *            was a workflow edit and the push was rejected. The script sat in
 *            `scripts/` asserting nothing, and the `secret scan` job stayed
 *            green, which is exactly what it looks like when the scanner works.
 *   TOG-488  the install hardening below sat written-and-tested in an issue
 *            description, where no build could ever read it.
 *
 * Both are mechanical comparisons, so they belong in a script rather than in a
 * run that re-improvises them. The gates:
 *
 *   1  every `docs/operator/*.patch` either applies cleanly to the working tree
 *      or is already applied. A patch that does neither has rotted against a
 *      workflow that moved underneath it, and the operator will discover that
 *      at the worst moment.
 *   2  every pinned scanner digest agrees with the publisher's own checksums
 *      file. A pin that no longer matches upstream is either a re-tagged
 *      release or a stale bump, and both should stop a human, not a runner.
 *   3  every script in `scripts/` is reachable from something that runs it —
 *      `package.json`, a workflow, or another script. A script reachable ONLY
 *      through an unapplied operator patch FAILS: it is queued, not running,
 *      and the whole point of this file is to refuse to call that done.
 *
 * Gate 3 is the one that would have caught TOG-227. It is why this script
 * exists rather than a line in a runbook.
 *
 * Read-only: it never writes, applies, or fetches anything into the tree.
 * Deliberately NOT part of `npm run verify` — it is red for as long as a patch
 * is pending, which is a true statement about the repository but not a reason
 * to block every commit. Run it before and after an operator handoff.
 *
 * Usage:
 *   node scripts/check-workflows.mjs            # all gates
 *   node scripts/check-workflows.mjs --offline  # gate 2 -> SKIP, no network
 *
 * Exits non-zero if any gate fails.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OFFLINE = process.argv.includes("--offline");

/**
 * Scripts that are deliberately not reachable from an automated entrypoint,
 * with the reason. Being on this list is a decision, not an oversight — that is
 * the entire difference between this and the TOG-227 failure, so each entry
 * must say why a machine cannot run it.
 */
const MANUAL_SCRIPTS = {
  "claude-lane-preflight.sh":
    "needs a live OMNIROUTE_API_KEY; it probes a third-party proxy, so it " +
    "cannot run unattended in CI. Documented in README.md.",
  "phase5-evidence.mjs":
    "TOG-157 evidence run. It exits non-zero BY DESIGN while the OmniRoute " +
    "substrate is undeployed — wiring it into CI would pin CI red and teach " +
    "everyone to ignore a red build. Run it at the phase gate.",
  "phase5-cost-baseline.mjs":
    "TOG-157 cost baseline. Reads live instrumentation from a host path " +
    "(/paperclip/operator-handoff/quota-pacing.jsonl) that does not exist on a " +
    "runner; it reports numbers rather than asserting a property.",
};

/**
 * Tools whose binaries CI downloads and pins by digest. One entry per tool.
 * `checksums` receives the pinned version and returns the publisher's checksums
 * URL; `assetLine` picks this tool's line out of that file.
 */
const PINNED_TOOLS = [
  {
    name: "gitleaks",
    versionKey: "GITLEAKS_VERSION",
    digestKey: "GITLEAKS_SHA256",
    checksums: (v) =>
      `https://github.com/gitleaks/gitleaks/releases/download/v${v}/gitleaks_${v}_checksums.txt`,
    assetLine: (v) => `gitleaks_${v}_linux_x64.tar.gz`,
  },
];

let failures = 0;
let pending = 0;

const pass = (label, note = "") =>
  console.log(`PASS  ${label.padEnd(58)} ${note}`);
const skip = (label, note = "") =>
  console.log(`SKIP  ${label.padEnd(58)} ${note}`);
const fail = (label, ...lines) => {
  failures += 1;
  console.log(`FAIL  ${label}`);
  for (const l of lines) console.log(`      ${l}`);
};

const git = (args) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: "pipe" });

/** True if `git apply` accepts these flags for this patch. */
function gitApplyOk(flags, patchPath) {
  try {
    git(["apply", ...flags, "--check", patchPath]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Strip a unified diff down to the content it produces: added lines with their
 * leading `+` removed, context lines as-is. Lets one regex read both a workflow
 * and a patch that has not landed yet.
 */
function effectiveText(raw, isPatch) {
  if (!isPatch) return raw;
  return raw
    .split("\n")
    .filter((l) => !/^(\+\+\+|---|diff |index |@@)/.test(l))
    .filter((l) => !l.startsWith("-"))
    .map((l) => (l.startsWith("+") ? l.slice(1) : l))
    .join("\n");
}

const operatorDir = join(ROOT, "docs", "operator");
const patchFiles = existsSync(operatorDir)
  ? readdirSync(operatorDir)
      .filter((f) => f.endsWith(".patch"))
      .map((f) => join(operatorDir, f))
  : [];

console.log("=".repeat(72));
console.log("WORKFLOW GUARD — operator-applied changes under .github/workflows/");
console.log("=".repeat(72));

// ---------------------------------------------------------------------------
// Gate 1: pending operator patches still describe a change that can be made.
// ---------------------------------------------------------------------------
console.log("\n-- gate 1: operator patches apply");

/** patch path -> "applied" | "pending" */
const patchState = new Map();

if (patchFiles.length === 0) {
  skip("no patches in docs/operator/", "nothing queued for an operator");
}

for (const p of patchFiles) {
  const rel = `docs/operator/${basename(p)}`;
  const appliesForward = gitApplyOk([], p);
  const alreadyApplied = gitApplyOk(["--reverse"], p);

  if (alreadyApplied) {
    patchState.set(p, "applied");
    pass(rel, "already applied");
  } else if (appliesForward) {
    patchState.set(p, "pending");
    pending += 1;
    fail(
      rel,
      "applies cleanly, but is still PENDING an operator.",
      "The repository still runs the old workflow. Apply the patch through the",
      "operator runbook before treating the queued CI behavior as real.",
    );
  } else {
    patchState.set(p, "rotted");
    fail(
      rel,
      "does not apply, and is not already applied.",
      "The workflow moved underneath this patch. Regenerate it against the",
      "current tree before handing it to an operator — do not ask them to",
      "resolve a conflict in a file the rest of us cannot push.",
    );
  }
}

// ---------------------------------------------------------------------------
// Gate 2: pinned digests still match what the publisher publishes.
// ---------------------------------------------------------------------------
console.log("\n-- gate 2: pinned tool digests match the publisher");

const workflowDir = join(ROOT, ".github", "workflows");
const sources = [];
if (existsSync(workflowDir)) {
  for (const f of readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f))) {
    const p = join(workflowDir, f);
    sources.push({
      label: `.github/workflows/${f}`,
      text: effectiveText(readFileSync(p, "utf8"), false),
    });
  }
}
for (const p of patchFiles) {
  if (patchState.get(p) !== "pending") continue; // applied patches are already in the workflow
  sources.push({
    label: `docs/operator/${basename(p)} (pending)`,
    text: effectiveText(readFileSync(p, "utf8"), true),
  });
}

let pinsChecked = 0;

for (const tool of PINNED_TOOLS) {
  for (const src of sources) {
    const version = src.text.match(
      new RegExp(`${tool.versionKey}:\\s*"?([0-9][^"\\s]*)"?`),
    )?.[1];
    const digest = src.text.match(
      new RegExp(`${tool.digestKey}:\\s*"?([0-9a-f]{64})"?`),
    )?.[1];

    if (!version) continue;

    const label = `${tool.name} ${version} in ${src.label}`;
    pinsChecked += 1;

    if (!digest) {
      fail(
        label,
        `${tool.versionKey} is pinned but ${tool.digestKey} is not.`,
        "CI would pipe an unverified binary from the network into the job",
        "whose entire purpose is being trustworthy about credentials.",
      );
      continue;
    }

    if (OFFLINE) {
      skip(label, "--offline: publisher checksums not fetched");
      continue;
    }

    let published;
    try {
      const res = await fetch(tool.checksums(version), {
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      const want = tool.assetLine(version);
      published = body
        .split("\n")
        .find((l) => l.includes(want))
        ?.trim()
        .split(/\s+/)[0];
      if (!published) throw new Error(`no line for ${want}`);
    } catch (err) {
      fail(
        label,
        `could not read the publisher's checksums: ${err.message}`,
        "A pin that cannot be checked is exactly the failure this gate exists",
        "to catch. Use --offline only when you know you are offline.",
      );
      continue;
    }

    if (published === digest) {
      pass(label, `sha256 ${digest.slice(0, 12)}…`);
    } else {
      fail(
        label,
        `pinned   ${digest}`,
        `published ${published}`,
        "Either the release was re-tagged or the version was bumped without",
        "the digest. Do NOT re-pin reflexively — find out which it was.",
      );
    }
  }
}

if (pinsChecked === 0) skip("no pinned tools found", "");

// ---------------------------------------------------------------------------
// Gate 3: every script is reachable from something that actually runs it.
// ---------------------------------------------------------------------------
console.log("\n-- gate 3: no script asserts nothing");

const scriptsDir = join(ROOT, "scripts");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const pkgScripts = Object.values(pkg.scripts ?? {}).join("\n");

const workflowText = sources
  .filter((s) => s.label.startsWith(".github/"))
  .map((s) => s.text)
  .join("\n");

const pendingPatchText = sources
  .filter((s) => s.label.includes("(pending)"))
  .map((s) => s.text)
  .join("\n");

const referencedScriptPaths = new Set(
  [...pendingPatchText.matchAll(/(?:^|[\s'"`])scripts\/([A-Za-z0-9._/-]+)/gm)].map(
    (match) => match[1].replace(/[),;:]+$/, ""),
  ),
);

/**
 * Grade what git tracks, not what happens to be sitting in the directory.
 *
 * This checkout is shared between concurrently running agents, so `scripts/`
 * routinely contains another run's work in progress. Grading those made this
 * gate's exit code a function of who else was working at the time: TOG-489's
 * uncommitted `ci-health.mjs` turned this gate red on a branch that had never
 * heard of it. A gate whose result depends on a neighbour's scratch file is
 * not a gate, and "re-run and see" is the exact habit this issue exists to
 * stamp out.
 *
 * Untracked scripts are still listed, as a NOTE rather than a verdict. They
 * are graded the moment they are committed, which is the moment they become
 * part of the repository and therefore someone's claim that they run.
 */
const allScriptFiles = readdirSync(scriptsDir).filter((f) =>
  statSync(join(scriptsDir, f)).isFile(),
);

let trackedScripts;
try {
  trackedScripts = new Set(
    git(["ls-files", "--", "scripts/"])
      .split("\n")
      .filter(Boolean)
      .map((p) => p.replace(/^scripts\//, ""))
      .filter((p) => !p.includes("/")),
  );
} catch {
  trackedScripts = new Set();
}

// A gate that grades nothing reports a clean sweep. If the listing came back
// empty while scripts/ plainly has files in it, the listing is broken — say so
// and exit, rather than printing a gate 3 with no rows and an exit code of 0.
if (allScriptFiles.length > 0 && trackedScripts.size === 0) {
  fail(
    "gate 3 harness",
    "`git ls-files -- scripts/` returned nothing while scripts/ is not empty.",
    "Refusing to report on zero scripts: an empty gate looks identical to a",
    "passing one. Is this a git checkout?",
  );
  process.exit(2);
}

const scriptFiles = allScriptFiles.filter((f) => trackedScripts.has(f));
const untrackedScripts = allScriptFiles.filter((f) => !trackedScripts.has(f));

for (const f of [...referencedScriptPaths].sort()) {
  if (!trackedScripts.has(f)) {
    fail(
      `scripts/${f}`,
      "is referenced by a pending workflow patch but is not a tracked file.",
      "An operator could apply the patch cleanly and still get a CI job that",
      "fails because its command does not exist. Restore or replace the script",
      "before handing the patch over.",
    );
  }
}

/**
 * Strip comments, so a script that merely *mentions* another one does not count
 * as running it.
 *
 * This is not a nicety. The first draft credited any textual mention, and this
 * file is full of them — the TOG-227 story above names `gitleaks-selftest.sh`,
 * and `MANUAL_SCRIPTS` names `claude-lane-preflight.sh` as a key. Both were
 * therefore reported "reachable" by the very gate written to catch them, and
 * `acceptance-rehearsal.mjs` credited a third from a comment reading "confirm
 * with … first". A guard whose blind spot is congruent with the bug is worse
 * than no guard, because it reports PASS.
 */
function stripComments(text, file) {
  if (file.endsWith(".sh")) {
    return text
      .split("\n")
      .map((l) => l.replace(/(^|\s)#.*$/, "$1"))
      .join("\n");
  }
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

// A script invoked by another script counts as reachable, but only if that
// caller is itself reachable. Resolve by iterating to a fixed point.
//
// This file is excluded as a caller outright: it names every script in the
// directory as reporting data, so crediting it would make the whole gate
// vacuous no matter how well comments are stripped.
const SELF = basename(fileURLToPath(import.meta.url));
const bodies = new Map(
  scriptFiles.map((f) => [
    f,
    f === SELF ? "" : stripComments(readFileSync(join(scriptsDir, f), "utf8"), f),
  ]),
);

const reachable = new Set(
  scriptFiles.filter(
    (f) => pkgScripts.includes(f) || workflowText.includes(f),
  ),
);

for (let changed = true; changed; ) {
  changed = false;
  for (const f of scriptFiles) {
    if (reachable.has(f)) continue;
    for (const caller of reachable) {
      // Ignore the script's own usage comments by only crediting other files.
      if (caller !== f && bodies.get(caller)?.includes(f)) {
        reachable.add(f);
        changed = true;
        break;
      }
    }
  }
}

for (const f of scriptFiles.sort()) {
  if (reachable.has(f)) {
    pass(`scripts/${f}`, "reachable");
  } else if (MANUAL_SCRIPTS[f]) {
    skip(`scripts/${f}`, "manual by decision");
    console.log(`      ${MANUAL_SCRIPTS[f]}`);
  } else if (pendingPatchText.includes(f)) {
    pending += 1;
    fail(
      `scripts/${f}`,
      "is wired ONLY in an operator patch that has not been applied.",
      "Until a human applies that patch it runs nowhere and asserts nothing,",
      "and whatever verdict the job it belongs to publishes does not include",
      "it. That is the TOG-227 failure exactly. This gate stays red until the",
      "handoff completes.",
    );
  } else {
    fail(
      `scripts/${f}`,
      "is not run by package.json, any workflow, or any other script.",
      "Either wire it in, or add it to MANUAL_SCRIPTS in this file with the",
      "reason a machine cannot run it. A script nobody runs is indistinguishable",
      "from a script that passes.",
    );
  }
}

for (const f of untrackedScripts.sort()) {
  skip(`scripts/${f}`, "untracked — not graded");
  console.log(
    "      Not committed, so it is not part of this repository yet and no",
  );
  console.log(
    "      claim is being made that it runs. It gets graded when it lands.",
  );
}

// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(72));
if (failures > 0) {
  const queued = pending > 0 ? ` (${pending} awaiting an operator)` : "";
  console.log(`  ${failures} gate(s) failed${queued}.`);
  console.log("  docs/OPERATIONS.md — \"Applying an operator-only change\"");
  process.exit(1);
}
console.log("  workflow guard passed");
