#!/usr/bin/env node
/**
 * Prove that a version pin handed to an operator is real, installable, and
 * still current.
 *
 * `npm run verify` proves the working tree is good. `verify:host` proves the
 * host would accept the built manifest. Neither says anything about the thing
 * an operator actually installs: a *published release asset*, named by a tag,
 * in a runbook written some hours earlier. That gap has cost this issue three
 * cycles:
 *
 *   v0.1.1  a tag existed with no published tarball behind it.
 *   v0.2.3  the pending approval card named a version the runbook had already
 *           marked unsafe; both were wrong by the time anyone read them.
 *   v0.2.5  correct, but `main` had moved twice since the tag and nobody could
 *           say from the card whether that mattered.
 *
 * Every one of those is a mechanical comparison, so it belongs in a script
 * rather than in a run that re-improvises it. The gates:
 *
 *   1  the tag resolves to a commit in this repository
 *   2  `package.json` AT THE TAG declares the tag's version
 *   3  `CHANGELOG.md` AT THE TAG carries a section for that version
 *   4  a published, non-draft release exists for the tag with exactly one
 *      `.tgz` asset
 *   5  that asset downloads, and its sha256 matches `--expect-sha256` if given
 *   6  the asset's `dist/*.js` are BYTE-IDENTICAL to a fresh build of the
 *      working tree
 *   7  `git diff <tag>..HEAD -- src` is empty, so HEAD ships the same plugin
 *      code the tag does
 *
 * Gate 6 is the one that matters most and the one a human never does: it is
 * what makes "I tested main" and "the operator installs the tarball" the same
 * sentence. Gate 7 is its complement — it is allowed to fail, and when it does
 * the answer is to cut a new tag, not to reword the runbook.
 *
 * Gates 4 and 5 need the network and a GitHub token. The token is read from
 * this repo's own git credential helper, so there is nothing to configure. If
 * they cannot run they FAIL, because a pin that cannot be checked is exactly
 * the failure this script exists to catch. `--offline` downgrades them to SKIP
 * for local use; it is refused together with `--for-card`.
 *
 * Usage:
 *   node scripts/release-pin-check.mjs                       # tag from package.json
 *   node scripts/release-pin-check.mjs --tag v0.2.5
 *   node scripts/release-pin-check.mjs --tag v0.2.5 --for-card
 *   node scripts/release-pin-check.mjs --expect-sha256 16eb40a7...
 *   node scripts/release-pin-check.mjs --offline --no-build
 *
 * `--for-card` prints a block meant to be pasted into an operator card or
 * runbook, and refuses to print it if ANY gate failed or skipped. A card is a
 * claim to a human who cannot check it; it may only quote a complete run.
 *
 * Exits non-zero on any FAIL. SKIPs are printed and, under `--for-card`, fatal.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "TogetherWeOwn/paperclip-model-router";
const DIST_FILES = ["dist/worker.js", "dist/manifest.js"];

let failures = 0;
let skips = 0;
const facts = {};

function pass(label, detail = "") {
  console.log(`PASS  ${label}${detail ? `\n      ${detail}` : ""}`);
}

function fail(label, detail = "") {
  failures += 1;
  console.log(`FAIL  ${label}${detail ? `\n      ${detail}` : ""}`);
}

function report(ok, label, detail = "") {
  (ok ? pass : fail)(label, detail);
  return ok;
}

function skip(label, reason) {
  skips += 1;
  console.log(`SKIP  ${label}\n      ${reason}`);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function gitOrNull(...args) {
  try {
    return git(...args);
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const opts = { tag: null, expectSha: null, offline: false, build: true, forCard: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--tag") opts.tag = argv[++i];
    else if (a === "--expect-sha256") opts.expectSha = (argv[++i] ?? "").toLowerCase();
    else if (a === "--offline") opts.offline = true;
    else if (a === "--no-build") opts.build = false;
    else if (a === "--for-card") opts.forCard = true;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (opts.offline && opts.forCard) {
    console.error("--offline cannot be combined with --for-card: a card may not quote an unchecked release");
    process.exit(2);
  }
  return opts;
}

/**
 * Ask this repository's own credential helper for a GitHub token, the same way
 * `git fetch` does. Returns null when no helper is configured or it declines,
 * which the caller turns into a FAIL rather than a silent pass.
 */
function githubToken() {
  const helper = gitOrNull("config", "--get-all", "credential.https://github.com.helper");
  if (!helper) return null;
  const path = helper
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith("!") ? l.slice(1) : null))
    .filter(Boolean)
    .pop();
  if (!path) return null;
  const [cmd, ...rest] = path.split(/\s+/);
  try {
    const out = execFileSync(cmd, [...rest, "get"], {
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
    });
    const line = out.split("\n").find((l) => l.startsWith("password="));
    return line ? line.slice("password=".length).trim() : null;
  } catch {
    return null;
  }
}

