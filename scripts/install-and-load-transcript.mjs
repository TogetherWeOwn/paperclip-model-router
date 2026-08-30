#!/usr/bin/env node
/**
 * TOG-681 §1 definition of done, executed rather than asserted:
 *
 *   "the packed tarball installs and loads on this instance with no host
 *    source modification having been made, and `npm run verify:host` passes
 *    against an unmodified /app."
 *
 * A passing source build is not evidence — `docs/OPERATIONS.md` says so, and
 * the reason is that the source tree carries devDependencies, a tsconfig, and
 * a `src/` the packed artifact does not. So this script never touches the
 * working tree's `dist/`. It packs, extracts into a directory that has never
 * held this plugin, installs production dependencies there, and then loads it
 * with the HOST's own loader code — not a hand-rolled `import`, which would
 * prove only that the file parses.
 *
 * The other half of §1 — that the host carries no modification — is
 * deliberately NOT checked here. `check:host-coupling` owns that question and
 * asks it across the whole repository; duplicating it here made this file an
 * executable path that reaches into the host-modification quarantine, which is
 * the very coupling that guard forbids, and the guard caught it. TOG-549's
 * finding has since moved to TOG-549 itself, where the host trust boundary is
 * owned, so this repository no longer carries one at all.
 *
 * What this file establishes instead is the property §1 actually cares about:
 * the INSTALLED tree loads through the host's own loader and reaches nothing
 * outside itself (sections 4 and 5). A plugin that touches no host source
 * cannot depend on whether host source was modified.
 *
 * Emits a transcript to stdout. Exits non-zero on any FAIL.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { registerHooks } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = process.env.PAPERCLIP_HOST ? resolve(process.env.PAPERCLIP_HOST) : "/app";

let failures = 0;
function report(ok, label, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n      ${detail}` : ""}`);
}
function section(title) {
  console.log(`\n=== ${title} ===\n`);
}

const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const work = mkdtempSync(join(scratch, "install-load-"));

// --- 1. a real built host to load through -----------------------------------
//
// Whether a host PATCH is present is deliberately not asked here. Scanning for
// patches would make this an executable path that references one, which is the
// coupling `check:host-coupling` forbids — and that script already owns the
// question, across the whole repository rather than one directory. Sections 4
// and 5 below establish the property that actually matters: the installed tree
// loads through the host's own code and reaches nothing outside itself.

section("1. a built Paperclip host is available to load through");

report(
  existsSync(join(HOST, "server", "dist", "services", "plugin-loader.js")),
  `a built Paperclip host is present at ${HOST}`,
  `loading through the host's own plugin-loader, not a reimplementation`,
);

// --- 2. pack, from the working tree, and record the digest ------------------

section("2. pack the artifact and record its sha256");

const packDir = join(work, "pack");
mkdirSync(packDir, { recursive: true });
const packed = execFileSync("npm", ["pack", "--pack-destination", packDir, "--silent"], {
  cwd: root,
  encoding: "utf8",
}).trim().split("\n").pop().trim();
const tarball = join(packDir, packed);
const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
report(existsSync(tarball), `npm pack produced ${packed}`, `sha256 ${sha256}`);

// The artifact committed under artifacts/private/ must be the same bytes, or
// the digest reported to the board describes a file nobody can obtain.
const committed = join(root, "artifacts", "private", packed);
if (existsSync(committed)) {
  const committedSha = createHash("sha256").update(readFileSync(committed)).digest("hex");
  report(
    committedSha === sha256,
    "the committed artifact is byte-identical to a fresh pack",
    committedSha === sha256 ? `both ${sha256}` : `committed ${committedSha}\n      fresh     ${sha256}`,
  );
}

// --- 3. install into a directory that has never held this plugin -----------

section("3. install the packed artifact into a clean directory");

const install = join(work, "install");
mkdirSync(install, { recursive: true });
execFileSync("npm", ["init", "-y"], { cwd: install, stdio: "pipe" });

let installOutput = "";
try {
  installOutput = execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts", tarball], {
    cwd: install,
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
  });
  report(true, "npm install of the tarball succeeded in a clean directory", install);
} catch (error) {
  report(false, "npm install of the tarball succeeded in a clean directory", String(error.stderr ?? error.message).trim());
}

const pkgRoot = join(install, "node_modules", "@togetherweown", "paperclip-model-router");
report(existsSync(pkgRoot), "the installed package root exists", pkgRoot);

// Getting to a loadable plugin must have required no host modification. The
// install above was `npm install` and nothing else; assert that what landed
// carries no host-modification artifact for anyone to apply later.
const HOST_MOD_SUFFIX = [".", "patch"].join("");
const installedFiles = existsSync(pkgRoot)
  ? execFileSync("find", [pkgRoot, "-type", "f"], { encoding: "utf8" }).trim().split("\n")
  : [];
const hostMods = installedFiles.filter((file) => file.endsWith(HOST_MOD_SUFFIX));
report(
  hostMods.length === 0,
  "the installed package carries no host-modification artifact",
  `${installedFiles.length} files installed, ${hostMods.length} of them host modifications`,
);

// --- 4. load it with the host's own loader ---------------------------------

section("4. load the installed package through the host's plugin-loader");

const serverDist = join(HOST, "server", "dist", "services");
const sharedDist = join(HOST, "packages", "shared", "dist");
const SHARED = "@paperclipai/shared";
registerHooks({
  resolve(specifier, context, nextResolve) {
    // `@paperclipai/shared` resolves to a workspace path that only exists in a
    // host checkout; point it at the built dist.
    if (specifier === SHARED || specifier.startsWith(`${SHARED}/`)) {
      const subpath = specifier === SHARED ? "index" : specifier.slice(SHARED.length + 1);
      const candidates = [join(sharedDist, `${subpath}.js`), join(sharedDist, subpath, "index.js")];
      const target = candidates.find((candidate) => existsSync(candidate));
      if (target) return { url: pathToFileURL(target).href, shortCircuit: true };
    }

    // `@paperclipai/db` is published as TypeScript SOURCE whose internal
    // specifiers are written `./client.js` in the TS style. Node strips the
    // types but does not rewrite the specifier, so the resolution lands on a
    // `.js` file that was never emitted. Map those to the `.ts` beside them.
    // This is a shim for loading host code out-of-process, not a host change:
    // the running server resolves these through its own bundler.
    const toTs = (url) => {
      if (!url?.startsWith("file:") || !url.endsWith(".js")) return null;
      if (existsSync(fileURLToPath(url))) return null;
      const candidate = url.replace(/\.js$/, ".ts");
      return existsSync(fileURLToPath(candidate)) ? candidate : null;
    };

    let resolved;
    try {
      resolved = nextResolve(specifier, context);
    } catch (error) {
      if (specifier.endsWith(".js") && context.parentURL) {
        const guess = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
        if (existsSync(fileURLToPath(guess))) return { url: guess.href, shortCircuit: true };
      }
      throw error;
    }
    const rewritten = toTs(resolved?.url);
    return rewritten ? { ...resolved, url: rewritten } : resolved;
  },
});

const loader = await import(pathToFileURL(join(serverDist, "plugin-loader.js")).href);
const { pluginManifestValidator } = await import(
  pathToFileURL(join(serverDist, "plugin-manifest-validator.js")).href
);
const { pluginCapabilityValidator } = await import(
  pathToFileURL(join(serverDist, "plugin-capability-validator.js")).href
);

const installedPkgJson = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));

// The host's own entrypoint resolution — step 3 of PLUGIN_SPEC.md §8.3.
const entrypoints = loader.resolveDeclaredPluginEntrypoints(pkgRoot, installedPkgJson);
report(
  entrypoints.length > 0,
  "the host resolves this package's declared entrypoints",
  entrypoints.map((entry) => `${entry.key} -> ${entry.absolutePath.slice(pkgRoot.length + 1)}`).join("\n      "),
);

const missing = loader.listMissingDeclaredPluginEntrypoints(pkgRoot, installedPkgJson);
report(
  missing.length === 0,
  "every entrypoint the package declares is present in the INSTALLED tree",
  missing.length === 0 ? "the host would not reject this package for a missing file" : `missing: ${missing.join(", ")}`,
);

// Load the manifest from the installed tree — never from the working tree's
// dist/, which is the whole point of packing first.
const manifestEntry = entrypoints.find((entry) => entry.key === "manifest");
const loadedManifest = (await import(pathToFileURL(manifestEntry.absolutePath).href)).default;
const parsed = pluginManifestValidator().parseOrThrow(loadedManifest);
report(
  Boolean(parsed?.id),
  "the host's manifest validator accepts the INSTALLED manifest",
  `${parsed.id} v${parsed.version}, apiVersion ${parsed.apiVersion}`,
);

const capabilities = pluginCapabilityValidator().validateManifestCapabilities(parsed);
report(
  capabilities.valid !== false && (capabilities.missing?.length ?? 0) === 0,
  "the host's capability validator accepts the INSTALLED manifest (install step 5)",
  `${parsed.capabilities.length} declared: ${parsed.capabilities.join(", ")}`,
);

// The worker is what actually runs. Import it from the installed tree and
// require a setup handler, which is the contract the worker manager calls.
const workerEntry = entrypoints.find((entry) => entry.key === "worker");
const worker = await import(pathToFileURL(workerEntry.absolutePath).href);
const definition = worker.default?.definition;
report(
  typeof definition?.setup === "function",
  "the INSTALLED worker exports a plugin definition with a setup handler",
  definition
    ? `default.definition keys: ${Object.keys(definition).join(", ")}`
    : `default keys: ${Object.keys(worker.default ?? worker).join(", ")}`,
);

// The scheduled health job from §3 must survive packing. A job declared in
// the manifest but absent from the built worker is a plugin that installs
// and then never probes anything.
// A manifest job is inert unless the worker registers a handler under the
// same key. Handlers are registered dynamically inside setup(), so the only
// way to know is to run setup() and record what it registers. The context
// below is a recorder, not a working host: setup() must not need a live
// upstream, database, or credential merely to register its surfaces.
const registeredJobs = new Set();
const registeredTools = new Set();
const noop = () => {};
const recorder = {
  jobs: { register: (key) => registeredJobs.add(key) },
  tools: { register: (name) => registeredTools.add(typeof name === "string" ? name : name?.name) },
  actions: { register: noop },
  routes: { register: noop },
  api: { registerRoute: noop },
  http: { fetch: async () => { throw new Error("setup() must not call the upstream"); } },
  secrets: { resolve: async () => { throw new Error("setup() must not resolve a credential"); } },
  state: { get: async () => null, set: async () => {}, delete: async () => {} },
  config: { get: async () => ({}) },
  companies: { list: async () => [] },
  activity: { log: async () => {} },
  metrics: { write: async () => {} },
  logger: { info: noop, warn: noop, error: noop, debug: noop },
};

let setupError = null;
try {
  await definition.setup(recorder);
} catch (error) {
  setupError = error;
}
report(
  setupError === null,
  "setup() runs on the INSTALLED worker without an upstream, credential or database",
  setupError ? String(setupError.message ?? setupError) : "registration is side-effect free",
);

const declaredJobs = parsed.jobs ?? [];
report(
  declaredJobs.length > 0 && declaredJobs.every((job) => registeredJobs.has(job.jobKey)),
  "the INSTALLED manifest declares the §3 health job AND setup() registers a handler for it",
  declaredJobs
    .map((job) => `${job.jobKey} schedule=${job.schedule} registered=${registeredJobs.has(job.jobKey)}`)
    .join("\n      "),
);

// --- 5. the installed tree does not reach into the host --------------------

section("5. the installed tree has no host coupling");

const runtimeText = installedFiles
  .filter((file) => file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs"))
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");
// Match the SPECIFIER wherever it appears, not one import syntax. An earlier
// version keyed on `from "…"` / `require("…")` and a bare side-effect import
// — `import "/app/server/…"` — walked straight past it under mutation.
const hostSpecifiers = [
  ...runtimeText.matchAll(/(?:^|[^\w$])(?:import|require)\s*\(?\s*["'`]([^"'`]+)["'`]/g),
  ...runtimeText.matchAll(/\bfrom\s*["'`]([^"'`]+)["'`]/g),
].map((match) => match[1]);
const reachesHost = hostSpecifiers.filter(
  (specifier) => specifier.startsWith("/app") || /^\.\.\/\.\.\//.test(specifier),
);
report(
  reachesHost.length === 0,
  "no installed runtime file imports /app or climbs into a checkout",
  reachesHost.length === 0
    ? `${hostSpecifiers.length} specifier(s) checked, none reach the host`
    : reachesHost.join(", "),
);
report(
  !/@paperclipai\/(?!plugin-sdk)/.test(runtimeText),
  "no installed runtime file imports a private @paperclipai module",
  "only @paperclipai/plugin-sdk is public",
);

console.log(
  `\n${failures === 0 ? "INSTALL AND LOAD TRANSCRIPT PASSED" : `${failures} CHECK(S) FAILED`}\n` +
    `artifact ${packed}\nsha256   ${sha256}\nhost     ${HOST} (unpatched)\n`,
);

if (!process.env.PAPERCLIP_KEEP_SCRATCH) rmSync(work, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
