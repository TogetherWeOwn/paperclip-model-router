#!/usr/bin/env node
/**
 * Fail if this plugin has grown a dependency on a MODIFIED Paperclip host.
 *
 * The claim in README.md — "needs no Paperclip source checkout, patch, or
 * private host module" — is the acceptance frame for TOG-681, and it is the
 * kind of claim that rots quietly. It was true when written; the repository
 * has since carried a host patch under `docs/operator/` for months, and the
 * only thing keeping that patch out of the install path was that nobody had
 * wired it in yet. That is not a guarantee, it is luck.
 *
 * So this script encodes the three ways the claim can die:
 *
 *   1  a host patch becomes part of installing or verifying the plugin
 *      — a `.patch` reachable from install docs, `package.json` scripts, CI,
 *        or the packed `files` list, or any `git apply` in an executable path;
 *   2  runtime source starts importing the host — `/app`, a relative climb
 *      into a checkout, or a private `@paperclipai/*` module that is not the
 *      published plugin SDK;
 *   3  the packed tarball starts carrying either of the above.
 *
 * A host patch is allowed to EXIST as a finding written up for whoever owns
 * the host source. It is not allowed to be something this plugin's own install
 * or verification path runs. `docs/operator/` is therefore quarantined rather
 * than banned: it is excluded from `files`, and nothing that runs may point at
 * it. `PATCH_QUARANTINE` below is that boundary, in one place.
 *
 * Runs in CI with no host checkout and no network. Exits non-zero on any FAIL.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where a host patch may live, and nowhere else. Excluded from `files`. */
const PATCH_QUARANTINE = "docs/operator/";

/** The one `@paperclipai/*` package that is public and may be imported. */
const PUBLIC_SDK = "@paperclipai/plugin-sdk";

/** Paths that ship or execute — a patch reference in any of these is fatal. */
const EXECUTABLE_GLOBS = ["src", "scripts", ".github", "package.json"];

let failures = 0;

function report(ok, label, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n      ${detail}` : ""}`);
}

function walk(start) {
  const absolute = join(root, start);
  if (!existsSync(absolute)) return [];
  if (statSync(absolute).isFile()) return [start];
  const out = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    out.push(...walk(join(start, entry.name)));
  }
  return out;
}

// This file names the things it forbids, so scanning itself would always fail.
const SELF = relative(root, fileURLToPath(import.meta.url));
const executableFiles = EXECUTABLE_GLOBS.flatMap((glob) => walk(glob)).filter((file) => file !== SELF);

// ---------------------------------------------------------------------------
// 1. No host patch in the install or verification path
// ---------------------------------------------------------------------------

/**
 * `git apply --check` asks whether a patch *would* apply and mutates nothing.
 * That is how `check:workflows` reports which operator patches are still
 * queued, and reporting on a patch is the opposite of depending on one — so the
 * check-only form is not a coupling. A real `git apply` (no `--check`) is.
 *
 * Both spellings are scanned: the shell form (`git apply foo.patch`) and the
 * argv form (`git(["apply", ...])`), because the argv form is what this
 * repository's own scripts use and a scanner that only knew the shell form
 * would read as passing while missing every real case.
 */