async function gh(token, path, accept = "application/vnd.github+json") {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept, "user-agent": "release-pin-check" },
  });
  return res;
}

const opts = parseArgs(process.argv.slice(2));

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const tag = opts.tag ?? `v${pkg.version}`;
facts.tag = tag;

console.log("=".repeat(74));
console.log(`RELEASE PIN CHECK — ${REPO} @ ${tag}`);
console.log("=".repeat(74));

// ---------------------------------------------------------------- gate 1
const tagCommit = gitOrNull("rev-parse", "--verify", `${tag}^{commit}`)?.trim();
report(Boolean(tagCommit), `1  tag ${tag} resolves to a commit`, tagCommit ?? "no such tag in this checkout — fetch tags, or the tag was never pushed");
facts.tagCommit = tagCommit;

// ---------------------------------------------------------------- gate 2
if (tagCommit) {
  const tagged = gitOrNull("show", `${tag}:package.json`);
  const taggedVersion = tagged ? JSON.parse(tagged).version : null;
  const want = tag.replace(/^v/, "");
  report(
    taggedVersion === want,
    `2  package.json at ${tag} declares ${want}`,
    taggedVersion === want ? `version=${taggedVersion}` : `version=${taggedVersion ?? "<unreadable>"} — the tag names a version the tree at that tag does not`,
  );
} else {
  skip("2  package.json at the tag declares the tag's version", "gate 1 failed");
}

// ---------------------------------------------------------------- gate 3
if (tagCommit) {
  const changelog = gitOrNull("show", `${tag}:CHANGELOG.md`) ?? "";
  const want = tag.replace(/^v/, "");
  const has = changelog.includes(`## [${want}]`);
  report(has, `3  CHANGELOG at ${tag} documents ${want}`, has ? `found "## [${want}]"` : `no "## [${want}]" section — an operator cannot read what changed`);
} else {
  skip("3  CHANGELOG at the tag documents the version", "gate 1 failed");
}

// ---------------------------------------------------------------- gate 7
// Run before the network gates so a stale pin is reported even offline.
if (tagCommit) {
  const drift = gitOrNull("diff", "--name-only", `${tag}..HEAD`, "--", "src");
  const changed = (drift ?? "").split("\n").filter(Boolean);
  report(
    changed.length === 0,
    `7  HEAD ships the same plugin code as ${tag}  (git diff ${tag}..HEAD -- src)`,
    changed.length === 0
      ? "src/ is untouched since the tag — installing the tag installs what main is tested as"
      : `${changed.length} file(s) changed since the tag:\n      ${changed.join("\n      ")}\n      CUT A NEW TAG. Do not hand an operator this pin.`,
  );
  const ahead = (gitOrNull("rev-list", "--count", `${tag}..HEAD`) ?? "0").trim();
  facts.commitsAhead = ahead;
  facts.srcDrift = changed.length;
  if (changed.length === 0 && ahead !== "0") {
    console.log(`      note: HEAD is ${ahead} commit(s) ahead of ${tag}, none of them touching src/`);
  }
} else {
  skip("7  HEAD ships the same plugin code as the tag", "gate 1 failed");
}

// ---------------------------------------------------------------- build
if (opts.build) {
  try {
    execFileSync("npm", ["run", "--silent", "build"], { stdio: "inherit" });
  } catch {
    fail("--  fresh build of the working tree", "npm run build failed; gate 6 cannot be trusted");
  }
} else {
  console.log("      note: --no-build, comparing against dist/ as it stands on disk");
}

