#!/usr/bin/env node
/**
 * Build the TOG-2922 operator release bundle deterministically.
 *
 * The v0.4.3 candidate's bundle was assembled by hand. That cost a re-cut when
 * review rejected the release: the SHAs in the handoff comment, the attachment,
 * and the tree had to be reconciled by reading three places. Anything with a
 * number in it belongs in a script, so this is the only supported way to cut it.
 *
 * Emits, into --out:
 *   togetherweown-paperclip-model-router-<version>.tgz   the install artifact
 *   release-manifest.json                                version, source SHA, hashes
 *   SHA256SUMS                                           checksums of every other file
 *   scripts/tog-2922-config-delta.mjs                    prerequisite/enable transformer
 *   docs/tog-2922-pace-prerequisites.json                reviewed prerequisite input
 *   docs/TOG-2922-v<version>-pace-ordering.md            the handoff runbook
 *
 * The manifest records the SHA-256 of `dist/worker.js` as it exists INSIDE the
 * packed tarball, not the working-tree copy, because the tarball is what an
 * operator installs. `--check` re-derives every hash and diffs it against the
 * manifest, so a bundle can be re-verified without rebuilding.
 *
 * Usage:
 *   node scripts/tog-2922-build-release-bundle.mjs --out <dir>
 *   node scripts/tog-2922-build-release-bundle.mjs --check <dir>
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const run = (cmd, args, cwd = ROOT) => execFileSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { mode: null, dir: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out" || argv[i] === "--check") {
      out.mode = argv[i] === "--out" ? "build" : "check";
      out.dir = argv[i + 1];
      i += 1;
    }
  }
  if (!out.mode || !out.dir) fail("usage: --out <dir> | --check <dir>");
  return out;
}

/** Hash a single member of the packed tarball without leaving it unpacked. */
function hashTarMember(tgz, member) {
  const scratch = mkdtempSync(path.join(tmpdir(), "tog2922-pack-"));
  try {
    run("tar", ["-xzf", tgz, "-C", scratch, `package/${member}`]);
    return sha256(readFileSync(path.join(scratch, "package", member)));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function checksumLines(dir) {
  // SHA256SUMS covers every bundle file except itself, sorted for stability.
  const names = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath ?? entry.path, entry.name)))
    .filter((name) => name !== "SHA256SUMS")
    .sort();
  return names.map((name) => `${sha256(readFileSync(path.join(dir, name)))}  ${name}`);
}

const { mode, dir } = parseArgs(process.argv.slice(2));
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = pkg.version;
const tgzName = `togetherweown-paperclip-model-router-${version}.tgz`;

if (mode === "check") {
  if (!existsSync(path.join(dir, "release-manifest.json"))) fail(`no release-manifest.json in ${dir}`);
  const manifest = JSON.parse(readFileSync(path.join(dir, "release-manifest.json"), "utf8"));
  const tgz = path.join(dir, manifest.package.file);
  if (!existsSync(tgz)) fail(`manifest names ${manifest.package.file}, which is absent`);

  const problems = [];
  const packHash = sha256(readFileSync(tgz));
  if (packHash !== manifest.package.sha256) problems.push(`package sha256 ${packHash} != manifest ${manifest.package.sha256}`);
  const workerHash = hashTarMember(tgz, "dist/worker.js");
  if (workerHash !== manifest.worker.sha256) problems.push(`dist/worker.js sha256 ${workerHash} != manifest ${manifest.worker.sha256}`);

  const recorded = readFileSync(path.join(dir, "SHA256SUMS"), "utf8").trim().split("\n").sort();
  const actual = checksumLines(dir).sort();
  if (recorded.join("\n") !== actual.join("\n")) problems.push("SHA256SUMS does not match the bundle contents");

  if (problems.length > 0) fail(problems.join("\n      "));
  console.log(`PASS  bundle ${dir} matches its manifest`);
  console.log(`      version ${manifest.version}  source ${manifest.source.commit}`);
  console.log(`      package  ${manifest.package.sha256}`);
  console.log(`      worker   ${manifest.worker.sha256}`);
  console.log(`      ${actual.length} checksummed file(s)`);
  process.exit(0);
}

// --- build -----------------------------------------------------------------
if (existsSync(dir) && readdirSync(dir).length > 0) fail(`${dir} exists and is not empty; refusing to overwrite a cut bundle`);
mkdirSync(path.join(dir, "scripts"), { recursive: true });
mkdirSync(path.join(dir, "docs"), { recursive: true });

// A bundle cut from a dirty tree cannot be re-derived from its recorded SHA.
const dirty = run("git", ["status", "--porcelain"]);
const commit = run("git", ["rev-parse", "HEAD"]);
const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);

console.log("building dist/ ...");
run("npm", ["run", "build"]);

console.log("packing ...");
const packed = run("npm", ["pack", "--pack-destination", path.resolve(dir)]);
const producedName = packed.split("\n").pop().trim();
if (producedName !== tgzName) fail(`npm pack produced ${producedName}, expected ${tgzName}`);
const tgz = path.join(dir, tgzName);

const workerSha = hashTarMember(tgz, "dist/worker.js");
const packSha = sha256(readFileSync(tgz));
const packedVersion = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
if (packedVersion !== version) fail("package.json version changed mid-build");

copyFileSync(path.join(ROOT, "scripts/tog-2922-config-delta.mjs"), path.join(dir, "scripts/tog-2922-config-delta.mjs"));
copyFileSync(path.join(ROOT, "docs/operator/tog-2922-pace-prerequisites.json"), path.join(dir, "docs/tog-2922-pace-prerequisites.json"));
const handoff = `docs/operator/TOG-2922-v${version}-pace-ordering.md`;
if (!existsSync(path.join(ROOT, handoff))) fail(`missing handoff runbook ${handoff} for version ${version}`);
copyFileSync(path.join(ROOT, handoff), path.join(dir, `docs/TOG-2922-v${version}-pace-ordering.md`));

const manifest = {
  issue: "TOG-2922",
  version,
  builtFrom: { dirtyWorkingTree: dirty.length > 0 },
  source: { commit, branch },
  package: { file: tgzName, sha256: packSha, bytes: statSync(tgz).size },
  worker: { path: "dist/worker.js", sha256: workerSha, note: "hash of the copy inside the tarball, which is what an operator installs" },
  supersedes: { version: "0.4.3", reason: "never tagged or published; rejected in review for gating pace evaluation on the steering flag" },
};
writeFileSync(path.join(dir, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(path.join(dir, "SHA256SUMS"), `${checksumLines(dir).join("\n")}\n`);

console.log(`\nbundle cut at ${dir}`);
console.log(`  version  ${version}`);
console.log(`  source   ${commit} (${branch})${dirty ? "  *** DIRTY TREE ***" : ""}`);
console.log(`  package  ${packSha}`);
console.log(`  worker   ${workerSha}`);
if (dirty) console.log("\nWARNING: cut from a dirty working tree; this bundle is not reproducible from its source SHA.");