const SHELL_APPLY = /\bgit\s+apply\b[^\n]*/g;
const ARGV_APPLY = /\[\s*["']apply["'][^\]]*\]/g;

function appliesAPatch(content) {
  // Prose in a comment is not an execution path; require a real invocation.
  const invocations = [
    ...(content.match(SHELL_APPLY) ?? []).filter((line) => /\.patch\b|\$\{|\bpatchPath\b/.test(line)),
    ...(content.match(ARGV_APPLY) ?? []),
  ];
  return invocations.some((invocation) => !invocation.includes("--check"));
}

const patchReferences = executableFiles.filter((file) =>
  appliesAPatch(readFileSync(join(root, file), "utf8")),
);
report(
  patchReferences.length === 0,
  "nothing that runs applies a host patch",
  patchReferences.length
    ? `${patchReferences.join(", ")} — a patch may be documented under ${PATCH_QUARANTINE}, never executed`
    : `checked ${executableFiles.length} files under ${EXECUTABLE_GLOBS.join(", ")}`,
);

/**
 * A patch under `docs/operator/` is a HOST patch only if it edits the host
 * source tree. Two of the queued patches edit *this repository's own*
 * `.github/workflows/ci.yml`, which no more couples the plugin to a modified
 * host than any other CI change does. Classify by what the diff targets, not by
 * the fact that it is a `.patch`.
 */
const HOST_TREES = ["server/", "packages/", "apps/", "src/server/"];

function isHostPatch(patchFile) {
  const diff = readFileSync(join(root, patchFile), "utf8");
  const targets = [...diff.matchAll(/^\+\+\+ b\/(\S+)/gm)].map((m) => m[1]);
  return targets.some((target) => HOST_TREES.some((tree) => target.startsWith(tree)));
}

const hostPatches = walk(PATCH_QUARANTINE)
  .filter((file) => file.endsWith(".patch"))
  .filter(isHostPatch);

// README is the document making the stock-host claim, and the install runbook
// is what an operator follows. Neither may route through a HOST patch.
const installDocs = ["README.md", "docs/OPERATIONS.md"].filter((file) => existsSync(join(root, file)));
const docsCitingPatch = installDocs.filter((file) => {
  const content = readFileSync(join(root, file), "utf8");
  return hostPatches.some((patch) => content.includes(patch));
});
report(
  docsCitingPatch.length === 0,
  "the install path documentation does not route through a host patch",
  docsCitingPatch.length
    ? `${docsCitingPatch.join(", ")} — cites a host patch`
    : `${installDocs.join(", ")}; ${hostPatches.length} host patch(es) quarantined in ${PATCH_QUARANTINE}`,
);

// ---------------------------------------------------------------------------
// 2. No host coupling in runtime source
// ---------------------------------------------------------------------------

const sourceFiles = walk("src");
const importPattern = /(?:^|\n)\s*import\s[^;]*?from\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g;

const badImports = [];
for (const file of sourceFiles) {
  const content = readFileSync(join(root, file), "utf8");
  for (const match of content.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (!specifier) continue;
    const privateHostPackage = specifier.startsWith("@paperclipai/") && specifier !== PUBLIC_SDK
      && !specifier.startsWith(`${PUBLIC_SDK}/`);
    // `../../` out of src/ can only be reaching for a checkout; src is flat
    // enough that nothing legitimate climbs past the package root.
    const escapesPackage = specifier.startsWith("/app") || /^\.\.\/\.\.\//.test(specifier);
    if (privateHostPackage || escapesPackage) badImports.push(`${file}: ${specifier}`);
  }
}
report(
  badImports.length === 0,
  `runtime source imports only ${PUBLIC_SDK} and relative modules`,
  badImports.length ? badImports.join("\n      ") : `${sourceFiles.length} files, no private host module`,
);

const hostPathReferences = sourceFiles.filter((file) =>
  /\/app\/|["'`]\/app["'`]|server\/src\/|packages\/db\/src/.test(readFileSync(join(root, file), "utf8")),
);
report(
  hostPathReferences.length === 0,
  "runtime source contains no path into a Paperclip checkout",
  hostPathReferences.length ? hostPathReferences.join(", ") : "no /app, server/src or packages/db path",
);

const declaredDependencies = Object.keys(
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies ?? {},
);
report(
  declaredDependencies.every((name) => !name.startsWith("@paperclipai/") || name === PUBLIC_SDK),
  "the only runtime dependency from the Paperclip scope is the published SDK",
  declaredDependencies.join(", ") || "(none)",
);

// ---------------------------------------------------------------------------
// 3. The packed tarball carries neither
// ---------------------------------------------------------------------------

// `npm pack --dry-run` is the same file list an operator would receive, without
// writing a tarball or needing a build.
let packed = null;
try {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  packed = JSON.parse(output)[0].files.map((entry) => entry.path);
} catch (error) {
  report(false, "npm pack --dry-run lists the packed files", String(error instanceof Error ? error.message : error));
}

if (packed) {
  const packedPatches = packed.filter((path) => path.endsWith(".patch") || path.startsWith(PATCH_QUARANTINE));
  report(
    packedPatches.length === 0,
    "the packed artifact ships no host patch",
    packedPatches.length ? packedPatches.join(", ") : `${packed.length} files packed, none under ${PATCH_QUARANTINE}`,
  );

  // The bundle is what actually executes on the host; a copied host module
  // would appear here even if the import that pulled it in looked innocent.
  const bundles = packed.filter((path) => path.startsWith("dist/") && path.endsWith(".js"));
  const contaminated = bundles.filter((path) =>
    existsSync(join(root, path)) && /\/app\/server\/|remote-http-endpoint-guard|plugin-host-services/.test(readFileSync(join(root, path), "utf8")),
  );
  report(
    bundles.length === 0 || contaminated.length === 0,
    "no host source is inlined into the built bundle",
    bundles.length === 0
      ? "no dist/ present — run npm run build for this check to mean anything"
      : `${bundles.map((path) => relative("dist", path)).join(", ")} clean`,
  );
}

console.log(
  failures === 0
    ? "\nHOST COUPLING CHECK PASSED — this plugin installs on a stock host"
    : `\n${failures} host-coupling check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