// ------------------------------------------------------------ gates 4-6
let tmp = null;
if (opts.offline) {
  skip("4  a published release with exactly one .tgz asset exists", "--offline");
  skip("5  the asset downloads and matches its sha256", "--offline");
  skip("6  the published asset's dist is byte-identical to this build", "--offline");
} else {
  const token = githubToken();
  if (!token) {
    fail("4  a published release with exactly one .tgz asset exists", "no GitHub token from the git credential helper — cannot check the artifact an operator would install");
    fail("5  the asset downloads and matches its sha256", "no token");
    fail("6  the published asset's dist is byte-identical to this build", "no token");
  } else {
    const res = await gh(token, `/repos/${REPO}/releases/tags/${tag}`);
    if (!res.ok) {
      fail(`4  a published release exists for ${tag}`, `GET /releases/tags/${tag} -> HTTP ${res.status}. A tag is not a release; nothing is installable.`);
      fail("5  the asset downloads and matches its sha256", "gate 4 failed");
      fail("6  the published asset's dist is byte-identical to this build", "gate 4 failed");
    } else {
      const rel = await res.json();
      const tgz = (rel.assets ?? []).filter((a) => a.name.endsWith(".tgz"));
      const ok4 = report(
        !rel.draft && tgz.length === 1,
        `4  ${tag} is a published release with exactly one .tgz asset`,
        !rel.draft && tgz.length === 1
          ? `${tgz[0].name}  ${tgz[0].size} bytes  published ${rel.published_at}`
          : `draft=${rel.draft} prerelease=${rel.prerelease} tgz assets=${tgz.length} — an operator would not know which file to install`,
      );
      if (!ok4) {
        fail("5  the asset downloads and matches its sha256", "gate 4 failed");
        fail("6  the published asset's dist is byte-identical to this build", "gate 4 failed");
      } else {
        const asset = tgz[0];
        facts.assetName = asset.name;
        facts.assetSize = asset.size;
        const dl = await gh(token, `/repos/${REPO}/releases/assets/${asset.id}`, "application/octet-stream");
        if (!dl.ok) {
          fail("5  the asset downloads and matches its sha256", `asset download -> HTTP ${dl.status}`);
          fail("6  the published asset's dist is byte-identical to this build", "gate 5 failed");
        } else {
          const buf = Buffer.from(await dl.arrayBuffer());
          const sha = createHash("sha256").update(buf).digest("hex");
          facts.sha256 = sha;
          const shaOk = opts.expectSha ? sha === opts.expectSha : true;
          report(
            shaOk && buf.length === asset.size,
            "5  the asset downloads and matches its sha256",
            shaOk
              ? `sha256 ${sha}  (${buf.length} bytes)${opts.expectSha ? " — matches --expect-sha256" : " — no --expect-sha256 given, recording it"}`
              : `sha256 ${sha}\n      EXPECTED ${opts.expectSha}\n      The pin in the runbook/card does not describe the file on the release.`,
          );

          tmp = mkdtempSync(join(tmpdir(), "release-pin-"));
          writeFileSync(join(tmp, "asset.tgz"), buf);
          try {
            execFileSync("tar", ["xzf", join(tmp, "asset.tgz"), "-C", tmp]);
            const mismatched = [];
            for (const f of DIST_FILES) {
              const published = readFileSync(join(tmp, "package", f));
              const local = readFileSync(f);
              if (!published.equals(local)) mismatched.push(f);
            }
            report(
              mismatched.length === 0,
              "6  the published asset's dist is byte-identical to this build",
              mismatched.length === 0
                ? `${DIST_FILES.join(", ")} identical — the tests that just ran describe the file the operator installs`
                : `differ: ${mismatched.join(", ")}\n      ${
                    facts.srcDrift
                      ? "Expected — gate 7 already found src/ has moved since this tag. Cut a new tag; this one is stale, not corrupt."
                      : "src/ is UNCHANGED since the tag, so the release was built from something other than this source. Re-cut the release."
                  }`,
            );
          } catch (err) {
            fail("6  the published asset's dist is byte-identical to this build", `could not extract/compare: ${err.message}`);
          }
        }
      }
    }
  }
}

if (tmp) rmSync(tmp, { recursive: true, force: true });

console.log("=".repeat(74));
console.log(`  ${failures} failed, ${skips} skipped`);

if (opts.forCard) {
  if (failures || skips) {
    console.log("");
    console.log("  REFUSING to print a card block: a card may only quote a complete, clean run.");
    console.log("  Fix the gates above, or drop --for-card and say in the card what was not checked.");
  } else {
    console.log("");
    console.log("  ---- paste into the operator card / runbook ----");
    console.log(`  Install \`${facts.tag}\`. Asset \`${facts.assetName}\`, ${facts.assetSize} bytes,`);
    console.log(`  sha256 \`${facts.sha256}\`.`);
    console.log(`  Its \`dist/\` is byte-identical to a fresh build of \`main\`, and`);
    console.log(
      facts.commitsAhead === "0"
        ? `  \`main\` is at the tag.`
        : `  \`main\` is ${facts.commitsAhead} commit(s) ahead with no change under \`src/\`.`,
    );
    console.log("  ------------------------------------------------");
  }
}

if (failures) {
  console.log("");
  console.log("  RELEASE PIN CHECK FAILED — do not hand this version to an operator.");
  process.exit(1);
}
if (opts.forCard && skips) process.exit(1);
console.log("");
console.log("  RELEASE PIN CHECK PASSED");
